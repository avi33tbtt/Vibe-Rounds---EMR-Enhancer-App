'use strict';
// Row R6g-2 (run on YOUR machine): write the conformance fixtures (R6g-1) to a temp folder and run the public HL7 FHIR validator on them.
// Needs Java and the validator jar: https://github.com/hapifhir/org.hl7.fhir.core/releases/latest/download/validator_cli.jar
// Usage:  FHIR_VALIDATOR_JAR=/path/to/validator_cli.jar npm run fhir:validate
// The validator downloads the FHIR R4 core package the first time, so this machine needs internet. FHIR_TX picks the terminology server (default n/a: the exports carry text, not codes).
// Exit code: 0 = the validator reported no errors, 1 = errors or the engine could not load (read the output), 2 = NOT RUN (no jar, no Java). "Not run" is never a pass.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fixtures } = require('../test/fhir-conformance-fixtures');

const jar = process.env.FHIR_VALIDATOR_JAR;
if (!jar || !fs.existsSync(jar)) {
  console.error('NOT RUN: set FHIR_VALIDATOR_JAR to the path of validator_cli.jar (download: https://github.com/hapifhir/org.hl7.fhir.core/releases/latest/download/validator_cli.jar).');
  process.exit(2);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emr-fhir-'));
const files = fixtures().map(f => { const p = path.join(dir, f.name + '.json'); fs.writeFileSync(p, JSON.stringify(f.resource, null, 2)); return p; });
console.log(`Validating ${files.length} resources in ${dir} (FHIR 4.0.1, terminology: ${process.env.FHIR_TX || 'n/a'})`);
const r = spawnSync('java', ['-jar', jar, ...files, '-version', '4.0.1', '-tx', process.env.FHIR_TX || 'n/a'], { stdio: 'inherit' });
if (r.error) { console.error('NOT RUN: Java could not be started (' + r.error.message + ').'); process.exit(2); }
process.exit(r.status === 0 ? 0 : 1);
