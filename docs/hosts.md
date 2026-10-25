# Machine host integration

Install the public package (or a generated preview tarball), then run `prodero install`. No elevated privileges are needed for normal per-user host settings. Close the host while changing its settings, then restart it. Development checkout runtimes are deliberately rejected by the installer.

## Commands and status

- `prodero install`: open the interactive installation wizard. It lists every agent and its saved configuration state, then offers numbered install/update actions only for agents that need them. Select an agent, confirm with `y`, and review the result. Repeat for another agent or choose Finish. Enter at the selection prompt finishes; Enter at confirmation cancels that action. Ctrl+C or EOF exits without starting another operation.
- Installation takes no host arguments and has no `--all` flag. Choose agents inside the wizard. Non-interactive invocation prints readable status and terminal instructions, exits nonzero, and makes no changes.
- `prodero uninstall [codex|claude]` / `prodero uninstall --all`: remove owned integration, including when the executable has since disappeared. The default visits all adapters.
- `prodero status`: readable machine integration status, including the installed version and each host's detection, MCP, launcher and configuration state. It does not discover or access a project, even when run inside one.
- `prodero status --root PATH`: readable status for that existing project: initialization, knowledge, sessions, skills, checkpoints, attention counts and the bounded update check. It does not initialize, migrate, synchronize or repair the project.
- Add `--json` to either status command for scripts. The format is explicit and does not depend on whether stdout is a terminal or a pipe.

States are `not-detected`, `not-configured`, `installed`, `outdated`, `conflicted`, `unsupported-configuration`, `recovery-required`, `externally-configured`, `external-incomplete`, or `unsupported` (detection-only adapter). On inspection failure, MCP and launcher fields are `null` (unknown), not proof of absence. Detection means an executable on PATH or the native configuration file exists; it does not prove login, an operational server or UI compatibility. Support labels describe verification separately from installation state. The wizard displays conflicts without hiding other agents; those agents cannot be selected for installation. An installation failure exits nonzero.

An unchanged install writes nothing, including receipts and backups. An intact older managed launcher or changed installed executable location is updated. Edited managed content is a conflict. Re-running install after an npm/Node installation moves refreshes its absolute paths. This command does not update npm packages.

`HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `XDG_STATE_HOME` must use absolute paths when set (empty optional overrides use their defaults). Relative overrides are rejected before any writes, so changing the current repository cannot redirect machine settings into it. Configuration and state must remain inside the user home. Codex installation also checks its inactive global instruction file: an existing Prodero block there is a conflict, rather than permission to install a second launcher. Uninstall can still remove the receipt-owned launcher while preserving an unrelated block in the other file.

## Runtime switching

Keep one managed server named `prodero` and select where it runs. This is separate from the initial `prodero install` wizard:

```sh
prodero runtime dev --host codex --checkout /absolute/prodero-checkout --dry-run
prodero runtime dev --host codex --checkout /absolute/prodero-checkout
prodero runtime package --host codex
```

Use `--host claude` in Claude Code. A host is always required; the command never guesses the current agent or switches all agents. Callers must select the intended host explicitly. `--workspace PATH` checks that workspace for overrides; otherwise the current directory is checked. Workspace Prodero overrides are reported for review, never rewritten silently.

The installed package must include the public MCP entrypoint and runtime switching support, even before enabling dev mode. Upgrade the package first if it predates this feature. For an existing managed installation, the package target is read from its receipt. Use `--package-root /absolute/installed/@prodero/curator` if the installed package or Node location changed, or when migrating manual dev from a source-checkout CLI. Dev mode requires a Prodero checkout, its development dependencies and an npm JavaScript executable resolvable on the managed launch PATH. Registration invokes the verified absolute public package executable `bin/prodero` with `mcp --dev`. This executable captures host launch context before loading development code or running builds. The checkout loader receives that context in process; builds use checkout-scoped child processes. Paths containing spaces are supported; shell expressions are never evaluated.

For a manual `prodero-dev` setup, first run the desired command with `--dry-run` and review the migration. Apply with `--adopt-dev` to replace only that host's old registration with managed `prodero`. The command preserves private originals and the global launcher. Codex migration accepts a standalone `[mcp_servers.prodero-dev]` table with an optional adjacent `[mcp_servers.prodero-dev.env]` child table. Original settings, including the old environment, remain in private restoration backups. Unusual TOML forms require manual review. Claude migration removes the exact JSON `mcpServers.prodero-dev` entry. Existing canonical `prodero` ownership conflicts are never adopted or overridden by this flag.

Receipts created by switching use format 2 and retain the selected mode, package entry, dev checkout/entry and original uninstall provenance. Format 1 receipts remain readable and upgrade on the first switch. Status exposes `runtimeMode`; the wizard shows `Installed · dev`. Reinstalling preserves intentional dev mode. A repeat switch to the same configuration writes nothing. The transaction verifies saved bytes and rolls back its own changes on write failure; concurrent edits still require recovery rather than an unsafe overwrite.

`runtime dev` stores the canonical Curator checkout as `runtime.devRoot` in the selected host’s private `receipt.json`. It describes runtime code, never a workspace permission. `mcp --dev` reads managed receipts for this installed executable and selects the unique saved checkout associated with an ordinary `mcp --dev` entry. Receipts using explicit checkout arguments do not compete with that default. Missing, malformed, pending, symlinked or ambiguous state fails closed; no cwd/Git/project discovery is used to find Curator code. A saved canonical checkout replaced by a symlink is rejected.

If hosts select different checkouts, switching the second host writes the advanced `mcp --dev --checkout /absolute/curator-checkout` form without changing the first host. The checkout flag selects trusted runtime code only. Package mode never reads development receipts. The `dev → package → dev` cycle retains the saved checkout. The public executable loads the internal `scripts/mcp-dev-launcher.mjs` module; it is no longer a standalone registered server.

Node is required (see `package.json` for the supported version). Ordinary production execution needs neither npm nor development dependencies once the package and runtime dependencies are installed. npm is used for current development builds and npm-based installation/upgrades; it is not a production MCP launcher. Git is optional for session branch/commit metadata. Start MCP directly through `prodero`, not an outer npm script that changes its launch directory.

Project `AGENTS.md` delegates runtime guidance to `prodero_instructions_read`.
The connected server reads `instructions/AGENTS.md` relative to its own installation,
so these switches also select the matching instructions. No separate instructions
path in MCP settings or project edits are needed after the one-time project migration.

Restart or reconnect only the selected host after applying. The command changes saved settings, not the running MCP process. Avoid running an older Prodero installer against a format 2 receipt. On uninstall, otherwise unchanged files restore their exact pre-install/pre-migration bytes, including any original manual dev registration. If other settings were edited later, uninstall removes only the managed blocks; migration originals remain in private backups for manual recovery.

## Native files and ownership

| Adapter | Detection | MCP settings | Minimal global instruction |
| --- | --- | --- | --- |
| Codex CLI (verified on macOS) | `codex` on PATH or config file | `$CODEX_HOME/config.toml`, default `~/.codex/config.toml`; only bounded `[mcp_servers.prodero]` stanza | Active nonempty `AGENTS.override.md`, otherwise `AGENTS.md`, in the same Codex home |
| Claude Code (experimental) | `claude` on PATH or config file | `~/.claude.json`; with `CLAUDE_CONFIG_DIR`, `$CLAUDE_CONFIG_DIR/.claude.json`; only `mcpServers.prodero` | `~/.claude/CLAUDE.md`, or `$CLAUDE_CONFIG_DIR/CLAUDE.md` |
| Cursor (unimplemented) | `cursor` on PATH or `~/.cursor` | No changes | No changes |

Native configuration overrides are honored only inside the current HOME. Symlinked paths, hardlinked files, malformed/duplicate configuration keys and ambiguous managed boundaries are rejected. Relocating a previously managed configuration requires reviewing/removing its original integration first. A new Codex global override that shadows an installed launcher requires uninstall/reinstall; the new custom override is preserved.

The MCP command is the verified absolute installed public `bin/prodero` executable (also exported as `prodero` by the package manager). Package mode uses `args = ["mcp"]`; development uses `args = ["mcp", "--dev"]`. Managed `env.PATH` starts with the verified Node directory so the executable’s shebang works in GUI hosts without shell profiles. No project cwd is configured. One global registration serves all projects. No fixed repository root is registered. The host supplies workspace authority before `.prodero` exists, so opening Prodero in a new workspace offers initialization through MCP. No CLI initialization, trust command or project allowlist is needed. Global instructions contain no prepare/record/close or other project lifecycle policy.

Claude Code uses negotiated roots, with its matching `CLAUDE_PROJECT_DIR` as the primary workspace; without roots, its captured host project environment can supply the boundary. Empty, unavailable or invalid negotiated roots fail closed. Codex local stdio uses its captured host-selected launch directory. The server recognizes supported host identities on the trusted local connection; client names do not authenticate an arbitrary hostile peer. Unknown contexts fail closed. A child process is bound to its workspace; switching projects uses the host's separate/reconnected sessions.

`projectRoot` is only an exact canonical selector among authorized roots. `PWD`, `INIT_CWD`, model-provided metadata, Git discovery and existing `.prodero` data never grant authority. Core, text, App callbacks and plugins share one operation context; the next call refreshes negotiated roots.

Old receipt-owned registrations using Node with an internal dev script or `npm --prefix` are upgraded on reinstall or runtime switching, preserving backups and uninstall provenance. Manually owned dev registrations need the existing one-time `runtime dev --adopt-dev` migration. Reconnect after that global integration update; no per-project setup follows. Legacy npm-launched Codex connections without roots fail closed instead of treating the installation directory as a workspace.

Text instructions use `<!-- prodero:global-start -->` / `<!-- prodero:global-end -->`. Codex TOML uses `# prodero:mcp-start` / `# prodero:mcp-end`. Private ownership receipts live in `${XDG_STATE_HOME:-$HOME/.local/state}/prodero/host-integrations/<host>/`. Unrelated settings and instructions are preserved, including changes made after installation. Uninstall restores exact original bytes when the files are otherwise unchanged; otherwise it removes only the owned entry/block. It never uninstalls the npm package or removes project knowledge, `.prodero`, project `AGENTS.md`, or project lifecycle instructions. Empty configuration directories and private recovery backups can remain.

## Conflicts and recovery

An active Codex `prodero-dev` connection with a bounded global launcher is recognized as externally configured. It is displayed as already configured manually, without creating a receipt or adding another server. A missing launcher is shown as an incomplete manual setup. Active `prodero-dev` alongside a managed `prodero` integration blocks installation until the duplicate is reconciled; a disabled `prodero-dev` connection is preserved and does not block installation. These are configuration checks, not connectivity tests.

The installer never adopts an existing unowned `prodero` entry or launcher. For an older manual setup, back up settings, review and remove only that old entry/block yourself, then run install. For a modified owned block, preserve your edits and reconcile it with the private receipt before retrying. There is no force-overwrite flag. An intact owned older launcher can update automatically.

Configuration is parsed before writes. Changes use temporary files and rename, a per-host installer lock, a pending journal and private recovery snapshots. Failed writes roll back when safe; externally changed files are never overwritten during rollback. Interrupted operations block further changes rather than guessing. Close installers/hosts, inspect the private journal and backup, restore a consistent pre-operation configuration and receipt, then remove the pending journal/lock before retrying. These protections do not guarantee power-loss durability or exclude writes by a native host between checks and rename.

Recovery snapshots can contain **the entire previous host configuration, including credentials**. They are local files with mode 0600 in private state directories; do not attach them to bug reports. Errors/status do not include configuration content. Backups are retained for recovery after uninstall; remove them yourself when no longer needed. The installer does not transmit configuration or validate host authentication.

## Experimental Claude limitations

Historical Claude Code 2.1.52 checks verified generated user-scope registration and an isolated stdio connection but stopped at login. On 2026-10-23, native Claude Code 2.1.302 passed the installed 0.2.0 candidate's text lifecycle, persistent retrieval, Local editing and promotion preview in a disposable project using existing client authentication and invocation-only MCP configuration. That run did not recertify global installer registration, Claude Desktop or graphical Apps. The adapter remains experimental; see the exact candidate and evidence boundaries in [Compatibility](COMPATIBILITY.md). No Claude Desktop adapter is provided.

Claude Code reads global `CLAUDE.md`, but does not automatically consume project `AGENTS.md`. Prodero project initialization is unchanged. For experimental lifecycle use, review the host's native project `CLAUDE.md` import of `@AGENTS.md` yourself; installation never writes that project file. Apps rendering depends on the host; text responses remain available.

## Advanced manual registration

Use this only when troubleshooting or deliberately managing MCP yourself. Do not combine a manual entry named `prodero` with the managed installer. A fixed root ties the server to that project even after switching workspaces:

```sh
codex mcp add prodero -- prodero mcp --root /absolute/path/to/project
```

Hosts using JSON stdio settings can use their documented location:

```json
{
  "mcpServers": {
    "prodero": {
      "command": "prodero",
      "args": ["mcp", "--root", "/absolute/path/to/project"]
    }
  }
}
```

Use the absolute installed executable if the host cannot find `prodero` on PATH. Manual MCP registration alone does not install the global launcher. A fixed server root is the security boundary: `projectRoot` may identify the same canonical directory, but cannot override it. Without a fixed root, `projectRoot` selects an exact member of the host-authorized roots; omission selects the host primary workspace or the sole root. Roots are compared using real paths, so aliases of the same project work. Absent roots capability uses only a supported local host launch context. Empty, unavailable or invalid negotiated roots fail closed. Multiple roots without a host primary require explicit selection, and authorizing a parent does not authorize independent nested projects. No arbitrary working-directory fallback or ancestor discovery is used; local Codex launch context is captured and pinned at the entrypoint. Explicit nested roots never silently select their parent Git repository: an uninitialized nested directory is rejected; an already initialized nested Prodero project retains its boundary.

Native references: [Codex MCP](https://developers.openai.com/codex/mcp), [Codex global instructions](https://developers.openai.com/codex/guides/agents-md), [Claude MCP scopes](https://code.claude.com/docs/en/mcp), [Claude instructions](https://code.claude.com/docs/en/memory).

## Updates and advanced project commands

Everyday work happens through the connected agent. These commands are for maintenance, recovery or deliberate terminal use. See also [project recovery](RECOVERY.md).

```sh
prodero --help
prodero status
prodero status --root /absolute/path/to/project
prodero status --json
prodero status --root /absolute/path/to/project --json
prodero check-update
prodero update
prodero update 0.2.1 --yes
prodero install
```

`check-update` reports the installed and public latest npm version when reachable, availability and the terminal command `prodero update`. An unpublished, disabled or unreachable registry is unavailable, not current. In Codex/Claude the update indicator only opens these instructions. The compatibility MCP tool `prodero_update` is read-only for every release source; it does not install, rebuild, stage or refresh project integration.

`prodero update` updates the installed package from a terminal. The built-in updater supports **Node 22.14–22.x with npm 10.9.x** and an ordinary same-user global npm installation. It verifies that installation, previews an exact stable newer version and unchanged prefix, asks you to finish active work and close Codex/Claude, then requires explicit confirmation. `prodero update VERSION` selects an exact stable target; ranges/tags/URLs/downgrades are rejected and an already-current target is a no-op. There is no automatic process discovery or host termination. Do not launch another consumer or package-manager operation during installation. Restart your hosts afterward.

For non-interactive use, provide both an exact target and explicit acknowledgment: `prodero update VERSION --yes`. Replace VERSION with the published version you want to install. The flag acknowledges that active work has ended and hosts are closed; the updater does not verify this. Without both, a non-TTY command refuses instead of waiting or silently agreeing.

The CLI waits for npm and checks the resulting installed version/public command. Failure exits nonzero with repair guidance; npm can leave a partial installation and there is no atomic rollback or hot activation. Source checkouts, linked/alternate package-manager layouts, other npm versions, mismatched installs and inadequate permissions are unsupported by this updater; use the installation's package manager instead. Follow the reported package-manager/path guidance without using sudo or changing ownership to bypass a refusal. Ordinary npm dependency resolution remains in effect: the top-level artifact is verified, but the transitive dependency tree is not promised to be frozen or available offline. Prebuilt packages are installed with lifecycle scripts disabled.

Package update does not migrate projects, rewrite host settings/receipts/preferences or switch dev mode. A host saved in dev mode continues to load its existing checkout: updated package is distinct from active dev runtime. After restart, Open/Prepare separately present required project/knowledge migration for review; CLI `migrate` explicitly applies a permitted update. Back up the whole `.prodero` directory before preview migrations and do not downgrade to a runtime unable to read its schema.

`PRODERO_RELEASE_SOURCE=none` disables passive version checks. Local manifest/check-out staging remains an internal development test adapter, not a production updater or a way to install through MCP. The terminal installer uses its verified public npm source rather than a model-supplied release location.


`status` without `--root` inspects machine integrations only. `status --root PATH` inspects the selected project. Both default to plain text, including in pipes; scripts must pass `--json`. Successful machine JSON retains `ok`, `version`, `scope: "machine"`, `action` and `hosts`. Successful project JSON retains `version`, `project` and `update`, with additive `scope: "project"`. Failed machine inspection retains its host results with `ok: false` and unknown (`null`) configuration fields where inspection failed.

With `status --json`, invalid arguments or roots, blocked migration, newer schemas and storage failures produce exactly one JSON document on stdout, no stderr, and exit 1. The error shape is `{ "ok": false, "version": "…", "scope": "machine|project", "error": { "code": "…", "message": "…", "recovery": "…" } }`; a migration gate also includes `migration`. Successful reads exit 0. A failed or disabled registry check remains `update.status: "unavailable"` or `"invalid"` in a successful project result and retains exit 0; this does not claim the installed version is current. Plain-text failures remain diagnostic text and exit nonzero.

Status does not change canonical knowledge, skills, sessions, configuration, indexes, managed instructions or migration journals, and does not recreate missing runtime stores. If a required store (for example `checkpoints`) is missing or unreadable, status reports a diagnostic and exits 1; it does not repair the store. The CLI explicitly disables cache persistence: it may read valid caches or scan canonical files, but it does not create, replace or delete caches, create cache directories, or refresh `.gitignore`. Other detailed-status API callers retain their existing default derived-cache behavior (`memory-index.json`, `session-index.json`, `knowledge-graph.json` and the required ignore rules); that maintenance is not performed by CLI status. Projects needing an update are inspected through metadata only; run `prodero migrate status --root PATH` to review the required step.

`init`, `sync`, `context [query]` and `prepare [task]` accept `--root PATH` or `--root=PATH`. Without it they require a Git or initialized Prodero ancestor. Unknown commands/flags and invalid roots exit non-zero. `prepare` starts a session; use the MCP lifecycle to record and close it. `sync` starts or resumes the Curate Memory options workflow and can recover pending observations, including active-session observations. Use the connected agent/App to continue its review steps. `sync-sessions` is the low-level deterministic recovery command that processes only closed sessions and leaves active sessions untouched. Normal session close/prepare learning does not require starting Curate Memory.


For project-history questions without starting a session, use `prodero recall "why was this designed this way?" --root /absolute/project`, or ask the connected agent.

The npm package is now `@prodero/curator`; the command remains `prodero`. Existing project data and host receipts keep their paths and formats. Legacy `@prodero/cli` package/checkouts remain recognized when selecting an existing runtime. If the installed package path changes, explicitly select the new installation with `--package-root` as described above; no host setting or project data is silently migrated.
