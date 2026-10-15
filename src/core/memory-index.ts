import { applicabilitySchema, validateApplicability, scopeProjection, type Applicability, sameApplicability } from "./applicability.js";
import { knowledgePolicy, CONTEXT_POLICIES, KNOWLEDGE_AUTHORITIES } from "./knowledge-policy.js";
import { knowledgeReadFence } from "./storage.js";
import { assertNoSecrets } from "./secrets.js";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { normalized, tokens } from "./matching.js";
import { parseKnowledge } from "./memory.js";
import { estimateTokens, knowledgeText, MAX_CANONICAL_ITEM_TOKENS, STALE_STATE_AFTER_DAYS } from "./telemetry.js";
import { ensureDerivedStateRoot, exists, projectDataPath, checkedDataPath, sha256, writeFileAtomic, readConfig } from "./storage.js";
import type { KnowledgeCategory, KnowledgeItem, KnowledgeLayer, KnowledgePriority, KnowledgeRelation, KnowledgeScope, KnowledgeStatus, MemoryHealth } from "./types.js";

interface FileStamp { size: number; mtimeMs: number; ctimeMs: number }
export interface KnowledgeSummary extends FileStamp {
  id: string;
  filename: string;
  relativePath: string;
  layer: KnowledgeLayer;
  scope: KnowledgeScope;
  scopeRef: string | null;
  scopeKind?: "path" | "topic";
  version: 1 | 2 | 3;
  applicability?:Applicability;
  contextPolicy: import("./knowledge-policy.js").ContextPolicy;
  authority: import("./knowledge-policy.js").KnowledgeAuthority;
  category: KnowledgeCategory;
  priority: KnowledgePriority;
  status: KnowledgeStatus;
  title: string;
  normalizedTitle: string;
  normalizedContent: string;
  tokens: string[];
  contentChars: number;
  estimatedTokens: number;
  updatedAt: string;
  sourceSessionCount: number;
  derivedFromCount: number;
  sourceEvidenceCount: number;
  related: string[];
  supersedes: string[];
  sourceSessions: string[];
  relations: KnowledgeRelation[];
}
interface MemoryIndexCache { version: 10; entries: Record<string, KnowledgeSummary> }
export type DerivedCacheState = "warm" | "missing" | "invalid" | "stale";
export interface RelatedKnowledgeQuery {
  applicability?:Applicability;
  scope: KnowledgeScope;
  scopeRef: string | null;
  scopeKind?: "path" | "topic";
  category: KnowledgeCategory;
  title: string;
  content: string;
  explicitIds: string[];
}

export const MAX_RELATED_MEMORY_CANDIDATES = 24;
const DAY_MS = 86_400_000;
const PRIORITY_SCORE: Record<KnowledgePriority, number> = { critical: 40, important: 30, normal: 20, contextual: 10 };

export function isStaleSummary(item: Pick<KnowledgeSummary, "status" | "category" | "priority" | "updatedAt">, now = new Date()): boolean {
  if (item.status !== "active" || item.category !== "state" || item.priority === "critical") return false;
  const updated = Date.parse(item.updatedAt);
  return Number.isFinite(updated) && now.getTime() - updated >= STALE_STATE_AFTER_DAYS * DAY_MS;
}

export function memoryHealth(summaries: KnowledgeSummary[], now = new Date()): MemoryHealth {
  const active = summaries.filter((item) => item.status === "active");
  const disputedItems = summaries.filter((item) => item.status === "disputed").length;
  const staleActiveItems = active.filter((item) => isStaleSummary(item, now)).length;
  const missingProvenanceItems = active.filter((item) => (item.sourceSessionCount === 0 && (item.sourceEvidenceCount ?? 0) === 0) || item.derivedFromCount === 0).length;
  const oversizedActiveItems = active.filter((item) => item.estimatedTokens > MAX_CANONICAL_ITEM_TOKENS).length;
  return {
    activeItems: active.length,
    disputedItems,
    historicalItems: summaries.length - active.length - disputedItems,
    staleActiveItems,
    missingProvenanceItems,
    oversizedActiveItems,
    status: disputedItems || missingProvenanceItems || oversizedActiveItems ? "attention" : "healthy",
  };
}
function stamp(stat: Awaited<ReturnType<typeof fs.stat>>): FileStamp { return { size: Number(stat.size), mtimeMs: Number(stat.mtimeMs), ctimeMs: Number(stat.ctimeMs) }; }
function sameStamp(left: FileStamp | undefined, right: FileStamp): boolean { return Boolean(left && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs); }
function summary(item: KnowledgeItem, filename: string, relativePath: string, layer: KnowledgeLayer, fileStamp: FileStamp): KnowledgeSummary {
  return {
    ...fileStamp,
    id: item.id,
    filename,
    relativePath,
    layer,
    scope: item.scope,
    scopeRef: item.scopeRef,
    ...(item.scopeKind ? { scopeKind: item.scopeKind } : {}),
    version: item.version ?? 3,
    ...(item.applicability?{applicability:item.applicability}:{}),
    contextPolicy: knowledgePolicy(item).contextPolicy,
    authority: knowledgePolicy(item).authority,
    category: item.category,
    priority: item.priority,
    status: item.status,
    title: item.title,
    normalizedTitle: normalized(item.title),
    normalizedContent: normalized(item.content),
    tokens: [...tokens(`${item.title} ${item.content} ${item.scopeRef ?? ""}`)].sort(),
    contentChars: item.content.length,
    estimatedTokens: estimateTokens(knowledgeText(item)),
    updatedAt: item.updatedAt,
    sourceSessionCount: item.sourceSessions.length,
    derivedFromCount: item.derivedFrom.length,
    sourceEvidenceCount: item.evidence?.filter(e => e.kind === "source_file" && typeof e.ref === "string" && e.ref.length > 0).length ?? 0,
    related: item.related,
    supersedes: item.supersedes,
    sourceSessions: item.sourceSessions,
    relations: item.relations ?? [],
  };
}

const summarySchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  applicability: applicabilitySchema.optional(),
  contextPolicy: z.enum(CONTEXT_POLICIES), authority: z.enum(KNOWLEDGE_AUTHORITIES),
  size: z.number().nonnegative(), mtimeMs: z.number().finite(), ctimeMs: z.number().finite(),
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/), filename: z.string(), relativePath: z.string(), layer: z.enum(["local", "versioned"]),
  scope: z.enum(["global", "module", "task"]), scopeRef: z.string().nullable(), scopeKind: z.enum(["path", "topic"]).optional(),
  category: z.enum(["principle", "invariant", "decision", "constraint", "lesson", "state", "instruction"]),
  priority: z.enum(["critical", "important", "normal", "contextual"]), status: z.enum(["active", "superseded", "deprecated", "consolidated", "duplicate", "disputed"]),
  title: z.string(), normalizedTitle: z.string(), normalizedContent: z.string(), tokens: z.array(z.string()),
  contentChars: z.number().nonnegative(), estimatedTokens: z.number().nonnegative(), updatedAt: z.string(),
  sourceSessionCount: z.number().nonnegative(), derivedFromCount: z.number().nonnegative(), sourceEvidenceCount: z.number().nonnegative(),
  related: z.array(z.string()), supersedes: z.array(z.string()), sourceSessions: z.array(z.string()),
  relations: z.array(z.object({ type: z.enum(["related_to", "depends_on", "implements", "applies_to", "supersedes", "superseded_by", "consolidates", "consolidated_into", "contradicts", "learned_from"]), target: z.string() })),
}).superRefine((entry,ctx)=>{
  if(entry.version!==3)return;
  try {
    const applicability=validateApplicability(entry.applicability,entry.contextPolicy);
    if(applicability.kind!=='legacy') {
      const projection=scopeProjection(applicability);
      if(entry.scope!==projection.scope||entry.scopeRef!==projection.scopeRef||entry.scopeKind!==projection.scopeKind)throw new Error('Invalid applicability projection');
    }
  } catch {ctx.addIssue({code:z.ZodIssueCode.custom,message:'Invalid v3 applicability cache entry'});}
});
const memoryCacheSchema = z.object({ version: z.literal(10), entries: z.record(summarySchema) });

async function readCache(root: string, persistCache: boolean): Promise<{ cache: MemoryIndexCache; state: DerivedCacheState }> {
  if (persistCache) await ensureDerivedStateRoot(root);
  const target = await checkedDataPath(root, ".cache", "memory-index.json");
  if (!(await exists(target))) return { cache: { version: 10, entries: {} }, state: "missing" };
  try {
    const parsed = memoryCacheSchema.parse(JSON.parse(await fs.readFile(target, "utf8")));
    assertNoSecrets(parsed);
    if (Object.entries(parsed.entries).every(([key, e]) => key === e.relativePath && key === `${e.layer === "local" ? "local/memory" : "memory"}/${e.filename}` && /^[a-zA-Z0-9_-]+\.md$/.test(e.filename))) return { cache: parsed, state: "warm" };
  } catch {
    // Disposable derived JSON is rebuilt below; canonical Markdown is never repaired here.
  }
  if (persistCache) await fs.rm(target, { force: true });
  return { cache: { version: 10, entries: {} }, state: "invalid" };
}

export class MemoryCatalog {
  readonly summaries: KnowledgeSummary[];
  readonly filesScanned: number;
  readonly cacheState: DerivedCacheState;
  bodiesIndexed: number;
  bodiesLoaded = 0;
  private readonly staged = new Map<string, KnowledgeItem>();
  readonly originalHashes = new Map<string, string>();
  private readonly byId: Map<string, KnowledgeSummary>;

  constructor(private readonly root: string, summaries: KnowledgeSummary[], filesScanned: number, bodiesIndexed: number, cacheState: DerivedCacheState) {
    this.summaries = summaries;
    this.filesScanned = filesScanned;
    this.bodiesIndexed = bodiesIndexed;
    this.cacheState = cacheState;
    this.byId = new Map(summaries.map((entry) => [entry.id, entry]));
  }

  selectRelated(query: RelatedKnowledgeQuery, limit = MAX_RELATED_MEMORY_CANDIDATES): KnowledgeSummary[] {
    const queryTokens = tokens(`${query.title} ${query.content} ${query.scopeRef ?? ""}`);
    const explicit = new Set(query.explicitIds);
    const shadowed = new Set(this.summaries.filter(m => m.status === "active" || m.status === "disputed").flatMap(m => m.supersedes));
    return this.summaries
      .filter(entry => explicit.has(entry.id) || !shadowed.has(entry.id))
      .filter((entry) => (entry.status === "active" || entry.status === "disputed") && (explicit.has(entry.id) || (entry.scope === query.scope && entry.scopeRef === query.scopeRef && entry.scopeKind === query.scopeKind && entry.category === query.category && sameApplicability(entry,query))))
      .map((entry) => {
        const intersection = entry.tokens.filter((token) => queryTokens.has(token)).length;
        let score = intersection * 10 + PRIORITY_SCORE[entry.priority];
        if (explicit.has(entry.id)) score += 10_000;
        const queryTitle = normalized(query.title);
        const queryContent = normalized(query.content);
        if (queryTitle && entry.normalizedTitle === queryTitle) score += 1_000;
        if (queryContent && entry.normalizedContent === queryContent) score += 2_000;
        if (entry.scopeRef && query.scopeRef === entry.scopeRef) score += 100;
        return { entry, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))
      .slice(0, Math.max(1, limit))
      .map(({ entry }) => entry);
  }

  async load(id: string): Promise<KnowledgeItem> {
    const entry = this.byId.get(id);
    if (!entry) throw new Error(`Canonical Prodero memory ${id} was not found.`);
    this.bodiesLoaded += 1;
    const staged = this.staged.get(id);
    if (staged) return structuredClone(staged);
    const finishRead = await knowledgeReadFence(this.root);
    const target = await checkedDataPath(this.root, entry.relativePath);
    if (!sameStamp(entry, stamp(await fs.stat(target)))) throw new Error("Knowledge changed after context selection; retry");
    const text = await fs.readFile(target, "utf8");
    await finishRead();
    this.originalHashes.set(id, sha256(text));
    return parseKnowledge(text, entry.filename, (await readConfig(this.root))?.knowledgeSchemaVersion ?? 1);
  }

  /** In-memory overlay for a Sync plan; never persist virtual stamps in the derived cache. */
  stage(item: KnowledgeItem, layer: KnowledgeLayer = "local"): void {
    const filename = `${item.id}.md`;
    const relativePath = layer === "versioned" ? `memory/${filename}` : `local/memory/${filename}`;
    const entry = summary(item, filename, relativePath, layer, { size: 0, mtimeMs: 0, ctimeMs: 0 });
    const index = this.summaries.findIndex(candidate => candidate.id === item.id);
    if (index >= 0) this.summaries.splice(index, 1, entry); else this.summaries.push(entry);
    this.byId.set(item.id, entry);
    this.staged.set(item.id, structuredClone({...item, ...knowledgePolicy(item)}));
  }

  async save(): Promise<void> {
    if (this.staged.size) throw new Error("Cannot persist an uncommitted knowledge plan as cache");
    await ensureDerivedStateRoot(this.root);
    const entries = Object.fromEntries(this.summaries.sort((a, b) => a.relativePath.localeCompare(b.relativePath)).map((entry) => [entry.relativePath, entry]));
    await writeFileAtomic(projectDataPath(this.root, ".cache", "memory-index.json"), `${JSON.stringify({ version: 10, entries })}\n`);
  }
}

export async function loadMemoryCatalog(root: string, options: { persistCache?: boolean } = {}): Promise<MemoryCatalog> {
  const finishRead = await knowledgeReadFence(root);
  const { cache, state } = await readCache(root, options.persistCache !== false);
  const summaries: KnowledgeSummary[] = [];
  const schema = (await readConfig(root))?.knowledgeSchemaVersion ?? 1;
  let bodiesIndexed = 0;
  for (const layer of ["versioned", "local"] as const) {
    const relativeDirectory = layer === "versioned" ? "memory" : "local/memory";
    const directory = await checkedDataPath(root, ...relativeDirectory.split("/"));
    if (!(await exists(directory))) continue;
    const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".md") && !name.startsWith(".")).sort();
    for (const name of names) {
      const target = await checkedDataPath(root, relativeDirectory, name);
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) throw new Error(`Symlink in canonical ${layer} memory: ${name}`);
      const fileStamp = stamp(stat);
      const relativePath = `${relativeDirectory}/${name}`;
      let entry = cache.entries[relativePath];
      if (!sameStamp(entry, fileStamp) || (schema >= 2 && entry.version !== schema)) {
        entry = summary(parseKnowledge(await fs.readFile(target, "utf8"), name, schema), name, relativePath, layer, fileStamp);
        bodiesIndexed += 1;
      }
      if (summaries.some((candidate) => candidate.id === entry.id)) throw new Error(`Knowledge id ${entry.id} exists in both Local and Versioned Knowledge.`);
      summaries.push(entry);
    }
  }
  const cacheState = state === "warm" && bodiesIndexed > 0 ? "stale" : state;
  const catalog = new MemoryCatalog(root, summaries, summaries.length, bodiesIndexed, cacheState);
  await finishRead();
  if (options.persistCache !== false) await catalog.save();
  return catalog;
}
