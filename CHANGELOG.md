# Changelog

## 0.3.0 — 2026-11-09 (Public Preview)

- Updated MCP SDK to 1.32.2, refreshed compatible production dependency patches, and migrated validators to Zod 4.6.7. Bounded collections now reject oversized input before walking elements; provider/plugin JSON Schema and legacy input defaults/receipts retain their validation contracts.

- Open navigation preserves filtered catalogue pages on detail return, reports Initialize failures truthfully, clears completed sharing selections and retains confirmed Apply receipts across refresh errors. Unavailable/cached catalogues are explicit and cannot masquerade as empty current data.

- Compact text Open now shows branch lines with total/Local/Versioned memory and actual bootstrap instruction counts. Four stable numbered actions support natural-language requests and clearly distinguish legacy instruction refinement from sharing memory via Git.

- Installation examples now follow npm `@latest`; the agent resolves and reviews one exact release before installing, so the stable prompt needs no version edit on future releases.
- Added an optional prompt-assisted installation guide, with current-stable wizard fallback and a landing Copy prompt publication handoff. Manual npm/CLI installation remains supported.
- Added explicit one-host installation preview/apply for agents, reusing existing native configuration ownership, backups and recovery. Saved configuration and pending restart/connectivity remain distinct.
- Added an approved prerequisite preparation path to the installation guide, preserving existing runtime versions/defaults and separating project initialization.
- Retained explicit Curate Memory and selected Local → Versioned actions in both interfaces, with fresh current previews isolated from unavailable historical reviews and unchanged approval guards.
- Close always returns a confirmed, visible final receipt, including zero observations, replay, deferred saving and diagnostic failures.
- Removed the old routine memory moderation queues, cards and attention prompts from text/visual interfaces; CLI status keeps maintenance diagnostics in explicit JSON rather than nagging counters.
- Bounded current-session agent reconciliation reuses semantic validation and transactional history for eligible Local knowledge. Protected, ambiguous and unsupported changes preserve originals; no new external provider is required.
- MCP chat text now uses native Markdown: a small ›_ prodero launch mark, factual project overview, named actions and brief unbranded task/save updates. Terminal CLI/explicit ASCII fallback and visual App contracts remain separate.

Project schema remains **8** and knowledge schema remains **3**; no canonical schema migration is added. See [compatibility and verification](docs/COMPATIBILITY.md) for the tested artifact and host coverage.

## 0.2.1 — 2026-10-25 (Public Preview)

- Corrected public documentation and release wording, including installation and compatibility guidance.
- Documented the built-in updater's npm **10.9.x** requirement.
- Replaced the outdated overview screenshot with the current **Curate Memory** interface using demonstration project data.

This is a documentation-only patch. Application behavior and project/knowledge schemas are unchanged. Users already running 0.2.0 do not need an urgent upgrade.

## 0.2.0 — 2026-10-25 (Public Preview)

- **Curate Memory** replaces the Memory Sync user-facing name, with existing MCP tool IDs and saved workflows retained. Retry/expired analysis, saved answers, deferred questions and Revisit resume reliably; partial progress and remaining work stay visible.
- Text mode uses the shared Telemetry/Pulse layout with letter-bound knowledge entries, exact numeric actions, complete review bodies and mobile-width output. Prepare continues automatically; Prepare/Close retain a compact fallback when an App is invisible, without repeating Core calls.
- **CLI compatibility:** `prodero status` now returns readable text by default. Scripts must pass `--json`; scope, failure exit codes and safe diagnostics remain explicit.
- Theme and mode changes write ignored checkout-local preferences rather than shared project config. Shared context settings stay versioned. Older v0.1 runtimes ignore local preferences and can still write legacy shared presentation settings; no automatic shared-config cleanup is performed.
- Terminal-only `prodero update [VERSION]` verifies an ordinary npm installation and exact target, asks users to close hosts and confirm, waits for npm and verifies the installed CLI. Non-TTY installation requires an exact version plus `--yes`. No automatic host shutdown or atomic rollback. MCP/App update actions provide terminal instructions only; package update and approved project migration remain separate.
- Valid legacy links are preserved across current/archive storage and repair previews; the disposable graph cache is rebuilt at format 2. Missing-target removal retains exact approval, stale-preview and recovery guards. Existing canonical legacy IDs are accepted by Remember/relationships/Local Forget and promotion selectors without changing supersession history or path safety. Versioned retirement still requires reviewed repository maintenance with the current revision.
- Procedural intent gates skill selection so a project name alone does not pull an installer into unrelated context. Skill Preview/Review honor effective local/shared/invocation presentation, retain complete drafts and identify create/update/covered and the exact target before consent. Explicit skill creation and inferred candidates keep their existing distinct workflows.
- The generated runtime guide is shorter and restores bundle-only read-only handling, last-resort file fallback, readiness/migration/resume and lifecycle rules. It separates Curator tools' Git behavior from the coding agent's current user authorization and host approval controls.
- Incomplete provenance diagnostics no longer imply proven loss of history; no provenance backfill or canonical storage redesign is included.
- Session writers serialize lock acquisition, stale-owner recovery and release under the same transition guard, preventing a stale PID decision from deleting a successor's lock. Deterministic process barriers and acknowledgment-preservation stress regressions cover record/close concurrency; unknown owners and interrupted guards remain fail-closed.

Project schema remains **8** and knowledge schema remains **3**. This release adds no canonical schema migration. See [compatibility and verification](docs/COMPATIBILITY.md) for tested clients, platforms and the published package identity.

## 0.1.0 — 2026-10-15 (Public Preview)

- Host-scoped package/dev runtime switching with read-only previews, explicit manual-dev migration, format 1 receipt compatibility and transactional rollback.

- Persistent Local and Versioned Knowledge with shared lexical and scope-safe graph retrieval.
- Conversational remember, search, replacement and Local forget; session learning and consolidation.
- Knowledge Management App: filtering, inspection, revision-checked editing/retirement and reviewed Local promotion. Text fallback for hosts without Apps.
- Compact context preparation, project skills, plugin integration and existing theme choices.
- Storage validation, CRLF support, durable migration backups, disposable cache recovery, journaled Sync and cross-process session mutation protection.
- Local/Versioned Git boundary, conservative lifecycle secret screening and consistent path scopes.
- npm artifact installation, manual package-manager updates, explicit MCP roots and a clean artifact release gate.
- Interactive `prodero install` wizard with agent status, install/update selection, confirmation and readable results. Replaces install host arguments and `--all`; recognizes manual Codex `prodero-dev` connections without adding a duplicate server.

Historical release notes. Preview limitations and actual verification coverage are recorded in docs/COMPATIBILITY.md.
