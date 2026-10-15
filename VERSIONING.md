# Prodero Curator versioning

Use Semantic Versioning: `MAJOR.MINOR.PATCH`. The intended first public release is **v0.1.0** (`0.1.0` in package metadata). This policy does not change the current project version or announce a release.

Versions are incremented for **releases**, not individual commits or internal development phases.

## Choosing a version

- **PATCH** (`0.1.0` → `0.1.1`): bug fixes, reliability fixes, UI/UX and documentation corrections, and small internal improvements that add no meaningful user-facing capability. Examples: fix session recovery, correct a dialog label, or improve retrieval performance without changing behavior.
- **MINOR** (`0.1.x` → `0.2.0`): new user-facing capabilities, workflows, integrations, or meaningful behavior changes. Before 1.0, necessary breaking changes to unstable interfaces or persisted formats also require MINOR. Examples: add an agent integration, introduce a memory workflow, or change the knowledge schema incompatibly. Document breaking changes and any migration or recovery steps.
- **MAJOR**: after 1.0, breaking changes to public contracts require a MAJOR increment (`1.x.y` → `2.0.0`). Compatible additions use MINOR; compatible fixes use PATCH. Reset lower components when increasing MAJOR or MINOR.

## Prereleases

When a release needs a test candidate, use standard SemVer identifiers: `0.1.0-alpha.1`, `0.1.0-beta.1`, `0.1.0-rc.1`, then `0.1.0`. Prereleases precede the corresponding final version; numeric identifiers have no leading zeros. Add prerelease process only when it serves an actual release need.

## What 1.0 means

`1.0.0` means Curator's public contracts are considered stable enough for normal external use. These include, where applicable: `.prodero/` persisted data, project configuration, knowledge schema and migrations, CLI commands and behavior, MCP contracts, session/memory lifecycle, installer/update behavior, and Codex/Claude Code integrations.

For example, removing a supported CLI command or incompatibly changing the persisted memory format after 1.0 requires a MAJOR release.
