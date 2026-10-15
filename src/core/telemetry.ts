import {parseObservationAnnotations} from "./format.js";
import type { ContextPressure, MemoryCompressionMetric, SessionMemory, SessionObservationType, TokenCountMethod } from "./types.js";

export const TOKEN_COUNT_METHOD: TokenCountMethod = "estimated-utf8-bytes-div-4-v1";
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 6_000;
export const DEFAULT_REQUIRED_CONTEXT_BUDGET_TOKENS = 2_000;
export const MAX_CANONICAL_ITEM_TOKENS = 2_000;
export const STALE_STATE_AFTER_DAYS = 180;

/**
 * Deterministic local approximation: ceil(UTF-8 byte length / 4).
 * It is deliberately model-neutral and must never be presented as provider billing usage.
 */
export function estimateTokens(value: string): number {
  return value ? Math.ceil(Buffer.byteLength(value, "utf8") / 4) : 0;
}

export function knowledgeText(item: { title: string; content: string }): string {
  return `${item.title}\n${item.content}`;
}

export function safeRatio(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return Math.max(0, numerator) / denominator;
}

export function contextPressure(requiredTokens: number, budgetTokens: number): ContextPressure {
  const ratio = safeRatio(requiredTokens, budgetTokens);
  return ratio >= 0.75 ? "high" : ratio >= 0.5 ? "moderate" : "normal";
}

export function memoryCompression(rawTokens: number, canonicalTokens: number): MemoryCompressionMetric {
  if (rawTokens <= 0) return { kind: "unavailable", ratio: null };
  if (canonicalTokens < rawTokens) return { kind: "compression", ratio: 1 - canonicalTokens / rawTokens };
  if (canonicalTokens > rawTokens) return { kind: "expansion", ratio: canonicalTokens / rawTokens - 1 };
  return { kind: "unchanged", ratio: 0 };
}

const SECTION_TYPES: Record<string, SessionObservationType> = {
  Decisions: "decision",
  Lessons: "lesson",
  Discoveries: "discovery",
  "Project State Changes": "state_change",
  "Global Instruction Candidates": "global_instruction_candidate",
  "Skill Candidates": "skill_candidate",
};

export function summarizeSessionMemory(session: SessionMemory) {
  const byType: Record<SessionObservationType, number> = {
    decision: 0, lesson: 0, discovery: 0, state_change: 0, global_instruction_candidate: 0, skill_candidate: 0,
  };
  let observations = 0;
  let rawSessionTokens = 0;
  for (const [section, entries] of Object.entries(session.sections)) {
    const type = SECTION_TYPES[section];
    if (!type) continue;
    for (const raw of entries) {
      const content = parseObservationAnnotations(raw).content;
      if (!content) continue;
      observations += 1;
      byType[type] += 1;
      rawSessionTokens += estimateTokens(content);
    }
  }
  return { observations, byType, rawSessionTokens };
}
