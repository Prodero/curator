/** Terminal-owned npm update. Every controller import is a Node builtin and is
 * loaded before npm may replace this package; no project or host writers. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {gunzip} from 'node:zlib';
import {promisify} from 'node:util';
const unzip=promisify(gunzip);
const NAME='@prodero/curator',REGISTRY='https://registry.npmjs.org/';
const stable=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_TARBALL=32*1024*1024,MAX_UNPACKED=128*1024*1024;
export class NpmUpdateError extends Error {constructor(public code:string,message:string,public exitCode=1){super(message);}}
function fail(code:string,message:string):never{throw new NpmUpdateError(code,message);}
export interface CommandResult {code:number|null;stdout:string;stderr:string;timedOut?:boolean;exited?:boolean;outputIncomplete?:boolean;signal?:string|null}
export interface UpdateDependencies {
 packageRoot?:string;entryPath?:string;nodePath?:string;
 request?:typeof fetch;run?:(node:string,args:string[],options:{cwd:string;env:NodeJS.ProcessEnv;timeout:number})=>Promise<CommandResult>;
 confirm?:(question:string)=>Promise<boolean>;write?:(message:string)=>void;interactive?:boolean;
}
export interface UpdateOptions {targetVersion?:string;yes?:boolean}
export interface NpmUpdateResult {ok:boolean;status:'updated'|'current'|'cancelled'|'failed';installedVersion:string|null;targetVersion:string;prefix:string;restartRequired:boolean;message:string;exitCode:number}
interface Layout {root:string;prefix:string;node:string;npm:string;version:string;identity:string}
interface Target {name:string;version:string;bin:{prodero:string};engines:{node:string};dist:{tarball:string;integrity:string};scripts?:Record<string,string>}
// The registry normalizes away ./; allow only these equivalent exact paths.
const supportedBin=(value:unknown):boolean=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===1&&Object.hasOwn(value,'prodero')&&['bin/prodero','./bin/prodero'].includes((value as Record<string,string>).prodero);
const comparison=(a:string,b:string)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);return x[0]-y[0]||x[1]-y[1]||x[2]-y[2];};
const supportedEngine=(engine:unknown,node:string)=>{
 // The initial allowlist intentionally accepts only the project's published
 // engine contract. Unknown range syntax is unsupported, never guessed.
 return engine==='>=22.14.0 <23'&&stable.test(node)&&comparison(node,'22.14.0')>=0&&comparison(node,'23.0.0')<0;
};
async function bounded(response:Response,max:number):Promise<Buffer>{
 if(!response.ok||!response.body)fail('NPM_UPDATE_REGISTRY','The public npm artifact or metadata is unavailable. No install started.');
 const length=Number(response.headers.get('content-length'));if(length>max)fail('NPM_UPDATE_ARTIFACT','The npm response exceeds the supported size.');
 const reader=response.body.getReader(),parts:Buffer[]=[];let bytes=0;
 try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;if(bytes>max)fail('NPM_UPDATE_ARTIFACT','The npm response exceeds the supported size.');parts.push(Buffer.from(chunk.value));}}finally{await reader.cancel().catch(()=>{});}
 return Buffer.concat(parts);
}
function childEnv(temp:string,node:string):NodeJS.ProcessEnv {
 return {HOME:path.join(temp,'home'),TMPDIR:path.join(temp,'tmp'),PATH:path.dirname(node),LANG:'C',LC_ALL:'C',NO_COLOR:'1',npm_config_update_notifier:'false'};
}
/** Wait for actual exit, but never wait indefinitely for descendants holding
 * inherited output pipes. Only this command's direct child is signalled. */
export async function runNpmCommand(node:string,args:string[],options:{cwd:string;env:NodeJS.ProcessEnv;timeout:number}):Promise<CommandResult>{
 return new Promise(resolve=>{
  let stdout='',stderr='',timedOut=false,done=false,exited=false,code:number|null=null,signal:string|null=null;
  const child=spawn(node,args,{cwd:options.cwd,env:options.env,shell:false,stdio:['ignore','pipe','pipe']});
  let hardTimer:ReturnType<typeof setTimeout>|undefined,drainTimer:ReturnType<typeof setTimeout>|undefined,finalTimer:ReturnType<typeof setTimeout>|undefined;
  const finish=(outputIncomplete:boolean)=>{if(done)return;done=true;clearTimeout(deadline);clearTimeout(hardTimer);clearTimeout(drainTimer);clearTimeout(finalTimer);child.stdout.destroy();child.stderr.destroy();child.unref();resolve({code,stdout,stderr,timedOut,exited,outputIncomplete,signal});};
  child.stdout.on('data',data=>{stdout=(stdout+String(data)).slice(-65536);});
  child.stderr.on('data',data=>{stderr=(stderr+String(data)).slice(-65536);});
  const deadline=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');hardTimer=setTimeout(()=>{child.kill('SIGKILL');finalTimer=setTimeout(()=>finish(true),250);},5000);},options.timeout);
  child.once('error',()=>finish(true));
  child.once('exit',(exitCode,exitSignal)=>{exited=true;code=exitCode;signal=exitSignal;clearTimeout(deadline);clearTimeout(hardTimer);drainTimer=setTimeout(()=>finish(true),250);});
  child.once('close',()=>finish(false));
 });
}
function flags(temp:string,prefix:string):string[]{return ['--prefix',prefix,'--userconfig',path.join(temp,'user.npmrc'),'--globalconfig',path.join(temp,'global.npmrc'),'--cache',path.join(temp,'cache'),'--registry',REGISTRY];}
async function owned(target:string,directory=false){
 const stat=await fs.lstat(target);if(stat.isSymbolicLink()||(directory?!stat.isDirectory():!stat.isFile())||(process.getuid&&stat.uid!==process.getuid())||(stat.mode&0o022))fail('NPM_UPDATE_LAYOUT','This updater requires an ordinary same-user npm installation without writable shared paths. Use your package manager for this layout.');if(directory&&!(stat.mode&0o200))fail('NPM_UPDATE_PERMISSION','This npm installation is not writable. Repair permissions with its package manager; this updater does not use sudo.');if(directory)await fs.access(target,fs.constants.W_OK).catch(()=>fail('NPM_UPDATE_PERMISSION','This npm installation is not writable. Repair permissions with its package manager; this updater does not use sudo.'));return stat;
}
async function layout(deps:UpdateDependencies,temp:string):Promise<Layout>{
 const selectedRoot=path.resolve(deps.packageRoot??fileURLToPath(new URL('../..',import.meta.url))),root=await fs.realpath(selectedRoot),prefix=path.resolve(root,'../../../..');
 if(selectedRoot!==root)fail('NPM_UPDATE_LAYOUT','Linked package roots are unsupported. Invoke this installation’s own public executable.');
 const entry=path.resolve(deps.entryPath??process.argv[1]??'');
 const publicEntries=[path.join(prefix,'bin/prodero'),path.join(root,'bin/prodero')],internalCli=path.join(root,'dist/cli.js');
 if(!publicEntries.includes(entry)&&entry!==internalCli||await fs.realpath(entry)!==(entry===internalCli?internalCli:path.join(root,'bin/prodero')))fail('NPM_UPDATE_LAYOUT','The invoked executable does not belong to this exact npm installation. Linked aliases cannot select a different prefix.');
 if(root!==path.join(prefix,'lib/node_modules/@prodero/curator')||await fs.stat(path.join(root,'src/cli.ts')).catch(()=>null))fail('NPM_UPDATE_LAYOUT','Only an installed global npm @prodero/curator package is supported. Linked packages and source checkouts need their package manager.');
 for(const dir of [prefix,path.join(prefix,'bin'),path.join(prefix,'lib'),path.join(prefix,'lib/node_modules'),path.join(prefix,'lib/node_modules/@prodero'),root])await owned(dir,true);
 await owned(path.join(root,'package.json'));await owned(path.join(root,'bin/prodero'));
 const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
 if(pkg.name!==NAME||!stable.test(pkg.version)||!supportedBin(pkg.bin))fail('NPM_UPDATE_LAYOUT','The installed package identity or public executable is unsupported.');
 const publicBin=path.join(prefix,'bin/prodero');const bin=await fs.lstat(publicBin);if(!bin.isSymbolicLink()||process.getuid&&bin.uid!==process.getuid()||await fs.realpath(publicBin)!==path.join(root,'bin/prodero'))fail('NPM_UPDATE_LAYOUT','The public executable does not belong to this npm package. No other installation will be changed.');
 const node=await fs.realpath(deps.nodePath??process.execPath);await fs.access(node,fs.constants.X_OK);
 const npm=await fs.realpath(path.join(path.dirname(node),'npm')).catch(()=>fail('NPM_UPDATE_TOOLCHAIN','Cannot find npm beside the current Node executable. Use this installation’s package manager.'));
 const npmRoot=path.resolve(path.dirname(npm),'..'),npmPkg=JSON.parse(await fs.readFile(path.join(npmRoot,'package.json'),'utf8'));
 if(npm!==path.join(npmRoot,'bin/npm-cli.js')||npmPkg.name!=='npm'||npmPkg.bin?.npm!=='bin/npm-cli.js'||!/^10\.9\.\d+$/.test(npmPkg.version))fail('NPM_UPDATE_TOOLCHAIN','This updater supports npm 10.9.x with Node 22.14–22.x. Other toolchains need their package manager.');
 if(!supportedEngine('>=22.14.0 <23',process.versions.node))fail('NPM_UPDATE_TOOLCHAIN','This updater requires Node 22.14–22.x.');
 for(const file of [node,npm,path.join(npmRoot,'package.json')]){const s=await fs.lstat(file);if(!s.isFile()||s.mode&0o022||process.getuid&&s.uid!==process.getuid()&&s.uid!==0)fail('NPM_UPDATE_TOOLCHAIN','The Node/npm toolchain ownership or permissions are unsupported.');}
 if(node.startsWith(root+path.sep)||npm.startsWith(root+path.sep))fail('NPM_UPDATE_TOOLCHAIN','Node and npm must be outside the package being replaced.');
 const run=deps.run??runNpmCommand,options={cwd:temp,env:childEnv(temp,node),timeout:15000},fixed=flags(temp,prefix);
 const npmRootResult=await run(node,[npm,'root','--global',...fixed],options),listing=await run(node,[npm,'ls','--global','--parseable','--depth=0',NAME,...fixed],options);
 if(npmRootResult.code!==0||npmRootResult.timedOut||npmRootResult.outputIncomplete||npmRootResult.exited===false||npmRootResult.stdout.trim()!==path.join(prefix,'lib/node_modules')||listing.code!==0||listing.timedOut||listing.outputIncomplete||listing.exited===false||!listing.stdout.trim().split(/\r?\n/).includes(root))fail('NPM_UPDATE_LAYOUT','The verified npm does not recognize this exact global installation. No package was changed.');
 const identities=await Promise.all([entry,node,npm,path.join(npmRoot,'package.json'),path.join(root,'package.json'),path.join(root,'bin/prodero')].map(async file=>{const s=await fs.stat(file);return [file,s.dev,s.ino,s.size,s.mtimeMs,s.uid,s.mode];}));
 return {root,prefix,node,npm,version:pkg.version,identity:JSON.stringify(identities)};
}
function manifest(value:unknown,version?:string):Target {
 const v=value as Target;
 if(!v||v.name!==NAME||!stable.test(v.version)||version&&v.version!==version||!supportedBin(v.bin)||!supportedEngine(v.engines?.node,process.versions.node))fail('NPM_UPDATE_TARGET','The npm target identity, executable or Node engine contract is unsupported.');
 if(v.scripts&&(typeof v.scripts!=='object'||Array.isArray(v.scripts)))fail('NPM_UPDATE_TARGET','Invalid npm target script metadata.');
 if(v.scripts&&['preinstall','install','postinstall'].some(k=>v.scripts![k]))fail('NPM_UPDATE_SCRIPTS','The target requires install lifecycle hooks, which this updater does not run.');
 return v;
}
/** Inspect the verified archive before npm can create bins or install anything.
 * Normal ustar and npm PAX headers are supported; links/escaping paths are not. */
async function archiveManifest(compressed:Buffer):Promise<{pkg:unknown;files:Set<string>}>{
 const tar=await unzip(compressed,{maxOutputLength:MAX_UNPACKED}),files=new Set<string>();let pkg:unknown,paxPath:string|undefined;
 for(let offset=0;offset+512<=tar.length;){const h=tar.subarray(offset,offset+512);if(h.every(b=>b===0))break;const field=(start:number,size:number)=>h.subarray(start,start+size).toString('utf8').replace(/\0.*$/s,'');
  const sizeText=field(124,12).trim();if(!/^[0-7]+$/.test(sizeText))fail('NPM_UPDATE_ARTIFACT','Unsupported npm archive size field.');const size=parseInt(sizeText,8),end=offset+512+size;if(!Number.isSafeInteger(size)||end>tar.length)fail('NPM_UPDATE_ARTIFACT','Incomplete npm archive.');
  const checksum=parseInt(field(148,8).trim(),8),sum=h.reduce((a,b,i)=>a+(i>=148&&i<156?32:b),0);if(checksum!==sum)fail('NPM_UPDATE_ARTIFACT','Invalid npm archive header.');
  const type=field(156,1),body=tar.subarray(offset+512,end);offset+=512+Math.ceil(size/512)*512;
  if(type==='x'||type==='g'){let at=0;while(at<body.length){const space=body.indexOf(32,at),length=Number(body.subarray(at,space).toString());if(space<at||!Number.isSafeInteger(length)||length<=space-at+1||at+length>body.length)fail('NPM_UPDATE_ARTIFACT','Invalid npm archive metadata.');const record=body.subarray(space+1,at+length-1).toString(),equal=record.indexOf('=');if(record.slice(0,equal)==='path')paxPath=record.slice(equal+1);if(['linkpath','size'].includes(record.slice(0,equal)))fail('NPM_UPDATE_ARTIFACT','Unsupported npm archive metadata.');at+=length;}continue;}
  const name=paxPath??[field(345,155),field(0,100)].filter(Boolean).join('/');paxPath=undefined;
  if(!name.startsWith('package/')||name.includes('\\')||name.split('/').includes('..')||path.posix.normalize(name).replace(/\/$/,'')!==name.replace(/\/$/,''))fail('NPM_UPDATE_ARTIFACT','Unsafe npm archive path.');
  if(type==='5')continue;if(type!==''&&type!=='0')fail('NPM_UPDATE_ARTIFACT','Linked or unsupported npm archive entries are not supported.');
  const relative=name.slice(8);if(files.has(relative))fail('NPM_UPDATE_ARTIFACT','Duplicate npm archive entry.');files.add(relative);
  if(relative.endsWith('.node')||path.posix.basename(relative)==='binding.gyp')fail('NPM_UPDATE_SCRIPTS','A target native build is unsupported with install scripts disabled.');
  if(relative==='package.json'){if(size>1024*1024)fail('NPM_UPDATE_ARTIFACT','The package manifest is too large.');try{pkg=JSON.parse(body.toString('utf8'));}catch{fail('NPM_UPDATE_ARTIFACT','Invalid package manifest in npm archive.');}}
 }
 if(!pkg||!files.has('bin/prodero')||!files.has('dist/cli.js'))fail('NPM_UPDATE_ARTIFACT','The target is missing its prebuilt public executable or CLI.');return {pkg,files};
}
export async function runNpmUpdate(options:UpdateOptions={},deps:UpdateDependencies={}):Promise<NpmUpdateResult>{
 if(options.targetVersion&&!stable.test(options.targetVersion))fail('NPM_UPDATE_VERSION','Use one exact stable version (for example 0.2.0), without ranges, tags or URLs.');
 if(!deps.interactive&&!(options.yes&&options.targetVersion))fail('NPM_UPDATE_CONFIRMATION','Use an interactive terminal, or explicitly run prodero update <exact-version> --yes after ending work and closing Codex and Claude.');
 const write=deps.write??console.log,temp=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-npm-update-'));let started=false;
 try{
  await Promise.all(['home','tmp','cache'].map(dir=>fs.mkdir(path.join(temp,dir),{mode:0o700})));await Promise.all(['user.npmrc','global.npmrc'].map(file=>fs.writeFile(path.join(temp,file),'',{mode:0o600})));
  const current=await layout(deps,temp),request=deps.request??fetch;let target:Target;
  try{const data=await bounded(await request(`${REGISTRY}@prodero%2fcurator/${options.targetVersion??'latest'}`,{signal:AbortSignal.timeout(15000),redirect:'error'}),1024*1024);target=manifest(JSON.parse(data.toString()),options.targetVersion);}catch(error){if(error instanceof NpmUpdateError)throw error;fail('NPM_UPDATE_REGISTRY','Cannot verify the public npm target. No install started.');}
  if(comparison(target.version,current.version)<0)fail('NPM_UPDATE_VERSION','Downgrades are not supported. No package was changed.');
  if(target.version===current.version)return {ok:true,status:'current',installedVersion:current.version,targetVersion:target.version,prefix:current.prefix,restartRequired:false,message:'This exact npm version is already installed. No package was changed.',exitCode:0};
  let url:URL;try{url=new URL(target.dist.tarball);}catch{fail('NPM_UPDATE_TARGET','The npm artifact URL is missing or invalid.');}
  if(url.protocol!=='https:'||url.hostname!=='registry.npmjs.org'||url.port||url.username||url.password||url.search||url.hash||url.pathname!==`/@prodero/curator/-/curator-${target.version}.tgz`||!/^sha512-[A-Za-z0-9+/]{86}==$/.test(target.dist.integrity))fail('NPM_UPDATE_TARGET','Only a verified standard npm registry artifact is supported.');
  let tarball:Buffer;try{tarball=await bounded(await request(url.href,{signal:AbortSignal.timeout(30000),redirect:'error'}),MAX_TARBALL);}catch(error){if(error instanceof NpmUpdateError)throw error;fail('NPM_UPDATE_REGISTRY','Cannot download the verified npm artifact. No install started.');}
  if(`sha512-${crypto.createHash('sha512').update(tarball).digest('base64')}`!==target.dist.integrity)fail('NPM_UPDATE_INTEGRITY','The downloaded npm artifact does not match its approved integrity. No install started.');
  const archived=manifest((await archiveManifest(tarball)).pkg,target.version);if(archived.engines.node!==target.engines.node)fail('NPM_UPDATE_TARGET','The artifact engine metadata differs from the registry.');
  write(`Update ${NAME}: ${current.version} → ${target.version}\nDestination: ${current.prefix}\nInstall scripts are disabled. Standard npm production dependencies will be resolved from the public registry.\nFinish work and close Codex and Claude before continuing. This command does not detect or close running applications.`);
  if(options.yes)write('--yes confirms that you have finished work and closed Codex and Claude.');
  if(!options.yes&&!await deps.confirm?.('Have you finished work and closed Codex and Claude? Continue with this update? [y/N] '))return {ok:false,status:'cancelled',installedVersion:current.version,targetVersion:target.version,prefix:current.prefix,restartRequired:false,message:'Update cancelled. No package was changed.',exitCode:1};
  if((await layout(deps,temp)).identity!==current.identity)fail('NPM_UPDATE_CHANGED','The installation or toolchain changed during confirmation. Run the update again to review it.');
  const artifact=path.join(temp,'curator.tgz');await fs.writeFile(artifact,tarball,{mode:0o600});write('Installing the checked npm artifact. Keep Codex and Claude closed until verification finishes.');
  const run=deps.run??runNpmCommand,execOptions={cwd:temp,env:childEnv(temp,current.node),timeout:180000};started=true;
  const installed=await run(current.node,[current.npm,'install','--global',...flags(temp,current.prefix),'--ignore-scripts','--engine-strict','--omit=dev','--no-audit','--no-fund',artifact],execOptions);
  if(installed.code!==0||installed.timedOut||installed.outputIncomplete||installed.exited===false)return {ok:false,status:'failed',installedVersion:null,targetVersion:target.version,prefix:current.prefix,restartRequired:true,message:'npm did not complete successfully. The installation may be partial; keep applications closed and inspect/repair this npm installation before retrying. No rollback is claimed.',exitCode:installed.code&&installed.code>0?installed.code:1};
  // From this boundary onward use only builtin readers/child-process code already
  // loaded above. Never import new helpers from the replaced installation.
  const pkg=JSON.parse(await fs.readFile(path.join(current.root,'package.json'),'utf8'));
  if(pkg.name!==NAME||pkg.version!==target.version||!supportedBin(pkg.bin)||await fs.realpath(path.join(current.prefix,'bin/prodero'))!==path.join(current.root,'bin/prodero'))fail('NPM_UPDATE_VERIFY','npm finished, but the installed package or public executable does not match the target. Keep applications closed and repair the npm installation.');
  await fs.access(path.join(current.prefix,'bin/prodero'),fs.constants.X_OK);
  const version=await run(current.node,[path.join(current.root,'bin/prodero'),'--version'],{...execOptions,timeout:15000}),help=await run(current.node,[path.join(current.root,'bin/prodero'),'--help'],{...execOptions,timeout:15000});
  if(version.outputIncomplete||help.outputIncomplete||version.exited===false||help.exited===false||version.timedOut||help.timedOut||version.code!==0||version.stdout.trim()!==target.version||help.code!==0||!help.stdout.includes('Usage: prodero'))fail('NPM_UPDATE_VERIFY','The installed target failed its CLI smoke checks. Keep applications closed and repair the npm installation.');
  return {ok:true,status:'updated',installedVersion:target.version,targetVersion:target.version,prefix:current.prefix,restartRequired:true,message:`Installed ${NAME}@${target.version} and verified its public CLI. Reopen Codex or Claude and reconnect MCP to load the new runtime. Project data and saved host/dev selections were not changed by this updater.`,exitCode:0};
 }catch(error){if(error instanceof NpmUpdateError)throw error;throw new NpmUpdateError(started?'NPM_UPDATE_VERIFY':'NPM_UPDATE_FAILED',started?'The update outcome could not be verified. Keep applications closed and inspect/repair the npm installation before retrying.':'The npm installation or target could not be verified. No install started.');}
 finally{await fs.rm(temp,{recursive:true,force:true}).catch(()=>{});}
}
