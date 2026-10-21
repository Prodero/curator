import { replaceManagedBlock } from "./templates.js";
import {withApplicability,applicabilityOf,sameApplicability,inferApplicability,buildTaskContext,type Applicability,type TaskContextInput} from "./applicability.js";
import { withTrustedKnowledgeIntent, type CurrentUserRule } from './knowledge-authority.js';
import { recordRetrievalEvidence, recordSyncEvidenceLocked, type RetrievalEvidence } from "./memory-pressure.js";
import { publicDiagnostic } from "./diagnostics.js";
import { explicitProjectRoot } from "./project-root.js";
import { reviewSessionKnowledge } from "./session-review.js";
import { assertNoSecrets } from "./secrets.js";
import { intelligenceTelemetry, type IntelligenceProvider } from "./intelligence.js";
import { planAssistedSync, observationEvidence, observationKey } from "./knowledge-engine.js";
import { withSyncLock, recoverSyncTransaction, commitSyncTransaction, safeProjectPath, fileHash } from "./sync-transaction.js";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { listProjectSkills, skillCounts } from "./skills.js";
import { consolidateSessions } from "./consolidation.js";
import { PRODERO_SCHEMA_VERSION, PRODERO_KNOWLEDGE_SCHEMA_VERSION, PRODERO_VERSION } from "./constants.js";
import { prepareContext, type ContextPurpose, MAX_CONTEXT_RELEVANT_ITEMS } from "./context.js";
import { emptyBootstrapContext, getBootstrapContext } from "./bootstrap.js";
import { associatePreparedContext } from "./context-snapshot.js";
import { sortableId } from "./ids.js";
import { buildIndex } from "./index.js";
import { assertEnglishProse } from "./language.js";
import { loadKnowledgeGraph } from "./knowledge-graph.js";
import { loadMemoryCatalog, memoryHealth } from "./memory-index.js";
import { forgetMemory, getMemory, searchMemory, type MemorySearchOptions } from "./memory-operations.js";
import { migrateProject, recoverProjectMigration, requireCurrentProject } from "./migrations.js";
import { listKnowledge } from "./memory.js";
import { safeRelative } from "./plugin-files.js";
import { exactKnowledge } from "./semantic-safety.js";
import { applyKnowledgePromotion, previewKnowledgePromotion, promotionRecommendations, type PromotionPreview } from "./promotion.js";
import { discoverSessions } from "./session-index.js";
import { closeSession, createSession, readSession, recordSessionObservations, updateSessionTaskContext } from "./sessions.js";
import { DEFAULT_CONTEXT_BUDGET_TOKENS, DEFAULT_REQUIRED_CONTEXT_BUDGET_TOKENS, memoryCompression, summarizeSessionMemory, TOKEN_COUNT_METHOD } from "./telemetry.js";
import { INDEX_TEMPLATE } from "./templates.js";
import {
  CANONICAL_ID_PATTERN,
  ensureDerivedStateRoot,
  checkedDataPath,
  ensureProjectDirectories,
  ensureRuntimeDirectories,
  ensureLocalStateIgnored,
  exists,
  projectDataPath,
  readConfig,
  sha256,
  writeFileAtomic,
  writeConfig,
} from "./storage.js";
import type { AgentUsageTelemetry, Checkpoint, ContextResult, FastProjectStatus, KnowledgeItem, KnowledgeCategory, KnowledgePriority, KnowledgeRelation, KnowledgeScope, MigrationResult, ProjectStatus, ProderoConfig, SessionObservationInput, SessionObservationType, StatusInstrumentation, StatusTimingPhase, SyncDiagnostics, SyncResult } from "./types.js";

export { PRODERO_SCHEMA_VERSION, PRODERO_VERSION } from "./constants.js";
export { createSession, parseSession, SESSION_SECTIONS } from "./sessions.js";
export { getContext } from "./context.js";
export { emptyBootstrapContext, getBootstrapContext } from "./bootstrap.js";
export { buildIndex } from "./index.js";
export { listKnowledge, parseKnowledge } from "./memory.js";
export { searchMemory } from "./memory-operations.js";
export type { ContextResult, FastProjectStatus, KnowledgeItem, MigrationResult, ProjectStatus, ProderoConfig, SessionMemory, SessionObservationInput, StatusInstrumentation, StatusTiming, SyncResult } from "./types.js";

export async function findProjectRoot(start = process.cwd()): Promise<string> {
  // Adapter discovery is explicit: Core must never widen the selected boundary.
  return explicitProjectRoot(path.resolve(start));
}

async function updateManagedAgents(root: string): Promise<void> {
  const agentsPath = path.join(root, "AGENTS.md");
  const existing = (await exists(agentsPath)) ? await fs.readFile(agentsPath, "utf8") : "";
  const next = replaceManagedBlock(existing);
  if (next !== existing) await writeFileAtomic(agentsPath, next);
}

async function timed<T>(phase: StatusTimingPhase, instrument: StatusInstrumentation | undefined, operation: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try { return await operation(); }
  finally { instrument?.({ phase, durationMs: performance.now() - started }); }
}

export async function getFastProjectStatus(start = process.cwd(), options: { instrument?: StatusInstrumentation } = {}): Promise<FastProjectStatus> {
  return timed("fast-status", options.instrument, async () => {
    const root = await findProjectRoot(start);
    const [configExists, git, agentsFile] = await Promise.all([
      exists(projectDataPath(root, "config.json")),
      exists(path.join(root, ".git")),
      exists(path.join(root, "AGENTS.md")),
    ]);
    let config: ProderoConfig | null = null;
    if (configExists) {
      try { config = await readConfig(root); }
      catch (error) {
        if (error instanceof Error && error.message.startsWith("PRODERO_SCHEMA_NEWER:")) throw error;
        // Detailed hydration reports config corruption after the App shell renders.
      }
    }
    const canonicalStructure = configExists && (await Promise.all([
      "index.md", "memory", "sessions", "skills", "checkpoints",
    ].map((entry) => exists(projectDataPath(root, entry))))).every(Boolean);
    return {
      root,
      name: path.basename(root),
      initialized: configExists,
      git,
      agentsFile,
      schemaVersion: config?.schemaVersion ?? null,
      canonicalStructure,
    };
  });
}

export async function getDetailedProjectStatus(start = process.cwd(), options: { instrument?: StatusInstrumentation; persistCache?: boolean } = {}): Promise<ProjectStatus> {
  const started = performance.now();
  try {
    const root = await findProjectRoot(start);
    const config = await readConfig(root);
    const statusReads = [
      config ? (async () => {
        const phaseStarted = performance.now();
        const result = await discoverSessions(root, {persistCache: options.persistCache});
        options.instrument?.({ phase: "session-index", durationMs: performance.now() - phaseStarted, cache: result.cacheState, filesScanned: result.sessionFilesScanned, bodiesRead: result.sessionBodiesRead });
        return result;
      })() : null,
      config ? (async () => {
        const phaseStarted = performance.now();
        const result = await loadMemoryCatalog(root, {persistCache: options.persistCache});
        options.instrument?.({ phase: "memory-index", durationMs: performance.now() - phaseStarted, cache: result.cacheState, filesScanned: result.filesScanned, bodiesRead: result.bodiesIndexed });
        return result;
      })() : null,
      getFastProjectStatus(root),
      listProjectSkills(root),
    ] as const;
    let statusResults;
    try { statusResults = await Promise.all(statusReads); }
    catch (error) {
      // Readers can finish derived-cache writes after a sibling fails (including a
      // pending lifecycle guard). Do not return while those writes are still running.
      await Promise.allSettled(statusReads);
      throw error;
    }
    const [discovery, catalog, fast, skills] = statusResults;
    const telemetryStarted = performance.now();
    const knowledge = catalog?.summaries ?? [];
    const graph = config && catalog ? await loadKnowledgeGraph(root, catalog, {persistCache: options.persistCache}) : null;
    const disputedIds = new Set(knowledge.filter((item) => item.status === "disputed").map((item) => item.id));
    const conflictPairs = new Set<string>();
    for (const item of knowledge.filter((candidate) => candidate.status === "disputed")) {
      for (const related of item.related.filter((id) => disputedIds.has(id))) conflictPairs.add([item.id, related].sort().join(":"));
      if (!item.related.some((id) => disputedIds.has(id))) conflictPairs.add(item.id);
    }
    const counts = skillCounts(skills);
    const recommendations = config ? await promotionRecommendations(root, {persistCache: options.persistCache}) : [];
    const status = {
      ...fast,
      knowledgeCount: knowledge.filter((item) => item.status === "active" || item.status === "disputed").length,
      localKnowledgeCount: knowledge.filter((item) => item.layer === "local" && (item.status === "active" || item.status === "disputed")).length,
      versionedKnowledgeCount: knowledge.filter((item) => item.layer === "versioned" && (item.status === "active" || item.status === "disputed")).length,
      promotionRecommendedCount: recommendations.filter((item) => item.recommended).length,
      sessionCount: discovery?.sessions.length ?? 0,
      activeSessionCount: discovery?.sessions.filter((session) => session.status !== "closed").length ?? 0,
      pendingSessionCount: discovery?.sessions.filter((session) => session.pending).length ?? 0,
      skillCount: counts.active,
      skillCandidateCount: counts.candidate,
      skillDismissedCount: counts.dismissed,
      checkpointCount: discovery?.checkpointCount ?? 0,
      conflictCount: conflictPairs.size,
      lastSyncAt: discovery?.lastSyncAt ?? null,
      memoryHealth: memoryHealth(knowledge),
      knowledgeGraph: graph?.diagnostics ?? { cacheState: "missing" as const, nodeCount: 0, edgeCount: 0, brokenReferences: 0, conflictEdges: 0 },
    };
    options.instrument?.({ phase: "telemetry", durationMs: performance.now() - telemetryStarted });
    return status;
  } finally {
    options.instrument?.({ phase: "detailed-status", durationMs: performance.now() - started });
  }
}

/** Complete status remains the compatibility API for correctness-oriented callers. */
export async function getProjectStatus(start = process.cwd(), options: {persistCache?: boolean} = {}): Promise<ProjectStatus> {
  return getDetailedProjectStatus(start, options);
}

export async function initializeProject(start = process.cwd()): Promise<ProjectStatus> {
  const root = await findProjectRoot(start);
  await recoverProjectMigration(root);
  const existing = await readConfig(root);
  await ensureProjectDirectories(root);
  if (existing) await migrateProject(root, existing);
  const config: ProderoConfig = existing ?? {
    schemaVersion: PRODERO_SCHEMA_VERSION,
    knowledgeSchemaVersion: PRODERO_KNOWLEDGE_SCHEMA_VERSION,
    initializedWith: PRODERO_VERSION,
    lastUpdatedWith: PRODERO_VERSION,
    projectId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    context: { max_tokens: DEFAULT_CONTEXT_BUDGET_TOKENS, max_items: MAX_CONTEXT_RELEVANT_ITEMS, required_max_tokens: DEFAULT_REQUIRED_CONTEXT_BUDGET_TOKENS },
  };
  await writeConfig(root, config);
  const indexPath = await checkedDataPath(root, "index.md");
  if (!(await exists(indexPath))) await fs.writeFile(indexPath, INDEX_TEMPLATE);
  await updateManagedAgents(root);
  await ensureLocalStateIgnored(root);
  await buildIndex(root);
  return getProjectStatus(root);
}

export async function autoMigrateProject(start = process.cwd()): Promise<MigrationResult> {
  const root = await findProjectRoot(start);
  await recoverProjectMigration(root);
  const config = await readConfig(root);
  if (!config) return { migrated: false, from: null, to: PRODERO_SCHEMA_VERSION, backup: null };
  await ensureRuntimeDirectories(root);
  const result = await migrateProject(root, config);
  if (result.migrated) {
    await updateManagedAgents(root);
    await ensureLocalStateIgnored(root);
    await buildIndex(root);
  }
  return result;
}

export interface ProjectIntegrationRefresh {
  root: string;
  migration: MigrationResult;
  changedFiles: string[];
}

const INTEGRATION_FILES = ["AGENTS.md", ".gitignore", ".prodero/config.json", ".prodero/index.md"] as const;
async function integrationRevision(root: string, relative: string): Promise<string | null> {
  const target = path.join(root, relative);
  return (await exists(target)) ? sha256(await fs.readFile(target, "utf8")) : null;
}

/** Explicitly reconcile runtime-owned project integration without rewriting knowledge. */
export async function refreshProjectIntegration(start = process.cwd()): Promise<ProjectIntegrationRefresh> {
  const root = await findProjectRoot(start);
  const config = await readConfig(root);
  if (!config) throw new Error("Prodero is not initialized for this project.");
  const before = new Map(await Promise.all(INTEGRATION_FILES.map(async (relative) => [relative, await integrationRevision(root, relative)] as const)));
  const migration = await migrateProject(root, config);
  await updateManagedAgents(root);
  await ensureLocalStateIgnored(root);
  await buildIndex(root);
  const changedFiles: string[] = [];
  for (const relative of INTEGRATION_FILES) if (before.get(relative) !== await integrationRevision(root, relative)) changedFiles.push(relative);
  return { root, migration, changedFiles };
}

const PENDING_INTEGRATION_REFRESH = ".cache/runtime-maintenance.json";
export async function scheduleProjectIntegrationRefresh(start: string, target: { version: string | null; source: string }): Promise<void> {
  const root = await findProjectRoot(start);
  if (!(await readConfig(root))) return;
  await ensureDerivedStateRoot(root);
  await writeFileAtomic(projectDataPath(root, PENDING_INTEGRATION_REFRESH), `${JSON.stringify({ formatVersion: 1, target, requestedAt: new Date().toISOString() }, null, 2)}\n`);
}

export async function applyPendingProjectIntegrationRefresh(start = process.cwd()): Promise<ProjectIntegrationRefresh | null> {
  const root = await findProjectRoot(start), marker = projectDataPath(root, PENDING_INTEGRATION_REFRESH);
  if (!(await exists(marker))) return null;
  const raw = JSON.parse(await fs.readFile(marker, "utf8")) as { formatVersion?: unknown };
  if (raw.formatVersion !== 1) throw new Error("Invalid pending Prodero project-maintenance marker.");
  const result = await refreshProjectIntegration(root);
  await fs.rm(marker, { force: true });
  return result;
}

export interface SyncOptions { onlyClosed?: boolean; provider?: IntelligenceProvider; sessionId?: string; excludeSessionId?: string }
export async function syncProject(start = process.cwd(), options: SyncOptions = {}): Promise<SyncResult> {
  const root = await findProjectRoot(start);
  if (!(await readConfig(root))) throw new Error("Prodero is not initialized for this project.");
  await requireCurrentProject(root);
  await autoMigrateProject(root);
  return withSyncLock(root, async () => { await recoverSyncTransaction(root); return syncProjectLocked(root, options); });
}
async function syncProjectLocked(start: string, options: SyncOptions): Promise<SyncResult> {
  const root = await findProjectRoot(start);
  if (!(await readConfig(root))) throw new Error("Prodero is not initialized for this project.");
  const discovery = await discoverSessions(root, { loadPendingBodies: true, onlyClosed: options.onlyClosed });
  const states = discovery.sessions.filter((state) => state.pending && (!options.onlyClosed || state.status === "closed") && (!options.sessionId || state.id === options.sessionId) && (state.id !== options.excludeSessionId || state.status === "closed"));
  const config = (await readConfig(root))!;
  const mode = config.knowledgeEngine?.mode ?? "deterministic";
  if (mode !== "deterministic" && mode !== "assisted") throw new Error("Invalid knowledgeEngine.mode");
  const provider = mode === "assisted" ? options.provider : undefined;
  const intelligence = intelligenceTelemetry(provider, mode === "assisted" && !provider ? "Intelligence provider unavailable; conservative deterministic fallback" : undefined);
  const emptyDiagnostics: SyncDiagnostics = {
    sessionFilesScanned: discovery.sessionFilesScanned,
    sessionBodiesRead: discovery.sessionBodiesRead,
    sessionBodiesConsolidated: 0,
    checkpointFilesRead: discovery.checkpointFilesRead,
    memoryFilesScanned: 0,
    memoryBodiesIndexed: 0,
    memoryBodiesLoaded: 0,
    relatedCandidatesSelectedMax: 0,
    relatedCandidateLimit: 24,
    compactedSegments: 0,
    conservativeMergesSkipped: 0,
  };
  if (!states.length) {
    const catalog = await loadMemoryCatalog(root);
    emptyDiagnostics.memoryFilesScanned = catalog.filesScanned;
    emptyDiagnostics.memoryBodiesIndexed = catalog.bodiesIndexed;
    await buildIndex(root);
    return {
      checkpoint: null, intelligence, consolidation: provider ? "assisted-v1" : "deterministic-v1", sessions: 0, candidates: 0, created: 0, consolidated: 0, duplicates: 0, superseded: 0, conflicts: 0, diagnostics: emptyDiagnostics,
      sessionsProcessed: 0, observationsProcessed: 0, knowledgeCreated: 0, skillCandidatesCreated: 0, skillCandidateTokensAdded: 0, knowledgeConsolidated: 0, knowledgeSuperseded: 0,
      rawSessionTokens: 0, rawKnowledgeTokens: 0, rawSkillCandidateTokens: 0, canonicalTokensAdded: 0, compressionRatio: null, memoryCompression: memoryCompression(0, 0), tokenCountMethod: TOKEN_COUNT_METHOD, estimated: true,
    };
  }

  const now = new Date();
  const sessions = states.map((state) => state.session!);
  const plan = provider ? await planAssistedSync(root, sessions, provider, now, discovery.processedObservations) : null;
  // Recheck snapshots after reasoning: new observations must never be checkpointed accidentally.
  for (const state of states) if (await fileHash(await safeProjectPath(root, `sessions/${state.path}`)) !== state.sha256) throw new Error("Session changed during Sync; retry with the new evidence");
  const processedSources = new Set(observationEvidence(sessions).filter((entry) => discovery.processedObservations.has(observationKey(entry))).map((entry) => entry.id));
  const consolidation = plan?.result ?? await consolidateSessions(root, sessions, now, undefined, processedSources);
  const id = sortableId("chk", now);
  const summary = {
    sessions: states.length,
    candidates: consolidation.candidates,
    created: consolidation.created.length,
    consolidated: consolidation.consolidated.length,
    duplicates: consolidation.duplicates.length,
    superseded: consolidation.superseded.length,
    conflicts: consolidation.conflictCount,
  };
  const checkpoint: Checkpoint = {
    id,
    createdAt: now.toISOString(),
    previousCheckpoint: discovery.latestCheckpointId,
    sessions: states.map((state) => ({ id: state.id, path: state.path, sha256: state.sha256 })),
    consolidation: plan ? "assisted-v1" : "deterministic-v1",
    intelligence: plan?.intelligence ?? intelligence,
    reasoning: plan?.reasoning,
    instructionCandidates: plan?.instructionCandidates ?? consolidation.instructionCandidates,
    knowledgeBefore: plan?.knowledgeBefore,
    observationHashes: plan?.observationHashes ?? observationEvidence(sessions).map(observationKey),
    createdMemory: consolidation.created,
    createdSkills: consolidation.createdSkills,
    updatedMemory: consolidation.updated,
    supersededMemory: consolidation.superseded,
    duplicateMemory: consolidation.duplicates,
    conflicts: consolidation.conflicts,
    summary,
  };
  const checkpointText = `${JSON.stringify(checkpoint, null, 2)}\n`;
  // Recheck after deterministic planning too, before the durable journal is created.
  for (const state of states) if (await fileHash(await safeProjectPath(root, `sessions/${state.path}`)) !== state.sha256) throw new Error("Session changed during Sync; retry with the new evidence");
  const policyTransitions = await commitSyncTransaction(root, [...(plan?.writes ?? consolidation.writes ?? []), { path: `checkpoints/${id}.json`, before: null, after: checkpointText }]);
  consolidation.consolidated=consolidation.consolidated.filter(id=>!policyTransitions.preservedIds.includes(id));summary.consolidated=consolidation.consolidated.length;
  if(policyTransitions.createdIds) { consolidation.created=policyTransitions.createdIds;summary.created=consolidation.created.length; }
  if(policyTransitions.supersededIds) { consolidation.superseded=policyTransitions.supersededIds;summary.superseded=consolidation.superseded.length; }
  // Observational sidecar failure must never change the committed Sync outcome.
  if (consolidation.memoryPressure) await recordSyncEvidenceLocked(root, {
    ...consolidation.memoryPressure, checkpoint: id,
    sessionIds: states.slice(0, 128).map(state => state.id), sessionIdsDropped: Math.max(0, states.length - 128),
  });
  const refreshed = await discoverSessions(root);
  await buildIndex(root);
  const compression = memoryCompression(consolidation.rawKnowledgeTokens, consolidation.canonicalTokensAdded);
  return {
    checkpoint: id,
    policyTransitions,
    consolidation: plan ? "assisted-v1" : "deterministic-v1",
    intelligence: plan?.intelligence ?? intelligence,
    ...summary,
    sessionsProcessed: states.length,
    observationsProcessed: consolidation.observationsProcessed,
    knowledgeCreated: consolidation.created.length,
    skillCandidatesCreated: consolidation.createdSkills.length,
    skillCandidateTokensAdded: consolidation.skillCandidateTokensAdded,
    knowledgeConsolidated: consolidation.consolidated.length,
    knowledgeSuperseded: consolidation.superseded.length,
    rawSessionTokens: consolidation.rawSessionTokens,
    rawKnowledgeTokens: consolidation.rawKnowledgeTokens,
    rawSkillCandidateTokens: consolidation.rawSkillCandidateTokens,
    canonicalTokensAdded: consolidation.canonicalTokensAdded,
    compressionRatio: compression.kind === "compression" ? compression.ratio : null,
    memoryCompression: compression,
    tokenCountMethod: TOKEN_COUNT_METHOD,
    estimated: true,
    diagnostics: {
      sessionFilesScanned: discovery.sessionFilesScanned,
      sessionBodiesRead: discovery.sessionBodiesRead,
      sessionBodiesConsolidated: states.length,
      checkpointFilesRead: discovery.checkpointFilesRead + refreshed.checkpointFilesRead,
      memoryFilesScanned: consolidation.memoryFilesScanned,
      memoryBodiesIndexed: consolidation.memoryBodiesIndexed,
      memoryBodiesLoaded: consolidation.memoryBodiesLoaded,
      relatedCandidatesSelectedMax: consolidation.relatedCandidatesSelectedMax,
      relatedCandidateLimit: 24,
      compactedSegments: consolidation.compactedSegments,
      conservativeMergesSkipped: consolidation.conservativeMergesSkipped,
    },
  };
}

export async function resolveProjectContext(start = process.cwd(), query?: string): Promise<ContextResult> {
  const root = await findProjectRoot(start);
  return prepareContext(root, { query });
}

/** Lightweight recall never initializes, migrates, syncs, or opens a session. */
export async function recallProject(start: string | undefined, query: string, purpose: ContextPurpose = "explain") {
  if (!query.trim()) throw new Error("Recall query must not be empty.");
  const root = await findProjectRoot(start);
  return prepareContext(root, { query, purpose });
}

export async function resolveProjectBootstrapContext(start = process.cwd(), scope?: string) {
  const root = await findProjectRoot(start);
  if (!(await readConfig(root))) throw new Error("Prodero is not initialized for this project.");
  return getBootstrapContext(root, scope);
}

export async function prepareProject(start = process.cwd(), options: { task?: string; taskContext?:TaskContextInput; purpose?: ContextPurpose; agent?: string; sessionId?: string; agentUsage?: AgentUsageTelemetry | null; provider?: IntelligenceProvider; onRequiredOmitted?: (items: import("./types.js").OmittedContextCandidate[]) => void } = {}) {
  assertNoSecrets([options.task, options.agent]);
  const root = await findProjectRoot(start);
  await requireCurrentProject(root);
  await recoverProjectMigration(root);
  if (!(await readConfig(root))) await initializeProject(root);
  await requireCurrentProject(root);
  await autoMigrateProject(root);
  // Recover durable snapshots of interrupted sessions without closing live sessions.
  // A session explicitly resumed by this prepare remains untouched.
  const automaticSync = await syncProject(root, { excludeSessionId: options.sessionId, provider: options.provider });
  const discovery = await discoverSessions(root);
  let retrievalEvidence: RetrievalEvidence | undefined;
  const context = await prepareContext(root, {
    query: options.task,
    onRetrievalEvidence: evidence => { retrievalEvidence = evidence; },
    purpose: options.purpose ?? "work",
    taskContext:options.taskContext,
    pendingSessions: discovery.sessions.filter((candidate) => candidate.pending).length,
    onRequiredOmitted: options.onRequiredOmitted,
  });
  context.agentUsage = options.agentUsage ?? null;
  if (automaticSync.intelligence?.audit.status === "attention" && !context.attention.some((item) => item.kind === "conflict")) {
    context.attention.push({ kind: "memory-health", severity: "important", title: "Knowledge review needed", detail: "The affected-area audit left uncertainty or reached its review budget. Original evidence is preserved." });
  }
  let session = options.sessionId ? await readSession(root, options.sessionId) : undefined;
  if (session?.status === "closed") session = undefined;
  if (!session) session = await createSession(root, { agent: options.agent, taskContext:context.taskContext });
  else if(context.taskContext)session=await updateSessionTaskContext(root,session.id,context.taskContext);
  associatePreparedContext(context, session.id);
  const memoryTelemetry = retrievalEvidence ? await recordRetrievalEvidence(root, session.id, retrievalEvidence) : "unavailable";
  const status = await getProjectStatus(root);
  const uiState = { blocking:context.policyReadiness?.blocking??false, view: context.attention.length ? "attention" as const : "context-ready" as const, attention: context.attention };
  return { memoryTelemetry, project: status, session: { id: session.id, path: `.prodero/sessions/${session.path}`, status: session.status }, automaticSync, context, proderoMetrics: context.metrics, agentUsage: context.agentUsage, uiState };
}

export async function recordProjectSession(start: string | undefined, sessionId: string, entries: SessionObservationInput[]) {
  const root = await findProjectRoot(start);
  if (!(await readConfig(root))) throw new Error("Prodero is not initialized for this project.");
  await requireCurrentProject(root);
  await autoMigrateProject(root);
  return recordSessionObservations(root, sessionId, entries);
}

export async function closeProjectSession(start: string | undefined, sessionId: string, finalEntries: SessionObservationInput[] = [], sync = true, _provider?: IntelligenceProvider) {
  const root = await findProjectRoot(start);
  if (!(await readConfig(root))) throw new Error("Prodero is not initialized for this project.");
  await requireCurrentProject(root);
  await autoMigrateProject(root);
  const closed = await closeSession(root, sessionId, finalEntries);
  // Persist the immutable observation batch before Sync. Closed means recording ended;
  // only the checkpoint certifies synchronization. Errors propagate, leaving recovery evidence.
  const synchronization = sync ? await syncProject(root, { onlyClosed: true, sessionId }) : null;
  const learned = {
    ...summarizeSessionMemory(closed.session),
    syncState: synchronization ? "synchronized" as const : "pending-auto-sync" as const,
    synchronization,
  };
  // Review is optional: an unavailable catalogue must not undo successful close.
  let review: {root:string;sessionId:string;total:number;needsReview:number;automatic:number;consolidated:boolean;error?:string};
  try {
    const inspected = await reviewSessionKnowledge(root, sessionId);
    if (inspected.consolidated) learned.syncState = "synchronized";
    review = {root,sessionId,...inspected.summary,consolidated:inspected.consolidated};
  } catch (error) {
    review = {root,sessionId,total:learned.observations,needsReview:1,automatic:0,consolidated:Boolean(synchronization),error:publicDiagnostic(error)};
  }
  return { ...closed, synchronization, learned, review, proderoMetrics: { tokenCountMethod: TOKEN_COUNT_METHOD, estimated: true, rawSessionTokens: learned.rawSessionTokens }, agentUsage: null, uiState: { view: "session-learned" as const } };
}

export interface RememberKnowledgeInput {
  applicability?:Applicability;
  taskContext?:TaskContextInput;
  sessionId?: string;
  content: string;
  title?: string;
  scope?: "global" | "project" | "path";
  path?: string;
  kind?: "rule" | "decision" | "fact" | "lesson";
  importance?: KnowledgePriority;
  replaceId?: string;
  relationships?: KnowledgeRelation[];
}

const KIND_CATEGORY: Record<NonNullable<RememberKnowledgeInput["kind"]>, KnowledgeCategory> = { rule: "instruction", decision: "decision", fact: "state", lesson: "lesson" };
const KIND_OBSERVATION: Record<NonNullable<RememberKnowledgeInput["kind"]>, SessionObservationType> = { rule: "decision", decision: "decision", fact: "state_change", lesson: "lesson" };

export async function rememberProjectKnowledge(start: string | undefined, input: RememberKnowledgeInput, provider?: IntelligenceProvider) {
  assertNoSecrets(input);
  const root = await findProjectRoot(start);
  if (!(await readConfig(root))) await initializeProject(root);
  await requireCurrentProject(root);
  await autoMigrateProject(root);
  const content = input.content?.trim();
  if (!content) throw new Error("Remember requires non-empty durable content.");
  if (content.length > 10_000) throw new Error("Remember content may not exceed 10,000 characters.");
  if (input.title && input.title.trim().length > 200) throw new Error("Remember title may not exceed 200 characters.");
  assertEnglishProse([input.title, content], "Remembered Prodero knowledge");
  const beforeKnowledge = await listKnowledge(root);
  const replaced = input.replaceId ? await getMemory(root, input.replaceId) : undefined;
  if (replaced && replaced.status !== "active" && replaced.status !== "disputed") throw new Error("Only active or disputed knowledge can be updated.");
  const relationships = [...new Map((input.relationships ?? replaced?.relations ?? []).map((relation) => [`${relation.type}:${relation.target}`, relation])).values()]
    .sort((a, b) => a.type.localeCompare(b.type) || a.target.localeCompare(b.target));
  if (relationships.length > 12) throw new Error("Remember supports at most 12 explicit relationships.");
  for (const relation of relationships) {
    if (!["related_to", "depends_on", "implements"].includes(relation.type) || !CANONICAL_ID_PATTERN.test(relation.target)) throw new Error("Remember relationship is malformed.");
    const target = beforeKnowledge.find((item) => item.id === relation.target);
    if (!target || (target.status !== "active" && target.status !== "disputed")) throw new Error(`Remember relationship target is not current canonical knowledge: ${relation.target}`);
  }
  const parentContext=input.sessionId?(await readSession(root,input.sessionId)).taskContext:undefined;
  const applicability=input.applicability??(replaced?applicabilityOf(replaced):input.scope==='path'?{kind:'scoped' as const,paths:[safeRelative(input.path??'')]}:input.scope?{kind:'project' as const}:inferApplicability(content,input.taskContext?buildTaskContext('',input.taskContext):parentContext));
  const projected=withApplicability({scope:replaced?.scope??'global' as KnowledgeScope,scopeRef:replaced?.scopeRef??null as string|null,scopeKind:replaced?.scopeKind as 'path'|'topic'|undefined},applicability);
  const scope=projected.scope,scopeRef=projected.scopeRef??undefined;
  const kind = input.kind ?? (replaced?.category === "instruction" ? "rule" : replaced?.category === "state" ? "fact" : replaced?.category === "lesson" ? "lesson" : "decision");
  const priority = input.importance ?? replaced?.priority ?? 'normal';
  const session = await createSession(root, { agent: "conversational-memory", parentSessionId: input.sessionId });
  const recorded = await recordSessionObservations(root, session.id, [{
    type: KIND_OBSERVATION[kind],
    content,
    title: input.title?.trim() || replaced?.title,
    scopeHint: scope,
    scopeRef,
    applicability,
    ...(projected.scopeKind ? { scopeKind: projected.scopeKind } : {}),
    categoryHint: KIND_CATEGORY[kind],
    importanceHint: priority,
    supersedes: replaced ? [replaced.id] : undefined,
    relations: relationships,
  }]);
  await closeSession(root, session.id);
  const synchronization = await syncProject(root, { onlyClosed: true, provider, sessionId: session.id });
  const provenance = `${session.id}#${recorded.recorded[0].id}`;
  const item = (await listKnowledge(root)).find((candidate) => candidate.derivedFrom.includes(provenance))
    ?? beforeKnowledge.find((candidate) => candidate.scope === scope && candidate.scopeRef === (scopeRef ?? null) && candidate.category === KIND_CATEGORY[kind] && exactKnowledge(candidate.content) === exactKnowledge(content));
  if (!item) throw new Error("Remember synchronized but did not resolve a canonical knowledge item.");
  const id = item.id;
  const previous = beforeKnowledge.find((candidate) => candidate.id === id);
  const sameRelations = JSON.stringify(previous?.relations ?? []) === JSON.stringify(item.relations ?? []);
  const replacementApplied=!!replaced && item.supersedes.includes(replaced.id);
  const outcome = replacementApplied ? "updated" : !previous ? "created" : previous.content === item.content && sameRelations ? "duplicate" : "merged";
  const layer = (await loadMemoryCatalog(root)).summaries.find((candidate) => candidate.id === item.id)?.layer ?? "local";
  return {
    item,
    layer,
    outcome,
    replacedId: replacementApplied ? replaced!.id : null,
    preservedId: replaced && !replacementApplied ? replaced.id : null,
    sessionId: session.id,
    parentSessionId: session.parentSessionId ?? null,
    observationId: recorded.recorded[0].id,
    checkpoint: synchronization.checkpoint,
    synchronization,
  };
}

/** This validates binding, not authenticity. Only the embedding host can attest intent. */
export function matchesCurrentUserRule(input:RememberKnowledgeInput,intent:CurrentUserRule):boolean {
  return intent.mandatory===true && !!intent.turnId?.trim() && !!intent.userText?.trim() && intent.content===input.content && (input.scope===undefined || input.scope===intent.scope) && input.path===intent.path && (input.importance===undefined || input.importance===intent.importance) && (input.applicability===undefined || JSON.stringify(input.applicability)===JSON.stringify(intent.applicability));
}
/** Trusted host adapter only. Tool arguments never call this path on their own. */
export async function rememberCurrentUserRule(root:string,input:RememberKnowledgeInput,intent:CurrentUserRule) {
  if(!matchesCurrentUserRule(input,intent)) throw new Error('Current user intent does not match the requested knowledge');
  return rememberAuthorizedRule(root,input,intent,`current-user-turn:${intent.turnId}: ${intent.userText}`);
}
/** Explicit chat command, authorized by the calling assistant from the user's request.
 * This is model-mediated provenance, not a claim of authenticated host attestation. */
export async function rememberChatRule(root:string,input:RememberKnowledgeInput,userInstruction:string) {
  if(input.kind!=='rule'||!userInstruction.trim())throw new Error('A Required chat rule needs the explicit user request.');
  assertNoSecrets(userInstruction);
  const scope=input.scope??'project';
  if(scope==='path'&&!input.path?.trim())throw new Error('Path-scoped Required rules need a path.');
  return rememberAuthorizedRule(root,input,{content:input.content,scope,path:input.path,importance:input.importance,applicability:input.applicability},`chat-user-request: ${userInstruction.trim()}`);
}
async function rememberAuthorizedRule(root:string,input:RememberKnowledgeInput,intent:Pick<CurrentUserRule,'content'|'scope'|'path'|'importance'|'applicability'>,evidence:string) {
  const scope=intent.scope==='path'?'module' as const:'global' as const;
  const priority=intent.importance??'normal';
  const applicability=intent.applicability??(intent.scope==='path'?{kind:'scoped' as const,paths:[intent.path!]}:{kind:'project' as const});
  const proposed:KnowledgeItem=withApplicability({id:'mem_intent',version:3,category:'instruction',contextPolicy:'required',authority:'explicit_user',scope,scopeRef:intent.path??null,...(intent.scope==='path'?{scopeKind:'path' as const}:{}),priority,status:'active',title:input.title??'',content:intent.content,createdAt:'',updatedAt:'',sourceSessions:[],derivedFrom:[],supersedes:[],related:[]},applicability);
  return withTrustedKnowledgeIntent(root,proposed,{authority:'explicit_user',evidence},()=>rememberProjectKnowledge(root,{...input,scope:intent.scope,path:intent.path,importance:intent.importance,applicability,kind:'rule'}));
}

export async function searchProjectMemory(start: string | undefined, query: string, options: MemorySearchOptions = {}) {
  const root = await findProjectRoot(start);
  if (!(await readConfig(root))) throw new Error("Prodero is not initialized for this project.");
  await requireCurrentProject(root);
  await autoMigrateProject(root);
  const normalizedQuery = query.trim();
  if (!normalizedQuery) throw new Error("Memory search requires a non-empty query.");
  const normalizedOptions = { ...options };
  if (options.scope === "path") {
    if (!options.path?.trim()) throw new Error("Path-scoped memory search requires a repository-relative path.");
    normalizedOptions.path = safeRelative(options.path.trim().replace(/^\.\//, "").replace(/\/$/, ""));
  }
  return { query: normalizedQuery, matches: await searchMemory(root, normalizedQuery, normalizedOptions) };
}

export async function forgetProjectKnowledge(start: string | undefined, input: { id?: string; query?: string; reason?: string }) {
  const root = await findProjectRoot(start);
  if (!(await readConfig(root))) throw new Error("Prodero is not initialized for this project.");
  await requireCurrentProject(root);
  await autoMigrateProject(root);
  return forgetMemory(root, input);
}

export async function previewProjectKnowledgePromotion(start: string | undefined, options: { ids?: string[]; includeAll?: boolean; provider?: IntelligenceProvider } = {}) {
  const root = await findProjectRoot(start);
  if (!(await readConfig(root))) throw new Error("Prodero is not initialized for this project.");
  await requireCurrentProject(root);
  await autoMigrateProject(root);
  return previewKnowledgePromotion(root, options);
}

export async function promoteProjectKnowledge(start: string | undefined, preview: PromotionPreview, approved: boolean) {
  const root = await findProjectRoot(start);
  if (!(await readConfig(root))) throw new Error("Prodero is not initialized for this project.");
  await requireCurrentProject(root);
  await autoMigrateProject(root);
  return applyKnowledgePromotion(root, preview, approved);
}
