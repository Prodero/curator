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
function clock(){let time=0,next=0;const timers=new Map();return {setTimeout(fn,ms){const id=++next;timers.set(id,{fn,at:time+ms});return id;},clearTimeout(id){timers.delete(id);},async advance(ms){const end=time+ms;while(true){const due=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;time=due[1].at;timers.delete(due[0]);due[1].fn();await new Promise(resolve=>setImmediate(resolve));}time=end;},get pending(){return timers.size;}};}

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
 const vm=buildViewModel(envelope(w).structuredContent);assert.match(vm.conversation.state,/remaining work/);assert.match(vm.conversation.attention.join(' '),/2 questions deferred/);
 const legacy=memorySyncOperation({...w,questionCounts:undefined});assert.equal(legacy.counts.questionsDeferred,null);assert.equal(legacy.counts.savedAnswers,null);
});

test('compact/expanded/UI use the same explicit promotion-selection factory and never emit empty IDs',async t=>{
 const {f,w}=await share(t),vm=buildViewModel(envelope(w).structuredContent),compact=numberedActions(vm).find(a=>a.arguments.request?.action==='promotions'),expanded=numberedActions(vm,true).find(a=>a.arguments.request?.action==='promotions');assert.deepEqual(compact.arguments,expanded.arguments);
 assert.equal(memorySyncOperation(w,{promotionIds:[]}).actions.some(a=>a.id==='promotions'),false);assert.equal(memorySyncOperation(w,{promotionIds:['unknown']}).actions.some(a=>a.id==='promotions'),false);
 const calls=[],ui=await knowledgeUi(async req=>{calls.push(req);return envelope(await run(f.root,req.arguments.request));});ui.render(envelope(w));const removed=w.promotionCandidates[0].id;ui.check(`[data-sync-promotion="${removed}"]`,false);await ui.sync('promotions');
 const ids=w.promotionCandidates.filter(c=>c.id!==removed).map(c=>c.id),expected=memorySyncOperation(w,{promotionIds:ids}).actions.find(a=>a.id==='promotions');assert.deepEqual(calls[0].arguments,expected.arguments);assert.equal(calls.length,1);assert.match(ui.html,/Share reviewed knowledge/);assert.match(ui.html,/Sharing review/);assert.equal((await listCheckpoints(f.root)).length,0);
});

test('safe rejection survives authoritative equal/new/older echoes without repeating a mutation',async t=>{
 const f=await fixture(t),w=await run(f.root,{action:'start'}),calls=[],ui=await knowledgeUi(async req=>{calls.push(req.arguments.request.action);if(req.arguments.request.action==='select')return {isError:true,structuredContent:{ok:false,code:'FIXTURE_LOCK_BUSY',message:'Another writer is busy. Wait and retry.'}};return envelope(w);});ui.render(envelope(w));await ui.sync('select');assert.deepEqual(calls,['select','inspect']);assert.match(ui.html,/FIXTURE_LOCK_BUSY/);
 ui.render(envelope(w));ui.render(envelope({...w,revision:w.revision+1}));ui.render(envelope(w));assert.match(ui.html,/FIXTURE_LOCK_BUSY/);assert.match(ui.html,/Wait and retry/);
});

test('lost approval response inspects committed state once and duplicate clicks never reapply',async t=>{
 const {f,w}=await share(t),review=await action(f,w,'promotions',{ids:w.promotionCandidates.map(c=>c.id)}),calls=[],ui=await knowledgeUi(async req=>{calls.push(req.arguments.request.action);const next=await run(f.root,req.arguments.request);if(req.arguments.request.action==='approve')throw new Error('PRIVATE HOST DETAIL password=synthetic_transport_credential');return envelope(next);});ui.render(envelope(review));ui.fireSync('approve');ui.fireSync('approve');await ui.settle();assert.deepEqual(calls,['approve','inspect']);assert.equal((await listCheckpoints(f.root)).length,1);assert.match(ui.html,/outcome is unknown/);assert.match(ui.html,/Versioned files/);assert.doesNotMatch(ui.html,/PRIVATE HOST|synthetic_transport|shared with the team/);
 const completed=await inspect(f,review),restart=await run(f.root,{action:'start',restart:true});assert.notEqual(restart.id,completed.id);assert.equal((await listCheckpoints(f.root)).length,1);await assert.rejects(run(f.root,{action:'approve',workflowId:review.id,revision:review.revision,reviewId:review.review.reviewId,approved:true}),/expired|replaced/);
});

test('transport plus unavailable inspect stays unknown, hides raw errors and blocks mutation handlers',async t=>{
 const f=await fixture(t),w=await run(f.root,{action:'start'}),calls=[],ui=await knowledgeUi(async req=>{calls.push(req.arguments.request.action);throw new Error('PRIVATE host parser excerpt password=synthetic_transport_credential');});ui.render(envelope(w));await ui.sync('select');assert.deepEqual(calls,['select','inspect']);assert.match(ui.html,/SYNC_TRANSPORT_UNKNOWN/);assert.match(ui.html,/outcome is unknown/);assert.doesNotMatch(ui.html,/PRIVATE|synthetic_transport/);await ui.sync('select');assert.deepEqual(calls,['select','inspect']);await ui.sync('inspect');assert.deepEqual(calls,['select','inspect','inspect']);
 const unsafe=syncClientFailure(w.id,'action',{structuredContent:{code:'FIXTURE',message:'Unexpected token secret parser source password=synthetic_transport_credential'}});assert.doesNotMatch(syncClientNotice(unsafe),/secret parser source|synthetic_transport/);assert.match(syncClientNotice(unsafe),/INVALID_JSON/);
});

for(const response of [{},undefined])test(`host ${response?'acknowledgment':'undefined response'} never proves a background worker`,async t=>{
 const f=await fixture(t),w=await run(f.root,{action:'start'}),ui=await knowledgeUi(async req=>envelope(await run(f.root,req.arguments.request)),()=>response);ui.render(envelope(w));await ui.sync('select');assert.match(ui.html,response?/host acknowledged/:/SYNC_HANDOFF_UNKNOWN/);assert.doesNotMatch(ui.html,/Your agent is reviewing memory/);assert.match(ui.html,/not confirmed|outcome is unknown/);
});

test('twelve automatic checks pause visibly; manual check resumes without dispatch',async t=>{
 const {f,w}=await progress(t),prepared=await action(f,w,'prepare',{candidateId:w.next.candidateId}),timers=clock(),calls=[],ui=await knowledgeUi(async req=>{calls.push(req.arguments.request.action);return envelope(await inspect(f,prepared));},()=>{throw Error('Polling must not dispatch');},timers);ui.render(envelope(prepared));
 for(let i=0;i<12;i++){await timers.advance(5000);await ui.settle();}assert.equal(calls.length,12);assert.match(ui.html,/Automatic checks paused after 12 attempts/);await timers.advance(60000);assert.equal(calls.length,12);await ui.sync('inspect');assert.equal(calls.length,13);assert.doesNotMatch(ui.html,/Automatic checks paused/);
});


test('structured post-commit failure with unavailable inspect remains blocked until saved state is verified',async t=>{
 const {f,w}=await share(t),review=await action(f,w,'promotions',{ids:w.promotionCandidates.map(c=>c.id)}),calls=[],rename=fs.rename;
 let injected=false;fs.rename=async(from,to)=>{if(String(to).endsWith('/local/memory-sync.json')&&(await fs.readFile(from,'utf8')).includes('"state":"completed"')){injected=true;throw Error('Injected completion checkpoint failure');}return rename(from,to);};
 const ui=await knowledgeUi(async req=>{calls.push(req.arguments.request.action);if(req.arguments.request.action==='inspect')throw Error('Inspect unavailable');try{return envelope(await run(f.root,req.arguments.request));}catch{return {isError:true,structuredContent:{ok:false,code:'PRODERO_CHECKPOINT_FAILED',message:'The completion checkpoint could not be saved.'}};}});
 try{ui.render(envelope(review));await ui.sync('approve');assert.ok(injected);assert.equal((await listCheckpoints(f.root)).length,1);assert.match(ui.html,/PRODERO_CHECKPOINT_FAILED/);assert.match(ui.html,/outcome is unknown/);assert.equal(ui.host.querySelector('[data-memory-sync="approve"]').disabled,true);await ui.sync('approve');assert.deepEqual(calls,['approve','inspect']);}finally{fs.rename=rename;}
 assert.equal(syncClientFailure(w.id,'action',{structuredContent:{}}).certainty,'unknown');
});

for(const path of ['normal','recovery','revisit'])test(`late ${path} response cannot replace another root/workflow view`,async t=>{
 const a=await fixture(t),b=await fixture(t);let wa=path==='revisit'?await defer(a,await questioned(a)):await run(a.root,{action:'start'}),wb=await run(b.root,{action:'start'}),release,entered;
 const started=new Promise(resolve=>{entered=resolve;}),delayed=new Promise(resolve=>{release=resolve;}),calls=[],messages=[];
 const ui=await knowledgeUi(async req=>{calls.push(req);if(req.arguments.projectRoot===wa.root){if(path==='recovery'&&req.arguments.request?.action==='select')throw Error('Select transport error');entered();await delayed;return envelope(wa);}return envelope(wb);},m=>{messages.push(m);return {};});
 ui.render(envelope(wa));if(path==='revisit'){const button=ui.host.querySelector('[data-sync-revisit]');button.listeners.click({currentTarget:button});}else ui.fireSync('select');
 await started;ui.render(envelope(wb));release();await ui.settle();await ui.sync('inspect');assert.equal(calls.at(-1).arguments.projectRoot,wb.root);assert.equal(calls.at(-1).arguments.request.workflowId,wb.id);assert.equal(messages.length,0);assert.doesNotMatch(ui.html,/SYNC_TRANSPORT_UNKNOWN/);
});

test('failed automatic polling uses exactly twelve reads, then one read per manual check',async t=>{
 const {f,w}=await progress(t),prepared=await action(f,w,'prepare',{candidateId:w.next.candidateId}),timers=clock(),calls=[],ui=await knowledgeUi(async req=>{calls.push(req);throw Error('Inspect unavailable');},()=>({}),timers);ui.render(envelope(prepared));
 for(let i=0;i<12;i++){await timers.advance(5000);await ui.settle();}assert.equal(calls.length,12);assert.match(ui.html,/Automatic checks paused after 12 attempts/);await ui.sync('inspect');assert.equal(calls.length,13);assert.doesNotMatch(ui.html,/Automatic checks paused/);
});


test('leaving and resuming retains the exact saved workflow without dispatch or cancellation',async t=>{
 const {f,w}=await progress(t),before=await fs.readFile(f.root+'/.prodero/local/memory-sync.json','utf8'),calls=[],ui=await knowledgeUi(async req=>{calls.push(req);throw Error('Status unavailable');},()=>{throw Error('Leaving must not dispatch');});ui.render(envelope(w));assert.match(ui.html,/Your place and saved answers are retained/);await ui.sync('back');assert.equal(calls.length,1);assert.equal(calls[0].name,'prodero_status_details');assert.equal(await fs.readFile(f.root+'/.prodero/local/memory-sync.json','utf8'),before);ui.render(envelope(await inspect(f,w)));assert.match(ui.html,/Analysis queued/);assert.match(ui.html,/Skip or Answer later retains original knowledge/);
});


test('source edits invalidate saved question/reasoning actions and continuation',async t=>{
 const {f,w}=await progress(t),prepared=await action(f,w,'prepare',{candidateId:w.next.candidateId});assert.ok(prepared.operation.continuation.jobId);await writeKnowledge(f.root,fixtureItem('mem_external',{content:'A newer project fact invalidates the prepared inventory.'}),false,'local');const stale=await inspect(f,prepared);assert.equal(stale.state,'stale');assert.deepEqual(stale.operation.actions.map(a=>a.id),['restart','inspect','details']);assert.equal(stale.operation.continuation,undefined);const recovery=memorySyncOperation({...prepared,state:'applying'});assert.deepEqual(recovery.actions.map(a=>a.id),['inspect','details']);assert.equal(recovery.continuation,undefined);
});
