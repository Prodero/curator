import type { KnowledgeItem } from './types.js';

export const CONTEXT_POLICIES = ['required', 'relevant'] as const;
export type ContextPolicy = typeof CONTEXT_POLICIES[number];
export const KNOWLEDGE_AUTHORITIES = ['legacy_inherited', 'inferred', 'imported', 'explicit_user', 'reviewed'] as const;
export type KnowledgeAuthority = typeof KNOWLEDGE_AUTHORITIES[number];

/** Classification is not proof of user intent. Evidence remains in the existing
 * evidence/sourceSessions/derivedFrom fields. No Phase 1A writer grants stronger
 * authority merely on an agent's assertion or on publication approval. */
export function validateKnowledgePolicy(category: string, policy: unknown, authority: unknown): void {
  if (!(CONTEXT_POLICIES as readonly unknown[]).includes(policy)) throw new Error('Invalid canonical knowledge contextPolicy');
  if (!(KNOWLEDGE_AUTHORITIES as readonly unknown[]).includes(authority)) throw new Error('Invalid canonical knowledge authority');
  if (policy === 'required' && category !== 'instruction') throw new Error('Required contextPolicy is supported only for instruction records in Knowledge Schema v2');
}

/** Strict canonical v2/v3 policy plus a v1/trusted-draft compatibility adapter.
 * Inference writers explicitly use inferredKnowledge and the transaction gate;
 * unversioned draft defaults are not authorization to create mandatory knowledge. */
export function knowledgePolicy(item: Pick<KnowledgeItem, 'category' | 'version' | 'contextPolicy' | 'authority'>) {
  const contextPolicy = (item.version ?? 0) >= 2 ? item.contextPolicy : item.contextPolicy ?? (item.category === 'instruction' ? 'required' : 'relevant');
  const authority = (item.version ?? 0) >= 2 ? item.authority : item.authority ?? (item.version === 1 ? 'legacy_inherited' : 'inferred');
  validateKnowledgePolicy(item.category, contextPolicy, authority);
  return { version: item.version === 3 ? 3 as const : 2 as const, contextPolicy: contextPolicy as ContextPolicy, authority: authority as KnowledgeAuthority,
    ...(item.category === 'instruction' ? {kind:'instruction' as const,enforcement:contextPolicy as ContextPolicy} : {}) };
}

/** Preserve policy when editing/replacing canonical sources of the same category.
 * Ambiguous source policies need a separate reviewed operation, not a guessed default. */
export function inheritKnowledgePolicy(item: KnowledgeItem, sources: KnowledgeItem[]): void {
  const matching = sources.filter(source => source.category === item.category);
  if (!matching.length) return;
  const policies = matching.map(knowledgePolicy);
  if (new Set(policies.map(p => p.contextPolicy)).size !== 1) { Object.assign(item, knowledgePolicy({...item,version:item.version===3?3:2,contextPolicy:'relevant',authority:'inferred'})); return; }
  const authority = new Set(policies.map(p => p.authority)).size === 1 ? policies[0].authority : 'inferred';
  Object.assign(item, knowledgePolicy({...item, version: item.version===3?3:2, contextPolicy: policies[0].contextPolicy, authority}));
}
