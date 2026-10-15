import { readConfig } from './storage.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseKnowledge } from './memory.js';
import { assertCompatibleProject, assertLifecycleReadable, knowledgeReadFence, canonicalId, checkedDataPath, exists, sha256 } from './storage.js';
import type { KnowledgeItem, KnowledgeLayer } from './types.js';
export type ProvenanceKind = 'supersedes' | 'consolidates';
export interface ProvenanceEdge {
    from: string;
    to: string;
    type: ProvenanceKind;
}
export interface LocatedKnowledge {
    item: KnowledgeItem;
    layer: KnowledgeLayer;
    path: string;
    revision: string;
    storage: 'current' | 'archive';
}
export const archiveBucket = (at: string) => {
    if (!Number.isFinite(Date.parse(at)))
        throw new Error('Invalid archive timestamp');
    return new Date(at).toISOString().slice(0, 7).replace('-', '_');
};
export const knowledgeArchivePath = (layer: KnowledgeLayer, at: string, id: string) => {
    canonicalId(id, 'archive');
    return `${layer === 'local' ? 'local/' : ''}archive/${archiveBucket(at)}/${id}.md`;
};
/** Enumerate paths only. Ordinary retrieval never loads archive bodies. */
export async function listArchivePaths(root: string): Promise<Array<{
    path: string;
    layer: KnowledgeLayer;
    id: string;
}>> {
    await assertLifecycleReadable(root);
    const entries: Array<{
        path: string;
        layer: KnowledgeLayer;
        id: string;
    }> = [];
    for (const layer of ['versioned', 'local'] as const) {
        const base = layer === 'local' ? 'local/archive' : 'archive';
        const directory = await checkedDataPath(root, base);
        if (!await exists(directory))
            continue;
        for (const bucket of (await fs.readdir(directory)).filter(n => /^\d{4}_(0[1-9]|1[0-2])$/.test(n)).sort()) {
            const dir = await checkedDataPath(root, base, bucket);
            for (const name of (await fs.readdir(dir)).filter(n => n.endsWith('.md') && !n.startsWith('.')).sort()) {
                const id = path.basename(name, '.md');
                canonicalId(id, name);
                const relative = `${base}/${bucket}/${name}`;
                await checkedDataPath(root, relative);
                entries.push({ id, path: relative, layer });
            }
        }
    }
    return entries;
}
/** Explicit ID/provenance operations, not archive-aware search or ranking. */
export async function readKnowledgeInventory(root: string, options: { storage?: 'archive' } = {}): Promise<LocatedKnowledge[]> {
    await assertCompatibleProject(root);
    const finishRead = await knowledgeReadFence(root);
    const paths: Array<{
        path: string;
        layer: KnowledgeLayer;
        id: string;
        storage: 'current' | 'archive';
    }> = (await listArchivePaths(root)).map(e => ({ ...e, storage: 'archive' }));
    for (const layer of options.storage === 'archive' ? [] : ['versioned', 'local'] as const) {
        const base = layer === 'local' ? 'local/memory' : 'memory', dir = await checkedDataPath(root, base);
        if (!await exists(dir))
            continue;
        for (const name of (await fs.readdir(dir)).filter(n => n.endsWith('.md') && !n.startsWith('.')).sort())
            paths.push({ path: `${base}/${name}`, layer, id: path.basename(name, '.md'), storage: 'current' });
    }
    const records: LocatedKnowledge[] = [], ids = new Set<string>();
    for (const entry of paths.sort((a, b) => a.path.localeCompare(b.path))) {
        const text = await fs.readFile(await checkedDataPath(root, entry.path), 'utf8'), item = parseKnowledge(text, path.basename(entry.path), (await readConfig(root))?.knowledgeSchemaVersion);
        if (ids.has(item.id))
            throw new Error(`Duplicate knowledge ID across storage locations: ${item.id}`);
        ids.add(item.id);
        if (entry.storage === 'archive' && (!item.archivedAt || knowledgeArchivePath(entry.layer, item.archivedAt, item.id) !== entry.path))
            throw new Error(`Archive metadata/path mismatch: ${item.id}`);
        records.push({ ...entry, item, revision: sha256(text) });
    }
    await finishRead();
    return records;
}
export function provenanceEdges(items: Pick<KnowledgeItem, 'id' | 'supersedes' | 'relations'>[]): ProvenanceEdge[] {
    const edges = new Map<string, ProvenanceEdge>();
    const add = (from: string, to: string, type: ProvenanceKind) => edges.set(`${from}\0${type}\0${to}`, { from, to, type });
    for (const item of items) {
        for (const old of item.supersedes)
            add(item.id, old, 'supersedes');
        for (const r of item.relations ?? []) {
            if (r.type === 'supersedes' || r.type === 'consolidates')
                add(item.id, r.target, r.type);
            if (r.type === 'superseded_by')
                add(r.target, item.id, 'supersedes');
            if (r.type === 'consolidated_into')
                add(r.target, item.id, 'consolidates');
        }
    }
    return [...edges.values()].sort((a, b) => a.from.localeCompare(b.from) || a.type.localeCompare(b.type) || a.to.localeCompare(b.to));
}
export async function getKnowledgeProvenance(root: string, id: string) {
    canonicalId(id, 'knowledge lookup');
    const records = await readKnowledgeInventory(root), record = records.find(r => r.item.id === id);
    if (!record)
        throw new Error(`Knowledge ${id} was not found`);
    const edges = provenanceEdges(records.map(r => r.item)), incoming = edges.filter(e => e.to === id), outgoing = edges.filter(e => e.from === id);
    const supersededBy = incoming.filter(e => e.type === 'supersedes').map(e => e.from), consolidatedInto = incoming.filter(e => e.type === 'consolidates').map(e => e.from);
    return { ...record, current: record.storage === 'current' && record.item.status === 'active' && !incoming.length,
        supersedes: outgoing.filter(e => e.type === 'supersedes').map(e => e.to), superseded_by: supersededBy,
        consolidates: outgoing.filter(e => e.type === 'consolidates').map(e => e.to), consolidated_into: consolidatedInto };
}
