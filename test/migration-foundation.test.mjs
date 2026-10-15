// Invented toy-project fixtures; no real project incidents or operational records.
import { readAgentInstructions } from "./helpers/agent-instructions.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {initializeProject,prepareProject,rememberProjectKnowledge} from '../dist/core/project.js';
import {readConfig,writeConfig} from '../dist/core/storage.js';
import {MIGRATIONS,planProjectMigration,applyProjectMigration,migrateProject} from '../dist/core/migrations.js';
import {writeKnowledge,renderKnowledge,parseKnowledge} from '../dist/core/memory.js';
import {createServer} from '../dist/server.js';
import {buildViewModel,renderText} from '../dist/presentation.js';
import {lifecycleUi} from './helpers/lifecycle-ui.mjs';
const exec=promisify(execFile);
async function fixture(t,old=false) {
 const root=await fs.mkdtemp('/tmp/prodero-migration-foundation-');t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'.git'));await initializeProject(root);
 const item={id:'mem_preserved',scope:'global',scopeRef:null,category:'instruction',priority:'important',status:'active',title:'Preserve data',content:'Preserve existing knowledge.',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',sourceSessions:[],derivedFrom:[],supersedes:[],related:[],relations:[]};
 await writeKnowledge(root,item,false,'local');await writeKnowledge(root,{...item,id:'mem_shared'},false,'versioned');
 if(old){const c=await readConfig(root);c.schemaVersion=5;c.knowledgeSchemaVersion=3;await writeConfig(root,c);}
 return root;
}
const file=(root,name)=>path.join(root,'.prodero',name);
async function tree(root){const out={};async function walk(dir,prefix=''){for(const ent of await fs.readdir(dir,{withFileTypes:true})){const rel=prefix+ent.name;if(ent.isDirectory())await walk(path.join(dir,ent.name),rel+'/');else out[rel]=await fs.readFile(path.join(dir,ent.name),'utf8');}}await walk(file(root,''));return out;}
const canonical=(snapshot)=>Object.fromEntries(Object.entries(snapshot).filter(([k])=>!/^\.(cache|transactions|backups|migrations)\//.test(k)));
async function client(t,root){const server=createServer({projectRoot:root});const client=new Client({name:'migration-test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});return (name,args={})=>client.callTool({name,arguments:args});}

test('current plan is read-only and has no migration controls; old project plans ordered metadata update',async t=>{
 const root=await fixture(t);let before=await tree(root);const current=await planProjectMigration(root);assert.equal(current.state,'current');assert.deepEqual(await tree(root),before);
 const call=await client(t,root);const opened=(await call('prodero_open')).structuredContent;
 assert.ok(!buildViewModel(opened).actions.some(a=>a.tool==='prodero_migrate'));
 const ui=await lifecycleUi();assert.doesNotMatch(ui.render({...opened,presentation:{resolved:'ui'}}),/data-action="migration-|Knowledge update/);
 const c=await readConfig(root);c.schemaVersion=3;c.knowledgeSchemaVersion=3;await writeConfig(root,c);before=await tree(root);
 const plan=await planProjectMigration(root);assert.equal(plan.state,'available');assert.deepEqual(plan.current,{project:3,knowledge:3});assert.deepEqual(plan.migrations.map(s=>[s.from,s.to]),[[3,4],[4,5],[5,6],[6,7],[7,8]]);assert.equal(plan.backupRequired,true);assert.deepEqual(await tree(root),before);
});

test('approval, stale plans, backup-before-transform, rebuild and idempotency',async t=>{
 const root=await fixture(t,true),before=await tree(root),plan=await planProjectMigration(root);
 await assert.rejects(applyProjectMigration(root,{approved:false,planId:plan.planId}),/approval/);
 await assert.rejects(applyProjectMigration(root,{approved:true,planId:'stale'}),/changed/);
 const original=MIGRATIONS[5];let transformed=false;
 MIGRATIONS[5]={...original,run:async(stage,config)=>{
  assert.notEqual(stage,root);const pending=JSON.parse(await fs.readFile(file(root,'.transactions/migration.json'),'utf8'));
  assert.equal(await fs.readFile(file(root,`${pending.backup}/local/memory/mem_preserved.md`),'utf8'),before['local/memory/mem_preserved.md']);
  assert.equal(await fs.readFile(file(root,'config.json'),'utf8'),before['config.json']);transformed=true;await original.run(stage,config);
 }};
 let result;try{result=await applyProjectMigration(root,{approved:true,planId:plan.planId});}finally{MIGRATIONS[5]=original;}
 assert.equal(transformed,true);assert.equal(result.plan.state,'current');assert.equal((await readConfig(root)).knowledgeSchemaVersion,3);
 for(const name of ['memory-index.json','session-index.json','knowledge-graph.json'])assert.ok(await fs.stat(file(root,'.cache/'+name)));
 for(const name of ['local/memory/mem_preserved.md','memory/mem_shared.md'])assert.equal(await fs.readFile(file(root,name),'utf8'),before[name]);
 assert.equal((await applyProjectMigration(root,{approved:true,planId:plan.planId})).migrated,false);
 assert.equal((await migrateProject(root,await readConfig(root))).migrated,false);
 const histories=(await fs.readdir(file(root,'.migrations'))).filter(n=>n.endsWith('.json'));assert.equal(histories.length,1);
 const history=JSON.parse(await fs.readFile(file(root,'.migrations/'+histories[0]),'utf8'));assert.equal(history.status,'completed');assert.ok(history.completedAt);assert.ok(history.backup);
});

for(const mode of ['transform','validation','commit','rebuild'])test(`failure during ${mode} restores canonical state and versions`,async t=>{
 const root=await fixture(t,true),before=canonical(await tree(root)),original=MIGRATIONS[5];
 const rename=fs.rename;let injected=false;
 MIGRATIONS[5]={...original,run:async(stage,config)=>{await original.run(stage,config);if(mode==='transform')throw new Error('injected transform');},validate:async()=>{if(mode==='validation')throw new Error('injected validation');}};
 if(mode==='commit'||mode==='rebuild')fs.rename=async(a,b)=>{if(!injected&&String(b)==file(root,mode==='commit'?'memory/mem_shared.md':'.cache/memory-index.json')){injected=true;throw new Error('injected '+mode);}return rename(a,b);};
 try{await assert.rejects(migrateProject(root,await readConfig(root)),/Migration rolled back/);}finally{MIGRATIONS[5]=original;fs.rename=rename;}
 assert.deepEqual(canonical(await tree(root)),before);assert.equal((await readConfig(root)).schemaVersion,5);assert.equal((await planProjectMigration(root)).state,'available');
});

test('partial backup failure cannot mutate canonical data or publish a journal',async t=>{
 const root=await fixture(t,true),before=canonical(await tree(root));const mkdir=fs.mkdir;
 fs.mkdir=async(a,o)=>{if(String(a).includes('.backups/')&&String(a).endsWith('/memory'))throw new Error('partial backup');return mkdir(a,o);};
 try{await assert.rejects(migrateProject(root,await readConfig(root)),/partial backup/);}finally{fs.mkdir=mkdir;}
 assert.deepEqual(canonical(await tree(root)),before);assert.equal((await planProjectMigration(root)).state,'available');await assert.rejects(fs.stat(file(root,'.transactions/migration.json')),{code:'ENOENT'});
});

test('process interruption has explicit recovery; backup corruption blocks destructive restoration',async t=>{
 for(const corrupt of [false,true]){
  const root=await fixture(t,true),before=canonical(await tree(root));
  await assert.rejects(exec(process.execPath,['--input-type=module','-e',`import {MIGRATIONS,migrateProject} from './dist/core/migrations.js';import {readConfig} from './dist/core/storage.js';MIGRATIONS[5].run=async()=>process.exit(23);const root=process.argv[1];await migrateProject(root,await readConfig(root));`,root]),e=>e.code===23);
  const plan=await planProjectMigration(root);assert.equal(plan.state,'recovery-required');await assert.rejects(prepareProject(root,{task:'Preserve task'}),/MIGRATION_REQUIRED/);
  if(corrupt){const journal=JSON.parse(await fs.readFile(file(root,'.transactions/migration.json'),'utf8'));await fs.writeFile(file(root,journal.backup+'/memory/mem_shared.md'),'corrupted');await assert.rejects(applyProjectMigration(root,{approved:true,planId:plan.planId,recover:true}),/integrity/);}
  else {assert.equal((await applyProjectMigration(root,{approved:true,planId:plan.planId,recover:true})).recovered,true);assert.deepEqual(canonical(await tree(root)),before);const p=await planProjectMigration(root);await applyProjectMigration(root,{approved:true,planId:p.planId});assert.equal((await planProjectMigration(root)).state,'current');}
 }
});

for(const domain of ['schemaVersion','knowledgeSchemaVersion'])test(`newer ${domain} blocks all attempted canonical mutations, Open/Prepare give structured diagnostics`,async t=>{
 const root=await fixture(t);const cfg=await readConfig(root);cfg[domain]=99;await fs.writeFile(file(root,'config.json'),JSON.stringify(cfg));const before=await tree(root);
 assert.equal((await planProjectMigration(root)).state,'runtime-too-old');
 await assert.rejects(rememberProjectKnowledge(root,{kind:'rule',content:'Do not save this.'}),/SCHEMA_NEWER|MIGRATION_REQUIRED/);
 await assert.rejects(writeKnowledge(root,{...parseKnowledge(before['memory/mem_shared.md'],'mem_shared.md'),id:'mem_new'},false,'local'),/SCHEMA_NEWER/);
 await assert.rejects(writeConfig(root,{...cfg,[domain]:1}),/SCHEMA_NEWER/);
 const call=await client(t,root);
 for(const tool of ['prodero_open','prodero_prepare','prodero_status','prodero_migrate']){const r=await call(tool);assert.equal(r.isError,undefined,JSON.stringify(r));assert.equal(r.structuredContent.plan.state,'runtime-too-old');assert.match(r.content[0].text,/Update Curator/);}
 for(const tool of ['prodero_remember','prodero_session_record','prodero_sync']){const args=tool==='prodero_remember'?{kind:'rule',content:'Never save this.'}:tool==='prodero_session_record'?{sessionId:'sess_missing',entries:[]}:{};assert.equal((await call(tool,args)).isError,true);}
 assert.deepEqual(await tree(root),before);
});

test('Open/Prepare text parity, approved migration and resumable original task across connections',async t=>{
 const root=await fixture(t,true),call=await client(t,root),before=await tree(root);
 const opened=(await call('prodero_open')).structuredContent;assert.equal(opened.plan.state,'available');
 const blocked=(await call('prodero_text',{tool:'prodero_prepare',arguments:{task:'Fix ToyGrid tests',agent:'fixture',purpose:'debug'}})).structuredContent;
 assert.equal(blocked.resume.arguments.task,'Fix ToyGrid tests');assert.deepEqual(await tree(root),before);
 assert.match(renderText(buildViewModel(blocked)),/backup/);
 const actions=buildViewModel(blocked).actions;assert.equal(actions[0].approval,true);
 const updated=await call('prodero_text',{tool:'prodero_migrate',arguments:actions[0].arguments});assert.equal(updated.isError,undefined,JSON.stringify(updated));assert.equal(updated.structuredContent.completed,true);
 const restarted=await client(t,root);const resume=updated.structuredContent.resume;
 const prepared=await restarted(resume.tool,resume.arguments);assert.equal(prepared.structuredContent.action,'prepare');assert.equal(prepared.structuredContent.result.context.query,'Fix ToyGrid tests');
 assert.equal((await restarted('prodero_open')).structuredContent.action,'open');
});

test('UI shows updating, performs real resume tool call, and removes controls when current',async t=>{
 const root=await fixture(t,true),call=await client(t,root),initial=(await call('prodero_prepare',{task:'Fix ToyGrid tests'})).structuredContent,calls=[];
 const ui=await lifecycleUi({callServerTool:async request=>{calls.push(request);return call(request.name,{...request.arguments,presentation:'ui'});}});
 assert.match(ui.render({...initial,presentation:{resolved:'ui'}}),/Knowledge update available/);ui.click('migration-0');
 for(let i=0;i<200&&!ui.html.includes('Context Ready');i++)await new Promise(r=>setTimeout(r,20));
 assert.equal(calls[0].name,'prodero_migrate');assert.equal(calls[1]?.name,'prodero_prepare');assert.equal(calls[1]?.arguments.task,'Fix ToyGrid tests');assert.ok(ui.renders.some(s=>s.includes('Updating project knowledge')));assert.doesNotMatch(ui.html,/data-action="migration-/);
});

test('review-required migration cannot be approved with a boolean',async t=>{
 const root=await fixture(t,true),original=MIGRATIONS[5];MIGRATIONS[5]={...original,kind:'review-required'};
 try{const plan=await planProjectMigration(root);assert.equal(plan.state,'review-required');assert.equal(buildViewModel({action:'migration',root,plan}).actions.length,0);await assert.rejects(applyProjectMigration(root,{approved:true,planId:plan.planId}),/review-required/);await assert.rejects(migrateProject(root,await readConfig(root)),/semantic review/);}finally{MIGRATIONS[5]=original;}
});

// A copied runtime with synthetic target metadata exercises future knowledge transitions
// without adding a production semantic migration or changing any real project's data.
test('future runtime fixture: independent old knowledge, ordered multi-step knowledge registry and validation',async t=>{
 const dir=await fs.mkdtemp('/tmp/prodero-future-runtime-');t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.cp(path.resolve('dist'),path.join(dir,'dist'),{recursive:true});await fs.copyFile('package.json',path.join(dir,'package.json'));await fs.symlink(path.resolve('node_modules'),path.join(dir,'node_modules'));await fs.writeFile(path.join(dir,'prodero.release.json'),JSON.stringify({formatVersion:1,schemaVersion:8,knowledgeSchemaVersion:4}));
 const root=await fixture(t);await fs.rm(file(root,'memory/mem_shared.md'));await fs.rm(file(root,'local/memory/mem_preserved.md'));const c=await readConfig(root);c.knowledgeSchemaVersion=1;await writeConfig(root,c);const result=await exec(process.execPath,['--input-type=module','-e',`
 import assert from 'node:assert/strict';import {KNOWLEDGE_MIGRATIONS,planProjectMigration,applyProjectMigration} from './dist/core/migrations.js';import {readConfig} from './dist/core/storage.js';
 const calls=[];for(const from of [1,2,3])KNOWLEDGE_MIGRATIONS[from]={from,to:from+1,kind:'compatible-semantic',description:'Synthetic metadata fixture',invalidatesDerivedState:true,modifiesVersionedKnowledge:false,run:async(root,c)=>{calls.push(from);c['fixture'+from]=true;},validate:async(root,c)=>assert.equal(c.knowledgeSchemaVersion,from+1)};
 const root=process.argv[1],plan=await planProjectMigration(root);assert.equal(plan.current.project,8);assert.equal(plan.current.knowledge,1);assert.equal(plan.state,'available');assert.deepEqual(plan.migrations.map(s=>s.domain),['knowledge','knowledge','knowledge']);await applyProjectMigration(root,{approved:true,planId:plan.planId});assert.deepEqual(calls,[1,2,3]);assert.equal((await readConfig(root)).knowledgeSchemaVersion,4);assert.equal((await planProjectMigration(root)).state,'current');console.log('verified');`,root],{cwd:dir});assert.match(result.stdout,/verified/);
 await assert.rejects(readConfig(root),/KNOWLEDGE_SCHEMA_NEWER/);
});

test('active update is distinguishable from recovery and fences concurrent knowledge reads',async t=>{
 const root=await fixture(t,true),original=MIGRATIONS[5];let release,started;
 const begun=new Promise(resolve=>started=resolve),pending=new Promise(resolve=>release=resolve);
 MIGRATIONS[5]={...original,run:async(stage,c)=>{started();await pending;await original.run(stage,c);}};
 const operation=migrateProject(root,await readConfig(root));
 try{await begun;assert.equal((await planProjectMigration(root)).state,'updating');const {listKnowledge}=await import('../dist/core/memory.js');await assert.rejects(listKnowledge(root),/update is in progress/);await assert.rejects(prepareProject(root,{task:'Wait'}),/MIGRATION_REQUIRED/);}finally{release();await operation;MIGRATIONS[5]=original;}
});

for(const boundary of ['journal','commit','schema','history'])test(`process crash at ${boundary} rolls back and retries deterministically`,async t=>{
 const root=await fixture(t,true),before=canonical(await tree(root));
 await assert.rejects(exec(process.execPath,['--input-type=module','-e',`
 import fs from 'node:fs/promises';import {migrateProject} from './dist/core/migrations.js';import {readConfig} from './dist/core/storage.js';
 const root=process.argv[1],boundary=process.argv[2],rename=fs.rename;fs.rename=async(a,b)=>{const result=await rename(a,b);const rel=String(b).slice((root+'/.prodero/').length);
 if((boundary==='journal'&&rel==='.transactions/migration.json')||(boundary==='commit'&&rel==='memory/mem_shared.md')||(boundary==='schema'&&rel==='config.json')||(boundary==='history'&&rel.startsWith('.migrations/')&&rel.endsWith('.json')&&JSON.parse(await fs.readFile(b,'utf8')).status==='completed'))process.exit(23);return result;};await migrateProject(root,await readConfig(root));`,root,boundary]),e=>e.code===23);
 const p=await planProjectMigration(root);assert.equal(p.state,'recovery-required');await applyProjectMigration(root,{approved:true,planId:p.planId,recover:true});assert.deepEqual(canonical(await tree(root)),before);
 const retry=await planProjectMigration(root);await applyProjectMigration(root,{approved:true,planId:retry.planId});assert.equal((await planProjectMigration(root)).state,'current');
});

test('CLI status is read-only; CLI update delegates to the same engine',async t=>{
 const root=await fixture(t,true),before=await tree(root);
 const status=await exec(process.execPath,[path.resolve('dist/cli.js'),'migrate','status','--root',root]);assert.match(status.stdout,/Knowledge update available/);assert.deepEqual(await tree(root),before);
 const applied=await exec(process.execPath,[path.resolve('dist/cli.js'),'migrate','--root',root]);assert.match(applied.stdout,/up to date/);assert.equal((await planProjectMigration(root)).state,'current');
});

test('public planning diagnostics never echo malformed configuration or version values',async t=>{
 const root=await fixture(t),secret='password=synthetic_fixture_only';
 for(const content of [secret,JSON.stringify({schemaVersion:secret})]){
  await fs.writeFile(file(root,'config.json'),content);const plan=await planProjectMigration(root);assert.equal(plan.state,'blocked');assert.ok(!JSON.stringify(plan).includes(secret));
 }
});

test('read fence detects a complete migration even after its journal disappears',async t=>{
 const root=await fixture(t,true);const {knowledgeReadFence}=await import('../dist/core/storage.js');const finish=await knowledgeReadFence(root);const p=await planProjectMigration(root);await applyProjectMigration(root,{approved:true,planId:p.planId});await assert.rejects(finish(),/transaction committed during read/);
});

test('UI refreshes Core state after a failed update and exposes safe recovery',async t=>{
 const root=await fixture(t,true),plan=await planProjectMigration(root),calls=[];
 const ui=await lifecycleUi({callServerTool:async request=>{calls.push(request);return calls.length===1?{isError:true,content:[{type:'text',text:'Update interrupted'}]}:{structuredContent:{action:'migration',root,plan:{...plan,state:'recovery-required',safeToApply:false,blocked:true}}};}});
 ui.render({action:'migration',root,plan});ui.click('migration-0');
 for(let i=0;i<30&&!ui.html.includes('Restore pre-update backup');i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(calls[1]?.arguments.action,'status');assert.match(ui.html,/Restore pre-update backup/);assert.doesNotMatch(ui.html,/>Update project knowledge</);
});

test('project 6 to current uses existing Open/Prepare update review and refreshes managed instructions', async t => {
 const root = await fixture(t);
 const agents = '# User instructions\n\n<!-- prodero:start -->\nUse prodero_skills to inspect skills.\n<!-- prodero:end -->\n# User footer\n';
 await fs.writeFile(path.join(root,'AGENTS.md'),agents);
 const config = await readConfig(root); config.schemaVersion = 6; await writeConfig(root,config);
 const before = canonical(await tree(root));
 const call = await client(t,root);
 for (const tool of ['prodero_open','prodero_prepare']) {
  const payload = (await call(tool)).structuredContent;
  assert.equal(payload.action,'migration');
  assert.equal(payload.plan.state,'available');
  assert.equal(payload.plan.migrations[0].id,'project-instructions-6-7');
  assert.ok(payload.plan.migrations[0].affectedStores.includes('AGENTS.md'));
 }
 assert.equal(await fs.readFile(path.join(root,'AGENTS.md'),'utf8'),agents);
 assert.deepEqual(canonical(await tree(root)),before);
 const plan = await planProjectMigration(root);
 await call('prodero_migrate',{action:'apply',approved:true,planId:plan.planId});
 const updated = await fs.readFile(path.join(root,'AGENTS.md'),'utf8');
 assert.ok(updated.startsWith('# User instructions\n\n'));
 assert.ok(updated.endsWith('# User footer\n'));
 assert.match(await readAgentInstructions(root),/use prodero_skills_read without opening UI/);
 assert.match(await readAgentInstructions(root),/briefly mention its name in chat only/);
 assert.equal((await readConfig(root)).schemaVersion,8);
 for (const name of ['local/memory/mem_preserved.md','memory/mem_shared.md']) assert.equal(await fs.readFile(file(root,name),'utf8'),before[name]);
 assert.equal((await planProjectMigration(root)).state,'current');
 assert.notEqual((await call('prodero_open')).structuredContent.action,'migration');
 assert.equal((await applyProjectMigration(root,{approved:true,planId:plan.planId})).migrated,false);
});

test('project instruction migration restores AGENTS when final version commit fails', async t => {
 const root = await fixture(t), config = await readConfig(root);
 config.schemaVersion=6; await writeConfig(root,config);
 const agents='User text\n<!-- prodero:start -->old instructions<!-- prodero:end -->\n';
 await fs.writeFile(path.join(root,'AGENTS.md'),agents);
 const original=fs.rename; let injected=false;
 fs.rename=async (a,b)=>{
  if(!injected && String(b)===file(root,'config.json')) {injected=true;throw new Error('final version failure');}
  return original(a,b);
 };
 try {const plan=await planProjectMigration(root);await assert.rejects(applyProjectMigration(root,{approved:true,planId:plan.planId}),/rolled back/);}
 finally {fs.rename=original;}
 assert.equal(await fs.readFile(path.join(root,'AGENTS.md'),'utf8'),agents);
 assert.equal((await readConfig(root)).schemaVersion,6);
 assert.equal((await planProjectMigration(root)).state,'available');
});

test('instruction migration preserves concurrent AGENTS edits and leaves the update available', async t => {
 const root=await fixture(t), config=await readConfig(root);
 config.schemaVersion=6;await writeConfig(root,config);
 const original=MIGRATIONS[6], concurrent='User edited this file during the update.\n';
 MIGRATIONS[6]={...original,run:async(stage,c)=>{await original.run(stage,c);await fs.writeFile(path.join(root,'AGENTS.md'),concurrent);}};
 try {const plan=await planProjectMigration(root);await assert.rejects(applyProjectMigration(root,{approved:true,planId:plan.planId}),/AGENTS.md changed/);}
 finally {MIGRATIONS[6]=original;}
 assert.equal(await fs.readFile(path.join(root,'AGENTS.md'),'utf8'),concurrent);
 assert.equal((await readConfig(root)).schemaVersion,6);
});

test('interruption after installing AGENTS restores it through the existing recovery flow', async t => {
 const root=await fixture(t), config=await readConfig(root);
 config.schemaVersion=6;await writeConfig(root,config);
 const agents='Original user instructions\n';await fs.writeFile(path.join(root,'AGENTS.md'),agents);
 await assert.rejects(exec(process.execPath,['--input-type=module','-e',`
  import fs from 'node:fs/promises';import path from 'node:path';
  import {planProjectMigration,applyProjectMigration} from './dist/core/migrations.js';
  const root=process.argv[1],rename=fs.rename;
  fs.rename=async(a,b)=>{if(String(b)===path.join(root,'.prodero/config.json'))process.exit(23);return rename(a,b);};
  const plan=await planProjectMigration(root);await applyProjectMigration(root,{approved:true,planId:plan.planId});
 `,root]),e=>e.code===23);
 assert.match(await fs.readFile(path.join(root,'AGENTS.md'),'utf8'),/prodero_instructions_read/);
 const plan=await planProjectMigration(root);assert.equal(plan.state,'recovery-required');
 await applyProjectMigration(root,{approved:true,planId:plan.planId,recover:true});
 assert.equal(await fs.readFile(path.join(root,'AGENTS.md'),'utf8'),agents);
 assert.equal((await readConfig(root)).schemaVersion,6);
});

test('project 7 migrates its embedded instructions to the packaged document through the existing approval flow', async t=>{
 const root=await fixture(t), config=await readConfig(root);config.schemaVersion=7;await writeConfig(root,config);
 const agents='My rule.\n\n<!-- prodero:start -->\nEmbedded old instructions.\n<!-- prodero:end -->\nMy footer.\n';
 await fs.writeFile(path.join(root,'AGENTS.md'),agents);
 const plan=await planProjectMigration(root);
 assert.equal(plan.state,'available');
 assert.deepEqual(plan.migrations.map(m=>m.id),['project-instructions-link-7-8']);
 await assert.rejects(applyProjectMigration(root,{approved:false,planId:plan.planId}),/approval/);
 assert.equal(await fs.readFile(path.join(root,'AGENTS.md'),'utf8'),agents);
 await applyProjectMigration(root,{approved:true,planId:plan.planId});
 const updated=await fs.readFile(path.join(root,'AGENTS.md'),'utf8');
 assert.match(updated,/^My rule\./);assert.match(updated,/My footer\.\n$/);
 assert.doesNotMatch(updated,/Embedded old instructions/);
 assert.match(await readAgentInstructions(root),/prodero_session_close/);
 assert.equal((await readConfig(root)).schemaVersion,8);
});
