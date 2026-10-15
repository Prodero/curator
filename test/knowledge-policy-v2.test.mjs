// Invented toy-project fixtures; no real project incidents or operational records.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {initializeProject,rememberProjectKnowledge} from '../dist/core/project.js';
import {renderKnowledge,parseKnowledge,writeKnowledge,listKnowledge} from '../dist/core/memory.js';
import {readConfig,writeConfig} from '../dist/core/storage.js';
import {KNOWLEDGE_MIGRATIONS,planProjectMigration,applyProjectMigration} from '../dist/core/migrations.js';
import {loadMemoryCatalog} from '../dist/core/memory-index.js';
import {getContext} from '../dist/core/context.js';
import {getBootstrapContext} from '../dist/core/bootstrap.js';
import {knowledgeView,mutateKnowledge} from '../dist/core/knowledge-management.js';
import {previewKnowledgePromotion,applyKnowledgePromotion} from '../dist/core/promotion.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer} from '../dist/server.js';
const item=(id='mem_rule',more={})=>({id,category:'instruction',scope:'global',scopeRef:null,priority:'important',status:'active',title:'Cedar tests',content:'Run Cedar tests before reporting completion.',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',sourceSessions:['sess_fixture'],derivedFrom:['sess_fixture:1'],supersedes:[],related:[],relations:[],evidence:[{kind:'documentation',ref:'docs/testing.md'}],...more});
const v1=i=>renderKnowledge(i).replace(/^version:.*\n|^context_policy:.*\n|^authority:.*\n|^applicability:.*\n/gm,'');
const file=(root,rel)=>path.join(root,'.prodero',rel);
async function fixture(t,old=false){const root=await fs.mkdtemp('/tmp/prodero-policy-');t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'.git'));await initializeProject(root);if(old){const c=await readConfig(root);c.knowledgeSchemaVersion=1;await writeConfig(root,c);}return root;}
async function legacy(root,i,dir='memory'){await fs.mkdir(file(root,dir),{recursive:true});await fs.writeFile(file(root,`${dir}/${i.id}.md`),v1(i));}
async function migrate(root){const plan=await planProjectMigration(root);return applyProjectMigration(root,{approved:true,planId:plan.planId});}
for(const category of ['instruction','decision','state','lesson','principle','invariant','constraint'])test(`v1 ${category} compatibility and mechanical migration`,async t=>{
 const root=await fixture(t,true),i=item('mem_legacy',{category,priority:'critical',scope:'module',scopeRef:'src/cedar',scopeKind:'path'});await legacy(root,i);
 const before=parseKnowledge(v1(i),i.id+'.md');assert.equal(before.contextPolicy,category==='instruction'?'required':'relevant');assert.equal(before.authority,'legacy_inherited');
 const plan=await planProjectMigration(root);assert.equal(plan.state,'available');assert.equal(plan.migrations[0].kind,'compatible-semantic');const raw=await fs.readFile(file(root,'memory/'+i.id+'.md'),'utf8');assert.equal(raw,v1(i));
 await migrate(root);const after=(await listKnowledge(root))[0];assert.deepEqual(after,{...before,version:3,applicability:{kind:'legacy'}});assert.match(await fs.readFile(file(root,'memory/'+i.id+'.md'),'utf8'),/authority: legacy_inherited/);assert.equal((await planProjectMigration(root)).state,'current');assert.equal((await migrate(root)).migrated,false);
});
for(const policy of ['required','relevant'])test(`v2 instruction ${policy} round trip, index, retrieval, Bootstrap, edit, replacement and publication`,async t=>{
 const root=await fixture(t),i=item('mem_explicit',{version:2,contextPolicy:policy,authority:'inferred'}),parsed=parseKnowledge(renderKnowledge(i),i.id+'.md',2);assert.equal(parsed.enforcement,policy);assert.equal(parsed.contextPolicy,policy);assert.deepEqual(parseKnowledge(renderKnowledge(parsed),i.id+'.md',2),parsed);
 await writeKnowledge(root,i,false,'local');let catalog=await loadMemoryCatalog(root);assert.equal(catalog.summaries[0].contextPolicy,policy);assert.equal((await catalog.load(i.id)).contextPolicy,policy);
 await fs.rm(file(root,'.cache'),{recursive:true,force:true});catalog=await loadMemoryCatalog(root);assert.equal(catalog.summaries[0].contextPolicy,policy);
 const context=await getContext(root,'Cedar tests');assert.equal(context.required.some(r=>r.id===i.id),policy==='required');assert.equal(context.relevant.some(r=>r.id===i.id),policy==='relevant');assert.equal((await getBootstrapContext(root)).instructions.some(r=>r.id===i.id),policy==='required');
 const d=(await knowledgeView(root,{},i.id)).detail;await mutateKnowledge(root,{id:i.id,revision:d.revision,action:'edit',approved:true,title:i.title,content:policy==='required'?i.content:'Run Cedar tests before completing the change.'});assert.equal((await listKnowledge(root))[0].contextPolicy,policy);
 const preview=await previewKnowledgePromotion(root,{ids:[i.id]});assert.equal(preview.actions[0].draft.contextPolicy,policy);await applyKnowledgePromotion(root,preview,true);assert.ok((await listKnowledge(root)).every(r=>r.contextPolicy===policy));
 const replaced=await rememberProjectKnowledge(root,{replaceId:preview.actions[0].draft.id,content:policy==='required'?i.content:'Run Cedar tests before completing any change.'});assert.equal(replaced.item.contextPolicy,policy);assert.equal(replaced.item.authority,'inferred');
});
for(const field of ['context_policy','authority','version'])test(`v2 missing ${field} fails closed`,()=>{const raw=renderKnowledge(item());assert.throws(()=>parseKnowledge(raw.replace(new RegExp('^'+field+':.*\\n','m'),''),'mem_rule.md',2),/Invalid canonical/);});
test('v2 category cannot override explicit policy and unsupported combinations fail',()=>{const i=item('mem_rule',{version:2,contextPolicy:'relevant',authority:'inferred',enforcement:'required'});assert.equal(parseKnowledge(renderKnowledge(i),'mem_rule.md',2).enforcement,'relevant');assert.throws(()=>renderKnowledge({...i,category:'decision',contextPolicy:'required'}),/only for instruction/);assert.throws(()=>renderKnowledge({...i,contextPolicy:undefined}),/contextPolicy/);});
test('historical records in both archive stores migrate without lifecycle or provenance drift',async t=>{const root=await fixture(t,true);for(const [n,status]of ['superseded','deprecated','consolidated','duplicate','disputed'].entries()){const i=item('mem_history_'+n,{status,archivedAt:'2026-09-01T00:00:00Z'});await legacy(root,i,`${n%2?'local/':''}archive/2026_09`);}await migrate(root);for(const [n,status]of ['superseded','deprecated','consolidated','duplicate','disputed'].entries()){const rel=`${n%2?'local/':''}archive/2026_09/mem_history_${n}.md`,after=parseKnowledge(await fs.readFile(file(root,rel),'utf8'),path.basename(rel),3);assert.equal(after.status,status);assert.equal(after.authority,'legacy_inherited');assert.equal(after.archivedAt,'2026-09-01T00:00:00Z');}});
for(const mode of ['backup','transform','validation','rebuild','malformed'])test(`production knowledge migration ${mode} failure leaves canonical v1 and versions intact`,async t=>{
 const root=await fixture(t,true),i=item();await legacy(root,i);const target=file(root,'memory/mem_rule.md');if(mode==='malformed')await fs.writeFile(target,v1(i).replace('category: instruction','category: invalid'));
 const before=await fs.readFile(target,'utf8'),config=await fs.readFile(file(root,'config.json'),'utf8'),original=KNOWLEDGE_MIGRATIONS[1],mkdir=fs.mkdir,rename=fs.rename;let injected=false;
 if(mode==='backup')fs.mkdir=async(a,o)=>{if(String(a).includes('.backups/')&&String(a).endsWith('/memory'))throw new Error('backup failure');return mkdir(a,o);};
 if(mode==='transform')KNOWLEDGE_MIGRATIONS[1]={...original,run:async(...args)=>{await original.run(...args);throw new Error('transform failure');}};
 if(mode==='validation')KNOWLEDGE_MIGRATIONS[1]={...original,validate:async()=>{throw new Error('validation failure');}};
 if(mode==='rebuild')fs.rename=async(a,b)=>{if(!injected&&String(b).includes('migration-stage-')&&String(b).endsWith('/.cache/memory-index.json')){injected=true;throw new Error('index failure');}return rename(a,b);};
 try{await assert.rejects(migrate(root));}finally{KNOWLEDGE_MIGRATIONS[1]=original;fs.mkdir=mkdir;fs.rename=rename;}
 assert.equal(await fs.readFile(target,'utf8'),before);assert.equal(await fs.readFile(file(root,'config.json'),'utf8'),config);assert.equal((await readConfig(root)).knowledgeSchemaVersion,1);
});
test('26-record synthetic fixed-budget fixture preserves 5670 candidate tokens and query selections',async t=>{
 const root=await fixture(t,true);for(let n=0;n<26;n++){const title=['Architecture audit','ZED color picker','ToyGrid tests','README documentation'][n%4]+' '+n,targetTokens=n===25?220:218,content='Cedar policy '+n+' ';await legacy(root,item('mem_corpus_'+n,{title,content:content+'x'.repeat(targetTokens*4-title.length-1-content.length)}));}
 const queries=['architecture audit','ZED color picker','ToyGrid tests','README documentation'],views=[];for(const q of queries){const c=await getContext(root,q);assert.equal(c.metrics.requiredGlobalCandidateTokens,5670);views.push({required:c.required.map(i=>i.id),relevant:c.relevant.map(i=>i.id),selection:c.selection,tokens:c.metrics.requiredGlobalTokens});}
 await migrate(root);const records=await listKnowledge(root);assert.equal(records.length,26);assert.ok(records.every(i=>i.contextPolicy==='required'&&i.authority==='legacy_inherited'));
 for(const [n,q] of queries.entries()){const c=await getContext(root,q);assert.equal(c.metrics.requiredGlobalCandidateTokens,5670);assert.deepEqual({required:c.required.map(i=>i.id),relevant:c.relevant.map(i=>i.id),selection:c.selection,tokens:c.metrics.requiredGlobalTokens},views[n]);}
});
test('MCP text migration action resumes Prepare and then Open has no migration controls',async t=>{
 const root=await fixture(t,true);await legacy(root,item());const server=createServer({projectRoot:root}),client=new Client({name:'policy-test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});
 const call=(tool,args={})=>client.callTool({name:'prodero_text',arguments:{tool,arguments:args}});
 const pending=await call('prodero_prepare',{task:'Fix Cedar tests'});assert.equal(pending.structuredContent.action,'migration');assert.match(pending.content[0].text,/update available/i);
 const migrated=await call('prodero_migrate',{action:'apply',approved:true,planId:pending.structuredContent.plan.planId,resume:pending.structuredContent.resume});assert.equal(migrated.isError,undefined,JSON.stringify(migrated));assert.deepEqual(migrated.structuredContent.resume,pending.structuredContent.resume);
 const ready=await call('prodero_prepare',{task:'Fix Cedar tests'});assert.notEqual(ready.structuredContent.action,'migration');assert.match(JSON.stringify(ready.structuredContent),/contextPolicy/);assert.doesNotMatch((await call('prodero_open')).content[0].text,/Knowledge update available/);
});

test('interrupted production transform is rolled back before retry',async t=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),exec=promisify(execFile),root=await fixture(t,true);await legacy(root,item());const original=await fs.readFile(file(root,'memory/mem_rule.md'),'utf8');
 await assert.rejects(exec(process.execPath,['--input-type=module','-e',`import {KNOWLEDGE_MIGRATIONS,planProjectMigration,applyProjectMigration} from './dist/core/migrations.js';const original=KNOWLEDGE_MIGRATIONS[1].run;KNOWLEDGE_MIGRATIONS[1].run=async(...args)=>{await original(...args);process.exit(23)};const root=process.argv[1],p=await planProjectMigration(root);await applyProjectMigration(root,{approved:true,planId:p.planId});`,root]),e=>e.code===23);
 const p=await planProjectMigration(root);assert.equal(p.state,'recovery-required');await applyProjectMigration(root,{approved:true,planId:p.planId,recover:true});assert.equal(await fs.readFile(file(root,'memory/mem_rule.md'),'utf8'),original);assert.equal((await readConfig(root)).knowledgeSchemaVersion,1);await migrate(root);assert.equal((await listKnowledge(root))[0].contextPolicy,'required');
});
test('knowledge-v1 runtime refuses v2 canonical mutation before serialization reaches disk',async t=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),exec=promisify(execFile),root=await fixture(t);await writeKnowledge(root,item());const original=await fs.readFile(file(root,'memory/mem_rule.md'),'utf8');const runtime=await fs.mkdtemp('/tmp/prodero-v1-runtime-');t.after(()=>fs.rm(runtime,{recursive:true,force:true}));
 await fs.cp(path.resolve('dist'),runtime+'/dist',{recursive:true});await fs.copyFile('package.json',runtime+'/package.json');await fs.symlink(path.resolve('node_modules'),runtime+'/node_modules');const release=JSON.parse(await fs.readFile('prodero.release.json','utf8'));release.knowledgeSchemaVersion=1;await fs.writeFile(runtime+'/prodero.release.json',JSON.stringify(release));
 await exec(process.execPath,['--input-type=module','-e',`import assert from 'node:assert/strict';import {writeKnowledge,parseKnowledge} from './dist/core/memory.js';import {planProjectMigration} from './dist/core/migrations.js';import fs from 'node:fs/promises';const root=process.argv[1];assert.equal((await planProjectMigration(root)).state,'runtime-too-old');const i=parseKnowledge(await fs.readFile(root+'/.prodero/memory/mem_rule.md','utf8'),'mem_rule.md');await assert.rejects(writeKnowledge(root,{...i,content:'Changed'}),/KNOWLEDGE_SCHEMA_NEWER/);`,root],{cwd:runtime});assert.equal(await fs.readFile(file(root,'memory/mem_rule.md'),'utf8'),original);
});

test('mechanical migration preserves body text resembling frontmatter and validates actual broken v2 output',async t=>{
 const root=await fixture(t,true),i=item('mem_literal',{content:'Documentation example:\nenforcement: relevant\nKeep this literal example.'});await legacy(root,i);const before=await fs.readFile(file(root,'memory/mem_literal.md'),'utf8'),original=KNOWLEDGE_MIGRATIONS[1];
 KNOWLEDGE_MIGRATIONS[1]={...original,run:async(stage,c)=>{await original.run(stage,c);const f=file(stage,'memory/mem_literal.md');await fs.writeFile(f,(await fs.readFile(f,'utf8')).replace(/^context_policy:.*\n/m,''));}};
 try{await assert.rejects(migrate(root),/contextPolicy\/authority/);}finally{KNOWLEDGE_MIGRATIONS[1]=original;}
 assert.equal(await fs.readFile(file(root,'memory/mem_literal.md'),'utf8'),before);await migrate(root);assert.equal((await listKnowledge(root))[0].content,i.content);
});
test('warm compatibility cache cannot disguise a v1 record in a v2 project',async t=>{const root=await fixture(t,true);await legacy(root,item());await loadMemoryCatalog(root);const c=await readConfig(root);c.knowledgeSchemaVersion=2;await writeConfig(root,c);await assert.rejects(loadMemoryCatalog(root),/missing version metadata/);});
test('production migration UI applies reviewed plan, resumes original tool, and preserves snapshot policy',async t=>{
 const {lifecycleUi}=await import('./helpers/lifecycle-ui.mjs'),{preparedContextSnapshot}=await import('../dist/core/context-snapshot.js'),root=await fixture(t,true);await legacy(root,item());const server=createServer({projectRoot:root}),client=new Client({name:'policy-ui',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);t.after(async()=>{await client.close();await server.close();});
 const calls=[],results=[],call=(name,args={})=>client.callTool({name,arguments:args});const pending=(await call('prodero_prepare',{task:'Fix Cedar tests'})).structuredContent;const ui=await lifecycleUi({callServerTool:async req=>{calls.push(req);const r=await call(req.name,req.arguments);results.push(r);return r;}});
 assert.match(ui.render({...pending,presentation:{resolved:'ui'}}),/Knowledge update available/);ui.click('migration-0');for(let n=0;n<200&&!ui.html.includes('Context Ready');n++)await new Promise(r=>setTimeout(r,20));
 assert.equal(calls[0].name,'prodero_migrate');assert.equal(calls[1]?.name,'prodero_prepare');assert.equal(calls[1].arguments.task,'Fix Cedar tests');assert.doesNotMatch(ui.html,/data-action="migration-/);const snapshot=preparedContextSnapshot(results[1].structuredContent.result.context);assert.equal(snapshot.required[0].contextPolicy,'required');assert.equal(snapshot.required[0].authority,'legacy_inherited');assert.equal(snapshot.required[0].enforcement,'required');
});
