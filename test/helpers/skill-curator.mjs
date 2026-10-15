// Deterministic contract double; never represented as real-model dogfooding.
export function curationResponse(input, edits = {}) {
  const { content, ...candidate } = input.candidate;
  const draft = {
    title: candidate.title, description: candidate.description, scope: candidate.scope,
    triggers: candidate.triggers, references: input.knownReferences, relatedKnowledge: [],
    procedure: content.split('\n').filter(Boolean).map(line => line.replace(/^\d+[.)]\s*/, '')),
    ...edits,
  };
  const fields = ['title', 'description', 'scope', ...draft.triggers.map((_, i) => `triggers.${i}`), ...draft.procedure.map((_, i) => `procedure.${i}`)];
  return { draft, disposition: { action: input.candidate.status === 'active' ? 'update' : 'create', targetSkillId: input.candidate.status === 'active' ? input.candidate.id : null }, reasoningSummary: 'Separate evidence from applicability and retain the safety constraints.', grounding: fields.map(field => ({ field, sources: [input.candidate.id, ...input.relatedKnowledge.slice(0, 4).map(k => k.id), ...input.activeSkills.slice(0, 3).map(k => k.id)].filter((v, i, a) => a.indexOf(v) === i) })) };
}
