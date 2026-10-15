# Knowledge Policy Schema v2

Historical schema reference. The current runtime extends this model with [Knowledge Schema v3 applicability](APPLICABILITY.md); authority and policy guarantees remain in force.

## Architecture and canonical format

This transition introduced knowledge schema 2 on project schema 6. Current targets in
`prodero.release.json` are project 8 and knowledge 3; project-local `.prodero/config.json` remains authoritative.
The adjacent `knowledge-policy-1-2` compatible-semantic transition is registered in
Core's existing migration engine. There is no separate conversion command or lock.

Canonical Markdown frontmatter now includes:

```yaml
version: 2
kind: knowledge
category: instruction
context_policy: relevant
authority: inferred
```

Category describes the
kind of knowledge. `context_policy: required` selects mandatory delivery when
applicable; `relevant` uses ordinary retrieval and does not mean unimportant.
Priority, critical status, scope and relevance score retain their existing meanings.
All categories support relevant. Only instruction supports required in this phase.
Decision/constraint/invariant required combinations are rejected, not auto-promoted.

Core uses `version`, `contextPolicy`, `authority`. Record version is an explicit
parser discriminator, not another independently evolving project version axis.
Malformed v2 records missing version/policy/authority fail validation; project-bound
readers also reject v1 records in projects declaring knowledge v2. Pure serializers
have no project identity. Project-bound storage operations retain the Foundation's
newer-project/newer-knowledge barrier.

## Authority and trust boundary

Authority values: `legacy_inherited`, `inferred`, `imported`, `explicit_user`,
`reviewed`. They classify the provenance basis of a policy, not confidence, priority,
or proof of authorization. Evidence stays in existing `evidence`, `sourceSessions`,
`derivedFrom` and relationship fields; no second evidence system was added.

No Phase 1A conversational, Sync or transformation writer grants explicit_user or
reviewed merely from agent assertions, user_instruction evidence, or publication
approval. Existing creation behavior uses inferred; imports use imported. Trusted
canonical input can represent stronger classifications, but consumers must not treat
that string as authenticated user intent. Phase 1B must establish the actual grant
boundary. Remember still creates required instructions as before, with conservative
inferred authority. This is intentional compatibility, not a completed safety model.

## Mechanical migration and recovery

Every canonical record in both memory layers and both monthly archives is converted,
including historical/disputed records. Instructions become required; every other
category becomes relevant, including critical decisions. All migrated authority is
legacy_inherited. No model, content heuristics, scope inference or reclassification
runs. Modern frontmatter receives only structural metadata; bodies and unrelated
metadata are preserved. Legacy unstructured Markdown receives canonical defaults
matching its compatibility reader. The converter checks complete parsed-record
identity apart from the schema discriminator. Checkpoint preimages remain historical
evidence, not live canonical records, and are not rewritten.

Foundation planning/approval, full backup, staging, validation, cache rebuild,
journal, config-last commit, history and rollback are reused. Versions advance only
after staged v2 validates. Recovery restores preimages then retries. Current checks
are no-ops. The release's previous Foundation runtime rejects knowledge 2 at storage;
pre-Foundation runtimes reject project 6. This cannot protect arbitrary external
editors that bypass Prodero's storage contract.

## Readers, writers, retrieval and contracts

The v1 compatibility reader alone derives policy from category. Normal v2 parsing
uses explicit metadata. The transitional draft creation adapter preserves existing
writer defaults until Phase 1B; its fallback never applies to parsed v2 records.
Render/read/edit/archive/publication preserve policy and authority. Same-category
replacements inherit source policy; mixed policies cannot be silently consolidated.
Instruction optimization groups by policy/authority as well as existing boundaries.

Prepare and Bootstrap share policy-based required applicability. Scope matching,
ranking, overflow, token budgets and item limits are unchanged. The Markdown router's
Required section now uses policy rather than global importance. Genuine instruction
category behavior remains in consolidation, protected merge checks, candidate
lifecycle, instruction editing/optimization, importer classification and category
filters. These are not globally replaced with policy checks.

MemoryIndex format 9 stores policy and authority, invalidating old disposable caches.
Canonical Markdown remains authoritative. Snapshot JSON retains canonical fields.
MCP exposes contextPolicy/authority on canonical records and summaries. The temporary
instruction `enforcement` alias is derived exclusively from contextPolicy; `kind`
continues to describe instruction category. Neither alias is canonical on disk.
Bootstrap's alias is required because that collection contains required records only.

Open/Prepare use the Foundation's temporary Knowledge update available view. The
same approved Core action is available through UI, chat/text and CLI; no shell is
needed. UI resumes the original tool call; text returns exact resumable arguments.
After migration normal views are unchanged; legacy authority is not added as a badge.
No new policy editor or promotion authorization surface is introduced.

## Validation evidence

Permanent tests use synthetic records plus focused round trips, malformed data, historical migration,
selectors, cache deletion/rebuild, maintenance, publication, replacement, text resume,
older-runtime barriers, failure injection and interrupted production migration.
Foundation tests continue to cover UI approval, progress/resume, newer project
schemas, plan immutability and ordered synthetic future migrations.

## Phase 1B escalation paths (historical Phase 1A audit)

These paths are now governed by [Knowledge authority](KNOWLEDGE-AUTHORITY.md).
The following describes the Phase 1A baseline, not current runtime permissions.

The following still require authority/intent enforcement, intentionally unchanged:

- Remember `kind: rule` and replacements: agent-supplied assertions of user intent.
- Session observations with `categoryHint: instruction` and deterministic Sync.
- Assisted distillation/reconciliation and audit-created instruction candidates.
- Memory Transformation/lifecycle creation that changes category into instruction.
- Import source classification (including must/should/use/run rules) and apply paths.
- Trusted direct Core draft writers, canonical manual edits, and future promotion APIs.
- Policy changes across explicit supersession/reclassification boundaries; publication
  approval must remain distinct from approval to establish mandatory authority.

Global instruction candidates remain pending, and skill/instruction candidate review
retains its current checks. Phase 1A adds metadata preservation, not a claim that all
escalation routes are authorized. No applicability redesign, corpus cleanup, lexical
reclassification, new required categories, budgets/item-limit changes, evidence
verification, policy editor or complete authorization system is included.

## Implementation map

- `core/knowledge-policy.ts`: supported combinations, strict policy validation,
  compatibility draft adapter and policy-preserving replacement helper.
- `core/knowledge-migration.ts`, `core/migrations.ts`: production registry step,
  current/archive traversal and mechanical equivalence validation.
- `core/memory.ts`, `core/types.ts`, `core/memory-index.ts`: canonical persistence,
  compatibility parsing, shared model and disposable index format 9.
- `core/bootstrap.ts`, `core/context.ts`, `core/index.ts`: mandatory selection and
  Required router labeling. No selection caps or applicability changes.
- `core/consolidation.ts`, `core/knowledge-engine.ts`, `core/knowledge-lifecycle.ts`,
  `core/promotion.ts`, `core/instruction-review.ts`: writer/merge preservation.
- `core/imports.ts`: explicit imported classification with existing category logic.
- `core/knowledge-provenance.ts`, `core/memory-transformation-bundle.ts`,
  `core/skill-curation.ts`, `core/sync-transaction.ts`: project-aware validation at
  additional read/write boundaries.
- `test/knowledge-policy-v2.test.mjs`: focused production migration and v2 regressions.
  Existing migration, project, scope and update tests use explicit format fixtures.

All paths above are relative to `src/` except the test path. The existing MCP server,
presentation model, UI handlers and CLI migration actions delegate to the same Core
engine; Phase 1A does not fork those implementations.
