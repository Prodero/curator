# Compatibility and verification

The current checkout prepares **0.2.0 (unreleased)**. Historical v0.1 artifact/host evidence below is not certification of the new candidate. Candidate-specific artifact evidence must satisfy the [release gates](RELEASING.md). Supported runtime targets and project/knowledge schemas remain unchanged; see the [changelog](../CHANGELOG.md) for status JSON and local-preference compatibility changes.

> Contract: Local/Versioned describe Git storage and sharing, not a security boundary against the connected agent. Review and approval are workflow safeguards, not authenticated human consent. The agent may create, promote and maintain Versioned files within current authorization. Curator tools do not execute Git commit or push; coding-agent Git actions follow current user scope and host approval controls. See [Privacy](PRIVACY.md).

Supported runtime target: **Node 22.14.0–22.x**, npm and Git. Node 22.14.0 is the tested minimum; the package rejects other Node majors through its engine contract (npm may only warn unless engine-strict is enabled). `import.meta.dirname` and modern Node filesystem/runtime APIs are used. Earlier Node 20 declarations were not a verified compatibility promise.

| Environment | Status |
| --- | --- |
| macOS ARM64, Node 22.14.0 | Tested locally: full tests and isolated release gate |
| macOS / Ubuntu, Node 22.14.0 and latest 22.x | CI release-gate matrix; support certification requires green runs on the exact RC commit |
| Native Windows | Not supported in v0.1; filesystem/Git fixtures and process behavior are not verified |
| Node 20, 24 or other majors; WSL | Not verified / outside the initial runtime contract |

CI configuration is not evidence that a remote run has passed. Record actual runs before publication.

## Hosts

| Host | Status / boundary |
| --- | --- |
| Codex CLI | Tested: Codex CLI 0.144.4 on macOS ARM64 with an isolated v0.1.0 artifact. Text lifecycle, knowledge maintenance and promotion preview; no Apps rendering claim from a CLI test. |
| Codex desktop | Used during development with Apps; artifact-host UI interaction has not yet been independently verified. |
| Claude Code | Experimental adapter: native 2.1.52 user MCP registration and stdio connection verified in isolated HOME. Bare-word model flow stopped at login; not certified as supported. |
| Claude Desktop | No installer adapter; not verified. |
| Cursor | Not yet verified against this RC. Workspace and Apps behavior must be checked before claiming support. |
| Other MCP hosts | Experimental; require standard stdio tools, optional roots and optional Apps/sampling. |

Use `prodero install` for one global machine integration. New workspaces initialize directly through MCP. Negotiated host roots authorize project selection; Claude's captured host project directory selects the primary root, and supported local Codex stdio launches supply the workspace through their launch directory. `projectRoot` is a checked selector, not authority. Missing supported context fails closed; no manual allowlist, per-project registration or CLI initialization is required. Explicit `--root` remains an optional hard boundary. Both integrations use the absolute public `prodero` executable: `mcp` for the installed package and `mcp --dev` for the saved Curator checkout. The public executable captures workspace context before loading development code. Update old global integration once and reconnect; `npm --prefix` is not a supported outer launcher. Managed PATH resolves the shebang to the verified Node installation. See [host integration](hosts.md) and [workspace trust contract](PRIVACY.md).

Apps-capable hosts can render bundled main/lifecycle/plugin resources. Others receive text and structured content; knowledge actions and explicit text approval remain available. Serving an HTML resource in a protocol smoke test does not verify host rendering. Sampling is optional and host-controlled; deterministic operation works without it. Assisted inputs may be transmitted to the host/model.

Machine integration verification: Codex CLI 0.144.4 loaded the installed artifact's native configuration and global launcher in isolated HOME, received only `prodero`, and invoked `prodero_open` with the test workspace. The uninitialized project response exposed initialization and the main App resource; no project was initialized by installation. This text run does not certify desktop rendering.

Claude Code does not automatically read project `AGENTS.md`. Initialization remains unchanged; experimental Claude users need the host's documented project `CLAUDE.md` import of `@AGENTS.md` for the existing project lifecycle instructions. The installer does not create that project file or move lifecycle instructions into the global launcher. See [host integration](hosts.md). Restart hosts after package updates.

## RC evidence

The [release gate](RELEASING.md) checks a clean installed artifact, stdio lifecycle, Local storage, reviewed synthetic sharing, restart and synthetic patch upgrade preservation. Synthetic upgrades do not certify future releases or arbitrary schema downgrades. Record results for the exact release candidate.

Codex CLI 0.144.4 connected to the installed artifact with a fixed project root. It performed open/initialize/prepare/record/close/next prepare with the learned decision, conversational remember/search/inspect/Local edit and promotion preview. Noninteractive writes required invocation-scoped preapproval of only the synthetic test tools; publication was excluded. The host's sandbox kept `.git` read-only, so the outer test harness committed the initialization baseline; normal host operations then left Git clean. Interactive users should approve their own actions; do not copy test preapprovals into normal host setup.

The host correctly rejected an incomplete edit without a title, then accepted the corrected request. Apps UI rendering and host sampling were not verified by this text run. Actual publication is covered by the separate deterministic synthetic protocol fixture, not claimed as human UI approval.

Passing configured remote CI jobs on the final RC commit remains required before publication. Local protocol checks do not certify other Node/OS combinations or host App rendering.

Codex setup and per-tool configuration reference: [official configuration reference](https://developers.openai.com/codex/config-reference).

## Project and knowledge compatibility

Project schema 8 and Knowledge Schema 3 are the current targets. Schema 3 adds explicit applicability with a mechanical legacy-scope migration; see [Applicability](APPLICABILITY.md). Missing knowledge version means legacy format 1; its approved migration preserves instruction behavior with explicit context policy and legacy authority. Both versions live in the project config; moving or cloning a project requires no machine registry. Newer project or knowledge formats fail closed at the storage boundary. Open/Prepare can present update instructions without interpreting unsupported records. See [Migration Foundation](MIGRATIONS.md) for approval, recovery and future format transitions.

## CLI status output

`prodero status` and `prodero status --root PATH` now default to readable text, including when piped. Consumers of the previous implicit JSON output must add `--json`; TTY detection never selects the format. Successful machine JSON fields are unchanged. Project JSON keeps `version`, `project` and `update`, adding `scope: "project"`. Status errors in JSON mode are one stdout document with `ok: false`, `version`, `scope` and a safe `error` object (`code`, `message`, `recovery`); migration gates also include `migration`. CLI status performs no writes, including derived caches or ignore-rule maintenance; other detailed-status readers retain their existing defaults. Existing exit meanings remain: failed arguments/project compatibility/host inspection exit 1; an unavailable registry alone retains exit 0 and its `update.status` diagnostic. See [status commands and read-only/cache boundaries](hosts.md#commands-and-status).
