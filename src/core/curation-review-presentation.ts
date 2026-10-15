/** Browser-safe wording over the server-owned projection; no state derivation. */
import type { CurationReviewProjection } from './curation-review-state.js';

export function renderReviewProjection(p: CurationReviewProjection): string {
  return `${p.analyzedSourceCount} knowledge items · ${p.readyChangeGroups} proposed change groups · ${p.needsInputNow} need your input · ${p.deferredQuestions} deferred questions · ${p.deferredChanges} deferred changes · ${p.unchanged} unchanged${p.blockedGroups ? ` · ${p.blockedGroups} blocked change groups` : ''}${p.applied ? ` · ${p.applied} applied` : ''}${p.semanticAnalysisPending ? ` · ${p.semanticAnalysisPending} semantic analysis pending` : ''}${p.semanticAnalysisFailed ? ` · ${p.semanticAnalysisFailed} semantic analysis failed` : ''}${p.semanticProposalsReady ? ` · ${p.semanticProposalsReady} staged semantic candidates (structural validation only)` : ''}${p.additionalEvidenceRequired?.length ? ' · Additional evidence required' : ''}${p.paused ? ' · Review paused' : ''}`;
}
