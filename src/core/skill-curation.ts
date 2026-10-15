import { readConfig } from './storage.js';
import { assertCompatibleProject } from "./storage.js";
import { assertNoSecrets } from "./secrets.js";
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { skillInputSchema, deterministicSkillDraft, candidateRevision, getProjectSkill, type ProjectSkill, type SkillInput } from './skills.js';
import { getContext } from './context.js';
import { readSession } from './sessions.js';
import { sessionCandidates } from './consolidation.js';
import { safeProjectPath } from './sync-transaction.js';
import { parseKnowledge } from './memory.js';
import { estimateTokens } from './telemetry.js';
import { tokens } from './matching.js';
import type { IntelligenceProvider } from './intelligence.js';

export const CURATION_LIMITS = Object.freeze({ inputTokens: 6500, outputTokens: 4000, outputBytes: 32000, skillTokens: 2500, observations: 4, sessionBytes: 64000, knowledge: 6, skills: 3, timeoutMs: 45000 });
const identifier = z.string().regex(/^[a-zA-Z0-9_-]+$/).max(200);
export const skillDispositionSchema = z.object({ action: z.enum(['create', 'update', 'covered', 'keep-separate']), targetSkillId: identifier.nullable() }).strict();
export type SkillDisposition = z.infer<typeof skillDispositionSchema>;
export const skillCurationOutputSchema = z.object({
  draft: skillInputSchema.omit({ content: true }).extend({ procedure: z.array(z.string().trim().min(1).max(4000)).min(1).max(24) }).strict(),
  disposition: skillDispositionSchema,
  reasoningSummary: z.string().trim().min(1).max(800),
  grounding: z.array(z.object({ field: z.string().regex(/^(title|description|scope|triggers\.\d+|procedure\.\d+)$/), sources: z.array(z.string().min(1).max(300)).min(1).max(8) }).strict()).min(3).max(60),
}).strict();
export interface CurationSource { id: string; title: string; content: string }
export interface SkillCurationInput {
  candidate: ProjectSkill;
  observations: CurationSource[];
  provenance: { sourceSessions: string[]; derivedFrom: string[] };
  knownReferences: string[];
  relatedKnowledge: CurationSource[];
  activeSkills: Array<CurationSource & { revision: string; scope: string; description: string; triggers: string[] }>;
  protectedConstraints: string[];
  truncated: boolean;
}

/** References are project-relative labels, not permission to read arbitrary files. */
export async function validateProjectReference(root: string, reference: string) {
  if (!reference || reference.includes('\\') || reference.includes('\0') || /[\r\n]/.test(reference) || path.isAbsolute(reference) || /^[a-z]+:/i.test(reference) || reference.split('/').includes('..')) throw new Error('Reference escapes project root');
  const realRoot = await fs.realpath(root);
  let cursor = realRoot;
  for (const part of reference.split('/')) {
    cursor = path.join(cursor, part);
    try {
      const real = await fs.realpath(cursor);
      if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error('Reference escapes project root');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
export async function validateSkillDraft(root: string, input: SkillInput, knownReferences?: string[]) {
  await assertCompatibleProject(root);
  assertNoSecrets(input);
  const draft = skillInputSchema.strict().parse(input);
  if (/^(?:[\\/]|[a-z]:[\\/])/i.test(draft.scope) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(draft.scope) || /[\0\r\n]/.test(draft.scope)) throw new Error('Invalid applicability scope');
  if (estimateTokens(JSON.stringify(draft)) > CURATION_LIMITS.skillTokens) throw new Error('Project Skill size limit exceeded');
  for (const ref of draft.references) {
    await validateProjectReference(root, ref);
    if (knownReferences && !knownReferences.includes(ref)) throw new Error(`Unknown reference: ${ref}`);
  }
  for (const id of draft.relatedKnowledge) {
    const target = await safeProjectPath(root, `memory/${id}.md`);
    const knowledge = parseKnowledge(await fs.readFile(target, 'utf8'), `${id}.md`, (await readConfig(root))?.knowledgeSchemaVersion);
    if (knowledge.id !== id || knowledge.status !== 'active') throw new Error(`Invalid related knowledge: ${id}`);
  }
  return draft;
}

export async function sourceObservations(root: string, skill: ProjectSkill): Promise<CurationSource[]> {
  await assertCompatibleProject(root);
  const result: CurationSource[] = [];
  for (const source of skill.derivedFrom.slice(0, CURATION_LIMITS.observations)) {
    const sessionId = source.split('#')[0];
    if (!/^sess_[a-zA-Z0-9_-]+$/.test(sessionId)) continue;
    const target = await safeProjectPath(root, `sessions/${sessionId}.md`);
    try {
      if ((await fs.stat(target)).size > CURATION_LIMITS.sessionBytes) continue;
      const observation = sessionCandidates(await readSession(root, sessionId)).find(o => o.derivedFrom === source);
      if (observation) result.push({ id: source, title: observation.title, content: observation.content });
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return result;
}

/** Recover original evidence for an explicitly requested re-curation; do not reset the active record. */
export async function originalSkillCandidate(root: string, skill: ProjectSkill): Promise<ProjectSkill> {
  await assertCompatibleProject(root);
  for (const source of skill.derivedFrom.slice(0, CURATION_LIMITS.observations)) {
    const id = source.split('#')[0];
    if (!/^sess_[a-zA-Z0-9_-]+$/.test(id)) continue;
    const target = await safeProjectPath(root, `sessions/${id}.md`);
    try {
      if ((await fs.stat(target)).size > CURATION_LIMITS.sessionBytes) continue;
      const observation = sessionCandidates(await readSession(root, id)).find(o => o.skill && o.derivedFrom === source);
      if (observation) return { ...skill, title: observation.title, description: observation.description ?? observation.title, scope: observation.scopeRef ?? 'project', triggers: observation.triggers ?? [], content: observation.content, references: [], relatedKnowledge: [] };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return skill;
}

export async function buildSkillCurationInput(root: string, skill: ProjectSkill): Promise<SkillCurationInput> {
  await assertCompatibleProject(root);
  const candidate = skill.status === 'active' ? await originalSkillCandidate(root, skill) : skill;
  const known = deterministicSkillDraft(candidate).references;
  for (const match of `${candidate.description} ${candidate.proposedReason ?? ''}`.match(/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+/g) ?? []) {
    const ref = match.replace(/[.,;]+$/, '');
    // Slash-separated prose such as "missing/invalid-cache" is not a file reference.
    if (/\.[a-z0-9]+$/i.test(ref) && !known.includes(ref)) known.push(ref);
  }
  // A file-shaped observation scope is evidence, not automatically applicability.
  if (/\.[a-z0-9]+$/i.test(candidate.scope) && !known.includes(candidate.scope)) known.push(candidate.scope);
  const knownReferences: string[] = [];
  for (const ref of known.slice(0, 30)) { await validateProjectReference(root, ref); knownReferences.push(ref); }
  const input: SkillCurationInput = {
    candidate, observations: [], provenance: { sourceSessions: candidate.sourceSessions.slice(0, 4), derivedFrom: candidate.derivedFrom.slice(0, 4) }, knownReferences,
    relatedKnowledge: [], activeSkills: [], protectedConstraints: safetyConstraints(candidate.content), truncated: false,
  };
  const fits = () => estimateTokens(JSON.stringify(input)) <= CURATION_LIMITS.inputTokens;
  if (!fits()) throw new Error('Candidate exceeds curation input limit');
  for (const observation of await sourceObservations(root, candidate)) {
    input.observations.push(observation);
    if (!fits()) { input.observations.pop(); input.truncated = true; }
  }
  // The existing context resolver owns ranking, metadata discovery and bounded body loading.
  const context = await getContext(root, `${candidate.title} ${candidate.description} ${candidate.triggers.join(' ')}`, { contextBudgetTokens: 2800, requiredContextBudgetTokens: 2000 });
  for (const item of [...context.required, ...context.relevant].slice(0, CURATION_LIMITS.knowledge)) {
    input.relatedKnowledge.push({ id: item.id, title: item.title, content: item.content });
    if (!fits()) { input.relatedKnowledge.pop(); input.truncated = true; }
  }
  const active = skill.status === 'active' ? [skill, ...context.skills.filter(s => s.id !== skill.id)] : context.skills;
  for (const selected of active.slice(0, CURATION_LIMITS.skills)) {
    const item = await getProjectSkill(root, selected.id);
    if (item.status !== 'active') continue;
    input.activeSkills.push({ id: item.id, title: item.title, content: item.content, scope: item.scope, description: item.description, triggers: item.triggers, revision: candidateRevision(item) });
    if (!fits()) { input.activeSkills.pop(); input.truncated = true; }
  }
  return input;
}

// Preserve explicit safety clauses verbatim while allowing surrounding procedure to be rewritten.
export function safetyConstraints(content: string) {
  return [...new Set(content.split(/\n|(?<=[.!?;])\s+/).map(s => s.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(s => /\b(?:never|do not|must not|without|only|unchanged|instead of|rather than|no leftover)\b/i.test(s)))];
}

export async function validateCurationOutput(root: string, raw: unknown, input: SkillCurationInput) {
  await assertCompatibleProject(root);
  const result = skillCurationOutputSchema.parse(raw);
  const { procedure, ...fields } = result.draft;
  const draft = await validateSkillDraft(root, { ...fields, content: procedure.map((step, i) => `${i + 1}. ${step}`).join('\n') }, input.knownReferences);
  if (input.knownReferences.some(r => !draft.references.includes(r))) throw new Error('Source reference was dropped');
  if (draft.relatedKnowledge.some(id => !input.relatedKnowledge.some(k => k.id === id))) throw new Error('Related knowledge outside supplied evidence');
  const target = result.disposition.targetSkillId;
  if (['update', 'covered'].includes(result.disposition.action) ? !input.activeSkills.some(s => s.id === target) : target !== null) throw new Error('Invalid overlapping skill target');
  const sources = new Map<string, string>();
  const evidenceSources: Array<CurationSource & { description?: string; scope?: string; triggers?: string[] }> = [input.candidate, ...input.observations, ...input.relatedKnowledge, ...input.activeSkills];
  for (const source of evidenceSources) {
    // Re-curation has original evidence and the approved revision under the same stable ID.
    const details = `${source.description ?? ''} ${source.scope ?? ''} ${(source.triggers ?? []).join(' ')}`;
    sources.set(source.id, `${sources.get(source.id) ?? ''} ${source.title} ${details} ${source.content}`);
  }
  const fieldsToGround = { title: draft.title, description: draft.description, scope: draft.scope, ...Object.fromEntries(draft.triggers.map((v, i) => [`triggers.${i}`, v])), ...Object.fromEntries(procedure.map((v, i) => [`procedure.${i}`, v])) };
  if (new Set(result.grounding.map(g => g.field)).size !== result.grounding.length || result.grounding.some(g => !(g.field in fieldsToGround))) throw new Error('Invalid grounding fields');
  for (const [field, value] of Object.entries(fieldsToGround)) {
    const evidence = result.grounding.find(g => g.field === field);
    if (!evidence || evidence.sources.some(id => !sources.has(id))) throw new Error(`Missing field evidence: ${field}`);
    const sourceText = evidence.sources.map(id => sources.get(id)).join(' ');
    const sourceTokens = tokens(sourceText.toLowerCase().replace(/[._/-]/g, ' '));
    const significant = [...tokens(value.toLowerCase().replace(/[._/-]/g, ' '))].filter(t => t.length > 3);
    if (significant.length && !significant.some(t => sourceTokens.has(t))) throw new Error(`Ungrounded field: ${field}`);
    const stem = (s: string) => s.toLowerCase().replace(/(?:ing|ed|es|s)$/, '');
    const vocabulary = new Set([...sourceTokens].map(stem));
    const connective = new Set('verify validate check inspect compare ensure confirm perform follow repeat use run preserve retain before after during when changing changes relevant required existing reusable procedure purpose scope references source evidence safely safe'.split(' ').map(stem));
    if (significant.some(t => !vocabulary.has(stem(t)) && !connective.has(stem(t)))) throw new Error(`Unsupported concept in ${field}`);
    // New paths/code identifiers or numeric conventions cannot be introduced in paraphrases.
    for (const literal of value.match(/`[^`]+`|\b\d+(?:\.\d+)+\b|[\w.]+\/[\w./-]+/g) ?? []) if (!sourceText.includes(literal.replace(/`/g, '')) && !sourceText.includes(literal)) throw new Error(`Unsupported literal: ${literal}`);
  }
  const overlapConstraints = result.disposition.action === 'update' ? safetyConstraints(input.activeSkills.find(s => s.id === target)!.content) : [];
  const normalized = (s: string) => s.replace(/\s+/g, ' ').trim();
  for (const constraint of [...input.protectedConstraints, ...overlapConstraints]) if (!normalized(draft.content).includes(normalized(constraint))) throw new Error('Safety constraint was not preserved');
  return { draft, disposition: result.disposition, reasoningSummary: result.reasoningSummary };
}

export async function curateProjectSkill(root: string, skill: ProjectSkill, provider: IntelligenceProvider) {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const input = await buildSkillCurationInput(root, skill);
    const response = await Promise.race([
      (assertNoSecrets(input), provider.curateSkill!(structuredClone(input), controller.signal)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Curation timeout')); }, CURATION_LIMITS.timeoutMs); }),
    ]);
    if (Buffer.byteLength(JSON.stringify(response.output) ?? '') > CURATION_LIMITS.outputBytes) throw new Error('Curation output limit');
    assertNoSecrets(response.output);
    const validated = await validateCurationOutput(root, response.output, input);
    const selectedTarget = input.activeSkills.find(s => s.id === validated.disposition.targetSkillId);
    if (skill.status === 'active' && (validated.disposition.action !== 'update' || selectedTarget?.id !== skill.id)) throw new Error('Active re-curation must propose updating this skill');
    return { ...validated, ...(selectedTarget ? { target: { id: selectedTarget.id, title: selectedTarget.title, revision: selectedTarget.revision } } : {}), mode: 'assisted' as const, relatedKnowledge: input.relatedKnowledge.filter(k => validated.draft.relatedKnowledge.includes(k.id)), notice: undefined };
  } catch {
    return { draft: deterministicSkillDraft(skill), mode: 'deterministic' as const, disposition: undefined, reasoningSummary: undefined, relatedKnowledge: [], notice: 'A curated draft could not be prepared safely. Review this source-based draft or use Edit.' };
  } finally { clearTimeout(timer); }
}
