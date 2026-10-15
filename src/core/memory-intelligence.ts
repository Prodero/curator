import { ownsSyncLock } from './sync-transaction.js';
/** Read-only, deterministic candidate discovery. No transformation or lifecycle mutation. */
import { loadMemoryCatalog, type KnowledgeSummary } from './memory-index.js';
import { getMemoryPressureSnapshot, type RetrievalRecord } from './memory-pressure.js';
import { provenanceEdges, readKnowledgeInventory } from './knowledge-provenance.js';
import { assertCompatibleProject, checkedDataPath, exists, sha256 } from './storage.js';
export const MEMORY_INTELLIGENCE_POLICY = {
    version: 1, limits: { candidates: 20, records: 24, evidence: 32, sessions: 8, pairs: 24 },
    thresholds: { repeatedSessions: 2, fragmentationRecords: 4, repeatedCheckpoints: 2 },
    scoring: {
        context_pressure: { perRepeatedRecord: 12, recordCap: 5, perSession: 3, sessionCap: 8 },
        fragmentation: { perRecordBeyondTwo: 2, recordCap: 6 },
        recent_evolution: { perCreatedRecord: 2, perTransition: 3, perRefinement: 2, cap: 12 },
        potential_conflict: { perPair: 20, pairCap: 2 },
        redundancy: { perCheckpoint: 2, checkpointCap: 4 },
        unresolved: { perCheckpoint: 3, checkpointCap: 4 },
    },
} as const;
type Signal = keyof typeof MEMORY_INTELLIGENCE_POLICY.scoring;
type Snapshot = Awaited<ReturnType<typeof getMemoryPressureSnapshot>>;
type Classification = Snapshot['syncs'][number]['reconciliation'][number]['classification'];
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sorted = (values: Iterable<string>) => [...new Set(values)].sort(compare);
const pairKey = (a: string, b: string) => JSON.stringify([a, b].sort(compare));
const budget = (r: RetrievalRecord) => r.reason === 'context-budget' || r.reason === 'required-budget';
const useful = (r: RetrievalRecord) => r.bucket !== 'filtered' && ['selected', 'context-budget', 'required-budget', 'item-limit', 'rank-window'].includes(r.reason);
const coUsable = (r: RetrievalRecord) => r.bucket === 'contextual' && (r.reason === 'selected' || budget(r));
const protectedCategories = new Set(['instruction', 'principle', 'invariant', 'constraint', 'decision']);
export interface MemoryIntelligenceReconciliationEvidence {
    checkpoint: string;
    source: string;
    sourceId: string | null;
    targetId: string;
    originalTargetId: string;
    classification: Classification;
    verifiedCurrentConflict: boolean;
}
interface Pair {
    ids: [
        string,
        string
    ];
    sessions: Set<string>;
    coOmissionSessions: Set<string>;
    reasons: Set<string>;
}
/** No writer locks, migration, recovery, caches or telemetry writes on this path. */
async function assertQuiescent(root: string) {
    for (const relative of ['.transactions/pending.json', '.transactions/migration.json', '.transactions/lock'])
        if (!(relative === '.transactions/lock' && ownsSyncLock(root)) && await exists(await checkedDataPath(root, relative)))
            throw new Error('Memory intelligence requires a stable project: a storage writer or recovery journal is pending. No recovery was attempted.');
}
async function computeMemoryIntelligencePlan(root: string, selectedId?: string) {
    let selectedSourceIds: string[] = [];
    await assertCompatibleProject(root);
    await assertQuiescent(root);
    const catalog = await loadMemoryCatalog(root, { persistCache: false });
    const snapshot = await getMemoryPressureSnapshot(root);
    // Reuse archive/provenance reading; cached current summaries are not reread as bodies.
    const archived = await readKnowledgeInventory(root, { storage: 'archive' });
    const allLayers = new Map(catalog.summaries.map(r => [r.id, r.layer]));
    for (const r of archived) {
        if (allLayers.has(r.item.id))
            throw new Error(`Duplicate knowledge ID across current/archive storage: ${r.item.id}`);
        allLayers.set(r.item.id, r.layer);
    }
    const edges = provenanceEdges([...catalog.summaries, ...archived.map(r => r.item)]);
    const retired = new Set(edges.map(e => e.to));
    // Disputed claims remain visible for conflict diagnostics, not ordinary retrieval.
    const current = catalog.summaries.filter(r => ['active', 'disputed'].includes(r.status) && !retired.has(r.id)).sort((a, b) => compare(a.id, b.id));
    const byId = new Map(current.map(r => [r.id, r]));
    const sessions = [...new Map(snapshot.sessions.map(s => [s.sessionId, s])).values()].sort((a, b) => compare(a.sessionId, b.sessionId));
    const syncs = [...new Map(snapshot.syncs.map(s => [s.checkpoint, s])).values()].sort((a, b) => compare(a.checkpoint, b.checkpoint));
    const sessionsFor = new Map<string, Map<string, RetrievalRecord>>();
    let ignoredRetrievalDetails = 0;
    for (const session of sessions) {
        const records = new Map<string, RetrievalRecord>();
        for (const r of session.records) {
            if (byId.get(r.id)?.layer !== r.layer || !useful(r)) {
                ignoredRetrievalDetails++;
                continue;
            }
            records.set(r.id, r);
        }
        sessionsFor.set(session.sessionId, records);
    }
    const direct = new Set<string>();
    for (const r of current)
        for (const target of [...r.related, ...r.relations.filter(e => ['related_to', 'depends_on', 'implements', 'contradicts'].includes(e.type)).map(e => e.target)])
            if (byId.has(target) && target !== r.id)
                direct.add(pairKey(r.id, target));
    const parents = new Map<string, Set<string>>();
    const successors = new Map<string, Set<string>>();
    for (const e of edges) {
        const sources = parents.get(e.from) ?? new Set<string>();
        sources.add(e.to);
        parents.set(e.from, sources);
        const newer = successors.get(e.to) ?? new Set<string>();
        newer.add(e.from);
        successors.set(e.to, newer);
    }
    const resolve = (id: string): string | null => {
        if (byId.has(id))
            return id;
        const seen = new Set<string>(), todo = [id], matches = new Set<string>();
        for (let i = 0; i < todo.length; i++) {
            const next = todo[i];
            if (seen.has(next))
                continue;
            seen.add(next);
            if (byId.has(next))
                matches.add(next);
            else
                todo.push(...(successors.get(next) ?? []));
        }
        return matches.size === 1 ? [...matches][0] : null;
    };
    // Observation refs are not knowledge IDs. Resolve them only via existing derived_from,
    // loading only current records named by bounded committed Sync changes.
    const sourceIds = new Map<string, Set<string>>();
    const requiredSources = new Set(syncs.flatMap(s => s.reconciliation.map(e => e.source)));
    for (const id of sorted(syncs.flatMap(s => s.changes.map(c => c.id)))) {
        if (!byId.has(id))
            continue;
        const item = await catalog.load(id);
        for (const source of item.derivedFrom)
            if (requiredSources.has(source)) {
                const ids = sourceIds.get(source) ?? new Set<string>();
                ids.add(id);
                sourceIds.set(source, ids);
            }
    }
    const events = new Map<string, MemoryIntelligenceReconciliationEvidence>();
    let ignoredReconciliation = 0;
    for (const sync of syncs)
        for (const e of sync.reconciliation) {
            const targetId = resolve(e.target.id);
            if (!targetId || allLayers.has(e.target.id) && allLayers.get(e.target.id) !== e.target.layer) {
                ignoredReconciliation++;
                continue;
            }
            const sources = sourceIds.get(e.source);
            const sourceId = byId.has(e.source) ? e.source : sources?.size === 1 ? [...sources][0] : null;
            const event: MemoryIntelligenceReconciliationEvidence = { checkpoint: sync.checkpoint, source: e.source, sourceId, targetId, originalTargetId: e.target.id, classification: e.classification,
                verifiedCurrentConflict: e.classification === 'potential_conflict' && sourceId !== null && sourceId !== targetId && targetId === e.target.id };
            events.set(JSON.stringify([sync.checkpoint, e.source, e.target.id, e.classification]), event);
        }
    const evidence = [...events.values()].sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
    const pairs = new Map<string, Pair>();
    const pair = (a: string, b: string) => { const key = pairKey(a, b); let p = pairs.get(key); if (!p) {
        p = { ids: [a, b].sort(compare) as [
                string,
                string
            ], sessions: new Set(), coOmissionSessions: new Set(), reasons: new Set() };
        pairs.set(key, p);
    } return p; };
    const affinity = (a: KnowledgeSummary, b: KnowledgeSummary): string | null => {
        if (direct.has(pairKey(a.id, b.id)))
            return 'explicit_relationship';
        if (a.scopeRef && a.scope === b.scope && a.scopeRef === b.scopeRef && (a.scopeKind ?? null) === (b.scopeKind ?? null))
            return 'same_named_scope';
        if ([...(parents.get(a.id) ?? [])].some(id => parents.get(b.id)?.has(id)))
            return 'shared_provenance_source';
        return null;
    };
    for (const [sessionId, records] of sessionsFor) {
        const contextual = [...records.values()].filter(coUsable).sort((a, b) => compare(a.id, b.id));
        for (let i = 0; i < contextual.length; i++)
            for (let j = i + 1; j < contextual.length; j++) {
                const a = contextual[i], b = contextual[j], reason = affinity(byId.get(a.id)!, byId.get(b.id)!);
                if (!reason)
                    continue;
                const p = pair(a.id, b.id);
                p.sessions.add(sessionId);
                p.reasons.add(reason);
                if (budget(a) && budget(b))
                    p.coOmissionSessions.add(sessionId);
            }
    }
    const admissible = new Map([...pairs].filter(([, p]) => p.sessions.size >= MEMORY_INTELLIGENCE_POLICY.thresholds.repeatedSessions));
    // A verified incompatible pair is explicit evidence, not a lexical grouping guess.
    for (const e of evidence)
        if (e.verifiedCurrentConflict) {
            const p = pair(e.sourceId!, e.targetId);
            p.reasons.add('verified_reconciliation_conflict');
            admissible.set(pairKey(...p.ids), p);
        }
    const observed = sorted([...sessionsFor.values()].flatMap(m => [...m.keys()]).concat(evidence.flatMap(e => [e.targetId, ...(e.verifiedCurrentConflict ? [e.sourceId!] : [])])));
    const unassigned = new Set(observed), areas: string[][] = [];
    // Complete-link partition: a bridge cannot merge unrelated ends of a chain.
    for (const seed of observed) {
        if (!unassigned.has(seed))
            continue;
        const area = [seed];
        unassigned.delete(seed);
        for (const id of observed)
            if (unassigned.has(id) && area.every(member => admissible.has(pairKey(member, id)))) {
                area.push(id);
                unassigned.delete(id);
            }
        areas.push(area);
    }
    const L = MEMORY_INTELLIGENCE_POLICY.limits, W = MEMORY_INTELLIGENCE_POLICY.scoring;
    const candidates = areas.flatMap(ids => {
        const members = new Set(ids), records = ids.map(id => byId.get(id)!);
        const considered = new Set<string>(), selected = new Set<string>(), omitted = new Set<string>();
        const omissionByRecord = new Map<string, Set<string>>(), selectedRecords = new Set<string>();
        const retrieval: Array<{
            sessionId: string;
            selectedIds: string[];
            contextOmittedIds: string[];
            requiredOmittedIds: string[];
            omittedTokens: number;
            contextBudgetTokens: number;
            requiredBudgetTokens: number;
        }> = [];
        for (const session of sessions) {
            const relevant = [...(sessionsFor.get(session.sessionId)?.values() ?? [])].filter(r => members.has(r.id));
            if (!relevant.length)
                continue;
            considered.add(session.sessionId);
            const selectedIds = sorted(relevant.filter(r => r.reason === 'selected').map(r => r.id));
            if (selectedIds.length)
                selected.add(session.sessionId);
            for (const id of selectedIds)
                selectedRecords.add(id);
            const omittedRecords = relevant.filter(budget);
            if (omittedRecords.length)
                omitted.add(session.sessionId);
            for (const r of omittedRecords) {
                const set = omissionByRecord.get(r.id) ?? new Set();
                set.add(session.sessionId);
                omissionByRecord.set(r.id, set);
            }
            retrieval.push({ sessionId: session.sessionId, selectedIds, contextOmittedIds: sorted(omittedRecords.filter(r => r.reason === 'context-budget').map(r => r.id)), requiredOmittedIds: sorted(omittedRecords.filter(r => r.reason === 'required-budget').map(r => r.id)), omittedTokens: omittedRecords.reduce((n, r) => n + r.estimatedTokens, 0), contextBudgetTokens: session.budgets.contextBudgetTokens, requiredBudgetTokens: session.budgets.requiredContextBudgetTokens });
        }
        const repeated = [...omissionByRecord].filter(([, s]) => s.size >= 2).map(([id]) => id).sort(compare);
        const areaEvents = evidence.filter(e => members.has(e.targetId));
        const classifications: Partial<Record<Classification, number>> = {};
        for (const e of areaEvents)
            classifications[e.classification] = (classifications[e.classification] ?? 0) + 1;
        const conflictPairs = new Set(areaEvents.filter(e => e.verifiedCurrentConflict && members.has(e.sourceId!)).map(e => pairKey(e.sourceId!, e.targetId)));
        const unverifiedConflicts = areaEvents.filter(e => e.classification === 'potential_conflict' && !e.verifiedCurrentConflict).length;
        const checkpoints = (types: Classification[]) => new Set(areaEvents.filter(e => types.includes(e.classification)).map(e => e.checkpoint));
        const redundant = checkpoints(['duplicate', 'supporting']), unresolved = checkpoints(['unresolved']);
        const additions = new Set<string>(), updates = new Set<string>();
        const syncDetails = syncs.flatMap(s => s.changes.filter(c => members.has(c.id) && byId.get(c.id)?.layer === c.layer).map(c => { if (c.actions.includes('created'))
            additions.add(c.id); if (c.actions.some(a => a === 'updated' || a === 'merged'))
            updates.add(c.id); return { checkpoint: s.checkpoint, id: c.id, actions: c.actions }; }));
        const connections = [...admissible.values()].filter(p => p.ids.every(id => members.has(id))).sort((a, b) => compare(pairKey(...a.ids), pairKey(...b.ids)));
        const repeatedCoRecords = new Set(connections.filter(p => p.sessions.size >= 2).flatMap(p => p.ids));
        const scores: Record<Signal, number> = { context_pressure: 0, fragmentation: 0, recent_evolution: 0, potential_conflict: 0, redundancy: 0, unresolved: 0 };
        if (repeated.length)
            scores.context_pressure = W.context_pressure.perRepeatedRecord * Math.min(W.context_pressure.recordCap, repeated.length) + W.context_pressure.perSession * Math.min(W.context_pressure.sessionCap, omitted.size);
        if (repeatedCoRecords.size >= MEMORY_INTELLIGENCE_POLICY.thresholds.fragmentationRecords && records.filter(r => !protectedCategories.has(r.category) && repeatedCoRecords.has(r.id)).length >= 2)
            scores.fragmentation = W.fragmentation.perRecordBeyondTwo * Math.min(W.fragmentation.recordCap, repeatedCoRecords.size - 2);
        scores.potential_conflict = W.potential_conflict.perPair * Math.min(W.potential_conflict.pairCap, conflictPairs.size);
        if (redundant.size >= 2)
            scores.redundancy = W.redundancy.perCheckpoint * Math.min(W.redundancy.checkpointCap, redundant.size);
        if (unresolved.size >= 2)
            scores.unresolved = W.unresolved.perCheckpoint * Math.min(W.unresolved.checkpointCap, unresolved.size);
        if (!Object.values(scores).some(n => n > 0))
            return [];
        scores.recent_evolution = Math.min(W.recent_evolution.cap, W.recent_evolution.perCreatedRecord * additions.size + W.recent_evolution.perTransition * (classifications.state_transition ?? 0) + W.recent_evolution.perRefinement * (classifications.refinement ?? 0));
        const categories: Record<string, number> = {};
        for (const r of records)
            categories[r.category] = (categories[r.category] ?? 0) + 1;
        const named = records[0].scopeRef, sameScope = !!named && records.every(r => r.scope === records[0].scope && r.scopeRef === named && r.scopeKind === records[0].scopeKind);
        const recordDetails = records.slice(0, L.records).map(r => ({ id: r.id, layer: r.layer, title: r.title.slice(0, 160), scope: r.scope, scopeRef: r.scopeRef?.slice(0, 256) ?? null, scopeKind: r.scopeKind ?? null, category: r.category, status: r.status, estimatedTokens: r.estimatedTokens, protected: protectedCategories.has(r.category), budgetOmissionSessions: omissionByRecord.get(r.id)?.size ?? 0 }));
        const clipIds = (values: string[]) => ({ ids: values.slice(0, L.records), dropped: Math.max(0, values.length - L.records) });
        const areaId = `area_${sha256(JSON.stringify(ids)).slice(0, 20)}`;
        if (areaId === selectedId) selectedSourceIds = ids;
        return [{ id: areaId, label: sameScope ? named!.slice(0, 160) : records[0].title.slice(0, 160), recommendation: 'transformation_candidate' as const,
                recordCount: ids.length, layers: { local: records.filter(r => r.layer === 'local').length, versioned: records.filter(r => r.layer === 'versioned').length }, categories, containsProtectedKnowledge: records.some(r => protectedCategories.has(r.category)), records: recordDetails,
                signals: (Object.keys(scores) as Signal[]).filter(s => scores[s] > 0), priority: { total: Object.values(scores).reduce((a, b) => a + b, 0), components: scores },
                counts: { consideredSessions: considered.size, selectedSessions: selected.size, selectedRecords: selectedRecords.size, budgetOmittedRecords: omissionByRecord.size, repeatedBudgetOmittedRecords: repeated.length, budgetOmissionSessions: omitted.size, repeatedCoRecords: repeatedCoRecords.size, recentCreatedRecords: additions.size, recentUpdatedRecords: updates.size, verifiedConflictPairs: conflictPairs.size, unverifiedConflictEvidence: unverifiedConflicts, redundancyCheckpoints: redundant.size, unresolvedCheckpoints: unresolved.size },
                reconciliation: classifications,
                evidence: { repeatedBudgetOmitted: clipIds(repeated), retrieval: retrieval.slice(-L.sessions).map(r => ({ ...r, selectedIds: clipIds(r.selectedIds), contextOmittedIds: clipIds(r.contextOmittedIds), requiredOmittedIds: clipIds(r.requiredOmittedIds) })),
                    relationships: connections.slice(0, L.pairs).map(p => ({ ids: p.ids, reasons: sorted(p.reasons), coRetrievalSessions: p.sessions.size, coOmissionSessions: p.coOmissionSessions.size, sessionIds: sorted(p.sessions).slice(-L.sessions), sessionIdsDropped: Math.max(0, p.sessions.size - L.sessions) })),
                    reconciliation: areaEvents.slice(-L.evidence), sync: syncDetails.slice(-L.evidence) },
                truncated: { records: Math.max(0, ids.length - L.records), retrievalSessions: Math.max(0, retrieval.length - L.sessions), relationships: Math.max(0, connections.length - L.pairs), reconciliation: Math.max(0, areaEvents.length - L.evidence), sync: Math.max(0, syncDetails.length - L.evidence) } }];
    }).sort((a, b) => b.priority.total - a.priority.total || compare(a.id, b.id));
    await assertQuiescent(root);
    const plan = { version: 1, policy: MEMORY_INTELLIGENCE_POLICY, coverage: { telemetry: snapshot.status, checkpointCoverage: snapshot.checkpointCoverage, ...snapshot.coverage,
            syncChangesDropped: syncs.reduce((n, s) => n + s.changesDropped, 0), reconciliationDetailsDropped: syncs.reduce((n, s) => n + s.relationshipsDropped, 0),
            currentRecords: current.length, archivedRecordsExcluded: archived.length, historicalOrRetiredRecordsExcluded: catalog.summaries.length - current.length, ignoredRetrievalDetails, ignoredReconciliation, unverifiedConflictEvidence: evidence.filter(e => e.classification === 'potential_conflict' && !e.verifiedCurrentConflict).length },
        candidateCount: candidates.length, candidates: candidates.slice(0, L.candidates), truncated: { candidates: Math.max(0, candidates.length - L.candidates) } };
    const sources = new Set(selectedSourceIds);
    const predecessors = new Set(edges.filter(e => sources.has(e.from)).map(e => e.to));
    const provenance = edges.filter(e => sources.has(e.from) || sources.has(e.to) || predecessors.has(e.from) || predecessors.has(e.to));
    const referenced = new Set([...selectedSourceIds, ...provenance.flatMap(e => [e.from,e.to])]);
    const locations = [...catalog.summaries.map(r=>({id:r.id,path:r.relativePath,layer:r.layer,storage:'current' as const})),
        ...archived.map(r=>({id:r.item.id,path:r.path,layer:r.layer,storage:'archive' as const}))].filter(r=>referenced.has(r.id)).sort((a,b)=>compare(a.id,b.id));
    return {plan,selectedSourceIds,provenance,locations};
}
export async function getMemoryIntelligencePlan(root: string) {
    return (await computeMemoryIntelligencePlan(root)).plan;
}
/** Internal exact membership, including IDs omitted from the bounded diagnostic table. */
export async function getMemoryIntelligenceCandidate(root: string, candidateId: string) {
    if (!/^area_[a-f0-9]{20}$/.test(candidateId)) throw new Error('Invalid memory candidate ID');
    const result = await computeMemoryIntelligencePlan(root,candidateId);
    const candidate = result.plan.candidates.find(c=>c.id===candidateId);
    if (!candidate) throw new Error('Memory candidate is stale or unavailable in the current bounded plan');
    const value = {candidate,sourceIds:result.selectedSourceIds,policy:result.plan.policy,coverage:result.plan.coverage,provenance:result.provenance,locations:result.locations};
    return {...value,revision:sha256(JSON.stringify(value))};
}
