import test from 'node:test';
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

test('completed Revisit is exact, explicit and preserves saved deferral on passive inspection',async t=>{
 const f=await fixture(t);let w=await defer(f,await questioned(f)),before=JSON.stringify(await listKnowledge(f.root));assert.equal(w.state,'completed');assert.equal(w.deferredQuestions.length,1);
 const saved=w.deferredQuestions[0];for(let i=0;i<2;i++){const next=await inspect(f,w);assert.equal(next.revision,w.revision);assert.equal(next.deferredQuestions[0].decisionRevision,saved.decisionRevision);w=next;}
 const vm=buildViewModel({ok:true,action:'memory-sync',result:w});for(const expanded of [false,true])assert.ok(numberedActions(vm,expanded).some(a=>a.arguments.questionId===saved.questionId&&a.arguments.action==='question_reopen'));
 for(const patch of [{questionId:'question_wrong'},{questionVersion:saved.questionVersion+1},{decisionRevision:saved.decisionRevision-1},{answerLogHash:'0'.repeat(64)},{reviewRevisionId:`revision_${'f'.repeat(64)}`}])await assert.rejects(graphicalReviewAction(f.root,{...reopen(saved),...patch}));
 const result=await graphicalReviewAction(f.root,reopen(saved));assert.equal(result.graphical.activeQuestionCount,1);
 w=await inspect(f,w);assert.equal(w.state,'awaiting_clarification');assert.equal(w.clarification.graphical.questions[0].question.id,saved.questionId);assert.equal(w.clarification.graphical.questions[0].question.version,saved.questionVersion);assert.equal(w.summary.questionsDeferred,0);assert.equal(JSON.stringify(await listKnowledge(f.root)),before);
 await assert.rejects(graphicalReviewAction(f.root,reopen(saved)),e=>e.code==='review_changed');
});

for(const prepared of [false,true])test(`Revisit queues behind independent ${prepared?'prepared':'pending'} work`,async t=>{
 const f=await fixture(t,true);let w=await defer(f,await questioned(f));assert.equal(w.state,'semantic_work');const independent=w.next.candidateId,q=w.deferredQuestions[0];assert.ok(q);if(prepared)w=await action(f,w,'prepare',{candidateId:independent});
 await graphicalReviewAction(f.root,reopen(q));w=await inspect(f,w);assert.equal(w.state,'semantic_work');assert.equal(w.next.candidateId,independent);assert.equal(w.jobs.find(j=>j.id===q.candidateId).status,'deferred');
 assert.equal(await syncWorkflowForCuration(f.root,(await inspectSyncCuration(f.root,q.reviewId)).review.snapshot.revision.lineageId),w.id);
 w=await action(f,w,'skip',{candidateId:independent});assert.equal(w.state,'awaiting_clarification');assert.equal(w.clarification.graphical.questions[0].question.id,q.questionId);
});

test('Revisit does not replace an active exact promotion preview',async t=>{
 const f=await fixture(t);let w=await defer(f,await questioned(f,true)),q=w.deferredQuestions[0];assert.equal(w.state,'awaiting_promotion_selection');w=await action(f,w,'promotions',{ids:w.promotionCandidates.map(c=>c.id)});const review=w.review;
 await graphicalReviewAction(f.root,reopen(q));w=await inspect(f,w);assert.equal(w.state,'awaiting_review');assert.deepEqual(w.review,review);
 w=await action(f,w,'skip');assert.equal(w.state,'awaiting_clarification');assert.equal(w.clarification.graphical.questions[0].question.id,q.questionId);
});

test('Revisit retains an already saved answer and reuses its exact lineage',async t=>{
 const f=await fixture(t);let w=await questioned(f);const v=w.clarification,q=v.graphical.questions[0];
 await graphicalReviewAction(f.root,{...identity(v),action:'answer',questionId:q.question.id,questionVersion:q.question.version,choiceId:'yes',requestId:'saved-before-defer'});
 const pending=await inspectSyncCuration(f.root,v.review.snapshot.reviewId);await graphicalReviewAction(f.root,{...identity(pending),action:'question_later',questionId:q.question.id,questionVersion:q.question.version});w=await inspect(f,w);const answers=await curationAnswers(f.root,v.review.snapshot.revision.lineageId);assert.equal(answers.length,1);
 await graphicalReviewAction(f.root,reopen(w.deferredQuestions[0]));w=await inspect(f,w);assert.deepEqual(await curationAnswers(f.root,v.review.snapshot.revision.lineageId),answers);assert.equal(w.state,'awaiting_clarification');
});

test('expired deferred review has an executable explicit refresh that preserves deferral and lineage',async t=>{
 const f=await fixture(t);let w=await defer(f,await questioned(f));const old=w.deferredQuestions[0],lineage=(await inspectSyncCuration(f.root,old.reviewId)).review.snapshot.revision.lineageId,original=Date.now;Date.now=()=>original()+REVIEW_RETENTION.maxAgeMs+1000;t.after(()=>{Date.now=original;});
 w=await inspect(f,w);assert.equal(w.deferredQuestions[0].expired,true);const vm=buildViewModel({ok:true,action:'memory-sync',result:w}),refresh=numberedActions(vm).find(a=>a.arguments.request?.action==='refresh_questions');assert.ok(refresh);assert.equal(numberedActions(vm).some(a=>a.arguments.action==='question_reopen'),false);
 w=await run(f.root,refresh.arguments.request);assert.equal(w.state,'completed');const fresh=w.deferredQuestions[0];assert.equal(fresh.expired,false);assert.notEqual(fresh.reviewId,old.reviewId);assert.notEqual(fresh.reviewRevisionId,old.reviewRevisionId);assert.equal(fresh.questionId,old.questionId);assert.equal(fresh.questionVersion,old.questionVersion);
 assert.equal((await inspectSyncCuration(f.root,fresh.reviewId)).review.snapshot.revision.lineageId,lineage);await assert.rejects(graphicalReviewAction(f.root,reopen(old)));
 await graphicalReviewAction(f.root,reopen(fresh));w=await inspect(f,w);assert.equal(w.state,'awaiting_clarification');
});

test('an expired deferred review cannot block handoff ownership for fresh independent reasoning',async t=>{
 const f=await fixture(t,true);let w=await defer(f,await questioned(f));const original=Date.now;Date.now=()=>original()+REVIEW_RETENTION.maxAgeMs+1000;t.after(()=>{Date.now=original;});
 w=await action(f,w,'prepare',{candidateId:w.next.candidateId});assert.ok(w.curation.job);assert.equal(await syncWorkflowForCuration(f.root,w.curation.job.job.input.lineageId),w.id);assert.equal(w.deferredQuestions[0].expired,true);
});

test('multiple questions project one honest grouped Revisit and leave unrelated deferred work alone',async t=>{
 const f=await fixture(t,true);let w=await run(f.root,{action:'start'});w=await action(f,w,'select',{improve:true,share:false});w=await action(f,w,'prepare',{candidateId:w.next.candidateId});const j=w.curation.job,p=unresolved(j),first=p.issues[0];
 p.issues.push({...structuredClone(first),kind:'conflict',missingFact:'Which queue owns retries?',question:{...structuredClone(first.question),title:'Queue retries',prompt:'Which queue owns retries?'}});
 assert.equal((await submitSemanticCuration(f.root,{jobId:j.jobId,inputHash:j.job.input.inputHash,proposal:p})).status,'validated');w=await inspect(f,w);assert.equal(w.clarification.graphical.questions.length,2);
 w=await defer(f,w);assert.equal(w.deferredQuestions.length,1);const grouped=w.deferredQuestions[0];assert.equal(grouped.affectedQuestions.length,2);
 const vm=buildViewModel({ok:true,action:'memory-sync',result:w}),actions=numberedActions(vm).filter(a=>a.arguments.action==='question_reopen');assert.equal(actions.length,1);assert.match(actions[0].label,/2 related questions/);assert.ok(vm.sections.some(s=>s.items.some(i=>i.body.includes('Queue migration')&&i.body.includes('Queue retries'))));
 w=await action(f,w,'prepare',{candidateId:w.next.candidateId});const independent=w.curation.job;assert.equal((await submitSemanticCuration(f.root,{jobId:independent.jobId,inputHash:independent.job.input.inputHash,proposal:unresolved(independent)})).status,'validated');w=await defer(f,await inspect(f,w));assert.equal(w.deferredQuestions.length,2);
 const unrelated=w.deferredQuestions.find(q=>q.candidateId!==grouped.candidateId);await graphicalReviewAction(f.root,reopen(grouped));w=await inspect(f,w);assert.equal(w.clarification.graphical.activeQuestionCount,2);assert.equal(w.deferredQuestions.length,1);assert.equal(w.deferredQuestions[0].questionId,unrelated.questionId);
});

test('overlapping questions disclose direction-specific defer and reopen effects',async t=>{
 const f=await fixture(t);let w=await run(f.root,{action:'start'});w=await action(f,w,'select',{improve:true,share:false});w=await action(f,w,'prepare',{candidateId:w.next.candidateId});const j=w.curation.job,p=unresolved(j),base=p.issues[0],a=j.task.data.sources.filter(s=>s.record.category==='state').map(s=>s.id),b=j.task.data.sources.filter(s=>s.record.category==='lesson').map(s=>s.id);assert.equal(a.length,2);assert.equal(b.length,2);
 p.issues=[['A',a],['A and B',[...a,...b]],['B',b]].map(([title,sourceIds])=>({...structuredClone(base),sourceIds,grounding:sourceIds,question:{...structuredClone(base.question),title,prompt:`Is ${title} deployed?`}}));
 const staged=await submitSemanticCuration(f.root,{jobId:j.jobId,inputHash:j.job.input.inputHash,proposal:p});assert.equal(staged.status,'validated',staged.validation);w=await inspect(f,w);const v=w.clarification,first=v.graphical.questions.find(q=>q.question.title==='A');assert.deepEqual(first.relatedQuestions.map(q=>q.title),['A']);
 const after=await graphicalReviewAction(f.root,{...identity(v),action:'question_later',questionId:first.question.id,questionVersion:first.question.version});assert.deepEqual(after.graphical.questions.map(q=>[q.question.title,q.state]),[['A','deferred'],['A and B','open'],['B','open']]);
 const all=after.graphical.questions.find(q=>q.question.title==='A and B'),deferred=await graphicalReviewAction(f.root,{...identity(after),action:'question_later',questionId:all.question.id,questionVersion:all.question.version});const anchor=deferred.graphical.questions.find(q=>q.question.title==='A');assert.deepEqual(anchor.reopenedQuestions.map(q=>q.title),['A','A and B']);
 const reopened=await graphicalReviewAction(f.root,{...identity(deferred),action:'question_reopen',questionId:anchor.question.id,questionVersion:anchor.question.version});assert.deepEqual(reopened.graphical.questions.map(q=>[q.question.title,q.state]),[['A','open'],['A and B','open'],['B','deferred']]);
 const unrelated=reopened.graphical.questions.find(q=>q.question.title==='B'),kept=await stageCurationDecisions(f.root,{reviewId:reopened.review.snapshot.reviewId,planHash:reopened.review.snapshot.planHash,decisionRevision:reopened.review.state.revision,decisions:Object.fromEntries(unrelated.unitIds.map(id=>[id,'current']))}),afterKeep=await graphicalReviewPayload(f.root,kept);assert.deepEqual(afterKeep.graphical.questions.find(q=>q.question.title==='A').relatedQuestions.map(q=>q.title),['A','A and B']);
 const toDefer=afterKeep.graphical.questions.find(q=>q.question.title==='A'),mixed=await graphicalReviewAction(f.root,{...identity(afterKeep),action:'question_later',questionId:toDefer.question.id,questionVersion:toDefer.question.version}),aOnly=mixed.graphical.questions.find(q=>q.question.title==='A'),ab=mixed.graphical.questions.find(q=>q.question.title==='A and B');
 assert.deepEqual(aOnly.reopenedQuestions.map(q=>q.title),['A','A and B']);assert.deepEqual(ab.reopenedQuestions.map(q=>q.title),['A','A and B','B']);
 const restored=await graphicalReviewAction(f.root,{...identity(mixed),action:'question_reopen',questionId:ab.question.id,questionVersion:ab.question.version});assert.deepEqual(restored.graphical.questions.filter(q=>q.needsInput).map(q=>q.question.title),ab.reopenedQuestions.map(q=>q.title));
});
