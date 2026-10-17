import fs from 'node:fs/promises';
import {openSync,writeSync,closeSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {validatePackage} from './validate-package.mjs';
const {values}=parseArgs({options:{mode:{type:'string',default:'full'},integration:{type:'boolean',default:false}}});
const mode=values.mode;
if(!['fast','full'].includes(mode))throw new Error('Expected --mode fast or --mode full');
const integration=mode==='full'||values.integration;
const started=performance.now(),timings=[];
const source=fileURLToPath(new URL('..',import.meta.url));
const root=process.env.PRODERO_GATE_OUTPUT ? path.resolve(process.env.PRODERO_GATE_OUTPUT) : await fs.mkdtemp(path.join(os.tmpdir(),'prodero-rc-'));
await fs.mkdir(root,{recursive:true});const checkout=path.join(root,'checkout'),prefix=path.join(root,'install');
console.log(`Release evidence: ${root}`);
const env={...process.env,PRODERO_RELEASE_SOURCE:'none',npm_config_cache:process.env.npm_config_cache||path.join(root,'npm-cache')};
// Stream diagnostics immediately so a canceled CI job retains partial test output.
async function run(cmd,args,cwd,log){
 const commandStarted=performance.now();
 const fd=log?openSync(path.join(root,log),'w'):null;
 const capture=args[0]==='pack';let stdout='',stderr='';
 try {
  const child=spawn(cmd,args,{cwd,env,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',chunk=>{if(fd!==null)writeSync(fd,chunk);if(!capture)process.stdout.write(chunk);stdout=capture?stdout+chunk:(stdout+chunk).slice(-4000);});
  child.stderr.on('data',chunk=>{if(fd!==null)writeSync(fd,chunk);process.stderr.write(chunk);stderr=(stderr+chunk).slice(-2000);});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  if(code!==0)throw new Error(`${cmd} ${args.join(' ')} failed (${code}): ${stdout.slice(-4000)} ${stderr}`);
  return stdout;
 } finally {if(fd!==null)closeSync(fd);timings.push({command:[cmd,...args],durationMs:Math.round(performance.now()-commandStarted)});}
}

const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:source,encoding:'utf8'}).split('\0').filter(Boolean);
await fs.mkdir(checkout,{recursive:true});
for(const f of new Set(files)){if(/^(node_modules|dist|dist-ui)\//.test(f))throw new Error(`Build output tracked: ${f}`);const stat=await fs.lstat(path.join(source,f)).catch(()=>null);if(!stat)continue;if(!stat.isFile())throw new Error(`Unexpected tracked non-file: ${f}`);await fs.mkdir(path.dirname(path.join(checkout,f)),{recursive:true});await fs.copyFile(path.join(source,f),path.join(checkout,f));}
const tracked=execFileSync('git',['ls-files','-z'],{cwd:source,encoding:'utf8'}).split('\0');assertTree(tracked);
function assertTree(names){for(const f of names)if(/^\.prodero\/(?:local\/|\.cache\/|\.transactions\/|sessions\/[^.].*\.md$|checkpoints\/.*\.json$)/.test(f))throw new Error(`Runtime artifact in public Git tree: ${f}`);}
await run('git',['init','--quiet'],checkout);await run('git',['add','.'],checkout);await run('git',['-c','user.name=RC','-c','user.email=rc@example.invalid','commit','--quiet','-m','Clean RC snapshot'],checkout);
await run('npm',['ci','--no-audit','--no-fund'],checkout,'npm-ci.log');console.log('Clean npm ci passed');
await run('npm',['run','build'],checkout,'build.log');
const pack=JSON.parse(await run('npm',['pack','--ignore-scripts','--json'],checkout,'pack.json'))[0];const tarball=path.join(root,pack.filename);await fs.rename(path.join(checkout,pack.filename),tarball);
const {hasSecret}=await import(pathToFileURL(path.join(checkout,'dist/core/secrets.js')).href);
await validatePackage(checkout,pack,hasSecret);console.log('Package resources and documentation links passed');
await run(process.execPath,['scripts/run-tests.mjs',mode],checkout,'test.log');console.log(`Build and ${mode} tests passed`);
if(integration){
await fs.mkdir(prefix,{recursive:true});await run('npm',['install','--global','--prefix',prefix,'--omit=dev','--ignore-scripts','--no-audit','--no-fund',tarball],prefix,'install.log');
const installed=path.join(prefix,'lib/node_modules/@prodero/curator');for(const dep of ['typescript','tsx','vite']){if(await fs.stat(path.join(installed,'node_modules',dep)).catch(()=>null))throw new Error(`Dev dependency installed: ${dep}`);}
await fs.copyFile(path.join(checkout,'scripts/artifact-smoke.mjs'),path.join(root,'artifact-smoke.mjs'));
// Make it impossible for the smoke runner to use this checkout or its node_modules.
await fs.rename(checkout,path.join(root,'checkout-offline'));
await run(process.execPath,[path.join(root,'artifact-smoke.mjs'),prefix,path.join(root,'project'),tarball],root,'artifact-smoke.log');
}
const summary={ok:true,mode,integration,durationMs:Math.round(performance.now()-started),timings,node:process.version,platform:process.platform,arch:process.arch,tarball,sha256:crypto.createHash('sha256').update(await fs.readFile(tarball)).digest('hex'),files:pack.files.length,unpackedSize:pack.unpackedSize};await fs.writeFile(path.join(root,'result.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary,null,2));
