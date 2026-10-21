import { loadKnowledgeGraph } from './knowledge-graph.js';
import {memorySyncOperation} from '../memory-sync-operation.js';
import {curationAnswers} from './curation-semantic-jobs.js';
import {graphicalReviewPayload} from './curation-graphical.js';
import { previewMemoryLinkRepair, applyMemoryLinkRepair, type MemoryLinkRepairPreview } from './memory-link-repair.js';
import {loadCurationReview,CurationReviewError} from './curation-review.js';
import { requireCurrentProject } from "./migrations.js";
import { publicDiagnostic } from './diagnostics.js';
import {prepareSyncCuration,inspectSyncCuration,previewSyncCuration,refreshSyncQuestions} from './memory-sync-curator.js';
/** User-initiated orchestration. One bounded local workflow; no provider or background caller. */
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { checkedDataPath, ensureDataDirectory, writeFileAtomic, sha256, listCheckpoints, readConfig } from './storage.js';
import { withSyncLock, recoverSyncTransaction, fileHash } from './sync-transaction.js';
import { readKnowledgeInventory } from './knowledge-provenance.js';
import { getMemoryIntelligencePlan } from './memory-intelligence.js';
import { prepareMemoryTransformation, validateMemoryTransformationProposal, memoryTransformationProposalSchema } from './memory-transformation-proposal.js';
import { previewMemoryTransformation, applyMemoryTransformation, type MemoryTransformationPreview } from './memory-transformation.js';
import { promotionRecommendations, previewKnowledgePromotion, applyKnowledgePromotion, type PromotionPreview } from './promotion.js';
import { discoverSessions } from './session-index.js';
import { syncProject, autoMigrateProject, findProjectRoot } from './project.js';
const FILE = 'local/memory-sync.json';
export const MEMORY_SYNC_LIMITS = { workflows: 1, candidates: 20, promotions: 50, bytes: 4 * 1024 * 1024 } as const;
const digest = (v: unknown) => sha256(JSON.stringify(v));
const id = z.string().regex(/^area_[a-f0-9]{20}$/);
const fingerprintSchema = z.object({knowledge:z.string(),telemetry:z.string(),checkpoints:z.string()}).strict();
const jobSchema = z.object({id, label:z.string(), signals:z.array(z.string()), recordCount:z.number(), counts:z.record(z.number()).optional(), categories:z.record(z.number()).optional(), sourceIds:z.array(z.string()).max(24), layers:z.object({local:z.number(),versioned:z.number()}), selected:z.boolean(), status:z.enum(['unselected','pending','semantic_work','awaiting_review','awaiting_clarification','deferred','applied','skipped','failed']), curationReviewId:z.string().optional(),curationStateHash:z.string().optional(),error:z.string().optional(), unresolved:z.number().optional(), result:z.unknown().optional()}).strict();
const stateSchema = z.object({version:z.literal(1), id:z.string().uuid(),root:z.string(),revision:z.number().int(),createdAt:z.string(),state:z.enum(['awaiting_selection','semantic_work','awaiting_clarification','awaiting_review','applying','awaiting_promotion_selection','completed','stale']),improveEnabled:z.boolean().optional(),repairLinksEnabled:z.boolean().optional(),brokenLinks:z.number().int().nonnegative().optional(),repairLinksDone:z.boolean().optional(),repairLinksResult:z.object({fixed:z.number(),remaining:z.number()}).optional(),
 usage:z.object({sessions:z.number(),available:z.boolean()}).optional(),baseline:fingerprintSchema,jobs:z.array(jobSchema).max(20),promotionEnabled:z.boolean(),promotionDone:z.boolean(),promotionCandidates:z.array(z.object({id:z.string(),title:z.string(),score:z.number(),signals:z.array(z.string()),recommended:z.boolean()})).max(50),promotionTotal:z.number(),promotionResult:z.unknown().optional(),recovery:z.object({sessions:z.number(),created:z.number()}),error:z.string().optional(),
 active:z.object({kind:z.enum(['transformation','promotion','link-repair']),reviewId:z.string(),candidateId:id.optional(),preview:z.unknown(),approved:z.boolean(),unaffectedKnowledge:z.string().optional(),touchedIds:z.array(z.string()).max(150).optional()}).strict().optional(),
}).strict();
type Workflow = z.infer<typeof stateSchema>;
const requestIdentity = {workflowId:z.string().uuid(),revision:z.number().int().min(1)};
export const memorySyncActionSchema = z.discriminatedUnion('action', [
 z.object({action:z.literal('start'),restart:z.boolean().optional()}).strict(),
 z.object({action:z.literal('inspect'),workflowId:z.string().uuid().optional()}).strict(),
 z.object({action:z.literal('select'),...requestIdentity,improve:z.boolean().optional(),repairLinks:z.boolean().optional(),share:z.boolean().optional(),candidateIds:z.array(id).max(20).optional(),reviewPromotion:z.boolean().optional()}).strict(),
 z.object({action:z.literal('prepare'),...requestIdentity,candidateId:id}).strict(),
 z.object({action:z.literal('propose'),...requestIdentity,candidateId:id,proposal:memoryTransformationProposalSchema}).strict(),
 z.object({action:z.literal('approve'),...requestIdentity,reviewId:z.string(),approved:z.literal(true)}).strict(),
 z.object({action:z.literal('skip'),...requestIdentity,candidateId:id.optional()}).strict(),
 z.object({action:z.literal('retry'),...requestIdentity,candidateId:id}).strict(),
 z.object({action:z.literal('refresh_questions'),...requestIdentity,candidateId:id,reviewId:z.string(),reviewRevisionId:z.string(),planHash:z.string(),decisionRevision:z.number().int().nonnegative(),answerLogHash:z.string()}).strict(),
 z.object({action:z.literal('promotions'),...requestIdentity,ids:z.array(z.string()).max(50)}).strict(),
 z.object({action:z.literal('complete'),...requestIdentity}).strict(),
]);
// Public action shape is checked again by state-specific guards below.
export type MemorySyncAction = z.input<typeof memorySyncActionSchema>;
async function knowledgeHash(root:string,exclude:string[]=[]){return digest((await readKnowledgeInventory(root)).filter(r=>!exclude.includes(r.item.id)).map(r=>[r.item.id,r.path,r.revision]));}
async function fingerprint(root:string,excludeCheckpoint?:string){return {knowledge:await knowledgeHash(root),telemetry:await fileHash(await checkedDataPath(root,'local/memory-pressure.json'))??'missing',checkpoints:digest((await listCheckpoints(root)).filter(c=>c.id!==excludeCheckpoint).map(c=>[c.id,digest(c)]))};}
async function load(root:string):Promise<Workflow|null>{const target=await checkedDataPath(root,FILE);try{const stat=await fs.stat(target);if(stat.size>MEMORY_SYNC_LIMITS.bytes)throw new Error('Curate Memory state exceeds bound');const envelope=JSON.parse(await fs.readFile(target,'utf8'));if(envelope.hash!==digest(envelope.workflow))throw new Error('Curate Memory checkpoint is corrupt');const state=stateSchema.parse(envelope.workflow);if(state.root!==await fs.realpath(root))throw new Error('Curate Memory belongs to another project');return state;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
async function save(root:string,w:Workflow){w.revision++;const workflow=stateSchema.parse(w);const text=JSON.stringify({hash:digest(workflow),workflow});if(Buffer.byteLength(text)>MEMORY_SYNC_LIMITS.bytes)throw new Error('Curate Memory checkpoint exceeds bounded storage; split work');await ensureDataDirectory(root,'local');await writeFileAtomic(await checkedDataPath(root,FILE),text);}
async function promotions(root:string,w:Workflow){const rows=await promotionRecommendations(root,{persistCache:false});w.promotionCandidates=rows.slice(0,50);w.promotionTotal=rows.length;}
function currentJob(w:Workflow){return w.jobs.find(j=>j.selected&&['pending','semantic_work','awaiting_review','awaiting_clarification'].includes(j.status));}
async function advance(root:string,w:Workflow){
 if(w.repairLinksEnabled&&!w.repairLinksDone){
  const preview=await previewMemoryLinkRepair(root);
  if(preview.count){w.active={kind:'link-repair',reviewId:preview.previewId,preview,approved:false};w.state='awaiting_review';return;}
  w.repairLinksDone=true;
 }
 if(currentJob(w))w.state='semantic_work';else if(w.promotionEnabled&&!w.promotionDone){await promotions(root,w);if(w.improveEnabled!==undefined&&!w.promotionCandidates.length){w.promotionDone=true;w.state='completed';}else w.state='awaiting_promotion_selection';}else w.state='completed';}
async function deferredQuestions(root:string,w:Workflow){
 const questions=[];
 for(const job of w.jobs.filter(j=>j.selected&&j.status==='deferred'&&j.curationReviewId)){
  const payload=await inspectSyncCuration(root,job.curationReviewId!),review=payload.review!,g=payload.graphical!;
  const seen=new Set<string>();
  for(const q of g.questions.filter(q=>q.state==='deferred')){
   const related=q.reopenedQuestions,key=related.map(other=>other.id).sort().join(',');if(seen.has(key))continue;seen.add(key);
   questions.push({candidateId:job.id,title:q.question.title,prompt:q.question.prompt,expired:payload.projection.lifecycle==='stale',affectedQuestions:related,
    action:'question_reopen' as const,reviewId:review.snapshot.reviewId,reviewRevisionId:review.snapshot.revision!.id,planHash:review.snapshot.planHash,decisionRevision:review.state.revision,answerLogHash:g.answerLogHash,questionId:q.question.id,questionVersion:q.question.version});
  }
 }
 return questions;
}
/** Adopt only an explicitly reopened saved question. Inspection never reopens
 * one, preempts independent reasoning, or replaces an active exact review. */
async function resumeRevisitedQuestion(root:string,w:Workflow){
 if(!w.improveEnabled||currentJob(w)||w.active||['stale','applying','awaiting_selection'].includes(w.state))return;
 for(const job of w.jobs.filter(j=>j.selected&&j.status==='deferred'&&j.curationReviewId)){
  const payload=await inspectSyncCuration(root,job.curationReviewId!);
  if(!payload.graphical!.activeQuestionCount&&!payload.graphical!.analysisPending&&!payload.graphical!.questions.some(q=>q.state==='answered_pending_analysis'))continue;
  job.curationReviewId=payload.review!.snapshot.reviewId;job.status='semantic_work';delete job.error;w.state='semantic_work';await save(root,w);return;
 }
}
function view(w:Workflow,clarification?:Awaited<ReturnType<typeof inspectSyncCuration>>,deferred:Awaited<ReturnType<typeof deferredQuestions>>=[]){
 const applied=w.jobs.filter(j=>j.status==='applied').map(j=>(j.result as Awaited<ReturnType<typeof applyMemoryTransformation>>).summary);
 const promotion=w.promotionResult as Awaited<ReturnType<typeof applyKnowledgePromotion>>|undefined;
 return {...w,clarification,deferredQuestions:deferred,active:undefined,review:w.active?{kind:w.active.kind,reviewId:w.active.reviewId,preview:w.active.preview}:undefined,
  health:{transformationCandidates:w.jobs.length,contextPressureCandidates:w.jobs.filter(j=>j.signals.includes('context_pressure')).length,potentialConflictCandidates:w.jobs.filter(j=>j.signals.includes('potential_conflict')).length,localPromotionCandidates:w.promotionTotal,possibleVersionedTransformationRecords:w.jobs.reduce((n,j)=>n+j.layers.versioned,0)},
  summary:{brokenLinksFixed:w.repairLinksResult?.fixed??0,brokenLinksRemaining:w.repairLinksResult?.remaining??w.brokenLinks??0,areasProcessed:applied.length,areasFailed:w.jobs.filter(j=>j.status==='failed').length,areasSkipped:w.jobs.filter(j=>j.status==='skipped').length,questionsDeferred:w.jobs.filter(j=>j.status==='deferred').length,
   sourcesBefore:applied.reduce((n,r)=>n+r.consolidated.length+r.superseded.length+r.kept.length+r.unresolved.length,0),currentAfter:applied.reduce((n,r)=>n+r.created.length+r.kept.length+r.unresolved.length,0),
   archived:applied.reduce((n,r)=>n+r.archives.length,0),superseded:applied.reduce((n,r)=>n+r.superseded.length,0),unresolved:w.jobs.reduce((n,j)=>n+(j.unresolved??0),0),
   estimatedTokens:{scope:'transformed_areas',before:applied.reduce((n,r)=>n+r.estimatedTokens.before,0),after:applied.reduce((n,r)=>n+r.estimatedTokens.after,0)},
   versionedCreated:applied.reduce((n,r)=>n+r.created.filter(c=>c.layer==='versioned').length,0),promoted:promotion?.published??0,promotionCreated:promotion?.created.length??0,promotionUpdated:promotion?.updated.length??0,promotionCovered:promotion?.covered.length??0,localArchived:applied.reduce((n,r)=>n+r.archives.filter(a=>a.layer==='local').length,0),versionedArchived:applied.reduce((n,r)=>n+r.archives.filter(a=>a.layer==='versioned').length,0),acknowledgedCandidateIds:w.jobs.filter(j=>j.status==='applied').map(j=>j.id),promotionConflicts:promotion?.conflicts.length??0,historicalProvenancePreserved:true},
  coverage:{promotionCandidatesOmitted:Math.max(0,w.promotionTotal-w.promotionCandidates.length)},
  next:w.state==='semantic_work'?{action:'semantic_work_required',candidateId:currentJob(w)?.id,instructions:w.improveEnabled?'Use prodero_memory_sync prepare for the next candidate. For its curation job, use the existing prodero_curation_reasoning_prepare/propose protocol, then inspect this Sync workflow. Continue sequentially until a question, review or completion. Never Apply or approve; Core handles eligible Local changes. No session lifecycle or extra scans.':'Use prodero_memory_sync action=prepare, then reason only over that one bundle and submit action=propose with the returned workflow ID/revision. Continue sequentially while semantic_work_required. Never approve review automatically. Do not use session prepare/record/close for this workflow.'}:['awaiting_clarification','awaiting_promotion_selection','awaiting_review'].includes(w.state)?{action:w.state==='awaiting_review'?'human_review_required':w.state,tool:'prodero_sync',arguments:{projectRoot:w.root,workflowId:w.id},instructions:'When an unattached continuation returns this state, present the pending human step before ending the turn: read project presentation settings and invoke prodero_sync with these exact arguments once (use prodero_text for text mode). This reopens the same saved workflow without restarting analysis. After presenting it, stop and wait; do not repeatedly reopen an unchanged step. Never select records, answer questions, approve or publish for the human.'}:{action:w.state},
 };
}
async function workflowView(root:string,w:Workflow,clarification?:Awaited<ReturnType<typeof inspectSyncCuration>>,deferred?:Awaited<ReturnType<typeof deferredQuestions>>){
 const previous=currentJob(w)?.id;
 if(w.state!=='stale')await resumeRevisitedQuestion(root,w);
 if(!previous&&currentJob(w))clarification=await refreshCuration(root,w);
 const snapshot=view(w,clarification,deferred??(w.state!=='stale'?await deferredQuestions(root,w):[]));
 const lineages=new Set<string>(),questions=new Set<string>();let savedAnswerEvents=0,unsupersededAnswerEvents=0;
 let reasoning:NonNullable<Awaited<ReturnType<typeof inspectSyncCuration>>['graphical']>|undefined;
 for(const job of w.jobs.filter(j=>j.selected&&j.curationReviewId)){
  const payload=clarification&&clarification.review?.snapshot.reviewId===job.curationReviewId?clarification:await graphicalReviewPayload(root,await loadCurationReview(root,job.curationReviewId!,{allowExpired:true}));
  const lineage=payload.review!.snapshot.revision!.lineageId;
  if(job.id===currentJob(w)?.id)reasoning=payload.graphical!;
  if(lineages.has(lineage))continue;lineages.add(lineage);
  for(const q of payload.graphical!.questions)if(q.state==='deferred')questions.add(`${lineage}:${q.question.id}`);
  const answers=await curationAnswers(root,lineage);savedAnswerEvents+=answers.length;unsupersededAnswerEvents+=answers.filter(a=>!answers.some(next=>next.replacesAnswerId===a.id)).length;
 }
 const projected={...snapshot,reasoning,questionCounts:{deferred:questions.size,savedAnswerEvents,unsupersededAnswerEvents,coverage:'saved_selected_reviews' as const}};
 return {...projected,operation:memorySyncOperation(projected)};
}
async function refreshCuration(root:string,w:Workflow){
 const j=currentJob(w);if(!w.improveEnabled||!j?.curationReviewId||!['semantic_work','awaiting_clarification'].includes(w.state))return;
 const before=digest(w);
 let payload:Awaited<ReturnType<typeof inspectSyncCuration>>;
 try{payload=await inspectSyncCuration(root,j.curationReviewId);}
 catch(e){j.status='failed';j.error=publicDiagnostic(e).slice(0,1000);await advance(root,w);await save(root,w);return;}
 const g=payload.graphical!;
 j.curationReviewId=payload.review!.snapshot.reviewId;
 j.curationStateHash=digest([j.curationReviewId,payload.review!.state.revision,g.answerLogHash,g.jobs]);
 j.unresolved=payload.projection.unresolvedIssueCount;
 if(g.analysisPending){const answering=g.questions.some(q=>q.state==='answered_pending_analysis');w.state=answering?'awaiting_clarification':'semantic_work';j.status=w.state;if(digest(w)!==before)await save(root,w);return answering?payload:undefined;}
 if(g.activeQuestionCount||g.analysisFailed&&g.questions.some(q=>q.state==='answered_pending_analysis')){w.state='awaiting_clarification';j.status='awaiting_clarification';j.unresolved=payload.projection.unresolvedIssueCount;if(digest(w)!==before)await save(root,w);return payload;}
 if(g.deferredQuestionIds.length||payload.projection.paused){j.status='deferred';j.unresolved=payload.projection.unresolvedIssueCount;await advance(root,w);await save(root,w);return;}
 if(g.analysisFailed){j.status='failed';j.error='Analysis could not finish; saved answers are retained.';await advance(root,w);await save(root,w);return;}
 const typed=payload.review!.snapshot.revision!.typedPlan;
 if(typed.kind!=='semantic-v2')return payload;
 let preview:MemoryTransformationPreview|undefined;
 try{preview=await previewSyncCuration(root,j.id,payload);}
 catch(e){j.status='failed';j.error=publicDiagnostic(e).slice(0,1000);await advance(root,w);await save(root,w);return;}
 if(!preview){j.status='skipped';j.unresolved=payload.projection.unresolvedIssueCount;j.error='Knowledge retained because the available evidence did not support a safe change.';await advance(root,w);await save(root,w);return;}
 if(!preview.localDirectApplyEligible)throw new Error('Curator Sync result is not eligible for automatic Local apply');
 w.active={kind:'transformation',candidateId:j.id,reviewId:preview.previewId,preview,approved:false};
 await beginApply(root,w);
}
async function finishApply(root:string,w:Workflow){
 const a=w.active!;if((a.kind==='promotion'||a.kind==='link-repair')&&!a.approved)throw new Error('This operation requires persisted exact workflow approval');let result:Awaited<ReturnType<typeof applyMemoryTransformation>>|Awaited<ReturnType<typeof applyKnowledgePromotion>>|Awaited<ReturnType<typeof applyMemoryLinkRepair>>;
 if(a.kind==='transformation'){
  const p=a.preview as MemoryTransformationPreview;
  result=await applyMemoryTransformation(root,p,{initiatedByUser:true,reviewedPreviewId:p.previewId,approvedVersioned:a.approved,approvedSemanticLimitations:a.approved});
  w.jobs.find(j=>j.id===a.candidateId)!.status='applied';w.jobs.find(j=>j.id===a.candidateId)!.result=result;
 }else if(a.kind==='link-repair'){result=await applyMemoryLinkRepair(root,a.preview as MemoryLinkRepairPreview,a.approved);w.repairLinksResult={fixed:result.fixed,remaining:result.remaining};w.repairLinksDone=true;
 }else{result=await applyKnowledgePromotion(root,a.preview as PromotionPreview,true);w.promotionResult=result;w.promotionDone=true;}
 // A crash after commit must not silently adopt unrelated external changes on resume.
 const now=await fingerprint(root,result.checkpoint);
 const revisions=a.kind==='transformation'?(a.preview as MemoryTransformationPreview).lifecycle.changes.map(c=>({path:c.to,hash:sha256(c.after)})):(result as Awaited<ReturnType<typeof applyKnowledgePromotion>>|Awaited<ReturnType<typeof applyMemoryLinkRepair>>).revisions;
 const unchanged=now.telemetry===w.baseline.telemetry&&now.checkpoints===w.baseline.checkpoints&&await knowledgeHash(root,a.touchedIds)===a.unaffectedKnowledge;
 const exact=(await Promise.all(revisions.map(async r=>await fileHash(await checkedDataPath(root,r.path))===r.hash))).every(Boolean);
 delete w.active;
 if(!unchanged||!exact){w.state='stale';w.error='Operation committed, but project changed independently. Start a fresh workflow.';}else{w.baseline=await fingerprint(root);await advance(root,w);}
 await save(root,w);
}
async function beginApply(root:string,w:Workflow){
 const a=w.active!;
 a.touchedIds=a.kind==='link-repair'?(a.preview as MemoryLinkRepairPreview).changes.map(c=>c.id):a.kind==='transformation'?(a.preview as MemoryTransformationPreview).lifecycle.changes.map(c=>c.id):(a.preview as PromotionPreview).actions.flatMap(c=>[...c.localIds,...(c.targetId?[c.targetId]:[]),...(c.draft?[c.draft.id]:[])]);
 a.unaffectedKnowledge=await knowledgeHash(root,a.touchedIds);w.state='applying';await save(root,w); // authorization/intention durable BEFORE knowledge journal
 await finishApply(root,w);
}
async function resume(root:string,w:Workflow){
 if(w.state==='applying'){try{await finishApply(root,w);}catch(e){w.error=publicDiagnostic(e).slice(0,1000);if(/stale|changed|mismatch/i.test(w.error)&&!await fileHash(await checkedDataPath(root,'.transactions/pending.json')))w.state='stale';await save(root,w);}return;}
 if(w.state==='stale')return;
 if(digest(await fingerprint(root))!==digest(w.baseline)){w.state='stale';w.error='Knowledge, telemetry or checkpoints changed. Start a fresh workflow; old approvals cannot be reused.';await save(root,w);}
}
export async function runMemorySync(root:string,raw:MemorySyncAction){
 const input=memorySyncActionSchema.parse(raw);
 root=await findProjectRoot(root);
 if(!await readConfig(root))throw new Error('Prodero must be initialized before Curate Memory');
 if(input.action==='start'){
  await requireCurrentProject(root);
  await autoMigrateProject(root);
  // Explicit start recovers observations only when pending; no semantic maintenance on open.
  const existing=await load(root);
  if(existing&&!('restart' in input&&input.restart)&&!['completed','stale'].includes(existing.state))return runMemorySync(root,{action:'inspect',workflowId:existing.id});
  let recovery={sessions:0,created:0};
  await withSyncLock(root,()=>recoverSyncTransaction(root));
  const discovery=await discoverSessions(root,{loadPendingBodies:false});
  if(discovery.sessions.some(s=>s.pending)){const synced=await syncProject(root);recovery={sessions:synced.sessions,created:synced.created};}
  return withSyncLock(root,async()=>{
   const plan=await getMemoryIntelligencePlan(root);
   const w:Workflow={brokenLinks:(await loadKnowledgeGraph(root,undefined,{persistCache:false})).diagnostics.brokenReferences,version:1,id:randomUUID(),root:await fs.realpath(root),revision:0,createdAt:new Date().toISOString(),state:'awaiting_selection',usage:{sessions:plan.coverage.sessions,available:plan.coverage.telemetry==='available'},baseline:await fingerprint(root),jobs:plan.candidates.map(c=>({id:c.id,label:c.label,signals:c.signals,recordCount:c.recordCount,counts:c.counts,categories:c.categories,sourceIds:c.records.map(r=>r.id),layers:c.layers,selected:false,status:'unselected'})),promotionEnabled:false,promotionDone:false,promotionCandidates:[],promotionTotal:0,recovery};
   await promotions(root,w);await save(root,w);return workflowView(root,w);
  });
 }
 return withSyncLock(root,async()=>{
  await recoverSyncTransaction(root);
  const w=await load(root);if(!w)throw new Error('Start Curate Memory first');
  if(input.workflowId&&input.workflowId!==w.id)throw new Error('Curate Memory workflow expired or was replaced');
  const before=w.revision;await resume(root,w);
  if(input.action==='inspect'){
   if(w.state!=='stale')await resumeRevisitedQuestion(root,w);
   const clarification=w.state!=='stale'?await refreshCuration(root,w):undefined;
   // Finishing independent work may make a deliberately reopened question next.
   if(w.state!=='stale')await resumeRevisitedQuestion(root,w);
   return workflowView(root,w,clarification??(w.state!=='stale'?await refreshCuration(root,w):undefined),w.state!=='stale'?await deferredQuestions(root,w):[]);
  }
  if(w.state==='stale')throw new Error(w.error);
  if(w.state==='applying')throw new Error('Approved apply is pending recovery; inspect/resume before another action');
  if(!('revision' in input)||input.revision!==before||w.revision!==before)throw new Error('Stale workflow revision; inspect current workflow');
  delete w.error;
  if(input.action==='select'){
   if(w.state!=='awaiting_selection')throw new Error('Selection is already fixed');
   const modern=input.candidateIds===undefined&&input.reviewPromotion===undefined;
   if(!modern&&(input.improve!==undefined||input.share!==undefined||input.repairLinks!==undefined))throw new Error('Choose operations or legacy candidates, not both');
   const improve=input.improve??true,share=input.share??true,repairLinks=Boolean(w.brokenLinks)&&(input.repairLinks??true);
   if(modern&&!improve&&!share&&!repairLinks)throw new Error('Select Improve memory, Fix broken links or Share knowledge');
   const ids=modern?(improve?w.jobs.map(j=>j.id):[]):input.candidateIds??[];if(new Set(ids).size!==ids.length||ids.some(id=>!w.jobs.some(j=>j.id===id)))throw new Error('Unknown/duplicate candidate selection');
   if(modern){w.improveEnabled=improve;w.repairLinksEnabled=repairLinks;}
   for(const j of w.jobs){j.selected=ids.includes(j.id);j.status=j.selected?'pending':'unselected';}w.promotionEnabled=modern?share:input.reviewPromotion===true;await advance(root,w);
  }else if(input.action==='prepare'){
   const j=currentJob(w);if(w.state!=='semantic_work'||!j||input.candidateId!==j.id)throw new Error('Prepare only the next selected candidate');
   if(w.improveEnabled){
    try{const curation=await prepareSyncCuration(root,j.sourceIds,j.curationReviewId,j.status==='pending'&&!!j.curationReviewId);j.curationReviewId=curation.reviewId;j.status='semantic_work';await save(root,w);return {...await workflowView(root,w),curation};}
    catch(e){j.status='failed';j.error=publicDiagnostic(e).slice(0,1000);await advance(root,w);await save(root,w);return workflowView(root,w);}
   }
   try{const semantic=await prepareMemoryTransformation(root,j.id);if(!semantic.canPropose)throw new Error('Candidate requires splitting or complete evidence');if(semantic.bundle.sourceIds.length!==j.recordCount||semantic.bundle.sourceIds.some(id=>!j.sourceIds.includes(id)))throw new Error('Candidate membership changed');j.status='semantic_work';await save(root,w);return {...await workflowView(root,w),semantic};}catch(e){j.status='failed';j.error=publicDiagnostic(e).slice(0,1000);await advance(root,w);}
  }else if(input.action==='propose'){
   if(w.improveEnabled)throw new Error('Submit this job through Curator reasoning, then inspect Curate Memory');
   const j=currentJob(w);if(w.state!=='semantic_work'||j?.status!=='semantic_work'||input.candidateId!==j.id||!input.proposal)throw new Error('Prepare selected candidate before submitting its proposal');
   try{
    if(input.proposal.candidateId!==j.id)throw new Error('Proposal belongs to another candidate');
    const validated=await validateMemoryTransformationProposal(root,input.proposal);const preview=await previewMemoryTransformation(root,validated);
    j.unresolved=preview.summary.unresolved.length;w.active={kind:'transformation',candidateId:j.id,reviewId:preview.previewId,preview,approved:false};j.status='awaiting_review';w.state='awaiting_review';await save(root,w);
   }catch(e){j.status='failed';j.error=publicDiagnostic(e).slice(0,1000);await advance(root,w);await save(root,w);return workflowView(root,w);}
   if((w.active!.preview as MemoryTransformationPreview).localDirectApplyEligible)await beginApply(root,w);
   return workflowView(root,w);
  }else if(input.action==='approve'){
   if(w.state!=='awaiting_review'||!w.active||input.approved!==true||input.reviewId!==w.active.reviewId)throw new Error('Explicit approval of this exact review is required');w.active.approved=true;await beginApply(root,w);return workflowView(root,w);
  }else if(input.action==='skip'){
   if(w.active?.kind==='link-repair'){delete w.active;w.repairLinksDone=true;await advance(root,w);}else if(w.active?.kind==='promotion'){delete w.active;w.promotionDone=true;await advance(root,w);}else{const j=currentJob(w);if(!j||input.candidateId!==j.id)throw new Error('Skip requires current candidate');j.status='skipped';delete w.active;await advance(root,w);}
  }else if(input.action==='refresh_questions'){
   const j=w.jobs.find(j=>j.id===input.candidateId&&j.selected&&j.status==='deferred'&&j.curationReviewId);
   if(!j||w.active)throw new CurationReviewError('review_changed','Refresh only this saved deferred review after finishing the active exact review.');
   if((await inspectSyncCuration(root,j.curationReviewId!)).review!.snapshot.reviewId!==input.reviewId)throw new CurationReviewError('review_changed','This deferred review changed. Inspect saved progress.');
   const fresh=await refreshSyncQuestions(root,j.sourceIds,input);j.curationReviewId=fresh.review!.snapshot.reviewId;
  }else if(input.action==='retry'){
   if(w.active||w.promotionResult)throw new Error('Finish review before retry, or start a fresh workflow after promotion');const j=w.jobs.find(j=>j.id===input.candidateId&&j.selected&&j.status==='failed');if(!j)throw new Error('Only failed candidates can be retried');j.status='pending';delete j.error;w.state='semantic_work';
  }else if(input.action==='promotions'){
   if(w.state!=='awaiting_promotion_selection'||!w.promotionEnabled)throw new Error('Finish selected transformations before promotion review');
   const ids=input.ids??[];if(!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!w.promotionCandidates.some(c=>c.id===id)))throw new Error('Select specific current Local promotion candidates');
   const preview=await previewKnowledgePromotion(root,{ids});w.active={kind:'promotion',reviewId:preview.previewId,preview,approved:false};w.state='awaiting_review';
  }else if(input.action==='complete'){
   if(!['awaiting_promotion_selection','completed'].includes(w.state))throw new Error('Finish or skip selected transformations first');w.promotionDone=true;w.state='completed';
  }
  await save(root,w);return workflowView(root,w);
 });
}

/** Open-only diagnostic projection. Never resumes, recovers, migrates or persists a workflow. */
export async function getMemorySyncOverview(root:string) {
 const workflow=await load(root);
 const pending=workflow&&workflow.state!=='completed'?workflow:null;
 const stale=pending&&(pending.state==='stale'||pending.state!=='applying'&&digest(await fingerprint(root))!==digest(pending.baseline));
 const workflowStatus=pending?{id:pending.id,state:stale?'stale':pending.state}:null;
 try {
  const plan=await getMemoryIntelligencePlan(root);
  return {available:plan.coverage.telemetry!=='unavailable',sessions:plan.coverage.sessions,
   areas:plan.candidates.map(c=>({id:c.id,label:c.label,recordCount:c.recordCount,signals:c.signals,counts:c.counts,layers:c.layers,categories:c.categories})),
   areasOmitted:plan.truncated.candidates,workflow:workflowStatus};
 } catch { return {available:false,sessions:0,areas:[],areasOmitted:0,workflow:workflowStatus}; }
}

/** Resolve continuation ownership from persisted review lineage, not a particular App instance. */
export async function syncWorkflowForCuration(root:string,lineageId:string) {
 const w=await load(root);
 if(!w||!w.improveEnabled||w.state==='stale')return undefined;
 for(const job of w.jobs.filter(j=>j.selected&&j.curationReviewId&&['pending','semantic_work','awaiting_clarification','deferred'].includes(j.status))){
  const review=await loadCurationReview(root,job.curationReviewId!,{allowExpired:true});
  if(review.snapshot.revision?.lineageId===lineageId)return w.id;
 }
 return undefined;
}

/** Internal adapter ownership check under the common writer lock. A review ID
 * from another workflow/candidate never grants conversational access. */
export async function syncCurationReview(root:string,workflowId:string,candidateId:string,reviewId:string){
 const w=await load(root),job=w?.jobs.find(j=>j.id===candidateId&&j.selected&&j.curationReviewId&&['pending','semantic_work','awaiting_clarification','deferred','failed'].includes(j.status));
 if(!w||w.id!==workflowId||!w.improveEnabled||!job||w.state==='stale')throw new CurationReviewError('review_changed','This question is not part of the current Sync workflow. Inspect saved progress.');
 if(digest(await fingerprint(root))!==digest(w.baseline))throw new CurationReviewError('semantic_stale','Knowledge or evidence changed. Inspect the current workflow.');
 const payload=await inspectSyncCuration(root,job.curationReviewId!);
 if(payload.review!.snapshot.reviewId!==reviewId)throw new CurationReviewError('review_changed','This review changed. Inspect saved progress.');
 return payload;
}
