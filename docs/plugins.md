# Optional installation plugins

> v0.1 contract: Local/Versioned describe Git storage and sharing, not a security boundary against the connected agent. Review and approval are workflow safeguards, not authenticated human consent. The agent may create, promote and maintain Versioned files. Curator does not commit or push; users review repository changes before doing so. See [Privacy](PRIVACY.md).

Dependency direction: concrete plugin → public `PluginContext` → Core services.
Core does not import a concrete plugin or interpret its source system. LLMs and
plugins propose semantic changes; Core alone validates and mutates durable state.

The runtime scans only the installation's `plugins/` immediate child directories.
Each has a versioned `plugin.json` and one CommonJS `.cjs` entrypoint exporting
`{ actions: { actionName: { title, description, readOnly, run(context, input) } } }`.
Entrypoints are trusted local code; this is not a sandbox or a package installer.
No activation hook, project discovery write, model call or remote lookup occurs.
Restart the server after adding/removing a directory. Registry state is derived.

Minimal manifest:

```json
{"manifest_version":1,"api_version":1,"id":"hello","name":"Hello",
 "version":"1.0.0","description":"Example optional capability",
 "capabilities":["example"],"entrypoint":"index.cjs"}
```

```js
exports.actions = { hello: {
  title: "Hello", description: "Return a greeting", readOnly: true,
  async run(context) { return { greeting: "Hello", root: context.projectRoot }; }
} };
```

Optional `ui: { resource: "ui/dist/index.html", action: "hello" }` registers a
self-contained MCP App resource and a generated tool. UI implementations use the
existing MCP Apps SDK. Generic status lists contributions from the registry;
it contains no concrete plugin menu entries. A UI build script discovers plugin
`ui/index.html` inputs. Plugins without UI need no build step.

Malformed manifests, unsupported versions, entrypoint exceptions, missing UI and
action exceptions are isolated with plugin-specific diagnostics. Absent roots are
normal. Removing the directory removes its actions and UI after restart; existing
canonical knowledge remains readable without the plugin.

The public API is `src/plugins/api.ts`. It exposes bounded read-only source access,
plugin instruction assets, optional structured LLM calls, canonical state reads
and controlled import/verification services. No arbitrary write-path API exists.
Core uses existing knowledge/skill schemas, provenance and checkpoint transactions.
Plans/reports are portable returned JSON, never silently written into memory.
`context.screening.assertSafe(value)` and `context.screening.hasSecret(text)` expose
Core's existing best-effort credential policy. The bundled importer screens full
inputs, packets, plans, model output and responses, including excluded metadata,
and screens plans before caching and again on replay. Sensitive source paths
remain excluded by the existing file service; evidence validation and hashes are
unchanged. These services do not sandbox trusted installed plugins.

Distribution, registries, dependency resolution, sandboxing, hot reload and a
generic migration UI framework are deliberately outside API v1.

## Validation of the first implementation

Run `npm test` and [the release gate](RELEASING.md) for the current candidate. The package ships executable JavaScript, bundled Apps, instruction assets and public documentation; TypeScript declarations are not included.

Synthetic fixtures prove addability, removability, malformed/version/entrypoint/UI
failure isolation, tool-name collision rejection, and absence of concrete plugin
references across `src/`. Migration checks cover read-only audit, secret exclusion,
plan integrity, stale/contradicted/uncertain classifications, Core preflight,
source immutability, approval, deduplication, candidate/default skill behavior,
checkpoint replay/recovery, later lifecycle ordering and cache rebuilds.

The production UI handlers are exercised automatically, and a temporary browser
fixture exercised audit → exclude → review → apply → verify through real MCP
handlers with deterministic sampling responses. At 390px the layout had no
horizontal overflow. This does not establish semantic quality with a live model
or validate any company's real historical knowledge.

Known v1 limits: trusted installation code is not sandboxed; audits have explicit
coverage/size bounds; secret detection is conservative; exact same-boundary
content deduplicates deterministically while semantic duplicates depend on the
instruction-guided review. Both external source and repository integrity passes use the bounded exclusions below.
Plans are portable artifacts and must be retained for replay. The UI requires an
MCP Apps-capable host; unsupported hosts can use the same structured actions.

### Bounded file integrity services

`files.digest` returns `sha256-tree-v2`; `files.snapshot` uses the same bounded streaming traversal and external scope. Both exclude common sensitive paths, private Curator runtime state and Git-ignored files (including tracked matches via `check-ignore --no-index`). Limits are 20,000 files, 100MB, depth 32, 40,000 entries and 30 seconds per pass. Errors never return complete-looking partial results. Tool arguments cannot raise these ceilings. Core's separate canonical import-state snapshot deliberately includes required Local/session/checkpoint data for conflict and receipt checks. See [the importer integrity contract](../plugins/migrate_ai_studio/README.md#integrity-scope-and-limits-plugin-170) for exact scopes, Git/non-Git behavior, exceptions and compatibility.
