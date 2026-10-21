# Built-in UI themes

Appearance is a personal preference on the current checkout. Theme and display mode overrides are stored in the ignored, independently versioned `.prodero/local/preferences.json`; shared project configuration remains tracked. The compact **Appearance** disclosure above the main App contains seven native radio choices with palette swatches. It remains mounted outside `#app`, so changing appearance neither rerenders a screen nor discards form drafts. Keyboard users can tab to the picker and use arrow keys within its radio group.

- **Current / Prodero** is the default, with the original green-black gradients, lime identity, surface colors and typography.
- **Dark Neon** is the darkest variant: almost-black foundations, graphite-black elevated surfaces and restrained ice-blue edge light.
- **Pink Neon** uses black/plum foundations, deep wine surfaces, hot pink/magenta accents and a faint warm gradient.
- **Blue Neon** uses midnight navy-black foundations, deep blue surfaces, electric blue/cyan accents and cold ambient light.
- **Purple Neon** uses violet-black foundations, aubergine surfaces, violet/ultraviolet accents and a restrained purple gradient.
- **Light** uses pale neutral surfaces, dark text and a deep green accent.
- **System** resolves to Light or Dark Neon, preferring the MCP host's light/dark context over the browser media query. Without either signal it resolves to Prodero.

## Structure

`src/settings-definition.ts` holds the shared theme catalogue and validation. `src/ui/themes.ts` holds the browser controller and picker. `src/ui/themes.css` defines exact legacy semantic shade values, shared variant roles and built-in overrides. `src/ui/style.css` consumes those variables without theme branches. Numbered shades preserve the original subtle color differences; new palettes map them to a small set of primary/secondary/muted text, surfaces, borders, accent, on-accent, info, success, warning and error roles. Focus, hover, selected state, glow, graph/relationship decoration and Local/Versioned labels all use tokens. Long-form text has no added glow. New variants need a catalogue entry and token overrides, not component changes.

The four neon palettes separately define page, primary, elevated and tinted surfaces; subtle and control borders; primary/secondary accents; selection, hover, focus, glow and shell gradients. Solid reading surfaces remain unlit. Semantic success/warning/error colors retain their meaning within each atmosphere. The picker swatches reflect each foundation. Neon-only selectors leave Prodero and Light unchanged.

The original theme's low-emphasis text colors are deliberately unchanged. New themes use higher-contrast muted text and separate semantic colors; layer labels retain their textual names so color is not the only distinction.

## Persistence and host boundaries

The selected ID is saved for the current checkout through `prodero_config_set`, using the same validation as chat updates and owner-only atomic local storage. The Appearance disclosure shows whether the effective value is a local override, legacy project default or built-in default; when an override exists, **Use project/default setting** removes only that local theme field. Chat can reset either presentation field with `reset:true` and no `value`; reset with a value, reset of the context budget and null values are rejected. The old global browser storage key is ignored because it cannot be attributed to a project. Each field resolves independently: an explicit invocation mode (where supported), then a valid local field, then the legacy `.prodero/config.json` presentation field, then the built-in default. Theme defaults to Current / Prodero; mode defaults to Automatic. Explicit System/Automatic values are real overrides, not missing fields. Reads never create or copy preferences or rewrite shared config; theme/mode saves never write shared config or repair root ignore rules, even for same-value saves. Private self-excluding `local/.gitignore` and `.transactions/.gitignore` protect preferences and lock files if root exclusions are absent; existing unsupported/custom nested rules are preserved and saving fails with repair guidance instead of rewriting them. Reset reveals fallback rather than copying it. Failed saves retain the last applied theme and explain the failure. Separate checkouts/projects can display different themes simultaneously; late saves cannot recolor another project.

The local file format is `{ "version": 1, "presentation": { "mode": "text", "theme": "dark-neon" } }` (an example, not a default or migration). Context budgets, schema/runtime metadata, project identity and knowledge-engine policies remain shared config. Known policy/identity overrides are rejected in local preferences; unknown extensions round-trip without becoming effective settings. Existing MCP tool IDs, setting keys and effective `projectSettings.presentation` remain compatible. Effective settings are read per resolved project on every request; one-off text display never saves a preference.

A missing local file is ordinary fallback. Corrupt/unsafe/newer local files produce a safe code, cause and recovery guidance without echoing contents. Valid sibling fields can resolve independently when one known field is invalid, but saves/reset refuse to overwrite the damaged file. Newer local versions fall back entirely. Preserve the file and repair explicitly or use a compatible runtime. Writes retain initialization/canonical-schema/interrupted-migration gates, use the common Sync/migration lock and do not recover pending knowledge lifecycle transactions as a side effect of a theme save. Existing re-init, integration refresh and migration/recovery retain preferences.

There is no automatic cleanup or migration of legacy shared presentation fields. They remain fallback defaults, including an existing dirty choice; no blanket ignore/reset of `.prodero/config.json`. Optional removal would require separate reviewed work. Older runtimes ignore the local file and may still read/write `config.presentation`, creating a tracked diff; this is the downgrade limitation. No dual-write is used to disguise it. Preferences are per checkout, not synchronized across machines/worktrees, and are not a security boundary against the connected agent.

Browser preference changes are observed using `matchMedia`; host preferences use `getHostContext()` and `onhostcontextchanged`. Partial host notifications do not clear a known preference. Explicit themes ignore both signals. A host that reports no system preference falls back to browser detection. Separate plugin-owned MCP Apps have independent styles and are outside the main App's document; this feature does not impose styles on third-party plugin documents.

## Verification

Run `npm run build`, `npm test`, and the explicit UI typecheck:

```sh
npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM,DOM.Iterable --strict --skipLibCheck src/ui/main.ts
```

Focused controller/default-style tests are included in `npm test`. Browser checks use Playwright with Chromium available in the development environment:

```sh
node --test test/themes.browser.mjs
```

If Playwright is provided by the host runtime instead of local dependencies, set `PRODERO_PLAYWRIGHT_MODULE` to its importable module path. Optional `PRODERO_THEME_SCREENSHOTS` names an existing output directory. The browser test uses the production UI modules with only the MCP bridge stubbed, exercises all themes on status, knowledge, lifecycle, promotion and skills, tests keyboard selection and live System changes, checks text/semantic contrast and narrow layouts, compares default screenshots against the pre-theme stylesheet, and uses an initialized Git fixture to check that theme saves change only ignored local preferences, with shared config and knowledge preserved and Git clean. Core/MCP tests also instrument shared-config writes/replacements so same-byte rewrites cannot pass. Browser storage is not used. The optional browser suite is separate from the full Node test suite.

The browser suite also verifies distinct actual page, panel, card, border and gradient colors for all four neon themes with no active controls, surface elevation, contrast across all surface levels, hover/focus tokens and absence of content glow. Screenshot output includes `all-themes.png` and `neon-comparison.png` for side-by-side reading-surface review.
