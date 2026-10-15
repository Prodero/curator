# Migration Foundation

## Audit and reused mechanisms

Before this change, `core/migrations.ts` provided ordered project migrations 1→5,
canonical validation, backups, a recovery journal, cache invalidation, and rollback.
`storage.ts` rejected newer project schemas, checked paths/symlinks, and wrote files
with same-directory rename. `sync-transaction.ts` provided a shared process lock,
stale-owner recovery, and a separate Sync preimage journal. Initialization and Prepare
automatically migrated. Open loaded memory without first presenting compatibility.
MemoryIndex, session index and graph have disposable cache formats; config uses a
passthrough validator. MCP UI and text already share presentation contracts.

This extends that migration engine; there is no second conversion or lock system.

## Versions and registries

`.prodero/config.json` is authoritative: `schemaVersion` describes project structure;
`knowledgeSchemaVersion` describes canonical knowledge. Missing knowledge version
means legacy format 1. Runtime targets come from `prodero.release.json`.
Project transition 5→6 only records knowledge version 1. It preserves record bytes.
The project bump also fences older, pre-foundation runtimes supporting only schema 5.
No sessions/skills/config version axes are introduced.
Project transition 6→7 refreshes the managed AGENTS.md block for text-only skill
execution. Open/Prepare use the existing update review. The migration snapshots
AGENTS.md, preserves text outside the managed block, commits it before the project
version, and restores it on failure without overwriting concurrent user edits.
Project transition 7→8 replaces the embedded block with a three-line reference to
`prodero_instructions_read`. This text-only MCP tool reads `instructions/AGENTS.md`
from its own installation, so dev/package switching needs no project edits. This is a one-time
project migration using the same approval, backup and rollback flow. Subsequent
instruction-only updates replace the packaged document and need no project schema
bump or edits to consumer repositories. Project/knowledge format changes still
require migrations.

`MIGRATIONS` and `KNOWLEDGE_MIGRATIONS` contain adjacent transitions. Descriptors
carry class, description, affected stores, transform and optional validation.
Classes are structural, compatible-semantic and review-required. The latter is
blocked until a migration-specific review resolver exists; `approved:true` never
substitutes for semantic decisions. The knowledge registry contains the ordered compatible-semantic `knowledge-policy-1-2` and `knowledge-applicability-2-3` transitions. The current target is knowledge schema 3; see [Knowledge Schema v2](KNOWLEDGE-SCHEMA-V2.md) and [Applicability](APPLICABILITY.md).

## Planning, approval and continuation

`planProjectMigration` reads metadata without creating directories, sessions, caches
or recovering journals. It reports targets, ordered steps, backup policy, safety,
review/block state, runtime identity and a metadata/registry plan hash.
`applyProjectMigration` requires explicit approval bound to that plan; it rechecks
under the shared writer lock. Current projects are idempotent no-ops.

Open, lightweight/detailed status and Prepare inspect this plan before reading
canonical knowledge. Current projects have no migration controls. Other states use
one Core plan and one view-model in UI/text. `prodero_migrate` is also exposed through
`prodero_text`. CLI `migrate status` plans; `migrate` is explicit approval to update
(or restore an interrupted update). Review-required steps remain blocked.

An interrupted Prepare returns a resumable request containing its exact original
arguments. Migration preserves this request. The App invokes the actual original
tool after success; text agents can immediately invoke the returned request. This
is not a durable host task scheduler: following a client restart, the agent must use
the model-visible request. No session is created before compatibility is resolved.

## Transaction and recovery

The existing shared lock excludes Sync/session/migration writers. A validated full
backup includes config, indexes, both knowledge layers, archives, sessions, skills
and checkpoints. Backups are outside disposable caches. A journal references the
backup, its integrity digest and diagnostic history before transformation begins.
Transforms and each transition's validation run in a separate staged project.

Derived indexes are rebuilt against the target schema in staging. Commit installs
canonical data and rebuilt indexes using atomic individual file replacements under
the journal/read fence, then writes the new version last. Disposable cache stamps
are revalidated by the usual loaders at their installed paths. This is a recoverable
logical transaction, not an operating-system atomic directory swap. Failure restores
the validated backup and invalidates derived caches. Interrupted transactions roll
back deterministically before a new attempt. Backup corruption blocks recovery;
Prodero never guesses missing preimages. Legacy v1 journals remain recoverable.
Partial backup creation cannot change canonical data; orphan backups may be retained.
History under `.prodero/.migrations` records IDs, versions, runtime, times, status and
backup reference. These ignored diagnostic files are not schema authority.

## Knowledge format 2

Phase 1A registers knowledge 1→2 and makes explicit policy and conservative authority
canonical. Existing instruction behavior is preserved mechanically. See
[Knowledge Schema v2](KNOWLEDGE-SCHEMA-V2.md) for the schema and trust boundary.
Foundation runtimes reject newer knowledge versions at the common storage barrier;
pre-foundation runtimes reject project schema 6. UI metadata diagnostics remain
available without interpreting newer knowledge. Direct low-level serializers are
not project-bound storage APIs.

## Boundaries

Recovery is rollback-and-retry, not arbitrary user rollback after later writes.
Backups are local recovery copies, not an off-machine disaster-recovery service.
No power-loss/fsync durability guarantee beyond the existing filesystem primitives
is added. External tools editing `.prodero` outside Prodero's lock are unsupported.
No global project registry, bulk migration or backup retention policy is provided.
Migration review is distinct from the curation review workflow.
