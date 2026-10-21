# Release candidate gate

From a clean checkout on Node 22.14+ (22.x):

```sh
npm run release:gate
```

## CI tiers and local commands

| Trigger / command | Tests | Pack and doc links | Installed-artifact checks |
| --- | --- | --- | --- |
| Branch push or pull request | Ordinary suite, Ubuntu / Node 22.14.0 | Always | Required except for explicitly documentation-only changes |
| Any tag push or `workflow_dispatch` | Full suite, Ubuntu/macOS × minimum/latest Node 22 | Always | Always |
| `npm run ci:fast` | Ordinary suite | Always | Omitted |
| `npm run ci:fast -- --integration` | Ordinary suite | Always | Included |
| `npm run release:gate` | Full suite | Always | Included |
| `npm test` | Full suite after build | Not a package gate | Not a package gate |
| `npm run test:fast` | Ordinary suite after build | Not a package gate | Not a package gate |

Before creating a release, manually dispatch **Release gate** on the intended
commit and verify all four jobs against that exact SHA. A tag push also runs the
full matrix; neither check publishes a package or creates a GitHub release.
A successful fast run alone does not certify a release.

`test/scale/` explicitly owns the seven large-fixture tests (10,000-memory
intelligence, context/status/discovery scales, 20,100-file importer boundary and
retention histories). Their assertions and fixture sizes are unchanged. The
recursive runner includes every `*.test.mjs` below `test/` in full mode; every
suite outside `test/scale/` defaults to ordinary, including newly added suites.
Optional `*.browser.mjs` checks remain separate, as before. Fast mode runs at most
two test files concurrently; full mode retains one. Both fail on any selected
test failure. Partition and workflow-policy regression tests run in both modes.

Path classification is conservative: only the named top-level Markdown files,
LICENSE, `docs/*.md` and `docs/images/*.png` may omit installed-artifact checks.
Any other path (including core, installer, MCP, UI, plugins, managed instructions,
package manifests, workflow, runner or tests), mixed changes, missing/zero base,
or diff failure requires them. Both sides of renames are classified. PRs compare
the base SHA with the checked-out merge result; pushes compare the previous SHA
with HEAD. All branch/PR changes still run ordinary tests and package validation.

Superseded runs are cancelled only within the same branch or PR group. PR groups
use PR numbers to avoid collisions between fork branch names. Manual and tag
runs use unique run IDs and cannot cancel, or be cancelled by, branch/PR runs.

The gate copies tracked working files plus non-ignored new files into a clean
temporary checkout (never node_modules/dist), runs `npm ci`, builds **once**, then
packs and validates package resources, secret/path screening and documentation
links **before** running tests. It skips npm pack lifecycle scripts only because
the gate explicitly controls build/tests; successful completion requires both.
Ordinary `npm pack` still runs the full tests through prepack.

When integration is required, the gate installs that same tarball into a separate
prefix with production dependencies only, takes the build checkout offline and
runs the existing standalone smoke runner against the installation. CLI, stdio
MCP, bundled resources, the knowledge lifecycle, Git boundaries, restart and
synthetic manual upgrade preservation remain checked. The smoke runner's
synthetic patch version is only an isolated test fixture, never a publication.

`result.json` records mode, whether integration ran, total elapsed time, each
child-command duration, artifact path and SHA-256. CI uploads these results and
logs with the tarball. Measure fast and full runs separately; runner performance
and the filesystem-heavy fixtures make local and remote times different.

For host-integration verification, use a fresh temporary directory outside the real user home, an isolated HOME and Codex/Claude/XDG configuration, and no inherited host registrations. Keep custom `PRODERO_GATE_OUTPUT` paths outside real-home ancestry: normal workspace checks inspect ancestors and can correctly report `HOST_SCOPE_CONFLICT`. Never disable those checks or alter real settings to make a smoke test pass.

CI allows 30 minutes for the fast job and 45 minutes per full matrix job. Child-command output is streamed to the console and written continuously to evidence logs, so cancellation retains partial test diagnostics. The limit remains finite; a timeout is not a passing check.

Gate outputs and the tarball remain in the printed temporary directory for inspection. Nothing is published. Full CI repeats the gate on macOS/Ubuntu and the declared minimum/latest Node 22. Remote CI results must actually pass before those targets are certified.

A protocol runner is not a real host. Independently connect a primary host to the **installed artifact** in a synthetic Git project, run open/init/prepare/record/close/next prepare/remember/search/edit/restart, inspect tool results and Git status, and record host/runtime/artifact versions. Review promotion outcomes and approve only the intended synthetic fixture publication. Apps rendering needs its own host check.

## Install the artifact for review

For an unpublished candidate, install the reviewed tarball into an isolated prefix rather than requesting its version from the registry. The current candidate version is 0.2.0; this command is an example for a separately authorized isolated environment, not a request to replace the working installation:

```sh
npm install --global --prefix /absolute/isolated/prefix --omit=dev --ignore-scripts /absolute/path/prodero-curator-0.2.0.tgz
```

Use the isolated host environment described above for automated verification. For a deliberate real-host check, review the installer’s configuration changes and restart the selected coding agent. Open a synthetic project and type `prodero`. The tarball includes the compiled server, Apps and plugin resources; no source checkout or development dependencies are needed.

## Final human publication checklist

1. Finalize version, changelog/date and README in the intended release tree before freezing the candidate. Independently audit it, review diffs, run the full gate on the exact committed tree and obtain green declared CI matrix runs. Record artifact SHA-256 and primary-host evidence. Any packaged-content edit afterwards requires a new tarball and matching checks.
2. Review the intended public Git tree **and history** for private content. Ignoring runtime files today does not remove old commits. Decide explicitly what history to publish; never rewrite it automatically.
3. Confirm ownership of npm scope `@prodero`, package/repository identity `@prodero/curator` / `prodero/curator`, and permission to release. A registry 404 does not establish scope ownership.
4. Create/configure the intended public repository only with explicit approval. Enable Issues and private vulnerability reporting; verify the links and update any identity/channel changes in docs and package metadata.
5. Confirm candidate version `0.2.0`, MIT license, final changelog date, preview limitations, README registry example and exact artifact contents. If any edit is still needed, return to step 1 and certify the new artifact. Obtain explicit approval for publication.
6. Authenticate npm with the account's required 2FA/provenance policy. Publish the **reviewed tarball**, not an unreviewed rebuild: `npm publish /absolute/path/prodero-curator-0.2.0.tgz --access public`.
7. Verify external `npm install --global @prodero/curator@0.2.0`, `prodero --version` and `prodero check-update`. Only with separate approval create/push the `v0.2.0` tag and release notes or announcements.

The automated gate does not publish or push and does not change the source repository history. It creates an isolated disposable test commit in its temporary checkout. Package upgrades do not move project knowledge. Back up the full `.prodero` directory before preview upgrades; `.cache` is disposable, migration recovery backups are not.

## Terminal updater acceptance

Test the installed `prodero update VERSION` in an isolated prefix after explicit terminal acknowledgment, including non-TTY refusal/`--yes`, actual npm failures and fresh CLI/MCP verification. Record artifact/hash/version, scripts policy and unchanged synthetic project/host state. Published-release upgrade, fixture-modified candidate→published transition and same-version behavior are distinct claims. A direct npm install or the existing synthetic patch smoke does not alone exercise the updater. Never use the 0.0.0 placeholder as a functional baseline or update the maintainer’s working npm installation during automated checks. Chat/MCP checks must assert instruction-only behavior even with development release sources.
