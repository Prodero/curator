import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter } from "./format.js";
import { parseSession } from "./sessions.js";
import { ensureDerivedStateRoot, exists, projectDataPath, checkedDataPath, parseCheckpointData, sha256, writeFileAtomic } from "./storage.js";
import type { DerivedCacheState } from "./memory-index.js";
import type { Checkpoint, SessionMemory, SessionStatus } from "./types.js";

interface FileStamp { size: number; mtimeMs: number; ctimeMs: number }
interface CachedCheckpoint extends FileStamp { id: string; createdAt: string; processedKeys: string[]; observationHashes?: string[] }
interface CachedSession extends FileStamp { id: string; parentSessionId?: string; sha256: string; status: SessionStatus; hasObservations: boolean }
interface SessionIndexCache {
  version: 3;
  checkpoints: Record<string, CachedCheckpoint>;
  sessions: Record<string, CachedSession>;
}

export interface DiscoveredSession {
  id: string;
  parentSessionId?: string;
  path: string;
  sha256: string;
  status: SessionStatus;
  hasObservations: boolean;
  pending: boolean;
  session?: SessionMemory;
}

export interface SessionDiscovery {
  sessions: DiscoveredSession[];
  checkpointCount: number;
  latestCheckpointId: string | null;
  lastSyncAt: string | null;
  sessionFilesScanned: number;
  sessionBodiesRead: number;
  checkpointFilesRead: number;
  cacheState: DerivedCacheState;
  processedObservations: Set<string>;
  processedSessionPaths: Set<string>;
}

const EMPTY_CACHE: SessionIndexCache = { version: 3, checkpoints: {}, sessions: {} };
function stamp(stat: Awaited<ReturnType<typeof fs.stat>>): FileStamp { return { size: Number(stat.size), mtimeMs: Number(stat.mtimeMs), ctimeMs: Number(stat.ctimeMs) }; }
function sameStamp(left: FileStamp | undefined, right: FileStamp): boolean { return Boolean(left && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs); }

const stampSchema = z.object({ size: z.number().nonnegative(), mtimeMs: z.number().finite(), ctimeMs: z.number().finite() });
const cacheSchema = z.object({
  version: z.literal(3),
  checkpoints: z.record(stampSchema.extend({id: z.string(), createdAt: z.string(), processedKeys: z.array(z.string()), observationHashes: z.array(z.string()).optional()})),
  sessions: z.record(stampSchema.extend({id: z.string(), parentSessionId: z.string().regex(/^sess_[a-zA-Z0-9_]+$/).optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/), status: z.enum(["active", "open", "closed"]), hasObservations: z.boolean()})),
});

async function readCache(root: string, persistCache: boolean): Promise<{ cache: SessionIndexCache; state: DerivedCacheState }> {
  if (persistCache) await ensureDerivedStateRoot(root);
  const target = await checkedDataPath(root, ".cache", "session-index.json");
  if (!(await exists(target))) return { cache: structuredClone(EMPTY_CACHE), state: "missing" };
  try {
    const parsed = cacheSchema.parse(JSON.parse(await fs.readFile(target, "utf8")));
    return { cache: parsed, state: "warm" };
  } catch {
    // Disposable derived JSON is rebuilt below; canonical sessions/checkpoints remain authoritative.
  }
  if (persistCache) await fs.rm(target, { force: true });
  return { cache: structuredClone(EMPTY_CACHE), state: "invalid" };
}

function parseCheckpoint(content: string, filename: string): CachedCheckpoint {
  const checkpoint = parseCheckpointData(content, filename);
  return { observationHashes: checkpoint.observationHashes ?? [], id: checkpoint.id, createdAt: checkpoint.createdAt, processedKeys: checkpoint.sessions.map((session) => `${session.path}:${session.sha256}`), size: 0, mtimeMs: 0, ctimeMs: 0 };
}

export async function discoverSessions(root: string, options: { loadPendingBodies?: boolean; onlyClosed?: boolean; persistCache?: boolean } = {}): Promise<SessionDiscovery> {
  const { cache, state } = await readCache(root, options.persistCache !== false);
  const nextCheckpoints: Record<string, CachedCheckpoint> = {};
  const processed = new Set<string>();
  const processedObservations = new Set<string>();
  let checkpointFilesRead = 0;
  const checkpointDirectory = await checkedDataPath(root, "checkpoints");
  const checkpointNames = (await fs.readdir(checkpointDirectory)).filter((name) => name.endsWith(".json")).sort();
  for (const name of checkpointNames) {
    const target = await checkedDataPath(root, "checkpoints", name);
    const fileStamp = stamp(await fs.stat(target));
    let entry = cache.checkpoints[name];
    if (!sameStamp(entry, fileStamp)) {
      entry = { ...parseCheckpoint(await fs.readFile(target, "utf8"), name), ...fileStamp };
      checkpointFilesRead += 1;
    }
    nextCheckpoints[name] = entry;
    for (const hash of entry.observationHashes ?? []) processedObservations.add(hash);
    for (const key of entry.processedKeys) processed.add(key);
  }

  const nextSessions: Record<string, CachedSession> = {};
  const sessions: DiscoveredSession[] = [];
  let sessionBodiesRead = 0;
  const sessionDirectory = await checkedDataPath(root, "sessions");
  const sessionNames = (await fs.readdir(sessionDirectory)).filter((name) => name.endsWith(".md") && !name.startsWith(".")).sort();
  for (const name of sessionNames) {
    const target = await checkedDataPath(root, "sessions", name);
    const fileStamp = stamp(await fs.stat(target));
    let cached = cache.sessions[name];
    let parsed: SessionMemory | undefined;
    if (!sameStamp(cached, fileStamp)) {
      const content = await fs.readFile(target, "utf8");
      sessionBodiesRead += 1;
      parsed = parseSession(content, name);
      if (name.startsWith("sess_")) {
        const { metadata } = parseFrontmatter(content);
        if (metadata.id !== path.basename(name, ".md") || !["open", "active", "closed"].includes(String(metadata.status)) || typeof metadata.created_at !== "string") {
          throw new Error(`Invalid Prodero session: ${name} metadata is missing, malformed, or does not match the filename.`);
        }
      }
      cached = {
        ...fileStamp,
        id: parsed.id,
        parentSessionId: parsed.parentSessionId,
        sha256: sha256(content),
        status: parsed.status,
        hasObservations: Object.values(parsed.sections).some((items) => items.length > 0),
      };
    }
    nextSessions[name] = cached;
    const pending = cached.hasObservations && !processed.has(`${name}:${cached.sha256}`);
    const needsBody = options.loadPendingBodies && pending && (!options.onlyClosed || cached.status === "closed");
    if (needsBody && !parsed) {
      parsed = parseSession(await fs.readFile(target, "utf8"), name);
      sessionBodiesRead += 1;
    }
    sessions.push({ id: cached.id, parentSessionId: cached.parentSessionId, path: name, sha256: cached.sha256, status: cached.status, hasObservations: cached.hasObservations, pending, session: parsed });
  }

  const nextCache: SessionIndexCache = { version: 3, checkpoints: nextCheckpoints, sessions: nextSessions };
  if (options.persistCache !== false) {
    await ensureDerivedStateRoot(root);
    await writeFileAtomic(projectDataPath(root, ".cache", "session-index.json"), `${JSON.stringify(nextCache)}\n`);
  }
  const checkpointEntries = Object.values(nextCheckpoints).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    processedObservations,
    processedSessionPaths: new Set([...processed].map(key => key.slice(0, key.lastIndexOf(":")))),
    sessions,
    checkpointCount: checkpointEntries.length,
    latestCheckpointId: checkpointEntries.at(-1)?.id ?? null,
    lastSyncAt: checkpointEntries.at(-1)?.createdAt ?? null,
    sessionFilesScanned: sessionNames.length,
    sessionBodiesRead,
    checkpointFilesRead,
    cacheState: state === "warm" && (sessionBodiesRead > 0 || checkpointFilesRead > 0) ? "stale" : state,
  };
}
