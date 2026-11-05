# Installation through a prompt

Prompt-assisted installation is additive. Keep **Manual installation** equally visible with the existing npm command and `prodero install` wizard. The repository-owned candidate source is [`setup.md`](../setup.md). The separately deployed stable guide targets published 0.2.1 and its existing wizard; this Curator checkout does not deploy the website or release a package.

## Landing Copy prompt handoff

Show two choices, **Install with your agent** and **Manual installation**. The published stable setup file is verified; the first choice can copy this text:

```text
Help me install Prodero Curator for my coding client using this guide:
https://prodero.io/curator/setup.md
Read it first, inspect my client and Node/npm setup, and show one concrete plan before applying changes. If prerequisites are missing, prepare them through the approved plan while preserving my existing versions, defaults and settings. Treat project initialization as a separate choice. Follow my normal approval controls and report any incomplete stage, restart or verification still pending.
```

`https://prodero.io/curator/setup.md` is the permanent address on the project's own domain. The `/curator/` namespace leaves other products free to host their own guides at `/<product>/setup.md`. The repository-owned candidate source remains `setup.md`; a reviewed release/tag URL is a fallback after that revision exists. Do not use a guessed tag or npm version.

The existing landing site is a separate Next.js project. Its minimal static publication path is `prodero-site/public/curator/setup.md`, served at `/curator/setup.md` on the existing domain. This needs no new subdomain, DNS record, MCP server or installer API. The inspected site has no matching route, catch-all route, static file, rewrite or redirect; recheck that condition against the selected production revision before shipping. Verify the production branch/deployment target before shipping; this Curator checkout does not deploy that site.

For an initial stable publication, target the actually published 0.2.1 package and its interactive wizard. Keep unreleased targeted flags out of that hosted stable guide, or retain them only behind a separately reviewed capability check; do not advertise a 0.3.0 package before it exists. Changes to the guide are installation-policy changes and require review even when only a static file is deployed.

Serve UTF-8 Markdown/plain text over HTTPS without login or a JavaScript requirement. Rewrite the guide's relative `docs/` links to reviewed published repository documents, or host those documents too; otherwise they resolve to nonexistent paths on the branded domain. Use revalidation rather than an immutable cache for this stable URL. Before enabling Copy prompt, fetch the exact production URL, check the response type and contents against the reviewed artifact, verify the documentation links and test the published package's actual help/wizard path. Then replace the README's supplied-file preview with the verified one-link prompt.

## Verified stable publication

The separately approved website publication added only `public/curator/setup.md` to `0leg-K/prodero-site:main` in commit `51daca10c12a5f83d5c23d0d92bfb5e89878c610`. Vercel reported a successful production deployment. The permanent URL returned HTTP 200 with `text/markdown; charset=utf-8`, no authentication or JavaScript requirement, and all 18,056 bytes matched the reviewed 0.2.1 guide (SHA256 `0242c1975b727087bba10cf687f897ce422ab0fd1826ee09d71b5a146cd3c75c`). The three linked v0.2.1 repository documents returned HTTP 200. No 0.3.0 npm package was released, and the landing page's Copy action was not changed.

## Targeted CLI contract (unreleased)

```sh
prodero install                         # existing human wizard
prodero install --host codex --dry-run --json
prodero install --host codex --yes --json
```

Use `claude` for experimental Claude Code. Select exactly one supported host and exactly one action. `--dry-run` is read-only; `--yes` acknowledges that host's saved MCP settings and global launch instruction changes. It does not install npm packages, close hosts, initialize projects or establish connectivity. No `--all`, force or inferred selection. Plain text is available by omitting `--json`. Invalid arguments and blocked states exit nonzero. Existing `status --json` remains the machine inspection API. Published 0.2.1 lacks targeted flags and retains its interactive wizard fallback; see `setup.md`.

The manager retains native parsing, bounded edits, ownership receipts, private backups, locks/journals, rollback and unchanged-install no-op behavior. Saved state is not connection status. Restart/reconnect and discover tools in the selected native client before claiming connection success. See [host support and recovery](hosts.md).

## Prerequisite preparation

The agent guide now prepares absent/incompatible Node and missing/broken npm after one reviewed plan, rather than unconditionally stopping at a missing command. This is prompt orchestration; the targeted MCP CLI remains a configuration operation and does not install Node/npm itself.

The plan separates prerequisite directories/runtime selection, the npm package/prefix and persistent MCP/global instruction changes. Project initialization remains outside it. An unchanged later CLI preview can confirm that already-approved scope without another question; new effects or privileges need an updated decision.

Selection uses the chosen package's `engines.node` (currently `>=22.14.0 <23`), not whichever Node LTS is newest. Reuse a compatible version already managed by the user with an explicit invocation-scoped runner. Before installing another version, inspect the manager's documented alias/default-package effects; otherwise propose a verified official Node binary in a new user-owned versioned directory. npm normally accompanies Node. A compatible Node with a broken or mismatched npm should first use its verified bundled npm, then a separate Node/npm installation if needed; never repair or overwrite the existing runtime silently.

The guide starts with a discovery-only POSIX probe that works without Node/npm and never executes discovered commands. A second pass identifies concrete already-installed binaries or a currently documented invocation-local no-install guard before any version/status/help check. This prevents a PATH shim's lazy installation from bypassing the prerequisite plan; unresolved versions remain unknown until a safe check or approved preparation is possible.

Fixture tests execute that exact first-pass block with isolated PATH/HOME. They cover missing tools, conflicting PATH candidates, manager/functions, existing linked/dev CLI and hostile lazy-install shims that would create a sentinel if invoked. The snapshot/sentinel assertions prove this discovery pass does not execute them or change fixture runtimes/configuration. They do not certify second-pass manager guards, version compatibility, an actual Node installation, manager lifecycle, native-client connection or unsupported-platform compatibility. Official source/verification links live in `setup.md`; no real runtime, defaults, shell profile or global client is changed by the tests.

## Verification boundary

Automated tests should exercise prerequisite discovery under isolated PATH, dry-run immutability, explicit acknowledgment, selected-host isolation, repeated no-op, invalid/unowned/edited settings refusal, interrupted recovery, and preservation of unrelated client/project files using temporary HOME fixtures. Package checks must include this guide and root `setup.md`, validate documentation links, and exercise the command from a packed production artifact. Record exact results in the local verification evidence; do not label simulated fixtures as native-client checks.
