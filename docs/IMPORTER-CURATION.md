# Importer v2 and legacy curation

> v0.1 contract: Local/Versioned describe Git storage and sharing, not a security boundary against the connected agent. Review and approval are workflow safeguards, not authenticated human consent. The agent may create, promote and maintain Versioned files. Curator does not commit or push; users review repository changes before doing so. See [Privacy](PRIVACY.md).

## Existing architecture and root cause

The optional `plugins/migrate_ai_studio/index.cjs` importer gathers bounded source
and repository evidence, seals a project-bound plan, reviews inclusion as one batch,
then delegates canonical writes to Core `imports.ts`. Checkpoint receipts provide
exact replay, before-state fingerprints, and verification. Source files are never
rewritten. Semantic mode already has bounded evidence validation and exclusions.

Previously `durableSections` concatenated Decision, Impact, Constraint and Workflow
Note, matched must/should/never/always/required/keep/use/run/do not/cannot in Decision,
and assigned instruction/global. Before explicit policy this implied Required.
After Phase 1B Core prevents required/imported creation, but the plugin still had
poor category/granularity and global projections. Titles used the first sentence
of Decision. Literal portable-prose sanitization replaces task IDs and legacy
workspace paths; source evidence must retain the original reference.

## Importer implementation

`knowledge-analysis.ts` is a deterministic proposal service exposed through the
existing plugin context. It uses the Phase 2 Task Context/applicability APIs, not a
new evaluator. Explicit source labels, normative meaning, transient-state markers,
paths, leading named topics and activity evidence guide classification. Decision
labels do not override clear normative meaning; imperative words never authorize
mandatory delivery. It supports existing canonical categories only. Decision and
Impact remain cohesive; compatible normative Constraint stays attached. Workflow,
State and Lesson sections can split where lifecycle differs. Exact source slices
remain traceable. Oversized sections fail instead of being silently truncated.

All historical knowledge still passes Core import validation and the transaction
authority gate: Relevant/Imported, normal priority. The plugin cannot request
Required or explicit_user/reviewed. Source-derived scopes are unresolved or scoped;
there is no project-wide fallback. Historical state is retained. Prompt text is
additional guidance, never authorization.

The existing wire plan/receipt version remains compatible. The analysis engine is
versioned independently (`evidence-2`); existing plugin protocol identifiers remain
unchanged. New receipts retain source evidence. Re-audit checks original source
entry keys as well as decomposed child keys, so old receipts prevent unchanged
source re-import even after canonical editing or changed classification. New
receipt source ranges detect source updates and leave them excluded for review.
Old receipts without source positions cannot establish that an arbitrarily edited
or moved source entry is the same entry: that remains a limitation. Normal import
never rewrites legacy canonical knowledge. Exact content/applicability dedup still
runs in Core. Preview summarizes categories, Relevant/Required, scoped/unresolved
and per-record source details; selection is batch-oriented.

## Curation is not migration

`knowledge-curation.ts` uses a read-only MemoryCatalog (`persistCache:false`). It
analyzes active/disputed legacy Required records, excluding already curated
outputs, and returns a deterministic project/revision/engine/schema-bound plan.
No plan creation writes canonical files, indexes, archives, schema or history.
Current explicit_user/reviewed records are not cleanup targets, though their
conflicting evidence can place legacy sources in attention. Other authority and
relevant-only maintenance targets are deferred.

Proposals distinguish applicability narrowing, policy/category changes and
content decomposition. Legacy mandatory meaning is deliberately preserved unless
a separately identified workflow/history component is proposed as relevant.
Time-sensitive state, known contradiction relations, disputed records and possible
artifact-mirroring conflicts are attention items. Content alone does not establish
that a rule is obsolete. There is no LLM winner and no timestamp winner.

Every selected source is accounted for. Decomposition maps character ranges to
output IDs, retains source sessions/evidence and adds revision-qualified derivation.
No lexical paraphrase is considered a proof of clause preservation. Different or
incomparable applicability is not merged. The deterministic base analyzer keeps non-equivalent related records separate;
current bounded reasoning and clarification can refine review proposals.
This intentionally avoids conflating similar wording with equivalent protection.

## Review and application

A plan is not permission. `withTrustedKnowledgeBatch` extends the existing central
Phase 1B gate with invocation-local, exact-record/preimage/project authorization.
`curationReviewEntries` exposes the exact batch to a trusted adapter; serialized
plan IDs, confidence and approved booleans cannot mint the capability.

`applyKnowledgeCuration` supports selected safe groups, validates the plan and
selected source revisions, takes the existing writer lock, recovers a pending
journal and uses `commitSyncTransaction` in exact mode. New decomposition outputs
precede source retirement. Original bytes, exact plan/selection, unchanged IDs and
engine version are retained in the final checkpoint. Canonical parser validation
precedes commit; the existing journal supplies deterministic roll-forward after
interruption. Index rebuild follows commit and is retried after completed replay.
There is no new rollback engine: checkpoint preimages support diagnosis/restoration,
while automatic recovery uses the existing roll-forward contract. Unselected
attention records remain byte-for-byte unchanged. No source file is silently erased.

Stale selected sources fail with their ID. Core can apply an unaffected selected
group using its original plan; the MCP UI currently refreshes the whole fingerprint
and conservatively rejects stale plans. Core replay of the same reviewed selection
is idempotent. Review grants expire when their invocation completes.

## MCP, UI and text

`prodero_curation` provides plan/simulate/defer and remains available through
`prodero_text`. Graphical review now uses persistent server-owned snapshots,
staged Current/Suggested/Later decisions and a separate App-only apply tool.
The external `reviewCuration` startup callback is no longer required. The adapter
validates the entire plan under the writer lock before granting Core's exact-batch
permission. Text mode remains preview-only; legacy model-visible apply is closed.
See [App-first knowledge review](CURATION-APP-REVIEW.md) for protocol, retention,
replay, trust boundaries, compatibility and verification status.

Open may offer a non-blocking cleanup card; Prepare has no curation dependency.
Later persists a checkpoint tied to the exact recommendation, not a knowledge
record or policy rejection. Repeated Open suppresses unchanged deferred cards;
material canonical changes or a new analysis version can resurface them. Details
retain access. Analysis errors are caught by Open and do not block ordinary work.
No new recurring approval interaction is introduced.

## Simulation and metrics

Simulation copies canonical memory and skills plus the current config into an
isolated temporary repository, writes actual proposed Markdown, and runs the real
`prepareContext` entry point before and after. It does not call lifecycle Prepare,
Sync, simplify ranking or adjust budgets. Temporary stores are removed in finally.
Metrics include real estimated candidate/selected/omitted tokens and counts,
relevant item-limit omissions, total tokens, unknown required and readiness.

Two explicit modes distinguish **safe batch** (attention unchanged) from a
conditional **all proposals** scenario (attention outputs included for measurement
only, still requiring further review). The default UI simulates the safe batch.
The latter is not a prediction that attention has been resolved or approved.

Current targets are Knowledge Schema v3 and Project Schema v8; curation itself does not advance schema versions. Retrieval,
required/relevant item limits, skill limits and token budgets are unchanged.

## Limitations and scaling

Deterministic analysis makes zero model calls. Parsing/classification is linear in
source text; catalog/evidence grouping is in memory. Conflict cross-checking can
be quadratic in candidate count; optional expensive semantic work is not required
for project usability. This is not a complete semantic oracle: leading identifiers,
path-vs-domain boundaries, stale validity and complex conflicts can need refinement.
Current review supports bounded reasoning, clarification answers, deferral/reopening
and retry through the existing curation tools. This is not autonomous organization
cleanup, arbitrary rewriting or a new rollback UI.
