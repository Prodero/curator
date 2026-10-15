// Standalone: this file is copied beside an isolated installation, never imports the checkout.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const [prefix,project,tarball]=process.argv.slice(2);
const pkg=path.join(prefix,'lib/node_modules/@prodero/cli');
const require=createRequire(path.join(pkg,'package.json'));
const {Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
const {StdioClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
const bin=path.join(prefix,'bin/prodero');
const env={...process.env,NODE_PATH:'',PRODERO_RELEASE_SOURCE:'none'};
const run=(cmd,args,cwd=project)=>execFileSync(cmd,args,{cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe']});
await fs.mkdir(project,{recursive:true});run('git',['init','--quiet']);run('git',['config','user.name','RC Fixture']);run('git',['config','user.email','rc@example.invalid']);
assert.equal(run(bin,['--version']).trim(),'0.1.0');assert.match(run(bin,['--help']),/--root/);
for(const args of [['unknown'],['init','--unknown'],['init','--root',project+'/missing']])assert.throws(()=>run(bin,args));
// Exercise the public machine commands with no real user settings or checkout access.
const machineHome=path.join(prefix,'host-fixture-home');
await fs.mkdir(path.join(machineHome,'.codex'),{recursive:true});
await fs.writeFile(path.join(machineHome,'.codex/config.toml'),'model = "fixture-model"\n');
await fs.writeFile(path.join(machineHome,'.claude.json'),'{"customFixture":true}\n');
const machineEnv={...env,HOME:machineHome,CODEX_HOME:path.join(machineHome,'.codex'),CLAUDE_CONFIG_DIR:'',XDG_STATE_HOME:path.join(machineHome,'.local/state'),PATH:''};
const machine=(args)=>JSON.parse(execFileSync(process.execPath,[path.join(pkg,'dist/cli.js'),...args],{cwd:project,env:machineEnv,encoding:'utf8'}));
const machineBefore=await fs.readdir(project);
assert.throws(()=>machine(['install','--all']));
assert.throws(()=>machine(['install']));
const {runInstallWizard}=await import(pathToFileURL(path.join(pkg,'dist/hosts/wizard.js')).href);
const wizard=async answers=>runInstallWizard({interactive:true,write:()=>{},question:async()=>{assert.ok(answers.length,'Unexpected wizard prompt');return answers.shift();}},{home:machineHome,env:machineEnv});
assert.equal(await wizard(['1','y','1','y']),0);
const machineStatus=machine(['status']);assert.equal(machineStatus.scope,'machine');
for(const id of ['codex','claude'])assert.equal(machineStatus.hosts.find(h=>h.id===id).state,'installed');
const machineFiles=[path.join(machineHome,'.codex/config.toml'),path.join(machineHome,'.claude.json')];
const installedBytes=await Promise.all(machineFiles.map(f=>fs.readFile(f,'utf8')));
const installedTimes=await Promise.all(machineFiles.map(async f=>(await fs.stat(f)).mtimeMs));
assert.equal(await wizard([]),0);
assert.deepEqual(await Promise.all(machineFiles.map(f=>fs.readFile(f,'utf8'))),installedBytes);
assert.deepEqual(await Promise.all(machineFiles.map(async f=>(await fs.stat(f)).mtimeMs)),installedTimes);
const {switchRuntime}=await import(pathToFileURL(path.join(pkg,'dist/hosts/runtime.js')).href);
assert.equal((await switchRuntime('codex','package',{home:machineHome,env:machineEnv,workspace:machineHome,dryRun:true})).dryRun,true);
await switchRuntime('codex','package',{home:machineHome,env:machineEnv,workspace:machineHome});
assert.equal(machine(['status']).hosts.find(h=>h.id==='codex').runtimeMode,'package');
assert.equal(machine(['uninstall','--all']).ok,true);
assert.equal(await fs.readFile(machineFiles[0],'utf8'),'model = "fixture-model"\n');
assert.equal(await fs.readFile(machineFiles[1],'utf8'),'{"customFixture":true}\n');
assert.deepEqual(await fs.readdir(project),machineBefore);
assert.equal(run('git',['status','--porcelain']),'');
let client,transport;
const protocolErrors=[],stderrMessages=[];
async function connect(){transport=new StdioClientTransport({command:bin,args:['mcp','--root',project],cwd:prefix,env,stderr:'pipe'});transport.stderr?.on('data',c=>stderrMessages.push(String(c)));client=new Client({name:'prodero-artifact-rc',version:'1'});client.onerror=e=>protocolErrors.push(String(e));await client.connect(transport);}
async function call(name,args={}){const r=await client.callTool({name,arguments:args});assert.ok(!r.isError,JSON.stringify(r));return r.structuredContent;}
const commit=()=>{run('git',['add','.']);run('git',['commit','--quiet','-m','fixture checkpoint']);};
const clean=()=>assert.equal(run('git',['status','--porcelain']),'');
await connect();
try{
 const tools=(await client.listTools()).tools;assert.ok(tools.some(t=>t.name==='prodero_knowledge'));
 for(const {uri} of (await client.listResources()).resources){const resource=await client.readResource({uri});assert.ok(resource.contents[0].text.length>0);if(uri.endsWith('.html')){assert.match(resource.contents[0].text,/<html/i);assert.doesNotMatch(resource.contents[0].text,/(?:src|href)=["'](?:\/Users\/|\/src\/|http:\/\/localhost)/);}}
 assert.equal((await call('prodero_open')).project.initialized,false);await call('prodero_initialize');commit();
 const prepared=await call('prodero_prepare',{task:'RC durable lighthouse fixtures',agent:'artifact-smoke'});const sessionId=prepared.result.session.id;
 await call('prodero_session_record',{sessionId,entries:[{type:'decision',title:'Lighthouse fixtures',content:'Lighthouse integration tests must reuse the shared fixtures.',scopeHint:'global',importanceHint:'important'}]});
 assert.equal(JSON.parse(run(bin,['sync-sessions','--root',project])).sessions,0,'CLI sync-sessions must leave active observations untouched');
 const sync=await call('prodero_sync');assert.equal(sync.action,'memory-sync');assert.equal(sync.result.state,'awaiting_selection');
 assert.equal(sync.result.recovery.sessions,1,'Sync Memory recovers pending deterministic observations before selection');
 assert.equal((await call('prodero_sync',{workflowId:sync.result.id})).result.id,sync.result.id);
 assert.equal(JSON.parse(run(bin,['sync','--root',project])).id,sync.result.id,'CLI Sync resumes the same workflow');
 await call('prodero_session_record',{sessionId,entries:[{type:'discovery',title:'Lighthouse isolation',content:'Lighthouse integration tests keep temporary projects isolated.'}]});
 const closed=await call('prodero_session_close',{sessionId});assert.equal(closed.result.learned.syncState,'synchronized');assert.equal(closed.result.synchronization.sessions,1);
 const next=await call('prodero_prepare',{task:'Lighthouse fixtures',agent:'artifact-smoke'});assert.equal(next.result.automaticSync.sessions,0,'Prepare must not synchronize an already closed and synchronized session again');assert.match(JSON.stringify(next),/Lighthouse integration tests/i);await call('prodero_session_close',{sessionId:next.result.session.id});
 const remembered=await call('prodero_remember',{content:'Harbor release checks use deterministic fixtures.',title:'Harbor checks',scope:'path',path:'tests',kind:'decision'});const id=remembered.result.item.id;
 const search=await call('prodero_memory_search',{query:'Harbor',layer:'local'});assert.ok(search.result.matches.some(i=>i.id===id));
 const detail=(await call('prodero_knowledge',{id})).result.detail;
 await call('prodero_knowledge_mutate',{id,revision:detail.revision,action:'edit',approved:true,title:detail.title,content:'Harbor release checks use deterministic shared fixtures.'});
 const stale=await client.callTool({name:'prodero_knowledge_mutate',arguments:{id,revision:detail.revision,action:'retire',approved:true}});assert.equal(stale.isError,true);
 const secret='sk-proj-'+ 'SYNTHETICREJECTEDCREDENTIAL'.repeat(3);const rejected=await client.callTool({name:'prodero_remember',arguments:{content:`API_KEY=${secret}`}});assert.equal(rejected.isError,true);assert.ok(!JSON.stringify(rejected).includes(secret));
 async function noSecret(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())await noSecret(p);else assert.ok(!(await fs.readFile(p,'utf8')).includes(secret),`Rejected secret in ${p}`);}}
 await noSecret(path.join(project,'.prodero'));
 clean();await client.close();await fs.rm(path.join(project,'.prodero/.cache'),{recursive:true,force:true});await connect();assert.match(JSON.stringify(await call('prodero_knowledge',{id})),/deterministic shared/);clean();
 const preview=(await call('prodero_promotion_preview',{ids:[id]})).preview;assert.ok(preview.actions.length); // synthetic fixture approval, never user project publication
 const promoted=await call('prodero_promote',{approved:true,preview});assert.ok(promoted.result.published>0);
 const changes=run('git',['status','--porcelain']);assert.match(changes,/\.prodero\/memory\//);assert.ok(changes.trim().split('\n').every(line=>line.includes('.prodero/')),changes);commit();
 await client.close();
 const snapshot=async()=>{const result={};async function walk(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){if(e.name==='.cache')continue;const p=path.join(dir,e.name);if(e.isDirectory())await walk(p);else result[path.relative(project,p)]=await fs.readFile(p,'utf8');}}await walk(path.join(project,'.prodero'));return result;};
 const before=await snapshot();assert.ok(!JSON.stringify(before).includes(secret));
 // A synthetic next patch package checks a real package-manager replacement, without publishing.
 const upgraded=path.join(prefix,'upgrade-fixture');await fs.cp(pkg,upgraded,{recursive:true});const manifest=JSON.parse(await fs.readFile(path.join(upgraded,'package.json'),'utf8'));manifest.version='0.1.1';await fs.writeFile(path.join(upgraded,'package.json'),JSON.stringify(manifest));
 const packed=JSON.parse(run('npm',['pack','--ignore-scripts','--json'],upgraded))[0].filename;
 run('npm',['install','--global','--prefix',prefix,'--omit=dev','--ignore-scripts','--no-audit','--no-fund',path.join(upgraded,packed)],prefix);assert.equal(run(bin,['--version']).trim(),'0.1.1');assert.deepEqual(await snapshot(),before);
 await connect();assert.ok((await call('prodero_knowledge')).result.counts.versioned>0);clean();await client.close();
 // Restore the actual RC for human/primary host inspection.
 run('npm',['install','--global','--prefix',prefix,'--omit=dev','--ignore-scripts','--no-audit','--no-fund',tarball],prefix);assert.equal(run(bin,['--version']).trim(),'0.1.0');assert.deepEqual(await snapshot(),before);
 // Final RC regressions run against the installed package, with the build checkout offline.
 const nested=path.join(project,'uninitialized-child');await fs.mkdir(nested);
 const parentBefore=await snapshot();
 assert.throws(()=>run(bin,['init','--root',nested]),/PRODERO_NESTED_ROOT/);
 await connect();
 const nestedResult=await client.callTool({name:'prodero_initialize',arguments:{projectRoot:nested}});
 assert.equal(nestedResult.isError,true);assert.match(JSON.stringify(nestedResult),/PRODERO_ROOT_UNAUTHORIZED/);
 assert.deepEqual(await snapshot(),parentBefore);clean();
 const invalidScope=await client.callTool({name:'prodero_remember',arguments:{content:'Safe fixture content.',scope:secret}});
 assert.equal(invalidScope.isError,true);assert.ok(!JSON.stringify(invalidScope).includes(secret));assert.match(JSON.stringify(invalidScope),/PRODERO_INVALID_ARGUMENT/);
 const journal=path.join(project,'.prodero/.transactions/pending.json'),malformed='password=synthetic_journal_fixture';
 await fs.writeFile(journal,malformed);
 // Prepare recovers pending writes; Sync Memory may just reopen an existing workflow.
 const badJournal=await client.callTool({name:'prodero_prepare',arguments:{}});
 assert.equal(badJournal.isError,true);assert.ok(!JSON.stringify(badJournal).includes(malformed));assert.match(JSON.stringify(badJournal),/PRODERO_INVALID_JOURNAL/);
 assert.equal(await fs.readFile(journal,'utf8'),malformed);await fs.rm(journal);
 const configPath=path.join(project,'.prodero/config.json'),configText=await fs.readFile(configPath,'utf8');
 await fs.writeFile(configPath,JSON.stringify({...JSON.parse(configText),schemaVersion:99}));const futureBefore=await snapshot();
 for(const [name,args] of [['prodero_open',{}],['prodero_prepare',{}],['prodero_skill_create',{title:'Rejected future skill',description:'Fixture only',content:'Do not write unknown canonical state.'}],['prodero_skills',{}],['prodero_initialize',{}],['prodero_sync',{}]]){
  const r=await client.callTool({name,arguments:args});
  if(['prodero_open','prodero_prepare'].includes(name)){assert.notEqual(r.isError,true,name);assert.equal(r.structuredContent.action,'migration');assert.equal(r.structuredContent.plan.state,'runtime-too-old');}
  else {assert.equal(r.isError,true,name);assert.match(JSON.stringify(r),/PRODERO_SCHEMA_NEWER/);}
  assert.deepEqual(await snapshot(),futureBefore,name);
 }
 await fs.writeFile(configPath,configText);await client.close();clean();
 assert.deepEqual(protocolErrors,[]);assert.deepEqual(stderrMessages,[]);
 console.log(JSON.stringify({ok:true,node:process.version,platform:process.platform,artifact:tarball,prefix,project,checks:['machine install/status/idempotency/uninstall with isolated HOME and no project changes','RC-01 nested root rejection','RC-02 future schema immutability','RC-04 diagnostic privacy','Sync Memory MCP/CLI workflow and closed-only sync-sessions','CLI','stdio MCP','App/plugin resources','session auto-sync','remember/search/edit','stale revision','secret rejection','cache rebuild/restart','Git-clean Local','reviewed synthetic promotion','manual synthetic patch upgrade preserves canonical storage']},null,2));
}finally{await client?.close();}
