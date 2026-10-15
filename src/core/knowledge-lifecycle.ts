import {applicabilitySchema,applicabilityOf,sameApplicability,withApplicability} from "./applicability.js";
import { inferredKnowledge, evaluateKnowledgeTransition, protectedKnowledge, coversProtection } from './knowledge-authority.js';
import { inheritKnowledgePolicy } from './knowledge-policy.js';
import { z } from 'zod';
import { sortableId } from './ids.js';
import { assertEnglishProse } from './language.js';
import { parseKnowledge, renderKnowledge } from './memory.js';
import { knowledgeArchivePath, provenanceEdges, readKnowledgeInventory, type LocatedKnowledge } from './knowledge-provenance.js';
import { assertCompatibleProject, listCheckpoints, sha256 } from './storage.js';
import { commitSyncTransaction, recoverSyncTransaction, withSyncLock, ownsSyncLock, type PlannedMove, type PlannedWrite } from './sync-transaction.js';
import type { Checkpoint, KnowledgeItem } from './types.js';
const id = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const proposalSchema = z.object({
    operationId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    expectedRevisions: z.record(id, z.string().regex(/^[a-f0-9]{64}$/)).default({}),
    create: z.array(z.object({
        applicability:applicabilitySchema.optional(),
        id: z.string().regex(/^mem_[a-zA-Z0-9_]+$/), layer: z.enum(['local', 'versioned']), title: z.string().trim().min(1).max(240), content: z.string().trim().min(1).max(10000),
        scope: z.enum(['global', 'module', 'task']), scopeRef: z.string().nullable(), scopeKind: z.enum(['path', 'topic']).optional(),
        category: z.enum(['instruction', 'principle', 'invariant', 'constraint', 'decision', 'lesson', 'state']),
        priority: z.enum(['critical', 'important', 'normal', 'contextual']).default('normal'),
        related: z.array(id).max(32).optional(), sourceSessions: z.array(id).optional(), derivedFrom: z.array(z.string()).optional(),
    }).strict()).max(100).default([]),
    links: z.array(z.object({ from: id, to: id, type: z.enum(['supersedes', 'consolidates']) }).strict()).max(1000).default([]),
    archive: z.array(id).max(1000).default([]),
}).strict();
export type KnowledgeLifecycleProposal = z.input<typeof proposalSchema>;
export interface KnowledgeLifecyclePreview {
    version: 1;
    proposal: z.output<typeof proposalSchema>;
    createdAt: string;
    inventoryHash: string;
    changes: Array<{
        id: string;
        layer: 'local' | 'versioned';
        from: string | null;
        to: string;
        before: string | null;
        after: string;
    }>;
    versionedChanges: string[];
    planId: string;
}
const digest = (value: unknown) => sha256(JSON.stringify(value));
const inventoryHash = (records: LocatedKnowledge[]) => digest(records.map(r => [r.item.id, r.path, r.revision]));
function validateGraph(items: KnowledgeItem[]) {
    const ids = new Set(items.map(i => i.id)), edges = provenanceEdges(items), adjacency = new Map<string, string[]>();
    for (const item of items)
        for (const target of [...item.related, ...(item.relations ?? []).filter(r => !['applies_to', 'learned_from'].includes(r.type)).map(r => r.target)]) {
            if (!ids.has(target))
                throw new Error(`Missing relationship target: ${target}`);
        }
    for (const e of edges) {
        if (!ids.has(e.from) || !ids.has(e.to))
            throw new Error(`Missing provenance target: ${e.from} -> ${e.to}`);
        if (e.from === e.to)
            throw new Error('Self supersession/consolidation is forbidden');
        const targets = adjacency.get(e.from) ?? [];
        targets.push(e.to);
        adjacency.set(e.from, targets);
    }
    // Iterative topological validation also handles long historical chains safely.
    const indegree = new Map([...ids].map(id => [id, 0]));
    for (const targets of adjacency.values())
        for (const target of targets)
            indegree.set(target, indegree.get(target)! + 1);
    const ready = [...ids].filter(id => indegree.get(id) === 0);
    let visited = 0;
    for (let i = 0; i < ready.length; i++) {
        visited++;
        for (const target of adjacency.get(ready[i]) ?? []) {
            indegree.set(target, indegree.get(target)! - 1);
            if (indegree.get(target) === 0)
                ready.push(target);
        }
    }
    if (visited !== ids.size)
        throw new Error('Knowledge provenance cycle');
}
function plan(root: string, records: LocatedKnowledge[], proposal: z.output<typeof proposalSchema>, createdAt: string): KnowledgeLifecyclePreview {
    if (!Number.isFinite(Date.parse(createdAt)))
        throw new Error('Invalid lifecycle timestamp');
    const before = new Map(records.map(r => [r.item.id, r]));
    for (const [id, revision] of Object.entries(proposal.expectedRevisions)) {
        if (before.get(id)?.revision !== revision) throw new Error(`Stale source revision: ${id}`);
    }
    // Incomparable source boundaries cannot be replaced by one broader record.
    const skipped=new Set(proposal.create.filter(input=>{const sources=proposal.links.filter(l=>l.from===input.id).flatMap(l=>before.has(l.to)?[before.get(l.to)!.item]:[]);return sources.length>1&&!sources.every(s=>sameApplicability(s,sources[0]));}).map(i=>i.id));
    const preserved=new Set(proposal.links.filter(l=>skipped.has(l.from)).map(l=>l.to));
    const after = new Map(records.map(r => [r.item.id, structuredClone(r)]));
    for (const input of proposal.create) {
        if(skipped.has(input.id))continue;
        if (after.has(input.id))
            throw new Error(`Knowledge ID already exists: ${input.id}`);
        assertEnglishProse([input.title, input.content], 'Lifecycle knowledge');
        const { layer, ...fields } = input;
        const item: KnowledgeItem = { ...fields, status: 'active', createdAt, updatedAt: createdAt, sourceSessions: input.sourceSessions ?? [], derivedFrom: input.derivedFrom ?? [], supersedes: [], related: input.related ?? [], relations: [] };
        const sources=proposal.links.filter(l=>l.from===item.id).flatMap(l=>before.has(l.to)?[before.get(l.to)!.item]:[]);
        Object.assign(item,withApplicability(inferredKnowledge(item),input.applicability??(sources[0]?applicabilityOf(sources[0]):{kind:'legacy'})),{version:3});
        inheritKnowledgePolicy(item, proposal.links.filter(link => link.from === item.id).flatMap(link => before.has(link.to) ? [before.get(link.to)!.item] : []));
        Object.assign(item, evaluateKnowledgeTransition(root,item,undefined,{sources:proposal.links.filter(link=>link.from===item.id).flatMap(link=>before.has(link.to)?[before.get(link.to)!.item]:[])}).item);
        const parsed = parseKnowledge(renderKnowledge(item), `${item.id}.md`);
        if (parsed.title !== item.title || parsed.content !== item.content) throw new Error('Lifecycle formatting would alter semantic content; revise title/body explicitly');
        after.set(item.id, { item:parsed, layer, path: `${layer === 'local' ? 'local/' : ''}memory/${item.id}.md`, revision: '', storage: 'current' });
    }
    for (const link of proposal.links) {
        if(skipped.has(link.from))continue;
        const newer = after.get(link.from), older = after.get(link.to);
        if (!newer || !older)
            throw new Error('Missing knowledge ID in lifecycle link');
        if (link.from === link.to)
            throw new Error('Self supersession/consolidation is forbidden');
        const exists = provenanceEdges([newer.item, older.item]).some(e => e.from === link.from && e.to === link.to && e.type === link.type);
        if (exists)
            continue;
        if (newer.storage === 'archive')
            throw new Error('Archived records are immutable provenance sources');
        if (protectedKnowledge(older.item) && !coversProtection(older.item,newer.item)) continue;
        if (link.type === 'supersedes')
            newer.item.supersedes.push(link.to);
        else
            (newer.item.relations ??= []).push({ type: 'consolidates', target: link.to });
    }
    validateGraph([...after.values()].map(r => r.item));
    const edges = provenanceEdges([...after.values()].map(r => r.item));
    const affected = new Set(proposal.links.map(l => l.to));
    const archiving = new Set(proposal.archive);
    for (const id of new Set([...affected, ...archiving])) {
        if(preserved.has(id))continue;
        const record = after.get(id);
        if (!record)
            throw new Error(`Missing knowledge ID: ${id}`);
        if (record.storage === 'archive')
            continue;
        const incoming = edges.filter(e => e.to === id);
        // Local provenance may reference Versioned sources without publishing a mutation to them.
        if (incoming.length && (record.layer === 'local' || archiving.has(id))) {
            if (incoming.some(e => e.type === 'supersedes')) record.item.status = 'superseded';
            else if (record.item.status === 'active') record.item.status = 'consolidated';
            // Consolidation must not erase an existing supersession, deprecation or dispute.
        }
        if (archiving.has(id)) {
            if (protectedKnowledge(record.item) && (record.item.status === 'active' || record.item.status === 'disputed')) continue;
            if (record.item.status === 'active' || record.item.status === 'disputed')
                throw new Error('Only historical knowledge can be archived');
            record.item.archivedAt = createdAt;
            record.path = knowledgeArchivePath(record.layer, createdAt, id);
            record.storage = 'archive';
        }
    }
    const changes: KnowledgeLifecyclePreview['changes'] = [];
    for (const [id, record] of after) {
        const original = before.get(id);
        if (original && original.path === record.path && JSON.stringify(original.item) === JSON.stringify(record.item))
            continue;
        record.item.updatedAt = createdAt;
        const text = renderKnowledge(record.item);
        parseKnowledge(text, `${id}.md`);
        changes.push({ id, layer: record.layer, from: original?.path ?? null, to: record.path, before: original?.revision ?? null, after: text });
    }
    changes.sort((a, b) => a.id.localeCompare(b.id));
    const value = { version: 1 as const, proposal, createdAt, inventoryHash: inventoryHash(records), changes, versionedChanges: changes.filter(c => c.layer === 'versioned').map(c => c.id) };
    return { ...value, planId: digest(value) };
}
const withLifecycleLock = <T>(root: string, operation: () => Promise<T>) => ownsSyncLock(root) ? operation() : withSyncLock(root, operation);
/** Recover pending work under the writer lock, then prepare a plan without applying it. */
export async function previewKnowledgeLifecycle(root: string, input: KnowledgeLifecycleProposal, createdAt = new Date().toISOString()): Promise<KnowledgeLifecyclePreview> {
    const proposal = proposalSchema.parse(input);
    return withLifecycleLock(root, async () => {
        await assertCompatibleProject(root);
        await recoverSyncTransaction(root);
        return plan(root, await readKnowledgeInventory(root), proposal, createdAt);
    });
}
/** Only Core chooses paths and writes. Versioned writes require the exact reviewed preview. */
export async function applyKnowledgeLifecycle(root: string, preview: KnowledgeLifecyclePreview, review: {
    approvedVersioned?: boolean;
    reviewedPlanId?: string;
    transformationPreviewId?: string;
} = {}) {
    return withLifecycleLock(root, async () => {
        await assertCompatibleProject(root);
        await recoverSyncTransaction(root);
        const proposal = proposalSchema.parse(preview.proposal), proposalHash = digest(proposal);
        const { planId, ...value } = preview;
        if (preview.version !== 1 || digest(value) !== planId)
            throw new Error('Lifecycle preview was modified');
        const checkpoints = await listCheckpoints(root);
        const receipt = checkpoints.find(c => c.lifecycle?.operationId === proposal.operationId);
        if (receipt) {
            if (receipt.lifecycle?.planId !== planId || receipt.lifecycle.proposalHash !== proposalHash || receipt.lifecycle.transformationPreviewId !== review.transformationPreviewId)
                throw new Error('Lifecycle operation ID already used by a different plan');
            return { checkpoint: receipt.id, alreadyApplied: true, changed: receipt.createdMemory.length + receipt.updatedMemory.length };
        }
        const records = await readKnowledgeInventory(root);
        if (inventoryHash(records) !== preview.inventoryHash)
            throw new Error('Stale lifecycle preview: knowledge changed; prepare a new preview');
        if (proposal.archive.length && preview.createdAt.slice(0, 7) !== new Date().toISOString().slice(0, 7))
            throw new Error('Stale archive month: prepare a new lifecycle preview');
        const computed = plan(root, records, proposal, preview.createdAt);
        if (computed.planId !== planId)
            throw new Error('Lifecycle preview does not match the validated proposal');
        if (computed.versionedChanges.length && (!review.approvedVersioned || review.reviewedPlanId !== planId))
            throw new Error('Versioned lifecycle changes require approval of this exact reviewed preview');
        const writes: PlannedWrite[] = [], moves: PlannedMove[] = [];
        for (const c of computed.changes) {
            const moving = c.from !== null && c.from !== c.to;
            writes.push({ path: c.to, before: moving ? null : c.before, after: c.after });
            if (moving)
                moves.push({ from: c.from!, to: c.to, before: c.before! });
        }
        const checkpoint: Checkpoint = {
            id: sortableId('chk'), createdAt: new Date().toISOString(),
            previousCheckpoint: checkpoints.at(-1)?.id ?? null, sessions: [], consolidation: 'not-performed',
            createdMemory: computed.changes.filter(c => !c.from).map(c => c.id), updatedMemory: computed.changes.filter(c => c.from).map(c => c.id),
            supersededMemory: computed.changes.filter(c => parseKnowledge(c.after, `${c.id}.md`).status === 'superseded').map(c => c.id), duplicateMemory: [], conflicts: [],
            summary: { sessions: 0, candidates: 0, created: computed.changes.filter(c => !c.from).length, consolidated: 0, duplicates: 0, superseded: 0, conflicts: 0 },
            lifecycle: { operationId: proposal.operationId, planId, proposalHash, ...(review.transformationPreviewId ? { transformationPreviewId: review.transformationPreviewId } : {}) },
        };
        writes.push({ path: `checkpoints/${checkpoint.id}.json`, before: null, after: JSON.stringify(checkpoint, null, 2) + '\n' });
        await commitSyncTransaction(root, writes, { moves });
        return { checkpoint: checkpoint.id, alreadyApplied: false, changed: computed.changes.length };
    });
}
