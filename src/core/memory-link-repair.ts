/** Explicit Sync review of dangling canonical links. Never guesses replacement knowledge. */
import fs from 'node:fs/promises';
import { loadKnowledgeGraph } from './knowledge-graph.js';
import { readKnowledgeInventory } from './knowledge-provenance.js';
import { renderKnowledge } from './memory.js';
import { listCheckpoints, sha256 } from './storage.js';
import { commitSyncTransaction, ownsSyncLock } from './sync-transaction.js';
import type { Checkpoint } from './types.js';

const digest = (value: unknown) => sha256(JSON.stringify(value));
export async function previewMemoryLinkRepair(root: string, createdAt = new Date().toISOString()) {
  const graph = await loadKnowledgeGraph(root, undefined, { persistCache: false });
  const broken = new Set(graph.brokenReferences);
  const inventory = await readKnowledgeInventory(root);
  // Bound each exact review; remaining links are offered by the next Sync.
  const changes = inventory.filter(r => r.storage === 'current').flatMap(r => {
    const links = new Map<string, { type: string; target: string }>();
    const missing = (type: string, target: string) => {
      if (!broken.has(`${r.item.id}:${type}:${target}`)) return false;
      links.set(`${type}:${target}`, { type, target }); return true;
    };
    const after = { ...r.item, version: 3 as const, applicability: r.item.applicability ?? { kind: 'legacy' as const }, updatedAt: createdAt,
      supersedes: r.item.supersedes.filter(target => !missing('supersedes', target)),
      related: r.item.related.filter(target => !missing('related_to', target)),
      relations: (r.item.relations ?? []).filter(link => !missing(link.type, link.target)),
    };
    return links.size ? [{ id: r.item.id, title: r.item.title, layer: r.layer, path: r.path,
      before: r.revision, original: r.item, after: renderKnowledge(after), links: [...links.values()] }] : [];
  }).slice(0, 100);
  const count = changes.reduce((n, c) => n + c.links.length, 0);
  const payload = { root: await fs.realpath(root), createdAt, changes, count,
    remaining: broken.size - count, requiresVersionedReview: changes.some(c => c.layer === 'versioned') };
  return { ...payload, previewId: digest(payload) };
}
export type MemoryLinkRepairPreview = Awaited<ReturnType<typeof previewMemoryLinkRepair>>;

/** Called only under Sync's lock, after its exact review approval has been persisted. */
export async function applyMemoryLinkRepair(root: string, preview: MemoryLinkRepairPreview, approved: boolean) {
  if (!ownsSyncLock(root) || !approved) throw new Error('Link repair requires a locked, approved exact review');
  const { previewId, ...payload } = preview;
  if (digest(payload) !== previewId || preview.root !== await fs.realpath(root)) throw new Error('Link repair preview mismatch');
  const checkpoint = `chk_link_repair_${previewId}`;
  const checkpoints = await listCheckpoints(root);
  const receipt = checkpoints.find(c => c.id === checkpoint);
  if (receipt) {
    if (receipt.note !== `Approved link repair ${previewId}`) throw new Error('Link repair receipt mismatch');
  } else {
    const fresh = await previewMemoryLinkRepair(root, preview.createdAt);
    if (fresh.previewId !== previewId) throw new Error('Stale link repair preview; knowledge changed');
    const record: Checkpoint = { id: checkpoint, createdAt: preview.createdAt,
      previousCheckpoint: checkpoints.at(-1)?.id ?? null, sessions: [], consolidation: 'not-performed',
      knowledgeBefore: preview.changes.map(c => c.original), createdMemory: [],
      updatedMemory: preview.changes.map(c => c.id), supersededMemory: [], duplicateMemory: [], conflicts: [],
      summary: { sessions: 0, candidates: 0, created: 0, consolidated: 0, duplicates: 0, superseded: 0, conflicts: 0 },
      note: `Approved link repair ${previewId}` };
    await commitSyncTransaction(root, [
      ...preview.changes.map(c => ({ path: c.path, before: c.before, after: c.after })),
      { path: `checkpoints/${checkpoint}.json`, before: null, after: JSON.stringify(record, null, 2) + '\n' },
    ], { policyMode: 'exact' });
  }
  return { checkpoint, fixed: preview.count, remaining: preview.remaining,
    revisions: preview.changes.map(c => ({ path: c.path, hash: sha256(c.after) })) };
}
