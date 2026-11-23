# Chunk DM2b-insights-panel: CCIS insights panel in the case screen

_Needs: DM2a._ **Core rules:** attach `01-core.md`.
**Read only:** page code via `grep -n` for the case screen and storage adapter; the DM2a routes.

**Build:**
1. Panel "CCIS insights" on the case screen: list of imported runs (time, package id and version, engine version, who imported). Open one: outputs by kind, each with value or its declared state (indeterminate, not enabled, missing data), warnings, limitations, missing-data notes, parameter list showing enabled or disabled.
2. Banner on every shown run: "Demo parameters are test-only placeholders, not clinical values" whenever any parameter is enabled; "Synthetic data, prototype" always.
3. Buttons: Import run record (file picker), Acknowledge (with optional note). The page never edits a result.
4. All text through the shared escaper; no inline handlers (CSP). Signed-out demo fallback shows nothing.
5. Page tests with jsdom, including a hostile string in a warning.

**Done when:** DEMO-SCRIPT steps 4 and 5 are possible in the browser with a fixture run record.
**Size guard:** page edit + 1 test file. Split list (DM2b-1) and detail (DM2b-2) if over about 250 lines.
