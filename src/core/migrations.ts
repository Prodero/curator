import { copyStorageTree, ensureStorageDirectory, privateStateRoot, protectPrivatePath } from "./storage.js";
import { writeFileExclusive } from "./storage.js";
import { replaceManagedBlock } from "./templates.js";
import { migrateKnowledgeV1ToV2, validateKnowledgeV2, migrateKnowledgeV2ToV3, validateKnowledgeV3 } from "./knowledge-migration.js";
import { publicDiagnostic } from "./diagnostics.js";
import { assertSupportedSchema, assertSupportedKnowledgeSchema } from "./storage.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PRODERO_DIRECTORY, PRODERO_SCHEMA_VERSION, PRODERO_KNOWLEDGE_SCHEMA_VERSION, PRODERO_VERSION } from "./constants.js";
import { parseFrontmatter } from "./format.js";
import { assertSafePath, ensureProjectDirectories, exists, projectDataPath, checkedDataPath, canonicalId, ensureDataDirectory, readConfig, validateConfig, writeFileAtomic, listCheckpoints, writeConfig } from "./storage.js";
import { withSyncLock, recoverSyncTransaction } from "./sync-transaction.js";
import { parseKnowledge } from "./memory.js";
import { listSessions } from "./sessions.js";
import { listProjectSkills } from "./skills.js";
import type { MigrationResult, ProderoConfig } from "./types.js";
import { DEFAULT_CONTEXT_BUDGET_TOKENS, DEFAULT_REQUIRED_CONTEXT_BUDGET_TOKENS } from "./telemetry.js";

export type MigrationKind = "structural" | "compatible-semantic" | "review-required";
export interface MigrationStep {
  id?: string;
  kind?: MigrationKind;
  affectedStores?: string[];
  validate?(root: string, config: ProderoConfig): Promise<void>;
  from: number;
  to: number;
  description: string;
  invalidatesDerivedState: boolean;
  modifiesVersionedKnowledge: boolean;
  run(root: string, config: ProderoConfig): Promise<void>;
}

// Schema 2 adds structured memory and richer manifests without invalidating existing Markdown/checkpoints.
export const MIGRATIONS: Record<number, MigrationStep> = {
  1: { from: 1, to: 2, description: "Normalize legacy canonical memory filenames to stable knowledge IDs.", invalidatesDerivedState: true, modifiesVersionedKnowledge: true, run: async (root) => {
    const directory = await checkedDataPath(root, "memory");
    if (!(await exists(directory))) return;
    const renames: Array<[string, string]> = [];
    for (const name of (await fs.readdir(directory)).filter((entry) => entry.endsWith(".md") && !entry.startsWith("."))) {
      const source = await checkedDataPath(root, "memory", name);
      const { metadata } = parseFrontmatter(await fs.readFile(source, "utf8"), name);
      if (metadata.id === undefined) continue;
      canonicalId(metadata.id, name);
      if (`${metadata.id}.md` === name) continue;
      const destination = await checkedDataPath(root, "memory", `${metadata.id}.md`);
      if (await exists(destination)) throw new Error(`Migration ID collision: ${name}`);
      renames.push([source, destination]);
    }
    for (const [source, destination] of renames) await fs.rename(source, destination);
  } },
  // Schema 3 makes the resolver budget explicit and token-based. 6,000 estimated
  // tokens preserves the scale of the previous 24,000-character bound.
  2: { from: 2, to: 3, description: "Replace the character context limit with an explicit estimated-token budget.", invalidatesDerivedState: true, modifiesVersionedKnowledge: false, run: async (_root, config) => {
    config.context = { budgetTokens: config.context?.budgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS };
  } },
  // Schema 4 bounds required globals separately from the complete task-context budget.
  3: { from: 3, to: 4, description: "Add a separate required-context budget.", invalidatesDerivedState: true, modifiesVersionedKnowledge: false, run: async (_root, config) => {
    config.context = {
      budgetTokens: config.context?.budgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS,
      requiredBudgetTokens: config.context?.requiredBudgetTokens ?? DEFAULT_REQUIRED_CONTEXT_BUDGET_TOKENS,
    };
  } },
  // Schema 5 introduces ignored Local Knowledge beside repository Versioned Knowledge.
  // Existing canonical memory remains versioned; no knowledge is moved implicitly.
  4: { from: 4, to: 5, description: "Add ignored Local Knowledge beside Versioned Knowledge without moving existing records.", invalidatesDerivedState: true, modifiesVersionedKnowledge: false, run: async () => {} },
  5: { from: 5, to: 6, id: "project-5-6", kind: "structural", description: "Record the independent knowledge format; preserve all existing knowledge.", invalidatesDerivedState: true, modifiesVersionedKnowledge: false, run: async (_root, config) => { config.knowledgeSchemaVersion ??= 1; } },
  6: { from: 6, to: 7, id: "project-instructions-6-7", kind: "structural", description: "Update managed project instructions: read and apply skills without opening the Skills UI.", affectedStores: ["AGENTS.md", "config.json"], invalidatesDerivedState: true, modifiesVersionedKnowledge: false, run: async (root) => {
    const target = path.join(root, "AGENTS.md");
    const existing = await fs.readFile(target, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
    await writeFileAtomic(target, replaceManagedBlock(existing));
  } },
  7: { from: 7, to: 8, id: "project-instructions-link-7-8", kind: "structural", description: "Replace embedded Prodero instructions with a reference to instructions supplied by the connected MCP server.", affectedStores: ["AGENTS.md", "config.json"], invalidatesDerivedState: true, modifiesVersionedKnowledge: false, run: async (root) => {
    const target = path.join(root, "AGENTS.md");
    const existing = await fs.readFile(target, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
    await writeFileAtomic(target, replaceManagedBlock(existing));
  } },
};

export const KNOWLEDGE_MIGRATIONS: Record<number, MigrationStep> = {
  2:{id:'knowledge-applicability-2-3',from:2,to:3,kind:'compatible-semantic',description:'Make applicability explicit while preserving all existing scope behavior.',affectedStores:['memory','local/memory','archive','local/archive','config.json'],invalidatesDerivedState:true,modifiesVersionedKnowledge:true,run:async root=>migrateKnowledgeV2ToV3(root),validate:async root=>validateKnowledgeV3(root)},
  1: { id:"knowledge-policy-1-2", from:1, to:2, kind:"compatible-semantic",
    description:"Make required/relevant context policy explicit while preserving existing knowledge behavior and legacy authority.",
    affectedStores:["memory","local/memory","archive","local/archive","config.json"],
    invalidatesDerivedState:true, modifiesVersionedKnowledge:true,
    run:async root=>migrateKnowledgeV1ToV2(root), validate:async root=>validateKnowledgeV2(root),
  },
};

export function migrationPlan(from: number, to = PRODERO_SCHEMA_VERSION, registry = MIGRATIONS): MigrationStep[] {
  if (!Number.isInteger(from) || from < 1 || from > to) throw new Error(`Invalid migration range v${from} → v${to}.`);
  const steps: MigrationStep[] = [];
  for (let version = from; version < to; version += 1) {
    const step = registry[version];
    if (!step || step.from !== version || step.to !== version + 1) throw new Error(`No migration is registered from project schema v${version}.`);
    steps.push(step);
  }
  return steps;
}

async function versionedDigest(root: string): Promise<string> {
  return (await Promise.all(["memory", "archive"].map(async store => directoryDigest(await checkedDataPath(root, store))))).join(":");
}

async function invalidateDerivedState(root: string): Promise<void> {
  await Promise.all(["memory-index.json", "session-index.json", "knowledge-graph.json"].map((name) => fs.rm(projectDataPath(root, ".cache", name), { force: true })));
}

async function directoryDigest(directory: string): Promise<string> {
  const digest = crypto.createHash("sha256");
  const visit = async (current: string, relative = "") => {
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { digest.update("missing"); return; } throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childRelative = path.join(relative, entry.name), child = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Migration cannot inspect symlinked canonical knowledge: ${childRelative}`);
      if (entry.isDirectory()) { digest.update(`D\0${childRelative}\0`); await visit(child, childRelative); }
      else if (entry.isFile()) { const content = await fs.readFile(child); digest.update(`F\0${childRelative}\0${content.length}\0`); digest.update(content); digest.update("\0"); }
    }
  };
  await visit(directory);
  return digest.digest("hex");
}

const BACKUP_ENTRIES = ["config.json", "index.md", "memory", "local", "sessions", "skills", "checkpoints", "archive"];
const MIGRATION_MARKER = ".transactions/migration.json";

async function backupDirectory(root: string): Promise<string> {
  const directory = await ensureDataDirectory(root, ".backups");
  await writeFileExclusive(await checkedDataPath(root, ".backups/.gitignore"), "*\n").catch(error => { if (error.code !== "EEXIST") throw error; });
  return directory;
}

async function createBackup(root: string, from: number): Promise<string> {
  await backupDirectory(root);
  const relative = `.backups/schema-${from}-${crypto.randomUUID()}`;
  const destination = await ensureDataDirectory(root, relative);
  const sharedModes: Record<string, number> = {};
  const rememberSharedModes = async (source: string): Promise<void> => {
    if (privateStateRoot(source)) return;
    await assertSafePath(source);
    const stat = await fs.lstat(source);
    sharedModes[path.relative(projectDataPath(root), source)] = stat.mode & 0o777;
    if (stat.isDirectory()) for (const name of await fs.readdir(source)) await rememberSharedModes(path.join(source, name));
  };
  for (const entry of BACKUP_ENTRIES) {
    const source = await checkedDataPath(root, entry);
    if (await exists(source)) await rememberSharedModes(source);
    if (await exists(source)) await copyStorageTree(source, path.join(destination, entry));
  }
  const agentsPath = path.join(root, "AGENTS.md");
  await assertSafePath(agentsPath);
  const before = await fs.readFile(agentsPath, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
  await writeFileAtomic(path.join(destination, "project-integration.json"), JSON.stringify({before, after: replaceManagedBlock(before ?? ""), sharedModes}));
  return relative;
}

async function restoreBackup(root: string, relative: string, expectedDigest?: string): Promise<void> {
  if (!/^\.backups\/schema-\d+-[a-f0-9-]+$/.test(relative)) throw new Error("Invalid migration backup path; inspect .prodero/.transactions/migration.json.");
  const backup = await checkedDataPath(root, relative);
  const digest = await directoryDigest(backup); // Refuse linked/incomplete recovery sources before removing any destination.
  if (expectedDigest && digest !== expectedDigest) throw new Error("Migration backup integrity check failed; preserve recovery data.");
  if (!(await exists(path.join(backup, "config.json")))) throw new Error("Migration backup is incomplete; restore manually before retrying.");
  const backupConfig=JSON.parse(await fs.readFile(path.join(backup,"config.json"),"utf8"));
  validateConfig(backupConfig);
  assertSupportedSchema(backupConfig.schemaVersion);
  assertSupportedKnowledgeSchema(backupConfig.knowledgeSchemaVersion);
  // Older backups do not include repository-root integration files.
  const integrationPath = path.join(backup, "project-integration.json");
  let sharedModes: Record<string, number> | undefined;
  if (await exists(integrationPath)) {
    const {before, after, sharedModes: savedModes} = JSON.parse(await fs.readFile(integrationPath, "utf8"));
    sharedModes = savedModes;
    const target = path.join(root, "AGENTS.md");
    await assertSafePath(target);
    const current = await fs.readFile(target, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (current === after) {
      if (before === null) await fs.rm(target, {force:true});
      else await writeFileAtomic(target, before);
    }
    // Preserve concurrent user edits when the file is neither our preimage nor output.
  }
  for (const entry of BACKUP_ENTRIES) await checkedDataPath(root, entry);
  for (const entry of BACKUP_ENTRIES) {
    const target = await checkedDataPath(root, entry), source = path.join(backup, entry);
    // Pre-foundation journals did not snapshot the versioned archive store.
    if (entry === "archive" && !expectedDigest && !(await exists(source))) continue;
    await fs.rm(target, { recursive: true, force: true });
    if (await exists(source)) await copyStorageTree(source, target, false, (destination, sourceMode) => {
      const saved = sharedModes?.[path.relative(projectDataPath(root), destination)];
      // Old backups retained the original modes directly; new backups carry a private manifest.
      if (saved === undefined) return sourceMode;
      if (!Number.isInteger(saved) || saved < 0 || saved > 0o777) throw new Error("Invalid backup permission metadata");
      return saved;
    });
  }
}

async function validateCanonicalProject(root: string, schema: number): Promise<void> {
  const knowledgeSchema=(await readConfig(root))?.knowledgeSchemaVersion ?? 1;
  const ids = new Set<string>();
  for (const entry of BACKUP_ENTRIES) {
    const target = await checkedDataPath(root, entry);
    if (await exists(target) && (await fs.lstat(target)).isDirectory()) await directoryDigest(target);
  }
  const knowledgeDirectories=["memory","local/memory"];
  for(const archive of ["archive","local/archive"]) {
    const dir=await checkedDataPath(root,archive);
    if(await exists(dir))for(const month of await fs.readdir(dir)) {
      if(/^\d{4}_\d{2}$/.test(month))knowledgeDirectories.push(`${archive}/${month}`);
    }
  }
  for (const directory of knowledgeDirectories) {
    const target = await checkedDataPath(root, directory);
    if (!(await exists(target))) continue;
    for (const name of (await fs.readdir(target)).filter(n => n.endsWith(".md") && !n.startsWith("."))) {
      const text = await fs.readFile(await checkedDataPath(root, directory, name), "utf8");
      const { metadata } = parseFrontmatter(text, `${directory}/${name}`);
      if (metadata.id !== undefined) canonicalId(metadata.id, `${directory}/${name}`);
      const item = parseKnowledge(text, schema === 1 && typeof metadata.id === "string" ? `${metadata.id}.md` : name, knowledgeSchema);
      if (ids.has(item.id)) throw new Error(`Duplicate canonical knowledge ID: ${directory}/${name}`);
      ids.add(item.id);
    }
  }
  await listSessions(root);
  await listProjectSkills(root);
  await listCheckpoints(root);
}

async function validateCurrentProject(root: string, config: ProderoConfig): Promise<void> {
  validateConfig(config);
  if ((config.knowledgeSchemaVersion ?? 1) !== PRODERO_KNOWLEDGE_SCHEMA_VERSION) throw new Error(`Migration validation expected knowledge format v${PRODERO_KNOWLEDGE_SCHEMA_VERSION}.`);
  if (config.schemaVersion !== PRODERO_SCHEMA_VERSION) throw new Error(`Migration validation expected schema v${PRODERO_SCHEMA_VERSION}.`);
  for (const entry of ["config.json", "index.md", "memory", "local/memory", "sessions", "skills", "checkpoints", ".cache"]) {
    if (!(await exists(await checkedDataPath(root, entry)))) throw new Error(`Migration validation failed: .prodero/${entry} is missing.`);
  }
  await validateCanonicalProject(root, config.schemaVersion);
}

async function recoverMigrationLocked(root: string): Promise<void> {
  const marker = await checkedDataPath(root, MIGRATION_MARKER);
  if (!(await exists(marker))) return;
  let pending;
  try { pending = JSON.parse(await fs.readFile(marker, "utf8")); } catch { throw new Error("Invalid migration journal: .prodero/.transactions/migration.json; inspect before retrying."); }
  if (pending?.version !== 1 || typeof pending.backup !== "string") throw new Error("Invalid migration journal: .prodero/.transactions/migration.json");
  await restoreBackup(root, pending.backup, pending.backupDigest);
  await invalidateDerivedState(root);
  if (pending.history) await recordHistory(root, { ...pending.history, status: "rolled-back", completedAt: new Date().toISOString() });
  if (pending.history && /^[a-f0-9-]+$/.test(pending.history.id)) {
    const stage=await checkedDataPath(root, `.transactions/migration-stage-${pending.history.id}`);
    await fs.rm(stage,{recursive:true,force:true});
  }
  await fs.rm(marker);
}

/** Entry points recover before parsing config: rollback itself may have been interrupted. */
export async function recoverProjectMigration(root: string, expectedPlanId?: string): Promise<void> {
  if (await exists(await checkedDataPath(root, MIGRATION_MARKER))) await withSyncLock(root, async () => {
    if (expectedPlanId && (await planProjectMigration(root)).planId !== expectedPlanId) throw new Error("Recovery plan changed; review it again.");
    await recoverMigrationLocked(root);
  }, { migrationRecovery: true });
}

export async function migrateProject(root: string, config: ProderoConfig, expectedPlanId?: string): Promise<MigrationResult> {
  validateConfig(config);
  assertSupportedSchema(config.schemaVersion);
  const marker = await checkedDataPath(root, MIGRATION_MARKER);
  const legacyBackups = await checkedDataPath(root, ".cache/migration-backups");
  if (config.schemaVersion === PRODERO_SCHEMA_VERSION && (config.knowledgeSchemaVersion ?? 1) === PRODERO_KNOWLEDGE_SCHEMA_VERSION && !(await exists(marker)) && !(await exists(legacyBackups))) return { migrated: false, from: config.schemaVersion, to: PRODERO_SCHEMA_VERSION, backup: null };
  return withSyncLock(root, async () => {
    if (expectedPlanId && (await planProjectMigration(root)).planId !== expectedPlanId) throw new Error("Migration plan changed; review it again.");
    await recoverMigrationLocked(root);
    await recoverSyncTransaction(root);
    const current = await readConfig(root);
    if (!current) throw new Error("Migration requires .prodero/config.json.");
    const from = current.schemaVersion;
    const plan = [...migrationPlan(from).map(step => ({...step, domain: "project" as const})), ...migrationPlan(current.knowledgeSchemaVersion ?? 1, PRODERO_KNOWLEDGE_SCHEMA_VERSION, KNOWLEDGE_MIGRATIONS).map(step => ({...step, domain: "knowledge" as const}))];
    if (!expectedPlanId && plan.some(step => step.kind === "compatible-semantic")) throw new Error("Explicit approval of the knowledge migration plan is required.");
    if (plan.some(step => step.kind === "review-required")) throw new Error("Migration requires semantic review; this runtime has no review resolver for these steps.");
    // Preserve old-runtime backups too before their former cache directory is discarded.
    if (await exists(legacyBackups)) {
      await directoryDigest(legacyBackups);
      await backupDirectory(root);
      await fs.rename(legacyBackups, await checkedDataPath(root, `.backups/legacy-cache-${crypto.randomUUID()}`));
    }
    if (!plan.length) { Object.assign(config, current); return { migrated: false, from, to: PRODERO_SCHEMA_VERSION, backup: null }; }
    await validateCanonicalProject(root, from);
    const backup = await createBackup(root, from);
    const history = { id: crypto.randomUUID(), curatorVersion: PRODERO_VERSION, from: { project: from, knowledge: current.knowledgeSchemaVersion ?? 1 }, to: { project: PRODERO_SCHEMA_VERSION, knowledge: PRODERO_KNOWLEDGE_SCHEMA_VERSION }, migrations: plan.map(step => step.id ?? `${step.domain}-${step.from}-${step.to}`), startedAt: new Date().toISOString(), backup, status: "started" };
    const backupDigest = await directoryDigest(projectDataPath(root,backup));
    const stage = projectDataPath(root, `.transactions/migration-stage-${history.id}`);
    await recordHistory(root, history);
    await writeFileAtomic(marker, JSON.stringify({ version: 1, backup, backupDigest, history }));
    const next = structuredClone(current);
    try {
      await ensureStorageDirectory(path.join(stage, PRODERO_DIRECTORY));
      for (const entry of BACKUP_ENTRIES) {
        const source = projectDataPath(root, `${backup}/${entry}`);
        if (await exists(source)) await copyStorageTree(source, projectDataPath(stage, entry));
      }
      const integration = JSON.parse(await fs.readFile(projectDataPath(root, `${backup}/project-integration.json`), "utf8"));
      if (integration.before !== null) await writeFileAtomic(path.join(stage, "AGENTS.md"), integration.before);
      await ensureProjectDirectories(stage);
      for (const migration of plan) {
        const versionedBefore = migration.modifiesVersionedKnowledge ? null : await versionedDigest(stage);
        await migration.run(stage, next);
        if (versionedBefore !== null && await versionedDigest(stage) !== versionedBefore) throw new Error(`Migration v${migration.from} → v${migration.to} modified Versioned Knowledge without declaring it.`);
        if (migration.domain === "project") next.schemaVersion = migration.to;
        else next.knowledgeSchemaVersion = migration.to;
        validateConfig(next);
        await writeConfig(stage, next);
        await validateCanonicalProject(stage, next.schemaVersion);
        await migration.validate?.(stage, next);
      }
      next.lastUpdatedWith = PRODERO_VERSION;
      await validateCurrentProject(stage, next);
      // Rebuild against the target schema in staging, never interpret migrated
      // records using the still-old live config. Derived file stamps are checked
      // again by the normal cache loaders after installation.
      const { buildIndex } = await import("./index.js");
      const { discoverSessions } = await import("./session-index.js");
      await buildIndex(stage);
      await discoverSessions(stage);
      // The existing journal and common writer lock make this a recoverable logical
      // transaction. Each file replacement is atomic; readers are fenced until done.
      for (const entry of BACKUP_ENTRIES.filter(entry => entry !== "config.json")) {
        const target = await checkedDataPath(root, entry), source = projectDataPath(stage, entry);
        await commitTree(source,target);
      }
      await invalidateDerivedState(root);
      for (const name of ["memory-index.json", "session-index.json", "knowledge-graph.json"]) {
        await commitTree(projectDataPath(stage,".cache",name), await checkedDataPath(root,".cache",name));
      }
      if (plan.some(step => step.affectedStores?.includes("AGENTS.md"))) {
        const target = path.join(root, "AGENTS.md");
        await assertSafePath(target);
        const currentAgents = await fs.readFile(target, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
        if (currentAgents !== integration.before) throw new Error("AGENTS.md changed during migration; retry with the current file.");
        await commitTree(path.join(stage, "AGENTS.md"), target);
      }
      await writeConfig(root, next);
      await recordHistory(root, {...history, status:"completed", completedAt:new Date().toISOString()});
      await fs.rm(stage,{recursive:true,force:true});
      await fs.rm(marker);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try { await restoreBackup(root, backup, backupDigest); await invalidateDerivedState(root); await recordHistory(root, {...history,status:"rolled-back",completedAt:new Date().toISOString(),error:message}); await fs.rm(marker); }
      catch { throw new Error(`${message} Migration recovery required: preserve .prodero/${backup} and .prodero/.transactions/migration.json; retry migration or restore the backup manually.`); }
      await fs.rm(stage,{recursive:true,force:true});
      throw new Error(`${message} Migration rolled back; recovery backup: .prodero/${backup}.`);
    }
    Object.assign(config, next);
    return { migrated: true, from, to: PRODERO_SCHEMA_VERSION, backup: `${PRODERO_DIRECTORY}/${backup}` };
  }, { migrationRecovery: true });
}

/** Replace each file by same-directory rename; the journal fences the multi-file commit. */
async function commitTree(source:string,target:string):Promise<void> {
  await assertSafePath(target);
  if(!(await exists(source))) {await fs.rm(target,{recursive:true,force:true});return;}
  const stat=await fs.lstat(source);
  if(stat.isSymbolicLink())throw new Error("Symlink in staged migration data");
  if(stat.isDirectory()) {
    await ensureStorageDirectory(target);
    const names=await fs.readdir(source);
    for(const name of await fs.readdir(target))if(!names.includes(name))await fs.rm(path.join(target,name),{recursive:true,force:true});
    for(const name of names)await commitTree(path.join(source,name),path.join(target,name));
  } else {
    const temporary=`${target}.tmp-${crypto.randomUUID()}`;
    try {
      await copyStorageTree(source,temporary);
      // Staging/backup files are private; do not propagate their modes to shared targets.
      if (!privateStateRoot(target) && process.platform !== "win32") {
        const existing = await fs.lstat(target).catch(error => { if (error.code === "ENOENT") return null; throw error; });
        if (existing) await fs.chmod(temporary, existing.mode & 0o777);
      }
      await fs.rename(temporary,target);
      await protectPrivatePath(target);
    }
    finally {await fs.rm(temporary,{force:true});}
  }
}

async function recordHistory(root: string, entry: {id:string; [key:string]:unknown}): Promise<void> {
  if (!/^[a-f0-9-]+$/.test(entry.id)) throw new Error("Invalid migration history ID");
  await ensureDataDirectory(root, ".migrations");
  await writeFileAtomic(await checkedDataPath(root, ".migrations/.gitignore"), "*\n");
  await writeFileAtomic(await checkedDataPath(root, `.migrations/${entry.id}.json`), JSON.stringify(entry,null,2)+"\n");
}

export interface ProjectMigrationPlan {
  root: string;
  state: "current" | "available" | "review-required" | "recovery-required" | "updating" | "runtime-too-old" | "blocked";
  current: {project:number;knowledge:number} | null;
  target: {project:number;knowledge:number};
  curatorVersion: string;
  migrations: {id:string;domain:"project"|"knowledge";from:number;to:number;kind:MigrationKind;description:string;affectedStores:string[]}[];
  backupRequired: boolean;
  safeToApply: boolean;
  reviewRequired: boolean;
  blocked: boolean;
  planId: string;
  diagnostic?: string;
  recovery?: string;
}
/** Only metadata is inspected. No directories, caches, sessions or journals are written. */
export async function planProjectMigration(root: string): Promise<ProjectMigrationPlan> {
  const plan: ProjectMigrationPlan = {root,state:"current",current:null,target:{project:PRODERO_SCHEMA_VERSION,knowledge:PRODERO_KNOWLEDGE_SCHEMA_VERSION},curatorVersion:PRODERO_VERSION,migrations:[],backupRequired:false,safeToApply:false,reviewRequired:false,blocked:false,planId:""};
  const configPath=projectDataPath(root,"config.json");
  await assertSafePath(configPath);
  const raw=await fs.readFile(configPath,"utf8").catch(error=>{if(error.code==="ENOENT")return null;throw error;});
  plan.planId=crypto.createHash("sha256").update(raw ?? "uninitialized").update(JSON.stringify(plan.target)).update(PRODERO_VERSION).digest("hex");
  const marker=projectDataPath(root,MIGRATION_MARKER);
  await assertSafePath(marker);
  const journal=await fs.readFile(marker,"utf8").catch(error=>{if(error.code==="ENOENT")return null;throw error;});
  plan.planId=crypto.createHash("sha256").update(plan.planId).update(journal ?? "no-migration").digest("hex");
  try {
    let config;
    try {config=raw===null?null:JSON.parse(raw);} catch(error) {
      if(await exists(marker)){plan.state="recovery-required";plan.blocked=true;plan.recovery="Restore the pre-update backup.";return plan;}
      throw error;
    }
    if(config) {
      if(!Number.isInteger(config.schemaVersion) || config.schemaVersion<1 || !Number.isInteger(config.knowledgeSchemaVersion ?? 1) || (config.knowledgeSchemaVersion ?? 1)<1) throw new Error("PRODERO_INVALID_CONFIG: Invalid schema version metadata.");
      plan.current={project:config.schemaVersion,knowledge:config.knowledgeSchemaVersion ?? 1};
      if(plan.current.project>plan.target.project || plan.current.knowledge>plan.target.knowledge) {
        plan.state="runtime-too-old";plan.blocked=true;plan.diagnostic=`${plan.current.project>plan.target.project ? "PRODERO_SCHEMA_NEWER" : "PRODERO_KNOWLEDGE_SCHEMA_NEWER"}: Update Curator; the project uses a newer project or knowledge format.`;return plan;
      }
    }
    if(await exists(marker)) {
      const ownerPath=projectDataPath(root,".transactions/lock/owner");
      await assertSafePath(ownerPath);
      try { const pid=Number(await fs.readFile(ownerPath,"utf8")); if(Number.isSafeInteger(pid) && pid>0) {process.kill(pid,0);plan.state="updating";plan.blocked=true;return plan;} } catch {}
      plan.state="recovery-required";plan.blocked=true;plan.recovery="Restore the complete pre-update backup, then plan the update again.";return plan;}
    if(!config)return plan;
    validateConfig(config);
    for(const domain of ["project","knowledge"] as const) {
      for(const step of migrationPlan(plan.current![domain],plan.target[domain],domain==="project"?MIGRATIONS:KNOWLEDGE_MIGRATIONS)) plan.migrations.push({id:step.id ?? `${domain}-${step.from}-${step.to}`,domain,from:step.from,to:step.to,kind:step.kind ?? "structural",description:step.description,affectedStores:step.affectedStores ?? ["config.json",...(step.invalidatesDerivedState?["index.md","local/index.md",".cache"]:[]),...(step.modifiesVersionedKnowledge?["memory","local/memory","archive","local/archive"]:[])]});
    }
    plan.reviewRequired=plan.migrations.some(s=>s.kind==="review-required");
    plan.backupRequired=plan.migrations.length>0;
    plan.state=plan.reviewRequired?"review-required":plan.backupRequired?"available":"current";
    plan.safeToApply=plan.state==="available";plan.blocked=plan.reviewRequired;
    plan.planId=crypto.createHash("sha256").update(plan.planId).update(JSON.stringify(plan.migrations)).digest("hex");
  } catch(error) {plan.state="blocked";plan.blocked=true;plan.diagnostic=publicDiagnostic(error);}
  return plan;
}

export class MigrationRequiredError extends Error {
  constructor(public plan:ProjectMigrationPlan) {super(`PRODERO_MIGRATION_REQUIRED: ${plan.state}. Open Prodero to review the knowledge update.`);}
}
export async function requireCurrentProject(root:string):Promise<void> {
  const plan=await planProjectMigration(root);
  if(plan.state!=="current")throw new MigrationRequiredError(plan);
}
/** User approval is bound to the exact metadata/registry plan. Review-required steps
 * intentionally cannot be overridden by a boolean approval. */
export async function applyProjectMigration(root:string, options:{approved:boolean;planId:string;recover?:boolean}) {
  if(!options.approved)throw new Error("Explicit approval of the knowledge update is required.");
  const plan=await planProjectMigration(root);
  if(plan.state==="current")return {migrated:false,plan};
  if(plan.planId!==options.planId)throw new Error("Migration plan changed; review the current plan again.");
  if(plan.state==="recovery-required" && options.recover) {
    await recoverProjectMigration(root,options.planId);
    return {migrated:false,recovered:true,plan:await planProjectMigration(root)};
  }
  if(!plan.safeToApply)throw new Error(plan.diagnostic ?? `Migration is ${plan.state}; cannot apply automatically.`);
  const config=await readConfig(root);
  if(!config)throw new Error("Project is not initialized.");
  const result=await migrateProject(root,config,options.planId);
  return {...result,plan:await planProjectMigration(root)};
}
