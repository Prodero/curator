import { deriveDependencies, selectionProblems, curationSelectionHash, revisionIssues, type ReviewRevision } from './curation-revision.js';
import { z } from 'zod';
import type { CurationPlan } from './knowledge-curation.js';

export type AnalysisOutcome = 'unchanged' | 'proposed' | 'unresolved';
export type ReviewDisposition = 'included' | 'keep_current' | 'deferred';
export const clarificationStateSchema = z.enum(['open', 'answered_pending_analysis', 'resolved', 'deferred', 'superseded']);
export type ClarificationState = z.infer<typeof clarificationStateSchema>;
export type ReviewExecution = 'not_applied' | 'applied';
export type ReviewLifecycle = 'analyzing' | 'awaiting_input' | 'ready' | 'partially_ready' | 'paused' | 'partially_applied' | 'completed' | 'stale' | 'analysis_failed';
export type ReviewDecision = 'current' | 'suggested' | 'deferred';
export interface ReviewUnit { id: string; proposalIds: string[]; applicable: boolean; attention: boolean; }
export interface ReviewIssue {
  id: string; basisHash: string; sourceIds: string[];
  state: ClarificationState;
}
export interface ReviewItemState {
  outcome: AnalysisOutcome;
  disposition: ReviewDisposition | null;
  execution: ReviewExecution;
  issue?: ReviewIssue;
}
export interface ReviewState {
  revision: number; snapshotHash: string;
  /** Compatibility selection only. No default or inherited Suggested decisions. */
  decisions: Record<string, ReviewDecision>;
  items: Record<string, ReviewItemState>;
  paused: boolean;
  analysis: 'complete' | 'pending' | 'failed';
}
export function analysisOutcome(plan: CurationPlan, unit: ReviewUnit): AnalysisOutcome {
  const proposals = unit.proposalIds.map(id => plan.proposals.find(p => p.id === id)!);
  if (unit.attention || proposals.some(p => p.outputs.some(o => o.applicability?.kind === 'unresolved'))) return 'unresolved';
  return unit.applicable ? 'proposed' : 'unchanged';
}

/** The one attention/count/lifecycle policy. UI and text render this result verbatim. */
export function projectCurationReview(plan: CurationPlan, units: ReviewUnit[], state: ReviewState, options: { stale?: boolean; legacy?: boolean; semantic?:{pending:number;failed:number;jobIds:string[];blockedGroupIds:string[];answeredIssueIds?:string[]}; revision?: ReviewRevision } = {}) {
  const dependencies=options.legacy?undefined:options.revision?.dependencies??deriveDependencies(plan,units);
  const consumed=!!options.revision&&Object.values(state.items).some(i=>i.execution==='applied');
  const semanticIssues=revisionIssues(options.revision);
  const items = units.map(unit => {
    const persisted = state.items[unit.id];
    const answerPending=semanticIssues.some(issue=>options.semantic?.answeredIssueIds?.includes(issue.id)&&unit.proposalIds.some(id=>issue.sourceIds.includes(id)));
    const item=answerPending&&persisted.issue?{...persisted,issue:{...persisted.issue,state:'answered_pending_analysis' as const}}:persisted;
    const needsInput = item.outcome === 'unresolved' && item.issue?.state === 'open' && item.disposition !== 'keep_current' && item.disposition !== 'deferred' && item.execution !== 'applied';
    const dependency=dependencies?.groups.find(g=>g.id===unit.id)!;
    const blocked=!!options.semantic?.blockedGroupIds.includes(unit.id)||!!dependency&&(dependency.blockedByIssueIds.length>0||dependency.incomplete.length>0||dependency.requires.some(id=>['keep_current','deferred'].includes(state.items[id]?.disposition??'')));
    const ready = !consumed && !options.semantic?.blockedGroupIds.includes(unit.id) && !blocked && item.outcome === 'proposed' && item.disposition !== 'keep_current' && item.disposition !== 'deferred' && item.execution !== 'applied';
    return { ...unit, ...item, blocked: item.outcome==='proposed'&&blocked, blockedReason:blocked?'Depends on unresolved information or incomplete evidence.':null, needsInput: needsInput && !state.paused, ready: ready && !state.paused && !options.stale,
      pendingDecision: item.execution !== 'applied' && item.outcome === 'proposed' && item.disposition === null };
  });
  const count = (predicate: (item: typeof items[number]) => boolean) => items.filter(predicate).length;
  const analyzedSourceCount = options.revision?.analyzedSourceIds.length??new Set(plan.proposals.map(p => p.sourceId)).size;
  const unchanged = plan.proposals.filter(p => !p.changes.length && !p.attention.length && !p.outputs.some(o => o.applicability?.kind === 'unresolved')).length;
  let needsInputNow = count(i => i.needsInput);
  let deferredQuestions = count(i => i.outcome === 'unresolved' && i.issue?.state === 'deferred');
  const deferredChanges = count(i => i.outcome === 'proposed' && i.disposition === 'deferred');
  const keptCurrent = count(i => i.disposition === 'keep_current');
  const proposed = count(i => i.outcome === 'proposed');
  const readyChangeGroups = count(i => i.ready);
  const applied = count(i => i.execution === 'applied') + (options.revision?.appliedHistory.length??0);
  const semanticAnalysisPending=options.semantic?.pending??0,semanticAnalysisFailed=options.semantic?.failed??0;
  const clarificationCandidates=semanticIssues.map(issue=>{
    const affected=items.filter(i=>i.proposalIds.some(id=>issue.sourceIds.includes(id)));
    const kept=affected.length>0&&affected.every(i=>i.disposition==='keep_current');
    const deferred=!kept&&affected.length>0&&affected.every(i=>i.issue?.state==='deferred'||i.disposition==='keep_current');
    const questionState:ClarificationState=options.semantic?.answeredIssueIds?.includes(issue.id)?'answered_pending_analysis':deferred?'deferred':'open';
    return {...issue,state:questionState,disposition:kept?'keep_current' as const:deferred?'deferred' as const:null,needsInput:!state.paused&&!kept&&questionState==='open'};
  });
  if(semanticIssues.length){
    const uncovered=items.filter(i=>!semanticIssues.some(issue=>i.proposalIds.some(id=>issue.sourceIds.includes(id))));
    needsInputNow=clarificationCandidates.filter(i=>i.needsInput).length+uncovered.filter(i=>i.needsInput).length;
    deferredQuestions=clarificationCandidates.filter(i=>i.state==='deferred').length+uncovered.filter(i=>i.issue?.state==='deferred').length;
  }
  const analysisPending = (state.analysis === 'pending' ? 1 : count(i => i.issue?.state === 'answered_pending_analysis'&&!options.semantic?.answeredIssueIds?.length))+semanticAnalysisPending;
  const analysisFailed = (state.analysis === 'failed' ? 1 : 0)+semanticAnalysisFailed;
  const selectedIds = items.filter(i => i.ready && i.disposition === 'included').flatMap(i => i.proposalIds).sort();
  const selectionIssues=dependencies?selectionProblems(dependencies,selectedIds):[];
  const included = count(i => i.ready && i.disposition === 'included');
  const outstanding = count(i => i.execution !== 'applied' && i.outcome !== 'unchanged');
  const lifecycle: ReviewLifecycle = options.stale ? 'stale' : state.paused ? 'paused' : analysisFailed ? 'analysis_failed' : analysisPending ? 'analyzing' : applied ? (outstanding ? 'partially_applied' : 'completed') : needsInputNow ? (readyChangeGroups ? 'partially_ready' : 'awaiting_input') : readyChangeGroups ? 'ready' : count(i=>i.blocked) ? 'awaiting_input' : deferredQuestions || deferredChanges ? 'ready' : 'completed';
  return { version: 1 as const, semanticAnalysisPending,semanticAnalysisFailed,clarificationCandidates,semanticProposalsReady:options.revision?.typedPlan.kind==='semantic-v2'?items.filter(i=>i.ready&&plan.proposals.some(p=>i.proposalIds.includes(p.id)&&p.changes.includes('semantic-candidate'))).length:0,additionalEvidenceRequired:options.revision?.typedPlan.kind==='semantic-v2'?options.revision.typedPlan.analyses.flatMap((a,index,all)=>a.proposal.additionalEvidenceRequired.filter(missing=>!all.slice(index+1).some(next=>missing.sourceIds.some(id=>next.bundle.expectedSources.some(s=>s.id===id))))):[],semanticValidation:options.revision?.typedPlan.kind==='semantic-v2'?'structurally_validated_candidate' as const:undefined,unresolvedIssueCount:clarificationCandidates.length+items.filter(i=>i.outcome==='unresolved'&&!semanticIssues.some(issue=>i.proposalIds.some(id=>issue.sourceIds.includes(id)))).length, reviewRevisionId:options.revision?.id, parentRevisionId:options.revision?.parentRevisionId, lineageId:options.revision?.lineageId, selectionHash:options.revision?curationSelectionHash(options.revision.id,state.revision,selectedIds):undefined, blockedGroups:count(i=>i.blocked), selectionIssues, analyzedSourceCount, unchanged, proposed, readyChangeGroups, needsInputNow, deferredQuestions, keptCurrent, deferredChanges, analysisPending, analysisFailed, applied, included,
    pendingDecisions: count(i => i.pendingDecision), unresolved: count(i => i.outcome === 'unresolved'),
    paused: state.paused, lifecycle, selectedIds, canApply: selectedIds.length > 0 && state.analysis==='complete' && !selectionIssues.length,
    attentionUnitIds: items.filter(i => i.needsInput).map(i => i.id), items };
}
export type CurationReviewProjection = ReturnType<typeof projectCurationReview>;
export { renderReviewProjection } from './curation-review-presentation.js';
