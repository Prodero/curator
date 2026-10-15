import { readConfig } from './storage.js';
/** Temporary evidence packaging only. No prompt, proposal, writer or provider. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { getMemoryIntelligenceCandidate } from './memory-intelligence.js';
import { parseKnowledge } from './memory.js';
import { checkedDataPath, sha256 } from './storage.js';
import { estimateTokens, TOKEN_COUNT_METHOD } from './telemetry.js';
import type { KnowledgeItem, KnowledgeLayer } from './types.js';
export const MEMORY_TRANSFORMATION_BUNDLE_LIMITS = { activeSources: 24, historicalSources: 8, provenanceEdges: 128, totalTokens: 32768, totalBytes: 131072, evidenceTokens: 12000 } as const;
const limitsSchema = z.object({
    activeSources: z.number().int().min(1).max(24).default(24), historicalSources: z.number().int().min(0).max(8).default(8),
    provenanceEdges: z.number().int().min(0).max(128).default(128), totalTokens: z.number().int().min(2048).max(32768).default(32768),
    totalBytes: z.number().int().min(8192).max(131072).default(131072), evidenceTokens: z.number().int().min(1).max(12000).default(12000),
}).strict();
export interface BundleOptions {
    expectedCandidateRevision?: string;
    limits?: z.input<typeof limitsSchema>;
}
export interface BundleSource {
    role: 'active_source' | 'historical_provenance';
    id: string;
    layer: KnowledgeLayer;
    path: string;
    revision: string;
    lifecycle: {
        storage: 'current' | 'archive';
        current: boolean;
        status: KnowledgeItem['status'];
        archivedAt: string | null;
    };
    protected: boolean;
    knowledge: KnowledgeItem;
    /** Exact canonical UTF-8 file text; parsed content above follows the existing parser. */
    sourceMarkdown: string;
}
const protectedCategories = ['instruction', 'principle', 'invariant', 'constraint', 'decision'] as const;
const sortIds = (ids: Iterable<string>) => [...new Set(ids)].sort();
const encodedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
/** One current planner candidate; no unrequested neighbors or recursive archive bodies. */
export async function buildMemoryTransformationBundle(root: string, candidateId: string, options: BundleOptions = {}) {
    const limits = limitsSchema.parse(options.limits ?? {});
    const current = await getMemoryIntelligenceCandidate(root, candidateId);
    if (options.expectedCandidateRevision && options.expectedCandidateRevision !== current.revision)
        throw new Error('Stale memory candidate revision');
    const { candidate, sourceIds, provenance, locations } = current;
    const activeIds = new Set(sourceIds), locationById = new Map(locations.map(r => [r.id, r]));
    const historicalIds = sortIds(provenance.filter(e => activeIds.has(e.from) && !activeIds.has(e.to)).map(e => e.to));
    const loaded = new Map<string, BundleSource>();
    const load = async (id: string, role: BundleSource['role']) => {
        const location = locationById.get(id);
        if (!location)
            return null;
        const text = await fs.readFile(await checkedDataPath(root, location.path), 'utf8');
        const knowledge = parseKnowledge(text, path.basename(location.path), (await readConfig(root))?.knowledgeSchemaVersion);
        if (knowledge.id !== id)
            throw new Error('Knowledge identity changed while building bundle');
        if (role === 'active_source' && (location.storage !== 'current' || knowledge.archivedAt || !['active', 'disputed'].includes(knowledge.status)))
            throw new Error('Stale active bundle source');
        const record: BundleSource = { role, id, layer: location.layer, path: location.path, revision: sha256(text), lifecycle: { storage: location.storage, current: role === 'active_source', status: knowledge.status, archivedAt: knowledge.archivedAt ?? null },
            protected: (protectedCategories as readonly string[]).includes(knowledge.category), knowledge, sourceMarkdown: text };
        loaded.set(id, record);
        return record;
    };
    const evidenceFits = estimateTokens(JSON.stringify(candidate.evidence)) <= limits.evidenceTokens;
    const bundle = {
        version: 1 as const, bundleId: 'bundle_' + '0'.repeat(64), candidateId, status: 'ready' as 'ready' | 'bundle_truncated' | 'requires_split', readyForSemanticWork: true,
        limits, sourceIds, activeSources: [] as BundleSource[], historicalSources: [] as BundleSource[],
        planner: { revision: current.revision, policy: current.policy, coverage: current.coverage,
            label: candidate.label, recordCount: candidate.recordCount, signals: candidate.signals, priority: candidate.priority, counts: candidate.counts, layers: candidate.layers, categories: candidate.categories,
            containsProtectedKnowledge: candidate.containsProtectedKnowledge, reconciliation: candidate.reconciliation, truncated: candidate.truncated, evidence: evidenceFits ? candidate.evidence : null },
        protection: { categories: protectedCategories, policy: 'conservative_handling_required' as const, transformationAuthorized: false as const },
        provenance: { bodyExpansionDepth: 1, edges: provenance.slice(0, limits.provenanceEdges), edgesDropped: Math.max(0, provenance.length - limits.provenanceEdges), referenceOnlyIds: [] as string[] },
        omissions: { activeSourceIds: [] as string[], historicalSourceIds: [] as string[], missingHistoricalIds: [] as string[], plannerEvidence: !evidenceFits, reasons: [] as string[] },
        revisions: { active: {} as Record<string, string>, historical: {} as Record<string, string> },
        size: { bytes: 0, estimatedTokens: 0, tokenCountMethod: TOKEN_COUNT_METHOD, estimated: true },
    };
    // Reserve envelope accounting/digest space. All serialized metadata and escaped bodies count.
    const fits = () => encodedBytes(bundle) + 256 <= Math.min(limits.totalBytes, limits.totalTokens * 4);
    if (sourceIds.length > limits.activeSources)
        bundle.omissions.reasons.push('active_record_limit');
    if (!evidenceFits)
        bundle.omissions.reasons.push('planner_evidence_limit');
    if (!bundle.omissions.reasons.length) {
        for (const id of sourceIds) {
            const record = await load(id, 'active_source');
            if (!record)
                throw new Error(`Missing active bundle source: ${id}`);
            bundle.activeSources.push(record);
            bundle.revisions.active[id] = record.revision;
            if (!fits()) {
                bundle.omissions.reasons.push('active_content_budget');
                break;
            }
        }
    }
    if (bundle.omissions.reasons.length) {
        // An incomplete active cluster is never handed out as a usable semantic package.
        bundle.activeSources = [];
        bundle.revisions.active = {};
        bundle.omissions.activeSourceIds = [...sourceIds];
        bundle.status = 'requires_split';
    }
    else {
        for (const id of historicalIds) {
            if (bundle.historicalSources.length >= limits.historicalSources) {
                bundle.omissions.historicalSourceIds.push(id);
                continue;
            }
            const record = await load(id, 'historical_provenance');
            if (!record) {
                bundle.omissions.historicalSourceIds.push(id);
                bundle.omissions.missingHistoricalIds.push(id);
                continue;
            }
            bundle.historicalSources.push(record);
            bundle.revisions.historical[id] = record.revision;
            if (!fits()) {
                bundle.historicalSources.pop();
                delete bundle.revisions.historical[id];
                bundle.omissions.historicalSourceIds.push(id);
            }
        }
    }
    if (bundle.status === 'requires_split')
        bundle.omissions.historicalSourceIds = [...historicalIds];
    const included = new Set([...bundle.activeSources, ...bundle.historicalSources].map(r => r.id));
    bundle.provenance.referenceOnlyIds = sortIds(bundle.provenance.edges.flatMap(e => [e.from, e.to]).filter(id => !included.has(id)));
    if (bundle.omissions.historicalSourceIds.length)
        bundle.omissions.reasons.push('direct_history_incomplete');
    if (bundle.provenance.edgesDropped)
        bundle.omissions.reasons.push('provenance_edge_limit');
    if (bundle.status !== 'requires_split' && bundle.omissions.reasons.length)
        bundle.status = 'bundle_truncated';
    bundle.readyForSemanticWork = bundle.status === 'ready';
    // Omission manifests/metadata also consume space. Never escape the total budget with them.
    if (!fits()) {
        bundle.status = 'requires_split';
        bundle.readyForSemanticWork = false;
        bundle.activeSources = [];
        bundle.historicalSources = [];
        bundle.revisions = { active: {}, historical: {} };
        bundle.omissions.activeSourceIds = [...sourceIds];
        bundle.omissions.historicalSourceIds = [...historicalIds];
        bundle.omissions.reasons.push('envelope_budget');
        bundle.provenance.referenceOnlyIds = sortIds(bundle.provenance.edges.flatMap(e => [e.from, e.to]));
        if (bundle.planner.evidence) {
            bundle.planner.evidence = null;
            bundle.omissions.plannerEvidence = true;
        }
        if (!fits())
            throw new Error('BUNDLE_MANIFEST_TOO_LARGE: candidate IDs/metadata cannot fit the bounded diagnostic; candidate requires splitting. No bundle produced.');
    }
    const fresh = await getMemoryIntelligenceCandidate(root, candidateId);
    if (fresh.revision !== current.revision)
        throw new Error('Memory candidate changed during bundle construction; retry');
    for (const record of loaded.values())
        if (sha256(await fs.readFile(await checkedDataPath(root, record.path), 'utf8')) !== record.revision)
            throw new Error('Knowledge changed during bundle construction; retry');
    bundle.bundleId = bundleDigest(bundle);
    for (let i = 0; i < 4; i++) {
        const bytes = encodedBytes(bundle);
        const tokens = Math.ceil(bytes / 4);
        if (bundle.size.bytes === bytes && bundle.size.estimatedTokens === tokens)
            break;
        bundle.size.bytes = bytes;
        bundle.size.estimatedTokens = tokens;
    }
    if (bundle.size.bytes > limits.totalBytes || bundle.size.estimatedTokens > limits.totalTokens)
        throw new Error('Bundle exceeds total envelope budget');
    return bundle;
}
export type MemoryTransformationBundle = Awaited<ReturnType<typeof buildMemoryTransformationBundle>>;
function bundleDigest(bundle: Omit<MemoryTransformationBundle, 'bundleId' | 'size'> & {
    bundleId?: string;
    size?: unknown;
}) {
    const { bundleId: _, size: __, ...payload } = bundle;
    return `bundle_${sha256(JSON.stringify(payload))}`;
}
/** Read-only validity check; hashes are revision tokens, not publication authorization. */
export async function validateMemoryTransformationBundle(root: string, bundle: MemoryTransformationBundle) {
    if (bundle.version !== 1 || bundleDigest(bundle) !== bundle.bundleId || encodedBytes(bundle) !== bundle.size.bytes || Math.ceil(encodedBytes(bundle) / 4) !== bundle.size.estimatedTokens)
        return { valid: false, reason: 'modified_bundle' as const };
    const fresh = await buildMemoryTransformationBundle(root, bundle.candidateId, { limits: bundle.limits });
    return fresh.bundleId === bundle.bundleId ? { valid: true, reason: 'current' as const } : { valid: false, reason: 'stale_evidence' as const };
}
