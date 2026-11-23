# Chunk DM3c: Run the CCIS CLI as a child process (bridge step 3)

_Needs: DM3b (`mapEnvelope`), CCIS DS4 (`ccis-cli.js run`)._ **Core rules:** attach `01-core.md`. **Read only:** `scripts/demo-bridge.js`, `scripts/demo-map.js`, the CCIS `ccis-cli.js` usage header.

CLI contract (CCIS): `node ccis-cli.js run --envelope <file> --out <file> --at <ISO time with offset> [--demo-parameters]`. Exit 0 = record written (a `failed` record counts); exit 2 = usage error. The CLI never reads the clock and refuses to overwrite a different record.

**Build:** add `runCcis({ envelopeFile, outDir, at, ccisPath, timeoutMs, demoParameters })` to `scripts/demo-bridge.js`.
1. `ccisPath` defaults to `CCIS_PATH`; it must hold `ccis-cli.js` or the call throws (no search, no guessing).
2. Read the ORIGINAL envelope file bytes, take their SHA-256, `mapEnvelope` a parsed copy, write the mapped copy to `outDir`. The original file is never modified.
3. Spawn with `execFile(process.execPath, [cli, 'run', ...])`: array arguments, no shell, `cwd` = `ccisPath`, only `PATH` in the environment, `timeoutMs` (default 30000).
4. Non-zero exit, timeout or missing record throws with the CLI message. `at` must be an ISO time with offset and is passed by the caller (never read from the clock here).
5. Parse the CLI record, add top-level `x-envelopeSha256` = the ORIGINAL file hash (DECISIONS 2026-11-23, DM2a), write the result as a separate `.run-record.json`. The CLI's own file is kept untouched.
6. Returns `{ recordPath, record, status, envelopeSha256 }`. No HTTP, no import (DM3d).

**Done when:** tests with a stub CLI show array args, the hash is of the original, the mapped file differs, and every throw path.
**Size guard:** same script, 1 test file.
