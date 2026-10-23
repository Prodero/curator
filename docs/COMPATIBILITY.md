# Compatibility and verification

This document covers the **0.2.0** release contract and evidence recorded through 2026-10-23. A checkout, local tarball or passing test does not establish npm publication. Artifact evidence must satisfy the [release gates](RELEASING.md) on the final release tree. Supported runtime targets and project/knowledge schemas remain unchanged; see the [changelog](../CHANGELOG.md) for status JSON and local-preference compatibility changes.

> Contract: Local/Versioned describe Git storage and sharing, not a security boundary against the connected agent. Review and approval are workflow safeguards, not authenticated human consent. The agent may create, promote and maintain Versioned files within current authorization. Curator tools do not execute Git commit or push; coding-agent Git actions follow current user scope and host approval controls. See [Privacy](PRIVACY.md).

Supported runtime target: **Node 22.14.0–22.x**, npm and Git. Node 22.14.0 is the tested minimum; the package rejects other Node majors through its engine contract (npm may only warn unless engine-strict is enabled). `import.meta.dirname` and modern Node filesystem/runtime APIs are used. Earlier Node 20 declarations were not a verified compatibility promise.

| Environment | Status |
| --- | --- |
| macOS ARM64, Node 22.14.0 | Tested locally: full tests and isolated release gate |
| macOS / Ubuntu, Node 22.14.0 and 22.23.3 | Full four-job CI matrix passed on the runtime candidate identified below; final-tree certification requires matching exact-SHA runs |
| Native Windows | Not supported in 0.2.0; filesystem/Git fixtures and process behavior are not verified |
| Node 20, 24 or other majors; WSL | Not verified / outside the initial runtime contract |

CI configuration is not evidence that a remote run has passed. Record actual runs before publication.

## Hosts

| Host | Status / boundary |
| --- | --- |
| Codex CLI | Native 0.144.4 on macOS ARM64 passed installed 0.2.0 text lifecycle, persistent retrieval, Local maintenance and promotion preview. No Apps rendering claim from a CLI test. |
| Codex desktop | The owner reported a successful manual check on 2026-10-23. Exact-build, artifact-bound graphical acceptance is not independently traced; see the owner report below. |
| Claude Code | Experimental adapter. Native 2.1.302 on macOS ARM64 passed installed 0.2.0 text lifecycle, persistent retrieval, Local maintenance and promotion preview. This does not certify Claude Desktop or Apps rendering. |
| Claude Desktop | No installer adapter; not verified. |
| Codex mobile / iPad | The owner reported a successful Codex Mobile manual check on 2026-10-23 and previously accepted iPad Context Ready / Session Complete. Build/artifact binding and individual case traces were not supplied. |
| Cursor | Not yet verified against this RC. Workspace and Apps behavior must be checked before claiming support. |
| Other MCP hosts | Experimental; require standard stdio tools, optional roots and optional Apps/sampling. |

Use `prodero install` for one global machine integration. New workspaces initialize directly through MCP. Negotiated host roots authorize project selection; Claude's captured host project directory selects the primary root, and supported local Codex stdio launches supply the workspace through their launch directory. `projectRoot` is a checked selector, not authority. Missing supported context fails closed; no manual allowlist, per-project registration or CLI initialization is required. Explicit `--root` remains an optional hard boundary. Both integrations use the absolute public `prodero` executable: `mcp` for the installed package and `mcp --dev` for the saved Curator checkout. The public executable captures workspace context before loading development code. Update old global integration once and reconnect; `npm --prefix` is not a supported outer launcher. Managed PATH resolves the shebang to the verified Node installation. See [host integration](hosts.md) and [workspace trust contract](PRIVACY.md).

Apps-capable hosts can render bundled main/lifecycle/plugin resources. Others receive text and structured content; knowledge actions and explicit text approval remain available. Serving an HTML resource in a protocol smoke test does not verify host rendering. Sampling is optional and host-controlled; deterministic operation works without it. Assisted inputs may be transmitted to the host/model.

Historical machine-integration verification used isolated HOME and the native global launcher. The 2026-10-23 native runtime checks instead used existing client authentication, invocation-scoped candidate-only MCP configuration and separate disposable Git projects. They did not change saved MCP registrations or independently recertify the installer. Literal `prodero` opened each uninitialized fixture without creating `.prodero`; initialization occurred only in the subsequent explicitly requested step. These text runs do not certify desktop rendering.

Claude Code does not automatically read project `AGENTS.md`. Initialization remains unchanged; experimental Claude users need the host's documented project `CLAUDE.md` import of `@AGENTS.md` for the existing project lifecycle instructions. The installer does not create that project file or move lifecycle instructions into the global launcher. See [host integration](hosts.md). Restart hosts after package updates.

## RC evidence

The [release gate](RELEASING.md) checks a clean installed artifact, stdio lifecycle, Local storage, reviewed synthetic sharing, restart and synthetic patch upgrade preservation. Synthetic upgrades do not certify future releases or arbitrary schema downgrades. Record results for the exact release candidate.

### Runtime candidate: independently observed

The runtime candidate was commit `4f14a196b5325cf08c67ebeac40d21f5edb6e89f`. Its [fast CI](https://github.com/Prodero/curator/actions/runs/39653486240) passed 1,446 ordinary tests; its [full CI](https://github.com/Prodero/curator/actions/runs/39653523638) passed all four macOS/Ubuntu × Node 22.14.0/22.23.3 jobs, each with 1,453 tests and 16 installed-artifact smoke groups. These counts overlap and are not additive. The reviewed full-CI tarball SHA-256 was `c6bb29869c6fdcdff139799d01626a3f7ec57598005e5ab5d14437a76fbe9a12`.

On 2026-10-23 both native clients connected only to that installed 0.2.0 candidate, bounded to their own synthetic Git project. All 148 installed payload files matched the CI artifact. Each performed Open/initialize/Prepare/Record/Close/next Prepare, fresh-process retrieval, remember/search/inspect, a revision-bound Local edit and exact promotion preview. Independent storage checks found exactly two Local items, zero Versioned items, preserved pre-edit checkpoint content, four closed sessions per fixture and clean Git. Promotion was not applied. Existing authentication was used through the clients; invocation-only test permissions must not be copied into normal host setup.

Single-session maintenance visibly delivered Context Ready and Saved once in each client. In the batched two-session scenario each client omitted some intermediate receipts; persistence and closure still succeeded. This is an observed agent-relay limitation, not demonstrated knowledge loss. Curator supplies lifecycle text but does not guarantee model/client delivery. Apps rendering, host sampling and physical approval interaction were not independently verified by these CLI runs. Separate deterministic fixtures cover publication mechanics without claiming human UI approval.

### Owner-reported manual acceptance

On 2026-10-23 the owner reported successful manual Curator checks in **Codex Desktop, Claude CLI and Codex Mobile**, following the request for manual Apps acceptance. Record this as **owner-reported acceptance** for those named surfaces. The report did not supply client build versions, an exact candidate executable/hash/SHA, individual case results or an App call trace. It therefore does not establish independently traced results for Apply replay, stale-review handling or model-facing tool filtering, and does not upgrade an unverified host tier. Do not infer that the desktop used a particular dev connection or that the Claude CLI was the exact build used by the independent native test. Candidate binding can be clarified without assuming the entire manual check must be repeated. The previously accepted iPad lifecycle result remains accepted.

### Final release identity

These CI and native results identify the runtime candidate above. Release-note/README/compatibility edits change packaged bytes and produce a different tarball; they do not inherit its archive hash or exact-commit CI status. The final committed release tree requires its own matching package validation and full CI matrix, with host evidence explicitly bound or reconciled to the final artifact. No broader host support is inferred from a successful owner report.

Passing configured remote CI jobs on the final RC commit remains required before publication. Local protocol checks do not certify other Node/OS combinations or host App rendering.

Codex setup and per-tool configuration reference: [official configuration reference](https://developers.openai.com/codex/config-reference).

## Project and knowledge compatibility

Project schema 8 and Knowledge Schema 3 are the current targets. Schema 3 adds explicit applicability with a mechanical legacy-scope migration; see [Applicability](APPLICABILITY.md). Missing knowledge version means legacy format 1; its approved migration preserves instruction behavior with explicit context policy and legacy authority. Both versions live in the project config; moving or cloning a project requires no machine registry. Newer project or knowledge formats fail closed at the storage boundary. Open/Prepare can present update instructions without interpreting unsupported records. See [Migration Foundation](MIGRATIONS.md) for approval, recovery and future format transitions.

## CLI status output

`prodero status` and `prodero status --root PATH` now default to readable text, including when piped. Consumers of the previous implicit JSON output must add `--json`; TTY detection never selects the format. Successful machine JSON fields are unchanged. Project JSON keeps `version`, `project` and `update`, adding `scope: "project"`. Status errors in JSON mode are one stdout document with `ok: false`, `version`, `scope` and a safe `error` object (`code`, `message`, `recovery`); migration gates also include `migration`. CLI status performs no writes, including derived caches or ignore-rule maintenance; other detailed-status readers retain their existing defaults. Existing exit meanings remain: failed arguments/project compatibility/host inspection exit 1; an unavailable registry alone retains exit 0 and its `update.status` diagnostic. See [status commands and read-only/cache boundaries](hosts.md#commands-and-status).
