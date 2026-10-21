import test from 'node:test';
import assert from 'node:assert/strict';
import {runMemorySync as run,syncWorkflowForCuration} from '../dist/core/memory-sync.js';
import {submitSemanticCuration,curationAnswers} from '../dist/core/curation-semantic-jobs.js';
import {graphicalReviewAction} from '../dist/core/curation-graphical.js';
import {inspectSyncCuration} from '../dist/core/memory-sync-curator.js';
import {writeKnowledge,listKnowledge} from '../dist/core/memory.js';
import {createMemoryBundleFixture,fixtureItem,observeFixture} from './helpers/memory-bundle-fixtures.mjs';
import {buildViewModel} from '../dist/presentation.js';
import {numberedActions} from '../dist/conversation-presentation.js';
const action=(f,w,action,extra={})=>run(f.root,{action,workflowId:w.id,revision:w.revision,...extra});
const inspect=(f,w)=>run(f.root,{action:'inspect',workflowId:w.id});
const identity=v=>({reviewId:v.review.snapshot.reviewId,reviewRevisionId:v.review.snapshot.revision.id,planHash:v.review.snapshot.planHash,decisionRevision:v.review.state.revision,answerLogHash:v.graphical.answerLogHash});
async function fixture(t,independent=false){const f=await createMemoryBundleFixture('fragmentation');t.after(f.cleanup);if(independent){const ids=Array.from({length:4},(_,i)=>`mem_billing_${i}`);for(const id of ids)await writeKnowledge(f.root,fixtureItem(id,{scopeRef:'src/billing',content:'Billing queues preserve ordering.'}),false,'local');await observeFixture(f.root,ids,3);await observeFixture(f.root,ids,4);}return f;}
function unresolved(j){const b=j.task.data,ids=b.expectedSources.map(s=>s.id);return {version:1,bundleId:b.id,sources:b.sources.map(s=>({sourceId:s.id,revision:s.revision,disposition:'unresolved',outputKeys:[],coverage:s.clauses.map(c=>({clauseId:c.id,action:'unresolved',grounding:[c.id],exceptions:c.protections.filter(p=>p.kind==='exception').map(p=>p.id),negations:c.protections.filter(p=>p.kind==='negation').map(p=>p.id),modality:c.protections.filter(p=>p.kind==='modality').map(p=>p.id)})),rationale:'The deployment state needs clarification.'})),relations:[],outputs:[],issues:[{kind:'missing_fact',sourceIds:ids,missingFact:'Whether queue v2 is deployed.',why:'No deployment fact is supplied.',grounding:ids,question:{title:'Queue migration',prompt:'Has queue v2 deployed?',choices:[{id:'yes',label:'Deployed',meaning:'Queue v2 is deployed.'},{id:'no',label:'Not deployed',meaning:'Queue v2 is not deployed.'}],allowFreeText:true},limitations:[]}],answerInterpretations:[],additionalEvidenceRequired:[],rationale:'Retain sources until clarified.',limitations:[]};}
async function questioned(f,share=false){let w=await run(f.root,{action:'start'});w=await action(f,w,'select',{improve:true,share});w=await action(f,w,'prepare',{candidateId:w.next.candidateId});const j=w.curation.job,result=await submitSemanticCuration(f.root,{jobId:j.jobId,inputHash:j.job.input.inputHash,proposal:unresolved(j)});assert.equal(result.status,'validated',result.validation);return inspect(f,w);}
async function defer(f,w){const v=w.clarification,q=v.graphical.questions[0];await graphicalReviewAction(f.root,{...identity(v),action:'question_later',questionId:q.question.id,questionVersion:q.question.version});return inspect(f,w);}
const reopen=q=>{const {candidateId,title,prompt,expired,affectedQuestions,...binding}=q;return binding;};
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createServer,PRODERO_TOOLS as T} from '../dist/server.js';
import {SEMANTIC_RETENTION,semanticJobs,inspectSemanticCuration} from '../dist/core/curation-semantic-jobs.js';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
async function client(t,root){const server=createServer({projectRoot:root}),c=new Client({name:'bounded-question-client',version:'1'},{capabilities:{}}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await c.connect(a);t.after(async()=>{await c.close();await server.close();});return c;}
const throughText=(c,args)=>c.callTool({name:T.text,arguments:{tool:T.curationQuestion,arguments:args}});
const show=(c,w,details=false)=>c.callTool({name:T.text,arguments:{tool:T.sync,arguments:{workflowId:w.id,details}}});
const bind=(w,v=w.clarification)=>({workflowId:w.id,candidateId:w.jobs.find(j=>j.curationReviewId===v.review.snapshot.reviewId).id,...identity(v)});
const choice=(w,requestId='chat-answer')=>({...bind(w),action:'answer',questionId:w.clarification.graphical.questions[0].question.id,questionVersion:w.clarification.graphical.questions[0].question.version,choiceId:'yes',requestId});
const result=r=>{assert.notEqual(r.isError,true,JSON.stringify(r));return r.structuredContent;};

test('no-App discovery and both text menus expose callable exact Sync answer choices',async t=>{
 const f=await fixture(t),w=await questioned(f),c=await client(t,f.root),tools=(await c.listTools()).tools;
 assert.ok(tools.find(x=>x.name===T.curationQuestion));assert.equal(tools.find(x=>x.name===T.curationQuestion)._meta?.ui,undefined);assert.deepEqual(tools.find(x=>x.name===T.curationReview)._meta.ui.visibility,['app']);
 for(const details of [false,true]){const shown=result(await show(c,w,details));assert.match(shown.presentation.text,/Has queue v2 deployed/);const answer=shown.presentation.operational.numberedActions.find(a=>a.tool===T.curationQuestion&&a.arguments.choiceId==='yes');assert.ok(answer);assert.equal(answer.arguments.workflowId,w.id);assert.equal(answer.arguments.questionVersion,1);assert.equal(shown.presentation.operational.answerInputs[0].inputRequired,'rawText');assert.equal('rawText' in shown.presentation.operational.answerInputs[0].arguments,false);}
 const shown=result(await show(c,w)),answer=shown.presentation.operational.numberedActions.find(a=>a.arguments.choiceId==='yes'),saved=result(await throughText(c,answer.arguments));
 assert.equal(saved.answerAcknowledgement.origin,'agent_relay');assert.equal(saved.answerAcknowledgement.saved,true);const answers=await curationAnswers(f.root,w.clarification.review.snapshot.revision.lineageId);assert.equal(answers.length,1);assert.equal(answers[0].origin,'agent_relay');assert.equal(answers[0].choice.meaning,'Queue v2 is deployed.');
});

test('no-App defer and deliberately emitted Revisit return to the same saved question',async t=>{
 const f=await fixture(t),w=await questioned(f),c=await client(t,f.root);const shown=result(await show(c,w)),later=shown.presentation.operational.numberedActions.find(a=>a.arguments.action==='question_later');assert.ok(later);result(await throughText(c,later.arguments));
 const deferred=result(await show(c,w)),revisit=deferred.presentation.operational.numberedActions.find(a=>a.arguments.action==='question_reopen');assert.ok(revisit);assert.equal(revisit.tool,T.curationQuestion);result(await throughText(c,revisit.arguments));
 const reopened=result(await show(c,w));assert.equal(reopened.result.state,'awaiting_clarification');assert.equal(reopened.result.clarification.graphical.questions[0].question.id,w.clarification.graphical.questions[0].question.id);
});

test('wrong ownership/bindings and authority or approval fields fail without a saved answer',async t=>{
 const f=await fixture(t),w=await questioned(f),c=await client(t,f.root),input=choice(w),before=JSON.stringify(await listKnowledge(f.root));
 for(const patch of [{workflowId:randomUUID()},{candidateId:`area_${'f'.repeat(20)}`},{reviewId:'review_wrong'},{questionId:'question_wrong'},{questionVersion:2},{reviewRevisionId:`revision_${'f'.repeat(64)}`},{planHash:'f'.repeat(64)},{decisionRevision:99},{answerLogHash:'f'.repeat(64)},{origin:'app'},{approved:true},{decisions:{}},{meaning:'fabricated choice'},{choiceId:'unknown'}])assert.equal((await throughText(c,{...input,...patch})).isError,true,JSON.stringify(patch));
 for(const action of ['create','decide','summary','pause','resume','defer_change','apply'])assert.equal((await throughText(c,{...input,action})).isError,true,action);
 assert.equal((await c.callTool({name:T.curationReview,arguments:{...identity(w.clarification),action:'summary'}})).isError,true);
 assert.equal((await c.callTool({name:T.curationApply,arguments:{reviewId:w.clarification.review.snapshot.reviewId,planHash:w.clarification.review.snapshot.planHash,decisionRevision:0,selectedIds:f.ids}})).isError,true);
 assert.equal((await curationAnswers(f.root,w.clarification.review.snapshot.revision.lineageId)).length,0);assert.equal(JSON.stringify(await listKnowledge(f.root)),before);
 assert.equal((await c.callTool({name:T.curationQuestion,arguments:{...input,origin:'app'}})).isError,true);
});

test('saved answer survives preparation failure; inspect then exact replay creates no duplicate event or job',async t=>{
 const f=await fixture(t),w=await questioned(f),c=await client(t,f.root),input=choice(w,'unknown-outcome'),max=SEMANTIC_RETENTION.maxJobs;let saved;
 SEMANTIC_RETENTION.maxJobs=(await semanticJobs(f.root)).length;try{saved=result(await throughText(c,input));}finally{SEMANTIC_RETENTION.maxJobs=max;}
 assert.equal(saved.answerAcknowledgement.saved,true);assert.match(saved.analysisNotice,/Answer saved/);
 const inspected=result(await throughText(c,{action:'inspect',workflowId:w.id,candidateId:input.candidateId,reviewId:input.reviewId}));assert.equal(inspected.graphical.questions[0].answer.requestId,input.requestId);
 const resumed=result(await throughText(c,input));assert.ok(resumed.continuationJobId);const again=result(await throughText(c,input));assert.equal(again.continuationJobId,resumed.continuationJobId);assert.equal((await semanticJobs(f.root)).length,2);
 for(const patch of [{choiceId:'no'},{replacesAnswerId:'answer_wrong'},{questionVersion:2}])assert.equal((await throughText(c,{...input,...patch})).isError,true);
 assert.equal((await curationAnswers(f.root,w.clarification.review.snapshot.revision.lineageId)).length,1);
});

test('relayed answers remain conservative through bounded reasoning and an explicit deferred result',async t=>{
 const f=await fixture(t),w=await questioned(f),c=await client(t,f.root),input=choice(w),saved=result(await throughText(c,input)),j=await inspectSemanticCuration(f.root,saved.continuationJobId),p=unresolved(j);
 p.answerInterpretations=j.task.data.answers.map(a=>({answerId:a.id,status:'ambiguous',fact:a.choice.meaning,sourceIds:a.sourceIds,grounding:[a.id]}));
 const staged=result(await c.callTool({name:T.curationReasoningPropose,arguments:{jobId:j.jobId,inputHash:j.job.input.inputHash,proposal:p}}));assert.equal(staged.result.status,'validated');
 assert.equal((await throughText(c,input)).isError,true,'Old review binding must not re-answer a successor');
 const current=result(await show(c,w));assert.equal(current.result.state,'awaiting_clarification');const later=current.presentation.operational.numberedActions.find(a=>a.arguments.action==='question_later');result(await throughText(c,later.arguments));const done=result(await show(c,w));assert.equal(done.result.state,'completed');assert.equal(done.result.summary.questionsDeferred,1);assert.equal(done.result.summary.areasProcessed,0);
});

test('configured cross-project direct and nested roots cannot be authorized by a conversational selector',async t=>{
 const f=await fixture(t),w=await questioned(f),other=await fixture(t),otherW=await questioned(other),c=await client(t,f.root),input={...choice(otherW),projectRoot:other.root};
 for(const response of [await c.callTool({name:T.curationQuestion,arguments:input}),await throughText(c,input)]){assert.equal(response.isError,true);assert.match(JSON.stringify(response),/PRODERO_ROOT_UNAUTHORIZED/);}
 assert.equal((await curationAnswers(other.root,otherW.clarification.review.snapshot.revision.lineageId)).length,0);
});

test('truly unattached direct and gateway question calls cannot self-authorize a valid fixture',async t=>{
 const f=await fixture(t),w=await questioned(f),c=await client(t,undefined),input={...choice(w),projectRoot:f.root},lineage=w.clarification.review.snapshot.revision.lineageId;
 for(const response of [await c.callTool({name:T.curationQuestion,arguments:input}),await throughText(c,input)]){assert.equal(response.isError,true);assert.match(JSON.stringify(response),/PRODERO_WORKSPACE_UNAVAILABLE/);}
 assert.equal((await curationAnswers(f.root,lineage)).length,0);
});

test('authorized symlink aliases share one canonical question journal and exact replay',async t=>{
 const f=await fixture(t),w=await questioned(f),alias=path.join(f.root,'workspace-alias');await fs.symlink(f.root,alias);const c=await client(t,alias),input={...choice(w,'alias-answer'),projectRoot:alias};
 const saved=result(await throughText(c,input)),again=result(await throughText(c,{...input,projectRoot:f.root}));assert.equal(saved.answerAcknowledgement.answerId,again.answerAcknowledgement.answerId);assert.equal((await curationAnswers(f.root,w.clarification.review.snapshot.revision.lineageId)).length,1);
});

test('free-form relayed answers reject secrets and preserve exact replacement replay',async t=>{
 const f=await fixture(t),w=await questioned(f),c=await client(t,f.root),input=choice(w),q=w.clarification.graphical.questions[0];delete input.choiceId;
 const secret='synthetic_audit_credential',bad=await throughText(c,{...input,rawText:`SERVICE_PASSWORD password=${secret}`});assert.equal(bad.isError,true);assert.equal(JSON.stringify(bad).includes(secret),false);assert.equal((await curationAnswers(f.root,w.clarification.review.snapshot.revision.lineageId)).length,0);
 const saved=result(await throughText(c,{...input,rawText:'Deployment depends on the environment.'})),j=await inspectSemanticCuration(f.root,saved.continuationJobId),p=unresolved(j);p.answerInterpretations=j.task.data.answers.map(a=>({answerId:a.id,status:'ambiguous',fact:'The environment is not specified.',sourceIds:a.sourceIds,grounding:[a.id]}));result(await c.callTool({name:T.curationReasoningPropose,arguments:{jobId:j.jobId,inputHash:j.job.input.inputHash,proposal:p}}));
 const current=result(await show(c,w)),answerInputs=current.presentation.operational.answerInputs;assert.ok(answerInputs?.length);const replacement={...answerInputs[0].arguments,rawText:'The sandbox environment is deployed.'};assert.equal(replacement.replacesAnswerId,saved.answerAcknowledgement.answerId);result(await throughText(c,replacement));result(await throughText(c,replacement));
 assert.equal((await throughText(c,{...replacement,replacesAnswerId:undefined})).isError,true);const answers=await curationAnswers(f.root,w.clarification.review.snapshot.revision.lineageId);assert.equal(answers.length,2);assert.equal(answers[1].replacesAnswerId,answers[0].id);assert.equal(answers.every(a=>a.origin==='agent_relay'),true);
});
