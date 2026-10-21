/** First-party App orchestration. Local review state only; never grants or writes knowledge. */
import {z} from 'zod';
import {withSyncLock,ownsSyncLock} from './sync-transaction.js';
import {loadCurationReview,curationReviewView,stageCurationDecisions,stageEvent,assertCurationHead,CurationReviewError,type CurationReview} from './curation-review.js';
import {curationAnswers,appendCurationAnswer,semanticJobs,semanticJobStatus,semanticJobSuspended,semanticRetryState,prepareSemanticCuration} from './curation-semantic-jobs.js';
import {revisionIssues,selectionProblems,deterministicBaseline} from './curation-revision.js';
import {planKnowledgeCuration} from './knowledge-curation.js';
import {semanticHash,type AnswerEvent} from './curation-semantic-contract.js';
const identity={reviewId:z.string(),reviewRevisionId:z.string(),planHash:z.string(),decisionRevision:z.number().int().nonnegative(),answerLogHash:z.string()};
export const graphicalActionSchema=z.object({...identity,action:z.enum(['summary','analyze','answer','question_later','question_reopen','retry_analysis']),questionId:z.string().optional(),questionVersion:z.number().int().positive().optional(),choiceId:z.string().optional(),rawText:z.string().max(8192).optional(),requestId:z.string().min(1).max(100).optional(),replacesAnswerId:z.string().optional()}).strict();
export type GraphicalAction=z.infer<typeof graphicalActionSchema>;
const pending=(status:string)=>['prepared','awaiting_reasoning','submitted'].includes(status);
export async function graphicalReviewState(root:string,review:CurationReview,projection:Awaited<ReturnType<typeof curationReviewView>>['projection']){
 const revision=review.snapshot.revision;if(!revision)return undefined;
 const answers=await curationAnswers(root,revision.lineageId),allJobs=await semanticJobs(root);
 const questions=projection.clarificationCandidates.map(q=>{
  const units=projection.items.filter(u=>u.proposalIds.some(id=>q.sourceIds.includes(id)));
  const answer=[...answers].reverse().find(a=>a.questionId===q.question.id&&a.basisHash===q.basisHash&&!answers.some(next=>next.replacesAnswerId===a.id));
  return {...q,unitIds:units.map(u=>u.id),componentId:revision.dependencies.groups.find(g=>g.proposalIds.some(id=>q.sourceIds.includes(id)))?.component,answer};
 });
 const jobs=allJobs.filter(j=>j.input.reviewRevisionId===revision.id&&!allJobs.some(next=>next.input.previousJobId===j.input.jobId)).map(j=>{
  const event=j.events.at(-1)!;
  const suspended=semanticJobSuspended(j,review);
  const status=semanticJobStatus(j,review);
  return {id:j.input.jobId,componentId:j.input.bundle.componentId,status,reason:event.reason,suspended,...semanticRetryState(j,review,allJobs)};
 });
 const actionable=jobs.filter(j=>!j.suspended&&j.status!=='validated');
 const unansweredComponents=revision.dependencies.groups.filter(g=>projection.items.some(u=>u.id===g.id&&u.needsInput)&&!questions.some(q=>q.componentId===g.component));
 const awaiting=questions.find(q=>q.state==='answered_pending_analysis');
 const componentId=awaiting?.componentId??unansweredComponents[0]?.component;
 const activeQuestions=questions.filter(q=>q.needsInput);
 const answered=new Set(revision.answerBindings.map(a=>a.answerEventId));
 const clarifiedWithYou=new Set(answers.filter(a=>answered.has(a.id)&&!revisionIssues(revision).some(i=>i.sourceIds.some(id=>a.sourceIds.includes(id)))).map(a=>a.issueId)).size;
 return {version:1,questions:questions.map(q=>({...q,
  // Deferral requires every affected unit to become deferred/kept; reopening
  // any unit can reactivate an overlapping question. These effects differ.
  relatedQuestions:questions.filter(other=>other.state!=='deferred'&&other.unitIds.some(id=>q.unitIds.includes(id))&&other.unitIds.every(id=>q.unitIds.includes(id)||projection.items.some(u=>u.id===id&&(u.issue?.state==='deferred'||u.disposition==='keep_current')))).map(other=>({id:other.question.id,version:other.question.version,title:other.question.title})),
  reopenedQuestions:questions.filter(other=>(other.state==='deferred'||other.disposition==='keep_current')&&other.unitIds.some(id=>q.unitIds.includes(id))).map(other=>({id:other.question.id,version:other.question.version,title:other.question.title})),
  position:activeQuestions.findIndex(a=>a.question.id===q.question.id)+1})),activeQuestionIds:activeQuestions.map(q=>q.question.id),activeQuestionCount:activeQuestions.length,deferredQuestionIds:questions.filter(q=>q.state==='deferred').map(q=>q.question.id),answerLogHash:semanticHash(answers),clarifiedWithYou,
  jobs,continuationJobId:actionable.find(j=>pending(j.status))?.id,analysisFailed:actionable.some(j=>!pending(j.status)),analysisPending:actionable.some(j=>pending(j.status))||!!awaiting&&!actionable.some(j=>!pending(j.status)),
  canRetryAnalysis:actionable.some(j=>j.canRetry||j.canResume),
  nextAnalysisComponent:componentId,needsPreparation:!!componentId&&!actionable.some(j=>j.componentId===componentId),
  filters:{ready:projection.items.filter(i=>i.ready).map(i=>i.id),clarification:projection.items.filter(i=>i.outcome==='unresolved').map(i=>i.id),deferred:projection.items.filter(i=>i.disposition==='deferred').map(i=>i.id),unchanged:projection.items.filter(i=>i.outcome==='unchanged').map(i=>i.id),applied:projection.items.filter(i=>i.execution==='applied').map(i=>i.id)},
  repositoryChanges:projection.items.filter(i=>i.ready&&i.proposalIds.some(id=>!review.snapshot.plan.proposals.find(p=>p.id===id)!.path.startsWith('local/'))).length,policyEffectChanges:projection.items.filter(i=>i.ready&&i.proposalIds.some(id=>review.snapshot.plan.proposals.find(p=>p.id===id)!.changes.some(c=>c.startsWith('applicability-')))).length,
  packageReady:projection.readyChangeGroups===projection.included&&projection.canApply,packageCount:projection.included,
  remaining:projection.unresolvedIssueCount>0||projection.deferredChanges>0||projection.readyChangeGroups>0};
}
export async function graphicalReviewPayload(root:string,review:CurationReview){
 const view=await curationReviewView(root,review.snapshot.plan,review);
 return {action:'curation' as const,root,plan:review.snapshot.plan,...view,graphical:await graphicalReviewState(root,view.review!,view.projection),appReviewAvailable:true};
}
export async function graphicalReviewAction(root:string,raw:GraphicalAction,answerOrigin:AnswerEvent['origin']='app'){
 const input=graphicalActionSchema.parse(raw);
 const operation=async()=>{
  let review=await loadCurationReview(root,input.reviewId);const revision=review.snapshot.revision!;
  await assertCurationHead(root,review);
  if(!revision||revision.id!==input.reviewRevisionId||review.snapshot.planHash!==input.planHash||review.state.revision!==input.decisionRevision)throw new CurationReviewError('review_changed','This review changed. Reload saved decisions.');
  const answers=await curationAnswers(root,revision.lineageId);
  const replay=input.action==='answer'&&answers.find(a=>a.requestId===input.requestId);
  if(!replay&&semanticHash(answers)!==input.answerLogHash)throw new CurationReviewError('review_changed','Another answer was saved. Reload this review.');
  let view=await graphicalReviewPayload(root,review),g=view.graphical!;
  const question=g.questions.find(q=>q.question.id===input.questionId&&q.question.version===input.questionVersion);
  if(['answer','question_later','question_reopen'].includes(input.action)&&!question)throw new CurationReviewError('review_changed','This question changed. Reload the review.');
  if(input.action==='summary'){
   const selected=view.projection.items.filter(i=>i.ready).flatMap(i=>i.proposalIds);
   if(selectionProblems(revision.dependencies,selected).length)throw new CurationReviewError('dependency_blocked','Some changes depend on unresolved information.');
   const decisions=Object.fromEntries(view.projection.items.filter(i=>i.ready&&i.disposition!=='included').map(i=>[i.id,'suggested' as const]));
   if(Object.keys(decisions).length)review=await stageCurationDecisions(root,{...input,decisions});
  }else if(input.action==='question_later'||input.action==='question_reopen'){
   const baseline=deterministicBaseline(revision);
   if((await planKnowledgeCuration(root,{memorySyncSources:baseline.memorySyncSources})).planId!==baseline.planId)throw new CurationReviewError('semantic_stale','Knowledge or evidence changed. Review the current question.');
   if(input.action==='question_reopen'&&question!.state!=='deferred')throw new CurationReviewError('review_changed','This question is not deferred. Reload the saved review.');
   review=await stageEvent(root,input,input.action==='question_later'?'defer_issue':'reopen_issue',Object.fromEntries(question!.unitIds.map(id=>[id,'deferred' as const])));
  }else{
   if(input.action==='answer'){
    if(!input.requestId)throw new CurationReviewError('semantic_invalid','Answer request identity is missing.');
    if(!replay&&(!question!.needsInput||g.analysisPending))throw new CurationReviewError('review_changed','This answer is already being reviewed.');
    await appendCurationAnswer(root,{reviewId:input.reviewId,reviewRevisionId:input.reviewRevisionId,decisionRevision:input.decisionRevision,answerLogHash:input.answerLogHash,questionId:input.questionId!,questionVersion:input.questionVersion!,requestId:input.requestId,origin:answerOrigin,choiceId:input.choiceId,rawText:input.rawText,replacesAnswerId:input.replacesAnswerId});
    // Answer is durable before job preparation. A capacity/dispatch failure cannot erase it.
    view=await graphicalReviewPayload(root,review);g=view.graphical!;
   }
   const failed=g.jobs.find(j=>!j.suspended&&(j.canRetry||j.canResume)),component=input.action==='answer'?question!.componentId:input.action==='retry_analysis'?failed?.componentId:g.nextAnalysisComponent;
   if(!component){if(g.continuationJobId)return view;throw new CurationReviewError('semantic_limit','No further automatic analysis is available. Review details or answer later.');}
   try{
    const job=await prepareSemanticCuration(root,{reviewId:review.snapshot.reviewId,reviewRevisionId:revision.id,componentId:component,requestId:input.requestId??`app_${semanticHash([revision.id,review.state.revision,g.answerLogHash,component,input.action,...(input.action==='retry_analysis'?[failed!.id]:[])])}`,reason:input.action==='retry_analysis'?(failed!.canRetry?'validation_correction':'resume'):input.action==='answer'?'answer':g.questions.some(q=>q.state==='answered_pending_analysis')?'resume':'initial',...(input.action==='retry_analysis'?failed!.canRetry?{correctionForJobId:failed!.id}:{resumeForJobId:failed!.id}:{})});
    view=await graphicalReviewPayload(root,review);return {...view,continuationJobId:pending(job.status)?job.jobId:undefined,analysisNotice:pending(job.status)?undefined:'No further progress was possible with the current information.'};
   }catch(error){if(!(error instanceof CurationReviewError))throw error;return {...await graphicalReviewPayload(root,review),analysisNotice:input.action==='answer'?'Answer saved. Analysis needs more information or has reached its limit.':error.message};}
  }
  return graphicalReviewPayload(root,review);
 };return ownsSyncLock(root)?operation():withSyncLock(root,operation,{recoverLifecycle:false,waitMs:2000});
}
