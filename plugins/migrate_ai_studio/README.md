# AI Studio → Prodero

> v0.1: `reviewed`, `approvedPlanId` and skill activation selections are caller-supplied workflow safeguards, not proof of human consent. Import writes Git-shareable knowledge/skills, including candidate skills. Curator does not commit or push; review the repository diff before doing so.

This optional plugin distills durable engineering knowledge; it never copies a
legacy tree or modifies `.ai-studio/`. Remove this directory and restart to remove
its capabilities. Core has no special interpretation of the source system.

Open **Plugins → AI Studio Migration** in Prodero or call the generated
`prodero_plugin_migrate_ai_studio` tool. All stages are also available through
`prodero_plugin_action` with `pluginId: "migrate_ai_studio"`.

1. `detect`: cheap bounded metadata inventory, no model calls or writes.
2. `estimate`: the App's default opening action. It reads and hashes locally,
   reports the structured memory files selected for extraction, and makes no model
   call or filesystem write.
3. `audit`: locally parses structured `Decision`, `Reason`, `Impact`, `Constraint`,
   `Correction`, `Guard pattern`, `Workflow note`, and `Test-quality note` blocks
   from `.ai-studio/runtime/memory/`. Handoffs, epic runs, sessions, logs,
   transcripts, indexes, and unstructured execution history are excluded. The
   result opens directly as a reviewable plan without a model request or chat
   prompt. No filesystem writes.
   Optional `sourcePaths` (max 36) / `repositoryPaths` (max 16) narrow or deepen
   evidence. Defaults prioritize source areas, never semantic destinations.
4. `plan`: retained for optional advanced semantic integrations that explicitly
   request `audit` with `{semantic:true}` and have negotiated server-side MCP
   sampling. It is not used by the default App workflow.
5. `review`: submit `{plan, decisions:[{id,include,activateSkill}]}` with one
   decision per item. Conflicted/stale/uncertain/duplicate entries stay excluded.
   Skills default to candidates; only explicit human selection activates them.
6. `apply`: submit `{plan, approvedPlanId:plan.planId}` for the reviewed plan.
   Never approve skill activation on the user's behalf. Apply consumes the exact
   sealed content, performs no model call and rejects changed evidence/state.
7. `verify`: submit `{plan, receipt, semantic:true}`. Mechanical checks compare
   source/repository hashes, included item hashes, excluded IDs and unrelated
   canonical state. Optional LLM verification checks semantic quality again.

Plans and reports are portable versioned JSON returned by tools and exportable in
the App. Keep the reviewed plan to replay it. They are not hidden canonical memory
or required caches. Apply stores a receipt in the existing immutable checkpoint;
Semantic imports retain source file/line/hash provenance. Default local imports
use the source references only for preflight validation and persist only
plugin/version/plan provenance, so removing `.ai-studio/` later does not leave
dead source links in canonical knowledge. Local extraction also removes direct
`TASK-*` and `EPIC-*` identifiers and replaces `.ai-studio/...` paths with a
portable description before Review.

The App keeps the validated plan inside the MCP process. Review, Import, and
Verify submit only `planId` plus their small action-specific fields instead of
round-tripping the complete structured plan through the App bridge. Restarting
MCP deliberately expires an open Review and requires a fresh Audit.
The MCP App resource URI includes the plugin version so Codex cannot reuse a
stale cached migration interface after an upgrade.
Reapplying a committed plan returns the existing receipt. Same-boundary normalized
content is deduplicated, without overwriting existing knowledge. Existing dismissed
or candidate skills are never silently activated during deduplication. Knowledge
rules use Prodero's `instruction` category; AGENTS.md is never rewritten.

Apply uses Core's existing writer lock and recoverable checkpoint-last journal.
On interrupted application, retry after resolving any reported concurrent change;
the journal supports recovery. A changed project requires a new audit/review.
Verification reports later edits as changes rather than attributing causation.

Local extraction is bounded to 80KB of structured memory and 60 review items.
Large histories are skipped and never sent to a model. Streaming scoped digests cover eligible
source/repository files without retaining source contents in the plan. Sensitive paths, private
Curator runtime stores and Git-ignored files are outside external integrity scope; verification
does not claim that these excluded files are unchanged. See the integrity contract below.
The default audit reports zero model tokens. Optional semantic mode retains local
`ceil(UTF-8 bytes / 4)` estimates; monetary cost depends on the host model.
Uninspected/omitted coverage is explicit.
Symlinks and special files are rejected. Sensitive filenames, private keys, common
credential patterns and binary data are excluded before model calls. This is a
conservative secret detector, not proof that arbitrary text contains no secrets;
review remains necessary. Semantic validity also depends on the model and evidence.

Instructions live in `instructions/{audit,classify,migrate,verify}.md` because
judging durable truth, stale claims and reusable procedures is semantic work.
Code owns schemas, bounded reads, hashing, review consistency, destination validation and
writes. Default local extraction uses conservative label/text heuristics for category
and applicability. The optional semantic path uses the instruction contracts above;
neither path treats imperative wording as user authority.

No source deletion, remote distribution, marketplace, generic migration DSL or
migration of other agent systems is implemented.

## Integrity scope and limits (plugin 1.7.0)

Semantic ingestion and integrity hashing have different scopes. Semantic ingestion keeps its existing bounded source selection, text/binary/credential screening and exact evidence hashes. An explicitly imported legacy workspace may be Git-ignored; selected safe evidence from it can still be ingested and is independently revalidated on review/apply and verification.

External integrity digests cover the eligible `.ai-studio` tree and the remaining repository separately. They exclude the common Curator sensitive-path policy, private `.prodero` stores, Git metadata, dependencies/build/cache trees and explicit exclusions. Repository-root hashing excludes `.prodero` and `.ai-studio` (each has its own purpose-specific check). Git's `check-ignore --no-index` supplies repository, nested, info/exclude and global ignore semantics; matching files are excluded even if force-tracked. Ignored directories are pruned before traversal. No valid Git repository means there is no Git ignore scope; fixed and sensitive-path exclusions still apply. Git must be available; Git inspection errors fail closed rather than silently disabling ignore rules.

Core separately snapshots an allowlist of canonical Curator stores to detect concurrent changes and verify receipts: config/index, Versioned and Local memory/skills/archive, sessions and checkpoints. This bounded internal snapshot intentionally reads Git-ignored Local state; it does not hash reviews/reasoning, cache, transactions, backups, migration history or arbitrary additional stores or atomic `*.tmp-*` leftovers. It is not exposed as an external `files.snapshot` override.

Each digest/snapshot pass has hard ceilings: **20,000 files, 100,000,000 total bytes, depth 32** (root is depth 0), **40,000 examined directory entries**, and a **30-second deadline**. The count/byte limits reuse the former snapshot ceilings; depth/entry/time limits bound directory-heavy or slow work. Hashing streams in 64KiB chunks and checks stat identity/size/mtime/ctime before and after reads, plus directory metadata before/after traversal. Git input/output is bounded to 4MB/8MB per batch. Exceeding a limit, cancellation, unsupported entries or detected changes returns an error, never a successful partial digest. Narrow the actual tree or Git-ignore unnecessary generated artifacts, then rerun Audit; changing semantic selection alone does not increase integrity limits.

Limits apply to each pass, not to an entire multi-step workflow. A gather performs two external digests and one canonical snapshot, so at most 60,000 file hashes / 300MB are admitted across those passes; review/verify repeat their own bounded checks. Deadlines cancel Git subprocesses and file streams and are checked during traversal; a blocked OS metadata syscall cannot be forcibly interrupted. Filesystem checks detect observed drift, not an atomic snapshot of a concurrently edited whole repository.

Ordinary non-sensitive, non-ignored files outside the selected semantic evidence (including binary files and unselected legacy history) are intentionally hashed to detect unrelated edits; they are not sent to the model. Content-only credentials in otherwise ordinary filenames may be read for hashing: path screening is best-effort, and detecting arbitrary secrets would itself require reading the file. Git also consults its configuration/ignore metadata. Excluded files are not covered by integrity claims.

Digest format is `sha256-tree-v2`. Plans from plugin 1.6.0 or earlier require a new Audit/review; old whole-tree hashes are not compared as if they used this scope. Existing data/receipts are retained; older receipt verification may report scope differences. No source or user file is deleted or untracked.
