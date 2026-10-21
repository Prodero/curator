/** Model-visible Sync question adapter. Staging only; no selection or Apply. */
import {z} from 'zod';
import {graphicalActionSchema,graphicalReviewAction} from './curation-graphical.js';
import {syncCurationReview} from './memory-sync.js';
import {withSyncLock} from './sync-transaction.js';
import {curationAnswers} from './curation-semantic-jobs.js';
const owner={workflowId:z.string().uuid(),candidateId:z.string().regex(/^area_[a-f0-9]{20}$/)};
const actions=z.enum(['analyze','answer','question_later','question_reopen','retry_analysis']);
export const curationQuestionSchema=z.union([
 graphicalActionSchema.extend({...owner,action:actions}).strict(),
 z.object({...owner,action:z.literal('inspect'),reviewId:z.string().regex(/^review_[a-zA-Z0-9_]+$/)}).strict(),
]);
// MCP requires an object-root schema. The strict action-specific union is
// checked inside the same operation before ownership or journal mutations.
export const curationQuestionToolSchema=graphicalActionSchema.extend({...owner,action:z.enum(['inspect',...actions.options]),reviewRevisionId:graphicalActionSchema.shape.reviewRevisionId.optional(),planHash:graphicalActionSchema.shape.planHash.optional(),decisionRevision:graphicalActionSchema.shape.decisionRevision.optional(),answerLogHash:graphicalActionSchema.shape.answerLogHash.optional()}).strict();
export async function runCurationQuestion(root:string,raw:z.input<typeof curationQuestionToolSchema>){
 const input=curationQuestionSchema.parse(raw);
 return withSyncLock(root,async()=>{
  const {workflowId,candidateId,...request}=input;
  const saved=await syncCurationReview(root,workflowId,candidateId,request.reviewId);
  const payload=request.action==='inspect'?saved:await graphicalReviewAction(root,request,'agent_relay');
  const answer=request.action==='answer'?(await curationAnswers(root,payload.review!.snapshot.revision!.lineageId)).find(a=>a.requestId===request.requestId):undefined;
  return {...payload,action:'curation-question' as const,syncWorkflowId:workflowId,candidateId,appReviewAvailable:false,
   ...(answer?{answerAcknowledgement:{answerId:answer.id,origin:answer.origin,saved:true as const,message:'Relayed chat answer saved. It is evidence for staged analysis, not authenticated human intent or approval.'}}:{}),
   next:{tool:'prodero_memory_sync',arguments:{projectRoot:root,request:{action:'inspect',workflowId}},instructions:'Inspect this saved Sync workflow after the bounded reasoning continuation. Relayed answers remain evidence, not approval; unresolved facts may still need clarification or deliberate deferral. Never Apply, promote or publish on the strength of an answer.'}};
 },{recoverLifecycle:false,waitMs:2000});
}
