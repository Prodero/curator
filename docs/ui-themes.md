# Built-in UI themes (v0.1)

Appearance is a canonical project preference (`presentation.theme` in `.prodero/config.json`). The compact **Appearance** disclosure above the main App contains seven native radio choices with palette swatches. It remains mounted outside `#app`, so changing appearance neither rerenders a screen nor discards form drafts. Keyboard users can tab to the picker and use arrow keys within its radio group.

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

The selected ID is saved for the current project through `prodero_config_set`, using the same canonical validation and atomic storage as chat updates. The old global browser storage key is ignored because it cannot be attributed to a project. Missing project preferences use Current / Prodero. Failed saves retain the last applied theme and explain the failure. Separate projects can display different themes simultaneously; late saves cannot recolor another project.

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

If Playwright is provided by the host runtime instead of local dependencies, set `PRODERO_PLAYWRIGHT_MODULE` to its importable module path. Optional `PRODERO_THEME_SCREENSHOTS` names an existing output directory. The browser test uses the production UI modules with only the MCP bridge stubbed, exercises all themes on status, knowledge, lifecycle, promotion and skills, tests keyboard selection and live System changes, checks text/semantic contrast and narrow layouts, compares default screenshots against the pre-theme stylesheet, and uses an initialized Git fixture to check that theme saves change canonical configuration without changing knowledge or other canonical artifacts. Browser storage is no longer used. The optional browser suite is separate from the full Node test suite.

The browser suite also verifies distinct actual page, panel, card, border and gradient colors for all four neon themes with no active controls, surface elevation, contrast across all surface levels, hover/focus tokens and absence of content glow. Screenshot output includes `all-themes.png` and `neon-comparison.png` for side-by-side reading-surface review.
