import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE, tightenPrivateMode } from "../filesystem/permissions.js";
import { presentationConfigSchema } from "../settings-definition.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PRODERO_DIRECTORY, PROJECT_DIRECTORIES, PRODERO_SCHEMA_VERSION, PRODERO_KNOWLEDGE_SCHEMA_VERSION } from "./constants.js";
import { z } from "zod";
import type { Checkpoint, ProderoConfig } from "./types.js";

const LOCAL_STATE_DIRECTORIES = ["local", "sessions", "checkpoints", ".cache", ".transactions", ".backups", ".migrations"] as const;
export const LOCAL_STATE_IGNORE_RULES = [
  ...LOCAL_STATE_DIRECTORIES.flatMap(directory => ["sessions", "checkpoints"].includes(directory)
    ? [`${PRODERO_DIRECTORY}/${directory}/*`, `!${PRODERO_DIRECTORY}/${directory}/.gitkeep`]
    : [`${PRODERO_DIRECTORY}/${directory}/`]),
  // Atomic scratch files are never Versioned content, even next to a Versioned target.
  `${PRODERO_DIRECTORY}/**/*.tmp-*`,
];
const ignoreUpdates = new Map<string, Promise<void>>();
/** Install directory-wide exclusions before creating Local/runtime state. Preserve user rules/files. */
export async function ensureLocalStateIgnored(root: string): Promise<void> {
  const target = path.resolve(root, ".gitignore");
  const pending = ignoreUpdates.get(target);
  if (pending) return pending;
  const update = (async () => {
    await assertSafePath(target);
    const existing = await fs.readFile(target, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
    const lines = existing.split(/\r?\n/);
    const missing = LOCAL_STATE_IGNORE_RULES.filter(rule => !lines.includes(rule));
    if (missing.length) await writeFileAtomic(target, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
  })();
  ignoreUpdates.set(target, update);
  try { await update; } finally { ignoreUpdates.delete(target); }
}

/** The outer private store wins for nested migration staging projects. */
export function privateStateRoot(target: string): string | null {
  const parts = path.resolve(target).split(path.sep);
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === PRODERO_DIRECTORY && LOCAL_STATE_DIRECTORIES.some(name => name === parts[i + 1])) return parts.slice(0, i + 2).join(path.sep);
  }
  return null;
}

export async function protectPrivatePath(target: string): Promise<void> {
  const root = privateStateRoot(target);
  if (!root) return;
  await assertSafePath(target);
  let cursor = root;
  for (const part of ["", ...path.relative(root, target).split(path.sep).filter(Boolean)]) {
    if (part) cursor = path.join(cursor, part);
    await tightenPrivateMode(cursor);
  }
}

/** Create only the requested path; never recursively chmod preexisting children. */
export async function ensureStorageDirectory(target: string, forcePrivate = false): Promise<void> {
  await assertSafePath(target);
  const privateRoot = privateStateRoot(target);
  if (privateRoot) await fs.mkdir(path.dirname(privateRoot), { recursive: true });
  await fs.mkdir(target, { recursive: true, ...(privateRoot || forcePrivate ? { mode: PRIVATE_DIRECTORY_MODE } : {}) });
  await assertSafePath(target);
  await protectPrivatePath(target);
  if (forcePrivate) await tightenPrivateMode(target);
}

export async function writeFileExclusive(target: string, content: string): Promise<void> {
  await assertSafePath(target);
  await protectPrivatePath(target);
  const privateFile = Boolean(privateStateRoot(target));
  const handle = await fs.open(target, "wx", privateFile ? PRIVATE_FILE_MODE : 0o666);
  try {
    if (privateFile && process.platform !== "win32") await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(content);
  } finally { await handle.close(); }
}

/** Copies are new Curator-owned artifacts, so their entire destination tree may be secured. */
export async function copyStorageTree(source: string, target: string, forcePrivate = false, sharedMode?: (target: string, sourceMode: number) => number): Promise<void> {
  await assertSafePath(source);
  await assertSafePath(target);
  const stat = await fs.lstat(source);
  const savedMode = !forcePrivate && !privateStateRoot(target) ? sharedMode?.(target, stat.mode & 0o777) : undefined;
  if (stat.isDirectory()) {
    await ensureStorageDirectory(target, forcePrivate);
    if (savedMode !== undefined && process.platform !== "win32") await fs.chmod(target, savedMode);
    for (const name of await fs.readdir(source)) await copyStorageTree(path.join(source, name), path.join(target, name), forcePrivate, sharedMode);
  } else if (stat.isFile()) {
    const privateFile = forcePrivate || Boolean(privateStateRoot(target));
    // Open the destination restrictively BEFORE copying any bytes (copyFile inherits source mode).
    const handle = await fs.open(target, "wx", privateFile ? PRIVATE_FILE_MODE : savedMode ?? 0o666);
    try {
      if (process.platform !== "win32" && (privateFile || savedMode !== undefined)) await handle.chmod(privateFile ? PRIVATE_FILE_MODE : savedMode!);
      const input = await fs.open(source, "r");
      try { for await (const chunk of input.createReadStream({ autoClose: false })) await handle.writeFile(chunk); }
      finally { await input.close(); }
    } finally { await handle.close(); }
  } else throw new Error("Unsupported migration/private copy source");
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

export function projectDataPath(root: string, ...parts: string[]): string {
  const base = path.resolve(root, PRODERO_DIRECTORY);
  const target = path.resolve(base, ...parts);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw new Error("Unsafe Prodero storage path");
  return target;
}

/** Reject links in every existing component, including dangling links. Never follow them on writes. */
export async function assertSafePath(target: string): Promise<void> {
  const absolute = path.resolve(target);
  // Resolve OS aliases such as /tmp first; the storage boundary itself must never be an alias.
  const marker = `${path.sep}${PRODERO_DIRECTORY}`;
  const index = absolute.indexOf(`${marker}${path.sep}`);
  const boundary = index >= 0 ? index : absolute.endsWith(marker) ? absolute.length - marker.length : -1;
  const parent = boundary >= 0 ? absolute.slice(0, boundary) : path.dirname(absolute);
  let cursor = await fs.realpath(parent);
  const parts = boundary >= 0 ? absolute.slice(boundary + 1).split(path.sep) : [path.basename(absolute)];
  for (const [offset, part] of parts.entries()) {
    cursor = path.join(cursor, part);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error(`Symlink in Prodero storage path: ${cursor}`);
      if (offset < parts.length - 1 && !stat.isDirectory()) throw new Error(`Invalid Prodero storage directory: ${cursor}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

/** Storage-level barrier also protects direct domain/plugin calls and recovery writes.
 * Inspect only the version discriminator, never interpret unknown canonical content.
 * Malformed config is handled by readConfig or interrupted-migration recovery.
 */
export async function assertCompatibleProject(root: string): Promise<void> {
  const target = projectDataPath(root, "config.json");
  await assertSafePath(target);
  let raw: unknown;
  try { raw = JSON.parse(await fs.readFile(target, "utf8")); }
  catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const version = raw && typeof raw === "object" && "schemaVersion" in raw ? raw.schemaVersion : undefined;
  assertSupportedSchema(version);
  assertSupportedKnowledgeSchema(raw && typeof raw === "object" && "knowledgeSchemaVersion" in raw ? raw.knowledgeSchemaVersion : undefined);
}

export function assertSupportedSchema(version: unknown): void {
  if (typeof version === "number" && version > PRODERO_SCHEMA_VERSION) {
    throw new Error(`PRODERO_SCHEMA_NEWER: Project schema v${version} is newer than Prodero runtime schema v${PRODERO_SCHEMA_VERSION}. Update Prodero before reading or changing this project.`);
  }
}

export function assertSupportedKnowledgeSchema(version: unknown): void {
  if (version !== undefined && (!Number.isInteger(version) || Number(version) < 1)) throw new Error("PRODERO_INVALID_CONFIG: Invalid knowledge schema version.");
  if (typeof version === "number" && version > PRODERO_KNOWLEDGE_SCHEMA_VERSION) throw new Error(`PRODERO_KNOWLEDGE_SCHEMA_NEWER: Knowledge format v${version} requires a newer Curator. Update Prodero before reading or changing knowledge.`);
}

export async function checkedDataPath(root: string, ...parts: string[]): Promise<string> {
  await assertCompatibleProject(root);
  const target = projectDataPath(root, ...parts);
  await assertSafePath(target);
  await protectPrivatePath(target);
  return target;
}

export async function ensureDataDirectory(root: string, relative: string): Promise<string> {
  const target = await checkedDataPath(root, relative);
  const directory = path.relative(projectDataPath(root), target).split(path.sep)[0];
  if (LOCAL_STATE_DIRECTORIES.some(local => local === directory)) await ensureLocalStateIgnored(root);
  await ensureStorageDirectory(target);
  return target;
}

export function canonicalId(value: unknown, filename: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error(`Invalid canonical ID: ${filename}`);
}

const positive = z.number().int().positive();
const configSchema = z.object({
  schemaVersion: positive, knowledgeSchemaVersion: positive.optional(), initializedWith: z.string().min(1), lastUpdatedWith: z.string().min(1),
  projectId: z.string().min(1), createdAt: z.string().refine(v => Number.isFinite(Date.parse(v))),
  context: z.object({ max_tokens: positive.optional(), max_items: positive.optional(), required_max_tokens: z.number().int().nonnegative().optional(), budgetTokens: positive.optional(), requiredBudgetTokens: z.number().int().nonnegative().optional() }).passthrough().optional(),
  presentation: presentationConfigSchema.optional(),
  knowledgeEngine: z.object({ mode: z.enum(["deterministic", "assisted"]) }).passthrough().optional(),
}).passthrough();
export function validateConfig(value: unknown): asserts value is ProderoConfig {
  const result = configSchema.safeParse(value);
  if (!result.success) throw new Error(`Invalid Prodero config: .prodero/config.json (${result.error.issues.map(i => i.path.join(".")).join(", ")}).`);
}

/** Ensure only the disposable working-tree-local derived-state root. */
export async function ensureDerivedStateRoot(root: string): Promise<string> {
  return ensureDataDirectory(root, ".cache");
}

export async function ensureProjectDirectories(root: string): Promise<void> {
  await Promise.all([
    ensureDerivedStateRoot(root),
    ...PROJECT_DIRECTORIES.filter((directory) => directory !== ".cache").map((directory) => ensureDataDirectory(root, directory)),
  ]);
  await Promise.all(PROJECT_DIRECTORIES.filter((directory) => directory !== ".cache")
    .map(async (directory) => { const target = await checkedDataPath(root, directory, ".gitkeep"); if (!(await exists(target))) await writeFileExclusive(target, "").catch(error => { if (error.code !== "EEXIST") throw error; }); }));
}

/** Missing ignored directories are normal after clone. Do not touch tracked placeholders. */
export async function ensureRuntimeDirectories(root: string): Promise<void> {
  for (const directory of ["local/memory", "local/skills", "sessions", "checkpoints", ".cache"]) await ensureDataDirectory(root, directory);
  // Protect dormant legacy stores at their boundary without walking their contents.
  for (const directory of LOCAL_STATE_DIRECTORIES) await protectPrivatePath(projectDataPath(root, directory));
}

export async function countContentFiles(directory: string): Promise<number> {
  if (!(await exists(directory))) return 0;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && !entry.name.startsWith(".")).length;
}

export async function readConfig(root: string): Promise<ProderoConfig | null> {
  const configPath = await checkedDataPath(root, "config.json");
  if (!(await exists(configPath))) return null;
  let config: unknown;
  try { config = JSON.parse(await fs.readFile(configPath, "utf8")); } catch (error) { if (error instanceof SyntaxError) throw new Error("PRODERO_INVALID_CONFIG: Invalid Prodero config: .prodero/config.json is not valid JSON. Restore valid configuration or use init to recover an interrupted migration."); throw error; }
  validateConfig(config);
  return config;
}

export async function writeConfig(root: string, config: ProderoConfig): Promise<void> {
  validateConfig(config);
  assertSupportedSchema(config.schemaVersion);
  assertSupportedKnowledgeSchema(config.knowledgeSchemaVersion);
  await writeFileAtomic(await checkedDataPath(root, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

export async function writeFileAtomic(target: string, content: string): Promise<void> {
  await assertSafePath(target);
  await protectPrivatePath(target);
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFileExclusive(temporary, content);
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

const checkpointSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/), createdAt: z.string().refine(v => Number.isFinite(Date.parse(v))),
  sessions: z.array(z.object({id: z.string().nullable().optional(), path: z.string().regex(/^[a-zA-Z0-9_-]+\.md$/), sha256: z.string().regex(/^[a-f0-9]{64}$/)})),
  previousCheckpoint: z.string().nullable().optional(),
  consolidation: z.enum(["not-performed", "deterministic-v1", "assisted-v1"]).optional(),
  summary: z.object({ sessions: z.number().nonnegative(), candidates: z.number().nonnegative(), created: z.number().nonnegative(), consolidated: z.number().nonnegative(), duplicates: z.number().nonnegative(), superseded: z.number().nonnegative(), conflicts: z.number().nonnegative() }).optional(),
  lifecycle: z.object({ operationId:z.string(), planId:z.string().regex(/^[a-f0-9]{64}$/), proposalHash:z.string().regex(/^[a-f0-9]{64}$/), transformationPreviewId:z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().optional(),
  promotionRevisions: z.array(z.object({path:z.string(),hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).optional(),
  observationHashes: z.array(z.string()).optional(),
  createdMemory: z.array(z.string()).optional(), updatedMemory: z.array(z.string()).optional(), supersededMemory: z.array(z.string()).optional(),
  duplicateMemory: z.array(z.string()).optional(), createdSkills: z.array(z.string()).optional(), conflicts: z.array(z.string()).optional(),
}).passthrough();
export function parseCheckpointData(content: string, filename: string): Checkpoint {
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { throw new Error(`Invalid Prodero checkpoint: ${filename} is not valid JSON.`); }
  const result = checkpointSchema.safeParse(raw);
  if (!result.success || (filename.startsWith("chk_") && result.data.id !== path.basename(filename, ".json"))) throw new Error(`Invalid Prodero checkpoint: ${filename} has malformed metadata.`);
  return result.data as unknown as Checkpoint;
}

export async function listCheckpoints(root: string): Promise<Checkpoint[]> {
  const directory = await checkedDataPath(root, "checkpoints");
  if (!(await exists(directory))) return [];
  const names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  const checkpoints: Checkpoint[] = [];
  for (const name of names) {
    const raw = parseCheckpointData(await fs.readFile(await checkedDataPath(root, "checkpoints", name), "utf8"), name);
    checkpoints.push({
      id: raw.id,
      createdAt: raw.createdAt,
      previousCheckpoint: raw.previousCheckpoint ?? null,
      sessions: raw.sessions.map((session) => ({ id: session.id ?? null, path: session.path, sha256: session.sha256 })),
      consolidation: raw.consolidation ?? "not-performed",
      createdMemory: raw.createdMemory ?? [],
      createdSkills: raw.createdSkills ?? [],
      updatedMemory: raw.updatedMemory ?? [],
      supersededMemory: raw.supersededMemory ?? [],
      duplicateMemory: raw.duplicateMemory ?? [],
      conflicts: raw.conflicts ?? [],
      summary: raw.summary ?? { sessions: raw.sessions.length, candidates: 0, created: 0, consolidated: 0, duplicates: 0, superseded: 0, conflicts: 0 },
      note: raw.note,
      importReceipt: raw.importReceipt,
      curation: raw.curation,
      curationDefer: raw.curationDefer,
      lifecycle: raw.lifecycle,
      promotionRevisions: raw.promotionRevisions,
      intelligence: raw.intelligence, reasoning: raw.reasoning, instructionCandidates: raw.instructionCandidates, observationHashes: raw.observationHashes, knowledgeBefore: raw.knowledgeBefore,
    });
  }
  return checkpoints;
}

export function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/** Block ordinary readers while a recoverable lifecycle transaction has partial files. */
/** Optimistic read fence: a lifecycle commit during a multi-file read must be retried.
 * The journal blocks partial writes; the immutable checkpoint set detects a commit
 * that started AND finished between the two journal checks. No persistent state.
 */
export async function knowledgeReadFence(root: string): Promise<() => Promise<void>> {
  const generation = async () => {
    const directory = await checkedDataPath(root, 'checkpoints');
    const checkpoints = (await fs.readdir(directory).catch(error => {
      if (error.code === 'ENOENT') return [] as string[];
      throw error;
    })).filter(name => /^chk_.*\.json$/.test(name)).sort();
    // Migration does not necessarily create checkpoints. History revisions fence
    // reads spanning an entire commit or rollback, including journal removal.
    const history = await checkedDataPath(root, ".migrations");
    const names = await fs.readdir(history).catch(error => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    });
    const revisions = await Promise.all(names.filter(name => name.endsWith(".json")).sort().map(async name => {
      const entry = await checkedDataPath(root, ".migrations", name);
      const stat = await fs.stat(entry);
      return [name, stat.mtimeMs, stat.ctimeMs, stat.size];
    }));
    return JSON.stringify({checkpoints, migrations: revisions});
  };
  const before = await generation();
  await assertLifecycleReadable(root);
  return async () => {
    await assertLifecycleReadable(root);
    if (await generation() !== before) throw new Error('Knowledge transaction committed during read; retry against a stable graph');
  };
}
export async function assertLifecycleReadable(root: string): Promise<void> {
  const migration = await checkedDataPath(root, ".transactions/migration.json");
  if (await exists(migration)) {
    const { ownsSyncLock } = await import("./sync-transaction.js");
    if (!ownsSyncLock(root)) throw new Error("Project update is in progress or requires recovery; open Prodero before reading knowledge.");
  }
  const journal = await checkedDataPath(root, ".transactions/pending.json");
  const text = await fs.readFile(journal, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
  let version: unknown;
  try { version = text ? JSON.parse(text).version : undefined; }
  catch { throw new Error("PRODERO_INVALID_JOURNAL: invalid pending journal JSON; preserve it for recovery."); }
  if (version === 2) throw new Error("Knowledge lifecycle transaction is pending recovery; run prepare or Sync before reading knowledge.");
}
