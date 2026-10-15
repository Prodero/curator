import { getKnowledgeProvenance } from "./knowledge-provenance.js";
import { isPathScope, pathApplies } from "./path-scope.js";
import { assertNoSecrets } from "./secrets.js";
import { buildIndex } from "./index.js";
import { sortableId } from "./ids.js";
import { assertEnglishProse } from "./language.js";
import { loadMemoryCatalog } from "./memory-index.js";
import { renderKnowledge } from "./memory.js";
import { normalized, tokens } from "./matching.js";
import { listCheckpoints, sha256 } from "./storage.js";
import { commitSyncTransaction, fileHash, recoverSyncTransaction, safeProjectPath, withSyncLock } from "./sync-transaction.js";
import type { Checkpoint, KnowledgeItem, KnowledgeLayer, KnowledgeStatus, KnowledgeCategory } from "./types.js";

export interface MemorySearchOptions {
  scope?: "global" | "project" | "path";
  path?: string;
  limit?: number;
  includeHistorical?: boolean;
  layer?: KnowledgeLayer;
  category?: KnowledgeCategory;
  offset?: number;
  includeShadowed?: boolean;
}

const CURRENT = new Set<KnowledgeStatus>(["active", "disputed"]);

export async function searchMemoryPage(root: string, query: string, options: MemorySearchOptions = {}) {
  const catalog = await loadMemoryCatalog(root);
  const queryTokens = tokens(query);
  const path = options.path?.replace(/^\.\//, "").replace(/\/$/, "");
  const statuses = options.includeHistorical ? null : CURRENT;
  const shadowed = new Set(catalog.summaries.filter((item) => CURRENT.has(item.status)).flatMap((item) => item.supersedes));
  const matches = catalog.summaries
    .filter((item) => !statuses || statuses.has(item.status))
    .filter((item) => options.includeHistorical || options.includeShadowed || !shadowed.has(item.id))
    .filter((item) => !options.category || item.category === options.category)
    .filter((item) => !options.layer || item.layer === options.layer)
    .filter((item) => options.scope !== "path" || (item.applicability?.kind === "scoped" && item.applicability.paths ? item.applicability.paths.some(p => Boolean(path && pathApplies(p.replace(/\/\*\*$/, ""), path))) : isPathScope(item) && Boolean(path && pathApplies(item.scopeRef!, path))))
    .filter((item) => options.scope !== "global" || item.scope === "global")
    .filter((item) => options.scope !== "project" || item.scope === "global")
    .map((item) => {
      const overlap = item.tokens.filter((token) => queryTokens.has(token)).length;
      const titleOverlap = [...tokens(item.title)].filter((token) => queryTokens.has(token)).length;
      const exactTitle = normalized(item.title) === normalized(query);
      const exactContent = item.normalizedContent === normalized(query);
      const score = overlap * 10 + titleOverlap * 20 + (exactTitle ? 1_000 : 0) + (exactContent ? 2_000 : 0);
      return { item, score };
    })
    .filter(({ score }) => !query.trim() || score > 0)
    .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id))
;
  const offset = Math.max(0, options.offset ?? 0), limit = Math.min(20, Math.max(1, options.limit ?? 8));
  const page = matches.slice(offset, offset + limit);
  return { total: matches.length, offset, nextOffset: offset + limit < matches.length ? offset + limit : null,
    matches: await Promise.all(page.map(async ({ item, score }) => ({ ...(await catalog.load(item.id)), layer: item.layer, score, shadowed: shadowed.has(item.id), revision: catalog.originalHashes.get(item.id)! }))) };

}

export async function searchMemory(root: string, query: string, options: MemorySearchOptions = {}) {
  if (!query.trim()) return []; // Empty conversational searches must never select an arbitrary forget target.
  return (await searchMemoryPage(root, query, options)).matches;
}

export async function getMemory(root: string, id: string): Promise<KnowledgeItem> {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid Prodero memory id.");
  const catalog = await loadMemoryCatalog(root);
  return catalog.summaries.some(item => item.id === id) ? catalog.load(id) : (await getKnowledgeProvenance(root, id)).item;
}

export async function getMemoryLayer(root: string, id: string): Promise<KnowledgeLayer> {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid Prodero memory id.");
  const entry = (await loadMemoryCatalog(root)).summaries.find((item) => item.id === id);
  if (!entry) return (await getKnowledgeProvenance(root, id)).layer;
  return entry.layer;
}

export async function forgetMemory(root: string, input: { id?: string; query?: string; reason?: string; revision?: string }) {
  assertNoSecrets(input);
  return withSyncLock(root, async () => {
    await recoverSyncTransaction(root);
    assertEnglishProse([input.reason], "Forgotten Prodero knowledge metadata");
    let item: KnowledgeItem;
    if (input.id) item = await getMemory(root, input.id);
    else {
      const matches = await searchMemory(root, input.query ?? "", { limit: 3 });
      if (matches.length !== 1) throw new Error(matches.length ? `Forget is ambiguous. Search first and pass one exact id: ${matches.map((match) => match.id).join(", ")}` : "No active knowledge matched. Search first or pass an exact id.");
      item = matches[0];
    }
    if (await getMemoryLayer(root, item.id) === "versioned") throw new Error("Versioned Knowledge cannot be forgotten through local memory operations. Use explicit repository maintenance and review the Git diff.");
    if (input.revision) {
      const actual = await fileHash(await safeProjectPath(root, `local/memory/${item.id}.md`));
      if (actual !== input.revision) throw new Error("Knowledge changed since it was opened. Reload and review the current revision.");
    }
    if (!CURRENT.has(item.status)) return { forgotten: false, alreadyHistorical: true, item };
    const now = new Date();
    const checkpointId = sortableId("chk", now);
    const layer = await getMemoryLayer(root, item.id);
    const relative = layer === "versioned" ? `memory/${item.id}.md` : `local/memory/${item.id}.md`;
    const before = await fileHash(await safeProjectPath(root, relative));
    if (!before) throw new Error(`Canonical Prodero memory ${item.id} was not found.`);
    const updated: KnowledgeItem = {
      ...item,
      status: "deprecated",
      updatedAt: now.toISOString(),
      derivedFrom: [...new Set([...item.derivedFrom, `user:forget:${checkpointId}`])].sort(),
      evidence: [...(item.evidence ?? []), { kind: "user_instruction", ref: input.reason?.trim() || "Explicit conversational forget" }],
    };
    const checkpoints = await listCheckpoints(root);
    const checkpoint: Checkpoint = {
      id: checkpointId,
      createdAt: now.toISOString(),
      previousCheckpoint: checkpoints.at(-1)?.id ?? null,
      sessions: [],
      consolidation: "not-performed",
      createdMemory: [],
      createdSkills: [],
      updatedMemory: [item.id],
      supersededMemory: [],
      duplicateMemory: [],
      conflicts: [],
      summary: { sessions: 0, candidates: 0, created: 0, consolidated: 0, duplicates: 0, superseded: 0, conflicts: 0 },
      note: `Explicit conversational forget: ${item.id}`,
    };
    await commitSyncTransaction(root, [
      { path: relative, before, after: renderKnowledge(updated) },
      { path: `checkpoints/${checkpointId}.json`, before: null, after: `${JSON.stringify(checkpoint, null, 2)}\n` },
    ], {policyMode:'exact'});
    await buildIndex(root);
    return { forgotten: true, alreadyHistorical: false, item: updated, checkpoint: checkpointId, canonicalHash: sha256(renderKnowledge(updated)) };
  });
}
