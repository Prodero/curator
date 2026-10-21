/** App review is a workflow safeguard, not authentication of human consent.
 * The adapter validates the saved review before issuing an exact Core grant;
 * MCP Apps visibility/capability does not authenticate a physical user action.
 * Future interactive text confirmation can call this same executor after its own
 * protocol response; the public text gateway must never dispatch here directly. */
import { assertSafeCurationData } from './core/curation-evidence.js';
import { withSyncLock, recoverSyncTransaction } from './core/sync-transaction.js';
import { listCheckpoints } from './core/storage.js';
import { buildIndex } from './core/index.js';
import { planKnowledgeCuration, curationReviewEntries, applyKnowledgeCuration, StaleCurationPlanError, type CurationReceipt } from './core/knowledge-curation.js';
import { withTrustedKnowledgeBatch } from './core/knowledge-authority.js';
import { curationReceiptProjection, curationReviewView, assertCurationHead, ensureCurationSuccessor, validateRevisionReceipt, reserveSuccessorCapacity, loadCurationReview, selectedCurationProposals, curationOperationId, CurationReviewError, type CurationApplyRequest } from './core/curation-review.js';
import { validateRevision, deterministicBaseline, curationSelectionHash, selectionProblems, revisionHash } from './core/curation-revision.js';
import { semanticReviewStatus } from './core/curation-semantic-jobs.js';
import path from 'node:path';
import fs from 'node:fs/promises';
export async function executeCurationReview(root:string,input:CurationApplyRequest){
  const selected=[...input.selectedIds].sort();
  if(!/^review_[a-zA-Z0-9_]+$/.test(input.reviewId)||!selected.length||new Set(selected).size!==selected.length)throw new CurationReviewError('invalid_selection','Select a valid, non-empty set of suggestions.');
  const operationId=curationOperationId(input.reviewId,selected,input.reviewRevisionId,input.selectionHash);
  return withSyncLock(root,async()=>{
    await recoverSyncTransaction(root);
    const history=await listCheckpoints(root);
    const prior=history.find(c=>(c as any).curation?.review?.operationId===operationId);
    const result=(receipt:CurationReceipt,checkpointId:string,replayed:boolean)=>({status:'applied' as const,...receipt,checkpointId,appliedGroupCount:receipt.reviewSnapshot?.units.filter(u=>u.proposalIds.every(id=>receipt.applied.includes(id))).length??receipt.applied.length,historyPath:path.join(path.resolve(root),'.prodero','checkpoints',`${checkpointId}.json`),replayed});
    if(prior){
      const stored=(prior as any).curation;
      assertSafeCurationData(stored);
      if(stored.plan.project!==path.resolve(root)||stored.review.planHash!==input.planHash||stored.review.projectIdentity!==await fs.realpath(root))throw new CurationReviewError('review_changed','This request does not match the completed review.');
      if(stored.review.reviewRevisionId){
        validateRevisionReceipt(stored.review);
        if(input.reviewRevisionId!==stored.review.reviewRevisionId||input.decisionRevision!==stored.review.decisionRevision||input.selectionHash!==stored.review.selectionHash||JSON.stringify(selected)!==JSON.stringify(stored.review.selectedIds))throw new CurationReviewError('review_changed','This request does not match the completed revision.');
      }
      await buildIndex(root);
      const successor=await ensureCurationSuccessor(root,stored.review);
      return {...result(stored.review,prior.id,true),successor,projection:successor?(await curationReviewView(root,successor.snapshot.plan,successor)).projection:curationReceiptProjection(stored.plan,stored.review)};
    }
    const review=await loadCurationReview(root,input.reviewId);
    if(review.snapshot.plan.memorySyncSources)throw new CurationReviewError('invalid_selection','Sync analysis is read-only; continue its owning Curate Memory operation.');
    if(review.snapshot.planHash!==input.planHash)throw new CurationReviewError('stale_review','Knowledge changed since this review.');
    if(review.state.revision!==input.decisionRevision)throw new CurationReviewError('review_changed','Your review changed in another window. Reload your decisions.');
    const revision=review.snapshot.revision;
    if(revision){
      validateRevision(revision);
      if(input.reviewRevisionId!==revision.id)throw new CurationReviewError('stale_review','Apply requires the exact review revision.');
      if(input.selectionHash!==curationSelectionHash(revision.id,input.decisionRevision,selected))throw new CurationReviewError('invalid_selection','Apply selection hash changed.');
      if(history.some(c=>(c as any).curation?.review?.reviewRevisionId===revision.id))throw new CurationReviewError('stale_review','This revision was applied. Review its successor.');
    }else if(input.reviewRevisionId||input.selectionHash)throw new CurationReviewError('invalid_review','Legacy review has no revision binding.');
    if(revision)await assertCurationHead(root,review);
    const derived=selectedCurationProposals(review);
    if(revision?selected.some(id=>!derived.includes(id)):JSON.stringify(derived)!==JSON.stringify(selected))throw new CurationReviewError('invalid_selection','Apply must match your saved review decisions.');
    if(revision){const problems=selectionProblems(revision.dependencies,selected);if(problems.length)throw new CurationReviewError('dependency_blocked','Selected changes require unresolved information or additional reviewed groups.',{problems});}
    if(revision){const semantic=await semanticReviewStatus(root,review);if(revision.dependencies.groups.some(g=>semantic.blockedGroupIds.includes(g.id)&&g.proposalIds.some(id=>selected.includes(id))))throw new CurationReviewError('dependency_blocked','Selected changes await semantic analysis or updated answers.');}
    // Validate selection, including dependency closure, independently of the UI.
    const entries=curationReviewEntries(review.snapshot.plan,selected,revision);
    const current=await planKnowledgeCuration(root).catch(()=>{throw new CurationReviewError('stale_review','Knowledge can no longer be validated against this review. Review updated changes.');});
    if(current.planId!==(revision?deterministicBaseline(revision).planId:review.snapshot.planHash)||current.fingerprint!==review.snapshot.plan.fingerprint)throw new CurationReviewError('stale_review','Knowledge changed since this review.');
    if(revision)await reserveSuccessorCapacity(root);
    const receipt:CurationReceipt={...(revision?{reviewRevisionId:revision.id,selectionHash:input.selectionHash,reviewSnapshot:review.snapshot,reviewState:review.state,executionHash:revisionHash([review.snapshot.snapshotHash,review.state,selected])}:{}),projectIdentity:review.snapshot.projectIdentity,decisions:review.state.decisions,reviewId:input.reviewId,planHash:input.planHash,operationId,decisionRevision:input.decisionRevision,selectedIds:selected,applied:selected,unselected:review.snapshot.plan.proposals.filter(p=>!selected.includes(p.id)&&!p.attention.length).map(p=>p.id),unresolved:review.snapshot.plan.proposals.filter(p=>p.attention.length).map(p=>p.id)};
    const applied=await withTrustedKnowledgeBatch(root,entries,`app-review:${operationId}`,()=>applyKnowledgeCuration(root,review.snapshot.plan,selected,receipt)).catch(error=>{
      if(error instanceof StaleCurationPlanError)throw new CurationReviewError('stale_review','Knowledge changed since this review.');
      throw error;
    });
    const successor=await ensureCurationSuccessor(root,receipt);
    return {...result(receipt,applied.checkpoint,false),successor,projection:successor?(await curationReviewView(root,successor.snapshot.plan,successor)).projection:curationReceiptProjection(review.snapshot.plan,receipt)};
  },{waitMs:2000});
}
