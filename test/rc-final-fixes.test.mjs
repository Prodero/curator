import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {ListRootsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import * as core from '../dist/core/project.js';
import * as skills from '../dist/core/skills.js';
import {listSessions,recordSessionObservations,closeSession} from '../dist/core/sessions.js';
import {readImportState,validateImportItems,verifyImport} from '../dist/core/imports.js';
import {checkedPath} from '../dist/core/plugin-files.js';
import {recoverSyncTransaction} from '../dist/core/sync-transaction.js';
import {loadMemoryCatalog} from '../dist/core/memory-index.js';
import {loadKnowledgeGraph} from '../dist/core/knowledge-graph.js';
import {originalSkillCandidate,validateSkillDraft} from '../dist/core/skill-curation.js';
import {checkForUpdate,installLatest,LocalManifestReleaseSource} from '../dist/core/update.js';
import {publicDiagnostic} from '../dist/core/diagnostics.js';
const exec=promisify(execFile), cli=fileURLToPath(new URL('../dist/cli.js',import.meta.url));
const env={...process.env,PRODERO_RELEASE_SOURCE:'none'};
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-rc-fix-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
async function git(root,...args){return (await exec('git',['-C',root,...args])).stdout;}
async function snapshot(root,skip=[]){const result={};async function walk(dir,prefix=''){for(const e of await fs.readdir(dir,{withFileTypes:true})){const rel=prefix+e.name;if(skip.includes(rel))continue;if(e.isDirectory())await walk(path.join(dir,e.name),rel+'/');else if(e.isFile())result[rel]=createHash('sha256').update(await fs.readFile(path.join(dir,e.name))).digest('hex');}}await walk(root);return result;}
async function connect(t,root,roots){const client=new Client({name:'RC regression',version:'1'},{capabilities:roots?{roots:{}}:{}});if(roots)client.setRequestHandler(ListRootsRequestSchema,async()=>({roots:roots.map(r=>({uri:pathToFileURL(r).href}))}));const transport=new StdioClientTransport({command:process.execPath,args:[cli,'mcp',...(root?['--root',root]:[])],env,stderr:'pipe'});let stderr='';transport.stderr?.on('data',d=>stderr+=d);await client.connect(transport);t.after(async()=>{await client.close();assert.equal(stderr,'','clean stdio diagnostics');});return client;}
async function call(client,name,args={}){return client.callTool({name:'prodero_'+name,arguments:args});}

for(const source of ['cli','server','tool','host'])test(`RC-01 ${source}: explicit nested boundary rejects without touching parent`,async t=>{
 const parent=await fixture(t);await git(parent,'init','-q');await fs.writeFile(path.join(parent,'sentinel'),'Parent must remain untouched.');await git(parent,'add','.');await git(parent,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','baseline');const nested=path.join(parent,'nested');await fs.mkdir(nested);const before=await snapshot(parent);const status=await git(parent,'status','--porcelain');
 if(source==='cli'||source==='server')await assert.rejects(exec(process.execPath,[cli,source==='cli'?'init':'mcp','--root',nested],{env}),/PRODERO_NESTED_ROOT/);
 else{const client=await connect(t,undefined,[nested]);const r=await call(client,'initialize',source==='tool'?{projectRoot:nested}:{});assert.equal(r.isError,true);assert.match(JSON.stringify(r),/PRODERO_NESTED_ROOT/);}
 assert.deepEqual(await snapshot(parent),before);assert.equal(await git(parent,'status','--porcelain'),status);
});

test('RC-01 existing nested project remains exact and Local lifecycle is Git-clean',async t=>{
 const parent=await fixture(t),nested=path.join(parent,'nested');await fs.mkdir(nested);await core.initializeProject(nested);await git(parent,'init','-q');await fs.writeFile(path.join(parent,'sentinel'),'Untouched parent');await git(parent,'add','.');await git(parent,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','existing nested project');const before=await snapshot(parent,['nested']);
 const client=await connect(t,nested);const opened=await call(client,'open');assert.equal(opened.structuredContent.project.root,nested);const prepared=await core.prepareProject(nested,{task:'Nested boundary'});assert.equal(prepared.project.root,nested);await recordSessionObservations(nested,prepared.session.id,[{type:'decision',content:'Nested project state stays local.'}]);await closeSession(nested,prepared.session.id);await core.syncProject(nested,{onlyClosed:true});assert.deepEqual(await snapshot(parent,['nested']),before);assert.equal(await git(parent,'status','--porcelain'),'');
});

test('RC-01 standalone, missing, absent and multiple roots',async t=>{
 const root=await fixture(t);await git(root,'init','-q');assert.equal((await core.initializeProject(root)).root,root);const before=await snapshot(root);
 await assert.rejects(exec(process.execPath,[cli,'init','--root',path.join(root,'missing')],{env}),/existing directory/);
 const absent=await connect(t);assert.equal((await call(absent,'initialize')).isError,true);
 const multiple=await connect(t,undefined,[root,path.dirname(root)]);assert.match(JSON.stringify(await call(multiple,'initialize')),/ambiguous/);
 const explicit=await call(multiple,'open',{projectRoot:root});assert.equal(explicit.structuredContent.project.root,root);
 assert.deepEqual(await snapshot(root),before);
});

// Build structurally valid requests from the advertised contract, then override lifecycle IDs.
function sample(s){if('const'in s)return s.const;if(s.enum)return s.enum[0];if(s.default!==undefined)return s.default;if(s.anyOf)return sample(s.anyOf[0]);if(s.type==='object')return Object.fromEntries((s.required??[]).map(k=>[k,sample(s.properties[k])]));if(s.type==='array')return Array.from({length:s.minItems??0},()=>sample(s.items));if(s.type==='boolean')return true;if(s.type==='integer'||s.type==='number')return s.minimum??1;return 'fixture';}
for(const schemaField of ['schemaVersion','knowledgeSchemaVersion'])test(`RC-02 future ${schemaField} blocks canonical MCP/domain surface and preserves every byte`,async t=>{
 const root=await fixture(t);await core.initializeProject(root);const learned=await core.rememberProjectKnowledge(root,{content:'Future-schema sentinel instructions must never enter context.',kind:'rule',scope:'global'});const prepared=await core.prepareProject(root,{task:'Future guard'});const skill=await skills.createProjectSkill(root,{title:'Fixture procedure',description:'Test schema safety',content:'Run the fixture checks.'});
 const catalog=await loadMemoryCatalog(root);
 const configPath=path.join(root,'.prodero/config.json');const config=JSON.parse(await fs.readFile(configPath,'utf8'));config[schemaField]=99;await fs.writeFile(configPath,JSON.stringify(config));const before=await snapshot(root);
 const client=await connect(t,root);const tools=(await client.listTools()).tools;
 const independent=new Set(['prodero_instructions_read','prodero_status','prodero_plugins','prodero_check_update','prodero_config_get','prodero_open','prodero_prepare','prodero_status_details','prodero_migrate','prodero_text']);
 for(const tool of tools){const args={...sample(tool.inputSchema),projectRoot:root};if(tool.inputSchema.properties?.sessionId)args.sessionId=prepared.session.id;if(tool.inputSchema.properties?.id)args.id=tool.name.includes('skill')?skill.id:learned.item.id;
  const r=await client.callTool({name:tool.name,arguments:args});assert.ok(!JSON.stringify(r).includes('Future-schema sentinel'),tool.name+' must not expose active instructions');
  if(tool.name==='prodero_instructions_read'){assert.notEqual(r.isError,true);assert.match(r.structuredContent.instructions,/Prodero Project Intelligence/);}
  if(!independent.has(tool.name)&&!tool.name.includes('update'))assert.equal(r.isError,true,tool.name+' must not consume future state');
  assert.deepEqual(await snapshot(root),before,tool.name+' changed canonical or cache bytes');
 }
 for(const operation of [()=>loadKnowledgeGraph(root,catalog),()=>originalSkillCandidate(root,skill),()=>validateSkillDraft(root,skill),()=>core.initializeProject(root),()=>core.autoMigrateProject(root),()=>core.getDetailedProjectStatus(root),()=>core.resolveProjectBootstrapContext(root),()=>core.resolveProjectContext(root),()=>core.syncProject(root),()=>core.listKnowledge(root),()=>listSessions(root),()=>skills.listProjectSkills(root),()=>skills.createProjectSkill(root,{title:'Rejected skill',description:'Do not persist',content:'Do not create this skill.'}),()=>skills.reviewProjectSkill(root,skill.id,'dismiss'),()=>readImportState(root),()=>validateImportItems(root,[]),()=>verifyImport(root,{checkpoint:'fixture'}),()=>checkedPath(root,'.prodero'),()=>recoverSyncTransaction(root)]){await assert.rejects(operation(),/PRODERO_(?:KNOWLEDGE_)?SCHEMA_NEWER/);assert.deepEqual(await snapshot(root),before);}
 for(const command of ['init','status','sync','context','prepare']){await assert.rejects(exec(process.execPath,[cli,command,'--root',root],{env}),/PRODERO_(?:KNOWLEDGE_)?SCHEMA_NEWER/);assert.deepEqual(await snapshot(root),before);}
});

test('RC-04 MCP validation and CLI arguments never reflect rejected values',async t=>{
 const root=await fixture(t);await core.initializeProject(root);const client=await connect(t,root);const secret='sk-proj-'+'SYNTHETIC_ONLY_'.repeat(4);const before=await snapshot(root);
 for(const args of [{content:'Safe prose.',scope:secret},{content:'Safe prose.',kind:secret},{content:42,scope:'project'},{content:'Safe prose.',relationships:[{type:secret,target:'mem_fixture'}]}]){const r=await call(client,'remember',args);assert.equal(r.isError,true);assert.ok(!JSON.stringify(r).includes(secret));assert.match(JSON.stringify(r),/PRODERO_INVALID_ARGUMENT/);}
 await assert.rejects(exec(process.execPath,[cli,secret],{env}),e=>!String(e.stderr).includes(secret)&&/Unknown command/.test(e.stderr));assert.deepEqual(await snapshot(root),before);
});

for(const target of ['.prodero/config.json','.prodero/.transactions/pending.json','.prodero/.transactions/migration.json','.prodero/.cache/runtime-maintenance.json'])test('RC-04 malformed JSON stays private: '+target,async t=>{
 const root=await fixture(t);await core.initializeProject(root);await fs.mkdir(path.dirname(path.join(root,target)),{recursive:true});const secret='password=synthetic_fixture_only';await fs.writeFile(path.join(root,target),secret);const client=await connect(t,root);const response=await call(client,target.endsWith('runtime-maintenance.json')?'status_details':'sync');assert.equal(response.isError,true);assert.ok(!JSON.stringify(response).includes(secret));assert.match(JSON.stringify(response),/JSON|journal|migration/i);assert.equal(await fs.readFile(path.join(root,target),'utf8'),secret);
 if(!target.endsWith('runtime-maintenance.json'))await assert.rejects(exec(process.execPath,[cli,'sync','--root',root],{env}),e=>!String(e.stderr).includes(secret));
});

test('RC-04 public parser/schema diagnostics omit arbitrary source excerpts',()=>{for(const raw of ['Unexpected token x, "private arbitrary malformed input" is not valid JSON','Input validation error: received "private arbitrary malformed input"'])assert.ok(!publicDiagnostic(raw).includes('private arbitrary'));});

test('RC-06 low-level Sync excludes active sessions; explicit Curate Memory recovers observations and stays Git-clean',async t=>{
 const root=await fixture(t);await git(root,'init','-q');await core.initializeProject(root);await git(root,'add','.');await git(root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','baseline');
 const prepared=await core.prepareProject(root,{task:'Sync contract'});await recordSessionObservations(root,prepared.session.id,[{type:'decision',content:'Juniper fixture checks require reproducible UTC timestamps.'}]);const client=await connect(t,root);
 assert.equal(JSON.parse((await exec(process.execPath,[cli,'sync-sessions','--root',root],{env})).stdout).sessions,0);assert.equal((await core.listKnowledge(root)).length,0);const started=(await call(client,'sync')).structuredContent.result;assert.equal(started.state,'awaiting_selection');assert.equal(started.recovery.sessions,1);assert.ok(started.jobs.every(j=>!j.selected));
 await closeSession(root,prepared.session.id);const closedSync=JSON.parse((await exec(process.execPath,[cli,'sync-sessions','--root',root],{env})).stdout);assert.equal(closedSync.created,0);assert.equal((await core.listKnowledge(root)).length,1);assert.equal(JSON.parse((await exec(process.execPath,[cli,'sync-sessions','--root',root],{env})).stdout).sessions,0);assert.equal(await git(root,'status','--porcelain'),'');
});


test('RC-06 explicit close-and-sync never consolidates another active session',async t=>{
 const root=await fixture(t);await core.initializeProject(root);const a=await core.prepareProject(root,{task:'Close A'}),b=await core.prepareProject(root,{task:'Keep B active'});
 await recordSessionObservations(root,a.session.id,[{type:'decision',content:'Closed session uses Cedar fixtures.'}]);await recordSessionObservations(root,b.session.id,[{type:'decision',content:'Active session uses Willow fixtures.'}]);
 const client=await connect(t,root),result=await call(client,'session_close',{sessionId:a.session.id,sync:true});assert.equal(result.isError,undefined);assert.equal(result.structuredContent.result.synchronization.sessions,1);const memory=JSON.stringify(await core.listKnowledge(root));assert.match(memory,/Cedar/);assert.doesNotMatch(memory,/Willow/);
});

test('RC-04 returned update diagnostics sanitize JSON and schema errors outside isError responses',async t=>{
 const root=await fixture(t),manifest=path.join(root,'manifest.json'),source=new LocalManifestReleaseSource(manifest,path.join(root,'state')),secret='password=synthetic_manifest_fixture';
 for(const value of [secret,JSON.stringify({formatVersion:1,release:{version:secret}})]){
  await fs.writeFile(manifest,value);
  for(const result of [await checkForUpdate(source),await installLatest(source)]){assert.ok(!JSON.stringify(result).includes(secret));assert.match(JSON.stringify(result),/PRODERO_INVALID_(JSON|ARGUMENT)/);}
  const cliEnv={...env,PRODERO_RELEASE_SOURCE:'dev',PRODERO_DEV_UPDATE:'1',PRODERO_RELEASE_MANIFEST:manifest,PRODERO_UPDATE_STATE_DIR:path.join(root,'state')};
  const {stdout,stderr}=await exec(process.execPath,[cli,'check-update'],{env:cliEnv});assert.ok(!(stdout+stderr).includes(secret));assert.match(stdout,/PRODERO_INVALID_(JSON|ARGUMENT)/);
  await assert.rejects(exec(process.execPath,[cli,'update'],{env:cliEnv}),error=>{
   assert.equal(error.code,1);const output=String(error.stdout??'')+String(error.stderr??'');assert.match(output,/NPM_UPDATE_CONFIRMATION/);assert.ok(!output.includes(secret));assert.doesNotMatch(output,/PRODERO_INVALID_(JSON|ARGUMENT)/);return true;
  });
  assert.equal(await fs.readFile(manifest,'utf8'),value);await assert.rejects(fs.access(path.join(root,'state')),{code:'ENOENT'});
 }
});
