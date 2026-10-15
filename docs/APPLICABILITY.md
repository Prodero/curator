# Applicability and task context

## 1. Previous scope model audit

The audit preceded implementation. The existing scope mechanism is extended; canonical knowledge, catalog, context engine and authority boundary remain the same.

| Area | Previous behavior and distinction | Implementation reference |
| --- | --- | --- |
| Markdown | `scope` (`global`, `module`, `task`), nullable `scope_ref` and optional `scope_kind` persisted. The public `project`/`path` names were adapters, not additional canonical scopes. | `src/core/memory.ts:29` |
| Paths | `scope_kind: path` made even a bare name such as `docs` a path. An untagged module reference containing `/` or `.` was interpreted as a path. Other module references were topics. Exact/descendant matching used relative paths; a bare directory in prose was not path evidence. | `src/core/path-scope.ts:4` |
| Required | Global was always applicable. Module topics used exact/prefix query matching; task scopes used token overlap. Paths used the path matcher. Policy, not category, already selected required records after explicit context policy was introduced. | `src/core/bootstrap.ts:18`; historical behavior now in `applicability.ts:123` |
| Relevant | Non-path scope used lexical ranking; path mismatch excluded records. Thus Required and Relevant did not have identical scope semantics. | `src/core/context.ts:108` |
| Remember | Public project/global both mapped to canonical global, but used priority to distinguish topic retrieval from global guidance. Path mapped to module + explicit path kind. | `src/core/project.ts:519` |
| Observations / Sync | Scope hints and section defaults supplied candidate boundaries. Deterministic consolidation, assisted validation and catalog neighbor discovery compared legacy scope fields. | `src/core/sessions.ts:165`, `consolidation.ts`, `knowledge-engine.ts:35`, `memory-index.ts` |
| Other writers | Imports mapped source scope; transformations and replacements inherited source metadata; publication copied canonical records. Maintenance exposed legacy scope fields. Their authority ceiling came from the knowledge authority transaction gate. | `imports.ts:100`, `knowledge-lifecycle.ts:167`, `promotion.ts`, `knowledge-management.ts`, `knowledge-write-policy.ts` |
| Presentation / cache | Catalog summaries carried scope fields. Prepare snapshots retained the result, Open had its own bootstrap selector, UI/text showed scope labels. | `memory-index.ts`, `context-snapshot.ts`, `bootstrap.ts:90`, `src/presentation.ts`, `src/ui/main.ts` |

The hidden conventions were path-shaped references, task token matching, topic matching that differed by retrieval bucket, and the public project/global priority mapping. `scope_kind` was optional canonical metadata, not evidence of user authorization.

## 2. Final canonical model and version decision

Knowledge Schema **3**, project schema **8** (see `prodero.release.json`). Knowledge applicability was introduced with the schema-6 migration foundation. The bump is necessary: a v2 reader/writer cannot preserve or enforce structured applicability. The existing Migration Foundation provides the compatibility barrier, planner, approval, staging, backup, validation, history and recovery. No parallel migration path exists.

The independent dimensions are:

- category: the kind of knowledge;
- context_policy: required or relevance-driven delivery;
- authority: provenance classification, not a capability;
- applicability: the conditions under which this knowledge applies;
- priority: importance, independent of scope;
- relevance: runtime task usefulness, not persisted policy.

Canonical frontmatter example:

```yaml
version: 3
context_policy: required
authority: legacy_inherited
applicability: {"kind":"scoped","subsystems":["ExampleAPI"],"taskKinds":["testing"]}
scope: module
scope_ref: ExampleAPI
scope_kind: topic
```

Supported applicability forms:

| Form | Meaning |
| --- | --- |
| `{kind: "project"}` | Applies throughout the project. |
| `{kind: "scoped", paths?, subsystems?, taskKinds?}` | At least one non-empty restriction. |
| `{kind: "unresolved"}` | Insufficient evidence to assign a work boundary. Ordinary relevant knowledge remains retrievable. No invented global assertion. Valid only for relevant records; required records must state a boundary. |
| `{kind: "legacy"}` | Preserve the exact existing scope/ref/kind behavior, including the old difference between Required and Relevant. Used by mechanical migration and compatibility adapters. |

For structured forms, scope/ref/kind are a deterministic compatibility projection, validated on read. They are not an independent second applicability source. Project projects to global; scoped uses its first path, otherwise first subsystem, otherwise task kinds. Legacy retains the original fields verbatim. Empty scoped metadata, missing v3 applicability, invalid paths or conflicting projection fail validation.

## 3. Combination and path semantics

Dimensions combine with **AND**; alternatives inside each array combine with **OR**. ExampleAPI + testing means both conditions, not either one. Multiple paths provide explicit alternative targets. Task kinds are implementation, testing, migration, deployment, documentation, review and debugging.

Paths are case-sensitive repository-relative exact/descendant boundaries. An optional terminal `/**` is supported; arbitrary wildcard expressions, absolute paths and parent traversal are not. There are no nested boolean expressions, negation or general policy language. Topics are case-insensitive subsystem labels.

## 4. Task Context and evidence

`buildTaskContext` runs once per context resolution. It carries task text, paths, subsystems, task kinds, a documentation-only focus and signal provenance. Optional MCP/Core `taskContext` accepts paths, subsystems, taskKinds and explicitTopics; agents supply these when known, not through user forms.

Evidence includes explicit arguments, quoted/path-shaped references, activity wording, known canonical subsystem labels, and technical identifiers. A known bare path supplied as the whole task is recognized. An incidental unfamiliar CamelCase identifier is only a hint: it cannot by itself prove that a different subsystem is excluded. An explicit or known-vocabulary subsystem can establish a different task focus. README/documentation wording does not count as implementation merely because it says “update”.

Prepare stores this context in its session. Observations may supply stronger work signals later. Explicitly retrying Prepare with the same session refreshes the context for future observations; already returned context snapshots are not mutated. No filesystem watcher, automatic repository-wide scan or hidden mid-turn context delivery is introduced.

## 5. Tri-state applicability and unknown required policies

The evaluator returns `applicable`, `not_applicable` or `unknown`, with reasons and matched dimensions. A known mismatch makes an AND expression not applicable; otherwise an unresolved dimension makes it unknown.

Required selection is policy → applicability → existing ranking/budget selection. Relevance cannot make a known applicable required policy optional. Existing token budgets, overflow behavior and item ceilings are unchanged.

For **structured required** knowledge:

- applicable enters Required candidates;
- not applicable is excluded from both delivery buckets;
- unknown does not silently disappear or become global. It produces `policyReadiness: {state: "context-needed", blocking: true}` and bounded diagnostic metadata. The agent enriches taskContext from actual work evidence and retries Prepare, preferably with the same session ID.

This readiness interruption is **not policy review or an approval request**. Required bodies are not all loaded to resolve uncertainty. If evidence genuinely remains unavailable, Core does not claim that work is ready; a host cannot safely guarantee automatic continuation. Unknown disputed required records receive the same protection. Explicit required conflicts keep the distinct existing `review-required` state.

Legacy records retain their old bucket behavior. In particular, a legacy scoped instruction that did not enter Required can still be retrieved through the historical relevant path. The migration does not reinterpret that behavior.

## 6. Relevant retrieval and explainability

Known unrelated paths/subsystems/activity exclude structured records. Matching dimensions contribute a relevance signal. Unknown relevant records can still match lexical evidence; a graph edge alone cannot admit unknown *restricted* scope with no lexical match. Unresolved ordinary knowledge can use normal lexical/graph retrieval because no specific boundary was asserted.

Selection metadata and snapshots retain applicability decisions. Knowledge Details can evaluate a supplied task. UI View Context and text Details show the human label and decision reasons: matched subsystem/task kind, paths outside a boundary, or missing signals with the expected boundary. Diagnostics are bounded; records outside that window remain inspectable through paginated Knowledge details. No permanent scope-management section was added to Open.

Open without a task loads project-wide required records and legacy global records. Scoped policies remain available to Prepare; bootstrap metrics include their count, without dumping their bodies or adding recurring controls.

## 7. Automatic creation and authority ceiling

Remember and ordinary session observations infer applicability from their content and producing task context. Paths and subsystem identifiers take precedence when present; otherwise session activity/context is used. With no justified restriction, relevant knowledge gets unresolved applicability. Explicit project/global input is still supported but no longer sets priority. Explicit path input produces structured path applicability.

The in-process invocation-local grant binds an exact operation; it does not authenticate a person. The current chat adapter can create that grant from model-supplied `required:true`, `kind:rule` and `userInstruction`, and the App adapter from validated review state. These are workflow safeguards under the [v0.1 trust model](PRIVACY.md). Ordinary inferred observations cannot directly set protected policy. Ambiguous inferred rules remain relevant/inferred.

Legacy scope hints on existing clients/observations remain compatibility inputs. They are not permission to widen protected knowledge. Global instruction candidates remain pending, and skill candidates keep their separate existing scope model.

`evaluateKnowledgeTransition` remains the central gate. Applicable boundary identity is now part of its trusted operation binding, protected-clause equivalence, source ceilings and replacement checks:

- inferred relevant records can narrow to a provable subset with existing provenance;
- path → project, subsystem → project, dropping a task restriction, or changing an authoritative boundary cannot happen through inference;
- authoritative narrowing is also protected against accidental de-escalation;
- invalid/ambiguous mutations preserve the original and use the existing safe-fallback/deferred-review behavior;
- a new inferred replacement cannot union incomparable source boundaries, and an uncovered source is not retired.

The subset proof is structural, not a claim that an LLM proved semantic equivalence. No new authorization mechanism or automatic promotions are introduced.

## 8. Writer and lifecycle coverage

| Path | Applicability behavior |
| --- | --- |
| Remember | Structured applicability or silent inference; replacement defaults to source applicability; policy remains governed by knowledge authority. |
| Session recording | Persists inferred applicability with each ordinary observation and keeps its existing session/observation provenance. Later explicit work signals can narrow new observations. |
| Session review | Preserves structured applicability on prose edits; legacy projection edits cannot silently change structured boundaries. Instruction/skill candidate transitions retain their separate lifecycle. |
| Deterministic Sync | Exact applicability is part of matching. Same content/same boundary deduplicates; overlapping or disjoint different boundaries stay separate. |
| Assisted Sync/audit | Canonical validation compares applicability with source boundaries after model output. Omitted optional fields inherit source metadata. Incompatible merges are rejected before canonical mutation. |
| Memory Transformation/lifecycle | Source applicability is inherited; proposals can carry structured metadata. Mixed-boundary consolidation preserves originals instead of creating a broader aggregate. Clean local operations remain automatic. |
| Imports | Explicit structural applicability or path/topic source metadata is preserved. Otherwise ordinary inference/unresolved fallback. New imported instructions remain relevant/imported. The keyword classifier is unchanged. |
| Replacement/supersession | Source ceiling and protected-clause checks include applicability. Incompatible retirement cannot erase the original boundary. |
| Publication | Canonical applicability is copied; matching/merge checks include it. Publication approval confers no policy/applicability authority. |
| Maintenance/optimization | Prose edits preserve applicability. Structured changes use the same central gate. Duplicate optimization groups include applicability, not only the first projected path/topic. |

## 9. Compatibility, migration, cache and presentation

Production registry step `knowledge-applicability-2-3` mechanically adds `{kind:"legacy"}` and changes record version. It preserves content, category, context policy, authority, lifecycle status, original scope, priority, provenance and relationships in both active and archive stores, Local and Versioned. It does not inspect bodies to infer a subsystem or task kind. Existing global records therefore retain their scope.

The Foundation performs read-only planning, explicit approved execution, backup, staged transform/validation, commit and derived rebuild with recovery/history. Schema advancement follows validated canonical migration. Open/Prepare automatically surface the existing migration card/text flow only when needed. Migration resume now carries taskContext as well as the original task and session. Older runtime capability blocks mutation before an old serializer can strip v3 metadata.

MemoryIndex format **10** stores applicability. Missing, malformed or projection-inconsistent v3 cache entries rebuild from canonical Markdown. Even the trusted low-level writer refuses unmigrated projects and incomplete explicit v3 records; it cannot silently substitute legacy applicability. Knowledge schema/version mismatches cannot be masked by a warm cache. Snapshots retain the resolved task and decision metadata. No independent index inference exists.

Normal UI still says Required, Relevant and Applies to. Scope details stay in View Context/Knowledge Details. Text mode uses the same Core state and migration actions. There are no new per-record review prompts or persistent pending-scope controls.

## 10. Acceptance fixtures and validation

Tests use synthetic records in temporary repositories, including scoped rules for documentation, implementation and testing.

Focused tests cover tri-state/AND/OR/multiple paths, strict round-trips, no-widening, inferred narrowing, same-session enrichment, required readiness/retry, unknown relevant retrieval, Open, Details, index rebuilding, silent ten-observation Sync, trusted rules, assisted Sync, imports, disjoint consolidation, mechanical migration/rollback/interruption, older-runtime mutation barriers and MCP UI/text parity. Existing tests additionally cover publication, maintenance, archive migration, backup failures, multi-step planning and UI migration/resume.

## 11. Limits and deferred work

- Inference is deterministic and deliberately limited. Subsystem aliases, repository ownership maps, multilingual classification and richer trusted touched-file integrations are not a general semantic classifier.
- Explicit/recognized task focus is treated as the work boundary. A host must enrich incomplete context honestly; simply inventing another subsystem to clear readiness is not supported use.
- A genuinely unknown required policy can block readiness until the agent resolves context. This is not a recurring approval workflow; perfect automatic resolution from arbitrary prose is not promised.
- The system conservatively keeps differing overlapping scopes separate rather than proving semantic union/equivalence.
- No nested predicates, negative clauses, arbitrary globs or task-kind hierarchy.
- Legacy compatibility behavior intentionally remains coarse. Current curation/import behavior is described in [Importer and curation](IMPORTER-CURATION.md); allocation is described in [Context Selection v2](CONTEXT-SELECTION-V2.md).
- Existing skills retain their own model; this phase versions knowledge only.
