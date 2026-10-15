import {applicabilitySchema} from "./applicability.js";
import { assertNoSecrets } from "./secrets.js";
import { z } from 'zod';
import { estimateTokens } from './telemetry.js';
import type { AgentUsageTelemetry, KnowledgeItem } from './types.js';

/** Central limits are local estimates, never provider billing units. */
export const INTELLIGENCE_LIMITS = Object.freeze({
  distillInputTokens: 4_000, candidatesPerBatch: 12, observationsPerBatch: 12,
  relatedMemories: 12, reconcileInputTokens: 8_000,
  auditItems: 16, auditInputTokens: 12_000, auditTriggerItems: 3,
  outputTokens: 4_000, outputBytes: 32_000, timeoutMs: 45_000,
});
const text = z.string().trim().min(1);
const id = text.max(240);
export const canonicalProposalSchema = z.object({
  applicability:applicabilitySchema.optional(),
  title: text.max(200), content: text.max(8_000),
  category: z.enum(['principle', 'invariant', 'decision', 'constraint', 'lesson', 'state', 'instruction']),
  scope: z.enum(['global', 'module', 'task']), scopeRef: z.string().max(300).nullable(), scopeKind: z.enum(['path', 'topic']).optional(),
  priority: z.enum(['critical', 'important', 'normal', 'contextual']),
}).strict();
export const candidateSchema = canonicalProposalSchema.extend({
  id, kind: z.enum(['knowledge', 'skill_candidate', 'instruction_candidate']),
  sources: z.array(id).min(1).max(24),
  evidence: z.array(z.object({ source: id, quote: text.max(8_000) }).strict()).min(1).max(24),
  supersedes: z.array(id).max(12),
}).strict();
export const distillSchema = z.object({ candidates: z.array(candidateSchema).max(INTELLIGENCE_LIMITS.candidatesPerBatch) }).strict();
export const reconciliationCategorySchema = z.enum(['state_transition', 'refinement', 'duplicate', 'supporting', 'potential_conflict', 'unresolved', 'independent']);
export type ReconciliationCategory = z.infer<typeof reconciliationCategorySchema>;
export const actionSchema = z.object({
  action: z.enum(['CREATE', 'MERGE', 'SUPERSEDE', 'CONFLICT', 'NO_CHANGE', 'LINK', 'UNCERTAIN']),
  sources: z.array(id).min(1).max(16),
  canonical: canonicalProposalSchema.nullable(),
  reason: text.max(500),
  classification: reconciliationCategorySchema.optional(),
  // Optional for backward-compatible providers; required for inferred replacement.
  replacements: z.array(z.object({
    target: id, previousQuote: text.max(8_000), replacementQuote: text.max(8_000),
    transitionQuote: text.max(8_000), sameFact: z.literal(true), completeReplacement: z.literal(true),
    basis: z.literal('explicit_transition'),
  }).strict()).min(1).max(12).optional(),
}).strict();
export const reconcileSchema = z.object({ actions: z.array(actionSchema).min(1).max(1) }).strict();
export const auditSchema = z.object({
  status: z.enum(['clean', 'changes_proposed', 'uncertain']),
  issues: z.array(z.object({ kind: z.enum(['contradiction', 'duplicate', 'obsolete', 'unsafe_merge', 'fragmentation', 'constraint_loss', 'uncertain']), sources: z.array(id).min(1).max(16), reason: text.max(500) }).strict()).max(16),
  actions: z.array(actionSchema).max(16),
}).strict();
export type KnowledgeCandidate = z.infer<typeof candidateSchema>;
export type ProposedAction = z.infer<typeof actionSchema>;
export type CanonicalProposal = z.infer<typeof canonicalProposalSchema>;
export type Phase = 'distill' | 'reconcile' | 'audit';
export interface ObservationEvidence extends CanonicalProposal {
  id: string; sessionId: string; kind: KnowledgeCandidate['kind']; supersedes: string[];
}
export interface DistillInput { observations: ObservationEvidence[] }
export interface ReconcileInput { candidate: KnowledgeCandidate; related: KnowledgeItem[] }
/** Also serves as the future explicit Memory Area Audit boundary; no background sweep. */
export interface AuditInput { purpose?: 'instruction_optimization'; items: KnowledgeItem[]; changes: ProposedAction[]; evidence: ObservationEvidence[]; truncated: boolean }
export interface ProviderResponse { output: unknown; usage?: AgentUsageTelemetry }
export interface IntelligenceProvider {
  readonly name: string;
  curateSkill?(input: import("./skill-curation.js").SkillCurationInput, signal: AbortSignal): Promise<ProviderResponse>;
  polishSkill?(input: import("./skills.js").SkillInput, signal: AbortSignal): Promise<ProviderResponse>;
  distill(input: DistillInput, signal: AbortSignal): Promise<ProviderResponse>;
  reconcile(input: ReconcileInput, signal: AbortSignal): Promise<ProviderResponse>;
  audit(input: AuditInput, signal: AbortSignal): Promise<ProviderResponse>;
}
export interface IntelligenceTelemetry {
  mode: 'deterministic' | 'assisted'; provider: string | null; fallbackReason?: string;
  distillation: { calls: number; sessions: number; observations: number; candidates: number; inputTokens: number; outputTokens: number };
  reconciliation: { calls: number; comparisons: number; inputTokens: number; outputTokens: number; actions: Record<ProposedAction['action'], number> };
  audit: { triggered: boolean; items: number; truncated: boolean; issues: number; proposed: number; applied: number; inputTokens: number; outputTokens: number; status: 'skipped' | 'coherent' | 'attention' };
  providerUsage: AgentUsageTelemetry[];
}
export interface IntelligenceRecord { phase: Phase; action: string; sources: string[]; targets: string[]; reason: string; classification?: ReconciliationCategory }
export function intelligenceTelemetry(provider?: IntelligenceProvider, fallbackReason?: string): IntelligenceTelemetry {
  return { mode: provider ? 'assisted' : 'deterministic', provider: provider?.name ?? null, ...(fallbackReason ? { fallbackReason } : {}),
    distillation: { calls: 0, sessions: 0, observations: 0, candidates: 0, inputTokens: 0, outputTokens: 0 },
    reconciliation: { calls: 0, comparisons: 0, inputTokens: 0, outputTokens: 0, actions: { CREATE: 0, MERGE: 0, SUPERSEDE: 0, CONFLICT: 0, NO_CHANGE: 0, LINK: 0, UNCERTAIN: 0 } },
    audit: { triggered: false, items: 0, truncated: false, issues: 0, proposed: 0, applied: 0, inputTokens: 0, outputTokens: 0, status: 'skipped' }, providerUsage: [] };
}
export class IntelligenceError extends Error {
  constructor(readonly phase: Phase, detail: string) { super(`Knowledge engine ${phase} failed: ${detail}. No semantic plan was committed; sessions remain pending.`); }
}
export async function requestIntelligence<P extends Phase>(provider: IntelligenceProvider, phase: P, input: DistillInput | ReconcileInput | AuditInput, telemetry: IntelligenceTelemetry): Promise<unknown> {
  assertNoSecrets(input);
  const limit = phase === 'distill' ? INTELLIGENCE_LIMITS.distillInputTokens : phase === 'reconcile' ? INTELLIGENCE_LIMITS.reconcileInputTokens : INTELLIGENCE_LIMITS.auditInputTokens;
  const inputTokens = estimateTokens(JSON.stringify(input));
  if (inputTokens > limit) throw new IntelligenceError(phase, 'input budget exceeded');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      (provider[phase] as (input: any, signal: AbortSignal) => Promise<ProviderResponse>).call(provider, structuredClone(input), controller.signal),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('provider timed out')); }, INTELLIGENCE_LIMITS.timeoutMs); }),
    ]);
    assertNoSecrets(response.output);
    const encoded = JSON.stringify(response.output);
    if (!encoded || Buffer.byteLength(encoded) > INTELLIGENCE_LIMITS.outputBytes) throw new Error('output budget exceeded');
    const output = (phase === 'distill' ? distillSchema : phase === 'reconcile' ? reconcileSchema : auditSchema).parse(response.output);
    const target = phase === 'distill' ? telemetry.distillation : phase === 'reconcile' ? telemetry.reconciliation : telemetry.audit;
    target.inputTokens += inputTokens; target.outputTokens += estimateTokens(encoded);
    if ('calls' in target) target.calls++;
    if (response.usage) telemetry.providerUsage.push(response.usage);
    return output;
  } catch (error) { throw new IntelligenceError(phase, error instanceof z.ZodError ? 'invalid structured output' : 'provider failed or returned unsafe content'); }
  finally { clearTimeout(timer); }
}
