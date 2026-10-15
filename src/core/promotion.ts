import {applicabilitySchema,sameApplicability} from "./applicability.js";
import { CONTEXT_POLICIES, KNOWLEDGE_AUTHORITIES } from "./knowledge-policy.js";
import { reconcileCandidate } from './reconciliation.js';
import { assertNoSecrets } from "./secrets.js";
import { z } from "zod";
import { buildIndex } from "./index.js";
import { intelligenceTelemetry, type IntelligenceProvider, type KnowledgeCandidate } from "./intelligence.js";
import { sortableId } from "./ids.js";
import { loadMemoryCatalog, type KnowledgeSummary } from "./memory-index.js";
import { tokens } from "./matching.js";
import { renderKnowledge } from "./memory.js";
import { exactKnowledge, isExtractivelyGrounded } from "./semantic-safety.js";
import { listCheckpoints, sha256 } from "./storage.js";
import { commitSyncTransaction, fileHash, recoverSyncTransaction, safeProjectPath, withSyncLock, ownsSyncLock, type PlannedWrite } from "./sync-transaction.js";
import type { Checkpoint, KnowledgeItem } from "./types.js";

const dispositionSchema = z.enum(["new", "merge", "supersede", "covered", "conflict"]);
const revisionSchema = z.object({ id: z.string(), layer: z.enum(["local", "versioned"]), path: z.string(), hash: z.string() }).strict();
const itemSchema = z.object({
  applicability:applicabilitySchema.optional(),version: z.union([z.literal(1),z.literal(2),z.literal(3)]).optional(), contextPolicy: z.enum(CONTEXT_POLICIES).optional(), authority: z.enum(KNOWLEDGE_AUTHORITIES).optional(),
  kind: z.literal("instruction").optional(), enforcement: z.enum(CONTEXT_POLICIES).optional(),
  archivedAt: z.string().optional(),
  id: z.string(), scope: z.enum(["global", "module", "task"]), scopeRef: z.string().nullable(), scopeKind: z.enum(["path", "topic"]).optional(),
  category: z.enum(["principle", "invariant", "decision", "constraint", "lesson", "state", "instruction"]),
  priority: z.enum(["critical", "important", "normal", "contextual"]), status: z.enum(["active", "superseded", "deprecated", "consolidated", "duplicate", "disputed"]),
  title: z.string(), content: z.string(), createdAt: z.string(), updatedAt: z.string(), sourceSessions: z.array(z.string()),
  derivedFrom: z.array(z.string()), supersedes: z.array(z.string()), related: z.array(z.string()),
  relations: z.array(z.object({ type: z.enum(["related_to", "depends_on", "implements", "applies_to", "supersedes", "superseded_by", "consolidates", "consolidated_into", "contradicts", "learned_from"]), target: z.string() }).strict()).optional(),
  evidence: z.array(z.object({ kind: z.enum(["session_observation", "source_file", "test", "git_commit", "documentation", "user_instruction"]), ref: z.string() }).strict()).optional(),
}).strict();
const promotionActionSchema = z.object({
  disposition: dispositionSchema, localIds: z.array(z.string()).min(1), targetId: z.string().nullable(), before: itemSchema.nullable(), draft: itemSchema.nullable(),
  reason: z.string(), recommended: z.boolean(), recommendationSignals: z.array(z.string()),
}).strict();
export const promotionPreviewSchema = z.object({
  version: z.literal(1), previewId: z.string(), createdAt: z.string(), mode: z.enum(["deterministic", "assisted"]), notice: z.string().optional(),
  actions: z.array(promotionActionSchema), revisions: z.array(revisionSchema),
  summary: z.object({ new: z.number(), merge: z.number(), supersede: z.number(), covered: z.number(), conflict: z.number() }).strict(),
}).strict();
export type PromotionPreview = z.infer<typeof promotionPreviewSchema>;
type PromotionAction = z.infer<typeof promotionActionSchema>;

const withPromotionLock: typeof withSyncLock = (root, operation, options) => ownsSyncLock(root) ? operation() : withSyncLock(root, operation, options);
const unique = (values: string[]) => [...new Set(values)].sort();
const current = (item: Pick<KnowledgeSummary, "status">) => item.status === "active" || item.status === "disputed";
const samePolicy = (a: Pick<KnowledgeItem, "contextPolicy" | "authority">, b: Pick<KnowledgeItem, "contextPolicy" | "authority">) => a.contextPolicy === b.contextPolicy && a.authority === b.authority;
const sameBoundary = (a: Pick<KnowledgeItem, "scope" | "scopeRef" | "scopeKind" | "category" | "applicability">, b: Pick<KnowledgeItem, "scope" | "scopeRef" | "scopeKind" | "category" | "applicability">) => a.scope === b.scope && a.scopeRef === b.scopeRef && a.scopeKind === b.scopeKind && a.category === b.category && sameApplicability(a,b);
function similarity(a: KnowledgeSummary, b: KnowledgeSummary): number {
  const left = new Set(a.tokens), right = new Set(b.tokens);
  const intersection = [...left].filter((token) => right.has(token)).length;
  return intersection / Math.max(1, Math.min(left.size, right.size));
}

export function promotionSignals(local: KnowledgeSummary, versioned: KnowledgeSummary[], now = new Date()): { score: number; signals: string[]; recommended: boolean } {
  let score = 0;
  const signals: string[] = [];
  if (local.sourceSessionCount >= 2) { score += 2; signals.push(`Recurred across ${local.sourceSessionCount} sessions`); }
  if (local.priority === "critical") { score += 3; signals.push("Critical knowledge"); }
  else if (local.priority === "important") { score += 2; signals.push("Important knowledge"); }
  if (["principle", "invariant", "constraint", "instruction", "decision"].includes(local.category)) { score += 2; signals.push(`Architecturally significant ${local.category}`); }
  const ageDays = (now.getTime() - Date.parse(local.updatedAt)) / 86_400_000;
  if (Number.isFinite(ageDays) && ageDays >= 7) { score += 1; signals.push("Persisted locally for at least seven days"); }
  if (local.relations.length || local.related.length) { score += 1; signals.push("Connected to other knowledge"); }
  const covered = versioned.some((item) => sameBoundary(local as any, item as any) && samePolicy(local, item) && item.normalizedContent === local.normalizedContent);
  if (!covered) { score += 1; signals.push("Not already covered by Versioned Knowledge"); }
  return { score, signals, recommended: score >= 4 && !covered };
}

export async function promotionRecommendations(root: string, options: {persistCache?: boolean} = {}) {
  const catalog = await loadMemoryCatalog(root, options);
  const versioned = catalog.summaries.filter((item) => item.layer === "versioned" && current(item));
  return catalog.summaries.filter((item) => item.layer === "local" && current(item)).map((item) => ({ id: item.id, title: item.title, ...promotionSignals(item, versioned) }))
    .sort((a, b) => Number(b.recommended) - Number(a.recommended) || b.score - a.score || a.id.localeCompare(b.id));
}

function draftFromLocal(local: KnowledgeItem, now: string, target?: KnowledgeItem): KnowledgeItem {
  return target ? {
    ...target, title: local.title, content: local.content, updatedAt: now,
    sourceSessions: unique([...target.sourceSessions, ...local.sourceSessions]), derivedFrom: unique([...target.derivedFrom, ...local.derivedFrom]),
    related: unique([...target.related, ...local.related, local.id]), relations: [...(target.relations ?? []), ...(local.relations ?? [])].filter((relation, index, all) => all.findIndex((other) => other.type === relation.type && other.target === relation.target) === index),
    evidence: [...(target.evidence ?? []), ...(local.evidence ?? [])],
  } : { ...local, id: sortableId("mem"), status: "active", createdAt: now, updatedAt: now, related: unique(local.related) };
}

function deterministicAction(local: KnowledgeItem, localSummary: KnowledgeSummary, candidates: Array<{ item: KnowledgeItem; summary: KnowledgeSummary }>, recommendation: ReturnType<typeof promotionSignals>, now: string): PromotionAction {
  const exact = candidates.find(({ item }) => sameBoundary(local, item) && samePolicy(local, item) && exactKnowledge(item.content) === exactKnowledge(local.content));
  if (exact) return { disposition: "covered", localIds: [local.id], targetId: exact.item.id, before: exact.item, draft: null, reason: "Versioned Knowledge already covers the local knowledge exactly.", recommended: recommendation.recommended, recommendationSignals: recommendation.signals };
  if (local.status === "disputed") return { disposition: "conflict", localIds: [local.id], targetId: null, before: null, draft: null, reason: "Disputed Local Knowledge requires focused human resolution before publication.", recommended: recommendation.recommended, recommendationSignals: recommendation.signals };
  const explicit = candidates.find(({ item }) => local.supersedes.includes(item.id));
  if (explicit) {
    const draft = draftFromLocal(local, now); draft.supersedes = unique([...draft.supersedes, explicit.item.id]);
    return { disposition: "supersede", localIds: [local.id], targetId: explicit.item.id, before: explicit.item, draft, reason: "The local knowledge explicitly supersedes current Versioned Knowledge.", recommended: recommendation.recommended, recommendationSignals: recommendation.signals };
  }
  const related = candidates.filter(({ item }) => sameBoundary(local, item) && samePolicy(local, item)).sort((a, b) => similarity(localSummary, b.summary) - similarity(localSummary, a.summary) || a.item.id.localeCompare(b.item.id))[0];
  if (related) {
    const score = similarity(localSummary, related.summary);
    if (exactKnowledge(related.item.content).includes(exactKnowledge(local.content))) return { disposition: "covered", localIds: [local.id], targetId: related.item.id, before: related.item, draft: null, reason: "Versioned Knowledge already contains the local observation.", recommended: recommendation.recommended, recommendationSignals: recommendation.signals };
    if (score >= 0.65 && exactKnowledge(local.content).includes(exactKnowledge(related.item.content))) return { disposition: "merge", localIds: [local.id], targetId: related.item.id, before: related.item, draft: draftFromLocal(local, now, related.item), reason: "The local observation extends an existing Versioned Knowledge item.", recommended: recommendation.recommended, recommendationSignals: recommendation.signals };
  }
  return { disposition: "new", localIds: [local.id], targetId: null, before: null, draft: draftFromLocal(local, now), reason: "No sufficiently similar Versioned Knowledge item covers this durable local knowledge.", recommended: recommendation.recommended, recommendationSignals: recommendation.signals };
}

async function assistedAction(provider: IntelligenceProvider, local: KnowledgeItem, deterministic: PromotionAction, candidates: Array<{ item: KnowledgeItem; summary: KnowledgeSummary }>, now: string): Promise<PromotionAction> {
  const localTokens = tokens(`${local.title} ${local.content} ${local.scopeRef ?? ""}`);
  const related = candidates.filter(({ item }) => sameBoundary(local, item) && samePolicy(local, item)).sort((a, b) => b.summary.tokens.filter((token) => localTokens.has(token)).length - a.summary.tokens.filter((token) => localTokens.has(token)).length || a.item.id.localeCompare(b.item.id)).slice(0, 12).map(({ item }) => item);
  const candidate: KnowledgeCandidate = { id: `candidate_${local.id}`, kind: "knowledge", title: local.title, content: local.content, category: local.category, scope: local.scope, scopeRef: local.scopeRef, scopeKind: local.scopeKind, priority: local.priority, applicability:local.applicability, sources: [local.id], evidence: [{ source: local.id, quote: local.content }], supersedes: local.supersedes };
  const telemetry = intelligenceTelemetry(provider);
  const response = await reconcileCandidate(candidate, related, provider, telemetry);
  const targetId = response.sources.find((id) => id !== candidate.id) ?? null;
  const target = targetId ? related.find((item) => item.id === targetId) : undefined;
  const base = { localIds: [local.id], recommended: deterministic.recommended, recommendationSignals: deterministic.recommendationSignals, reason: response.reason };
  if (response.action === "CREATE" && !targetId) return { ...base, disposition: "new", targetId: null, before: null, draft: draftFromLocal(local, now) };
  if (response.action === "NO_CHANGE" && target) return { ...base, disposition: "covered", targetId, before: target, draft: null };
  if (response.action === "MERGE" && target && response.canonical && sameBoundary(local, target) && sameBoundary({...response.canonical,applicability:response.canonical.applicability??target.applicability}, target) && isExtractivelyGrounded(response.canonical.content, [local.content, target.content])) {
    return { ...base, disposition: "merge", targetId, before: target, draft: { ...draftFromLocal(local, now, target), ...response.canonical } };
  }
  if (response.action === "SUPERSEDE" && target && local.supersedes.includes(target.id)) { const draft = draftFromLocal(local, now); draft.supersedes = unique([...draft.supersedes, target.id]); return { ...base, disposition: "supersede", targetId, before: target, draft }; }
  if ((response.action === "CONFLICT" || response.action === "UNCERTAIN") && target) return { ...base, disposition: "conflict", targetId, before: target, draft: null };
  if (response.action === "LINK" && target) { const draft = draftFromLocal(local, now); draft.relations = [...(draft.relations ?? []), { type: "related_to", target: target.id }]; return { ...base, disposition: "new", targetId: null, before: null, draft }; }
  return deterministic;
}

export async function previewKnowledgePromotion(root: string, options: { ids?: string[]; includeAll?: boolean; provider?: IntelligenceProvider } = {}): Promise<PromotionPreview> {
  const catalog = await loadMemoryCatalog(root);
  const localSummaries = catalog.summaries.filter((item) => item.layer === "local" && current(item));
  const versionedSummaries = catalog.summaries.filter((item) => item.layer === "versioned" && current(item));
  const recommendations = new Map(localSummaries.map((item) => [item.id, promotionSignals(item, versionedSummaries)]));
  const selected = localSummaries.filter((item) => options.ids?.length ? options.ids.includes(item.id) : options.includeAll === false ? recommendations.get(item.id)!.recommended : true);
  if (options.ids?.some((id) => !selected.some((item) => item.id === id))) throw new Error("Promotion requires current Local Knowledge ids.");
  const versioned = await Promise.all(versionedSummaries.map(async (summary) => ({ summary, item: await catalog.load(summary.id) })));
  const now = new Date().toISOString();
  const actions: PromotionAction[] = [];
  let notice: string | undefined;
  for (const summary of selected.sort((a, b) => a.id.localeCompare(b.id))) {
    const local = await catalog.load(summary.id);
    const fallback = deterministicAction(local, summary, versioned, recommendations.get(summary.id)!, now);
    if (options.provider && local.status !== "disputed") {
      try { actions.push(await assistedAction(options.provider, local, fallback, versioned, now)); }
      catch { actions.push(fallback); notice = "Semantic reasoning was unavailable for at least one candidate; conservative deterministic proposals are shown."; }
    } else actions.push(fallback);
  }
  const targetWriters = new Map<string, PromotionAction[]>();
  for (const action of actions.filter((candidate) => candidate.targetId && (candidate.disposition === "merge" || candidate.disposition === "supersede"))) {
    const group = targetWriters.get(action.targetId!) ?? []; group.push(action); targetWriters.set(action.targetId!, group);
  }
  for (const group of targetWriters.values()) {
    if (group.length < 2) continue;
    const superseding = group.filter((action) => action.disposition === "supersede");
    const keep = superseding.length === 1 ? superseding[0] : null;
    for (const action of group) if (action !== keep) Object.assign(action, { disposition: "conflict", draft: null, reason: "Multiple local proposals would modify the same Versioned Knowledge item; consolidate this conflict in a fresh focused review." });
  }
  const promotedIds = new Map<string, string>();
  for (const action of actions) if (action.disposition !== "conflict") {
    const publishedId = action.disposition === "covered" || action.disposition === "merge" ? action.targetId : action.draft?.id;
    if (publishedId) for (const id of action.localIds) promotedIds.set(id, publishedId);
  }
  for (const action of actions) if (action.draft) {
    action.draft.related = unique(action.draft.related.map((id) => promotedIds.get(id) ?? id));
    action.draft.supersedes = unique(action.draft.supersedes.map((id) => promotedIds.get(id) ?? id));
    action.draft.relations = (action.draft.relations ?? []).map((relation) => ({ ...relation, target: promotedIds.get(relation.target) ?? relation.target }));
  }
  const involved = new Set(actions.flatMap((action) => [...action.localIds, ...(action.targetId ? [action.targetId] : [])]));
  const revisions = await Promise.all(catalog.summaries.filter((item) => involved.has(item.id)).map(async (item) => ({ id: item.id, layer: item.layer, path: item.relativePath, hash: (await fileHash(await safeProjectPath(root, item.relativePath)))! })));
  const summary = { new: 0, merge: 0, supersede: 0, covered: 0, conflict: 0 };
  for (const action of actions) summary[action.disposition]++;
  const base = promotionPreviewSchema.omit({ previewId: true }).parse({ version: 1 as const, createdAt: now, mode: options.provider ? "assisted" as const : "deterministic" as const, ...(notice ? { notice } : {}), actions, revisions: revisions.sort((a, b) => a.path.localeCompare(b.path)), summary });
  return { ...base, previewId: sha256(JSON.stringify(base)) };
}

export async function applyKnowledgePromotion(root: string, rawPreview: PromotionPreview, approved: boolean) {
  assertNoSecrets(rawPreview);
  if (!approved) throw new Error("Versioned Knowledge promotion requires workflow approval of the exact preview.");
  const preview = promotionPreviewSchema.parse(rawPreview);
  const { previewId, ...base } = preview;
  if (sha256(JSON.stringify(base)) !== previewId) throw new Error("Promotion preview was modified; generate a fresh review.");
  return withPromotionLock(root, async () => {
    await recoverSyncTransaction(root);
    const previous = (await listCheckpoints(root)).find(c => c.note === `Approved Local to Versioned Knowledge promotion ${previewId}`);
    if (previous) return { previewId, checkpoint: previous.id, created: previous.createdMemory, updated: previous.updatedMemory, superseded: previous.supersededMemory, covered: previous.duplicateMemory, conflicts: previous.conflicts, published: previous.createdMemory.length + previous.updatedMemory.length, alreadyApplied: true, revisions: previous.promotionRevisions ?? [] };
    for (const revision of preview.revisions) if (await fileHash(await safeProjectPath(root, revision.path)) !== revision.hash) throw new Error("Knowledge changed after promotion review; generate a fresh preview.");
    const catalog = await loadMemoryCatalog(root);
    const writes: PlannedWrite[] = [];
    const created: string[] = [], updated: string[] = [], superseded: string[] = [], covered: string[] = [], conflicts: string[] = [];
    const now = new Date().toISOString();
    for (const action of preview.actions) {
      const local = await catalog.load(action.localIds[0]);
      const localSummary = catalog.summaries.find((item) => item.id === local.id && item.layer === "local");
      if (!localSummary) throw new Error("Promotion candidate is no longer Local Knowledge.");
      if (action.disposition === "conflict") { conflicts.push(local.id); continue; }
      const localUpdated: KnowledgeItem = { ...local, status: action.disposition === "covered" ? "duplicate" : "consolidated", updatedAt: now, related: unique([...local.related, ...(action.targetId ? [action.targetId] : []), ...(action.draft ? [action.draft.id] : [])]) };
      writes.push({ path: localSummary.relativePath, before: (await fileHash(await safeProjectPath(root, localSummary.relativePath)))!, after: renderKnowledge(localUpdated) });
      if (action.disposition === "covered") { covered.push(local.id); continue; }
      if (!action.draft) throw new Error("Publishable promotion action is missing a reviewed draft.");
      if (action.disposition === "merge") {
        const target = catalog.summaries.find((item) => item.id === action.targetId && item.layer === "versioned");
        if (!target || action.draft.id !== target.id) throw new Error("Merge target is not current Versioned Knowledge.");
        writes.push({ path: target.relativePath, before: (await fileHash(await safeProjectPath(root, target.relativePath)))!, after: renderKnowledge(action.draft) }); updated.push(target.id);
      } else {
        writes.push({ path: `memory/${action.draft.id}.md`, before: null, after: renderKnowledge(action.draft) }); created.push(action.draft.id);
        if (action.disposition === "supersede") {
          const targetSummary = catalog.summaries.find((item) => item.id === action.targetId && item.layer === "versioned");
          if (!targetSummary) throw new Error("Supersession target is not current Versioned Knowledge.");
          const target = await catalog.load(targetSummary.id);
          const retired = { ...target, status: "superseded" as const, updatedAt: now, related: unique([...target.related, action.draft.id]) };
          writes.push({ path: targetSummary.relativePath, before: (await fileHash(await safeProjectPath(root, targetSummary.relativePath)))!, after: renderKnowledge(retired) }); superseded.push(target.id);
        }
      }
    }
    const checkpointId = sortableId("chk");
    const checkpoints = await listCheckpoints(root);
    const checkpoint: Checkpoint = { id: checkpointId, createdAt: now, previousCheckpoint: checkpoints.at(-1)?.id ?? null, sessions: [], consolidation: "not-performed", createdMemory: created, createdSkills: [], updatedMemory: updated, supersededMemory: superseded, duplicateMemory: covered, conflicts, summary: { sessions: 0, candidates: preview.actions.length, created: created.length, consolidated: updated.length, duplicates: covered.length, superseded: superseded.length, conflicts: conflicts.length }, promotionRevisions: writes.map(w => ({path:w.path, hash:sha256(w.after)})), note: `Approved Local to Versioned Knowledge promotion ${preview.previewId}` };
    await commitSyncTransaction(root, [...writes, { path: `checkpoints/${checkpointId}.json`, before: null, after: `${JSON.stringify(checkpoint, null, 2)}\n` }], {policyMode:"exact"});
    await buildIndex(root);
    return { previewId, checkpoint: checkpointId, created, updated, superseded, covered, conflicts, published: created.length + updated.length, alreadyApplied: false, revisions: checkpoint.promotionRevisions! };
  });
}
