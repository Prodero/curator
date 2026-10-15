import { writeFileExclusive } from "./storage.js";
import { PRODERO_KNOWLEDGE_SCHEMA_VERSION } from "./constants.js";
import { validateApplicability, scopeProjection } from "./applicability.js";
import { knowledgePolicy, validateKnowledgePolicy } from "./knowledge-policy.js";
import { knowledgeReadFence } from "./storage.js";
import { assertPathScope } from "./path-scope.js";
import { assertNoSecrets } from "./secrets.js";
import fs from "node:fs/promises";
import path from "node:path";
import { frontmatter, parseFrontmatter } from "./format.js";
import { exists, projectDataPath, checkedDataPath, canonicalId, writeFileAtomic, readConfig } from "./storage.js";
import type { KnowledgeCategory, KnowledgeItem, KnowledgeLayer, KnowledgePriority, KnowledgeRelation, KnowledgeRelationType, KnowledgeScope, KnowledgeStatus } from "./types.js";

const SCOPES = new Set<KnowledgeScope>(["global", "module", "task"]);
const CATEGORIES = new Set<KnowledgeCategory>(["principle", "invariant", "decision", "constraint", "lesson", "state", "instruction"]);
const PRIORITIES = new Set<KnowledgePriority>(["critical", "important", "normal", "contextual"]);
const STATUSES = new Set<KnowledgeStatus>(["active", "superseded", "deprecated", "consolidated", "duplicate", "disputed"]);
const RELATIONS = new Set<KnowledgeRelationType>(["related_to", "depends_on", "implements", "applies_to", "supersedes", "superseded_by", "consolidates", "consolidated_into", "contradicts", "learned_from"]);

function enumValue<T extends string>(value: unknown, allowed: Set<T>, fallback: T): T {
  return typeof value === "string" && allowed.has(value as T) ? value as T : fallback;
}
function arrayValue(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function stringValue(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
function relationValues(value: unknown): KnowledgeRelation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => entry && typeof entry === "object" && RELATIONS.has((entry as KnowledgeRelation).type) && typeof (entry as KnowledgeRelation).target === "string"
    ? [{ type: (entry as KnowledgeRelation).type, target: (entry as KnowledgeRelation).target }] : []);
}

export function renderKnowledge(item: KnowledgeItem): string {
  assertNoSecrets(item);
  assertPathScope(item);
  const policy = knowledgePolicy(item);
  const version=item.version===2?2:3;
  const applicability=version===3?validateApplicability(item.applicability ?? (item.version===3?undefined:{kind:"legacy"}),policy.contextPolicy):undefined;
  return frontmatter({
    version,
    ...(applicability?{applicability}:{}),
    context_policy: policy.contextPolicy,
    authority: policy.authority,
    id: item.id,
    kind: "knowledge",
    scope: item.scope,
    scope_ref: item.scopeRef,
    ...(item.scopeKind ? { scope_kind: item.scopeKind } : {}),
    category: item.category,
    priority: item.priority,
    status: item.status,
    ...(item.archivedAt ? { archived_at: item.archivedAt } : {}),
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    source_sessions: item.sourceSessions,
    derived_from: item.derivedFrom,
    supersedes: item.supersedes,
    related: item.related,
    ...(item.relations?.length ? { relations: [...item.relations].sort((a, b) => a.type.localeCompare(b.type) || a.target.localeCompare(b.target)) } : {}),
    ...(item.evidence ? { evidence: item.evidence } : {}),
  }, `# ${item.title}\n\n${item.content}`);
}

export function parseKnowledge(content: string, filename: string, expectedSchema?: number): KnowledgeItem {
  assertNoSecrets(content);
  const { metadata, body } = parseFrontmatter(content, filename);
  const modern = metadata.version === 2 || metadata.kind === "knowledge" || path.basename(filename).startsWith("mem_") || typeof metadata.id === "string" && metadata.id.startsWith("mem_");
  const fail = (field: string): never => { throw new Error(`Invalid canonical knowledge: ${filename} (${field}).`); };
  if (metadata.kind !== undefined && metadata.kind !== "knowledge") fail("kind");
  if (metadata.version !== undefined && ![2,3].includes(Number(metadata.version))) fail("unsupported version");
  const version = metadata.version === 3 ? 3 : metadata.version === 2 ? 2 : 1;
  if (expectedSchema !== undefined && expectedSchema >= 2 && version !== expectedSchema) fail("missing version metadata for current knowledge schema");
  if (version === 1 && (metadata.context_policy !== undefined || metadata.authority !== undefined)) fail("policy metadata requires version 2");
  if (modern) for (const field of ["id", "scope", "category", "priority", "status", "created_at", "updated_at", "source_sessions", "derived_from", "supersedes", "related"]) if (metadata[field] === undefined) fail(`missing ${field}`);
  const id = metadata.id ?? path.basename(filename, ".md");
  canonicalId(id, filename);
  if (modern && id !== path.basename(filename, ".md")) fail("ID does not match filename");
  for (const [field, allowed] of [["scope", SCOPES], ["category", CATEGORIES], ["priority", PRIORITIES], ["status", STATUSES]] as const) {
    if (metadata[field] !== undefined && (typeof metadata[field] !== "string" || !(allowed as Set<string>).has(metadata[field] as string))) fail(field);
  }
  for (const field of ["created_at", "updated_at", "archived_at"]) if (metadata[field] !== undefined && (typeof metadata[field] !== "string" || !Number.isFinite(Date.parse(metadata[field] as string)))) fail(field);
  for (const field of ["source_sessions", "derived_from", "supersedes", "related"]) if (metadata[field] !== undefined && (!Array.isArray(metadata[field]) || !(metadata[field] as unknown[]).every(v => typeof v === "string"))) fail(field);
  if (metadata.scope_ref !== undefined && metadata.scope_ref !== null && typeof metadata.scope_ref !== "string") fail("scope_ref");
  if (metadata.relations !== undefined && (!Array.isArray(metadata.relations) || !metadata.relations.every(v => v && typeof v === "object" && RELATIONS.has(v.type) && typeof v.target === "string"))) fail("relations");
  if (metadata.evidence !== undefined && (!Array.isArray(metadata.evidence) || !metadata.evidence.every(v => v && typeof v === "object" && typeof v.kind === "string" && typeof v.ref === "string"))) fail("evidence");
  if (metadata.scope_kind !== undefined && !["path", "topic"].includes(String(metadata.scope_kind))) fail("scope_kind");
  assertPathScope({ scope: String(metadata.scope), scopeRef: typeof metadata.scope_ref === "string" ? metadata.scope_ref : null, scopeKind: metadata.scope_kind as "path" | "topic" | undefined });
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? path.basename(filename, ".md");
  const bodyWithoutTitle = body.replace(/^#\s+.+\r?\n+/, "").trim();
  const createdAt = stringValue(metadata.created_at, new Date(0).toISOString());
  let applicability;
  if(version===3){
    try {applicability=validateApplicability(metadata.applicability,metadata.context_policy as string);}catch{fail('applicability');}
    if(applicability!.kind!=='legacy') {
      const projection=scopeProjection(applicability!);
      if(projection.scope!==metadata.scope || projection.scopeRef!==metadata.scope_ref || projection.scopeKind!==metadata.scope_kind)fail('scope projection disagrees with applicability');
    }
  }else if(metadata.applicability!==undefined)fail('applicability requires version 3');
  const category = enumValue(metadata.category, CATEGORIES, "state");
  const contextPolicy = version === 1 ? (category === "instruction" ? "required" : "relevant") : metadata.context_policy;
  const authority = version === 1 ? "legacy_inherited" : metadata.authority;
  try {validateKnowledgePolicy(category, contextPolicy, authority);} catch {fail("contextPolicy/authority");}
  return {
    version,
    ...(applicability?{applicability}:{}),
    contextPolicy: contextPolicy as NonNullable<KnowledgeItem['contextPolicy']>,
    authority: authority as NonNullable<KnowledgeItem['authority']>,
    id: stringValue(metadata.id, path.basename(filename, ".md")),
    scope: enumValue(metadata.scope, SCOPES, "global"),
    scopeRef: typeof metadata.scope_ref === "string" ? metadata.scope_ref : null,
    ...(metadata.scope_kind ? { scopeKind: metadata.scope_kind as "path" | "topic" } : {}),
    category,
    ...(typeof metadata.archived_at === "string" ? { archivedAt: metadata.archived_at } : {}),
    priority: enumValue(metadata.priority, PRIORITIES, "normal"),
    status: enumValue(metadata.status, STATUSES, "active"),
    title: heading,
    content: bodyWithoutTitle,
    createdAt,
    updatedAt: stringValue(metadata.updated_at, createdAt),
    sourceSessions: arrayValue(metadata.source_sessions),
    derivedFrom: arrayValue(metadata.derived_from),
    supersedes: arrayValue(metadata.supersedes),
    related: arrayValue(metadata.related),
    relations: relationValues(metadata.relations),
    ...(category === "instruction" ? { kind: "instruction" as const, enforcement: contextPolicy as NonNullable<KnowledgeItem["contextPolicy"]> } : {}),
    ...(Array.isArray(metadata.evidence) ? { evidence: metadata.evidence as KnowledgeItem["evidence"] } : {}),
  };
}

export function knowledgeDirectory(root: string, layer: KnowledgeLayer): string {
  return layer === "versioned" ? projectDataPath(root, "memory") : projectDataPath(root, "local", "memory");
}

export async function listKnowledge(root: string, layer?: KnowledgeLayer): Promise<KnowledgeItem[]> {
  const finishRead = await knowledgeReadFence(root);
  const items: KnowledgeItem[] = [];
  const schema = (await readConfig(root))?.knowledgeSchemaVersion ?? 1;
  for (const current of layer ? [layer] : ["versioned", "local"] as const) {
    const directory = await checkedDataPath(root, current === "versioned" ? "memory" : "local/memory");
    if (!(await exists(directory))) continue;
    const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".md") && !name.startsWith(".")).sort();
    for (const name of names) items.push(parseKnowledge(await fs.readFile(await checkedDataPath(root, current === "versioned" ? "memory" : "local/memory", name), "utf8"), name, schema));
  }
  await finishRead();
  return items;
}

/** Trusted storage primitive for fixtures and canonical restoration, not an agent writer.
 * Inference, imports and lifecycle mutations must use commitSyncTransaction. */
export async function writeKnowledge(root: string, item: KnowledgeItem, exclusive = false, layer: KnowledgeLayer = "versioned"): Promise<void> {
  const config = await readConfig(root);
  if (config && (config.knowledgeSchemaVersion ?? 1) < PRODERO_KNOWLEDGE_SCHEMA_VERSION) throw new Error("MIGRATION_REQUIRED: approve the knowledge update before writing the current knowledge schema.");
  canonicalId(item.id, "knowledge write");
  const text = renderKnowledge((config?.knowledgeSchemaVersion??1)>=3?{...item,...knowledgePolicy(item),version:3,applicability:item.applicability??(item.version===3?undefined:{kind:"legacy"})}:{...item,...knowledgePolicy(item),version:2});
  parseKnowledge(text, `${item.id}.md`, config?.knowledgeSchemaVersion);
  const target = await checkedDataPath(root, layer === "versioned" ? "memory" : "local/memory", `${item.id}.md`);
  if (exclusive) await writeFileExclusive(target, text);
  else await writeFileAtomic(target, text);
}
