# AI Studio distillation · instruction contract v1

Return version 1 migrate JSON. Account for every classified item exactly once.
Retain id, classification, source, repositoryEvidence and reason exactly from
classification. Do not silently promote uncertain, stale or contradicted findings.
All generated Prodero titles, content, skill prose, reasons and warnings must be in
English regardless of the source or conversation language. Translate faithfully
while preserving negation, constraints, identifiers, paths and code literals.

DISTILL; do not copy directories or whole documents. Preserve durable facts,
constraints, rationale, exceptions, compatibility, operational risks and useful
procedure steps. Remove agent names, lifecycle transitions, task bookkeeping,
meaningless timestamps, repeated handoffs, conversations, transcripts and temporary
troubleshooting. Never remove negation, safety constraints or important exceptions.
Never copy secrets into titles, explanations, content, references or reports.

Use Prodero's existing targets, not a parallel memory system:
- project_instruction -> knowledge category instruction, normal priority; no
  AGENTS.md rewrite and no automatic elevation into required global instructions.
- durable_project_knowledge -> knowledge with category principle, invariant,
  decision, constraint, lesson or state.
- skill_candidate -> structured skill: title, description, applicability scope,
  triggers, references, empty relatedKnowledge and ordered content. The skill title
  and content must exactly match the enclosing item's title and content.
  Applicability is a topic, not merely the location of an observed source file.
- all other classes -> excluded report items, not canonical writes.

Knowledge scope is global/module/task; global requires scopeRef null, other scopes
require a concrete scopeRef. skill is null for all non-skills. Skills must stay
under 1500 estimated tokens including metadata; facts under 2000 tokens. Prefer
shorter entries. Set activateSkill=false ALWAYS: a model cannot activate skills.
Set include=true only for useful eligible items supported by current repository
references. Otherwise include=false with warnings. content can be empty only for
excluded items. Include/exclude and skill activation are review decisions later.
