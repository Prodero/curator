# Changelog

## 0.2.0 — Candidate (unreleased)

Candidate prepared 2026-10-20; no publication or release date is implied.

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

Project schema remains **8** and knowledge schema remains **3**. No canonical schema migration is added by this version bump. See [compatibility and evidence limits](docs/COMPATIBILITY.md) and [release gates](docs/RELEASING.md). Exact-commit remote CI and selected native-host acceptance remain required; this entry does not announce publication.

## 0.1.0 — Public Preview (unreleased)

- Host-scoped package/dev runtime switching with read-only previews, explicit manual-dev migration, format 1 receipt compatibility and transactional rollback.

- Persistent Local and Versioned Knowledge with shared lexical and scope-safe graph retrieval.
- Conversational remember, search, replacement and Local forget; session learning and consolidation.
- Knowledge Management App: filtering, inspection, revision-checked editing/retirement and reviewed Local promotion. Text fallback for hosts without Apps.
- Compact context preparation, project skills, plugin integration and existing theme choices.
- Storage validation, CRLF support, durable migration backups, disposable cache recovery, journaled Sync and cross-process session mutation protection.
- Local/Versioned Git boundary, conservative lifecycle secret screening and consistent path scopes.
- npm artifact installation, manual package-manager updates, explicit MCP roots and a clean artifact release gate.
- Interactive `prodero install` wizard with agent status, install/update selection, confirmation and readable results. Replaces install host arguments and `--all`; recognizes manual Codex `prodero-dev` connections without adding a duplicate server.

Preview limitations and actual verification coverage are recorded in docs/COMPATIBILITY.md. This entry does not announce publication.
