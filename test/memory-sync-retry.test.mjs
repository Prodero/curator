// Retry fixtures are synthetic and owned by each test; never touch the checkout's memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {runMemorySync as run} from '../dist/core/memory-sync.js';
import {prepareSemanticCuration,submitSemanticCuration,inspectSemanticCuration,semanticJobs,appendCurationAnswer,curationAnswers} from '../dist/core/curation-semantic-jobs.js';
import {graphicalReviewAction,graphicalReviewPayload} from '../dist/core/curation-graphical.js';
import {createCurationReview,loadCurationReview,stageCurationDecisions} from '../dist/core/curation-review.js';
import {validateRevision,sealRevision,revisionIssues} from '../dist/core/curation-revision.js';
import {listKnowledge} from '../dist/core/memory.js';
import {listCheckpoints} from '../dist/core/storage.js';
import {createMemoryBundleFixture} from './helpers/memory-bundle-fixtures.mjs';

const action=(f,w,action,extra={})=>run(f.root,{action,workflowId:w.id,revision:w.revision,...extra});
async function fixture(t,options){const f=await createMemoryBundleFixture('fragmentation',options);t.after(f.cleanup);let w=await run(f.root,{action:'start'});w=await action(f,w,'select',{improve:true,share:false});w=await action(f,w,'prepare',{candidateId:w.next.candidateId});return {f,w,j:w.curation.job};}
async function semanticFixture(t,limits={}){const f=await createMemoryBundleFixture('fragmentation');t.after(f.cleanup);const review=await createCurationReview(f.root,undefined,f.ids),j=await prepareSemanticCuration(f.root,{reviewId:review.snapshot.reviewId,reviewRevisionId:review.snapshot.revision.id,componentId:review.snapshot.revision.dependencies.groups[0].component,requestId:'initial',limits});return {f,review,j};}
const inspect=(f,w)=>run(f.root,{action:'inspect',workflowId:w.id});
const submit=(f,j,proposal={unexpected:true})=>submitSemanticCuration(f.root,{jobId:j.jobId,inputHash:j.job.input.inputHash,proposal});
const request=(j,extra={})=>({reviewId:j.job.input.reviewId,reviewRevisionId:j.job.input.reviewRevisionId,componentId:j.task.data.componentId,requestId:j.job.input.requestId,...extra});
async function retry(f,w){w=await action(f,w,'retry',{candidateId:w.jobs[0].id});return action(f,w,'prepare',{candidateId:w.next.candidateId});}
const identity=v=>({reviewId:v.review.snapshot.reviewId,reviewRevisionId:v.review.snapshot.revision.id,planHash:v.review.snapshot.planHash,decisionRevision:v.review.state.revision,answerLogHash:v.graphical.answerLogHash});
async function unchanged(f,j){const b=j.task.data;return submit(f,j,{version:1,bundleId:b.id,sources:b.sources.map(s=>({sourceId:s.id,revision:s.revision,disposition:'unchanged',outputKeys:[],coverage:s.clauses.map(c=>({clauseId:c.id,action:'retained',grounding:[c.id],exceptions:c.protections.filter(p=>p.kind==='exception').map(p=>p.id),negations:c.protections.filter(p=>p.kind==='negation').map(p=>p.id),modality:c.protections.filter(p=>p.kind==='modality').map(p=>p.id)})),rationale:'Preserve all current facts.'})),relations:[],outputs:[],issues:[],answerInterpretations:[],additionalEvidenceRequired:[],rationale:'No safe change is needed.',limitations:[]});}

test('Sync Retry creates one bounded correction after initial rejection and preserves exact replay',async t=>{
 const {f,w,j}=await fixture(t),before=JSON.stringify(await listKnowledge(f.root));
 assert.equal((await submit(f,j)).status,'rejected');
 const failed=await inspect(f,w);assert.equal(failed.jobs[0].status,'failed');
 const next=await retry(f,failed),correction=next.curation.job;
 assert.notEqual(correction.jobId,j.jobId);assert.equal(correction.status,'awaiting_reasoning');assert.equal(correction.job.input.previousJobId,j.jobId);assert.equal(correction.job.input.correction,1);
 assert.deepEqual(correction.task.data.expectedSources,j.task.data.expectedSources);
 assert.equal((await prepareSemanticCuration(f.root,request(j))).jobId,j.jobId);
 assert.equal((await prepareSemanticCuration(f.root,request(correction))).jobId,correction.jobId);
 assert.equal((await action(f,next,'prepare',{candidateId:next.next.candidateId})).curation.job.jobId,correction.jobId);
 assert.equal((await submit(f,correction)).status,'rejected');
 const exhausted=await retry(f,await inspect(f,next));assert.equal(exhausted.jobs[0].status,'failed');assert.match(exhausted.jobs[0].error,/correction retry|limit/i);
 assert.equal((await semanticJobs(f.root)).length,2);assert.equal(JSON.stringify(await listKnowledge(f.root)),before);assert.equal((await listCheckpoints(f.root)).length,0);
});

test('Sync Retry resumes TTL-only expiry with distinct identity and bounded passes',async t=>{
 const {f,w,j}=await fixture(t),original=Date.now;let now=original();Date.now=()=>now;t.after(()=>{Date.now=original;});
 let current=j,workflow=w;
 for(let pass=1;pass<j.task.data.limits.maxPasses;pass++){
  now=Date.parse(current.job.input.expiresAt)+1;
  const failed=await inspect(f,workflow);assert.equal(failed.jobs[0].status,'failed');
  workflow=await retry(f,failed);const next=workflow.curation.job;
  assert.equal(next.status,'awaiting_reasoning');assert.notEqual(next.jobId,current.jobId);assert.equal(next.job.input.previousJobId,current.jobId);assert.equal(next.job.input.decisionRevision,current.job.input.decisionRevision);
  assert.equal((await prepareSemanticCuration(f.root,request(current))).jobId,current.jobId);
  assert.equal((await prepareSemanticCuration(f.root,request(next))).jobId,next.jobId);
  assert.equal((await submit(f,current)).status,'stale');
  current=next;
 }
 now=Date.parse(current.job.input.expiresAt)+1;
 const view=await graphicalReviewPayload(f.root,await loadCurationReview(f.root,current.job.input.reviewId));assert.equal(view.graphical.canRetryAnalysis,false);
 const exhausted=await retry(f,await inspect(f,workflow));assert.equal(exhausted.jobs[0].status,'failed');assert.match(exhausted.jobs[0].error,/budget reached/i);
 assert.equal((await semanticJobs(f.root)).length,j.task.data.limits.maxPasses);assert.equal((await listCheckpoints(f.root)).length,0);
});

test('graphical Retry can resume an expired job at unchanged decision revision',async t=>{
 const {f,j}=await fixture(t),original=Date.now;Date.now=()=>Date.parse(j.job.input.expiresAt)+1;t.after(()=>{Date.now=original;});
 const review=await loadCurationReview(f.root,j.job.input.reviewId),view=await graphicalReviewPayload(f.root,review);
 assert.equal(view.graphical.jobs[0].canResume,true);
 const next=await graphicalReviewAction(f.root,{...identity(view),action:'retry_analysis'});
 assert.ok(next.continuationJobId);assert.notEqual(next.continuationJobId,j.jobId);
 assert.equal((await inspectSemanticCuration(f.root,next.continuationJobId)).job.input.previousJobId,j.jobId);
});

test('fresh resumed analysis can validate without inheriting the old TTL',async t=>{
 const {f,w,j}=await fixture(t),original=Date.now;Date.now=()=>Date.parse(j.job.input.expiresAt)+1;t.after(()=>{Date.now=original;});
 const next=await retry(f,await inspect(f,w)),resumed=next.curation.job;
 assert.notEqual(resumed.jobId,j.jobId);assert.ok(Date.parse(resumed.job.input.expiresAt)>Date.now());
 const result=await unchanged(f,resumed);assert.equal(result.status,'validated',result.validation);assert.equal((await inspect(f,next)).state,'completed');
 validateRevision(result.review.snapshot.revision);assert.equal(result.review.snapshot.revision.typedPlan.analyses.at(-1).resumedFromJobId,j.jobId);
 const {id,...body}=structuredClone(result.review.snapshot.revision);body.typedPlan.analyses.at(-1).resumedFromJobId=`semantic_job_${'f'.repeat(40)}`;assert.throws(()=>validateRevision(sealRevision(body)),/analysis_input_hash/);
});

test('changed source fails closed before Retry or late result can apply',async t=>{
 const {f,w,j}=await fixture(t);await submit(f,j);const failed=await inspect(f,w);
 await fs.appendFile(`${f.root}/.prodero/local/memory/${f.ids[0]}.md`,'\nChanged source evidence.');
 assert.equal((await inspect(f,failed)).state,'stale');await assert.rejects(retry(f,failed),/changed|stale/i);
 await assert.rejects(prepareSemanticCuration(f.root,request(j,{requestId:'changed',reason:'validation_correction',correctionForJobId:j.jobId})),e=>e.code==='semantic_stale');
 assert.equal((await listCheckpoints(f.root)).length,0);
});

test('concurrent resume requests create one leaf even when createdAt timestamps are equal',async t=>{
 const {f,j}=await semanticFixture(t),NativeDate=globalThis.Date,fixed=Date.parse(j.job.input.createdAt);let now=Date.parse(j.job.input.expiresAt)+1;
 globalThis.Date=class extends NativeDate {constructor(...args){super(...(args.length?args:[fixed]));}static now(){return now;}};t.after(()=>{globalThis.Date=NativeDate;});
 const [a,b]=await Promise.all(['resume-a','resume-b'].map(requestId=>prepareSemanticCuration(f.root,request(j,{requestId,reason:'resume'}))));
 assert.equal(a.jobId,b.jobId);assert.notEqual(a.jobId,j.jobId);assert.equal(a.job.input.createdAt,j.job.input.createdAt);
 now=NativeDate.parse(a.job.input.expiresAt)+1;
 const leaf=await prepareSemanticCuration(f.root,request(a,{requestId:'next-expiry',reason:'resume'}));assert.notEqual(leaf.jobId,a.jobId);assert.equal(leaf.job.input.previousJobId,a.jobId);assert.equal(leaf.job.input.createdAt,j.job.input.createdAt);
 assert.equal((await prepareSemanticCuration(f.root,request(a))).jobId,a.jobId);
 assert.equal((await semanticJobs(f.root)).length,3);
});

test('resume cannot raise earlier pass/correction/TTL limits or reset correction count',async t=>{
 const {f,j}=await semanticFixture(t,{maxCorrections:0,maxPasses:2,ttlMs:1000}),original=Date.now;Date.now=()=>Date.parse(j.job.input.expiresAt)+1;t.after(()=>{Date.now=original;});
 const resumed=await prepareSemanticCuration(f.root,request(j,{requestId:'resumed',reason:'resume',limits:{maxCorrections:1,maxPasses:4,ttlMs:86400000}}));
 assert.equal(resumed.task.data.limits.maxCorrections,0);assert.equal(resumed.task.data.limits.maxPasses,2);assert.equal(resumed.task.data.limits.ttlMs,1000);
 await submit(f,resumed);await assert.rejects(prepareSemanticCuration(f.root,request(resumed,{requestId:'forbidden-correction',reason:'validation_correction',correctionForJobId:resumed.jobId})),e=>e.code==='semantic_limit');
 const view=await graphicalReviewPayload(f.root,await loadCurationReview(f.root,j.job.input.reviewId));assert.equal(view.graphical.canRetryAnalysis,false);
 const other=await semanticFixture(t);await submit(other.f,other.j);const correction=await prepareSemanticCuration(other.f.root,request(other.j,{requestId:'correction',reason:'validation_correction',correctionForJobId:other.j.jobId}));
 Date.now=()=>Date.parse(correction.job.input.expiresAt)+1;
 const retry=await prepareSemanticCuration(other.f.root,request(correction,{requestId:'resumed-correction',reason:'resume'}));assert.equal(retry.job.input.correction,1);await submit(other.f,retry);
 await assert.rejects(prepareSemanticCuration(other.f.root,request(retry,{requestId:'exhausted',reason:'validation_correction',correctionForJobId:retry.jobId})),e=>e.code==='semantic_limit');
});

test('changed decisions cannot use a rejected correction from an obsolete binding',async t=>{
 const {f,review,j}=await semanticFixture(t);await submit(f,j);
 await stageCurationDecisions(f.root,{reviewId:review.snapshot.reviewId,planHash:review.snapshot.planHash,decisionRevision:review.state.revision,decisions:{[review.snapshot.units[0].id]:'current'}});
 await assert.rejects(prepareSemanticCuration(f.root,request(j,{requestId:'obsolete-correction',reason:'validation_correction',correctionForJobId:j.jobId})),e=>e.code==='semantic_stale');
 assert.equal((await prepareSemanticCuration(f.root,request(j))).jobId,j.jobId);assert.equal((await semanticJobs(f.root)).length,1);
});

test('graphical correction inherits Sync limits for a 17-source component',async t=>{
 const {f,j}=await fixture(t,{count:17});assert.equal(j.task.data.sources.length,17);assert.equal(j.task.data.limits.maxItems,24);await submit(f,j);
 const view=await graphicalReviewPayload(f.root,await loadCurationReview(f.root,j.job.input.reviewId));assert.equal(view.graphical.canRetryAnalysis,true);
 const next=await graphicalReviewAction(f.root,{...identity(view),action:'retry_analysis'});assert.ok(next.continuationJobId,next.analysisNotice);
 const correction=await inspectSemanticCuration(f.root,next.continuationJobId);assert.equal(correction.task.data.sources.length,17);assert.equal(correction.task.data.limits.maxItems,24);assert.deepEqual(correction.task.data.expectedSources,j.task.data.expectedSources);
 assert.equal((await prepareSemanticCuration(f.root,request(correction,{reason:'validation_correction',correctionForJobId:j.jobId}))).jobId,correction.jobId);
});

test('explicit resume preserves a reduced input budget and its replay hash',async t=>{
 const {f,j}=await semanticFixture(t,{maxItems:1,ttlMs:1000}),original=Date.now;Date.now=()=>Date.parse(j.job.input.expiresAt)+1;t.after(()=>{Date.now=original;});
 const input=request(j,{requestId:'reduced-resume',reason:'resume',resumeForJobId:j.jobId}),next=await prepareSemanticCuration(f.root,input);
 assert.equal(next.task.data.sources.length,1);assert.equal(next.task.data.limits.maxItems,1);assert.equal(next.task.data.limits.ttlMs,1000);assert.equal(next.job.input.semanticInputHash,j.job.input.semanticInputHash);
 assert.equal((await prepareSemanticCuration(f.root,input)).jobId,next.jobId);
 await submit(f,next);
 const correctionInput=request(next,{requestId:'reduced-correction',reason:'validation_correction',correctionForJobId:next.jobId});
 await assert.rejects(prepareSemanticCuration(f.root,{...correctionInput,limits:{maxCorrections:0}}),e=>e.code==='semantic_limit');
 const correction=await prepareSemanticCuration(f.root,correctionInput);assert.equal(correction.task.data.sources.length,1);assert.equal(correction.job.input.semanticInputHash,next.job.input.semanticInputHash);assert.equal((await prepareSemanticCuration(f.root,correctionInput)).jobId,correction.jobId);
});

test('legacy resume without predecessor inherits reduced budgets instead of starting broader work',async t=>{
 const {f,j}=await semanticFixture(t,{maxItems:1,maxCorrections:0,ttlMs:1000}),original=Date.now;Date.now=()=>Date.parse(j.job.input.expiresAt)+1;t.after(()=>{Date.now=original;});
 const input=request(j,{requestId:'legacy-resume',reason:'resume'}),next=await prepareSemanticCuration(f.root,input);
 assert.equal(next.job.input.previousJobId,j.jobId);assert.equal(next.task.data.sources.length,1);assert.equal(next.task.data.limits.maxItems,1);assert.equal(next.task.data.limits.maxCorrections,0);assert.equal(next.task.data.limits.ttlMs,1000);assert.equal(next.job.input.semanticInputHash,j.job.input.semanticInputHash);
 assert.equal((await prepareSemanticCuration(f.root,input)).jobId,next.jobId);await submit(f,next);
 await assert.rejects(prepareSemanticCuration(f.root,request(next,{requestId:'legacy-correction',reason:'validation_correction',correctionForJobId:next.jobId})),e=>e.code==='semantic_limit');
});

test('expired answer analysis preserves answer lineage and refuses replaced-answer recovery',async t=>{
 const {f,j}=await semanticFixture(t),b=j.task.data,ids=b.expectedSources.map(s=>s.id);
 const result=await submit(f,j,{version:1,bundleId:b.id,sources:b.sources.map(s=>({sourceId:s.id,revision:s.revision,disposition:'unresolved',outputKeys:[],coverage:s.clauses.map(c=>({clauseId:c.id,action:'unresolved',grounding:[c.id],exceptions:c.protections.filter(p=>p.kind==='exception').map(p=>p.id),negations:c.protections.filter(p=>p.kind==='negation').map(p=>p.id),modality:c.protections.filter(p=>p.kind==='modality').map(p=>p.id)})),rationale:'A synthetic project fact is required.'})),relations:[],outputs:[],issues:[{kind:'missing_fact',sourceIds:ids,missingFact:'Whether replay traces are stored.',why:'The fixture does not establish the storage state.',grounding:ids,question:{title:'Replay traces',prompt:'Are replay traces stored?',choices:[{id:'yes',label:'Stored',meaning:'Replay traces are stored.'},{id:'no',label:'Not stored',meaning:'Replay traces are not stored.'}],allowFreeText:true},limitations:[]}],answerInterpretations:[],additionalEvidenceRequired:[],rationale:'Retain sources pending clarification.',limitations:[]});assert.equal(result.status,'validated',result.validation);
 const r=result.review,q=revisionIssues(r.snapshot.revision)[0].question,answerInput={reviewId:r.snapshot.reviewId,reviewRevisionId:r.snapshot.revision.id,questionId:q.id,questionVersion:q.version,origin:'app'},answer=await appendCurationAnswer(f.root,{...answerInput,requestId:'answer-1',choiceId:'yes'});
 const analyzed=await prepareSemanticCuration(f.root,{reviewId:r.snapshot.reviewId,reviewRevisionId:r.snapshot.revision.id,componentId:r.snapshot.revision.dependencies.groups[0].component,requestId:'answer-analysis',reason:'answer'}),original=Date.now;Date.now=()=>Date.parse(analyzed.job.input.expiresAt)+1;t.after(()=>{Date.now=original;});
 const resumed=await prepareSemanticCuration(f.root,request(analyzed,{requestId:'answer-resume',reason:'resume',resumeForJobId:analyzed.jobId}));assert.equal(resumed.task.data.answers[0].id,answer.id);assert.equal(resumed.task.data.answerLogHash,analyzed.task.data.answerLogHash);
 await appendCurationAnswer(f.root,{...answerInput,requestId:'answer-2',choiceId:'no',replacesAnswerId:answer.id});
 await assert.rejects(prepareSemanticCuration(f.root,request(resumed,{requestId:'obsolete-answer-resume',reason:'resume',resumeForJobId:resumed.jobId})),e=>e.code==='semantic_stale');
 assert.equal((await submit(f,resumed)).status,'stale');const answers=await curationAnswers(f.root,r.snapshot.revision.lineageId);assert.equal(answers.length,2);assert.equal(answers[1].replacesAnswerId,answer.id);assert.equal((await listCheckpoints(f.root)).length,0);
});
