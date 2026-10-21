# Storage recovery

Canonical knowledge, sessions, skills and checkpoints are durable project data. Normal learning and inferred proposals remain in ignored storage; the promotion review workflow writes Git-shareable Versioned Knowledge. Review/approval is a workflow safeguard, not human authentication; Curator does not commit or push. See [Privacy](PRIVACY.md).

| Location | Role | Safe to delete as cache? |
| --- | --- | --- |
| `.prodero/memory/`, `local/memory/`, `sessions/`, `skills/`, `local/skills/`, `checkpoints/`, `config.json` | Canonical data | No |
| `.prodero/.cache/` | Rebuildable memory/session indexes and graph | Yes, after old-runtime migration backups have been relocated as described below |
| `.prodero/index.md`, `local/index.md` | Generated routers | Rebuildable; root router may include Local skill metadata. This repository ignores it; inspect other projects before sharing |
| `.prodero/.transactions/` | Writer lock, pending Sync/migration journal | No |
| `.prodero/.backups/` | Migration recovery snapshots, excluded by root rules and its own `.gitignore` | No |
| `.prodero/.migrations/` | Migration history, excluded by root rules and its own `.gitignore` | No |

A clone or worktree normally has no ignored `local/` or `.cache/`. Prodero recreates missing runtime directories without rewriting tracked placeholders. It does not reconstruct lost Local Knowledge: deleting `local/` from an existing working tree deletes canonical local data, not a cache.

Runtime setup also upgrades missing Git-ignore rules in existing projects before new runtime writes. Sessions/checkpoints are excluded by directory contents, not filename extensions, while their root `.gitkeep` placeholders remain trackable. Atomic and interrupted-write remnants stay ignored, including `*.tmp-*` beside Versioned files. This does not delete recovery artifacts, change atomic-write/recovery behavior, or untrack existing user files.

## Invalid canonical files

LF and CRLF are supported. Modern knowledge, session and skill metadata is validated, including IDs, lifecycle state and timestamps. Unknown statuses, stripped modern metadata, invalid configuration and malformed checkpoints produce file-oriented diagnostics instead of active defaults. Deliberately supported legacy Markdown remains readable; old date-ID `checkpoint-ready` sessions are recognized explicitly. Files are not silently repaired or rewritten merely because they were read.

Correct a damaged canonical file from Git or a known backup after stopping writers. Do not remove it as a cache fix. Prodero rejects symlinks in its storage paths and IDs that could escape their directory; replace unintended links with the intended ordinary directories only after inspecting them.

## Interrupted Sync

Both deterministic and assisted Sync validate a complete write plan, persist `.transactions/pending.json`, then apply atomic file replacements with the immutable checkpoint last. The next Sync recovers that journal before processing more evidence. `prepare` runs this recovery through automatic Sync. A crash after the checkpoint but before journal cleanup is also recoverable and does not process the same snapshot twice.

To recover, keep `.transactions/` and canonical files intact, stop competing writers, and run `prodero sync-sessions --root=/absolute/project` or ask the agent to prepare the project. Missing or structurally invalid cache entries rebuild from canonical data. Deleting `.cache/` does not delete the Sync journal.

If a canonical file was independently edited after the journal was prepared, recovery stops with the affected path and preserves the journal. Inspect the file and its journal before/after hashes; restore the intended preimage or already-applied result before retrying. Never discard the journal merely to clear an error.

## Interrupted migration

Migrations use the same per-worktree writer exclusion as Sync and session writes. All supported migration steps and canonical input are checked before applying a migration; each attempt has a complete recovery snapshot. The schema is written only after the steps, post-validation and cache invalidation succeed.

Backups now live under `.prodero/.backups/schema-<version>-<id>/`. Existing `.cache/migration-backups/` from older runtimes are relocated into `.backups/legacy-cache-<id>/` when initialization/preparation/migration next accesses the project. Run one of those operations with the hardened runtime before deleting an old runtime's cache if it contains recovery backups.

A failed migration restores its snapshot and reports its backup path. A process interruption retains `.transactions/migration.json`. Open and Prepare present a recovery action before normal work. Approving recovery restores the snapshot; the next plan offers the update again. Explicit CLI initialization retains its legacy recovery behavior. This also handles a rollback interrupted while restoring `config.json`. New session writes fail explicitly while a migration recovery journal remains, so a later rollback cannot erase an acknowledged observation.

If automatic restoration fails, stop all Prodero writers and retain both the journal and its referenced backup. Restore the snapshot's `config.json`, `index.md`, `memory/`, `local/`, `sessions/`, `skills/`, `archive/` and `checkpoints/` together, preserving their original presence/absence. Do not mix snapshots. Verify the result before clearing the migration marker and retrying. Never copy an uninspected or symlinked backup over project data.

## Concurrency and limits

Session creation, record and close share a filesystem lock across processes. Session mutations wait up to five seconds for a writer; a timeout reports failure, never success. Acknowledged observations remain in the file, and a closed session cannot be reopened by a late record. An empty repeated close remains successful; repeated close with nonempty final entries is explicitly rejected, so callers should inspect the session after an uncertain response rather than replay that final batch blindly.

A dead PID owner can be reclaimed. Acquisition, owner publication, stale-owner inspection/removal and release share the short-lived `.transactions/lock-recovery` transition guard; the canonical operation runs outside that guard while retaining its writer lock. Release waits independently for up to five seconds for the guard and reports failure if cleanup cannot complete, rather than acknowledging success with an uncertain release.

An ownerless/invalid lock or interrupted lock-recovery guard fails conservatively: after stopping all writers, inspect `.transactions/lock` and `.transactions/lock-recovery` before removing stale lock directories. PID reuse is intentionally handled conservatively rather than risking deletion of a live owner's lock. Do not remove the guard while a writer or recovery contender remains active.

These guarantees are verified with local filesystem process-crash, injected I/O-error and multiprocess tests. They do not provide a multi-file snapshot to unrelated readers while a journal is being applied, nor protection against hostile processes replacing the directory topology during filesystem operations. Network filesystems and sudden hardware/power loss have not been certified. Do not edit storage concurrently with migration/recovery.

Migration Foundation adds independent knowledge compatibility, staged transforms, backup integrity, diagnostic history and resumable Open/Prepare actions. See [Migration Foundation](MIGRATIONS.md).

### Private recovery permissions

On POSIX platforms, new migration backups, staging trees, history, transaction journals and locks use owner-only directories (`0700`) and files (`0600`), including interrupted-write artifacts. Runtime setup tightens existing private store roots without recursively chmod-ing their children; existing files are tightened when checked/accessed or replaced. Do not interpret this as a historical cleanup or ACL audit. Symlinks, multiply linked files and another owner's data are not permission-repair targets.

Migration backups preserve shared-file mode metadata separately from their private content copies. Successful commits preserve existing shared target modes; rollback restores saved shared modes (older backups use their original source modes). Versioned stores are not made private merely because they passed through staging. Curation simulations live beneath the private, ignored `.cache` tree and are removed by the normal simulation cleanup. Windows uses native ACL behavior rather than POSIX chmod.
