import { writeFileExclusive } from "./storage.js";
import {validateApplicability,inferApplicability,buildTaskContext,type TaskContext} from "./applicability.js";
import { assertPathScope } from "./path-scope.js";
import { assertNoSecrets } from "./secrets.js";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { frontmatter, parseFrontmatter, sectionBullets } from "./format.js";
import { skillInputSchema } from "./skills.js";
import { sortableId } from "./ids.js";
import { exists, projectDataPath, checkedDataPath } from "./storage.js";
import { writeFileAtomic } from "./storage.js";
import type { RecordedObservation, SessionMemory, SessionObservationInput, SessionObservationType, SessionSection, SessionStatus } from "./types.js";
import { withSyncLock } from "./sync-transaction.js";
import { assertEnglishProse } from "./language.js";

const exec = promisify(execFile);
export const SESSION_SECTIONS = [
  "Decisions",
  "Lessons",
  "Discoveries",
  "Project State Changes",
  "Global Instruction Candidates",
  "Skill Candidates",
] as const satisfies readonly SessionSection[];

export const OBSERVATION_SECTIONS: Record<SessionObservationType, SessionSection> = {
  decision: "Decisions",
  lesson: "Lessons",
  discovery: "Discoveries",
  state_change: "Project State Changes",
  global_instruction_candidate: "Global Instruction Candidates",
  skill_candidate: "Skill Candidates",
};

export class SessionFormatError extends Error {
  constructor(message: string) { super(`Invalid Prodero session: ${message}`); this.name = "SessionFormatError"; }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "null" ? value : null;
}

async function gitValue(root: string, args: string[]): Promise<string | null> {
  try { return (await exec("git", ["-C", root, ...args])).stdout.trim() || null; } catch { return null; }
}

export function renderSession(session: Omit<SessionMemory, "path" | "sections">, sections?: Partial<Record<SessionSection, string[]>>): string {
  assertNoSecrets([session, sections]);
  const body = [`# Prodero Session ${session.id}`];
  for (const heading of SESSION_SECTIONS) {
    body.push(`## ${heading}`);
    const items = sections?.[heading] ?? [];
    body.push(items.length ? items.map((item) => `- ${item.replace(/\r?\n/g, "\n  ")}`).join("\n") : "_No durable observations recorded._");
  }
  return frontmatter({
    id: session.id,
    kind: "session-memory",
    ...(session.taskContext?{task_context:session.taskContext}:{}),
    ...(session.parentSessionId ? { parent_session_id: session.parentSessionId } : {}),
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    status: session.status,
    agent: session.agent,
    branch: session.branch,
    base_commit: session.baseCommit,
  }, body.join("\n\n"));
}

export function parseSession(content: string, sessionPath: string): SessionMemory {
  assertNoSecrets(content);
  const { metadata, body } = parseFrontmatter(content, sessionPath);
  // v1 checkpoint-ready sessions used date-based IDs and omitted timestamps.
  const legacyCheckpoint = metadata.kind === "session-memory" && metadata.status === "checkpoint-ready" && metadata.version === undefined
    && typeof metadata.id === "string" && /^\d{4}-\d{2}-\d{2}-[a-zA-Z0-9_-]+$/.test(metadata.id) && `${metadata.id}.md` === path.basename(sessionPath);
  const modern = !legacyCheckpoint && (metadata.kind === "session-memory" || path.basename(sessionPath).startsWith("sess_"));
  if (metadata.kind !== undefined && metadata.kind !== "session-memory") throw new SessionFormatError(`${sessionPath} has unsupported kind.`);
  if (metadata.version !== undefined) throw new SessionFormatError(`${sessionPath} has unsupported version.`);
  if (modern && (typeof metadata.id !== "string" || !/^sess_[a-zA-Z0-9_]+$/.test(metadata.id) || metadata.id !== path.basename(sessionPath, ".md"))) throw new SessionFormatError(`${sessionPath} id does not match its filename.`);
  if (!legacyCheckpoint && (modern || metadata.status !== undefined) && !["active", "open", "closed"].includes(String(metadata.status))) throw new SessionFormatError(`${sessionPath} has unsupported status.`);
  for (const field of ["created_at", "updated_at"]) if ((modern || metadata[field] !== undefined) && (typeof metadata[field] !== "string" || !Number.isFinite(Date.parse(metadata[field] as string)))) throw new SessionFormatError(`${sessionPath} has invalid ${field}.`);
  if (metadata.parent_session_id !== undefined && (typeof metadata.parent_session_id !== "string" || !/^sess_[a-zA-Z0-9_]+$/.test(metadata.parent_session_id) || metadata.parent_session_id === metadata.id)) throw new SessionFormatError(`${sessionPath} has invalid parent_session_id.`);
  const statelessId = path.basename(sessionPath, path.extname(sessionPath));
  const createdAt = stringOrNull(metadata.created_at) ?? new Date(0).toISOString();
  const rawStatus = stringOrNull(metadata.status);
  const status: SessionStatus = rawStatus === "closed" || rawStatus === "active" ? rawStatus : "open";
  return {
    id: stringOrNull(metadata.id) ?? statelessId,
    ...(metadata.parent_session_id ? { parentSessionId: metadata.parent_session_id as string } : {}),
    ...(metadata.task_context?{taskContext:metadata.task_context as TaskContext}:{}),
    createdAt,
    updatedAt: stringOrNull(metadata.updated_at) ?? createdAt,
    status,
    agent: stringOrNull(metadata.agent) ?? "unknown",
    branch: stringOrNull(metadata.branch),
    baseCommit: stringOrNull(metadata.base_commit),
    path: path.basename(sessionPath),
    sections: sectionBullets(body, SESSION_SECTIONS) as Record<SessionSection, string[]>,
  };
}

function parseSessionStrict(content: string, sessionPath: string): SessionMemory {
  const { metadata } = parseFrontmatter(content);
  if (typeof metadata.id !== "string" || !/^sess_[a-zA-Z0-9_]+$/.test(metadata.id)) throw new SessionFormatError(`${sessionPath} has a missing or invalid id.`);
  if (metadata.status !== "open" && metadata.status !== "active" && metadata.status !== "closed") throw new SessionFormatError(`${sessionPath} has an unsupported status.`);
  if (typeof metadata.created_at !== "string" || Number.isNaN(Date.parse(metadata.created_at))) throw new SessionFormatError(`${sessionPath} has an invalid created_at.`);
  const session = parseSession(content, sessionPath);
  if (session.id !== path.basename(sessionPath, ".md")) throw new SessionFormatError(`${sessionPath} id does not match its filename.`);
  return session;
}

export async function listSessions(root: string): Promise<SessionMemory[]> {
  const directory = await checkedDataPath(root, "sessions");
  if (!(await exists(directory))) return [];
  const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".md") && !name.startsWith(".")).sort();
  const sessions: SessionMemory[] = [];
  for (const name of names) sessions.push(parseSession(await fs.readFile(await checkedDataPath(root, "sessions", name), "utf8"), name));
  return sessions;
}

export async function readSession(root: string, sessionId: string): Promise<SessionMemory> {
  const filename = sessionFilename(sessionId);
  const target = await checkedDataPath(root, "sessions", filename);
  if (!(await exists(target))) throw new Error(`Prodero session ${sessionId} was not found.`);
  return parseSessionStrict(await fs.readFile(target, "utf8"), filename);
}

export async function createSession(root: string, options: { agent?: string; status?: SessionStatus; parentSessionId?: string; taskContext?:TaskContext } = {}): Promise<SessionMemory> {
  assertNoSecrets(options);
  return withSyncLock(root, () => createSessionLocked(root, options), { waitMs: 5_000 });
}

async function createSessionLocked(root: string, options: { agent?: string; status?: SessionStatus; parentSessionId?: string; taskContext?:TaskContext }): Promise<SessionMemory> {
  if (options.parentSessionId) {
    const parent = await readSession(root, options.parentSessionId);
    if (parent.status === "closed" || parent.parentSessionId) throw new Error("Remember provenance requires an active work session.");
  }
  const id = sortableId("sess");
  const now = new Date().toISOString();
  const session = {
    id,
    ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
    ...(options.taskContext?{taskContext:options.taskContext}:{}),
    createdAt: now,
    updatedAt: now,
    status: options.status ?? "active",
    agent: options.agent ?? "coding-agent",
    branch: await gitValue(root, ["branch", "--show-current"]),
    baseCommit: await gitValue(root, ["rev-parse", "HEAD"]),
  };
  const filename = `${id}.md`;
  await writeFileExclusive(await checkedDataPath(root, "sessions", filename), renderSession(session));
  return parseSession(await fs.readFile(await checkedDataPath(root, "sessions", filename), "utf8"), filename);
}

function sessionFilename(sessionId: string): string {
  if (!/^sess_[a-zA-Z0-9_]+$/.test(sessionId)) throw new SessionFormatError("sessionId is malformed.");
  return `${sessionId}.md`;
}

function annotationValue(value: string): string {
  return JSON.stringify(value.trim());
}

export function serializeObservation(id: string, entry: SessionObservationInput): string {
  const attributes = [`id=${id}`];
  if (entry.title?.trim()) attributes.push(`title=${annotationValue(entry.title)}`);
  if(entry.applicability)attributes.push(`applicability=${annotationValue(JSON.stringify(validateApplicability(entry.applicability)))}`);
  if (entry.scopeKind) attributes.push(`scope_kind=${entry.scopeKind}`);
  if (entry.scopeHint) attributes.push(`scope=${entry.scopeHint}`);
  if (entry.scopeRef?.trim()) attributes.push(`scope_ref=${annotationValue(entry.scopeRef)}`);
  if (entry.importanceHint) attributes.push(`priority=${entry.importanceHint}`);
  if (entry.categoryHint) attributes.push(`category=${entry.categoryHint}`);
  if (entry.description) attributes.push(`description=${annotationValue(entry.description)}`);
  if (entry.triggers) attributes.push(`triggers=${annotationValue(JSON.stringify(entry.triggers))}`);
  if (entry.proposedReason) attributes.push(`proposed_reason=${annotationValue(entry.proposedReason)}`);
  if (entry.supersedes?.length) attributes.push(`supersedes=${annotationValue(entry.supersedes.join(","))}`);
  if (entry.relations?.length) attributes.push(`relations=${annotationValue(JSON.stringify(entry.relations))}`);
  const content = entry.type === "skill_candidate" ? entry.content.trim() : entry.content.replace(/\s+/g, " ").trim();
  return `[${attributes.join(" ")}] ${content}`;
}

export function validateEntries(entries: SessionObservationInput[]): void {
  assertNoSecrets(entries);
  if (entries.length > 100) throw new Error("A Prodero session record batch may contain at most 100 observations.");
  for (const entry of entries) {
    if(entry.applicability)validateApplicability(entry.applicability);
    if (entry.scopeKind !== undefined && !["path", "topic"].includes(entry.scopeKind)) throw new Error("Invalid scope kind");
    assertPathScope({ scope: entry.scopeHint ?? "task", scopeRef: entry.scopeRef ?? null, scopeKind: entry.scopeKind });
    if (!(entry.type in OBSERVATION_SECTIONS)) throw new Error(`Unsupported Prodero observation type: ${String(entry.type)}.`);
    const content = entry.content.trim();
    if (!content) throw new Error("Prodero session observations require non-empty content.");
    assertEnglishProse([entry.title, content, entry.description, ...(entry.triggers ?? []), entry.proposedReason], "Prodero session knowledge");
    if (entry.type === "skill_candidate") {
      skillInputSchema.parse({ title: entry.title ?? "Candidate", description: entry.description ?? "Candidate", content, scope: entry.scopeRef ?? "project", triggers: entry.triggers ?? [] });
      if (entry.proposedReason && entry.proposedReason.length > 1_000) throw new Error("Skill proposal reasons may not exceed 1,000 characters.");
    }
    if (entry.supersedes?.some((id) => !/^mem_[a-zA-Z0-9_]+$/.test(id))) throw new Error("Superseded Prodero memory ids are malformed.");
    if (entry.relations?.some((relation) => !["related_to", "depends_on", "implements"].includes(relation.type) || !/^mem_[a-zA-Z0-9_]+$/.test(relation.target))) throw new Error("Prodero memory relationships are malformed.");
    if (content.length > 10_000) throw new Error("A Prodero session observation may not exceed 10,000 characters.");
  }
}

async function mutateSession(root: string, sessionId: string, entries: SessionObservationInput[], close: boolean) {
  return withSyncLock(root, () => mutateSessionLocked(root, sessionId, entries, close), { waitMs: 5_000 });
}

async function mutateSessionLocked(root: string, sessionId: string, entries: SessionObservationInput[], close: boolean) {
  const context=(await readSession(root,sessionId)).taskContext;
  entries=entries.map(entry=>({...entry,applicability:entry.applicability??(['skill_candidate','global_instruction_candidate'].includes(entry.type)?undefined:entry.taskContext?inferApplicability(entry.content,buildTaskContext('',entry.taskContext)):entry.scopeHint?{kind:'legacy'}:inferApplicability(entry.content,context))}));
  validateEntries(entries);
  const filename = sessionFilename(sessionId);
  const target = await checkedDataPath(root, "sessions", filename);
  const session = await readSession(root, sessionId);
  if (session.status === "closed") {
    // Retrying an identical final batch after a lost response or failed Sync must
    // not append fresh observation IDs. Compare the recorded suffix per section.
    const repeatedBatch = SESSION_SECTIONS.every((section) => {
      const expected = entries.filter((entry) => OBSERVATION_SECTIONS[entry.type] === section)
        .map((entry) => serializeObservation("retry", entry));
      const actual = session.sections[section].slice(-expected.length)
        .map((entry) => entry.replace(/^\[id=obs_[a-zA-Z0-9_]+/, "[id=retry"));
      return expected.length === 0 || (actual.length === expected.length && expected.every((entry, index) => entry === actual[index]));
    });
    if (close && repeatedBatch) return { session, recorded: [] as RecordedObservation[], alreadyClosed: true };
    throw new Error(`Prodero session ${sessionId} is closed and cannot accept new observations.`);
  }

  const recorded: RecordedObservation[] = [];
  for (const entry of entries) {
    if(entry.applicability)validateApplicability(entry.applicability);
    if (entry.scopeKind !== undefined && !["path", "topic"].includes(entry.scopeKind)) throw new Error("Invalid scope kind");
    assertPathScope({ scope: entry.scopeHint ?? "task", scopeRef: entry.scopeRef ?? null, scopeKind: entry.scopeKind });
    const id = sortableId("obs");
    session.sections[OBSERVATION_SECTIONS[entry.type]].push(serializeObservation(id, entry));
    recorded.push({ id, type: entry.type, content: entry.content.trim() });
  }
  session.updatedAt = new Date().toISOString();
  if (close) session.status = "closed";
  await writeFileAtomic(target, renderSession(session, session.sections));
  return { session: parseSessionStrict(await fs.readFile(target, "utf8"), filename), recorded, alreadyClosed: false };
}

export async function recordSessionObservations(root: string, sessionId: string, entries: SessionObservationInput[]) {
  if (!entries.length) throw new Error("Prodero session recording requires at least one observation.");
  return mutateSession(root, sessionId, entries, false);
}

export async function closeSession(root: string, sessionId: string, finalEntries: SessionObservationInput[] = []) {
  return mutateSession(root, sessionId, finalEntries, true);
}

/** A retry explicitly refreshes future observation context, not previously delivered snapshots. */
export async function updateSessionTaskContext(root:string,id:string,context:TaskContext):Promise<SessionMemory> {
 return withSyncLock(root,async()=>{
  const session=await readSession(root,id);
  if(session.status==='closed')throw new Error('Cannot enrich a closed session');
  session.taskContext=context;
  await writeFileAtomic(await checkedDataPath(root,'sessions',sessionFilename(id)),renderSession(session,session.sections));
  return session;
 });
}
