import { listArchivePaths } from "./knowledge-provenance.js";
import { assertCompatibleProject } from "./storage.js";
import { isPathScope } from "./path-scope.js";
import fs from "node:fs/promises";
import { loadMemoryCatalog, type DerivedCacheState, type KnowledgeSummary, type MemoryCatalog } from "./memory-index.js";
import { sha256, exists, projectDataPath, writeFileAtomic } from "./storage.js";
import type { KnowledgeGraphDiagnostics, KnowledgeRelationType } from "./types.js";

export interface KnowledgeGraphEdge {
  from: string;
  to: string;
  type: KnowledgeRelationType;
  inferred: boolean;
  weight: number;
}

interface KnowledgeGraphCache {
  version: 1;
  sourceDigest: string;
  nodes: string[];
  edges: KnowledgeGraphEdge[];
  brokenReferences: string[];
}

const MEMORY_ID = /^mem_[a-zA-Z0-9_]+$/;
const EDGE_WEIGHT: Record<KnowledgeRelationType, number> = {
  depends_on: 24,
  implements: 20,
  related_to: 12,
  supersedes: 8,
  superseded_by: 0,
  consolidates: 0,
  consolidated_into: 0,
  contradicts: 0,
  applies_to: 0,
  learned_from: 0,
};
const MAX_INFERRED_RELATED_PER_NODE = 3;
const MAX_TOKEN_POSTINGS = 128;
const RELATION_TYPES = new Set<KnowledgeRelationType>(["related_to", "depends_on", "implements", "applies_to", "supersedes", "superseded_by", "consolidates", "consolidated_into", "contradicts", "learned_from"]);

function validCache(value: unknown, digest: string): value is KnowledgeGraphCache {
  if (!value || typeof value !== "object") return false;
  const cache = value as KnowledgeGraphCache;
  return cache.version === 1 && cache.sourceDigest === digest
    && Array.isArray(cache.nodes) && cache.nodes.every((node) => typeof node === "string")
    && Array.isArray(cache.brokenReferences) && cache.brokenReferences.every((entry) => typeof entry === "string")
    && Array.isArray(cache.edges) && cache.edges.every((edge) => edge && typeof edge.from === "string" && typeof edge.to === "string"
      && RELATION_TYPES.has(edge.type) && typeof edge.inferred === "boolean" && typeof edge.weight === "number" && Number.isFinite(edge.weight));
}

function graphSourceDigest(summaries: KnowledgeSummary[], archives: string[] = []): string {
  return sha256(JSON.stringify([archives, summaries.map((item) => ({
    id: item.id, status: item.status, scope: item.scope, scopeRef: item.scopeRef, scopeKind: item.scopeKind, category: item.category,
    title: item.normalizedTitle, content: item.normalizedContent, updatedAt: item.updatedAt,
    related: item.related, supersedes: item.supersedes, sourceSessions: item.sourceSessions, relations: item.relations,
  }))]));
}

const pathLike = isPathScope;
function compatibleScope(left: KnowledgeSummary, right: KnowledgeSummary): boolean {
  if (pathLike(left) || pathLike(right)) return left.scope === right.scope && left.scopeRef === right.scopeRef && left.scopeKind === right.scopeKind;
  if (left.scope === "module" || right.scope === "module") return left.scope === right.scope && left.scopeRef === right.scopeRef && left.scopeKind === right.scopeKind;
  return true;
}

function canonicalPair(from: string, to: string, type: KnowledgeRelationType): [string, string] {
  return type === "related_to" || type === "contradicts" ? [from, to].sort() as [string, string] : [from, to];
}

function build(summaries: KnowledgeSummary[], archives: string[]): KnowledgeGraphCache {
  const nodes = [...summaries.map((item) => item.id), ...archives].sort();
  const knownIds = new Set(nodes);
  const byId = new Map(summaries.map((item) => [item.id, item]));
  const edges = new Map<string, KnowledgeGraphEdge>();
  const broken = new Set<string>();
  const add = (from: string, to: string, type: KnowledgeRelationType, inferred = false) => {
    const needsMemoryTarget = type === "related_to" || type === "depends_on" || type === "implements" || type === "supersedes" || type === "superseded_by" || type === "consolidates" || type === "consolidated_into" || type === "contradicts";
    if (needsMemoryTarget && (!MEMORY_ID.test(to) || !knownIds.has(to))) { broken.add(`${from}:${type}:${to}`); return; }
    const [edgeFrom, edgeTo] = canonicalPair(from, to, type);
    const key = `${edgeFrom}\0${type}\0${edgeTo}`;
    if (!edges.has(key) || !inferred) edges.set(key, { from: edgeFrom, to: edgeTo, type, inferred, weight: EDGE_WEIGHT[type] });
  };

  for (const item of summaries) {
    for (const target of item.supersedes) add(item.id, target, "supersedes");
    for (const target of item.related) {
      const other = byId.get(target);
      add(item.id, target, item.status === "disputed" && other?.status === "disputed" ? "contradicts" : "related_to");
    }
    for (const relation of item.relations) add(item.id, relation.target, relation.type);
    if (item.scopeRef) add(item.id, `scope:${item.scopeRef}`, "applies_to");
    for (const session of item.sourceSessions) add(item.id, `session:${session}`, "learned_from");
  }

  const successors = new Map<string, string[]>();
  for (const item of summaries.filter((candidate) => candidate.status === "active" || candidate.status === "disputed")) for (const target of item.supersedes) {
    const ids = successors.get(target) ?? []; ids.push(item.id); successors.set(target, ids);
  }
  for (const edge of [...edges.values()]) {
    const successor = successors.get(edge.to);
    if (successor?.length === 1 && edge.type !== "supersedes" && edge.type !== "contradicts") add(edge.from, successor[0], edge.type, true);
  }

  const current = summaries.filter((item) => item.status === "active" || item.status === "disputed");
  const inverted = new Map<string, string[]>();
  for (const item of current) for (const token of item.tokens.filter((value) => value.length >= 4)) {
    const ids = inverted.get(token) ?? []; ids.push(item.id); inverted.set(token, ids);
  }
  for (const item of current) {
    const overlap = new Map<string, number>();
    for (const token of item.tokens.filter((value) => value.length >= 4)) {
      const postings = inverted.get(token) ?? [];
      if (postings.length > MAX_TOKEN_POSTINGS) continue;
      for (const id of postings) if (id !== item.id) overlap.set(id, (overlap.get(id) ?? 0) + 1);
    }
    const candidates = [...overlap].flatMap(([id, shared]) => {
      const target = byId.get(id)!;
      if (!compatibleScope(item, target)) return [];
      const coverage = shared / Math.min(item.tokens.length || 1, target.tokens.length || 1);
      if (shared < 2 || coverage < 0.3) return [];
      const targetTitle = target.normalizedTitle.split(" ").filter(Boolean);
      const mentionsTitle = targetTitle.length > 0 && targetTitle.every((token) => item.tokens.includes(token));
      const words = new Set(item.tokens);
      const type: KnowledgeRelationType = mentionsTitle && (words.has("depends") || words.has("dependency")) ? "depends_on"
        : mentionsTitle && (words.has("implements") || words.has("implementation")) ? "implements" : "related_to";
      return [{ target, shared, coverage, type }];
    }).sort((a, b) => b.shared - a.shared || b.coverage - a.coverage || a.target.id.localeCompare(b.target.id));
    for (const candidate of candidates.slice(0, MAX_INFERRED_RELATED_PER_NODE)) add(item.id, candidate.target.id, candidate.type, true);
  }

  return {
    version: 1,
    sourceDigest: graphSourceDigest(summaries, archives),
    nodes,
    edges: [...edges.values()].sort((a, b) => a.from.localeCompare(b.from) || a.type.localeCompare(b.type) || a.to.localeCompare(b.to) || Number(a.inferred) - Number(b.inferred)),
    brokenReferences: [...broken].sort(),
  };
}

function diagnostics(cache: KnowledgeGraphCache, cacheState: DerivedCacheState): KnowledgeGraphDiagnostics {
  return {
    cacheState,
    nodeCount: cache.nodes.length,
    edgeCount: cache.edges.length,
    brokenReferences: cache.brokenReferences.length,
    conflictEdges: cache.edges.filter((edge) => edge.type === "contradicts").length,
  };
}

export class KnowledgeGraph {
  private readonly adjacency = new Map<string, KnowledgeGraphEdge[]>();
  readonly diagnostics: KnowledgeGraphDiagnostics;
  readonly edges: KnowledgeGraphEdge[];
  readonly brokenReferences: string[];

  constructor(cache: KnowledgeGraphCache, cacheState: DerivedCacheState) {
    this.edges = cache.edges;
    this.brokenReferences = cache.brokenReferences;
    this.diagnostics = diagnostics(cache, cacheState);
    for (const edge of cache.edges) {
      const outgoing = this.adjacency.get(edge.from) ?? []; outgoing.push(edge); this.adjacency.set(edge.from, outgoing);
      if (edge.type === "related_to" || edge.type === "contradicts") {
        const incoming = this.adjacency.get(edge.to) ?? [];
        incoming.push({ ...edge, from: edge.to, to: edge.from }); this.adjacency.set(edge.to, incoming);
      }
    }
  }

  neighbors(id: string): KnowledgeGraphEdge[] { return this.adjacency.get(id) ?? []; }
}

export async function loadKnowledgeGraph(root: string, suppliedCatalog?: MemoryCatalog, options: { persistCache?: boolean } = {}): Promise<KnowledgeGraph> {
  await assertCompatibleProject(root);
  const catalog = suppliedCatalog ?? await loadMemoryCatalog(root, options);
  const target = projectDataPath(root, ".cache", "knowledge-graph.json");
  const archives = (await listArchivePaths(root)).map(entry => entry.id).sort();
  const digest = graphSourceDigest(catalog.summaries, archives);
  let state: DerivedCacheState = "missing";
  if (await exists(target)) {
    try {
      const cached = JSON.parse(await fs.readFile(target, "utf8")) as KnowledgeGraphCache;
      if (validCache(cached, digest)) return new KnowledgeGraph(cached, "warm");
      state = "stale";
    } catch { state = "invalid"; }
  }
  const rebuilt = build(catalog.summaries, archives);
  if (options.persistCache !== false) await writeFileAtomic(target, `${JSON.stringify(rebuilt)}\n`);
  return new KnowledgeGraph(rebuilt, state);
}
