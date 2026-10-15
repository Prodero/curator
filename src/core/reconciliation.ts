import { exactKnowledge, evidenceSentences } from './semantic-safety.js';
import { intelligenceTelemetry, INTELLIGENCE_LIMITS, reconcileSchema, requestIntelligence, type IntelligenceProvider, type IntelligenceTelemetry, type KnowledgeCandidate, type ProposedAction, type ReconciliationCategory } from './intelligence.js';
import { estimateTokens } from './telemetry.js';
import type { KnowledgeItem } from './types.js';

type Evidence = Pick<KnowledgeCandidate, 'content' | 'supersedes'>;
/** Offline classification uses proof, not polarity, titles, dates or token overlap. */
export function deterministicClassification(candidate: Evidence, old: KnowledgeItem): ReconciliationCategory {
  if (candidate.supersedes.includes(old.id)) return 'state_transition';
  if (exactKnowledge(candidate.content) === exactKnowledge(old.content)) return 'duplicate';
  const incoming = evidenceSentences(candidate.content), previous = evidenceSentences(old.content);
  if (incoming.every(s => previous.includes(s))) return 'supporting';
  if (previous.every(s => incoming.includes(s))) return 'refinement';
  return 'unresolved';
}

/** Legacy actions remain readable; uncertainty alone never establishes incompatibility. */
export function actionClassification(action: ProposedAction): ReconciliationCategory {
  return action.classification ?? ({SUPERSEDE:'state_transition', MERGE:'refinement', NO_CHANGE:'supporting', CONFLICT:'potential_conflict', UNCERTAIN:'unresolved', LINK:'independent', CREATE:'independent'} as const)[action.action];
}
export function normalizeReconciliation(action: ProposedAction, hasCandidate = true): ProposedAction {
  const classification = actionClassification(action);
  if (classification === 'potential_conflict' && action.sources.length < 2) throw new Error('Potential conflict requires incompatible evidence.');
  if (action.action === 'SUPERSEDE' && classification !== 'state_transition') throw new Error('Supersession requires state_transition classification.');
  if (action.action === 'NO_CHANGE' && !['duplicate','supporting'].includes(classification)) throw new Error('No change requires duplicate or supporting evidence.');
  if (classification === 'potential_conflict' && !['CONFLICT','UNCERTAIN'].includes(action.action)) throw new Error('Potential conflict requires a conflict action.');
  if (['CONFLICT','UNCERTAIN'].includes(action.action) && classification !== 'potential_conflict') {
    return {...action, classification, action:!hasCandidate || action.sources.length > 1 ? 'LINK' : 'CREATE', canonical:null};
  }
  return {...action, classification};
}

/** Both session review and consolidation use this bounded semantic reconciliation path. */
export async function reconcileCandidate(candidate: KnowledgeCandidate, related: KnowledgeItem[], provider: IntelligenceProvider, telemetry: IntelligenceTelemetry = intelligenceTelemetry(provider)): Promise<ProposedAction> {
  const bounded: KnowledgeItem[] = [];
  for (const old of related.slice(0, INTELLIGENCE_LIMITS.relatedMemories)) {
    if (estimateTokens(JSON.stringify({candidate,related:[...bounded,old]})) <= INTELLIGENCE_LIMITS.reconcileInputTokens) bounded.push(old);
  }
  const action = reconcileSchema.parse(await requestIntelligence(provider,'reconcile',{candidate,related:bounded},telemetry)).actions[0];
  const allowed = new Set([candidate.id,...bounded.map(m=>m.id)]);
  if (!action.sources.includes(candidate.id) || new Set(action.sources).size !== action.sources.length || action.sources.some(id=>!allowed.has(id))) throw new Error('Invalid reconciliation sources: unknown, duplicate or out-of-area ID.');
  return normalizeReconciliation(action);
}

export function reconciliationSignal(kind: ReconciliationCategory, memory?: Pick<KnowledgeItem,'id'|'title'|'content'>) {
  const detail = {
    state_transition:'Knowledge evolution detected — newer evidence updates earlier project state.',
    refinement:'Knowledge refined — newer evidence adds detail to earlier knowledge.',
    duplicate:'Already covered by existing knowledge.',
    supporting:'Supporting evidence confirms earlier knowledge.',
    potential_conflict:'Potential conflict — incompatible claims need review to determine the current state.',
    unresolved:'Related evidence will be reconciled during consolidation.',
    independent:'Related knowledge provides additional context.',
  }[kind];
  return {kind,detail,severity:kind==='potential_conflict'?'warning' as const:'info' as const,requiresReview:kind==='potential_conflict',...(memory?{memory:{id:memory.id,title:memory.title,content:memory.content}}:{})};
}
