import { assertNoSecrets } from "./secrets.js";
import { skillInputSchema, type SkillInput } from './skills.js';
import { INTELLIGENCE_LIMITS, type IntelligenceProvider } from './intelligence.js';
import { evidenceSentences, exactKnowledge, semanticRisk } from './semantic-safety.js';
import { estimateTokens } from './telemetry.js';

/** Existing engine's extractive boundary: polish presentation, never manufacture rules. */
export async function polishSkillDraft(provider: IntelligenceProvider, source: SkillInput) {
  assertNoSecrets(source);
  const fallback = skillInputSchema.parse(source);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (estimateTokens(JSON.stringify(fallback)) > INTELLIGENCE_LIMITS.distillInputTokens) throw new Error('input budget');
    const response = await Promise.race([
      provider.polishSkill!(structuredClone(fallback), controller.signal),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, INTELLIGENCE_LIMITS.timeoutMs); }),
    ]);
    if (Buffer.byteLength(JSON.stringify(response.output) ?? '') > INTELLIGENCE_LIMITS.outputBytes) throw new Error('output budget');
    assertNoSecrets(response.output);
    const draft = skillInputSchema.strict().parse(response.output);
    // Titles may be shortened by selecting a contiguous phrase, with capitalization changes.
    // Purpose selects complete existing sentences. Procedure/order/constraints are retained.
    const allowedPurpose = new Set(evidenceSentences(fallback.description));
    if (!fallback.title.toLowerCase().includes(draft.title.toLowerCase()) || semanticRisk(fallback.title, draft.title) || semanticRisk(fallback.description, draft.description) ||
        !evidenceSentences(draft.description).every(s => allowedPurpose.has(s)) ||
        exactKnowledge(draft.content) !== exactKnowledge(fallback.content) ||
        draft.scope !== fallback.scope || JSON.stringify(draft.triggers) !== JSON.stringify(fallback.triggers) ||
        JSON.stringify(draft.references) !== JSON.stringify(fallback.references)) throw new Error('unsupported revision');
    return { draft, mode: 'assisted' as const };
  } catch {
    return { draft: fallback, mode: 'deterministic' as const, notice: 'Automatic polish was unavailable or could not preserve the evidence. Review this source-based draft, or use Edit.' };
  } finally { clearTimeout(timer); }
}
