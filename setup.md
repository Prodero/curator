# Install Prodero Curator with your coding agent

Use this guide for **Codex or experimental Claude Code**, following the client/platform boundaries below. The agent checks prerequisites, presents one plan and guides installation for the selected client. Do not promise a fully unattended install.

**Platform verification:** release checks passed on macOS and Ubuntu; historical native client lifecycle checks were performed on macOS. On Linux, offer the manual wizard and report native-client connectivity as unverified until checked in that client. Native Windows is not supported; WSL is unverified and outside this workflow.

**Claude Code uses the same setup route.** Its adapter remains experimental. Historical native text-lifecycle checks do not certify this prompt flow, desktop Apps rendering or every host/version. The [verification scope](docs/COMPATIBILITY.md#hosts) is an optional reference; guide the user through setup in chat.

The manual fallback is:

```sh
npm install --global @prodero/curator@latest
prodero install
```

**Release boundary:** this guide follows the public npm `latest` dist-tag, not a hardcoded release number. For an agent-assisted installation, resolve `@prodero/curator@latest` once from the [public registry metadata](https://registry.npmjs.org/@prodero%2fcurator/latest), then record its exact `name`, `version`, `engines.node` and `dist.integrity` before proposing a plan. Require package name `@prodero/curator`, an exact stable SemVer version and nonempty Node engine/integrity metadata. Stop if metadata is unavailable, invalid or points to a prerelease; do not substitute a cached/guessed version or an unpublished candidate. A locally supplied candidate must be explicitly identified and reviewed separately. This guide is installation guidance, not permission to bypass the user's or host's approval controls.

The manual `@latest` command resolves the current release when run. The assisted flow instead installs the exact version reviewed in the plan, so a later dist-tag change cannot silently change an approved target. To check metadata after identifying a safe installed npm executable in step 1, use:

<!-- curator:release-metadata:start -->
```sh
npm view --registry=https://registry.npmjs.org/ @prodero/curator@latest name version engines dist.integrity --json
```
<!-- curator:release-metadata:end -->

If Node/npm is missing, read the same public HTTPS metadata with an available read-only web tool; do not install or execute a package just to discover its version. Published documentation for the selected version is included in its npm package. The optional website documentation links follow `@latest`; if that tag moves after the plan was reviewed, consult those same files at the reviewed exact version instead.

## 1. Inspect before changing anything

Determine the current coding client from trusted session context; ask which client if ambiguous. Select exactly one client. Inspect the environment in **two passes**: discover command/manager locations without executing them, then identify already-installed concrete executables before checking OS/architecture and versions. Check the executable actually selected by PATH, not just a saved version-manager default. Do not dump native settings, receipts, backups, full PATH, environment variables or credentials into chat.

Select a runtime satisfying the resolved published package's **`engines.node`** before installing: the latest Node/LTS major is not necessarily compatible. Do not copy a Node requirement from an older guide or source checkout. A different installed Node version can remain untouched while Curator uses a compatible side-by-side runtime. Native Windows and WSL remain outside this installation workflow; a successful Node installation would not establish Curator/client support there.

**First pass — discovery only.** The following optional POSIX-shell probe uses shell builtins to report locations only. It never executes any discovered command, including `node`, `npm`, `prodero`, managers or `uname`. Run it in a known shell without sourcing arbitrary shell profiles. A found path is not proof that its target is installed or usable: it may be a lazy-install shim. Sanitize unexpected output before showing it to the user; these checks do not establish versions, package integrity or client connectivity.

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

`nvm` is normally a shell function, so an unloaded manager may not appear in a fresh shell. Inspect an already-known manager installation and its official documentation rather than interpreting a PATH miss as permission to install another manager. Do not source a repository's hooks or install scripts merely to discover versions.

**Second pass — identify before executing.** Inspect discovered paths and symlink/wrapper targets with trusted host file-reading tools; identify manager shims, shell functions/aliases, their selected version and whether that concrete version is already present. Do not run an unresolved PATH command, `--version`, `prodero status`, manager `exec`, or a wrapper to discover whether it will install something. For example, [mise documents automatic and lazy installation when a shim/command runs](https://mise.jdx.dev/dev-tools/#automatic-installation); an invocation named `node --version` can therefore mutate the environment before consent.

Obtain OS/architecture from trusted host metadata or an identified concrete system utility. Check versions only with a known concrete **already-installed** executable, or an invocation-local no-install guard verified in the current documentation of the installed manager and covering its lazy-install/update/hooks behavior. This guide supplies no generic guard flag; do not guess one, change manager settings, activate a shell, or assume that disabling one auto-install option disables lazy tools. If no safe check is established, report the version as **unknown** and include that unresolved prerequisite in the reviewed plan/manual step instead of executing the shim. Keep **missing**, **found but unverified**, and **verified check failed** distinct.

For npm scripts, use the identified matching already-installed Node binary and known bundled npm entry when necessary, rather than a PATH shim. Once that installation is verified, read its version, intended npm prefix and Curator status/help. All later command examples are shorthand for this verified concrete installation/scoped runner; do not fall back to unresolved PATH commands. Inspect the verified existing CLI help first. Use `prodero status --json` only when that interface is advertised. If an older installation lacks it, report the manual inspection step rather than sending an unsupported flag or upgrading silently. No pre-consent version/status/help probe may trigger downloads, installation, automatic updates or project hooks.

| Client / platform | Assisted setup boundary |
| --- | --- |
| Codex CLI on macOS | Managed adapter; historical native installation/runtime checks exist. Use client ID `codex`. |
| Codex desktop on macOS | Uses Codex native settings; manual maintainer check reported. Saved configuration does not prove desktop connectivity or Apps rendering. Use `codex` only after confirming it is the intended configuration. |
| Claude Code on macOS | Experimental managed adapter. Use `claude`; report the experimental label. |
| Codex CLI / Claude Code on Linux | Repository tests exist on Ubuntu; native host installation/connectivity is not certified by those tests. Offer the manual wizard with this limitation, without claiming verified host support. |
| Cursor, Claude Desktop, mobile-only or other clients | No managed installation adapter in this workflow. Do not invent paths or write their configuration. Link to the manual setup/compatibility guides and report unsupported. |

Honor absolute HOME/client overrides already in effect. Do not replace them to evade a path refusal. For a linked/source checkout, alternative package manager or intentional dev runtime, preserve the existing setup and explain the appropriate manual/package-manager path. Do not silently switch runtime mode, reinstall its toolchain or replace the runtime under an existing client connection.

## 2. Review the installation plan

Present **one concrete plan** covering the prerequisite steps needed, the exact published Curator package, the npm prefix/absolute CLI location, and the selected client's MCP settings/global launch instruction. Clearly separate these three stages: **prepare Node/npm**, **install/configure Curator**, and **optional project initialization later**. List the exact versions, sources, target directories, invocation-only PATH/runner and persistent files that would change. Reuse existing compatible tools; no prerequisites need changing when they already work.

If Curator is absent, propose installing the exact version resolved from `@latest` into the current user's inspected npm prefix. Record that validated version as `CURATOR_VERSION` for the apply step, never as `latest` or a version range. If that prefix is not safely writable, propose a new dedicated user-owned prefix and absolute CLI path instead of sudo, ownership changes or editing `.npmrc`. Do not collect npm tokens or other credentials; authentication/privilege requests follow normal host approvals. If Curator is already installed, inspect/reuse it; this guide does not authorize an upgrade, downgrade, runtime switch or relocation of that installation. Explain any such additional change separately.

### Preparing missing or incompatible prerequisites

Node's normal installation includes npm; a missing/broken npm command does not by itself require a second package manager. The [npm installation guide](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm/) describes version managers and the bundled Node/npm installation. Use the following decision order:

| Current evidence | Proposed preparation |
| --- | --- |
| Compatible Node and working npm from the intended installation | Reuse them. Verify the selected paths and npm prefix; make no runtime changes. |
| Node/npm absent, or current Node is outside `engines.node` | First look for an already-installed compatible version in the user's existing manager. Use an explicit-version scoped runner/absolute Node path, preserving the current/default version. If none exists, propose installing an exact compatible version side by side using the inspected manager only when its documented effects fit the approved plan; otherwise use the isolated official-archive route below. |
| Compatible Node exists, npm is missing, fails, or resolves to a different/broken installation | Inspect that Node installation's known bundled npm location and verify it with that exact Node. If healthy, use the matching runner/paths for this invocation. If bundled npm is absent or broken too, propose a separate verified Node+bundled-npm installation; do not overwrite the existing Node, repair arbitrary symlinks, or try `npm install npm` through a broken command. |
| Existing Curator/dev/linked runtime | Inspect and preserve it. Do not hide it behind a new CLI/PATH entry or change its host registration merely to prepare another runtime. A repair/migration requires a separate concrete plan. |
| OS/architecture/runtime provenance is unknown, or no supported verified binary/manager path is available | Stop that preparation step with a concrete manual action: choose a published Node release satisfying the resolved `engines.node` in the official Node archive, install it with the user's normal supported manager, then report its absolute Node/npm paths and rerun inspection. Do not claim setup success. |

Prefer the user's existing manager, but inspect its current official instructions before proposing its install command. For example, [`nvm exec` with an explicit installed version](https://github.com/nvm-sh/nvm#usage) scopes command execution; it does not require writing `.nvmrc` or selecting a new default. **An `nvm install` can create a default alias and install default packages**, so it is not an invisible substitute for scoped execution. Do not change manager defaults, run automatic package migrations/hooks, write `.nvmrc`/`.tool-versions`/`package.json`, or install/update a manager itself without describing those effects and obtaining consent. If those effects cannot be bounded, choose the isolated route or the manual step.

For a new isolated runtime on a supported macOS/Linux machine, select an exact published Node release satisfying the resolved `engines.node` and the official binary matching OS/architecture from the [Node release archive](https://nodejs.org/en/download/archive). Resolve the exact release first, then use its immutable `https://nodejs.org/dist/vVERSION/` directory; do not execute a mutable `latest` download. Download the archive and its checksum manifest separately over HTTPS, verify the archive against the exact manifest entry, and follow [Node's signed-SHASUM verification](https://github.com/nodejs/node#verifying-binaries) with trusted release keys when available. A failed/missing verification blocks extraction/execution. Do not use an unofficial mirror, source build, package-manager hook or `curl | sh` as a fallback.

After approval, extract only the verified official archive into a **new, absent, user-owned versioned directory**, for example `~/.local/share/prodero/runtimes/node-vVERSION-OS-ARCH`. Check the archive's member paths before extraction and reject absolute paths or `..` traversal. Never overwrite an existing directory or remove another runtime. Keep that directory for the persistent MCP launcher; do not register a temporary download directory. Use its absolute Node path and matching bundled npm with PATH limited to the relevant command/subshell. Do not change the user's global PATH, shell profiles, manager aliases or login defaults. A separately approved user-owned npm prefix may hold Curator; invoke its verified absolute CLI path rather than relying on a new shell-profile entry. The managed MCP adapter saves the needed absolute executable and Node launch path. Do not promise that a custom-prefix installation qualifies for the built-in updater; retain the exact package-manager command/prefix for maintenance.

If downloading or extracting needs unavailable verification tools, platform libraries or elevated privileges, explain the exact missing requirement and offer the manual step. Do not bootstrap another chain of tools or broaden the approved plan silently.

Inspect `prodero install --help`. When it advertises `--host` and `--dry-run`, use:

```sh
prodero install --host codex --dry-run --json
# For Claude Code, replace codex with claude.
```

Treat JSON and the exit code as evidence; an error is not absence. Show the selected client, package version/location, native MCP settings and minimal global launch instruction to be changed, preservation of unrelated settings, and local private backups. This does not initialize a repository. Ask for confirmation of the concrete combined plan before changes unless the user already explicitly approved it. If Node/Curator is absent and a CLI preview cannot yet run, explain that the MCP stage must be verified after the earlier approved steps. Do not ask again when that preview merely confirms the same approved paths/effects; a new persistent effect, conflict or changed installation target requires a revised plan and consent.

The installer configures one `prodero` MCP entry and a minimal global launch instruction; it owns configuration changes. Do not hand-edit native JSON/TOML, create another `prodero`/`prodero-dev` entry, add fixed repository roots or copy project lifecycle rules into global instructions.

If status shows installed/already configured, avoid reinstalling. Preserve intentional development mode. Conflicted, external-incomplete, unsupported-configuration and recovery-required states block automatic repair. An externally configured `prodero-dev` is an existing manual setup, not permission to install a duplicate or adopt it.

## 3. Apply only the reviewed action

Perform only the approved prerequisite preparation first. Verify the **actual selected** Node version against `engines.node`, absolute executable and npm location/version using the planned scoped runner. Verify npm can inspect the intended prefix, and record which new directories were created. A downloaded archive or successful manager exit alone is not a working runtime. If verification fails, stop before npm package or MCP changes; keep the old environment intact, report the partial result and do not delete/retry uncertain installations blindly.

Install the package only when absent and authorized, using that verified runtime and npm prefix. Set `CURATOR_VERSION` to the validated exact version already reviewed in the plan, then use the pinned command below (with the approved `--prefix` if needed). Do not resolve `@latest` again at this step or substitute a newer target without a revised plan. Registry failure is a blocker, not permission to change versions or sources.

<!-- curator:pinned-install:start -->
```sh
: "${CURATOR_VERSION:?Set CURATOR_VERSION to the exact stable version approved in the plan}"
npm install --global --registry=https://registry.npmjs.org/ --engine-strict --omit=dev --ignore-scripts "@prodero/curator@$CURATOR_VERSION"
```
<!-- curator:pinned-install:end -->

Verify the installed package/CLI version equals `CURATOR_VERSION` before changing client configuration. A mismatch blocks configuration and must be reported. Then re-inspect status/help and the dry-run, since installing the package can change available commands. Continue the already-approved plan when its effects match; do not restart the consent loop for each dependency. Any additional privilege, shell/default change, credential flow or new target still follows the user's normal approval controls.

For a CLI with targeted installation support, after the plan is confirmed:

```sh
prodero install --host codex --yes --json
```

`--yes` acknowledges the selected host's MCP settings/global instruction changes; it is not a blanket approval for further actions. Follow normal tool/sandbox approvals. Never pipe automatic answers into a wizard, bypass a rejection, disable approval controls or request credentials.

**Older CLI fallback:** if the installed CLI does not advertise targeted flags, use only its interactive `prodero install` wizard. Do not send unsupported flags to it. Ask the user to run the existing wizard, select only the reviewed client, confirm and Finish. If the agent has an interactive terminal and can relay the wizard faithfully, it may carry out that already confirmed selection; never infer menu numbers from an earlier screen. Without an interactive terminal, report the exact pending step rather than claiming completion. The manual setup route remains available throughout.

On failure, stop the dependent step and show a sanitized diagnostic and recovery guidance. Re-read status before retrying an uncertain outcome. The deterministic installer rejects malformed/duplicate settings, symlinks, unowned entries and edited owned blocks, retains private originals, and avoids writes on unchanged reruns. Never delete another MCP entry or remove a pending journal/lock automatically. Use the recovery guide for manual reconciliation. Backups can contain full settings, including credentials: keep them local and never upload them. `prodero uninstall codex` (or `claude`) removes only the managed integration after the user requests that rollback; it preserves projects and the npm package.

## 4. Verify and report honestly

Re-read status using the interface confirmed in step 1 (`prodero status --json` when advertised). An installed state means **saved configuration**, not a running or authenticated connection. Do not automatically close the current client or interrupt active work. Tell the user to restart/reconnect the selected client when ready.

After reconnect, use the client's actual tool discovery and, where available, `prodero_instructions_read` to verify this server is connected. Do not launch a second standalone server and call that proof of the client's connection. If the client cannot yet expose tools, report **restart/reconnect pending; connectivity unverified**. Report client/tool errors separately from configuration success. Do not claim Apps rendering, authentication or full lifecycle success from a status command.

End with: prerequisite runtime reused/prepared/blocked (exact Node/npm paths and versions); selected client; installed package version/prefix; configuration changed/already configured/blocked; restart status; connectivity evidence or unverified reason; exact next step. Separate a successful prerequisite stage from an incomplete package/MCP stage. Use the actual CLI/package version when testing a locally supplied candidate; report its archive identity and unpublished status. A candidate version alone is not proof of npm publication.

## 5. Project setup is a separate choice

Installation must not run `prodero init`, initialize `.prodero`, edit project `AGENTS.md`/`CLAUDE.md`, import memory or change Git. After the connection is verified, offer opening Prodero in the user's selected repository. A new project's initialization and generated files require their own explicit review/choice. Claude Code's project `CLAUDE.md` import of `@AGENTS.md` is likewise a separate project edit. Preserve existing project knowledge and instructions.

For **Claude Code**, guide this last step in chat instead of sending the user away to the host reference. After the user chooses project initialization through Prodero, check whether the project's `CLAUDE.md` already imports `@AGENTS.md`. If it does not, present a small project edit adding that import on its own line (or creating `CLAUDE.md` containing that line). Apply it only within the user's approved project-setup scope. Preserve existing instructions and avoid duplicate imports. Claude Code does not automatically read `AGENTS.md`; a successful global install alone does not complete project lifecycle setup. If the project edit is not authorized or cannot be made, report it as the exact pending step. Do not move project lifecycle rules into the global launcher.

## Manual documentation

- [Host installation, recovery and CLI reference](docs/hosts.md)
- [Compatibility and verification scope](docs/COMPATIBILITY.md)
- [Project recovery](docs/RECOVERY.md)
