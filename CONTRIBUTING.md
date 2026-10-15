# Contributing and support

Use Node 22.14+ within 22.x, npm and Git. Run `npm ci` then `npm test`; tests rebuild the server and Apps before executing. Run `npm run release:gate` for packaging/isolated-install changes. Keep fixes small and include a regression test for changed persistence or tool contracts.

Preserve canonical `.prodero` data, Local/Versioned boundaries, secret screening and exact preview/review workflow safeguards and user review of repository changes before commit/push. Do not commit local sessions, caches, checkpoints, credentials or private project knowledge. Tests should use temporary repositories, not your working project's memory.

Once the repository is public, use its GitHub Issues for reproducible bugs and feature requests. Include Prodero/Node/OS/host versions, the command or tool, expected/actual behavior and a minimal synthetic reproduction. Redact project data and secrets; do not attach your whole `.prodero` directory. For vulnerabilities follow [SECURITY.md](SECURITY.md) instead.

There is no response-time or compatibility SLA during Public Preview. Please discuss broad changes before implementing them. Contributions are under the existing MIT license.
