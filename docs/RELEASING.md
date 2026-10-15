# Release candidate gate

From a clean checkout on Node 22.14+ (22.x):

```sh
npm run release:gate
```

The gate copies tracked working files plus non-ignored new files into a clean temporary checkout (never node_modules/dist), runs `npm ci`, build, tests, pack, then installs the tarball into a separate prefix with production dependencies only. Its standalone runner resolves SDK dependencies from that installation. CLI, stdio MCP, bundled resources, the knowledge lifecycle, Git boundaries, restart and synthetic manual upgrade preservation are checked. `npm test` rebuilds first; ordinary `npm pack` runs the full tests through prepack. The gate's pack skips lifecycle scripts only after its build/tests have passed.

For host-integration verification, use a fresh temporary directory outside the real user home, an isolated HOME and Codex/Claude/XDG configuration, and no inherited host registrations. Keep custom `PRODERO_GATE_OUTPUT` paths outside real-home ancestry: normal workspace checks inspect ancestors and can correctly report `HOST_SCOPE_CONFLICT`. Never disable those checks or alter real settings to make a smoke test pass.

CI allows 45 minutes per matrix job. Child-command output is streamed to the console and written continuously to evidence logs, so cancellation retains partial test diagnostics. The limit remains finite; a timeout is not a passing check.

Gate outputs and the tarball remain in the printed temporary directory for inspection. Nothing is published. CI repeats the gate on macOS/Ubuntu and the declared minimum/latest Node 22. Remote CI results must actually pass before those targets are certified.

A protocol runner is not a real host. Independently connect a primary host to the **installed artifact** in a synthetic Git project, run open/init/prepare/record/close/next prepare/remember/search/edit/restart, inspect tool results and Git status, and record host/runtime/artifact versions. Review promotion outcomes and approve only the intended synthetic fixture publication. Apps rendering needs its own host check.

## Install the artifact for review

Before the first npm publication, install the generated tarball instead of a registry release:

```sh
npm install --global /absolute/path/prodero-curator-0.1.0.tgz
prodero install
```

Use the isolated host environment described above for automated verification. For a deliberate real-host check, review the installer’s configuration changes and restart the selected coding agent. Open a synthetic project and type `prodero`. The tarball includes the compiled server, Apps and plugin resources; no source checkout or development dependencies are needed.

## Final human publication checklist

1. Independently audit the RC, review diffs, run the full gate on the exact committed tree and obtain green declared CI matrix runs. Record artifact SHA-256 and primary-host evidence.
2. Review the intended public Git tree **and history** for private content. Ignoring runtime files today does not remove old commits. Decide explicitly what history to publish; never rewrite it automatically.
3. Confirm ownership of npm scope `@prodero`, package/repository identity `@prodero/curator` / `prodero/curator`, and permission to release. A registry 404 does not establish scope ownership.
4. Create/configure the intended public repository only with explicit approval. Enable Issues and private vulnerability reporting; verify the links and update any identity/channel changes in docs and package metadata.
5. Confirm version `0.1.0`, MIT license, changelog date, preview limitations and exact artifact contents. Obtain explicit approval for publication.
6. Authenticate npm with the account's required 2FA/provenance policy. Publish the **reviewed tarball**, not an unreviewed rebuild: `npm publish /absolute/path/prodero-curator-0.1.0.tgz --access public`.
7. Verify external `npm install --global @prodero/curator@0.1.0`, `prodero --version` and `prodero check-update`. Only with separate approval create/push the `v0.1.0` tag and release notes or announcements.

The automated gate does not publish or push and does not change the source repository history. It creates an isolated disposable test commit in its temporary checkout. Package upgrades do not move project knowledge. Back up the full `.prodero` directory before preview upgrades; `.cache` is disposable, migration recovery backups are not.
