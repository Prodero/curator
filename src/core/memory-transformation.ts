import fs from 'node:fs/promises';
/** Explicit, approved semantic transformation. No agent filesystem operations or automatic caller. */
import { z } from 'zod';
import { buildMemoryTransformationBundle } from './memory-transformation-bundle.js';
import { validateMemoryTransformationProposal, type MemoryTransformationProposal } from './memory-transformation-proposal.js';
import { previewKnowledgeLifecycle, applyKnowledgeLifecycle, type KnowledgeLifecycleProposal } from './knowledge-lifecycle.js';
import { listCheckpoints, sha256 } from './storage.js';
import { withSyncLock, ownsSyncLock } from './sync-transaction.js';

const withTransformationLock: typeof withSyncLock = (root, operation, options) => ownsSyncLock(root) ? operation() : withSyncLock(root, operation, options);
const digest = (value: unknown) => sha256(JSON.stringify(value));
const unique = (values: string[]) => [...new Set(values)].sort();
export type ValidatedMemoryTransformationProposal = Awaited<ReturnType<typeof validateMemoryTransformationProposal>>;

async function buildPreview(root: string, input: MemoryTransformationProposal, createdAt: string) {
    // Called under the writer capability: no race between semantic validation and lifecycle planning.
    const validated = await validateMemoryTransformationProposal(root, input);
    const bundle = await buildMemoryTransformationBundle(root, validated.proposal.candidateId);
    const { proposal, proposalId } = validated;
    const sources = new Map([...bundle.activeSources, ...bundle.historicalSources].map(s => [s.id, s]));
    const ids = Object.fromEntries(proposal.records.map(r => [r.key, `mem_${sha256(`${proposalId}:${r.key}`).slice(0,40)}`]));
    const replacing = proposal.dispositions.filter(d => d.action === 'consolidate' || d.action === 'supersede');
    const create: NonNullable<KnowledgeLifecycleProposal['create']> = proposal.records.map(r => {

        const replaced = replacing.filter(d => d.proposedKeys.includes(r.key));
        const layer = replaced.some(d => sources.get(d.sourceId)!.layer === 'versioned') ? 'versioned' as const : 'local' as const;
        const evidence = r.sourceIds.map(id => sources.get(id)!.knowledge);
        return { id: ids[r.key], layer, category: r.category, title: r.title, content: r.body, priority: r.priority,
            ...(r.applicability?{applicability:r.applicability}:{}),
            ...(r.scope === 'global' ? { scope: 'global' as const, scopeRef: null } : r.scope === 'path'
                ? { scope: 'module' as const, scopeKind: 'path' as const, scopeRef: r.path! }
                : { scope: 'global' as const, scopeRef: null }),
            related: r.sourceIds, sourceSessions: unique(evidence.flatMap(s => s.sourceSessions)), derivedFrom: unique([...r.sourceIds, ...evidence.flatMap(s => s.derivedFrom)]) };
    });
    const links = replacing.flatMap(d => d.proposedKeys.map(key => ({ from: ids[key], to: d.sourceId, type: d.action === 'supersede' ? 'supersedes' as const : 'consolidates' as const })));
    const lifecycle = await previewKnowledgeLifecycle(root, {
        operationId: `transform_${proposalId.slice('proposal_'.length)}`,
        expectedRevisions: { ...proposal.sourceRevisions.active, ...proposal.sourceRevisions.historical },
        create, links, archive: replacing.map(d => d.sourceId),
    }, createdAt);
    const limitations = {
        semanticLosslessnessVerified: false as const,
        warning: 'Core validates structure, provenance and revisions, not semantic losslessness.',
        warnings: proposal.warnings, additionalEvidenceRequired: proposal.additionalEvidenceRequired,
        unresolved: proposal.dispositions.filter(d => d.action === 'unresolved').map(d => ({ id: d.sourceId, information: d.unresolvedInformation, rationale: d.rationale })),
        omittedAsRedundant: proposal.dispositions.filter(d => d.omittedAsRedundant.length).map(d => ({ id: d.sourceId, information: d.omittedAsRedundant })),
    };
    const requiresSemanticReview = Boolean(limitations.warnings.length || limitations.additionalEvidenceRequired.length || limitations.unresolved.length || limitations.omittedAsRedundant.length);
    const archives = lifecycle.changes.filter(c => c.from && c.from !== c.to).map(c => ({ id: c.id, layer: c.layer, from: c.from!, to: c.to }));
    const versionedEffects = lifecycle.changes.filter(c => c.layer === 'versioned').map(c => ({ id: c.id, action: c.from ? proposal.dispositions.find(d => d.sourceId === c.id)!.action : 'create', from: c.from, to: c.to }));
    const summary = { label: bundle.planner.label,
        created: create.filter(c=>lifecycle.changes.some(change=>change.id===c.id)).map(c => ({ id: c.id, key: proposal.records.find(r => ids[r.key] === c.id)!.key, layer: c.layer, category: c.category, scope: proposal.records.find(r => ids[r.key] === c.id)!.scope, scopeRef: c.scopeRef, priority: c.priority })),
        consolidated: proposal.dispositions.filter(d => d.action === 'consolidate' && lifecycle.changes.some(c=>c.id===d.sourceId)).map(d => d.sourceId),
        superseded: proposal.dispositions.filter(d => d.action === 'supersede' && lifecycle.changes.some(c=>c.id===d.sourceId)).map(d => d.sourceId),
        kept: proposal.dispositions.filter(d => d.action === 'keep').map(d => d.sourceId),
        unresolved: proposal.dispositions.filter(d => d.action === 'unresolved').map(d => d.sourceId),
        archives, provenance: links, evidenceReferences: create.map(c => ({ id: c.id, sourceIds: c.related! })),
        estimatedTokens: validated.review.estimatedTokens, historicalEvidencePreserved: true as const,
        protectedSources: validated.review.protectedSources,
    };
    const payload = { version: 1 as const, root: await fs.realpath(root), proposalId, proposal, candidateId: proposal.candidateId, bundleId: proposal.bundleId,
        createdAt, draftIds: ids, lifecycle, summary, limitations, versionedEffects,
        requiresVersionedReview: versionedEffects.length > 0, requiresSemanticReview,
        localDirectApplyEligible: !versionedEffects.length && !requiresSemanticReview,
        authorization: 'explicit_workflow_and_exact_preview_required' as const };
    return { ...payload, previewId: digest(payload) };
}
export type MemoryTransformationPreview = Awaited<ReturnType<typeof buildPreview>>;
/** Preview is never approval. It refuses interrupted lifecycle journals rather than recovering them. */
export async function previewMemoryTransformation(root: string, validated: ValidatedMemoryTransformationProposal): Promise<MemoryTransformationPreview> {
    return withTransformationLock(root, async () => {
        const preview = await buildPreview(root, validated.proposal, new Date().toISOString());
        if (preview.proposalId !== validated.proposalId) throw new Error('Validated proposal identity mismatch');
        return preview;
    }, { recoverLifecycle: false });
}
const approvalSchema = z.object({
    initiatedByUser: z.literal(true), reviewedPreviewId: z.string().regex(/^[a-f0-9]{64}$/),
    approvedVersioned: z.boolean().optional(), approvedSemanticLimitations: z.boolean().optional(),
}).strict();
export type MemoryTransformationApproval = z.infer<typeof approvalSchema>;
/** Revalidate under the same lock as apply. Exact committed receipts are the sole stale-check exception. */
export async function applyMemoryTransformation(root: string, preview: MemoryTransformationPreview, input: MemoryTransformationApproval) {
    const approval = approvalSchema.parse(input);
    const { previewId, ...payload } = preview;
    if (preview.version !== 1 || digest(payload) !== previewId) throw new Error('Transformation preview was modified');
    if (await fs.realpath(root) !== preview.root) throw new Error('Transformation preview belongs to another project');
    if (approval.reviewedPreviewId !== previewId) throw new Error('Approval must bind this exact transformation preview');
    if (preview.requiresVersionedReview && !approval.approvedVersioned) throw new Error('Explicit Versioned approval required');
    if (preview.requiresSemanticReview && !approval.approvedSemanticLimitations) throw new Error('Semantic limitations require explicit review');
    return withTransformationLock(root, async () => {
        const receipt = (await listCheckpoints(root)).find(c => c.lifecycle?.operationId === preview.lifecycle.proposal.operationId);
        if (!receipt) {
            const fresh = await buildPreview(root, preview.proposal, preview.createdAt);
            if (fresh.previewId !== previewId) throw new Error('Stale or mismatched transformation/lifecycle preview');
        } else if (receipt.lifecycle?.transformationPreviewId !== previewId) {
            throw new Error('Transformation operation already committed with another preview');
        }
        const result = await applyKnowledgeLifecycle(root, preview.lifecycle, {
            approvedVersioned: approval.approvedVersioned, reviewedPlanId: preview.lifecycle.planId, transformationPreviewId: previewId,
        });
        return { version: 1 as const, previewId, proposalId: preview.proposalId, ...result,
            summary: preview.summary, limitations: preview.limitations, requiresVersionedReview: preview.requiresVersionedReview,
            historicalEvidencePreserved: true as const, applied: true as const };
    });
}
