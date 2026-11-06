# Installation through a prompt

The landing page uses one primary **Install with your agent** prompt for Codex and experimental Claude Code. Manual npm/CLI installation remains available in the documentation. The repository-owned source is [`setup.md`](../setup.md). The website is deployed separately; a Curator commit does not deploy it or publish an npm package.

## Landing Copy prompt handoff

Show the prompt as one line with a Copy button at the right. Both clients use the same guide; keep Claude Code experimental in the nearby compatibility text. Copy exactly:

```text
Install Prodero Curator using https://prodero.io/curator/setup.md
```

`https://prodero.io/curator/setup.md` is the permanent address on the project's own domain. The `/curator/` namespace leaves other products free to host their own guides at `/<product>/setup.md`. The repository-owned candidate source remains `setup.md`; a reviewed release/tag URL is a fallback after that revision exists. Do not use a guessed tag or npm version.

The existing landing site is a separate Next.js project. Its minimal static publication path is `prodero-site/public/curator/setup.md`, served at `/curator/setup.md` on the existing domain. This needs no new subdomain, DNS record, MCP server or installer API. The static guide already exists at that path; update the existing file without adding a duplicate route. Recheck rewrites and redirects against the selected production revision before shipping. Verify the production branch/deployment target before shipping; this Curator checkout does not deploy that site.

For the 0.3.0 handoff, first publish and verify the exact npm package and reviewed repository documentation. Then update the existing hosted guide, verify its exact production response and links, and deploy the landing Copy prompt under the website publication authorization. Until 0.3.0 is publicly available, keep the live guide on 0.2.1 with its wizard/capability fallback. Changes to the guide are installation-policy changes and require review even when only a static file is deployed.

Serve UTF-8 Markdown/plain text over HTTPS without login or a JavaScript requirement. Rewrite the guide's relative `docs/` links to reviewed published repository documents, or host those documents too; otherwise they resolve to nonexistent paths on the branded domain. Use revalidation rather than an immutable cache for this stable URL. Before enabling Copy prompt, fetch the exact production URL, check the response type and contents against the reviewed artifact, verify the documentation links and test the published package's actual help/wizard path. Keep the README and landing prompt identical, and test that Copy preserves the exact guide URL.

## Historical 0.2.1 guide publication

The separately approved website publication added only `public/curator/setup.md` to `0leg-K/prodero-site:main` in commit `51daca10c12a5f83d5c23d0d92bfb5e89878c610`. Vercel reported a successful production deployment. The permanent URL returned HTTP 200 with `text/markdown; charset=utf-8`, no authentication or JavaScript requirement, and all 18,056 bytes matched the reviewed 0.2.1 guide (SHA256 `0242c1975b727087bba10cf687f897ce422ab0fd1826ee09d71b5a146cd3c75c`). The three linked v0.2.1 repository documents returned HTTP 200. No 0.3.0 npm package was released, and the landing page's Copy action was not changed.

## Current stable website — 2026-11-06

The separately deployed website commit `20aadb4` provides the one-line Copy prompt and a shared Codex/experimental Claude Code guide. Read-only production fetches returned HTTP 200: the page contained the prompt and Copy control with no old Claude Code setup link; the 19,997-byte Markdown guide had SHA-256 `0cb5361650e10a0d072629e7033b69d4cbcc3c793130c2f905adf3282d9e249f` and still targeted published 0.2.1. This check confirms response contents, not browser clipboard interaction. Preserve its Claude project-import guidance and legacy CLI capability guards when updating the hosted guide for 0.3.0.

## Targeted CLI contract (0.3.0)

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
