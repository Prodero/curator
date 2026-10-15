import { PRIVATE_DIRECTORY_MODE } from "../filesystem/permissions.js";
import { writeFileExclusive } from "./storage.js";
import { protectKnowledgeWrites } from './knowledge-write-policy.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { assertNoSecrets } from "./secrets.js";
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { parseKnowledge } from './memory.js';
import { parseSkill } from './skills.js';
import { readConfig, checkedDataPath, exists, parseCheckpointData, ensureRuntimeDirectories, ensureDataDirectory, sha256, writeFileAtomic } from './storage.js';

const writeSchema = z.object({ path: z.string().regex(/^(memory|local\/memory|local\/skills|skills|(local\/)?archive\/\d{4}_(0[1-9]|1[0-2]))\/[a-zA-Z0-9_-]+\.md$|^checkpoints\/chk_[a-zA-Z0-9_-]+\.json$/), before: z.string().nullable(), after: z.string() }).strict();
const moveSchema = z.object({from:z.string().regex(/^(local\/)?memory\/[a-zA-Z0-9_-]+\.md$/),to:z.string().regex(/^(local\/)?archive\/\d{4}_(0[1-9]|1[0-2])\/[a-zA-Z0-9_-]+\.md$/),before:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type PlannedMove = z.infer<typeof moveSchema>;
const journalSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), writes: z.array(writeSchema).min(1) }).strict(),
  z.object({ version: z.literal(2), writes: z.array(writeSchema).min(1), moves:z.array(moveSchema) }).strict(),
]);
export type PlannedWrite = z.infer<typeof writeSchema>;
export async function safeProjectPath(root: string, relative: string): Promise<string> {
  if (!/^(memory|local\/memory|local\/skills|skills|sessions|checkpoints|(local\/)?archive\/\d{4}_(0[1-9]|1[0-2]))\/[a-zA-Z0-9_-]+\.(md|json)$/.test(relative)) throw new Error('Unsafe canonical path');
  return checkedDataPath(root, relative);
}
async function runtimeDirectory(root: string) {
  await ensureRuntimeDirectories(root);
  for (const directory of ['memory', 'skills']) await checkedDataPath(root, directory);
  const dir = await ensureDataDirectory(root, '.transactions');
  await writeFileExclusive(await checkedDataPath(root, '.transactions/.gitignore'), '*\n').catch((error) => { if (error.code !== 'EEXIST') throw error; });
  return dir;
}
export async function fileHash(target: string): Promise<string | null> {
  try { return sha256(await fs.readFile(target, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
// An unforgeable async-context capability for Core composition, never a caller boolean.
const writerContext = new AsyncLocalStorage<{root: string; active: boolean}>();
export function ownsSyncLock(root: string): boolean {
  const owner = writerContext.getStore();
  return Boolean(owner?.active && owner.root === path.resolve(root));
}
/** Per-worktree writer exclusion shared by migration, Sync and session mutations. */
export async function withSyncLock<T>(root: string, operation: () => Promise<T>, options: { waitMs?: number; migrationRecovery?: boolean; recoverLifecycle?: boolean } = {}): Promise<T> {
  await runtimeDirectory(root);
  const lock = await checkedDataPath(root, '.transactions/lock');
  const deadline = Date.now() + (options.waitMs ?? 0);
  while (true) {
    try {
      await fs.mkdir(lock, {mode: PRIVATE_DIRECTORY_MODE});
      try { await writeFileExclusive(await checkedDataPath(root, '.transactions/lock/owner'), String(process.pid)); }
      catch (error) { await fs.rm(lock, { recursive: true, force: true }); throw error; }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await checkedDataPath(root, '.transactions/lock/owner');
      // Only one stale-owner reaper may inspect/remove a lock. Re-read under that guard
      // so a second reaper cannot delete a newly acquired writer's lock.
      const reaper = await checkedDataPath(root, '.transactions/lock-recovery');
      let reaping = false, recovered = false;
      try {
        try { await fs.mkdir(reaper, {mode: PRIVATE_DIRECTORY_MODE}); reaping = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        if (reaping) {
          const owner = await fs.readFile(await checkedDataPath(root, '.transactions/lock/owner'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
          const pid = /^\d+$/.test(owner) ? Number(owner) : 0;
          if (pid > 0 && Number.isSafeInteger(pid)) {
            try { process.kill(pid, 0); }
            catch (probe) {
              if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe;
              await fs.rm(lock, { recursive: true, force: true }); recovered = true;
            }
          }
        }
      } finally { if (reaping) await fs.rm(reaper, { recursive: true, force: true }); }
      if (recovered) continue;
      if (Date.now() >= deadline) throw new Error('Another Sync or storage writer is already running, or its lock has no live owner; inspect .prodero/.transactions/lock before retrying');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  try {
    if (!options.migrationRecovery && await exists(await checkedDataPath(root, '.transactions/migration.json'))) throw new Error('Interrupted migration requires recovery; run Prodero init or prepare before recording new data. Preserve .prodero/.backups and .prodero/.transactions.');
    const pending = await fs.readFile(await checkedDataPath(root, '.transactions/pending.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    let pendingVersion: unknown;
    try { pendingVersion = pending ? JSON.parse(pending).version : undefined; }
    catch { throw new Error("PRODERO_INVALID_JOURNAL: invalid pending journal JSON; preserve it for recovery."); }
    if (pendingVersion === 2) {
      if (options.recoverLifecycle === false) throw new Error('Lifecycle transaction pending; explicit recovery required before preview');
      await recoverSyncTransaction(root);
    }
    const owner = {root: path.resolve(root), active: true};
    try { return await writerContext.run(owner, operation); }
    finally { owner.active = false; }
  }
  finally { await fs.rm(lock, { recursive: true, force: true }); }
}
async function validateWriteContent(root: string, writes: PlannedWrite[]): Promise<void> {
  assertNoSecrets(writes.map(write => write.after));
  const schema = (await readConfig(root))?.knowledgeSchemaVersion;
  for (const write of writes) {
    const filename = path.basename(write.path);
    if (write.path.startsWith('checkpoints/')) parseCheckpointData(write.after, filename);
    else if ((write.path.startsWith('skills/') || write.path.startsWith('local/skills/'))) parseSkill(write.after, filename);
    else parseKnowledge(write.after, filename, schema);
  }
}
function validateMoves(writes: PlannedWrite[], moves: PlannedMove[]) {
  const sources=new Set<string>();
  for(const move of moves){
    if(sources.has(move.from)||writes.some(w=>w.path===move.from))throw new Error('Invalid lifecycle move source');
    sources.add(move.from);
    const destination=writes.find(w=>w.path===move.to);
    if(!destination||destination.before!==null||path.basename(move.from)!==path.basename(move.to)||move.from.startsWith('local/')!==move.to.startsWith('local/'))throw new Error('Invalid lifecycle archive move');
    const archived=parseKnowledge(destination.after,path.basename(move.to));
    if(['active','disputed'].includes(archived.status))throw new Error('Only historical knowledge can be archived');
    if(!archived.archivedAt||!move.to.includes(`archive/${new Date(archived.archivedAt).toISOString().slice(0,7).replace('-','_')}/`))throw new Error('Archive move requires matching archived_at');
  }
}
async function applyWrites(root: string, writes: PlannedWrite[], moves: PlannedMove[] = []) {
  // Validate the entire journal and every before-image before the first write.
  const targets = await Promise.all(writes.map((write) => safeProjectPath(root, write.path)));
  await validateWriteContent(root, writes);
  validateMoves(writes,moves);
  for(const move of moves){
    const actual=await fileHash(await safeProjectPath(root,move.from));
    const destination=writes.find(w=>w.path===move.to)!;
    if(actual!==move.before&&(actual!==null||await fileHash(await safeProjectPath(root,move.to))!==sha256(destination.after)))throw new Error('Lifecycle recovery found a changed or missing source; journal preserved');
  }
  for (let i = 0; i < writes.length; i++) {
    const actual = await fileHash(targets[i]);
    if (actual !== writes[i].before && actual !== sha256(writes[i].after)) throw new Error(`Sync recovery found concurrently changed ${writes[i].path}; preserved journal for review`);
  }
  for (let i = 0; i < writes.length; i++) {
    if (i === writes.length - 1) for (const move of moves) await fs.rm(await safeProjectPath(root,move.from),{force:true});
    if (await fileHash(targets[i]) !== sha256(writes[i].after)) {
      if (/^(local\/)?archive\//.test(writes[i].path)) await ensureDataDirectory(root,path.dirname(writes[i].path));
      await writeFileAtomic(targets[i], writes[i].after);
    }
  }
}
export async function recoverSyncTransaction(root: string): Promise<boolean> {
  await runtimeDirectory(root);
  const target = await checkedDataPath(root, '.transactions/pending.json');
  const content = await fs.readFile(target, 'utf8').catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (!content) return false;
  let journal: z.infer<typeof journalSchema>;
  try { journal = journalSchema.parse(JSON.parse(content)); }
  catch { throw new Error("PRODERO_INVALID_JOURNAL: .prodero/.transactions/pending.json has invalid JSON or metadata. Preserve the journal and inspect or restore it before retrying Sync."); }
  validateWriteOrder(journal.writes);
  await applyWrites(root, journal.writes, journal.version === 2 ? journal.moves : []);
  await fs.rm(target);
  return true;
}
function validateWriteOrder(writes: PlannedWrite[]) {
  if (new Set(writes.map((w) => w.path)).size !== writes.length || !writes.at(-1)?.path.startsWith('checkpoints/') || writes.slice(0, -1).some((w) => w.path.startsWith('checkpoints/'))) throw new Error('Invalid Sync transaction order');
  if (writes.at(-1)!.before !== null) throw new Error('Checkpoint must be immutable');
}
/** Durable journal is NOT a disposable cache. Checkpoint is committed last. */
export async function commitSyncTransaction(root: string, writes: PlannedWrite[], lifecycle?: {moves?:PlannedMove[]; policyMode?:'exact'}) {
  assertNoSecrets(writes.map(w => w.after));
  // Validate paths and preimages before interpreting any untrusted content.
  journalSchema.parse(lifecycle?.moves ? {version:2,writes,moves:lifecycle.moves} : {version:1,writes});
  validateWriteOrder(writes);
  for(const write of writes) {
    if(await fileHash(await safeProjectPath(root,write.path))!==write.before) throw new Error(`Knowledge changed while reasoning: ${write.path}; retry Sync`);
  }
  const guarded = await protectKnowledgeWrites(root, writes, lifecycle?.policyMode === 'exact', lifecycle?.moves);
  writes = guarded.writes;
  const journal = journalSchema.parse(lifecycle?.moves ? {version:2,writes,moves:lifecycle.moves} : { version: 1, writes });
  if (lifecycle?.moves) validateMoves(writes, lifecycle.moves);
  validateWriteOrder(journal.writes);
  for (const write of writes) {
    const target = await safeProjectPath(root, write.path);
    if (await fileHash(target) !== write.before) throw new Error(`Knowledge changed while reasoning: ${write.path}; retry Sync`);
  }
  for(const move of lifecycle?.moves??[])if(await fileHash(await safeProjectPath(root,move.from))!==move.before)throw new Error('Knowledge source changed before archive; retry lifecycle preview');
  await runtimeDirectory(root);
  const target = await checkedDataPath(root, '.transactions/pending.json');
  if (await fileHash(target)) throw new Error('Unrecovered Sync journal');
  await validateWriteContent(root, writes);
  await writeFileAtomic(target, JSON.stringify(journal));
  await applyWrites(root, journal.writes, journal.version === 2 ? journal.moves : []);
  await fs.rm(target);
  return guarded.policy;
}
