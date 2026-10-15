import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initializeProject, prepareProject, syncProject, rememberProjectKnowledge, resolveProjectContext, buildIndex } from '../dist/core/project.js';
import { writeKnowledge, listKnowledge } from '../dist/core/memory.js';
import { createSession, recordSessionObservations, closeSession, readSession } from '../dist/core/sessions.js';
import { forgetMemory, searchMemory } from '../dist/core/memory-operations.js';
import { createSkillCandidate, createProjectSkill, listProjectSkills, previewProjectSkill, reviewProjectSkill } from '../dist/core/skills.js';
import { previewKnowledgePromotion, applyKnowledgePromotion } from '../dist/core/promotion.js';
import { requestIntelligence, intelligenceTelemetry } from '../dist/core/intelligence.js';
import { mcpSamplingProvider } from '../dist/providers/mcp-sampling.js';
import { assertNoSecrets } from '../dist/core/secrets.js';
import { pathScopeRelevant, pathApplies } from '../dist/core/path-scope.js';
import { instructionApplies } from '../dist/core/bootstrap.js';
const exec = promisify(execFile);
const skillInput = { title: 'Verify changes', description: 'Run focused regression checks.', content: '1. Build the project.\n2. Run the test suite.' };
async function fixture(t) {
 const root = await fs.mkdtemp('/tmp/prodero-phase2-');
 t.after(() => fs.rm(root, {recursive:true,force:true}));
 await exec('git',['init','-q',root]); await initializeProject(root); return root;
}
async function files(root) {
 const result = {};
 async function walk(dir, prefix='') { for (const e of await fs.readdir(dir,{withFileTypes:true})) { const rel=prefix+e.name; if(e.isDirectory()) await walk(path.join(dir,e.name),rel+'/'); else result[rel]=await fs.readFile(path.join(dir,e.name),'utf8'); } }
 await walk(path.join(root,'.prodero')); return result;
}
async function commit(root) { await exec('git',['-C',root,'add','.']); await exec('git',['-C',root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Fixture']); }
async function clean(root) { assert.equal((await exec('git',['-C',root,'status','--porcelain'])).stdout,''); }
function knowledge(id, overrides={}) {return {id,scope:'global',scopeRef:null,category:'state',priority:'normal',status:'active',title:'Cedar deployment',content:'Cedar deployment uses the staging queue.',createdAt:'2026-09-01T00:00:00.000Z',updatedAt:'2026-09-01T00:00:00.000Z',sourceSessions:[],derivedFrom:[],supersedes:[],related:[],...overrides};}

test('M5: real clone and worktree remain Git-clean through the complete local lifecycle', async t=>{
 const source=await fixture(t); await writeKnowledge(source,knowledge('mem_versioned')); await buildIndex(source); await commit(source);
 for(const mode of ['clone','worktree']) {
  const root=path.join(source,mode);
  if(mode==='clone') await exec('git',['clone','-q',source,root]); else await exec('git',['-C',source,'worktree','add','--detach',root,'HEAD']);
  const before=await fs.readFile(path.join(root,'.prodero/memory/mem_versioned.md'),'utf8');
  const prepared=await prepareProject(root,{task:'Cedar deployment'});
  await recordSessionObservations(root,prepared.session.id,[{type:'discovery',content:'Local validation uses focused regression checks.'},{type:'skill_candidate',...skillInput}]);
  await closeSession(root,prepared.session.id); await syncProject(root,{onlyClosed:true});
  const candidates=await listProjectSkills(root); assert.equal(candidates.length,1); assert.match(candidates[0].path,/^local\/skills\//);
  await reviewProjectSkill(root,candidates[0].id,'dismiss','Not needed for this project.');
  const remembered=await rememberProjectKnowledge(root,{content:'The worker queue retries twice.',kind:'fact'});
  const updated=await rememberProjectKnowledge(root,{replaceId:remembered.item.id,content:'The worker queue retries three times.'});
  await forgetMemory(root,{id:updated.item.id}); await forgetMemory(root,{id:updated.item.id});
  await assert.rejects(forgetMemory(root,{id:'mem_versioned'}),/Versioned Knowledge.*repository maintenance/);
  await rememberProjectKnowledge(root,{replaceId:'mem_versioned',content:'Cedar deployment uses the production queue.'});
  await fs.rm(path.join(root,'.prodero/.cache'),{recursive:true,force:true});
  // A separate process exercises restart and cache reconstruction.
  await exec(process.execPath,['--input-type=module','-e',`import { prepareProject } from ${JSON.stringify(new URL('../dist/core/project.js',import.meta.url).href)}; await prepareProject(${JSON.stringify(root)},{task:'Cedar deployment'});`]);
  assert.equal(await fs.readFile(path.join(root,'.prodero/memory/mem_versioned.md'),'utf8'),before);
  assert.equal((await listProjectSkills(root))[0].status,'dismissed'); await clean(root);
 }
});

test('M5: reviewed skill publication is explicit, transactional and replay-safe',async t=>{
 const root=await fixture(t); const provenance={sessionId:'sess_fixture',derivedFrom:'sess_fixture#obs_fixture'};
 const {skill}=await createSkillCandidate(root,skillInput,provenance); await commit(root); await clean(root);
 await assert.rejects(reviewProjectSkill(root,skill.id,'promote'),/approval/); await clean(root);
 const preview=await previewProjectSkill(root,skill.id); const published=await reviewProjectSkill(root,skill.id,'promote',undefined,{approved:true,preview});
 assert.equal(published.id,skill.id); assert.match(published.path,/^skills\//); assert.equal((await listProjectSkills(root)).length,1);
 assert.equal((await createSkillCandidate(root,skillInput,provenance)).created,false);
 assert.equal((await createSkillCandidate(root,skillInput,provenance)).skill.status,'active');
 assert.ok(Object.keys(await files(root)).some(p=>p.startsWith('checkpoints/')&&p.endsWith('.json')));
 await fs.rm(path.join(root,'.prodero/.cache'),{recursive:true,force:true}); assert.equal((await listProjectSkills(root))[0].status,'active');
});

const secrets=['api_key=synthetic_audit_value_123456','password=synthetic_password_123456','-----BEGIN PRIVATE KEY-----','sk-syntheticFixtureOnly1234567890','https://fixture:synthetic_password@example.invalid'];
for(const secret of secrets) test('M6: rejects synthetic credentials across durable lifecycle '+secrets.indexOf(secret),async t=>{
 const root=await fixture(t); const session=await createSession(root); const safe=await rememberProjectKnowledge(root,{content:'Cedar uses a bounded queue.',kind:'fact'});
 const before=await files(root);
 const calls=[
 ()=>rememberProjectKnowledge(root,{content:secret}), ()=>rememberProjectKnowledge(root,{content:'Safe content.',title:secret}),
 ()=>rememberProjectKnowledge(root,{content:secret,replaceId:safe.item.id}),
 ()=>recordSessionObservations(root,session.id,[{type:'discovery',content:'Safe first entry.'},{type:'discovery',content:secret}]),
 ()=>closeSession(root,session.id,[{type:'state_change',content:secret}]),
 ()=>recordSessionObservations(root,session.id,[{type:'skill_candidate',...skillInput,proposedReason:secret}]),
 ()=>createProjectSkill(root,{...skillInput,references:[secret]}),
 ()=>createSkillCandidate(root,{...skillInput,triggers:[secret]},{sessionId:session.id,derivedFrom:session.id+'#obs_secret'}),
 ()=>forgetMemory(root,{id:safe.item.id,reason:secret}),
 ()=>applyKnowledgePromotion(root,{reason:secret},true),
 ()=>writeKnowledge(root,knowledge('mem_rejected',{content:secret})),
 ];
 for(const call of calls) await assert.rejects(call,error=>{assert.match(error.message,/credential/i);assert.ok(!error.message.includes(secret));return true;});
 assert.equal((await readSession(root,session.id)).status,'active');
 const after=await files(root); for(const text of Object.values(after)) assert.ok(!text.includes(secret));
 assert.deepEqual(after,before,'no sessions, checkpoints, journals, caches or canonical content changed');
});

test('M6: provider boundaries reject before invocation and do not echo provider errors',async()=>{
 let calls=0; const provider={name:'fixture',distill:async()=>{calls++;throw Error('api_key=synthetic_provider_error_123456');}};
 await assert.rejects(requestIntelligence(provider,'distill',{text:secrets[0]},intelligenceTelemetry()),/credential/i); assert.equal(calls,0);
 await assert.rejects(requestIntelligence(provider,'distill',{observations:[]},intelligenceTelemetry()),error=>!error.message.includes('synthetic_provider_error'));
 const sampling=mcpSamplingProvider({server:{getClientCapabilities:()=>({sampling:{}}),createMessage:async()=>{calls++;throw Error('must not run');}}});
 const before=calls; for(const phase of ['distill','reconcile','audit','curateSkill','polishSkill']) await assert.rejects(sampling[phase]({text:secrets[0]},new AbortController().signal),/credential/i); assert.equal(calls,before);
});

test('M6: documentation placeholders remain usable',()=>{
 for(const text of ['api_key=<YOUR_KEY>','password=example','api_key=process.env.API_KEY','access_token=$ACCESS_TOKEN','password=********','Secret screening is conservative.\nNext paragraph is ordinary documentation.']) assert.doesNotThrow(()=>assertNoSecrets(text));
});

for(const ref of ['docs','src','tests','src/api']) for(const kind of ['fact','rule']) test(`M7: conversational ${kind} path ${ref} has exact/descendant scope only`,async t=>{
 const root=await fixture(t); const {item}=await rememberProjectKnowledge(root,{title:'Cedar deployment policy',content:'Cedar deployment uses the staging queue.',kind,scope:'path',path:ref});
 assert.equal(item.scopeRef,ref); assert.equal(item.scopeKind,'path');
 const relevant=async query=>{const c=await resolveProjectContext(root,query);return [...c.required,...c.relevant].some(k=>k.id===item.id);};
 for(const q of [ref,ref+'/file.ts',`Edit ${ref}/file.ts`,`Edit \`${ref}\``]) assert.equal(await relevant(q),true,q);
 for(const q of [ref+'-sibling/file.ts','unrelated/file.ts',...(ref.includes('/')?[ref.split('/')[0]]:[])]) assert.equal(await relevant(q),false,q);
 assert.equal(instructionApplies({...item,category:'instruction',contextPolicy:'required'},ref+'/file.ts'),true);
 assert.equal(instructionApplies({...item,category:'instruction',contextPolicy:'required'},'unrelated/file.ts'),false);
 assert.equal((await searchMemory(root,'Cedar',{scope:'path',path:ref+'/file.ts'})).length,1);
 assert.equal((await searchMemory(root,'Cedar',{scope:'path',path:ref+'-sibling'})).length,0);
 await fs.rm(path.join(root,'.prodero/.cache'),{recursive:true,force:true});assert.equal(await relevant(ref+'/file.ts'),true);
 const preview=await previewKnowledgePromotion(root,{ids:[item.id]});await applyKnowledgePromotion(root,preview,true);
 assert.equal((await listKnowledge(root,'versioned'))[0].scopeKind,'path'); assert.equal((await resolveProjectContext(root,'Cedar deployment staging')).relevant.length,1, 'published relevant knowledge with unknown applicability remains retrievable');
});

test('M7: graph relationships cannot bypass path restrictions; legacy topic remains explicit',async t=>{
 const root=await fixture(t);const target=knowledge('mem_path',{scope:'module',scopeRef:'docs',scopeKind:'path'});
 await writeKnowledge(root,target);await writeKnowledge(root,knowledge('mem_seed',{related:['mem_path'],relations:[{type:'depends_on',target:'mem_path'}]}));
 let context=await resolveProjectContext(root,'Cedar deployment staging');assert.ok(!context.relevant.some(k=>k.id==='mem_path'));
 context=await resolveProjectContext(root,'Cedar docs/file.md');assert.ok(context.relevant.some(k=>k.id==='mem_path'));
 assert.equal(pathScopeRelevant('Cedar deployment',{...target,scopeKind:'topic'}),true);
 assert.equal(pathApplies('src/api','src'),false); assert.equal(pathApplies('src/api','src/apis'),false);
});

test('M6: metadata, final batches and review drafts reject before the first write',async t=>{
 const root=await fixture(t); const session=await createSession(root);
 const candidate=await createSkillCandidate(root,skillInput,{sessionId:session.id,derivedFrom:session.id+'#safe'});
 const before=await files(root); const secret=secrets[0];
 for(const field of ['title','description','scopeRef','proposedReason','triggers']) {
  const entry={type:'skill_candidate',...skillInput,[field]:field==='triggers'?[secret]:secret};
  await assert.rejects(recordSessionObservations(root,session.id,[entry]),/credential/i);
  await assert.rejects(closeSession(root,session.id,[entry]),/credential/i);
 }
 for(const field of ['title','description','scope','triggers','references','content']) {
  const input={...skillInput,[field]:['triggers','references'].includes(field)?[secret]:secret};
  await assert.rejects(createProjectSkill(root,input),/credential/i);
  await assert.rejects(previewProjectSkill(root,candidate.skill.id,{draft:input}),/credential/i);
 }
 await assert.rejects(createSession(root,{agent:secret}),/credential/i);
 await assert.rejects(prepareProject(root,{task:secret}),/credential/i);
 await assert.rejects(reviewProjectSkill(root,candidate.skill.id,'dismiss',secret),/credential/i);
 assert.deepEqual(await files(root),before);
});

test('M6: legacy unsafe sessions cannot be consolidated, indexed or sent to providers',async t=>{
 const {consolidateSessions}=await import('../dist/core/consolidation.js');
 const {planAssistedSync}=await import('../dist/core/knowledge-engine.js');
 const root=await fixture(t); const session=await createSession(root);
 await recordSessionObservations(root,session.id,[{type:'discovery',content:'Safe fixture observation.'}]); await closeSession(root,session.id);
 const filename=path.join(root,'.prodero/sessions',session.id+'.md');
 const safe=await fs.readFile(filename,'utf8'); await fs.writeFile(filename,safe.replace('Safe fixture observation.',secrets[0]));
 const before=await files(root); let calls=0;
 await assert.rejects(syncProject(root,{onlyClosed:true,provider:{name:'fixture',distill:async()=>{calls++;}}}),/credential/i);
 const injected={...session,sections:{Discoveries:[secrets[0]]}};
 await assert.rejects(consolidateSessions(root,[injected]),/credential/i);
 await assert.rejects(planAssistedSync(root,[injected],{name:'fixture',distill:async()=>{calls++;}}),/credential/i);
 assert.equal(calls,0); assert.deepEqual(await files(root),before,'existing unsafe file is retained without copying its content anywhere');
 const matches=Object.entries(await files(root)).filter(([,body])=>body.includes(secrets[0])); assert.deepEqual(matches.map(([name])=>name),['sessions/'+session.id+'.md']);
});

test('M6: unsafe publication content and interrupted journals fail closed',async t=>{
 const {commitSyncTransaction,recoverSyncTransaction}=await import('../dist/core/sync-transaction.js');
 const root=await fixture(t); const {item}=await rememberProjectKnowledge(root,{content:'Cedar uses the staging queue.',kind:'fact'});
 const preview=await previewKnowledgePromotion(root,{ids:[item.id]});preview.actions[0].draft.title=secrets[0];
 const before=await files(root); await assert.rejects(applyKnowledgePromotion(root,preview,true),/credential/i);assert.deepEqual(await files(root),before);
 const checkpoint={id:'chk_rejected',createdAt:'2026-09-01T00:00:00.000Z',previousCheckpoint:null,sessions:[],consolidation:'not-performed',createdMemory:[],updatedMemory:[],supersededMemory:[],duplicateMemory:[],conflicts:[],summary:{sessions:0,candidates:0,created:0,consolidated:0,duplicates:0,superseded:0,conflicts:0},note:secrets[0]};
 const writes=[{path:'checkpoints/chk_rejected.json',before:null,after:JSON.stringify(checkpoint)}];
 await assert.rejects(commitSyncTransaction(root,writes),/credential/i);assert.deepEqual(await files(root),before);
 // Model a pre-hardening journal: retain it for maintenance, never apply it.
 await fs.writeFile(path.join(root,'.prodero/.transactions/pending.json'),JSON.stringify({version:1,writes}));
 await assert.rejects(recoverSyncTransaction(root),/credential/i);
 assert.deepEqual(Object.entries(await files(root)).filter(([,text])=>text.includes(secrets[0])).map(([name])=>name),['.transactions/pending.json']);
});

test('M7: repository path normalization does not turn traversal into a descendant',()=>{
 assert.equal(pathApplies('docs','docs/../src/file.ts'),false);
 assert.equal(pathApplies('docs','docs/./guide.md'),true);
 assert.equal(pathApplies('src/api','src/api/../../tests/a.ts'),false);
 assert.equal(pathApplies('src/api','src/API/file.ts'),false);
 assert.equal(pathScopeRelevant('Edit `docs/../src/file.ts`',{scope:'module',scopeRef:'docs',scopeKind:'path'}),false);
});
