import type { IntelligenceTelemetry, IntelligenceRecord, KnowledgeCandidate } from "./intelligence.js";
export interface ProderoConfig {
  schemaVersion: number;
  /** Absent in legacy projects: knowledge format 1. */
  knowledgeSchemaVersion?: number;
  initializedWith: string;
  lastUpdatedWith: string;
  projectId: string;
  createdAt: string;
  presentation?: { mode?: "auto" | "ui" | "text"; theme?: import("../settings-definition.js").Theme };
  context?: {
    /** Current configuration names. */
    max_tokens?: number;
    /** Relevant soft target; continuation is marginal-value and capacity driven. */
    max_items?: number;
    /** Protected Required reserve; applicable Required may borrow total capacity. */
    required_max_tokens?: number;
    /** Legacy names remain readable for existing projects. */
    budgetTokens?: number;
    requiredBudgetTokens?: number;
  };
  knowledgeEngine?: { mode: "deterministic" | "assisted" };
}

export type TokenCountMethod = "estimated-utf8-bytes-div-4-v1";

export interface AgentUsageTelemetry {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cost?: number;
  source: string;
}

/** Future host adapters may supply real provider telemetry through this boundary. */
export interface AgentUsageAdapter {
  readUsage(): Promise<AgentUsageTelemetry | null>;
}

export type ContextPressure = "normal" | "moderate" | "high";

export interface ProderoContextMetrics {
  tokenCountMethod: TokenCountMethod;
  estimated: true;
  projectKnowledgeTokens: number;
  requiredGlobalTokens: number;
  requiredGlobalCandidateTokens: number;
  requiredGlobalExcludedItems: number;
  requiredCriticalOmitted?: number;
  requiredNormalOmitted?: number;
  requiredGlobalExcludedTokens: number;
  requiredGlobalOmittedByBudget: number;
  requiredGlobalOmittedByBudgetTokens: number;
  requiredGlobalOmittedByItemLimit: number;
  requiredGlobalOmittedByItemLimitTokens: number;
  requiredContextBudgetTokens: number;
  selectedContextualTokens: number;
  selectedSkillsTokens: number;
  projectSkillsTokens: number;
  skillSelectivity: number;
  contextTokens: number;
  contextBudgetTokens: number;
  contextSelectivity: number;
  requiredGlobalPressure: ContextPressure;
  staleRelevantItems: number;
}

export interface MemoryHealth {
  activeItems: number;
  disputedItems: number;
  historicalItems: number;
  staleActiveItems: number;
  missingProvenanceItems: number;
  oversizedActiveItems: number;
  status: "healthy" | "attention";
}

export interface MemoryCompressionMetric {
  kind: "compression" | "expansion" | "unchanged" | "unavailable";
  ratio: number | null;
}

export interface SessionLearnedSummary {
  observations: number;
  byType: Record<SessionObservationType, number>;
  rawSessionTokens: number;
  syncState: "pending-auto-sync" | "synchronized";
  synchronization: SyncResult | null;
}

export interface AttentionItem {
  kind: "conflict" | "corruption" | "migration" | "context-budget" | "global-pressure" | "stale-memory" | "memory-health";
  severity: "important" | "critical";
  title: string;
  detail: string;
}

export interface FastProjectStatus {
  root: string;
  name: string;
  initialized: boolean;
  git: boolean;
  agentsFile: boolean;
  schemaVersion: number | null;
  canonicalStructure: boolean;
}

export interface ProjectStatus extends FastProjectStatus {
  knowledgeCount: number;
  localKnowledgeCount: number;
  versionedKnowledgeCount: number;
  promotionRecommendedCount: number;
  sessionCount: number;
  activeSessionCount?: number;
  pendingSessionCount: number;
  skillCount: number;
  skillCandidateCount: number;
  skillDismissedCount: number;
  checkpointCount: number;
  conflictCount: number;
  lastSyncAt: string | null;
  memoryHealth: MemoryHealth;
  knowledgeGraph: KnowledgeGraphDiagnostics;
}

export type StatusTimingPhase = "fast-status" | "memory-index" | "session-index" | "telemetry" | "detailed-status" | "first-tool-response" | "update-check";

export interface StatusTiming {
  phase: StatusTimingPhase;
  durationMs: number;
  cache?: "warm" | "missing" | "invalid" | "stale";
  filesScanned?: number;
  bodiesRead?: number;
}

export type StatusInstrumentation = (timing: StatusTiming) => void;

export type SessionStatus = "open" | "active" | "closed";
export type SessionSection = "Decisions" | "Lessons" | "Discoveries" | "Project State Changes" | "Global Instruction Candidates" | "Skill Candidates";
export type SessionObservationType = "decision" | "lesson" | "discovery" | "state_change" | "global_instruction_candidate" | "skill_candidate";

export interface SessionObservationInput {
  applicability?: import("./applicability.js").Applicability;
  taskContext?: import("./applicability.js").TaskContextInput;
  type: SessionObservationType;
  content: string;
  title?: string;
  scopeHint?: KnowledgeScope;
  scopeRef?: string;
  scopeKind?: "path" | "topic";
  importanceHint?: KnowledgePriority;
  categoryHint?: KnowledgeCategory;
  description?: string;
  triggers?: string[];
  proposedReason?: string;
  supersedes?: string[];
  relations?: KnowledgeRelation[];
}

export interface RecordedObservation {
  id: string;
  type: SessionObservationType;
  content: string;
}

export interface SessionMemory {
  taskContext?: import("./applicability.js").TaskContext;
  id: string;
  parentSessionId?: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  agent: string;
  branch: string | null;
  baseCommit: string | null;
  path: string;
  sections: Record<SessionSection, string[]>;
}

export type KnowledgeScope = "global" | "module" | "task";
export type KnowledgeCategory = "principle" | "invariant" | "decision" | "constraint" | "lesson" | "state" | "instruction";
export type KnowledgePriority = "critical" | "important" | "normal" | "contextual";
export type KnowledgeStatus = "active" | "superseded" | "deprecated" | "consolidated" | "duplicate" | "disputed";
export type KnowledgeLayer = "local" | "versioned";
export type KnowledgeRelationType = "related_to" | "depends_on" | "implements" | "applies_to" | "supersedes" | "superseded_by" | "consolidates" | "consolidated_into" | "contradicts" | "learned_from";
export interface KnowledgeRelation { type: KnowledgeRelationType; target: string }

export interface KnowledgeGraphDiagnostics {
  cacheState: "warm" | "missing" | "invalid" | "stale";
  nodeCount: number;
  edgeCount: number;
  brokenReferences: number;
  conflictEdges: number;
}

/** Evidence is independent of its producer; imports may cite read-only source files. */
export interface EvidenceReference { kind: "session_observation" | "source_file" | "test" | "git_commit" | "documentation" | "user_instruction"; ref: string }

export interface KnowledgeItem {
  /** Optional only on transitional creation drafts. Parsed canonical records always have these fields. */
  version?: 1 | 2 | 3;
  applicability?: import("./applicability.js").Applicability;
  contextPolicy?: import('./knowledge-policy.js').ContextPolicy;
  authority?: import('./knowledge-policy.js').KnowledgeAuthority;
  /** Storage lifecycle timestamp, independent of semantic status/category. */
  archivedAt?: string;
  evidence?: EvidenceReference[];
  id: string;
  scope: KnowledgeScope;
  scopeRef: string | null;
  scopeKind?: "path" | "topic";
  category: KnowledgeCategory;
  priority: KnowledgePriority;
  status: KnowledgeStatus;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  sourceSessions: string[];
  derivedFrom: string[];
  supersedes: string[];
  related: string[];
  relations?: KnowledgeRelation[];
  /** Compatibility aliases: kind follows category; enforcement follows contextPolicy. Never persisted. */
  kind?: "instruction";
  enforcement?: import("./knowledge-policy.js").ContextPolicy;
}

export interface BootstrapInstruction {
  applicability?: import("./applicability.js").Applicability;
  appliesTo?:string;
  id: string;
  title: string;
  content: string;
  scope: KnowledgeScope;
  scopeRef: string | null;
  scopeKind?: "path" | "topic";
  priority: KnowledgePriority;
  status: "active" | "disputed";
  layer: KnowledgeLayer;
  kind: "instruction";
  contextPolicy: "required";
  authority: import("./knowledge-policy.js").KnowledgeAuthority;
  enforcement: "required";
  estimatedTokens: number;
}

export interface BootstrapContext {
  version: 1;
  projectRoot: string;
  scope: string | null;
  loaded: boolean;
  instructions: BootstrapInstruction[];
  warnings: string[];
  metrics: { scopedRequiredPolicies?: number; candidateInstructions: number; loadedInstructions: number; omittedInstructions: number; estimatedTokens: number; tokenCountMethod: TokenCountMethod; estimated: true };
  limits: { maxInstructions: number; budgetTokens: number };
}

export type ContextSelectionSignalKind = "marginal-value" | "query-token" | "title-token" | "scope-token" | "priority" | "scope-diversity" | "category-diversity" | "stale-state" | "graph-edge" | "purpose" | "recency";

export interface ContextSelectionSignal {
  kind: ContextSelectionSignalKind;
  label: string;
  score: number;
}

export interface ContextSelectionDetail {
  applicability?: import("./applicability.js").ApplicabilityDecision;
  estimatedTokens: number;
  score: number | null;
  rankScore: number | null;
  signals: ContextSelectionSignal[];
}

export interface OmittedContextCandidate {
  id: string;
  title: string;
  category: KnowledgeCategory;
  scope: KnowledgeScope;
  scopeRef: string | null;
  scopeKind?: "path" | "topic";
  priority: KnowledgePriority;
  estimatedTokens: number;
  score: number;
  rankScore: number;
  signals: ContextSelectionSignal[];
  reason: "budget" | "item-limit" | "marginal-value";
  constraint?: import("./context-allocation.js").AllocationConstraint;
}

export interface PreparedContextSnapshot {
  reviewId?: string;
  version: 1;
  sessionId: string | null;
  task: string | null;
}

export interface CheckpointSession {
  id: string | null;
  path: string;
  sha256: string;
}

export interface PolicyTransitionSummary {
  blocking:boolean; recommendations:number; safeFallbacks:number; reasons:string[]; interactivePrompts:number;
}
export interface Checkpoint {
  policyTransitions?:PolicyTransitionSummary;
  id: string;
  createdAt: string;
  previousCheckpoint: string | null;
  sessions: CheckpointSession[];
  consolidation: "deterministic-v1" | "assisted-v1" | "not-performed";
  intelligence?: IntelligenceTelemetry;
  reasoning?: IntelligenceRecord[];
  instructionCandidates?: KnowledgeCandidate[];
  observationHashes?: string[];
  knowledgeBefore?: KnowledgeItem[];
  createdMemory: string[];
  createdSkills?: string[];
  updatedMemory: string[];
  supersededMemory: string[];
  duplicateMemory: string[];
  conflicts: string[];
  summary: ConsolidationSummary;
  note?: string;
  curation?: {reviewEvidence?:string|null;planId:string;engine:string;selected:string[];leftUnchanged:string[];plan:import("./knowledge-curation.js").CurationPlan;preimages:Array<{path:string;revision:string;content:string}>};
  curationDefer?: string;
  importReceipt?: import("./imports.js").ImportReceipt;
  promotionRevisions?: Array<{path: string; hash: string}>;
  lifecycle?: { operationId: string; planId: string; proposalHash: string; transformationPreviewId?: string };
}

export interface ConsolidationSummary {
  sessions: number;
  candidates: number;
  created: number;
  consolidated: number;
  duplicates: number;
  superseded: number;
  conflicts: number;
}

export interface SyncResult extends ConsolidationSummary {
  policyTransitions?:PolicyTransitionSummary;
  checkpoint: string | null;
  consolidation: "deterministic-v1" | "assisted-v1";
  intelligence?: IntelligenceTelemetry;
  diagnostics: SyncDiagnostics;
  sessionsProcessed: number;
  observationsProcessed: number;
  knowledgeCreated: number;
  skillCandidatesCreated: number;
  skillCandidateTokensAdded: number;
  knowledgeConsolidated: number;
  knowledgeSuperseded: number;
  rawSessionTokens: number;
  rawKnowledgeTokens: number;
  rawSkillCandidateTokens: number;
  canonicalTokensAdded: number;
  compressionRatio: number | null;
  memoryCompression: MemoryCompressionMetric;
  tokenCountMethod: TokenCountMethod;
  estimated: true;
}

export interface SyncDiagnostics {
  sessionFilesScanned: number;
  sessionBodiesRead: number;
  sessionBodiesConsolidated: number;
  checkpointFilesRead: number;
  memoryFilesScanned: number;
  memoryBodiesIndexed: number;
  memoryBodiesLoaded: number;
  relatedCandidatesSelectedMax: number;
  relatedCandidateLimit: number;
  compactedSegments: number;
  conservativeMergesSkipped: number;
}

export interface ContextResult {
  allocation?: import("./context-allocation.js").AllocationDiagnostics;
  taskContext?: import("./applicability.js").TaskContext;
  applicability?: {unknownRequired:number;decisions:Record<string,import("./applicability.js").ApplicabilityDecision>;truncated:number};
  policyReadiness?:{state:"ready"|"review-required"|"context-needed"|"required-incomplete";blocking:boolean};
  purpose?: "explain" | "work" | "review" | "debug";
  projectRoot: string;
  query: string | null;
  required: KnowledgeItem[];
  relevant: KnowledgeItem[];
  skills: Array<{ id: string; path: string; title: string; description: string; triggers: string[]; content: string; category: "skill"; scope: string; estimatedTokens: number }>;
  snapshot: PreparedContextSnapshot;
  selection: {
    required: Record<string, ContextSelectionDetail>;
    relevant: Record<string, ContextSelectionDetail>;
    omittedRequired?: OmittedContextCandidate[];
    omittedRelevant: OmittedContextCandidate[];
    omittedRelevantByMarginalValue?: number;
    omittedRelevantByBudget: number;
    omittedRelevantByItemLimit: number;
    omittedRelevantDetailsTruncated: number;
    omittedSkillsByBudget: number;
    omittedSkillsByItemLimit: number;
    loadedKnowledgeItems: number;
    graphTraversal: { seedCount: number; traversedEdges: number; expandedItems: number; maxDepth: number; expansionLimit: number };
  };
  warnings: string[];
  attention: AttentionItem[];
  metrics: ProderoContextMetrics;
  agentUsage: AgentUsageTelemetry | null;
  memoryHealth: MemoryHealth;
  knowledgeGraph: KnowledgeGraphDiagnostics;
  limits: { maxSkills: number; skillBudgetTokens: number; maxRequiredItems: number; maxRelevantItems: number; contextBudgetTokens: number; requiredContextBudgetTokens: number; tokenCountMethod: TokenCountMethod; estimated: true };
}

export interface MigrationResult {
  migrated: boolean;
  from: number | null;
  to: number;
  backup: string | null;
}
