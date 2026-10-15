import { writeFileExclusive } from "./storage.js";
import { assertNoSecrets } from "./secrets.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { frontmatter, parseFrontmatter } from "./format.js";
import { sortableId } from "./ids.js";
import { tokens } from "./matching.js";
import { exists, projectDataPath, checkedDataPath, ensureDataDirectory, readConfig, sha256, writeFileAtomic } from "./storage.js";
import { withSyncLock, recoverSyncTransaction, safeProjectPath, commitSyncTransaction, fileHash, type PlannedWrite } from "./sync-transaction.js";
import { estimateTokens } from "./telemetry.js";

export const skillInputSchema = z.object({
  title: z.string().trim().min(1).max(200).regex(/^[^\r\n]+$/, "Use a single-line title"),
  description: z.string().trim().min(1).max(1_000),
  scope: z.string().trim().min(1).max(300).default("project"),
  triggers: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
  relatedKnowledge: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/).max(200)).max(8).default([]),
  references: z.array(z.string().trim().min(1).max(500)).max(30).default([]),
  content: z.string().trim().min(1).max(20_000),
});
export type SkillInput = z.input<typeof skillInputSchema>;
export type SkillStatus = "active" | "candidate" | "dismissed" | "superseded";
export interface ProjectSkill extends z.output<typeof skillInputSchema> {
  id: string;
  status: SkillStatus;
  origin: "explicit-user" | "session-inference" | "legacy";
  createdAt: string;
  updatedAt: string;
  sourceSessions: string[];
  derivedFrom: string[];
  proposedReason: string | null;
  reviewedAt: string | null;
  reviewReason: string | null;
  path: string;
  promotedTo?: string;
  candidateTitle?: string;
}

export function renderSkill(skill: ProjectSkill): string {
  assertNoSecrets(skill);
  return frontmatter({
    kind: "project-skill", version: 2, id: skill.id, title: skill.title, status: skill.status,
    scope: skill.scope, description: skill.description, triggers: skill.triggers,
    origin: skill.origin, created_at: skill.createdAt, updated_at: skill.updatedAt,
    source_sessions: skill.sourceSessions, derived_from: skill.derivedFrom,
    references: skill.references,
    ...(skill.relatedKnowledge.length ? { related_knowledge: skill.relatedKnowledge } : {}),
    ...(skill.promotedTo ? { review_status: "promoted", promoted_to: skill.promotedTo, candidate_title: skill.candidateTitle } : {}),
    proposed_reason: skill.proposedReason, reviewed_at: skill.reviewedAt, review_reason: skill.reviewReason,
  }, skillMarkdown(skill));
}

export function parseSkill(text: string, filename: string): ProjectSkill {
  assertNoSecrets(text);
  const normalizedText = text.replace(/\r\n/g, "\n");
  if (normalizedText.startsWith("---\n") && normalizedText.indexOf("\n---\n", 4) < 0) throw new Error(`Invalid project skill frontmatter: ${filename}`);
  const { metadata: m, body } = parseFrontmatter(normalizedText, filename);
  const legacy = (m.kind === undefined || m.kind === "skill") && m.version === undefined && !filename.startsWith("skill_") && !(typeof m.id === "string" && m.id.startsWith("skill_"));
  const title = typeof m.title === "string" ? m.title : body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? path.basename(filename, ".md");
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const nullable = (value: unknown) => typeof value === "string" ? value : null;
  if (m.status !== undefined && !["active", "candidate", "dismissed", "superseded"].includes(String(m.status))) throw new Error(`Invalid project skill status: ${filename}`);
  if (!legacy && (m.kind !== "project-skill" || ![1, 2].includes(m.version as number) || !["active", "candidate", "dismissed", "superseded"].includes(String(m.status)))) throw new Error(`Invalid project skill: ${filename}`);
  if (!legacy && typeof m.id !== "string") throw new Error(`Invalid project skill ID: ${filename}`);
  for (const field of ["created_at", "updated_at"]) if ((!legacy || m[field] !== undefined) && (typeof m[field] !== "string" || !Number.isFinite(Date.parse(m[field] as string)))) throw new Error(`Invalid project skill ${field}: ${filename}`);
  for (const field of ["source_sessions", "derived_from"]) if ((!legacy || m[field] !== undefined) && (!Array.isArray(m[field]) || !(m[field] as unknown[]).every(v => typeof v === "string"))) throw new Error(`Invalid project skill ${field}: ${filename}`);
  const id = typeof m.id === "string" ? m.id : path.basename(filename, ".md");
  if (!/^[a-zA-Z0-9_-]+$/.test(id) || (!legacy && filename !== `${id}.md`)) throw new Error(`Invalid project skill ID: ${filename}`);
  let procedureBody: string | undefined;
  if (m.version === 2) {
    const prefix = skillPreamble({ title, description: String(m.description ?? ""), scope: String(m.scope ?? "project"), triggers: strings(m.triggers) });
    if (!body.startsWith(prefix)) throw new Error(`Invalid Project Skill sections: ${filename}`);
    const references = strings(m.references);
    const sources = strings(m.derived_from);
    const related = relatedKnowledgeMarkdown(strings(m.related_knowledge));
    const suffix = `${related}${references.length ? `\n\n## References\n\n${references.map(r => `- ${r}`).join("\n")}` : ""}${sources.length ? `\n\n## Based on\n\n${m.candidate_title ?? title}\n\n${sources.map(r => `- ${r}`).join("\n")}` : ""}`;
    const remaining = body.slice(prefix.length).trimEnd();
    if (suffix && !remaining.endsWith(suffix)) throw new Error(`Invalid Project Skill references: ${filename}`);
    procedureBody = (suffix ? remaining.slice(0, -suffix.length) : remaining).trim();
  }
  const content = procedureBody ?? (legacy ? body.trim() : body.replace(/^# [^\n]*\n+/, "").trim());
  const parsedInput = skillInputSchema.safeParse({ title, content, description: m.description ?? (legacy ? title : undefined), scope: m.scope ?? "project", triggers: m.triggers ?? [], references: m.references ?? [], relatedKnowledge: m.related_knowledge ?? [] });
  if (!parsedInput.success) throw new Error(`Invalid project skill: ${filename} (${parsedInput.error.issues.map(i => i.path.join(".")).join(", ")}).`);
  if (!legacy && !["explicit-user", "session-inference", "legacy"].includes(String(m.origin))) throw new Error(`Invalid project skill origin: ${filename}`);
  const input = parsedInput.data;
  return {
    ...input, id, status: (m.status ?? "active") as SkillStatus,
    origin: legacy ? "legacy" : m.origin as ProjectSkill["origin"],
    createdAt: nullable(m.created_at) ?? new Date(0).toISOString(), updatedAt: nullable(m.updated_at) ?? new Date(0).toISOString(),
    sourceSessions: strings(m.source_sessions), derivedFrom: strings(m.derived_from),
    proposedReason: nullable(m.proposed_reason), reviewedAt: nullable(m.reviewed_at), reviewReason: nullable(m.review_reason),
    ...(typeof m.promoted_to === "string" ? { promotedTo: m.promoted_to, candidateTitle: String(m.candidate_title ?? title) } : {}),
    path: `skills/${filename}`,
  };
}

export async function listProjectSkills(root: string): Promise<ProjectSkill[]> {
  const skills: ProjectSkill[] = [];
  for (const relative of ["skills", "local/skills"]) {
    const directory = await checkedDataPath(root, relative);
    if (!(await exists(directory))) continue;
    const entries = (await fs.readdir(directory, { withFileTypes: true })).filter(e => (e.isFile() || e.isSymbolicLink()) && e.name.endsWith(".md") && !e.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const skill = parseSkill(await fs.readFile(await checkedDataPath(root, relative, entry.name), "utf8"), entry.name);
      skill.path = `${relative}/${entry.name}`;
      // The local receipt preserves observation replay identity after reviewed publication.
      if (relative === "local/skills" && skill.status === "superseded" && skill.promotedTo === skill.id && skills.some(s => s.id === skill.id)) continue;
      skills.push(skill);
    }
  }
  if (new Set(skills.map((skill) => skill.id)).size !== skills.length) throw new Error("Duplicate project skill IDs; resolve the Markdown files before continuing.");
  return skills.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

async function requireProject(root: string) {
  if (!(await readConfig(root))) throw new Error("Prodero is not initialized for this project.");
}

export async function createProjectSkill(root: string, input: SkillInput, sourceSession?: string): Promise<ProjectSkill> {
  assertNoSecrets([input, sourceSession]);
  return withSyncLock(root, () => createProjectSkillLocked(root, input, sourceSession), { waitMs: 5_000 });
}

async function createProjectSkillLocked(root: string, input: SkillInput, sourceSession?: string): Promise<ProjectSkill> {
  await requireProject(root);
  const now = new Date();
  const id = sortableId("skill", now);
  const skill: ProjectSkill = {
    ...skillInputSchema.parse(input), id, status: "active", origin: "explicit-user",
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
    sourceSessions: sourceSession ? [sourceSession] : [], derivedFrom: [], proposedReason: null,
    reviewedAt: null, reviewReason: null, path: `skills/${id}.md`,
  };
  await writeFileExclusive(await checkedDataPath(root, skill.path), renderSkill(skill));
  return skill;
}

/** Stable observation identity makes replay safe even after promotion or dismissal. */
export async function createSkillCandidate(root: string, input: SkillInput, provenance: { sessionId: string; derivedFrom: string; proposedReason?: string }, now = new Date(), writes?: Map<string, PlannedWrite>): Promise<{ skill: ProjectSkill; created: boolean }> {
  assertNoSecrets([input, provenance]);
  if (writes) return createSkillCandidateLocked(root, input, provenance, now, writes);
  return withSyncLock(root, () => createSkillCandidateLocked(root, input, provenance, now), { waitMs: 5_000 });
}

async function createSkillCandidateLocked(root: string, input: SkillInput, provenance: { sessionId: string; derivedFrom: string; proposedReason?: string }, now: Date, writes?: Map<string, PlannedWrite>): Promise<{ skill: ProjectSkill; created: boolean }> {
  await requireProject(root);
  const id = `skill_${sha256(provenance.derivedFrom).slice(0, 32)}`;
  const filename = `${id}.md`;
  await ensureDataDirectory(root, "local/skills");
  const target = await checkedDataPath(root, "local/skills", filename);
  const published = (await listProjectSkills(root)).find(s => s.id === id);
  if (published) {
    if (!published.derivedFrom.includes(provenance.derivedFrom)) throw new Error("Project skill provenance collision");
    return { skill: published, created: false };
  }
  const skill: ProjectSkill = {
    ...skillInputSchema.parse(input), id, status: "candidate", origin: "session-inference",
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
    sourceSessions: [provenance.sessionId], derivedFrom: [provenance.derivedFrom],
    proposedReason: provenance.proposedReason ?? null, reviewedAt: null, reviewReason: null, path: `local/skills/${filename}`,
  };
  if (writes) {
    const staged = writes.get(skill.path);
    if (staged || await exists(target)) {
      const existing = parseSkill(staged?.after ?? await fs.readFile(target, "utf8"), filename);
      if (!existing.derivedFrom.includes(provenance.derivedFrom)) throw new Error(`Project skill provenance collision: ${id}`);
      return { skill: existing, created: false };
    }
    writes.set(skill.path, { path: skill.path, before: null, after: renderSkill(skill) });
    return { skill, created: true };
  }
  try { await writeFileExclusive(target, renderSkill(skill)); return { skill, created: true }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = parseSkill(await fs.readFile(target, "utf8"), filename);
    if (!existing.derivedFrom.includes(provenance.derivedFrom)) throw new Error(`Project skill provenance collision: ${id}`);
    return { skill: existing, created: false };
  }
}

export async function getProjectSkill(root: string, id: string): Promise<ProjectSkill> {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid project skill ID.");
  const skill = (await listProjectSkills(root)).find((item) => item.id === id);
  if (!skill) throw new Error(`Project skill ${id} was not found.`);
  return skill;
}

export async function reviewProjectSkill(root: string, id: string, action: "promote" | "dismiss", reason?: string, approval?: { approved: boolean; preview: SkillPreview }): Promise<ProjectSkill> {
  assertNoSecrets([reason, approval]);
  await requireProject(root);
  return withSyncLock(root, async () => {
    await recoverSyncTransaction(root);
    const skill = await getProjectSkill(root, id);
    if (action === "dismiss" && !skill.path.startsWith("local/")) throw new Error("Legacy Versioned skill proposals require explicit repository maintenance before local dismissal. Move the proposal into .prodero/local/skills and review the Git diff.");
    const targetStatus = action === "promote" ? "active" : "dismissed";
    if (skill.status === targetStatus && action === "dismiss") return skill;
    const activeRevision = skill.status === "active" && approval?.preview.target?.id === id && approval.preview.disposition?.action === "update";
    if (skill.status !== "candidate" && !activeRevision) throw new Error(`Only candidate skills can be ${action === "promote" ? "promoted" : "dismissed"}.`);
    if (activeRevision && action === "dismiss") throw new Error("Cancel an active skill revision without dismissing the active skill.");
    if (action === "promote") {
      if (!approval?.approved) throw new Error("Workflow approval of a Project Skill preview is required.");
      const { preview } = approval;
      const { validateSkillDraft } = await import("./skill-curation.js");
      const draft = await validateSkillDraft(root, preview.draft);
      if (preview.candidateId !== id || preview.candidateRevision !== candidateRevision(skill) || preview.previewId !== previewIdentity(skill, draft, preview.target, preview.disposition)) throw new Error("The candidate or preview changed. Open a fresh preview before approving.");
      if (preview.disposition?.action === "covered") throw new Error("Candidate already covered. Review the existing skill or dismiss the candidate.");
      if (preview.target) {
        const target = await getProjectSkill(root, preview.target.id);
        if (target.status !== "active" || candidateRevision(target) !== preview.target.revision) throw new Error("The existing skill changed. Open a fresh preview.");
        if (target.id !== id) {
          const beforeCandidate = await fileHash(await safeProjectPath(root, skill.path));
          const beforeTarget = await fileHash(await safeProjectPath(root, target.path));
          Object.assign(target, draft);
          target.sourceSessions = [...new Set([...target.sourceSessions, ...skill.sourceSessions])];
          target.derivedFrom = [...new Set([...target.derivedFrom, ...skill.derivedFrom])];
          target.updatedAt = target.reviewedAt = new Date().toISOString(); target.reviewReason = reason?.trim() || null;
          skill.status = "superseded"; skill.promotedTo = target.id; skill.candidateTitle = skill.title;
          skill.updatedAt = skill.reviewedAt = target.updatedAt; skill.reviewReason = reason?.trim() || null;
          const { discoverSessions } = await import("./session-index.js");
          const checkpointId = sortableId("chk");
          const checkpoint: import("./types.js").Checkpoint = { id: checkpointId, createdAt: target.updatedAt, previousCheckpoint: (await discoverSessions(root)).latestCheckpointId, sessions: [], consolidation: "not-performed", createdMemory: [], updatedMemory: [], supersededMemory: [], duplicateMemory: [], conflicts: [], summary: { sessions: 0, candidates: 0, created: 0, consolidated: 0, duplicates: 0, superseded: 0, conflicts: 0 }, note: `Human-approved skill update: ${id} → ${target.id}` };
          await commitSyncTransaction(root, [{ path: target.path, before: beforeTarget, after: renderSkill(target) }, { path: skill.path, before: beforeCandidate, after: renderSkill(skill) }, { path: `checkpoints/${checkpointId}.json`, before: null, after: JSON.stringify(checkpoint, null, 2) + "\n" }]);
          return target;
        }
      }
      skill.promotedTo = id;
      skill.candidateTitle ??= skill.title;
      Object.assign(skill, draft);
    }
    skill.status = targetStatus;
    skill.updatedAt = skill.reviewedAt = new Date().toISOString();
    skill.reviewReason = reason?.trim() || null;
    if (action === "promote" && skill.path.startsWith("local/")) {
      const before = await fileHash(await safeProjectPath(root, skill.path));
      const receipt = { ...skill, status: "superseded" as const, promotedTo: skill.id };
      const localPath = skill.path;
      skill.path = `skills/${skill.id}.md`;
      const { discoverSessions } = await import("./session-index.js");
      const checkpointId = sortableId("chk");
      const checkpoint: import("./types.js").Checkpoint = { id: checkpointId, createdAt: skill.updatedAt, previousCheckpoint: (await discoverSessions(root)).latestCheckpointId, sessions: [], consolidation: "not-performed", createdMemory: [], updatedMemory: [], supersededMemory: [], duplicateMemory: [], conflicts: [], summary: { sessions: 0, candidates: 0, created: 0, consolidated: 0, duplicates: 0, superseded: 0, conflicts: 0 }, note: `Human-approved skill publication: ${id}` };
      await commitSyncTransaction(root, [{ path: localPath, before, after: renderSkill(receipt) }, { path: skill.path, before: null, after: renderSkill(skill) }, { path: `checkpoints/${checkpointId}.json`, before: null, after: JSON.stringify(checkpoint, null, 2) + "\n" }]);
    } else await writeFileAtomic(await checkedDataPath(root, skill.path), renderSkill(skill));
    return skill;
  });
}

export function skillCounts(skills: ProjectSkill[]) {
  return { active: skills.filter((s) => s.status === "active").length, candidate: skills.filter((s) => s.status === "candidate").length, dismissed: skills.filter((s) => s.status === "dismissed").length };
}

/** Context text includes every instructional field and is charged independently of knowledge. */
export function skillContext(skill: ProjectSkill) {
  const content = skill.origin === "legacy" ? skill.content : skillMarkdown(skill);
  return { id: skill.id, path: skill.path, title: skill.title, content, description: skill.description, triggers: skill.triggers, category: "skill" as const, scope: skill.scope, estimatedTokens: estimateTokens(content) };
}

export function scoreSkill(query: string, skill: Pick<ProjectSkill, "title" | "description" | "triggers" | "scope">) {
  // Include path components as well as complete paths for module-scoped queries.
  const tokenize = (value: string) => tokens(`${value} ${value.replace(/[._/-]/g, " ")}`);
  const generic = new Set(["test", "tests", "testing", "verify", "verification", "check", "checks", "run", "change", "changes", "changing", "project", "projects", "temporary", "fixture", "fixtures", "procedure", "procedures", "files", "file", "src", "core", "ts", "mjs", "md", "build", "existing", "state", "status", "task", "tasks", "update", "add", "implement"]);
  const queryTokens = new Set([...tokenize(query)].filter((word) => !generic.has(word)));
  // Broad nouns alone cannot establish the domain of a procedure (e.g. npm cache vs derived cache).
  const ambiguous = new Set(["cache", "caches", "caching", "data", "local", "memory", "server", "client", "application", "recovery"]);
  const fields = [
    ["title", skill.title, 8], ["description", skill.description, 4],
    ["trigger", skill.triggers.join(" "), 10], ["scope", skill.scope === "project" ? "" : skill.scope, 6],
  ] as const;
  const signals = fields.flatMap(([field, value, weight]) => {
    const fieldTokens = tokenize(value);
    const matches = [...queryTokens].filter((token) => fieldTokens.has(token)).sort();
    return matches.length ? [{ field, matches, score: matches.length * weight }] : [];
  });
  const matched = new Set(signals.flatMap(s => s.matches));
  const domainMatch = [...matched].some(t => !ambiguous.has(t));
  const enoughContext = matched.size >= 2;
  return { score: domainMatch || enoughContext ? signals.reduce((sum, signal) => sum + signal.score, 0) : 0, signals };
}

export async function projectSkillsView(root: string, options: { status?: SkillStatus; offset?: number; limit?: number } = {}) {
  await requireProject(root);
  const all = await listProjectSkills(root);
  const filtered = all.filter((skill) => options.status ? skill.status === options.status : ["active", "candidate"].includes(skill.status));
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.min(50, Math.max(1, options.limit ?? 20));
  const skills = filtered.slice(offset, offset + limit).map(({ content, ...skill }) => ({ ...skill, contentPreview: content.slice(0, 500) }));
  return { root, skills, counts: skillCounts(all), offset, total: filtered.length, nextOffset: offset + skills.length < filtered.length ? offset + skills.length : null };
}

/** A portable readable body; the resolver uses this same text for the agent and UI. */
function skillPreamble(skill: Pick<ProjectSkill, "title" | "description" | "scope" | "triggers">) {
  const when = skill.triggers.length ? skill.triggers.map(t => `- ${t}`).join("\n") : `- Working within ${skill.scope}: ${skill.title}`;
  return `# ${skill.title}\n\n## Purpose\n\n${skill.description}\n\nScope: ${skill.scope}\n\n## Use when\n\n${when}\n\n## Procedure\n\n`;
}
function relatedKnowledgeMarkdown(ids: string[]) {
  return ids.length ? `\n\n## Related knowledge\n\n${ids.map(id => `- [${id}](../memory/${id}.md)`).join("\n")}` : "";
}
export function skillMarkdown(skill: Pick<ProjectSkill, "title" | "description" | "scope" | "triggers" | "content" | "references"> & Partial<ProjectSkill>): string {
  const references = skill.references.length ? `\n\n## References\n\n${skill.references.map(r => `- ${r}`).join("\n")}` : "";
  const sources = skill.derivedFrom?.length ? `\n\n## Based on\n\n${skill.candidateTitle ?? skill.title}\n\n${skill.derivedFrom.map(r => `- ${r}`).join("\n")}` : "";
  return `${skillPreamble(skill)}${skill.content}${relatedKnowledgeMarkdown(skill.relatedKnowledge ?? [])}${references}${sources}`;
}
export interface SkillPreview {
  candidateId: string;
  candidateRevision: string;
  previewId: string;
  draft: z.output<typeof skillInputSchema>;
  mode: "deterministic" | "assisted" | "edited";
  notice?: string;
  disposition?: import("./skill-curation.js").SkillDisposition;
  target?: { id: string; title: string; revision: string };
  reasoningSummary?: string;
  relatedKnowledge?: Array<{ id: string; title: string; content: string }>;
}
export function candidateRevision(skill: ProjectSkill) { return sha256(JSON.stringify(skill)); }
function previewIdentity(skill: ProjectSkill, draft: z.output<typeof skillInputSchema>, target?: SkillPreview["target"], disposition?: SkillPreview["disposition"]) { return sha256(JSON.stringify([candidateRevision(skill), draft, target ?? null, disposition ?? null])); }
export function deterministicSkillDraft(candidate: ProjectSkill) {
  const references = [...new Set([...candidate.references, ...[...candidate.content.matchAll(/`([^`]+)`/g)].map(m => m[1]).filter(r => r.length <= 500 && /(?:\/|\.(?:md|ts|js|mjs|json|yaml|yml)$)/i.test(r))])].slice(0, 30);
  return skillInputSchema.parse({ title: candidate.title, description: candidate.description, scope: candidate.scope, triggers: candidate.triggers, content: candidate.content, references, relatedKnowledge: candidate.relatedKnowledge });
}
export async function previewProjectSkill(root: string, id: string, options: { draft?: SkillInput; provider?: import("./intelligence.js").IntelligenceProvider; recurate?: boolean; previousPreview?: SkillPreview } = {}): Promise<SkillPreview> {
  assertNoSecrets([options.draft, options.previousPreview]);
  const candidate = await getProjectSkill(root, id);
  if (candidate.status !== "candidate" && !(candidate.status === "active" && (options.recurate || options.previousPreview))) throw new Error("Only candidate skills can be previewed; explicitly request re-curation to propose an active skill update.");
  let draft = deterministicSkillDraft(candidate);
  let mode: SkillPreview["mode"] = "deterministic";
  let notice: string | undefined;
  let disposition: SkillPreview["disposition"];
  let target: SkillPreview["target"];
  let reasoningSummary: string | undefined;
  let relatedKnowledge: SkillPreview["relatedKnowledge"];
  const { validateSkillDraft } = await import("./skill-curation.js");
  if (options.draft) {
    if (options.recurate) throw new Error("Edit and re-curate are separate actions.");
    if (options.previousPreview) {
      const previous = options.previousPreview;
      if (previous.candidateId !== id || previous.previewId !== previewIdentity(candidate, skillInputSchema.parse(previous.draft), previous.target, previous.disposition)) throw new Error("The candidate changed. Open a fresh preview.");
      disposition = previous.disposition; target = previous.target;
      reasoningSummary = previous.reasoningSummary; relatedKnowledge = previous.relatedKnowledge;
    }
    draft = await validateSkillDraft(root, options.draft); mode = "edited";
  } else if (options.provider?.curateSkill) {
    const { curateProjectSkill } = await import("./skill-curation.js");
    const result = await curateProjectSkill(root, candidate, options.provider);
    ({ draft, mode, notice, disposition, reasoningSummary, relatedKnowledge } = result);
    target = "target" in result ? result.target : undefined;
  } else if (options.provider?.polishSkill) {
    const { polishSkillDraft } = await import("./skill-polish.js");
    const result = await polishSkillDraft(options.provider, draft);
    draft = result.draft; mode = result.mode; notice = result.notice;
  }
  if (candidate.status === "active") disposition = { action: "update", targetSkillId: id };
  if (disposition?.targetSkillId) {
    const current = await getProjectSkill(root, disposition.targetSkillId);
    if (current.status !== "active" || (target && target.revision !== candidateRevision(current))) throw new Error("The existing skill changed. Open a fresh preview.");
    target = { id: current.id, title: current.title, revision: candidateRevision(current) };
  }
  return { candidateId: id, candidateRevision: candidateRevision(candidate), previewId: previewIdentity(candidate, draft, target, disposition), draft, mode, ...(notice ? { notice } : {}), ...(disposition ? { disposition } : {}), ...(target ? { target } : {}), ...(reasoningSummary ? { reasoningSummary } : {}), ...(relatedKnowledge?.length ? { relatedKnowledge } : {}) };
}
