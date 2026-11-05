import test from 'node:test';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {runMemorySync as run,syncWorkflowForCuration} from '../dist/core/memory-sync.js';
import {submitSemanticCuration,curationAnswers} from '../dist/core/curation-semantic-jobs.js';
import {graphicalReviewAction,graphicalReviewPayload} from '../dist/core/curation-graphical.js';
import {inspectSyncCuration} from '../dist/core/memory-sync-curator.js';
import {writeKnowledge,listKnowledge} from '../dist/core/memory.js';
import {createMemoryBundleFixture,fixtureItem,observeFixture} from './helpers/memory-bundle-fixtures.mjs';
import {buildViewModel} from '../dist/presentation.js';
import {numberedActions} from '../dist/conversation-presentation.js';
import {REVIEW_RETENTION,stageCurationDecisions} from '../dist/core/curation-review.js';
const action=(f,w,action,extra={})=>run(f.root,{action,workflowId:w.id,revision:w.revision,...extra});
const inspect=(f,w)=>run(f.root,{action:'inspect',workflowId:w.id});
const identity=v=>({reviewId:v.review.snapshot.reviewId,reviewRevisionId:v.review.snapshot.revision.id,planHash:v.review.snapshot.planHash,decisionRevision:v.review.state.revision,answerLogHash:v.graphical.answerLogHash});
async function fixture(t,independent=false){const f=await createMemoryBundleFixture('fragmentation');t.after(f.cleanup);if(independent){const ids=Array.from({length:4},(_,i)=>`mem_billing_${i}`);for(const id of ids)await writeKnowledge(f.root,fixtureItem(id,{scopeRef:'src/billing',content:'Billing queues preserve ordering.'}),false,'local');await observeFixture(f.root,ids,3);await observeFixture(f.root,ids,4);}return f;}
function unresolved(j){const b=j.task.data,ids=b.expectedSources.map(s=>s.id);return {version:1,bundleId:b.id,sources:b.sources.map(s=>({sourceId:s.id,revision:s.revision,disposition:'unresolved',outputKeys:[],coverage:s.clauses.map(c=>({clauseId:c.id,action:'unresolved',grounding:[c.id],exceptions:c.protections.filter(p=>p.kind==='exception').map(p=>p.id),negations:c.protections.filter(p=>p.kind==='negation').map(p=>p.id),modality:c.protections.filter(p=>p.kind==='modality').map(p=>p.id)})),rationale:'The deployment state needs clarification.'})),relations:[],outputs:[],issues:[{kind:'missing_fact',sourceIds:ids,missingFact:'Whether queue v2 is deployed.',why:'No deployment fact is supplied.',grounding:ids,question:{title:'Queue migration',prompt:'Has queue v2 deployed?',choices:[{id:'yes',label:'Deployed',meaning:'Queue v2 is deployed.'},{id:'no',label:'Not deployed',meaning:'Queue v2 is not deployed.'}],allowFreeText:true},limitations:[]}],answerInterpretations:[],additionalEvidenceRequired:[],rationale:'Retain sources until clarified.',limitations:[]};}
async function questioned(f,share=false){let w=await run(f.root,{action:'start'});w=await action(f,w,'select',{improve:true,share});w=await action(f,w,'prepare',{candidateId:w.next.candidateId});const j=w.curation.job,result=await submitSemanticCuration(f.root,{jobId:j.jobId,inputHash:j.job.input.inputHash,proposal:unresolved(j)});assert.equal(result.status,'validated',result.validation);return inspect(f,w);}
async function defer(f,w){const v=w.clarification,q=v.graphical.questions[0];await graphicalReviewAction(f.root,{...identity(v),action:'question_later',questionId:q.question.id,questionVersion:q.question.version});return inspect(f,w);}
const reopen=q=>{const {candidateId,title,prompt,expired,affectedQuestions,...binding}=q;return binding;};
import {memorySyncOperation,syncClientFailure,syncClientNotice} from '../dist/memory-sync-operation.js';
import {knowledgeUi} from './helpers/knowledge-ui.mjs';
import {listCheckpoints} from '../dist/core/storage.js';
const envelope=w=>({structuredContent:{ok:true,action:'memory-sync',result:w}});
async function progress(t){const f=await fixture(t);let w=await run(f.root,{action:'start'});w=await action(f,w,'select',{improve:true,share:false});return {f,w};}
async function share(t){const f=await fixture(t);let w=await run(f.root,{action:'start'});return {f,w:await action(f,w,'select',{improve:false,share:true})};}
test('one projection supplies queued/awaiting-agent/submitted/recovery evidence without worker claims',async t=>{
 const {f,w}=await progress(t);assert.equal(w.operation.phase,'queued');assert.equal(w.operation.counts.areasTotal,1);assert.equal(w.operation.counts.savedAnswers,0);
 const prepared=await action(f,w,'prepare',{candidateId:w.next.candidateId});assert.equal(prepared.operation.phase,'awaiting_agent');const persisted=await inspect(f,prepared);assert.equal(persisted.operation.phase,'awaiting_agent');assert.ok(persisted.operation.continuation.jobId);
 const submitted=memorySyncOperation({...persisted,reasoning:{...persisted.reasoning,jobs:persisted.reasoning.jobs.map(j=>({...j,status:'submitted'}))}});assert.equal(submitted.phase,'submitted');
 const suspended=memorySyncOperation({...persisted,reasoning:{...persisted.reasoning,continuationJobId:undefined,jobs:persisted.reasoning.jobs.map(j=>({...j,suspended:true}))}});assert.equal(suspended.phase,'queued');
 const answered=memorySyncOperation({...persisted,state:'awaiting_clarification',clarification:{graphical:{...persisted.reasoning,questions:[{needsInput:false,state:'answered_pending_analysis'}]}}});assert.equal(answered.phase,'awaiting_agent');
 const asking=memorySyncOperation({...persisted,state:'awaiting_clarification',clarification:{graphical:{...persisted.reasoning,questions:[{needsInput:true,state:'open'}]}}});assert.equal(asking.phase,'question');
 const stale=memorySyncOperation({...persisted,state:'stale',jobs:persisted.jobs.map(j=>({...j,status:'failed'}))});assert.equal(stale.actions.some(a=>a.id.startsWith('retry:')),false);
 const recovery=memorySyncOperation({...persisted,state:'applying',error:'Recover the pending receipt.'});assert.equal(recovery.phase,'recovery');assert.equal(recovery.actions.some(a=>a.approval),false);
});

test('two questions in one deferred area have exact separate question and answer-history counts',async t=>{
 const f=await fixture(t);let w=await run(f.root,{action:'start'});w=await action(f,w,'select',{improve:true,share:false});w=await action(f,w,'prepare',{candidateId:w.next.candidateId});const j=w.curation.job,p=unresolved(j);p.issues.push({...structuredClone(p.issues[0]),kind:'conflict',question:{...structuredClone(p.issues[0].question),title:'Queue retries',prompt:'Which queue owns retries?'}});
 assert.equal((await submitSemanticCuration(f.root,{jobId:j.jobId,inputHash:j.job.input.inputHash,proposal:p})).status,'validated');w=await defer(f,await inspect(f,w));assert.equal(w.operation.counts.deferredAreas,1);assert.equal(w.operation.counts.questionsDeferred,2);assert.equal(w.operation.outcome,'remaining');
 const vm=buildViewModel(envelope(w).structuredContent);assert.deepEqual(numberedActions(vm),[]);assert.deepEqual(numberedActions(vm,true),[]);
 const legacy=memorySyncOperation({...w,questionCounts:undefined});assert.equal(legacy.counts.questionsDeferred,null);assert.equal(legacy.counts.savedAnswers,null);
});


test('technical promotion selection remains exact and requires approval, while UI never selects automatically',async t=>{
 const {f,w}=await share(t),all=memorySyncOperation(w).actions.find(a=>a.id==='promotions');assert.equal(all.arguments.request.ids.length,w.promotionCandidates.length);
 assert.equal(memorySyncOperation(w,{promotionIds:[]}).actions.some(a=>a.id==='promotions'),false);assert.equal(memorySyncOperation(w,{promotionIds:['unknown']}).actions.some(a=>a.id==='promotions'),false);
 const ids=w.promotionCandidates.slice(1).map(c=>c.id),selected=memorySyncOperation(w,{promotionIds:ids}).actions.find(a=>a.id==='promotions');assert.deepEqual(selected.arguments.request.ids,ids);
 const calls=[],ui=await knowledgeUi(async req=>{calls.push(req);throw Error('No automatic selection.');});ui.render(envelope(w));assert.doesNotMatch(ui.html,/data-sync-promotion|data-memory-sync|<button/);assert.deepEqual(calls,[]);
 const reviewed=await run(f.root,selected.arguments.request);assert.equal(reviewed.state,'awaiting_review');assert.equal((await listCheckpoints(f.root)).length,0);
 await assert.rejects(action(f,reviewed,'approve',{approved:true,reviewId:'wrong'}),/exact review/);assert.equal((await listCheckpoints(f.root)).length,0);
});

test('committed technical promotion replay and restart never duplicate writes or reuse old approval',async t=>{
 const {f,w}=await share(t),review=await action(f,w,'promotions',{ids:w.promotionCandidates.map(c=>c.id)});
 const completed=await action(f,review,'approve',{approved:true,reviewId:review.review.reviewId});assert.equal((await listCheckpoints(f.root)).length,1);
 const before=JSON.stringify(await listKnowledge(f.root));assert.equal((await inspect(f,completed)).state,'completed');assert.equal(JSON.stringify(await listKnowledge(f.root)),before);assert.equal((await listCheckpoints(f.root)).length,1);
 const restarted=await run(f.root,{action:'start',restart:true});assert.notEqual(restarted.id,completed.id);
 await assert.rejects(action(f,review,'approve',{approved:true,reviewId:review.review.reviewId}),/expired|replaced/);assert.equal((await listCheckpoints(f.root)).length,1);
});

test('post-commit workflow failure retains durable intention and recovers exactly once through explicit API',async t=>{
 const {f,w}=await share(t),review=await action(f,w,'promotions',{ids:w.promotionCandidates.map(c=>c.id)}),rename=fs.rename;
 let injected=false;fs.rename=async(from,to)=>{if(String(to).endsWith('/local/memory-sync.json')&&(await fs.readFile(from,'utf8')).includes('"state":"completed"')){injected=true;throw Error('Injected completion checkpoint failure');}return rename(from,to);};
 try{await assert.rejects(action(f,review,'approve',{approved:true,reviewId:review.review.reviewId}),/Injected/);}finally{fs.rename=rename;}
 assert.equal(injected,true);assert.equal((await listCheckpoints(f.root)).length,1);const before=JSON.stringify(await listKnowledge(f.root));
 const recovered=await inspect(f,review);assert.equal(recovered.state,'completed');assert.equal(JSON.stringify(await listKnowledge(f.root)),before);assert.equal((await listCheckpoints(f.root)).length,1);
});

test('legacy maintenance display never starts polling, handoff or actions and keeps stored workflow unchanged',async t=>{
 const {f,w}=await progress(t),prepared=await action(f,w,'prepare',{candidateId:w.next.candidateId}),before=await fs.readFile(f.root+'/.prodero/local/memory-sync.json','utf8'),calls=[],messages=[],timers=[];
 const ui=await knowledgeUi(async req=>{calls.push(req);throw Error('No retired action.');},req=>{messages.push(req);throw Error('No retired handoff.');},{setTimeout:(...args)=>{timers.push(args);}});
 for(const result of [prepared,{...prepared,revision:prepared.revision+1},prepared,{...prepared,state:'applying',error:'Verify the saved receipt before retrying.'}])ui.render(envelope(result));
 assert.deepEqual(calls,[]);assert.deepEqual(messages,[]);assert.deepEqual(timers,[]);assert.doesNotMatch(ui.html,/data-memory-sync|data-review|<button/);assert.match(ui.html,/Verify the saved receipt/);
 assert.equal(await fs.readFile(f.root+'/.prodero/local/memory-sync.json','utf8'),before);
});

test('retained technical failure diagnostics sanitize unknown transport content',()=>{
 const unsafe=syncClientFailure('fixture','action',{structuredContent:{code:'FIXTURE',message:'Unexpected token secret parser source password=synthetic_transport_credential'}});assert.doesNotMatch(syncClientNotice(unsafe),/secret parser source|synthetic_transport/);assert.match(syncClientNotice(unsafe),/INVALID_JSON/);
 assert.equal(syncClientFailure('fixture','action',{structuredContent:{}}).certainty,'unknown');
});

test('source edits invalidate saved question/reasoning actions and continuation',async t=>{
 const {f,w}=await progress(t),prepared=await action(f,w,'prepare',{candidateId:w.next.candidateId});assert.ok(prepared.operation.continuation.jobId);await writeKnowledge(f.root,fixtureItem('mem_external',{content:'A newer project fact invalidates the prepared inventory.'}),false,'local');const stale=await inspect(f,prepared);assert.equal(stale.state,'stale');assert.deepEqual(stale.operation.actions.map(a=>a.id),['restart','inspect','details']);assert.equal(stale.operation.continuation,undefined);const recovery=memorySyncOperation({...prepared,state:'applying'});assert.deepEqual(recovery.actions.map(a=>a.id),['inspect','details']);assert.equal(recovery.continuation,undefined);
});
