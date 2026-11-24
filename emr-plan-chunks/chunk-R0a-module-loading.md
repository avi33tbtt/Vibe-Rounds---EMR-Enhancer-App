# R0a: module loading under the CSP (no behaviour change)

Row: R0a (roadmap, from the R0 brief in `04-demo-and-roadmap.md`). Docs written first, then built.

**Context impact:** none. No envelope section, no schema change.

## Goal
Let `emr-enhancer.html` load code from separate files so R0b to R0e can move it out. Nothing the user sees changes.

## Decisions
1. Classic `<script src="modules/NAME.js">` files, not ES modules: the page must still work from `file://` (demo fallback), where Chrome blocks ES modules. Files share one global scope, loaded in order, before the inline script.
2. Same origin only: `script-src 'self' 'nonce-...'` already allows them. The CSP is not loosened.
3. One route `GET /modules/:file`, public like `/sdc.js`, file name must match `^[a-z0-9][a-z0-9-]*\.js$`, served only from `modules/`.
4. The nonce is still added to every tag the page has; `src` tags are fine either way.
5. Test helper `pageHtml()` inlines every local `<script src>`; new `pageSource()` returns the page plus all module code, so ratchet tests keep seeing all code.
6. Proof of mechanism: move the 3 tiny helpers `$`, `toast`, `tg` into `modules/00-boot.js`. Nothing else moves.

## Size guard
1 serve edit (app.js), 1 module, 1 helper edit, 1 new test file, matrix line, page edit of about 5 lines.
