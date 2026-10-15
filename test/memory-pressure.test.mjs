import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initializeProject, prepareProject, closeProjectSession, recordProjectSession, syncProject, recallProject } from '../dist/core/project.js';
import { getContext, prepareContext } from '../dist/core/context.js';
import { listKnowledge, writeKnowledge } from '../dist/core/memory.js';
import { getMemoryPressureSnapshot, recordRetrievalEvidence, MEMORY_PRESSURE_LIMITS as L, MEMORY_PRESSURE_PATH } from '../dist/core/memory-pressure.js';
import { listCheckpoints } from '../dist/core/storage.js';

async function fixture(t, budget=150) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'prodero-pressure-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'.git'));await initializeProject(root);
 const file=path.join(root,'.prodero/config.json');const config=JSON.parse(await fs.readFile(file));config.context={...config.context,max_tokens:budget,required_max_tokens:50};await fs.writeFile(file,JSON.stringify(config));return root;
}
const item=(id,patch={})=>({id,title:'Driving control',content:'Driving control preserves traction.',scope:'module',scopeRef:'driving',category:'state',priority:'normal',status:'active',createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',sourceSessions:[],derivedFrom:[],supersedes:[],related:[],relations:[],...patch});
const entry=(content,patch={})=>({type:'state_change',title:'Driving control',content,scopeHint:'module',scopeRef:'driving',...patch});
async function seed(root) {
 await writeKnowledge(root,item('mem_small'),false,'local');
 await writeKnowledge(root,item('mem_large',{content:'Driving control preserves traction. '.repeat(100)}),false,'versioned');
}
const pressure=async root=>(await getMemoryPressureSnapshot(root));

test('prepare observes selected and budget-omitted knowledge with layer, scores, token totals and budgets',async t=>{
 const root=await fixture(t);await seed(root);const p=await prepareProject(root,{task:'driving'});assert.equal(p.memoryTelemetry,'recorded');
 const view=await pressure(root), evidence=view.sessions[0];
 const selected=evidence.records.find(r=>r.id==='mem_small'),omitted=evidence.records.find(r=>r.id==='mem_large');
 assert.equal(selected.reason,'selected');assert.equal(selected.layer,'local');assert.equal(omitted.reason,'context-budget');assert.equal(omitted.layer,'versioned');
 assert.ok(omitted.score>0);assert.ok(omitted.signals.some(s=>s.kind==='query-token'));
 assert.equal(evidence.totals.selected.tokens,p.context.metrics.selectedContextualTokens);
 assert.equal(evidence.totals['context-budget'].tokens,omitted.estimatedTokens);assert.equal(evidence.budgets.contextBudgetTokens,150);
 assert.equal(view.totals.relevantConsiderations,2);assert.equal(view.groups[0].budgetOmittedRecords,1);
});

test('required capacity failure and optional marginal-value omissions have separate evidence',async t=>{
 const root=await fixture(t);await seed(root);
 await writeKnowledge(root,item('mem_rule',{category:'instruction',scope:'global',scopeRef:null,priority:'critical',content:'Always validate driving controls. '.repeat(20)}),false,'versioned');
 const p=await prepareProject(root,{task:'driving'}),s=(await pressure(root)).sessions[0];
 assert.equal(s.requiredTruncated,true);assert.equal(s.requiredOmitted,1);assert.equal(p.context.metrics.requiredCriticalOmitted,1);
 assert.equal(s.records.find(r=>r.id==='mem_rule').reason,'required-budget');assert.equal(s.budgets.requiredContextBudgetTokens,50);
 const file=path.join(root,'.prodero/config.json'),c=JSON.parse(await fs.readFile(file));c.context.max_tokens=6000;c.context.max_items=1;await fs.writeFile(file,JSON.stringify(c));
 await prepareProject(root,{task:'driving'});const latest=(await pressure(root)).sessions[0];
 assert.equal(latest.totals['marginal-value'].records,1);assert.equal(latest.totals['context-budget'],undefined);
});

test('inactive, superseded, no-match and path mismatch are filters, never relevant budget omissions',async t=>{
 const root=await fixture(t);
 for(const [id,patch] of [['mem_inactive',{status:'deprecated'}],['mem_old',{status:'superseded'}],['mem_path',{scopeKind:'path',scopeRef:'src/driving'}],['mem_other',{title:'Invoices',scopeRef:'billing',content:'Invoices use monthly accounting.'}]])await writeKnowledge(root,item(id,patch),false,'local');
 await prepareProject(root,{task:'driving'});const s=(await pressure(root)).sessions[0];
 assert.deepEqual(s.records.map(r=>r.reason).sort(),['inactive','no-match','scope-mismatch','superseded']);
 assert.equal((await pressure(root)).totals.relevantConsiderations,0);assert.equal((await pressure(root)).groups.length,0);
});

test('repeated sessions accumulate pressure; retry and changed task on one session replace rather than increment',async t=>{
 const root=await fixture(t);await seed(root);let p;
 for(let i=0;i<3;i++)p=await prepareProject(root,{task:'driving'});
 let s=await pressure(root);assert.equal(s.records.find(r=>r.id==='mem_large').budgetOmissionSessions,3);assert.equal(s.groups[0].retrievalSessions,3);assert.equal(s.totals.repeatedBudgetOmittedRecords,1);
 const file=path.join(root,'.prodero',MEMORY_PRESSURE_PATH),before=await fs.readFile(file,'utf8');
 await prepareProject(root,{task:'driving',sessionId:p.session.id});assert.equal(await fs.readFile(file,'utf8'),before);
 await prepareProject(root,{task:'invoices',sessionId:p.session.id});s=await pressure(root);assert.equal(s.sessions.length,3);assert.equal(s.records.find(r=>r.id==='mem_large').budgetOmissionSessions,2);
});

test('instrumented retrieval is identical and recall never writes pressure telemetry or stores raw task text',async t=>{
 const root=await fixture(t);await seed(root);const task='driving customer private task fragment';
 await getContext(root,task);
 const before=await getContext(root,task,{now:new Date('2026-09-18'),contextBudgetTokens:150});let evidence;
 const after=await getContext(root,task,{now:new Date('2026-09-18'),contextBudgetTokens:150,onRetrievalEvidence:e=>evidence=e});assert.deepEqual(after,before);
 await prepareProject(root,{task});const file=path.join(root,'.prodero',MEMORY_PRESSURE_PATH),saved=await fs.readFile(file,'utf8');
 assert.ok(!saved.includes('customer private'));assert.ok(!saved.includes('preserves traction'));assert.ok(!saved.includes('Query token overlap'));
 await recallProject(root,'driving');assert.equal(await fs.readFile(file,'utf8'),saved);assert.match(evidence.queryHash,/^[a-f0-9]{64}$/);
});

test('close-time Sync records new, merged, superseded knowledge and deterministic reconciliation with target layers',async t=>{
 const root=await fixture(t,6000);
 let p=await prepareProject(root);await closeProjectSession(root,p.session.id,[entry('Driving control preserves traction.')]);
 let s=await pressure(root);assert.equal(s.totals.newKnowledge,1);assert.equal(s.syncs[0].changes[0].layer,'local');assert.deepEqual(s.syncs[0].changes[0].actions,['created']);
 p=await prepareProject(root);await closeProjectSession(root,p.session.id,[entry('Driving control preserves traction. Driving control records wheel slip.')]);
 s=await pressure(root);assert.equal(s.syncs[0].totals.merged,1);assert.equal(s.totals.classifications.refinement,1);
 const current=(await listKnowledge(root))[0];
 p=await prepareProject(root);await closeProjectSession(root,p.session.id,[entry('Driving control uses a revised model.',{supersedes:[current.id]})]);
 s=await pressure(root);assert.equal(s.syncs[0].totals.superseded,1);assert.equal(s.totals.classifications.state_transition,1);assert.ok(s.groups[0].newRecords>=2);
 await writeKnowledge(root,item('mem_shared',{content:'Driving control uses shared diagnostics.'}),false,'versioned');
 p=await prepareProject(root);await closeProjectSession(root,p.session.id,[entry('Driving control uses shared diagnostics.')]);
 s=await pressure(root);assert.ok(s.syncs[0].reconciliation.some(r=>r.target.id==='mem_shared'&&r.target.layer==='versioned'&&r.classification==='duplicate'));
 assert.ok(s.totals.classifications.unresolved>0);assert.equal(s.totals.classifications.potential_conflict,undefined,'uncertainty does not infer conflict');
 const knowledge=await listKnowledge(root);const count=s.syncs.length;
 await closeProjectSession(root,p.session.id);await syncProject(root);s=await pressure(root);
 assert.equal(s.syncs.length,count);assert.deepEqual(await listKnowledge(root),knowledge);
});

test('bounded history, per-session details and byte cap expose truncation; old retries cannot resurrect evicted sessions',async t=>{
 const root=await fixture(t,1);
 for(let i=0;i<150;i++)await writeKnowledge(root,item(`mem_${i}`,{title:`Driving ${i}`}),false,i%2?'local':'versioned');
 let evidence;await getContext(root,'driving',{contextBudgetTokens:1,onRetrievalEvidence:e=>evidence=e});
 assert.equal(evidence.totals['context-budget'].records,150);assert.equal(evidence.records.length,L.records);assert.equal(evidence.detailsDropped,22);
 for(let i=0;i<L.sessions+3;i++)await recordRetrievalEvidence(root,`sess_${String(i).padStart(3,'0')}`,evidence);
 await recordRetrievalEvidence(root,'sess_000',evidence);const s=await pressure(root);
 assert.ok(s.sessions.length>0&&s.sessions.length<L.sessions,"byte cap trims dense histories before session cap");assert.ok(!s.sessions.some(s=>s.sessionId==='sess_000'));
 assert.ok((await fs.stat(path.join(root,'.prodero',MEMORY_PRESSURE_PATH))).size<=L.bytes);
 assert.equal(s.totals.relevantConsiderations,s.sessions.length*150);assert.ok(s.coverage.retrievalDetailsDropped>0);assert.ok(s.coverage.sessionFloor);
});

test('unavailable telemetry never prevents prepare or Sync; checkpoints retain counts with explicit coverage gaps',async t=>{
 const root=await fixture(t);await fs.mkdir(path.join(root,'.prodero',MEMORY_PRESSURE_PATH));
 const p=await prepareProject(root,{task:'driving'});assert.equal(p.memoryTelemetry,'unavailable');
 const closed=await closeProjectSession(root,p.session.id,[entry('Driving control preserves traction.')]);assert.equal(closed.synchronization.created,1);
 const s=await pressure(root);assert.equal(s.status,'unavailable');assert.equal(s.totals.newKnowledge,1);assert.equal(s.coverage.checkpointsWithoutDetails.length,1);
 assert.equal((await listKnowledge(root)).length,1);
});

test('partial Sync recovery cannot publish failed pressure or inflate committed checkpoint counts',async t=>{
 const root=await fixture(t),p=await prepareProject(root);const rename=fs.rename;
 const stub=t.mock.method(fs,'rename',async(from,to)=>{if(String(to).includes('/checkpoints/chk_'))throw Error('Injected failure');return rename(from,to);});
 await assert.rejects(closeProjectSession(root,p.session.id,[entry('Driving control preserves traction.')]),/Injected/);stub.mock.restore();
 assert.equal((await pressure(root)).totals.newKnowledge,0);assert.equal((await pressure(root)).syncs.length,0);
 await prepareProject(root);let s=await pressure(root);assert.equal(s.totals.newKnowledge,1);assert.equal(s.coverage.checkpointsWithoutDetails.length,1);
 await closeProjectSession(root,p.session.id);s=await pressure(root);assert.equal(s.totals.newKnowledge,1);assert.equal((await listCheckpoints(root)).length,1);
});

test('compact session histories retain at most 32 sessions and Sync histories retain at most 32 committed events',async t=>{
 const root=await fixture(t,6000);let evidence;await getContext(root,'',{onRetrievalEvidence:e=>evidence=e});
 for(let i=0;i<L.sessions+2;i++)await recordRetrievalEvidence(root,`sess_${String(i).padStart(3,'0')}`,evidence);
 assert.equal((await pressure(root)).sessions.length,L.sessions);
 for(let i=0;i<L.syncs+2;i++){
  const p=await prepareProject(root);await closeProjectSession(root,p.session.id,[entry(`Driving component ${i} uses a separate control path.`,{title:`Component ${i}`,scopeRef:`driving/${i}`})]);
 }
 const s=await pressure(root);assert.equal(s.syncs.length,L.syncs);assert.equal(s.coverage.checkpoints,L.syncs);assert.equal(s.totals.newKnowledge,L.syncs);
 assert.equal(s.coverage.checkpointsWithoutDetails.length,0);assert.equal((await listKnowledge(root)).length,L.syncs+2);
});

test('malformed telemetry is preserved and disabled without altering knowledge or context',async t=>{
 const root=await fixture(t);await seed(root);const file=path.join(root,'.prodero',MEMORY_PRESSURE_PATH);await fs.writeFile(file,'invalid telemetry');
 const expected=await prepareContext(root,{query:'driving'});const p=await prepareProject(root,{task:'driving'});
 assert.deepEqual(p.context.required,expected.required);assert.deepEqual(p.context.relevant,expected.relevant);assert.deepEqual(p.context.selection,expected.selection);
 assert.equal(p.memoryTelemetry,'unavailable');assert.equal(await fs.readFile(file,'utf8'),'invalid telemetry');assert.equal((await pressure(root)).status,'unavailable');
});

test('checkpoint and knowledge writes are independent of telemetry write failures',async t=>{
 const root=await fixture(t),p=await prepareProject(root);const rename=fs.rename;
 const stub=t.mock.method(fs,'rename',async(from,to)=>{if(String(to).endsWith('/memory-pressure.json'))throw Error('Telemetry unavailable');return rename(from,to);});
 const closed=await closeProjectSession(root,p.session.id,[entry('Driving control preserves traction.')]);stub.mock.restore();
 assert.equal(closed.synchronization.created,1);assert.equal(closed.learned.syncState,'synchronized');assert.equal((await listCheckpoints(root)).length,1);
 const before=await listKnowledge(root);await closeProjectSession(root,p.session.id);assert.deepEqual(await listKnowledge(root),before);
 const s=await pressure(root);assert.equal(s.totals.newKnowledge,1);assert.equal(s.coverage.checkpointsWithoutDetails.length,1);
});

test('reconciliation and change samples are bounded independently from their exact totals',async t=>{
 const {SyncEvidenceCollector}=await import('../dist/core/memory-pressure.js');
 const root=await fixture(t);await seed(root);await prepareProject(root,{task:'driving'});
 const sample=(await pressure(root)).sessions[0].records[0];
 const collector=new SyncEvidenceCollector();const records=[];
 for(let i=0;i<140;i++){
  collector.observe(`sess_test#obs_${i}`,sample,'unresolved');records.push({...sample,id:`mem_${i}`});
 }
 const evidence=collector.finish(records,{created:records.map(r=>r.id),updated:[],consolidated:[],superseded:[]});
 assert.equal(evidence.changes.length,L.records);assert.equal(evidence.changesDropped,12);assert.equal(evidence.totals.created,140);
 assert.equal(evidence.reconciliation.length,L.relationships);assert.equal(evidence.relationshipsDropped,12);assert.equal(evidence.classifications.unresolved,140);
});

test('enabled versus unavailable telemetry produces identical deterministic Sync outcomes and knowledge semantics',async t=>{
 const outcomes=[];
 for(const unavailable of [false,true]){
  const root=await fixture(t,6000);await writeKnowledge(root,item('mem_existing'),false,'local');
  if(unavailable)await fs.mkdir(path.join(root,'.prodero',MEMORY_PRESSURE_PATH));
  const p=await prepareProject(root);
  const close=await closeProjectSession(root,p.session.id,[entry('Driving control preserves traction. Driving control records wheel slip.')]);
  const {created,consolidated,duplicates,superseded,conflicts,observationsProcessed}=close.synchronization;
  outcomes.push({sync:{created,consolidated,duplicates,superseded,conflicts,observationsProcessed},knowledge:(await listKnowledge(root)).map(({id,title,content,scope,scopeRef,category,status,supersedes})=>({id,title,content,scope,scopeRef,category,status,supersedes}))});
 }
 assert.deepEqual(outcomes[0],outcomes[1]);
});

test('explicit replacement of Versioned Knowledge preserves the source layer and existing immutable bytes',async t=>{
 const root=await fixture(t,6000);await writeKnowledge(root,item('mem_shared'),false,'versioned');
 const file=path.join(root,'.prodero/memory/mem_shared.md'),before=await fs.readFile(file,'utf8');
 const p=await prepareProject(root);await closeProjectSession(root,p.session.id,[entry('Driving control uses a revised model.',{supersedes:['mem_shared']})]);
 const s=await pressure(root),edge=s.syncs[0].reconciliation.find(r=>r.classification==='state_transition');
 assert.equal(edge.target.id,'mem_shared');assert.equal(edge.target.layer,'versioned');assert.equal(s.syncs[0].changes.find(r=>r.actions.includes('created')).layer,'local');
 assert.equal(await fs.readFile(file,'utf8'),before);assert.equal(s.syncs[0].totals.superseded,0,'Versioned target is shadowed, not physically rewritten');
});

test('eviction watermarks prevent retired retries from displacing another retained history',async t=>{
 const {recordSyncEvidenceLocked}=await import('../dist/core/memory-pressure.js');
 const {withSyncLock}=await import('../dist/core/sync-transaction.js');
 const root=await fixture(t);await seed(root);let evidence;
 await getContext(root,'driving',{onRetrievalEvidence:e=>evidence=e});
 for(let i=0;i<L.sessions+2;i++)await recordRetrievalEvidence(root,`sess_${String(i).padStart(3,'0')}`,evidence);
 const sync={sessionIds:[],sessionIdsDropped:0,changes:[],totals:{created:0,updated:0,merged:0,superseded:0},changesDropped:0,reconciliation:[],classifications:{},relationshipsDropped:0};
 for(let i=0;i<L.syncs+2;i++)await withSyncLock(root,()=>recordSyncEvidenceLocked(root,{...sync,checkpoint:`chk_${String(i).padStart(3,'0')}`}));
 const file=path.join(root,'.prodero',MEMORY_PRESSURE_PATH),before=await fs.readFile(file,'utf8');
 await recordRetrievalEvidence(root,'sess_000',evidence);
 await withSyncLock(root,()=>recordSyncEvidenceLocked(root,{...sync,checkpoint:'chk_000'}));
 assert.equal(await fs.readFile(file,'utf8'),before);
 const stored=JSON.parse(before);assert.equal(stored.sessionFloor,'sess_001');assert.equal(stored.syncFloor,'chk_001');
});
