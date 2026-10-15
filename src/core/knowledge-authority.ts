import { sameApplicability, applicabilityKey, narrowsApplicability, applicabilityOf, withApplicability, type Applicability } from "./applicability.js";
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { knowledgePolicy } from './knowledge-policy.js';
import { evidenceSentences } from './semantic-safety.js';
import type { KnowledgeItem } from './types.js';
export type PolicyDecision = 'allowed' | 'allowed_with_safe_fallback' | 'review_recommended' | 'review_required' | 'forbidden';
export interface KnowledgeTransition {
    decision: PolicyDecision;
    item: KnowledgeItem;
    reasons: string[];
    blocking: boolean;
}
export interface CurrentUserRule {
    /** Supplied by a trusted host adapter, never by tool arguments or model evidence. */
    turnId: string;
    userText: string;
    mandatory: true;
    content: string;
    scope: 'global' | 'project' | 'path';
    path?: string;
    importance?: KnowledgeItem['priority'];
    applicability?:Applicability;
}
interface Authorization {
    active: boolean;
    root: string;
    proposed: KnowledgeItem;
    evidence: string;
    authority: 'explicit_user' | 'reviewed';
    before?: string;
}
const authorityContext = new AsyncLocalStorage<Authorization>();
const shape = (i: KnowledgeItem) => JSON.stringify([i.category, i.scope, i.scopeRef, i.scopeKind, i.priority, i.content, applicabilityKey(i)]);
/** Internal application capability, not an MCP input or persisted permission.
 * Entry points bind either host-attested intent or the explicit chat-rule command;
 * the latter is model-mediated and retains distinct provenance.
 * Scope is invocation-local; neither serialized evidence nor authority is a capability. */
export async function withTrustedKnowledgeIntent<T>(root: string, proposed: KnowledgeItem, proof: {
    authority: 'explicit_user' | 'reviewed';
    evidence: string;
    before?: KnowledgeItem;
}, operation: () => Promise<T>): Promise<T> {
    if (!proof.evidence.trim())
        throw new Error('Trusted policy intent requires an auditable source reference');
    const grant: Authorization = { active: true, root: path.resolve(root), proposed: structuredClone(proposed), evidence: proof.evidence, authority: proof.authority, before: proof.before ? JSON.stringify(proof.before) : undefined };
    try {
        return await authorityContext.run(grant, operation);
    }
    finally {
        grant.active = false;
    }
}
export const protectedKnowledge = (i: KnowledgeItem) => i.contextPolicy === 'required' || i.priority === 'critical' || ['explicit_user', 'reviewed'].includes(i.authority ?? '');
const sameScope = (a: KnowledgeItem, b: KnowledgeItem) => sameApplicability(a,b);
/** Conservative proof: whole clauses, including order, must survive exactly. No
 * semantic equivalence is inferred from an LLM assertion or bag of words. */
export const sameProtection = (a: KnowledgeItem, b: KnowledgeItem) => a.category === b.category && sameScope(a, b) && a.priority === b.priority && a.contextPolicy === b.contextPolicy && a.authority === b.authority && JSON.stringify(evidenceSentences(a.content)) === JSON.stringify(evidenceSentences(b.content));
const samePolicyBoundary = (a: KnowledgeItem, b: KnowledgeItem) => a.category === b.category && sameScope(a, b) && a.priority === b.priority && a.contextPolicy === b.contextPolicy && a.authority === b.authority;
function clausesCovered(before: string, after: string): boolean {
    const output = evidenceSentences(after);
    let cursor = 0;
    return evidenceSentences(before).every(clause => { const index = output.indexOf(clause, cursor); cursor = index + 1; return index >= 0; });
}
export const coversProtection = (before: KnowledgeItem, after: KnowledgeItem) => samePolicyBoundary(before, after) && clausesCovered(before.content, after.content);
function equivalentSources(proposed: KnowledgeItem, sources: KnowledgeItem[]): boolean {
    if (!sources.length || !sources.every(s => samePolicyBoundary(s, proposed)))
        return false;
    const clauses = new Set(sources.flatMap(s => evidenceSentences(s.content))), out = new Set(evidenceSentences(proposed.content));
    return clauses.size === out.size && [...clauses].every(c => out.has(c)) && sources.every(s => clausesCovered(s.content, proposed.content));
}
export function inferredKnowledge(item: KnowledgeItem, origin: 'inferred' | 'imported' = 'inferred'): KnowledgeItem {
    return { ...item, ...knowledgePolicy({ ...item, version: item.version===3?3:2, contextPolicy: 'relevant', authority: origin }) };
}
/** The single semantic authorization boundary, shared by every canonical transaction. */
export function evaluateKnowledgeTransition(root: string, proposed: KnowledgeItem, before?: KnowledgeItem, options: {
    exact?: boolean;
    sources?: KnowledgeItem[];
    retirementCovered?: boolean;
    replacementRequested?: boolean;
} = {}): KnowledgeTransition {
    try {
        knowledgePolicy(proposed);
    }
    catch {
        return { decision: 'forbidden', item: before ?? proposed, reasons: ['invalid-policy-combination'], blocking: true };
    }
    if(reviewedBatchAllows(root,proposed,before)) return {decision:"allowed",item:proposed,reasons:["trusted-current-operation"],blocking:false};
    const grant = authorityContext.getStore();
    if (grant?.active && grant.proposed.status === proposed.status && grant.root === path.resolve(root) && shape(grant.proposed) === shape(proposed) && (!grant.before || grant.before === JSON.stringify(before) || (!before && options.sources?.some(s => JSON.stringify(s) === grant.before)))) {
        const item = { ...proposed, ...knowledgePolicy({ ...proposed, version: proposed.version===3?3:2, contextPolicy: grant.proposed.contextPolicy, authority: grant.authority }), evidence: [...(proposed.evidence ?? []), { kind: 'user_instruction' as const, ref: grant.evidence }] };
        return { decision: 'allowed', item, reasons: ['trusted-current-operation'], blocking: false };
    }
    if (!before) {
        // Publication and equivalent replacement retain existing policy, never gain it.
        const source = options.sources?.find(s => sameProtection(s, proposed));
        if ((source && source.status === proposed.status) || (proposed.status === 'active' && equivalentSources(proposed, (options.sources ?? []).filter(s => s.status === 'active'))))
            return { decision: 'allowed', item: proposed, reasons: ['existing-policy-preserved'], blocking: false };
        const item = inferredKnowledge(proposed, proposed.authority === 'imported' ? 'imported' : 'inferred');
        if (item.priority === 'critical')
            item.priority = 'important';
        const sources = options.sources ?? [];
        // Never union incomparable source boundaries. A useful inferred fork can
        // keep the first source boundary; uncovered originals remain active.
        if(sources.length && !sources.some(s=>sameScope(item,s))) {
            item.scope=sources[0].scope;item.scopeRef=sources[0].scopeRef;item.scopeKind=sources[0].scopeKind;
            Object.assign(item,withApplicability(item,applicabilityOf(sources[0])));
        }
        const changed = item.contextPolicy !== proposed.contextPolicy || item.authority !== proposed.authority || item.priority !== proposed.priority || !sameScope(item, proposed);
        return { decision: changed ? (options.exact ? 'review_required' : 'allowed_with_safe_fallback') : 'allowed', item, reasons: changed ? ['unverified-promotion-saved-as-relevant'] : [], blocking: changed && !!options.exact };
    }
    const reasons: string[] = [];
    if(options.replacementRequested && before.status!==proposed.status && !options.retirementCovered) reasons.push("replacement-does-not-cover-source");
    if (before.contextPolicy !== proposed.contextPolicy)
        reasons.push('delivery-policy-change');
    if (before.authority !== proposed.authority)
        reasons.push('authority-change');
    if (proposed.priority === 'critical' && before.priority !== 'critical')
        reasons.push('criticality-increase');
    if (protectedKnowledge(before)) {
        if (!sameScope(before, proposed))
            reasons.push('protected-applicability-change');
        if (before.priority !== proposed.priority)
            reasons.push('protected-priority-change');
        if ((before.category !== proposed.category || JSON.stringify(evidenceSentences(before.content)) !== JSON.stringify(evidenceSentences(proposed.content))) && !equivalentSources(proposed, options.sources ?? [before]))
            reasons.push('protected-meaning-change');
        if ((proposed.relations ?? []).some(r => ['superseded_by', 'consolidated_into', 'contradicts'].includes(r.type) && !(before.relations ?? []).some(old => old.type === r.type && old.target === r.target)))
            reasons.push('protected-topology-change');
        if (before.status !== proposed.status && !options.retirementCovered)
            reasons.push('protected-retirement');
    }
    // Ordinary inference may refine relevant knowledge but cannot broaden its scope.
    if (!sameScope(before, proposed) && !(before.contextPolicy==='relevant' && before.authority==='inferred' && proposed.derivedFrom.length>0 && narrowsApplicability(before,proposed)))
        reasons.push('applicability-change');
    if (!reasons.length)
        return { decision: 'allowed', item: proposed, reasons: [], blocking: false };
    return { decision: options.exact ? 'review_required' : 'review_recommended', item: structuredClone(before), reasons: [...new Set(reasons)], blocking: !!options.exact };
}
export class KnowledgePolicyReviewRequired extends Error {
    readonly code = 'POLICY_REVIEW_REQUIRED';
    constructor(readonly transition: KnowledgeTransition) { super('POLICY_REVIEW_REQUIRED: The requested rule change needs trusted user intent or an exact policy review. Existing knowledge was preserved.'); }
}
/** Optional diagnostics, not an approval queue and never a Prepare blocker. */
export function summarizePolicyDecisions(decisions: KnowledgeTransition[]) {
    return { blocking: decisions.some(d => d.blocking), recommendations: decisions.filter(d => d.decision === 'review_recommended').length,
        safeFallbacks: decisions.filter(d => d.decision === 'allowed_with_safe_fallback').length, reasons: [...new Set(decisions.flatMap(d => d.reasons))], interactivePrompts: 0 };
}

/** Trusted host review adapter only. A serialized plan or approved=true is not this
 * capability. Exact records (including provenance and lifecycle) and preimages bind
 * the batch. Nested async callers cannot reuse the grant after it returns. */
interface ReviewedBatch { active:boolean; root:string; evidence:string; entries:Array<{before?:KnowledgeItem; after:KnowledgeItem}> }
const batchReviewContext=new AsyncLocalStorage<ReviewedBatch>();
export async function withTrustedKnowledgeBatch<T>(root:string, entries:ReviewedBatch['entries'], evidence:string, operation:()=>Promise<T>):Promise<T>{
 if(!evidence.trim()||!entries.length)throw new Error('Exact trusted batch review required');
 const grant={active:true,root:path.resolve(root),entries:structuredClone(entries),evidence};
 try{return await batchReviewContext.run(grant,operation);}finally{grant.active=false;}
}
function reviewedBatchAllows(root:string,proposed:KnowledgeItem,before?:KnowledgeItem):boolean {
 const g=batchReviewContext.getStore();
 // Canonical normalization eliminates presentation aliases, not semantic metadata.
 const canonical=(i:KnowledgeItem)=>JSON.stringify(Object.fromEntries(Object.entries(i).filter(([k,v])=>v!==undefined&&!['kind','enforcement'].includes(k)).sort(([a],[b])=>a.localeCompare(b))));
 return !!g?.active&&g.root===path.resolve(root)&&g.entries.some(e=>canonical(e.after)===canonical(proposed)&&(!e.before?!before:!!before&&canonical(e.before)===canonical(before)));
}
/** Diagnostic reference only; never grants permission when replayed from history. */
export function trustedKnowledgeBatchEvidence(root:string):string|null {
 const grant=batchReviewContext.getStore();
 return grant?.active&&grant.root===path.resolve(root)?grant.evidence:null;
}
