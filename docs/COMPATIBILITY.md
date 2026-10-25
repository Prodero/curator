# Compatibility and verification

Curator **0.2.1 Public Preview** is a documentation-only patch for 0.2.0. Application behavior, runtime requirements, host support and project/knowledge schemas are unchanged; users already running 0.2.0 do not need an urgent upgrade. The runtime and host checks below describe 0.2.0. See the [changelog](../CHANGELOG.md) for release changes.

> Contract: Local/Versioned describe Git storage and sharing, not a security boundary against the connected agent. Review and approval are workflow safeguards, not authenticated human consent. The agent may create, promote and maintain Versioned files within current authorization. Curator tools do not execute Git commit or push; coding-agent Git actions follow current user scope and host approval controls. See [Privacy](PRIVACY.md).

Supported runtime target: **Node 22.14.0–22.x**, npm and Git. Node 22.14.0 is the tested minimum; the package rejects other Node majors through its engine contract (npm may only warn unless engine-strict is enabled). `import.meta.dirname` and modern Node filesystem/runtime APIs are used. Earlier Node 20 declarations were not a verified compatibility promise.

| Environment | Status |
| --- | --- |
| macOS ARM64, Node 22.14.0 | Tested locally: full tests and isolated release gate |
| macOS / Ubuntu, Node 22.14.0 and 22.23.3 | Full four-job release matrix passed on the 0.2.0 release commit; see the verification results below |
| Native Windows | Not supported; filesystem/Git fixtures and process behavior are not verified |
| Node 20, 24 or other majors; WSL | Not verified / outside the initial runtime contract |

The built-in terminal updater additionally requires **npm 10.9.x** and an ordinary same-user global npm installation. Other installation layouts or toolchains need their package manager; see [updates](hosts.md#updates-and-advanced-project-commands).

## Hosts

| Host | Status / boundary |
| --- | --- |
| Codex CLI | Native 0.144.4 on macOS ARM64 passed installed 0.2.0 text lifecycle, persistent retrieval, Local maintenance and promotion preview. No Apps rendering claim from a CLI test. |
| Codex desktop | Successful manual check reported by the maintainer on 2026-10-23; detailed build and per-case Apps results were not recorded. |
| Claude Code | Experimental adapter. Native 2.1.302 on macOS ARM64 passed installed 0.2.0 text lifecycle, persistent retrieval, Local maintenance and promotion preview. This does not certify Claude Desktop or Apps rendering. |
| Claude Desktop | No installer adapter; not verified. |
| Codex mobile / iPad | Successful manual check reported on 2026-10-23, with earlier iPad Context Ready / Session Complete acceptance. |
| Cursor | Detection-only; workspace and Apps workflows are not verified. |
| Other MCP hosts | Experimental; require standard stdio tools, optional roots and optional Apps/sampling. |

Use `prodero install` for one global machine integration. New workspaces initialize directly through MCP. Negotiated host roots authorize project selection; Claude's captured host project directory selects the primary root, and supported local Codex stdio launches supply the workspace through their launch directory. `projectRoot` is a checked selector, not authority. Missing supported context fails closed; no manual allowlist, per-project registration or CLI initialization is required. Explicit `--root` remains an optional hard boundary. Both integrations use the absolute public `prodero` executable: `mcp` for the installed package and `mcp --dev` for the saved Curator checkout. The public executable captures workspace context before loading development code. Update old global integration once and reconnect; `npm --prefix` is not a supported outer launcher. Managed PATH resolves the shebang to the verified Node installation. See [host integration](hosts.md) and [workspace trust contract](PRIVACY.md).

Apps-capable hosts can render bundled main/lifecycle/plugin resources. Others receive text and structured content; knowledge actions and explicit text approval remain available. Serving an HTML resource in a protocol smoke test does not verify host rendering. Sampling is optional and host-controlled; deterministic operation works without it. Assisted inputs may be transmitted to the host/model.

Historical machine-integration verification used isolated HOME and the native global launcher. The 2026-10-23 native runtime checks instead used existing client authentication, invocation-scoped candidate-only MCP configuration and separate disposable Git projects. They did not change saved MCP registrations or independently recertify the installer. Literal `prodero` opened each uninitialized fixture without creating `.prodero`; initialization occurred only in the subsequent explicitly requested step. These text runs do not certify desktop rendering.

Claude Code does not automatically read project `AGENTS.md`. Initialization remains unchanged; experimental Claude users need the host's documented project `CLAUDE.md` import of `@AGENTS.md` for the existing project lifecycle instructions. The installer does not create that project file or move lifecycle instructions into the global launcher. See [host integration](hosts.md). Restart hosts after package updates.

## Release verification

The [release gate](RELEASING.md) checks a clean installed artifact, stdio lifecycle, Local storage, reviewed synthetic sharing, restart and synthetic patch upgrade preservation. Synthetic upgrades do not certify future releases or arbitrary schema downgrades.

### Native text checks — 2026-10-23

The runtime candidate was commit `4f14a196b5325cf08c67ebeac40d21f5edb6e89f`. Its [fast CI](https://github.com/Prodero/curator/actions/runs/39653486240) passed 1,446 ordinary tests; its [full CI](https://github.com/Prodero/curator/actions/runs/39653523638) passed all four macOS/Ubuntu × Node 22.14.0/22.23.3 jobs, each with 1,453 tests and 16 installed-artifact smoke groups. These counts overlap and are not additive. The reviewed full-CI tarball SHA-256 was `c6bb29869c6fdcdff139799d01626a3f7ec57598005e5ab5d14437a76fbe9a12`.

On 2026-10-23 both native clients connected only to that installed 0.2.0 candidate, bounded to their own synthetic Git project. All 148 installed payload files matched the CI artifact. Each performed Open/initialize/Prepare/Record/Close/next Prepare, fresh-process retrieval, remember/search/inspect, a revision-bound Local edit and exact promotion preview. Independent storage checks found exactly two Local items, zero Versioned items, preserved pre-edit checkpoint content, four closed sessions per fixture and clean Git. Promotion was not applied. Existing authentication was used through the clients; invocation-only test permissions must not be copied into normal host setup.

Single-session maintenance visibly delivered Context Ready and Saved once in each client. In the batched two-session scenario each client omitted some intermediate receipts; persistence and closure still succeeded. This is an observed agent-relay limitation, not demonstrated knowledge loss. Curator supplies lifecycle text but does not guarantee model/client delivery. Apps rendering, host sampling and physical approval interaction were not independently verified by these CLI runs. Separate deterministic fixtures cover publication mechanics without claiming human UI approval.

### Manual host checks

On 2026-10-23 the maintainer reported successful manual checks in **Codex Desktop, Claude CLI and Codex Mobile**. Client build versions, exact artifact identity and individual case traces were not recorded. These reports are separate from the versioned native CLI runs above and do not establish per-case Apps coverage for Apply replay, stale reviews or tool filtering. The earlier iPad lifecycle check also passed by user confirmation. Claude Code remains experimental.

### Published 0.2.0 identity

Published on **2026-10-25**, the 0.2.0 package and [v0.2.0 tag](https://github.com/Prodero/curator/releases/tag/v0.2.0) identify commit **`d180a58017b9e2e32731689411b420fa899aa884`**. Its [full release matrix](https://github.com/Prodero/curator/actions/runs/39999946126) passed all four macOS/Ubuntu × Node 22.14.0/22.23.3 jobs, each with **1,453 tests and 16 installed-artifact smoke groups**. [Post-main CI](https://github.com/Prodero/curator/actions/runs/40132635896) and the [tag matrix](https://github.com/Prodero/curator/actions/runs/40175313983) also passed on that same SHA. Counts overlap and are not additive.

All four release-matrix archives were identical. The public npm archive and GitHub Release asset match their **SHA-256 `54e95138e2807c27927b219b0049f0af1a9992005fda4815dd01f941067ca548`**. A clean public-registry installation reported CLI **0.2.0**, a current update check and byte-identical contents for all **148** package files.

Compared with the native-tested runtime candidate above, the published artifact changes four Markdown files; the other 144 payload files, including runtime, App, plugin and instruction assets, are identical. This preserves the scope of those native checks without treating the two archive hashes as interchangeable. The frozen tag and archive describe the published package even when documentation on `main` is updated later. CI does not expand the supported Node/OS or host Apps coverage listed here.

Codex setup and per-tool configuration reference: [official configuration reference](https://developers.openai.com/codex/config-reference).

## Project and knowledge compatibility

Project schema 8 and Knowledge Schema 3 are the current targets. Schema 3 adds explicit applicability with a mechanical legacy-scope migration; see [Applicability](APPLICABILITY.md). Missing knowledge version means legacy format 1; its approved migration preserves instruction behavior with explicit context policy and legacy authority. Both versions live in the project config; moving or cloning a project requires no machine registry. Newer project or knowledge formats fail closed at the storage boundary. Open/Prepare can present update instructions without interpreting unsupported records. See [Migration Foundation](MIGRATIONS.md) for approval, recovery and future format transitions.

## CLI status output

`prodero status` and `prodero status --root PATH` now default to readable text, including when piped. Consumers of the previous implicit JSON output must add `--json`; TTY detection never selects the format. Successful machine JSON fields are unchanged. Project JSON keeps `version`, `project` and `update`, adding `scope: "project"`. Status errors in JSON mode are one stdout document with `ok: false`, `version`, `scope` and a safe `error` object (`code`, `message`, `recovery`); migration gates also include `migration`. CLI status performs no writes, including derived caches or ignore-rule maintenance; other detailed-status readers retain their existing defaults. Existing exit meanings remain: failed arguments/project compatibility/host inspection exit 1; an unavailable registry alone retains exit 0 and its `update.status` diagnostic. See [status commands and read-only/cache boundaries](hosts.md#commands-and-status).
