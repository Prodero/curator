import {parseObservationAnnotations as annotations} from "./format.js";
import {type Applicability,validateApplicability,withApplicability,sameApplicability} from "./applicability.js";
import { inferredKnowledge } from './knowledge-authority.js';
import { knowledgePolicy, inheritKnowledgePolicy } from "./knowledge-policy.js";
import { SyncEvidenceCollector, pressureRecord, type PressureRecord, type SyncPressureDraft } from "./memory-pressure.js";
import { deterministicClassification, reconciliationSignal } from "./reconciliation.js";
import { assertCompatibleProject } from "./storage.js";
import { assertNoSecrets } from "./secrets.js";
import type { KnowledgeCandidate } from "./intelligence.js";
import { exactKnowledge, semanticRisk, evidenceSentences } from "./semantic-safety.js";
import { createSkillCandidate } from "./skills.js";
import { sortableId } from "./ids.js";
import { tokens } from "./matching.js";
import { loadMemoryCatalog, MAX_RELATED_MEMORY_CANDIDATES } from "./memory-index.js";
import { renderKnowledge, parseKnowledge } from "./memory.js";
import { safeProjectPath, fileHash, type PlannedWrite } from "./sync-transaction.js";
import { estimateTokens, knowledgeText } from "./telemetry.js";
import type { KnowledgeCategory, KnowledgeItem, KnowledgePriority, KnowledgeRelation, KnowledgeScope, SessionMemory } from "./types.js";

export interface Candidate {
  applicability?:Applicability;
  instructionCandidate: boolean;
  skill: boolean;
  description?: string;
  triggers: string[];
  proposedReason?: string;
  scope: KnowledgeScope;
  scopeRef: string | null;
  scopeKind?: "path" | "topic";
  category: KnowledgeCategory;
  priority: KnowledgePriority;
  title: string;
  content: string;
  sessionId: string;
  derivedFrom: string;
  supersedes: string[];
  relations: KnowledgeRelation[];
}

export interface ConsolidationResult {
  memoryPressure?: SyncPressureDraft;
  writes?: PlannedWrite[];
  instructionCandidates?: KnowledgeCandidate[];
  candidates: number;
  created: string[];
  createdSkills: string[];
  skillCandidateTokensAdded: number;
  updated: string[];
  consolidated: string[];
  superseded: string[];
  duplicates: string[];
  conflicts: string[];
  conflictCount: number;
  memoryFilesScanned: number;
  memoryBodiesIndexed: number;
  memoryBodiesLoaded: number;
  relatedCandidatesSelectedMax: number;
  observationsProcessed: number;
  rawSessionTokens: number;
  rawKnowledgeTokens: number;
  rawSkillCandidateTokens: number;
  canonicalTokensAdded: number;
  compactedSegments: number;
  conservativeMergesSkipped: number;
}

export interface Consolidator {
  readonly name: string;
  consolidate(root: string, sessions: SessionMemory[], now?: Date, processedSources?: Set<string>): Promise<ConsolidationResult>;
}

const SECTION_DEFAULTS: Record<string, { category: KnowledgeCategory; priority: KnowledgePriority; scope: KnowledgeScope }> = {
  Decisions: { category: "decision", priority: "important", scope: "global" },
  Lessons: { category: "lesson", priority: "normal", scope: "task" },
  Discoveries: { category: "state", priority: "normal", scope: "task" },
  "Project State Changes": { category: "state", priority: "normal", scope: "global" },
  "Global Instruction Candidates": { category: "instruction", priority: "important", scope: "global" },
  "Skill Candidates": { category: "instruction", priority: "contextual", scope: "task" },
};

function similarity(a: string, b: string): { jaccard: number; coverage: number } {
  const left = tokens(a); const right = tokens(b);
  if (!left.size || !right.size) return { jaccard: 0, coverage: 0 };
  const intersection = [...left].filter((token) => right.has(token)).length;
  return { jaccard: intersection / (left.size + right.size - intersection), coverage: intersection / Math.min(left.size, right.size) };
}


function asScope(value: string | undefined, fallback: KnowledgeScope): KnowledgeScope { return value === "module" || value === "task" || value === "global" ? value : fallback; }
function asPriority(value: string | undefined, fallback: KnowledgePriority): KnowledgePriority { return value === "critical" || value === "important" || value === "normal" || value === "contextual" ? value : fallback; }
function asCategory(value: string | undefined, fallback: KnowledgeCategory): KnowledgeCategory {
  return value === "principle" || value === "invariant" || value === "decision" || value === "constraint" || value === "lesson" || value === "state" || value === "instruction" ? value : fallback;
}
function titleFrom(content: string): string {
  const clean = content.replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
  const sentence = clean.match(/^(.{1,100}?[.!?])(?:\s|$)/)?.[1] ?? clean;
  return sentence.length > 100 ? `${sentence.slice(0, 97).trim()}…` : sentence;
}

export function sessionCandidates(session: SessionMemory): Candidate[] {
  assertNoSecrets(session);
  const candidates: Candidate[] = [];
  for (const [section, items] of Object.entries(session.sections)) {
    const defaults = SECTION_DEFAULTS[section];
    if (!defaults) continue;
    items.forEach((raw, index) => {
      const parsed = annotations(raw);
      if (!parsed.content) return;
      const explicitFromText = [...parsed.content.matchAll(/\b(?:replaces|supersedes)\s+(mem_[a-zA-Z0-9_]+)/gi)].map((match) => match[1]);
      let triggers: string[] = [];
      try { const value = JSON.parse(parsed.metadata.triggers ?? "[]"); if (Array.isArray(value)) triggers = value.filter((v): v is string => typeof v === "string"); } catch { /* Legacy observations have no structured triggers. */ }
      let relations: KnowledgeRelation[] = [];
      try { const value = JSON.parse(parsed.metadata.relations ?? "[]"); if (Array.isArray(value)) relations = value.filter((v): v is KnowledgeRelation => Boolean(v && typeof v === "object" && typeof v.type === "string" && typeof v.target === "string")); } catch { /* Legacy observations have no structured relationships. */ }
      candidates.push({
        ...(parsed.metadata.applicability?{applicability:validateApplicability(JSON.parse(parsed.metadata.applicability))}:{}),
        instructionCandidate: section === "Global Instruction Candidates",
        skill: section === "Skill Candidates",
        description: parsed.metadata.description,
        triggers,
        proposedReason: parsed.metadata.proposed_reason,
        scope: asScope(parsed.metadata.scope, defaults.scope),
        scopeRef: parsed.metadata.scope_ref ?? null,
        ...(parsed.metadata.scope_kind ? { scopeKind: parsed.metadata.scope_kind as "path" | "topic" } : {}),
        category: asCategory(parsed.metadata.category, defaults.category),
        priority: asPriority(parsed.metadata.priority, defaults.priority),
        title: parsed.metadata.title ?? titleFrom(parsed.content),
        content: parsed.content,
        sessionId: session.id,
        derivedFrom: `${session.id}#${parsed.metadata.id ?? `${section.replace(/\s+/g, "-").toLowerCase()}-${index + 1}`}`,
        supersedes: unique([...(parsed.metadata.supersedes?.split(",").map((value) => value.trim()).filter(Boolean) ?? []), ...explicitFromText]),
        relations,
      });
    });
  }
  return candidates.map(c=>c.applicability&&!c.skill&&!c.instructionCandidate?withApplicability(c,c.applicability):c);
}

function unique(values: string[]): string[] { return [...new Set(values)].sort(); }
function uniqueRelations(values: KnowledgeRelation[]): KnowledgeRelation[] {
  return [...new Map(values.map((relation) => [`${relation.type}:${relation.target}`, relation])).values()]
    .sort((a, b) => a.type.localeCompare(b.type) || a.target.localeCompare(b.target));
}
function explicitSuperseded(candidate: Candidate, active: KnowledgeItem[]): KnowledgeItem[] {
  return active.filter((item) => candidate.supersedes.includes(item.id) || new RegExp(`\\b(?:replaces|supersedes)\\s+${item.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(candidate.content));
}
/** Core-owned signals; similarity and merge guards are never conflict verdicts. */
export function candidateReviewSignals(candidate: Candidate, related: KnowledgeItem[]) {
  const signals: Array<{kind:string;detail:string;severity:'info'|'warning';requiresReview:boolean;memory?:{id:string;title:string;content:string}}> = [];
  if(candidate.instructionCandidate) signals.push({kind:'instruction-candidate',detail:'Proposed instruction; not an active required policy.',severity:'info',requiresReview:true});
  if(candidate.skill) signals.push({kind:'skill-candidate',detail:'Proposed skill; activation requires separate review.',severity:'info',requiresReview:true});
  for(const old of related) {
    const category = deterministicClassification(candidate, old);
    // Retrieval can include loose neighbors; keep unrelated observations quiet.
    if (category === 'unresolved' && similarity(candidate.content,old.content).coverage < 0.3) continue;
    signals.push(reconciliationSignal(category, old));
  }
  return signals;
}

function mergeEligible(candidate: Candidate, old: KnowledgeItem): boolean {
  if (semanticRisk(candidate.content, old.content)) return false;
  const incoming = evidenceSentences(candidate.content);
  const existing = evidenceSentences(old.content);
  // Only an unchanged sentence prefix plus complementary complete sentences is safe without reasoning.
  const smaller = incoming.length < existing.length ? incoming : existing;
  const larger = incoming.length < existing.length ? existing : incoming;
  return smaller.length > 0 && smaller.every((sentence, index) => sentence === larger[index])
    && estimateTokens(`${old.title}\n${old.content}\n${candidate.content}`) <= 2_000;
}

function segments(value: string): string[] {
  return value.split(/(?:\r?\n){2,}|(?<=[.!?])\s+(?=[\p{Lu}\p{N}`])/u).map((part) => part.trim()).filter(Boolean);
}

function compactContribution(existing: string, incoming: string): { content: string; added: string; removed: number } {
  const kept = segments(existing);
  const seen = new Set(kept.map(exactKnowledge));
  const added: string[] = [];
  let removed = 0;
  for (const segment of segments(incoming)) {
    const key = exactKnowledge(segment);
    if (!key || seen.has(key)) { removed += 1; continue; }
    seen.add(key);
    kept.push(segment);
    added.push(segment);
  }
  return { content: kept.join("\n\n"), added: added.join("\n\n"), removed };
}

async function deterministicConsolidate(root: string, sessions: SessionMemory[], now = new Date(), processedSources = new Set<string>()): Promise<ConsolidationResult> {
  const candidates = sessions.flatMap(sessionCandidates).filter((candidate) => !processedSources.has(candidate.derivedFrom));
  const catalog = await loadMemoryCatalog(root);
  const writes = new Map<string, PlannedWrite>();
  const pressure = new SyncEvidenceCollector();
  const changedRecords = new Map<string, PressureRecord>();
  const stageKnowledge = async (item: KnowledgeItem) => {
    const relative = `local/memory/${item.id}.md`;
    const after = renderKnowledge(item);
    parseKnowledge(after, `${item.id}.md`);
    const existing = writes.get(relative);
    const before = existing ? existing.before : catalog.originalHashes.get(item.id) ?? await fileHash(await safeProjectPath(root, relative));
    writes.set(relative, { path: relative, before, after });
    catalog.stage(item, "local");
    changedRecords.set(item.id, pressureRecord({ ...item, layer: "local", estimatedTokens: estimateTokens(knowledgeText(item)), relations: item.relations ?? [] }));
  };
  const result: ConsolidationResult = {
    candidates: 0, created: [], createdSkills: [], skillCandidateTokensAdded: 0, updated: [], consolidated: [], superseded: [], duplicates: [], conflicts: [], conflictCount: 0,
    memoryFilesScanned: catalog.filesScanned, memoryBodiesIndexed: catalog.bodiesIndexed, memoryBodiesLoaded: 0, relatedCandidatesSelectedMax: 0,
    observationsProcessed: 0, rawSessionTokens: 0, rawKnowledgeTokens: 0, rawSkillCandidateTokens: 0, canonicalTokensAdded: 0,
    compactedSegments: 0, conservativeMergesSkipped: 0,
  };
  result.candidates = candidates.length;
  result.observationsProcessed = candidates.length;
  result.rawKnowledgeTokens = candidates.filter((candidate) => !candidate.skill).reduce((total, candidate) => total + estimateTokens(candidate.content), 0);
  result.rawSkillCandidateTokens = candidates.filter((candidate) => candidate.skill).reduce((total, candidate) => total + estimateTokens(candidate.content), 0);
  result.rawSessionTokens = candidates.reduce((total, candidate) => total + estimateTokens(candidate.content), 0);

  for (const candidate of candidates) {
    if (candidate.instructionCandidate) {
      (result.instructionCandidates ??= []).push({ ...candidate, id: `candidate_${result.instructionCandidates?.length ?? 0}`, kind: "instruction_candidate", sources: [candidate.derivedFrom], evidence: [{ source: candidate.derivedFrom, quote: candidate.content }] });
      continue;
    }
    if (candidate.skill) {
      const saved = await createSkillCandidate(root, {
        title: candidate.title,
        description: candidate.description ?? candidate.content.replace(/\s+/g, " ").slice(0, 300),
        content: candidate.content,
        scope: candidate.scopeRef ?? "project",
        triggers: candidate.triggers,
      }, { sessionId: candidate.sessionId, derivedFrom: candidate.derivedFrom, proposedReason: candidate.proposedReason }, now, writes);
      if (saved.created) {
        result.createdSkills.push(saved.skill.id);
        result.skillCandidateTokensAdded += estimateTokens(saved.skill.content);
      }
      continue;
    }
    const selected = catalog.selectRelated({
      scope: candidate.scope,
      scopeRef: candidate.scopeRef,
      scopeKind: candidate.scopeKind,
      applicability:candidate.applicability??{kind:"legacy"},
      category: candidate.category,
      title: candidate.title,
      content: candidate.content,
      explicitIds: candidate.supersedes,
    }, MAX_RELATED_MEMORY_CANDIDATES);
    // An explicit replacement must survive the complete write path. Never silently
    // drop a missing/historical target and save an unrelated active record instead.
    const unavailable = candidate.supersedes.filter(id => !selected.some(item => item.id === id));
    if (unavailable.length) throw new Error(`Explicit supersedes target is missing or no longer current: ${unavailable.join(", ")}. Session remains pending; use current memory IDs.`);
    result.relatedCandidatesSelectedMax = Math.max(result.relatedCandidatesSelectedMax, selected.length);
    const active = await Promise.all(selected.map((entry) => catalog.load(entry.id)));
    for (const signal of candidateReviewSignals(candidate, active)) {
      const target = selected.find(item => item.id === signal.memory?.id);
      if (target) pressure.observe(candidate.derivedFrom, pressureRecord(target), signal.kind as import("./intelligence.js").ReconciliationCategory);
    }
    const localIds = new Set(selected.filter((entry) => entry.layer === "local").map((entry) => entry.id));
    const exact = active.find((item) => item.scope === candidate.scope && item.scopeRef === candidate.scopeRef && item.scopeKind === candidate.scopeKind && item.category === candidate.category && sameApplicability(item,candidate) && exactKnowledge(item.content) === exactKnowledge(candidate.content));
    if (exact && !candidate.supersedes.length) {
      if (localIds.has(exact.id)) {
        exact.sourceSessions = unique([...exact.sourceSessions, candidate.sessionId]);
        exact.derivedFrom = unique([...exact.derivedFrom, candidate.derivedFrom]);
        exact.relations = uniqueRelations([...(exact.relations ?? []), ...candidate.relations]);
        exact.updatedAt = now.toISOString();
        await stageKnowledge(exact);
        result.updated.push(exact.id);
      }
      result.duplicates.push(exact.id);
      continue;
    }

    const supersededTargets = explicitSuperseded(candidate, active);
    const replaced = supersededTargets.filter((item) => localIds.has(item.id));
    const id = sortableId("mem", now);
    const item: KnowledgeItem = {
      id,
      scope: candidate.scope,
      scopeRef: candidate.scopeRef,
      scopeKind: candidate.scopeKind,
      applicability:candidate.applicability??{kind:"legacy"},
      version:3,
      category: candidate.category,
      priority: candidate.priority,
      status: "active",
      title: candidate.title,
      content: candidate.content,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      sourceSessions: [candidate.sessionId],
      derivedFrom: [candidate.derivedFrom],
      supersedes: unique(supersededTargets.flatMap((old) => [old.id, ...old.supersedes])),
      related: [],
      relations: uniqueRelations(candidate.relations),
    };

    Object.assign(item, withApplicability(inferredKnowledge(item),item.applicability!));
    inheritKnowledgePolicy(item, supersededTargets);

    if (supersededTargets.length) {
      for (const old of replaced) {
        old.status = "superseded";
        old.updatedAt = now.toISOString();
        old.related = unique([...old.related, id]);
        await stageKnowledge(old);
        result.superseded.push(old.id);
        result.updated.push(old.id);
      }
    } else {
      const sameBoundary = active.filter((old) => localIds.has(old.id) && old.scope === candidate.scope && old.scopeRef === candidate.scopeRef && old.scopeKind === candidate.scopeKind && old.category === candidate.category && sameApplicability(old,candidate));
      const overlapping = sameBoundary.find((old) => mergeEligible(candidate, old));
      if (overlapping) {
        const compacted = compactContribution(overlapping.content, candidate.content);
        overlapping.content = compacted.content;
        result.compactedSegments += compacted.removed;
        result.canonicalTokensAdded += estimateTokens(compacted.added);
        overlapping.sourceSessions = unique([...overlapping.sourceSessions, candidate.sessionId]);
        overlapping.derivedFrom = unique([...overlapping.derivedFrom, candidate.derivedFrom]);
        overlapping.relations = uniqueRelations([...(overlapping.relations ?? []), ...candidate.relations]);
        overlapping.updatedAt = now.toISOString();
        await stageKnowledge(overlapping);
        result.updated.push(overlapping.id);
        if (compacted.added) result.consolidated.push(overlapping.id); else result.duplicates.push(overlapping.id);
        continue;
      }

      if (sameBoundary.some((old) => {
        const score = similarity(`${candidate.title} ${candidate.content}`, `${old.title} ${old.content}`);
        return score.jaccard >= 0.35 || score.coverage >= 0.5;
      })) result.conservativeMergesSkipped += 1;

      // Similarity and protected-token changes only limit safe merging. Without
      // semantic evidence, keep both records active for later reconciliation.
    }

    await stageKnowledge(item);
    result.created.push(id);
    result.canonicalTokensAdded += estimateTokens(knowledgeText(item));
  }
  result.created = unique(result.created);
  result.updated = unique(result.updated);
  result.consolidated = unique(result.consolidated);
  result.superseded = unique(result.superseded);
  result.duplicates = unique(result.duplicates);
  result.conflicts = unique(result.conflicts);
  result.memoryBodiesLoaded = catalog.bodiesLoaded;
  result.writes = [...writes.values()];
  result.memoryPressure = pressure.finish([...changedRecords.values()], result);
  return result;
}

export const deterministicConsolidator: Consolidator = {
  name: "deterministic-v1",
  consolidate: deterministicConsolidate,
};

export async function consolidateSessions(root: string, sessions: SessionMemory[], now = new Date(), consolidator: Consolidator = deterministicConsolidator, processedSources = new Set<string>()): Promise<ConsolidationResult> {
  await assertCompatibleProject(root);
  return consolidator.consolidate(root, sessions, now, processedSources);
}
