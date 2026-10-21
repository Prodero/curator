// Standalone, copied into the explicitly approved Linux Docker lab. Never run
// against a working host prefix. This is a synthetic candidate -> published
// transition, not evidence of an upgrade between two published releases.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const [candidate,output]=process.argv.slice(2);
assert.equal(process.platform,'linux');assert.equal(process.getuid(),1000);
assert.equal(process.env.HOME,'/home/node');
assert.equal(process.env.NPM_CONFIG_PREFIX,'/home/node/.npm-global');
assert.ok(candidate?.startsWith('/home/node/evidence/'));
assert.ok(output?.startsWith('/home/node/evidence/'));
const prefix='/home/node/.npm-global',pkg=path.join(prefix,'lib/node_modules/@prodero/curator');
const bin=path.join(prefix,'bin/prodero');
await fs.mkdir(output,{recursive:false});
const command=(file,args,options={})=>{
 const r=spawnSync(file,args,{cwd:output,encoding:'utf8',timeout:180000,...options});
 return {status:r.status,signal:r.signal,stdout:r.stdout??'',stderr:r.stderr??'',error:r.error?.code};
};
const checked=(file,args,options)=>{const r=command(file,args,options);assert.equal(r.status,0,JSON.stringify({file,args,...r}));return r.stdout.trim();};
const save=async(name,value)=>fs.writeFile(path.join(output,name),JSON.stringify(value,null,2)+'\n');
const install=artifact=>checked('npm',['install','--global','--prefix',prefix,'--ignore-scripts','--omit=dev','--no-audit','--no-fund','--registry=https://registry.npmjs.org',artifact]);
const files=async root=>{
 const result={};async function walk(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){
  if(e.name==='.git'||e.name==='.cache')continue;
  const p=path.join(dir,e.name),s=await fs.lstat(p);
  if(s.isDirectory())await walk(p);else if(s.isFile())result[path.relative(root,p)]={mode:s.mode&0o777,hash:crypto.createHash('sha256').update(await fs.readFile(p)).digest('hex')};
  else throw Error('Unexpected fixture entry');
 }}await walk(root);return result;
};

const baseline=JSON.parse(await fs.readFile(path.join(pkg,'package.json'),'utf8'));
assert.equal(baseline.version,'0.1.0');
const previousProject=await files('/home/node/work/project');
const candidateHash=crypto.createHash('sha256').update(await fs.readFile(candidate)).digest('hex');
install(candidate);
const refused=command(bin,['update']);assert.equal(refused.status,1);assert.match(refused.stdout,/NPM_UPDATE_CONFIRMATION/);
const same=command(bin,['update','0.1.0','--yes']);assert.equal(same.status,0,JSON.stringify(same));assert.match(same.stdout,/already installed/);
await save('candidate-cli.json',{refused,same});

const require=createRequire(path.join(pkg,'package.json'));
const {Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
const {StdioClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
const project=path.join(output,'project'),hostHome=path.join(output,'host-home');
await fs.mkdir(project);checked('git',['init','--quiet'],{cwd:project});
const {initializeProject}=await import(pathToFileURL(path.join(pkg,'dist/core/project.js')).href);
await initializeProject(project);
await fs.mkdir(path.join(project,'.prodero/local'),{recursive:true});
await fs.writeFile(path.join(project,'.prodero/local/preferences.json'),'\n{"version":1,"presentation":{"theme":"dark-neon","mode":"text"}}\n');
const fixtureEnv={...process.env,HOME:hostHome,CODEX_HOME:path.join(hostHome,'.codex'),XDG_STATE_HOME:path.join(hostHome,'.local/state'),CLAUDE_CONFIG_DIR:'',PRODERO_RELEASE_SOURCE:'none'};
await fs.mkdir(path.join(hostHome,'.codex'),{recursive:true});
await fs.writeFile(path.join(hostHome,'.codex/config.toml'),'model = "synthetic-preserved"\n');
const {machineIntegrations}=await import(pathToFileURL(path.join(pkg,'dist/hosts/manager.js')).href);
assert.equal((await machineIntegrations('install','codex',{home:hostHome,env:fixtureEnv})).ok,true);
const dev=path.join(output,'dev-checkout');
for(const relative of ['src/cli.ts','scripts/mcp-dev.ts','scripts/mcp-dev-launcher.mjs','node_modules/tsx/package.json']){
 const file=path.join(dev,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,relative.endsWith('.json')?'{}':'// synthetic saved-selection fixture; never executed\n');
}
await fs.writeFile(path.join(dev,'package.json'),JSON.stringify({name:'@prodero/curator',version:'0.0.1',scripts:{'mcp:dev':'node scripts/mcp-dev-launcher.mjs'}}));
const {switchRuntime}=await import(pathToFileURL(path.join(pkg,'dist/hosts/runtime.js')).href);
await switchRuntime('codex','dev',{home:hostHome,env:fixtureEnv,workspace:project,checkout:dev});
const receipt=path.join(hostHome,'.local/state/prodero/host-integrations/codex/receipt.json');
assert.equal(JSON.parse(await fs.readFile(receipt,'utf8')).runtime.mode,'dev');
// The configured dev checkout is a saved selection fixture, not a launched host.
const connect=async()=>{const c=new Client({name:'terminal-updater-smoke',version:'1'});await c.connect(new StdioClientTransport({command:bin,args:['mcp','--root',project],cwd:project,env:{...process.env,PRODERO_RELEASE_SOURCE:'none'},stderr:'pipe'}));return c;};
let client=await connect();
const snapshotBeforeInstructions=await files(project);
const instructions=await client.callTool({name:'prodero_update',arguments:{projectRoot:project}});
assert.equal(instructions.isError,undefined);assert.equal(instructions.structuredContent.instructionOnly,true);
assert.equal(instructions.structuredContent.command,'prodero update');
assert.deepEqual(await files(project),snapshotBeforeInstructions);await client.close();

// Build an explicitly labelled synthetic older candidate, retaining compiled
// updater code. No repository version or published registry record is changed.
const unpack=path.join(output,'synthetic-old');await fs.mkdir(unpack);
checked('tar',['-xzf',candidate,'-C',unpack]);
const manifest=path.join(unpack,'package/package.json'),old=JSON.parse(await fs.readFile(manifest,'utf8'));
old.version='0.0.1';await fs.writeFile(manifest,JSON.stringify(old,null,2)+'\n');
const packed=JSON.parse(checked('npm',['pack','--ignore-scripts','--json'],{cwd:path.join(unpack,'package')}))[0];
const oldArtifact=path.join(unpack,'package',packed.filename);install(oldArtifact);
assert.equal(checked(bin,['--version']),'0.0.1');
// A deliberately older project format must remain unchanged by package update
// and be offered through the existing gate only after the new MCP is opened.
const config=path.join(project,'.prodero/config.json'),configValue=JSON.parse(await fs.readFile(config,'utf8'));
configValue.schemaVersion=7;await fs.writeFile(config,JSON.stringify(configValue,null,2)+'\n');
const before={project:await files(project),hosts:await files(hostHome),dev:await files(dev)};
const result=command(bin,['update','0.1.0','--yes'],{cwd:project});
await save('terminal-result.json',result);assert.equal(result.status,0,JSON.stringify(result));assert.match(result.stdout,/Installed @prodero\/curator@0.1.0/);
assert.equal(checked(bin,['--version']),'0.1.0');
assert.deepEqual(await files(project),before.project);assert.deepEqual(await files(hostHome),before.hosts);assert.deepEqual(await files(dev),before.dev);
assert.equal(JSON.parse(await fs.readFile(receipt,'utf8')).runtime.mode,'dev');
client=await connect();
const opened=await client.callTool({name:'prodero_open',arguments:{}});
assert.equal(opened.isError,undefined);assert.equal(opened.structuredContent.action,'migration');
assert.equal(opened.structuredContent.plan.state,'available');await client.close();
assert.deepEqual(await files(project),before.project);
assert.deepEqual(await files('/home/node/work/project'),previousProject);
const targetResponse=await fetch('https://registry.npmjs.org/@prodero%2fcurator/0.1.0',{signal:AbortSignal.timeout(15000),redirect:'error'});assert.equal(targetResponse.status,200);const targetMetadata=await targetResponse.json();
const summary={ok:true,scenario:'synthetic updater-capable candidate 0.0.1 -> official published 0.1.0; not published-to-published upgrade',genuinePublishedUpgrade:false,candidateSha256:candidateHash,oldArtifactSha256:crypto.createHash('sha256').update(await fs.readFile(oldArtifact)).digest('hex'),targetIntegrity:targetMetadata.dist.integrity,node:process.version,npm:checked('npm',['--version']),platform:process.platform,arch:process.arch,checks:['candidate non-TTY refusal','explicit equal-version no-op','MCP instruction-only and project unchanged','real synchronous CLI selfreplacement using official npm artifact','fresh public CLI version','canonical project/modes unchanged','saved synthetic dev selection and host receipt bytes unchanged','dev checkout unchanged','original lab knowledge project preserved','separate Open migration proposal without apply'],limits:['synthetic saved dev selection was not executed','no real host or browser UI certification','candidate distribution is local; only target0.1.0 is published']};
await save('result.json',summary);console.log(JSON.stringify(summary,null,2));
