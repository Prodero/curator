/** Sync orchestration adapter. Questions, answers and jobs belong to Curator. */
import {createCurationReview,resumeCurationReview,latestCurationReview,loadCurationReview,assertCurationHead,CurationReviewError} from './curation-review.js';
import {planKnowledgeCuration} from './knowledge-curation.js';
import {graphicalReviewPayload} from './curation-graphical.js';
import {prepareSemanticCuration,inspectSemanticCuration,curationAnswers} from './curation-semantic-jobs.js';
import {prepareMemoryTransformation,validateMemoryTransformationProposal,type MemoryTransformationProposal} from './memory-transformation-proposal.js';
import {previewMemoryTransformation} from './memory-transformation.js';
import {scopeEffect,semanticHash} from './curation-semantic-contract.js';
import {deterministicBaseline} from './curation-revision.js';

/** Explicit expiry refresh carries staged semantics and non-approval decisions
 * into a fresh revision. It neither reopens a question nor records an apply. */
export async function refreshSyncQuestions(root:string,sourceIds:string[],input:{reviewId:string;reviewRevisionId:string;planHash:string;decisionRevision:number;answerLogHash:string}){
 const review=await loadCurationReview(root,input.reviewId,{allowExpired:true}),revision=review.snapshot.revision!;
 await assertCurationHead(root,review);
 if(revision.id!==input.reviewRevisionId||review.snapshot.planHash!==input.planHash||review.state.revision!==input.decisionRevision||semanticHash(await curationAnswers(root,revision.lineageId))!==input.answerLogHash)throw new CurationReviewError('review_changed','This saved question changed. Inspect current progress.');
 const payload=await graphicalReviewPayload(root,review),baseline=deterministicBaseline(revision);
 if(payload.projection.lifecycle!=='stale')throw new CurationReviewError('review_changed','This review has not expired. Inspect its current questions.');
 if((await planKnowledgeCuration(root,{memorySyncSources:sourceIds})).planId!==baseline.planId)throw new CurationReviewError('semantic_stale','Knowledge or evidence changed. Re-analyze before refreshing this question.');
 const next=await createCurationReview(root,{parent:review,operationId:`question_refresh_${semanticHash([revision.id,input.decisionRevision,input.answerLogHash])}`,applied:[]},sourceIds);
 return graphicalReviewPayload(root,next);
}
import {sameApplicability} from './applicability.js';

export async function prepareSyncCuration(root:string,sourceIds:string[],reviewId?:string,retry=false){
 const previous=reviewId?undefined:await latestCurationReview(root,(await planKnowledgeCuration(root,{memorySyncSources:sourceIds})).planId);
 const review=reviewId?await resumeCurationReview(root,reviewId):previous??await createCurationReview(root,undefined,sourceIds);
 const payload=await graphicalReviewPayload(root,review),g=payload.graphical!;
 if(g.activeQuestionCount||g.deferredQuestionIds.length)return {reviewId:review.snapshot.reviewId,payload};
 // Replaying Prepare after Retry must return its live attempt, not the old initial request.
 if(g.continuationJobId)return {reviewId:review.snapshot.reviewId,payload,job:await inspectSemanticCuration(root,g.continuationJobId)};
 const failed=retry?g.jobs.find(j=>!j.suspended&&['rejected','stale'].includes(j.status)):undefined;
 const job=await prepareSemanticCuration(root,{reviewId:review.snapshot.reviewId,reviewRevisionId:review.snapshot.revision!.id,componentId:failed?.componentId??review.snapshot.revision!.dependencies.groups[0].component,requestId:failed?`sync_retry_${failed.id}`:`sync_${review.snapshot.reviewId}`,reason:failed?(failed.status==='rejected'?'validation_correction':'resume'):'initial',...(failed?failed.status==='rejected'?{correctionForJobId:failed.id}:{resumeForJobId:failed.id}:{}),limits:{maxItems:24}});
 return {reviewId:review.snapshot.reviewId,payload,job};
}

export async function inspectSyncCuration(root:string,reviewId:string){
 return graphicalReviewPayload(root,await resumeCurationReview(root,reviewId));
}

/** Reuse the existing Sync validator/writer; Curator staging is never authority.
 * Protected, shared or scope-changing outputs stay current. */
export async function previewSyncCuration(root:string,candidateId:string,payload:Awaited<ReturnType<typeof inspectSyncCuration>>){
 const typed=payload.review!.snapshot.revision!.typedPlan;
 if(typed.kind!=='semantic-v2')return undefined;
 const analysis=typed.analyses.at(-1)!;
 const proposal=analysis.proposal;
 if(proposal.issues.length||proposal.additionalEvidenceRequired.length||proposal.limitations.length||proposal.sources.some(s=>s.disposition==='unresolved'))return undefined;
 const prepared=await prepareMemoryTransformation(root,candidateId),b=prepared.bundle;
 if(!prepared.canPropose)throw new Error('Complete transformation evidence is required');
 if(analysis.bundle.expectedSources.length!==b.sourceIds.length||analysis.bundle.expectedSources.some(s=>b.revisions.active[s.id]!==s.revision))throw new Error('Sync analysis sources changed');
 const eligible=proposal.outputs.filter(o=>o.sourceIds.every(id=>{
  const s=b.activeSources.find(s=>s.id===id),first=b.activeSources.find(s=>s.id===o.sourceIds[0]);
  if(!s||!first||s.protected||s.layer!=='local'||s.knowledge.status!=='active'||s.knowledge.contextPolicy!=='relevant'||s.knowledge.authority!=='inferred')return false;
  const legacyRepresentable=s.knowledge.applicability?.kind!=='legacy'||s.knowledge.scope==='global'||s.knowledge.scope==='module'&&s.knowledge.scopeKind==='path';
  return legacyRepresentable&&sameApplicability(s.knowledge,first.knowledge)&&scopeEffect(s.knowledge,o.applicability)==='unchanged';
 }));
 // A source with several outputs is replaced only when every output is eligible.
 let allowed=eligible;
 while(true){const next=allowed.filter(o=>o.sourceIds.every(id=>proposal.sources.find(s=>s.sourceId===id)!.outputKeys.every(k=>allowed.some(a=>a.key===k))));if(next.length===allowed.length)break;allowed=next;}
 const records:MemoryTransformationProposal['records']=allowed.map(o=>{
  const source=b.activeSources.find(s=>s.id===o.sourceIds[0])!.knowledge;
  return {key:o.key.replace(/^out_/,'draft_'),category:source.category,priority:source.priority,title:o.title,body:o.body,sourceIds:o.sourceIds,applicability:o.applicability,scope:source.scope==='global'?'global':source.scopeKind==='path'?'path':'project',...(source.scopeKind==='path'?{path:source.scopeRef!}:{})};
 });
 const transformed:MemoryTransformationProposal={...prepared.binding,records,dispositions:b.sourceIds.map(sourceId=>{
  const keys=allowed.filter(o=>o.sourceIds.includes(sourceId)).map(o=>o.key.replace(/^out_/,'draft_'));
  return {sourceId,action:keys.length?'consolidate':'keep',proposedKeys:keys,rationale:proposal.sources.find(s=>s.sourceId===sourceId)!.rationale,coverage:'Validated Curator clause coverage; protected and shared sources remain current.',omittedAsRedundant:[],unresolvedInformation:[]};
 }),summary:`${proposal.rationale}\nCurator review: ${payload.review!.snapshot.reviewId}; revision: ${payload.review!.snapshot.revision!.id}; answer events: ${analysis.bundle.answers.map(a=>a.id).join(', ')||'none'}.`,warnings:[],additionalEvidenceRequired:[]};
 return previewMemoryTransformation(root,await validateMemoryTransformationProposal(root,transformed));
}
