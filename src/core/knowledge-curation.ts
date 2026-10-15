import { copyStorageTree, ensureStorageDirectory, ensureDataDirectory } from "./storage.js";
import { PRIVATE_FILE_MODE } from "../filesystem/permissions.js";
import { validateRevision, revisionHash, type ReviewRevision } from './curation-revision.js';
import { renderReviewProjection, type CurationReviewProjection } from './curation-review-state.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadMemoryCatalog } from './memory-index.js';
import { readConfig, checkedDataPath, sha256, listCheckpoints } from './storage.js';
import { parseKnowledge, renderKnowledge } from './memory.js';
import { KNOWLEDGE_ANALYSIS_VERSION } from './knowledge-analysis.js';
import { assertSafeCurationData, collectCurationEvidence, evidenceFor, type CurationEvidence } from './curation-evidence.js';
import { refineCurationClauses } from './curation-clauses.js';
const CURATION_ENGINE = KNOWLEDGE_ANALYSIS_VERSION + '/clauses-2';
import { withApplicability, sameApplicability, narrowsApplicability, applicabilityLabel } from './applicability.js';
import { evaluateKnowledgeTransition, KnowledgePolicyReviewRequired, trustedKnowledgeBatchEvidence } from './knowledge-authority.js';
import { withSyncLock, ownsSyncLock, recoverSyncTransaction, commitSyncTransaction, type PlannedWrite } from './sync-transaction.js';
import { buildIndex } from './index.js';
import { prepareContext } from './context.js';
import { sortableId } from './ids.js';
import { estimateTokens, knowledgeText } from './telemetry.js';
import type { KnowledgeItem } from './types.js';
export interface CurationProposal {
    id: string;
    group: string;
    sourceId: string;
    revision: string;
    path: string;
    before: KnowledgeItem;
    outputs: KnowledgeItem[];
    changes: string[];
    evidence: string[];
    attention: string[];
    /** Stable source/evidence basis; presentation wording is deliberately excluded. */
    issueBasis?: Array<{ id: string; revision: string }>;
    consolidationSources?: string[];
    investigation?: { outcome: 'resolved-proposal'|'reduced-ambiguity'|'needs-decision'|'historical-only'; state: 'still-supported'|'superseded-architecture'|'cannot-determine'; evidence:CurationEvidence[]; explanation:string };
    confidence: 'high' | 'limited';
    mapping: Array<{
        start: number;
        end: number;
        outputId: string;
    }>;
}
export interface CurationPlan {
    /** Bounded Sync analysis only; never an App Apply grant. */
    memorySyncSources?: string[];
    version: 1;
    engine: string;
    project: string;
    knowledgeSchema: number;
    fingerprint: string;
    planId: string;
    proposals: CurationProposal[];
    summary: ReturnType<typeof corpusSummary>;
    accountedSources: number;
    evidenceRoot: string;
    evidenceTruncated: boolean;
    evidenceExclusions?: Array<{reason: string; count: number}>;
}
const digest = (value: unknown) => sha256(JSON.stringify(value));
const seal = (plan: Omit<CurationPlan, 'planId'>): CurationPlan => ({ ...plan, planId: digest(plan) });
const active = (items: KnowledgeItem[]) => items.filter(i => i.status === 'active');
function stats(items: KnowledgeItem[]) { const a = active([...new Map(items.map(i=>[i.id,i])).values()]), required = a.filter(i => i.contextPolicy === 'required'); return { records: a.length, required: required.length, projectWideRequired: required.filter(i => i.applicability?.kind === 'project' || i.applicability?.kind === 'legacy' && i.scope === 'global').length, scopedRequired: required.filter(i => i.applicability?.kind === 'scoped').length, relevant: a.filter(i => i.contextPolicy === 'relevant').length, unresolved: a.filter(i => i.applicability?.kind === 'unresolved').length, requiredTokens: required.reduce((n, i) => n + estimateTokens(knowledgeText(i)), 0) }; }
export function corpusSummary(proposals: CurationProposal[]) { return { consolidated: new Set(proposals.flatMap(p=>p.outputs.filter(o=>o.id.startsWith('mem_curate_shared_')).map(o=>o.id))).size, before: stats(proposals.map(p => p.before)), proposed: stats(proposals.flatMap(p => p.attention.length ? p.before : p.outputs)), decomposed: proposals.filter(p => p.outputs.length > 1 && !p.attention.length).length, attention: proposals.filter(p => p.attention.length).length, unchanged: proposals.filter(p => !p.changes.length || p.attention.length).length, safe: proposals.filter(p => p.changes.length && !p.attention.length).length }; }
/** Pure read phase: cache rebuilds stay in memory, no plan/history persistence. */
export async function planKnowledgeCuration(root: string, options: { evidenceRoot?:string; memorySyncSources?:string[] } = {}): Promise<CurationPlan> {
    const config = await readConfig(root);
    if (!config || config.knowledgeSchemaVersion !== 3)
        throw new Error('Update knowledge format before curation');
    const catalog = await loadMemoryCatalog(root, { persistCache: false });
    const all = await Promise.all(catalog.summaries.filter(s=>!options.memorySyncSources||options.memorySyncSources.includes(s.id)).map(s => catalog.load(s.id)));
    if(options.memorySyncSources){
        const ids=[...new Set(options.memorySyncSources)].sort();
        if(!ids.length||ids.length>24||ids.length!==options.memorySyncSources.length)throw new Error('Invalid Sync analysis scope');
        const proposals:CurationProposal[]=ids.map(id=>{
            const before=all.find(i=>i.id===id&&['active','disputed'].includes(i.status)),summary=catalog.summaries.find(s=>s.id===id);
            if(!before||!summary)throw new Error('Sync analysis source changed');
            return {id,sourceId:id,revision:catalog.originalHashes.get(id)!,path:summary.relativePath,before,outputs:[before],group:'Memory',changes:[],evidence:[],attention:[],confidence:'high',mapping:[{start:0,end:before.content.length,outputId:id}],consolidationSources:ids};
        });
        const canonicalRoot=await fs.realpath(root);
        const plan=seal({version:1,engine:CURATION_ENGINE,project:canonicalRoot,knowledgeSchema:3,memorySyncSources:ids,fingerprint:digest(ids.map(id=>[id,catalog.originalHashes.get(id)])),proposals,summary:corpusSummary(proposals),accountedSources:ids.length,evidenceRoot:canonicalRoot,evidenceTruncated:false});
        validateCurationPlan(plan);return plan;
    }
    const inventory = await collectCurationEvidence(options.evidenceRoot ?? root);
    const proposals: CurationProposal[] = [];
    for (const before of all.filter(i => i.authority === 'legacy_inherited' && !i.derivedFrom.some(ref => ref.startsWith('curation-source:')) && i.contextPolicy === 'required' && ['active', 'disputed'].includes(i.status))) {
        const summary = catalog.summaries.find(s => s.id === before.id)!;
        const parts = refineCurationClauses(before.title, before.content);
        const projectEvidence=evidenceFor(before.content,inventory);
        const structured = /^Decision:/m.test(before.content);
        const attention: string[] = [];
        const conflicts = (before.relations ?? []).filter(r => r.type === 'contradicts');
        if (before.status === 'disputed' || conflicts.length)
            attention.push(`Existing conflict: ${conflicts.map(r => r.target).join(', ') || 'disputed lifecycle state'}`);
        if (parts.some(p => p.transient))
            attention.push('Contains potentially stale historical state; verify current validity before changing protection.');
        const outputs = parts.map((p, n) => {
            // Parent policy is a ceiling: only a source-supported normative core inherits it.
            const policy = before.contextPolicy === 'required' && p.normative ? 'required' : 'relevant';
            const category = policy === 'required' ? 'instruction' : p.category;
            const app = before.applicability && before.applicability.kind !== 'legacy' && before.applicability.kind !== 'unresolved' ? before.applicability : !structured || p.applicability.kind === 'unresolved' ? (before.applicability ?? { kind: 'legacy' as const }) : p.applicability;
            return withApplicability({ ...before, id: parts.length === 1 ? before.id : `mem_curate_${digest([before.id, catalog.originalHashes.get(before.id), n]).slice(0, 24)}`, category, contextPolicy: policy, authority: 'legacy_inherited', title: p.title, content: p.content, derivedFrom: [...before.derivedFrom, ...(p.segments??[{start:p.start,end:p.end}]).map(m=>`curation-source:${before.id}@${catalog.originalHashes.get(before.id)}#${m.start}-${m.end}`)], related: [...new Set([...before.related, ...(parts.length > 1 ? [before.id] : [])])] }, app) as KnowledgeItem;
        });
        // Contradiction metadata is evidence of unresolved policy, never permission to demote it.
        if (before.status === 'disputed' || conflicts.length) outputs.splice(0, outputs.length, structuredClone(before));
        if (structured && parts.some(p => p.applicability.kind === 'unresolved')) attention.push('Applicability remains unresolved; review the intended project boundary.');
        if (outputs.some(o => !sameApplicability(before, o) && !narrowsApplicability(before, o)))
            attention.push('Proposed applicability is not provably narrower; keep the source until reviewed.');
        const changes: string[] = [];
        if (outputs.length > 1)
            changes.push('decomposition');
        if (outputs.some(i => !sameApplicability(before, i)))
            changes.push('applicability-narrowing');
        if (outputs.some(i => i.contextPolicy !== before.contextPolicy))
            changes.push('policy-change');
        if (outputs.some(i => i.category !== before.category))
            changes.push('category-change');
        if (!changes.length)
            outputs.splice(0, outputs.length, structuredClone(before));
        if (changes.length && outputs.some(i => i.contextPolicy === 'required' && (i.applicability?.kind === 'legacy' && i.scope === 'global')))
            attention.push('Required project-wide boundary remains uncertain.');
        const group = outputs.flatMap(i => i.applicability?.kind === 'scoped' ? i.applicability.subsystems ?? i.applicability.paths ?? i.applicability.taskKinds ?? [] : [])[0] ?? 'Project-wide';
        if (outputs.some(o => o.applicability?.kind === 'scoped' && o.applicability.subsystems?.some(n => /^(?:DB|SQL|JSON|HTML|PHP|AI)$/.test(n) || /(?:Harness|Helper)$/.test(n)))) attention.push('Applicability currently names a generic technology or helper rather than a resolved subsystem; review its real work boundary.');
        const hadAttention=attention.length>0;
        const investigation: CurationProposal['investigation'] = hadAttention || projectEvidence.length ? {
            outcome:attention.length?(parts.length>1?'reduced-ambiguity':'needs-decision'):parts.every(p=>p.transient)?'historical-only':'resolved-proposal',
            state:'cannot-determine',
            evidence:projectEvidence,
            explanation:attention.length?'Evidence informs the proposal but cannot authorize choosing between protected meanings.':'Supporting history remains traceable; static evidence does not prove test execution or production rollout. Exact batch review is still required.'
        }:undefined;
        const issueSourceIds = new Set([before.id, ...conflicts.map(r => r.target)]);
        const issueBasis = [...issueSourceIds].sort().map(id => ({ id, revision: catalog.originalHashes.get(id) ?? 'missing' }));
        proposals.push({ issueBasis, investigation, id: before.id, sourceId: before.id, revision: catalog.originalHashes.get(before.id)!, path: summary.relativePath, before, outputs, group, changes, evidence: [...parts.flatMap(p => p.evidence), ...projectEvidence.map(e=>`${e.kind}: ${e.path}:${e.line} (${e.revision.slice(0,12)}) ${e.excerpt}`)], attention, confidence: attention.length ? 'limited' : 'high', mapping: before.status === 'disputed' || conflicts.length ? [{start:0,end:before.content.length,outputId:before.id}] : parts.flatMap((p, n) => (p.segments??[{start:p.start,end:p.end}]).map(m=>({...m,outputId:outputs[n]?.id??before.id}))).sort((a,b)=>a.start-b.start) });
    }
    // Only source-identical normative cores with equal applicability/authority can
    // share an output. Similar vocabulary is never a semantic equivalence proof.
    const cores=new Map<string,Array<{proposal:CurationProposal;output:KnowledgeItem}>>();
    for(const p of proposals.filter(p=>!p.attention.length)) for(const o of p.outputs.filter(o=>o.contextPolicy==='required')) {
        const key=digest([o.content,o.applicability,o.scope,o.scopeRef,o.authority,o.priority,p.path.startsWith('local/')]);
        cores.set(key,[...(cores.get(key)??[]),{proposal:p,output:o}]);
    }
    for(const [key,group] of cores) if(new Set(group.map(g=>g.proposal.id)).size>1) {
        const shared={...group[0].output,id:`mem_curate_shared_${key.slice(0,20)}`};
        for(const field of ['sourceSessions','derivedFrom','supersedes','related'] as const) shared[field]=[...new Set(group.flatMap(g=>g.output[field]))];
        shared.related=[...new Set([...shared.related,...group.map(g=>g.proposal.id)])];
        shared.evidence=Array.from(new Map(group.flatMap(g=>(g.output.evidence??[]).map(e=>[JSON.stringify(e),e] as const))).values());
        shared.relations=Array.from(new Map(group.flatMap(g=>(g.output.relations??[]).map(e=>[JSON.stringify(e),e] as const))).values());
        for(const g of group){const old=g.output.id;g.proposal.outputs=g.proposal.outputs.map(o=>o.id===old?structuredClone(shared):o);g.proposal.mapping.forEach(m=>{if(m.outputId===old)m.outputId=shared.id;});g.proposal.consolidationSources=group.map(g=>g.proposal.id);g.proposal.changes.push('normative-consolidation');g.proposal.evidence.push('Identical normative core, applicability, authority and priority; all source provenance retained.');}
    }
    const fingerprint = digest(catalog.summaries.map(s => [s.id, catalog.originalHashes.get(s.id)]).sort());
    const plan = seal({ version: 1, engine: CURATION_ENGINE, project: path.resolve(root), knowledgeSchema: 3, fingerprint, proposals, summary: corpusSummary(proposals), accountedSources: proposals.length, evidenceRoot: inventory.root, evidenceTruncated: inventory.truncated, ...(inventory.sensitiveExcluded?{evidenceExclusions:[{reason:'Sensitive evidence excluded',count:inventory.sensitiveExcluded}]}:{}) });
    validateCurationPlan(plan);
    return plan;
}
export function validateCurationPlan(plan: CurationPlan) {
    assertSafeCurationData(plan);
    const { planId, ...body } = plan;
    if (digest(body) !== planId)
        throw new Error('Curation plan changed');
    if (plan.engine !== CURATION_ENGINE || plan.knowledgeSchema !== 3 || new Set(plan.proposals.map(p => p.sourceId)).size !== plan.proposals.length || plan.accountedSources !== plan.proposals.length)
        throw new Error('Invalid curation accounting');
    for (const p of plan.proposals) {
        if (!p.outputs.length || p.before.id !== p.sourceId)
            throw new Error('Unaccounted curation source');
        for (const o of p.outputs) {
            const parsed = parseKnowledge(renderKnowledge(o), `${o.id}.md`, 3);
            if (parsed.category !== o.category || parsed.status !== o.status || parsed.content !== o.content)
                throw new Error("Invalid canonical proposal");
            if (!p.before.sourceSessions.every(v=>o.sourceSessions.includes(v)) || !p.before.derivedFrom.every(v=>o.derivedFrom.includes(v)) || !(p.before.evidence??[]).every(v=>(o.evidence??[]).some(e=>JSON.stringify(e)===JSON.stringify(v))) || !p.before.related.every(v=>o.related.includes(v)) || !p.before.supersedes.every(v=>o.supersedes.includes(v))) throw new Error('Curation provenance or relationships were lost');
            if (o.authority !== p.before.authority || o.priority !== p.before.priority)
                throw new Error('Curation cannot infer authority or criticality');
        }
        if (p.outputs.length === 1 && p.outputs[0].content.trim() !== p.before.content.trim())
            throw new Error("Unaccounted source meaning");
        if (p.outputs.length > 1) {
            const reproduced = p.mapping.map(m => p.before.content.slice(m.start, m.end)).join('');
            if (reproduced.replace(/\s+/g, ' ') !== p.before.content.trim().replace(/\s+/g, ' '))
                throw new Error('Unaccounted source clauses');
            for (const output of p.outputs) {
                if (output.content !== p.mapping.filter(m=>m.outputId===output.id).map(m=>p.before.content.slice(m.start,m.end).trim()).join('\n\n'))
                    throw new Error('Invalid clause mapping');
            }
        }
    }
}
function selected(plan: CurationPlan, ids: string[], revision?:ReviewRevision) { if(revision){validateRevision(revision);if(revisionHash(revision.typedPlan.plan)!==revisionHash(plan))throw new Error('Revision plan binding changed');}else validateCurationPlan(plan); if (!ids.length || new Set(ids).size !== ids.length)
    throw new Error('Select a non-empty exact batch'); return ids.map(id => { const p = plan.proposals.find(p => p.id === id); if (!p || p.attention.length || !p.changes.length)
    throw new Error(`Proposal needs individual analysis or has no change: ${id}`); return p; }); }
/** Exact review material for a trusted host adapter; never itself a capability. */
function proposalEntries(p:CurationProposal) { return p.outputs.length === 1 && p.outputs[0].id===p.sourceId ? [{ before: p.before, after: p.outputs[0] }] : [...p.outputs.map(after => ({ before: undefined as KnowledgeItem | undefined, after })), { before: p.before, after: { ...p.before, status: 'superseded' as const, related: [...new Set([...p.before.related, ...p.outputs.map(i => i.id)])] } }]; }
export function curationReviewEntries(plan: CurationPlan, ids: string[], revision?:ReviewRevision) { const chosen=selected(plan, ids,revision); for(const p of chosen)if(p.consolidationSources?.some(id=>!ids.includes(id)))throw new Error('Select the complete normative consolidation group'); return [...new Map(chosen.flatMap(proposalEntries).map(e=>[e.after.id,e])).values()]; }
/** A pre-commit source/evidence conflict; no curation writes have started. */
export class StaleCurationPlanError extends Error {}
export interface CurationReceipt { reviewRevisionId?:string; selectionHash?:string; executionHash?:string; reviewSnapshot?:import('./curation-review.js').CurationReviewSnapshot; reviewState?:import('./curation-review-state.js').ReviewState; projectIdentity:string; decisions:Record<string,string>; reviewId:string; planHash:string; operationId:string; decisionRevision:number; selectedIds:string[]; applied:string[]; unselected:string[]; unresolved:string[]; }
export async function applyKnowledgeCuration(root: string, plan: CurationPlan, ids: string[], receipt?: CurationReceipt) {
    if(plan.memorySyncSources)throw new Error('Sync analysis cannot grant curation Apply authority');
    if (path.resolve(root) !== plan.project)
        throw new Error('Curation project mismatch');
    const chosen = selected(plan, ids,receipt?.reviewSnapshot?.revision), entries = curationReviewEntries(plan, ids,receipt?.reviewSnapshot?.revision);
    // No approved boolean can mint this capability. Fail before mutation/lock.
    for (const e of entries) {
        const d = evaluateKnowledgeTransition(root, e.after, e.before, { exact: true });
        if (d.decision !== 'allowed')
            throw new KnowledgePolicyReviewRequired(d);
    }
    const commit = async () => {
        await recoverSyncTransaction(root);
        const prior = (await listCheckpoints(root)).find(c => receipt?.reviewRevisionId ? (c as any).curation?.review?.operationId===receipt.operationId : (c as any).curation?.planId === plan.planId && digest((c as any).curation.selected) === digest(ids));
        if (prior) {
            await buildIndex(root);
            return { checkpoint: prior.id, repeated: true };
        }
        for(const e of chosen.flatMap(p=>p.investigation?.evidence??[])) {
            const absolute=path.resolve(plan.evidenceRoot,e.path);
            try {
                if(!absolute.startsWith(path.resolve(plan.evidenceRoot)+path.sep) || await fs.realpath(absolute)!==absolute || sha256(await fs.readFile(absolute,'utf8'))!==e.revision) throw new StaleCurationPlanError(`Stale project evidence: ${e.path}`);
            } catch(error) {
                if((error as NodeJS.ErrnoException).code==='ENOENT')throw new StaleCurationPlanError(`Missing project evidence: ${e.path}`);
                throw error;
            }
        }
        const writes: PlannedWrite[] = [];
        const preimages: Array<{
            path: string;
            revision: string;
            content: string;
        }> = [];
        for (const p of chosen) {
            const current = await fs.readFile(await checkedDataPath(root, p.path), 'utf8').catch(error=>{
                if(error.code==='ENOENT')throw new StaleCurationPlanError(`Missing curation source: ${p.sourceId}`);
                throw error;
            });
            if (sha256(current) !== p.revision)
                throw new StaleCurationPlanError(`Stale curation source: ${p.sourceId}`);
            preimages.push({ path: p.path, revision: p.revision, content: current });
        }
        for (const e of entries) {
            const p = chosen.find(p => p.sourceId === e.before?.id || p.outputs.some(i => i.id === e.after.id))!;
            writes.push({ path: e.before ? p.path : `${p.path.startsWith('local/') ? 'local/' : ''}memory/${e.after.id}.md`, before: e.before ? p.revision : null, after: renderKnowledge(e.after) });
        }
        const id = sortableId('chk');
        writes.push({ path: `checkpoints/${id}.json`, before: null, after: JSON.stringify({ id, createdAt: new Date().toISOString(), previousCheckpoint: null, sessions: [], createdMemory: entries.filter(e => !e.before).map(e => e.after.id), updatedMemory: ids, supersededMemory: entries.filter(e => e.after.status === 'superseded').map(e => e.after.id), duplicateMemory: [], conflicts: [], curation: { ...(receipt ? {review:receipt} : {}), reviewEvidence:trustedKnowledgeBatchEvidence(root), planId: plan.planId, engine: plan.engine, selected: ids, leftUnchanged: plan.proposals.filter(p => !ids.includes(p.id)).map(p => p.id), plan, preimages, postimages: writes.map(w=>({path:w.path,revision:sha256(w.after),content:w.after})) } }, null, 2) + '\n' });
        await commitSyncTransaction(root, writes, { policyMode: 'exact' });
        await buildIndex(root);
        return { checkpoint: id, repeated: false };
    };
    return ownsSyncLock(root) ? commit() : withSyncLock(root, commit);
}
export async function curationRecommendation(root: string) {
    const plan = await planKnowledgeCuration(root);
    const { curationReviewView } = await import('./curation-review.js');
    const { review, projection } = await curationReviewView(root, plan);
    return { planId: plan.planId, reviewId: review?.snapshot.reviewId, state: projection.lifecycle,
        prominent: !projection.paused && (projection.needsInputNow > 0 || projection.readyChangeGroups > 0), projection };
}
export async function deferKnowledgeCuration(root: string, planId: string) { const plan = await planKnowledgeCuration(root); if (plan.planId !== planId)
    throw new Error('Curation changed; refresh'); return withSyncLock(root, async () => { await recoverSyncTransaction(root); const id = sortableId('chk'); await commitSyncTransaction(root, [{ path: `checkpoints/${id}.json`, before: null, after: JSON.stringify({ id, createdAt: new Date().toISOString(), sessions: [], curationDefer: planId }) + '\n' }]); return { state: 'deferred' }; }); }
// Explicitly labelled examples, not a claim of representative project coverage.
export const CURATION_TASKS = ['Synthetic example: review documentation', 'Synthetic example: run unit tests', 'Synthetic example: review deployment'];
function contextMetrics(c: Awaited<ReturnType<typeof prepareContext>>) { return { unknownRequired: c.applicability?.unknownRequired ?? 0, applicabilityDecisions: c.applicability?.decisions, requiredIds: c.required.map(i => i.id), requiredCandidates: c.required.length + c.metrics.requiredGlobalExcludedItems, requiredCandidateTokens: c.metrics.requiredGlobalCandidateTokens, requiredSelected: c.required.length, requiredSelectedTokens: c.metrics.requiredGlobalTokens, requiredOmissions: c.metrics.requiredGlobalExcludedItems, relevantSelected: c.relevant.length, relevantOmittedByItemLimit: c.selection.omittedRelevantByItemLimit, relevantOmittedByMarginalValue:c.selection.omittedRelevantByMarginalValue ?? 0, allocation:c.allocation, totalContextTokens: c.metrics.contextTokens, pressure: c.metrics.requiredGlobalPressure, contextNeeded: c.policyReadiness?.state === 'context-needed', readiness: c.policyReadiness, limits: c.limits }; }
/** Real selector over an isolated canonical corpus; no lifecycle Prepare/Sync. */
export async function simulateKnowledgeCuration(root: string, plan: CurationPlan, tasks = CURATION_TASKS, mode: 'safe-batch' | 'all-proposals' = 'safe-batch', selectedIds?:string[], revision?:ReviewRevision) {
    if(revision){validateRevision(revision);if(revision.typedPlan.plan.planId!==plan.planId)throw new Error('Simulation revision mismatch');}else validateCurationPlan(plan);
    if (path.resolve(root) !== plan.project)
        throw new Error('Simulation project mismatch');
    if(selectedIds?.length)curationReviewEntries(plan,selectedIds,revision);
    const temp = await fs.mkdtemp(path.join(await ensureDataDirectory(root, '.cache'), 'prodero-curation-simulation-'));
    try {
        await ensureStorageDirectory(path.join(temp, '.prodero'), true);
        const config = await readConfig(root);
        await fs.writeFile(path.join(temp, '.prodero/config.json'), JSON.stringify(config), {mode: PRIVATE_FILE_MODE});
        // Copy only canonical stores consumed by the selector, never caches or sessions.
        for (const dir of ['memory', 'local/memory', 'skills', 'local/skills']) {
            const from = await checkedDataPath(root, dir);
            try {
                await copyStorageTree(from, path.join(temp, '.prodero', dir), true);
            }
            catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw e;
            }
        }
        const copied=await loadMemoryCatalog(temp,{persistCache:false});
        await Promise.all(copied.summaries.map(i=>copied.load(i.id)));
        if(digest(copied.summaries.map(i=>[i.id,copied.originalHashes.get(i.id)]).sort())!==plan.fingerprint)throw new Error('Simulation corpus changed since planning');
        const before = await Promise.all(tasks.map(async (task) => ({ task, before: contextMetrics(await prepareContext(temp, { query: task })) })));
        for (const p of plan.proposals) {
            if (sha256(await fs.readFile(await checkedDataPath(temp, p.path), 'utf8')) !== p.revision)
                throw new Error(`Stale simulation source: ${p.id}`);
            if ((mode === 'safe-batch' && p.attention.length) || !p.changes.length || (selectedIds && !selectedIds.includes(p.id)))
                continue;
            for (const entry of proposalEntries(p))
                await fs.writeFile(await checkedDataPath(temp, entry.before?p.path:`${p.path.startsWith('local/') ? 'local/' : ''}memory/${entry.after.id}.md`), renderKnowledge(entry.after), {mode: PRIVATE_FILE_MODE});
        }
        return await Promise.all(before.map(async (row) => ({ ...row, after: contextMetrics(await prepareContext(temp, { query: row.task })) })));
    }
    finally {
        await fs.rm(temp, { recursive: true, force: true });
    }
}
export function renderCurationText(plan: CurationPlan, projection: CurationReviewProjection) {
    return `Knowledge cleanup\n${renderReviewProjection(projection)}.\nNo knowledge is removed automatically.\n` + plan.proposals.map(p => {
        const item=projection.items.find(i=>i.proposalIds.includes(p.id))!;
        const status=item.issue?.state==='deferred'?'Deferred clarification':item.disposition==='keep_current'?'Keep current':item.disposition==='deferred'&&item.outcome==='proposed'?'Deferred change':item.outcome==='unresolved'?'Needs clarification':item.outcome==='proposed'?'Proposed change':'Unchanged';
        return `${p.group} · ${p.before.title}\n${status}\nCurrently: ${p.before.contextPolicy} · ${applicabilityLabel(p.before)}\n${item.outcome==='unresolved'?'No actionable suggestion is available yet.':`Suggested: ${p.outputs.map(i => `${i.category}, ${i.contextPolicy}, ${applicabilityLabel(i)}`).join('; ')}`}\nWhy: ${p.evidence.join('; ')}`;
    }).join('\n\n');
}
