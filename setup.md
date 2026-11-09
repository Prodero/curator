# Install Prodero Curator with your coding agent

Follow this guide to install the current stable **Prodero Curator** and connect this coding client. Do the work, not just describe commands for the user to repair. Inspect quietly, give a short plan, obtain only missing approval, install, verify, and lead into project setup. Keep routine output brief. Never promise an unattended installation or support for every agent/platform.

## The route to follow

1. Identify this client: **`codex`** for Codex CLI/desktop, **`claude`** for Claude Code. Select one, not both. Ask only if the client is genuinely ambiguous.
2. Reuse compatible installed Node/npm. Resolve npm `@latest` once and pin that exact release. Set up the explicit runners below.
3. Install the package if absent. Run **`curator_cli install --host "$CURATOR_HOST" --dry-run --json`**, inspect the result, then **`curator_cli install --host "$CURATOR_HOST" --yes --json`** within the approved scope. **Never use `install claude` or `install codex`: these are not installation commands.** Do not guess syntax from the separate uninstall command.
4. Verify saved configuration, then the actual client's tools. Reconnect only if needed. After reconnect, open Curator in the intended project and offer initialization if it is new.

Use the same explicit Node + Curator runner for **every** version, help, status, install and rollback command. A different `prodero` on PATH is not a blocker: leave it and PATH unchanged. Do not ask the user to choose between deleting another tool and repairing PATH.

**Boundaries:** macOS Codex is the primary native-client route; Claude Code is experimental. Release tests also run on Ubuntu, but that does not certify native Linux client connectivity: offer the manual wizard there and verify in the actual client before claiming support. Native Windows is unsupported; WSL is unverified and outside this workflow. Cursor, Claude Desktop, mobile-only and other clients have no managed adapter here. Do not invent their configuration paths. See [host verification scope](docs/COMPATIBILITY.md#hosts).

## 1. Inspect and select the release

Use trusted session context and file tools to identify OS, architecture, existing client overrides, and concrete Node/npm installations. Do not print credentials, complete settings, receipts, backups, environment variables or full PATH. Respect existing absolute HOME/client overrides.

Find paths before executing them. A path may be a lazy-install manager shim, alias or shell function. Inspect its target and selected installed version; run version/help/status only through a concrete already-installed executable, or a documented invocation-local no-install guard for that manager. Never execute an unresolved shim just to see what it does. Keep missing, found-but-unverified and verified-check-failed distinct. This optional discovery-only probe runs in a known POSIX shell without sourcing profiles:

<!-- curator:environment-probe:start -->
```sh
for curator_tool in uname node npm git prodero nvm fnm volta mise asdf brew apt-get dnf pacman; do
  curator_tool_path=$(command -v "$curator_tool" 2>/dev/null) || curator_tool_path=
  if [ -z "$curator_tool_path" ]; then
    printf '%s.state=missing\n' "$curator_tool"
    continue
  fi
  printf '%s.path=%s\n' "$curator_tool" "$curator_tool_path"
done
```
<!-- curator:environment-probe:end -->

Read the [public registry metadata](https://registry.npmjs.org/@prodero%2fcurator/latest). Require name `@prodero/curator`, an exact stable SemVer version, `engines.node` and nonempty `dist.integrity`. Stop if metadata is unavailable, invalid or points to a prerelease. Do not substitute a cached/guessed version or unpublished candidate. If safe npm is already available, the equivalent lookup is the `release-metadata` block below.

Select Node using the resolved release's `engines.node`, not the newest LTS or an old document. Reuse an installed compatible version with its matching bundled npm, even when another Node is first on PATH. Do not change defaults, shell profiles, `.npmrc`, `.nvmrc`, `.tool-versions` or the project's `package.json`. If Node/npm needs preparation, use [Prerequisite exceptions](#prerequisite-exceptions), then return here.

Identify the inspected npm's global prefix. Reuse it if writable and its `bin/prodero` is absent or already owned by this Curator installation. If not writable, or another package owns that target, choose a new dedicated user-owned prefix such as `~/.local/share/prodero/npm`. Never use sudo, `--force`, ownership changes or overwrite another command. An unrelated `prodero` elsewhere on PATH does **not** require another prefix, uninstall or PATH edit.

Inspect any existing Curator installation and host registration first. This guide does not authorize an upgrade, downgrade, runtime switch or relocation. Preserve linked/source/dev setups. An existing configured release can be verified as-is; propose a separate concrete repair/update only when necessary. Empty npm scope directories alone do not prove a failed installation.

## 2. Use these runners, not bare `prodero`

Set the path variables to **actual inspected absolute paths**, then select the host and version. Do not copy placeholder values:

- `NODE_BIN`: compatible Node executable.
- `NPM_CLI`: that installation's bundled `npm/bin/npm-cli.js` file.
- `CURATOR_PREFIX`: reviewed global npm prefix, including any dedicated user-owned prefix.
- `CURATOR_HOST`: exactly `codex` or `claude`.
- `CURATOR_VERSION`: exact stable release resolved above, never `latest` or a range.

Define the following in the same shell as the commands that use them. If tool calls start fresh shells, include the assignments and these functions again. These functions do not persist shell changes.

<!-- curator:runners:start -->
```sh
: "${NODE_BIN:?Set the inspected absolute Node executable}"
: "${NPM_CLI:?Set the matching absolute npm-cli.js path}"
: "${CURATOR_PREFIX:?Set the inspected npm prefix}"
case "$NODE_BIN:$NPM_CLI:$CURATOR_PREFIX" in /*:/*:/*) ;; *) printf '%s\n' 'Absolute paths required' >&2; exit 1;; esac
case "${CURATOR_HOST-}" in codex|claude) ;; *) printf '%s\n' 'Select codex or claude' >&2; exit 1;; esac
curator_npm() (
  PATH="${NODE_BIN%/*}:$PATH"; export PATH
  "$NODE_BIN" "$NPM_CLI" "$@"
)
CURATOR_MODULES=$(curator_npm root --global --prefix "$CURATOR_PREFIX") || exit 1
CURATOR_CLI="$CURATOR_MODULES/@prodero/curator/bin/prodero"
curator_cli() (
  PATH="${NODE_BIN%/*}:$PATH"; export PATH
  "$NODE_BIN" "$CURATOR_CLI" "$@"
)
```
<!-- curator:runners:end -->

If not already resolved through the public metadata endpoint:

<!-- curator:release-metadata:start -->
```sh
curator_npm view --registry=https://registry.npmjs.org/ @prodero/curator@latest name version engines dist.integrity --json
```
<!-- curator:release-metadata:end -->

Show one short plan: selected client, exact package release, Node reused/prepared, npm prefix, and persistent client files affected. For Codex the default targets are `~/.codex/config.toml` and `~/.codex/AGENTS.md`; for Claude Code they are `~/.claude.json` and `~/.claude/CLAUDE.md`. Existing overrides change those paths; inspect, do not guess. The adapter also creates local private ownership/backup records. It preserves unrelated settings. Backups can contain credentials: keep them on this machine and do not upload them.

Follow the user's and host's approval controls. Ask once for any authorization still missing from this concrete plan; do not demand redundant consent for steps already approved. If the CLI is absent, explain that its dry-run will verify client paths after package installation. An unchanged preview then continues the approved plan, not another approval loop. New targets, privileges, conflicts, terms or persistent effects need a revised decision. Project files are a separate choice after connection.

## 3. Install and connect

For an absent package within the approved scope, run:

<!-- curator:pinned-install:start -->
```sh
: "${CURATOR_VERSION:?Set CURATOR_VERSION to the exact stable version approved in the plan}"
curator_npm install --global --prefix "$CURATOR_PREFIX" --registry=https://registry.npmjs.org/ --engine-strict --omit=dev --ignore-scripts "@prodero/curator@$CURATOR_VERSION"
```
<!-- curator:pinned-install:end -->

Do not resolve `latest` again during apply. For a newly installed package, verify the installed package/CLI version equals `CURATOR_VERSION`. A mismatch blocks configuration. For an existing installation being reused, record and verify its actual version and compatible runtime; do not require it to equal latest or silently upgrade it. Read package metadata and inspect capabilities first:

<!-- curator:inspect-cli:start -->
```sh
curator_cli --version &&
curator_cli --help &&
curator_cli install --help
```
<!-- curator:inspect-cli:end -->

If top-level help advertises `status --json`, run `curator_cli status --json`; otherwise use its documented read-only inspection/manual fallback, not unsupported flags. Check each command's exit code before continuing. Read JSON **and exit codes**. Errors are not absence. Installed/already-configured requires verification, not reinstalling. Conflicted, external-incomplete, unsupported-configuration, recovery-required or intentional dev/manual states block automatic replacement. Never create a duplicate `prodero`/`prodero-dev` entry.

When the inspected CLI advertises the targeted flags, preview the one selected host:

<!-- curator:preview-host:start -->
```sh
curator_cli install --host "$CURATOR_HOST" --dry-run --json
```
<!-- curator:preview-host:end -->

Continue only if the preview matches the approved plan and does not report a blocked state:

<!-- curator:apply-host:start -->
```sh
curator_cli install --host "$CURATOR_HOST" --yes --json &&
curator_cli status --json
```
<!-- curator:apply-host:end -->

`--yes` acknowledges only the selected host's MCP configuration/global launcher changes. Use the installer, not manual JSON/TOML edits. It stores the absolute Curator entrypoint and Node launch path, so an unrelated shell command named `prodero` cannot intercept MCP. Do not add fixed repository roots or project lifecycle rules globally. Do not initialize a project in this step.

**Older CLI only:** if help does not advertise targeted flags, run `curator_cli install` in a real interactive terminal, select only the reviewed host, confirm and Finish. Relay actual choices; never guess menu numbers or pipe automatic answers. If no interactive terminal is available, give the user that exact pending wizard step. This is a capability fallback, not a reason to downgrade a new install.

If a step fails, stop its dependent steps, report the specific sanitized error, and run the supported status inspection separately before retrying an uncertain outcome. A later successful status must never conceal a failed installation. Never disable approval controls, bypass a rejection, remove another MCP entry or erase locks/journals. Use [host recovery](docs/hosts.md). Only on requested rollback use `curator_cli uninstall "$CURATOR_HOST"`; uninstall uses a positional host, install uses `--host`. Rollback preserves the npm package and project data.

## 4. Verify the actual client, then continue to the project

Saved configuration is not a live connection. Check actual tool discovery in the selected client and call `prodero_instructions_read` when available. A standalone test server proves only that the server can run, not that this client is connected. Do not claim Apps rendering, authentication or lifecycle success from a status command.

If the client cannot reload tools in this chat, finish the installation with one clear handoff: **“Curator <version> is installed and configured for <client>. Reopen this client in your project, start a new chat and type `prodero`.”** Say connectivity is still pending. Do not close the client or interrupt active work yourself. Do not ask the user to rerun installation merely to reconnect.

Once tools are available, open Curator in the user's intended repository. If the project is new, offer its **Initialize Prodero** action and review the project files before applying it. If already initialized, open it and preserve its knowledge. Do not silently run `init`, import memory or change Git. If no project is selected, ask only for the project folder.

**Claude Code project completion:** as part of the user's chosen project setup, check the project's `CLAUDE.md` for an `@AGENTS.md` import. If missing, show the small edit adding that import on its own line (or a new file containing it) and apply within the authorized project-edit scope, preserving all existing content and avoiding duplicates. Claude Code does not automatically read `AGENTS.md`. Report a declined/blocked import as the exact remaining step; do not leave the user to discover it later or copy project instructions globally.

Report a short outcome: installed version and client, configuration result, actual connection verified or reconnect pending, project ready or the single next action. Keep exact Node/npm/prefix paths available for diagnostics, without overwhelming a successful install with a checklist of hypothetical problems.

## Prerequisite exceptions

Use this section **only** when compatible installed Node/npm cannot be reused. Do not turn these branches into questions for an ordinary working setup.

- If Node is compatible but npm resolves elsewhere or is broken, inspect and use its known bundled npm with that exact Node first. npm normally ships with Node. Do not repair arbitrary symlinks, overwrite Node or bootstrap `npm install npm` through a broken command.
- If another compatible version is already installed in the user's manager, use its concrete binary and bundled npm, without activation or changing defaults. Inspect official manager documentation before installing a missing version. For example, `nvm install` may change a default alias or install default packages; it is not equivalent to using an installed version. Unresolved shims must not run lazy installs or project hooks during inspection.
- If no compatible installation is present, propose an exact compatible Node+bundled-npm version side by side. Prefer the existing manager only when its documented effects fit the approved plan. Otherwise choose the matching official binary from the [Node release archive](https://nodejs.org/en/download/archive), using the immutable `https://nodejs.org/dist/vVERSION/` directory.
- Download the archive and checksum manifest separately over HTTPS; verify the exact archive entry, and follow [signed-SHASUM verification](https://github.com/nodejs/node#verifying-binaries) with trusted release keys when available. Missing/failed verification blocks execution. Reject absolute/traversal archive members. After approval, extract only to a new absent user-owned versioned directory such as `~/.local/share/prodero/runtimes/node-vVERSION-OS-ARCH`. Keep it for MCP; never register a temporary directory or overwrite another runtime.
- Use the absolute Node and bundled npm runners above, with PATH scoped to those invocations. Verify actual Node/npm versions and npm prefix before installing Curator. Do not add shell/profile entries, change manager defaults, install another manager, run automatic migrations/hooks, use unofficial mirrors, source builds or `curl | sh` as an implicit fallback.
- If tools, platform support, provenance or required verification cannot be established, explain the one specific blocker and manual next step. Do not claim success or silently broaden the plan. A custom-prefix install may not qualify for the built-in updater; retain its exact npm prefix/command for maintenance.

## Manual alternative

For a user who prefers the terminal and already has compatible Node/npm with no conflicting `prodero` command:

```sh
npm install --global @prodero/curator@latest
prodero install
```

The manual command resolves `latest` when run. The assisted path above resolves once, reviews and installs an exact version. Optional website documentation links follow `latest`; if it moves after review, consult the same files in the selected exact package version instead.

- [Host installation and recovery](docs/hosts.md)
- [Compatibility](docs/COMPATIBILITY.md)
- [Project recovery](docs/RECOVERY.md)
