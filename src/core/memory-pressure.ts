/** Bounded, observational evidence. Nothing here chooses or mutates knowledge. */
import fs from 'node:fs/promises';
import { z } from 'zod';
import { checkedDataPath, ensureDataDirectory, writeFileAtomic, sha256, parseCheckpointData } from './storage.js';
import { withSyncLock } from './sync-transaction.js';
import type { KnowledgeSummary } from './memory-index.js';
import type { ContextSelectionSignal } from './types.js';
import type { ReconciliationCategory } from './intelligence.js';
export const MEMORY_PRESSURE_LIMITS = { sessions: 32, syncs: 32, records: 128, relationships: 128, bytes: 1048576 } as const;
export const MEMORY_PRESSURE_PATH = 'local/memory-pressure.json';
const reasons = ['selected', 'marginal-value', 'context-budget', 'required-budget', 'item-limit', 'rank-window', 'inactive', 'superseded', 'scope-mismatch', 'no-match'] as const;
export type RetrievalReason = typeof reasons[number];
const count = z.number().finite().nonnegative();
const id = z.string().max(256);
const recordSchema = z.object({
    localityKey: z.string().regex(/^[a-f0-9]{64}$/), id, layer: z.enum(['local', 'versioned']), title: z.string().max(160), scope: z.string().max(32), scopeRef: z.string().max(256).nullable(), scopeKind: z.enum(['path', 'topic']).optional(),
    category: z.string().max(32), status: z.string().max(32), estimatedTokens: count, related: z.array(id).max(8),
}).strict();
export type PressureRecord = z.infer<typeof recordSchema>;
export function pressureRecord(item: Pick<KnowledgeSummary, 'id' | 'layer' | 'title' | 'scope' | 'scopeRef' | 'scopeKind' | 'category' | 'status' | 'estimatedTokens' | 'related' | 'supersedes' | 'relations'>): PressureRecord {
    return { localityKey: sha256(JSON.stringify([item.scope, item.scopeRef, item.scopeKind ?? null, item.category])), id: item.id, layer: item.layer, title: item.title.slice(0, 160), scope: item.scope, scopeRef: item.scopeRef?.slice(0, 256) ?? null, ...(item.scopeKind ? { scopeKind: item.scopeKind } : {}), category: item.category, status: item.status, estimatedTokens: item.estimatedTokens,
        related: [...new Set([...item.related, ...item.supersedes, ...item.relations.map(r => r.target)])].slice(0, 8) };
}
const selectionSchema = recordSchema.extend({ bucket: z.enum(['required', 'contextual', 'filtered']), reason: z.enum(reasons), score: z.number().finite().nullable(), rankScore: z.number().finite().nullable(), signals: z.array(z.object({ kind: z.string().max(32), score: z.number().finite() }).strict()).max(12) }).strict();
export type RetrievalRecord = z.infer<typeof selectionSchema>;
const totalsSchema = z.object({ records: count, tokens: count }).strict();
const retrievalSchema = z.object({
    queryHash: z.string().regex(/^[a-f0-9]{64}$/), purpose: z.string().max(16),
    budgets: z.object({ contextBudgetTokens: count, requiredContextBudgetTokens: count, maxRequiredItems: count, maxContextItems: count }).strict(),
    totals: z.record(z.enum(reasons), totalsSchema), requiredTruncated: z.boolean(), requiredOmitted: count,
    records: z.array(selectionSchema).max(MEMORY_PRESSURE_LIMITS.records), detailsDropped: count,
}).strict();
export type RetrievalEvidence = z.infer<typeof retrievalSchema>;
/** Called at existing selection/filter branches; never evaluates relevance itself. */
export class RetrievalEvidenceCollector {
    private samples: Record<string, RetrievalRecord[]> = {};
    private totals: RetrievalEvidence['totals'] = {};
    private requiredOmitted = 0;
    observe(item: KnowledgeSummary, bucket: RetrievalRecord['bucket'], reason: RetrievalReason, score: number | null = null, rankScore: number | null = null, signals: ContextSelectionSignal[] = []): void {
        const total = this.totals[reason] ??= { records: 0, tokens: 0 };
        total.records++;
        total.tokens += item.estimatedTokens;
        if (bucket === 'required' && reason !== 'selected')
            this.requiredOmitted++;
        const sample = this.samples[reason] ??= [];
        if (sample.length < MEMORY_PRESSURE_LIMITS.records)
            sample.push({ ...pressureRecord(item), bucket, reason, score, rankScore, signals: signals.slice(0, 12).map(({ kind, score }) => ({ kind, score })) });
    }
    finish(query: string, purpose: string, budgets: RetrievalEvidence['budgets']): RetrievalEvidence {
        // Retain selected and budget-pressure details before lower-ranked/filter samples.
        const records = ['selected', 'required-budget', 'context-budget', 'item-limit', 'marginal-value', 'rank-window', 'scope-mismatch', 'inactive', 'superseded', 'no-match'].flatMap(r => this.samples[r] ?? []).slice(0, MEMORY_PRESSURE_LIMITS.records);
        return { queryHash: sha256(query.trim()), purpose, budgets, totals: this.totals, requiredTruncated: this.requiredOmitted > 0, requiredOmitted: this.requiredOmitted, records, detailsDropped: Object.values(this.totals).reduce((n, t) => n + (t?.records ?? 0), 0) - records.length };
    }
}
const categories = ['state_transition', 'refinement', 'duplicate', 'supporting', 'potential_conflict', 'unresolved', 'independent'] as const;
const relationshipSchema = z.object({ source: id, target: recordSchema, classification: z.enum(categories) }).strict();
const syncSchema = z.object({ checkpoint: id, sessionIds: z.array(id).max(128), sessionIdsDropped: count,
    changes: z.array(recordSchema.extend({ actions: z.array(z.enum(['created', 'updated', 'merged', 'superseded'])).max(4) }).strict()).max(MEMORY_PRESSURE_LIMITS.records),
    totals: z.object({ created: count, updated: count, merged: count, superseded: count }).strict(), changesDropped: count,
    reconciliation: z.array(relationshipSchema).max(MEMORY_PRESSURE_LIMITS.relationships), classifications: z.record(z.enum(categories), count), relationshipsDropped: count,
}).strict();
export type SyncPressureEvidence = z.infer<typeof syncSchema>;
export type SyncPressureDraft = Omit<SyncPressureEvidence, 'checkpoint' | 'sessionIds' | 'sessionIdsDropped'>;
export class SyncEvidenceCollector {
    private relationships: SyncPressureEvidence['reconciliation'] = [];
    private classifications: SyncPressureEvidence['classifications'] = {};
    observe(source: string, target: PressureRecord, classification: ReconciliationCategory): void {
        this.classifications[classification] = (this.classifications[classification] ?? 0) + 1;
        if (this.relationships.length < MEMORY_PRESSURE_LIMITS.relationships)
            this.relationships.push({ source, target, classification });
    }
    finish(records: PressureRecord[], ids: {
        created: string[];
        updated: string[];
        consolidated: string[];
        superseded: string[];
    }): SyncPressureDraft {
        const sets = { created: new Set(ids.created), updated: new Set(ids.updated), merged: new Set(ids.consolidated), superseded: new Set(ids.superseded) };
        const changes = records.map(record => ({ ...record, actions: (Object.keys(sets) as Array<keyof typeof sets>).filter(key => sets[key].has(record.id)) })).filter(r => r.actions.length);
        return { changes: changes.slice(0, MEMORY_PRESSURE_LIMITS.records), totals: { created: sets.created.size, updated: sets.updated.size, merged: sets.merged.size, superseded: sets.superseded.size }, changesDropped: Math.max(0, changes.length - MEMORY_PRESSURE_LIMITS.records),
            reconciliation: this.relationships, classifications: this.classifications, relationshipsDropped: Object.values(this.classifications).reduce((n, c) => n + (c ?? 0), 0) - this.relationships.length };
    }
}
const sessionSchema = retrievalSchema.extend({ sessionId: id }).strict();
const storeSchema = z.object({ version: z.literal(1), sessionFloor: id.nullable().default(null), syncFloor: id.nullable().default(null), sessions: z.array(sessionSchema).max(MEMORY_PRESSURE_LIMITS.sessions), syncs: z.array(syncSchema).max(MEMORY_PRESSURE_LIMITS.syncs) }).strict();
type Store = z.infer<typeof storeSchema>;
const empty = (): Store => ({ version: 1, sessionFloor: null, syncFloor: null, sessions: [], syncs: [] });
async function readStore(root: string): Promise<{
    data: Store;
    status: 'available' | 'missing' | 'unavailable';
}> {
    try {
        const target = await checkedDataPath(root, MEMORY_PRESSURE_PATH);
        if ((await fs.stat(target)).size > MEMORY_PRESSURE_LIMITS.bytes)
            return { data: empty(), status: 'unavailable' };
        const parsed = storeSchema.safeParse(JSON.parse(await fs.readFile(target, 'utf8')));
        return parsed.success ? { data: parsed.data, status: 'available' } : { data: empty(), status: 'unavailable' };
    }
    catch (error) {
        return { data: empty(), status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable' };
    }
}
function evictOldest(state: Store, kind: 'sessions' | 'syncs'): void {
    const removed = kind === 'sessions' ? state.sessions.pop()?.sessionId : state.syncs.pop()?.checkpoint;
    const field = kind === 'sessions' ? 'sessionFloor' : 'syncFloor';
    if (removed && (!state[field] || removed.localeCompare(state[field]) > 0)) state[field] = removed;
}
async function update(root: string, mutate: (state: Store) => void): Promise<'recorded' | 'unavailable'> {
    try {
        const current = await readStore(root);
        if (current.status === 'unavailable')
            return 'unavailable';
        const before = JSON.stringify(current.data);
        mutate(current.data);
        current.data.sessions.sort((a, b) => b.sessionId.localeCompare(a.sessionId));
        while (current.data.sessions.length > MEMORY_PRESSURE_LIMITS.sessions) evictOldest(current.data, 'sessions');
        current.data.syncs.sort((a, b) => b.checkpoint.localeCompare(a.checkpoint));
        while (current.data.syncs.length > MEMORY_PRESSURE_LIMITS.syncs) evictOldest(current.data, 'syncs');
        let text = JSON.stringify(storeSchema.parse(current.data));
        while (Buffer.byteLength(text) > MEMORY_PRESSURE_LIMITS.bytes) {
            if (current.data.sessions.length >= current.data.syncs.length)
                evictOldest(current.data, 'sessions');
            else
                evictOldest(current.data, 'syncs');
            text = JSON.stringify(current.data);
        }
        if (text !== before) {
            await ensureDataDirectory(root, 'local');
            await writeFileAtomic(await checkedDataPath(root, MEMORY_PRESSURE_PATH), text);
        }
        return 'recorded';
    }
    catch {
        return 'unavailable';
    }
}
export async function recordRetrievalEvidence(root: string, sessionId: string, evidence: RetrievalEvidence): Promise<'recorded' | 'unavailable'> {
    try {
        return await withSyncLock(root, () => update(root, state => { if (state.sessionFloor && sessionId.localeCompare(state.sessionFloor) <= 0) return; state.sessions = state.sessions.filter(s => s.sessionId !== sessionId); state.sessions.push({ ...evidence, sessionId }); }), { waitMs: 5000 });
    }
    catch {
        return 'unavailable';
    }
}
/** Caller holds the existing Sync lock. Only publish after its checkpoint committed. */
export async function recordSyncEvidenceLocked(root: string, evidence: SyncPressureEvidence): Promise<'recorded' | 'unavailable'> {
    return update(root, state => { if (state.syncFloor && evidence.checkpoint.localeCompare(state.syncFloor) <= 0) return; state.syncs = state.syncs.filter(s => s.checkpoint !== evidence.checkpoint); state.syncs.push(evidence); });
}
/** Read-only recent evidence, never a maintenance recommendation. No knowledge bodies read. */
export async function getMemoryPressureSnapshot(root: string) {
    const { data, status } = await readStore(root);
    const checkpoints = [];
    let checkpointCoverage: 'available' | 'unavailable' = 'available';
    try {
        const directory = await checkedDataPath(root, 'checkpoints');
        const names = (await fs.readdir(directory)).filter(n => /^chk_[a-zA-Z0-9_-]+\.json$/.test(n)).sort().reverse().slice(0, MEMORY_PRESSURE_LIMITS.syncs);
        for (const name of names)
            checkpoints.push(parseCheckpointData(await fs.readFile(await checkedDataPath(root, 'checkpoints', name), 'utf8'), name));
    }
    catch {
        checkpointCoverage = 'unavailable';
    }
    const committed = new Set(checkpoints.map(c => c.id));
    const syncs = data.syncs.filter(s => committed.has(s.checkpoint));
    const records = new Map<string, {
        record: PressureRecord;
        consideredSessions: Set<string>;
        selectedSessions: Set<string>;
        budgetOmissionSessions: Set<string>;
    }>();
    const groups = new Map<string, {
        scope: string;
        scopeRef: string | null;
        scopeKind?: string;
        category: string;
        records: Set<string>;
        sessions: Set<string>;
        selected: Set<string>;
        budgetOmitted: Set<string>;
        budgetSessions: Set<string>;
        created: Set<string>;
        updated: Set<string>;
        superseded: Set<string>;
        classifications: Partial<Record<ReconciliationCategory, number>>;
    }>();
    const group = (r: PressureRecord) => { const key = r.localityKey; let g = groups.get(key); if (!g) {
        g = { scope: r.scope, scopeRef: r.scopeRef, scopeKind: r.scopeKind, category: r.category, records: new Set(), sessions: new Set(), selected: new Set(), budgetOmitted: new Set(), budgetSessions: new Set(), created: new Set(), updated: new Set(), superseded: new Set(), classifications: {} };
        groups.set(key, g);
    } g.records.add(`${r.layer}:${r.id}`); return g; };
    for (const session of data.sessions)
        for (const r of session.records) {
            if (r.bucket === 'filtered')
                continue;
            const key = `${r.layer}:${r.id}`;
            let evidence = records.get(key);
            if (!evidence) {
                evidence = { record: r, consideredSessions: new Set(), selectedSessions: new Set(), budgetOmissionSessions: new Set() };
                records.set(key, evidence);
            }
            evidence.consideredSessions.add(session.sessionId);
            const g = group(r);
            g.sessions.add(session.sessionId);
            if (r.reason === 'selected') {
                evidence.selectedSessions.add(session.sessionId);
                g.selected.add(key);
            }
            if (r.reason === 'context-budget' || r.reason === 'required-budget') {
                evidence.budgetOmissionSessions.add(session.sessionId);
                g.budgetOmitted.add(key);
                g.budgetSessions.add(session.sessionId);
            }
        }
    const classifications: Partial<Record<ReconciliationCategory, number>> = {};
    for (const sync of syncs) {
        for (const [kind, n] of Object.entries(sync.classifications))
            classifications[kind as ReconciliationCategory] = (classifications[kind as ReconciliationCategory] ?? 0) + (n ?? 0);
        for (const change of sync.changes) {
            const g = group(change);
            for (const action of change.actions)
                if (action !== 'merged')
                    g[action].add(`${change.layer}:${change.id}`);
        }
        for (const rel of sync.reconciliation) {
            const g = group(rel.target);
            g.classifications[rel.classification] = (g.classifications[rel.classification] ?? 0) + 1;
        }
    }
    return { version: 1 as const, status, checkpointCoverage, limits: MEMORY_PRESSURE_LIMITS, sessions: data.sessions, syncs,
        coverage: { sessionFloor: data.sessionFloor, syncFloor: data.syncFloor, sessions: data.sessions.length, checkpoints: checkpoints.length, checkpointsWithoutDetails: checkpoints.filter(c => !syncs.some(s => s.checkpoint === c.id)).map(c => c.id), retrievalDetailsDropped: data.sessions.reduce((n, s) => n + s.detailsDropped, 0) },
        totals: { relevantConsiderations: data.sessions.reduce((n, s) => n + Object.entries(s.totals).filter(([r]) => ['selected', 'marginal-value', 'context-budget', 'required-budget', 'item-limit', 'rank-window'].includes(r)).reduce((n, [, v]) => n + (v?.records ?? 0), 0), 0),
            selectedKnowledgeTokens: data.sessions.reduce((n, s) => n + (s.totals.selected?.tokens ?? 0), 0),
            budgetOmittedKnowledgeTokens: data.sessions.reduce((n, s) => n + (s.totals['context-budget']?.tokens ?? 0) + (s.totals['required-budget']?.tokens ?? 0), 0),
            repeatedBudgetOmittedRecords: [...records.values()].filter(r => r.budgetOmissionSessions.size > 1).length,
            requiredTruncatedSessions: data.sessions.filter(s => s.requiredTruncated).length, newKnowledge: checkpoints.reduce((n, c) => n + (c.createdMemory?.length ?? 0), 0), updatedKnowledge: checkpoints.reduce((n, c) => n + (c.updatedMemory?.length ?? 0), 0), supersededKnowledge: checkpoints.reduce((n, c) => n + (c.supersededMemory?.length ?? 0), 0), classifications },
        records: [...records.values()].map(r => ({ ...r.record, consideredSessions: r.consideredSessions.size, selectedSessions: r.selectedSessions.size, budgetOmissionSessions: r.budgetOmissionSessions.size })),
        groups: [...groups.entries()].map(([key, g]) => ({ key, scope: g.scope, scopeRef: g.scopeRef, scopeKind: g.scopeKind, category: g.category, records: [...g.records], retrievalSessions: g.sessions.size, selectedRecords: g.selected.size, budgetOmittedRecords: g.budgetOmitted.size, budgetOmissionSessions: g.budgetSessions.size, newRecords: g.created.size, updatedRecords: g.updated.size, supersededRecords: g.superseded.size, classifications: g.classifications })),
    };
}
