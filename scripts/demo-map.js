'use strict';
// Row DM3b: map the EMR context envelope to the names the CCIS snake slice uses. SYNTHETIC DATA ONLY. Prototype, not for clinical use.
// Pure: no database, no clock, no network. The input is never changed; a mapped copy is returned.
// Only the demo slice is known. Anything outside the tables below throws: the bridge never guesses a meaning.
const ELEMENT = { 'snake-envenomation-timing': 'snake.envenomation-timing' };
const PATHWAY = { 'snake-envenomation-documentation': 'snake.documentation-path' };
// EMR pins whole-number versions (v1 is sent as 1.0.0); the CCIS demo package holds 0.1.0. Only this pair is known.
const VERSION = { '1.0.0': '0.1.0' };
const PREFIX_EMR = 'snake-envenomation-timing.', PREFIX_CCIS = 'snake.envenomation-timing.';

// field (EMR, kebab) -> CCIS concept segment, plus for select fields the CCIS code name and the select words.
const TIMES = ['bite-time', 'arrival-time', 'clotting-test-start-time', 'clotting-result-read-time', 'antivenom-start-time'];
const SELECTS = {
  'bite-time-certainty': { code: 'bite-time-certainty', words: { Exact: 'exact', Estimated: 'estimated' } },
  'clotting-test-status': { code: 'clotting-test-status', words: { Performed: 'performed', 'Not performed': null } },
  'clotting-result': { code: 'clotting-test-result', words: { Clotted: 'demo-result-a', Unclotted: 'demo-result-a' } },   // CCIS has no member list (its D-032)
  'antivenom-status': { code: 'antivenom-status', words: { Given: 'given', 'Not given': null } },
};
const SYSTEM = 'ccis-demo', SYSTEM_VERSION = '0.1.0';

function mapEnvelope(envelope) {
  const out = structuredClone(envelope);
  const get = (tbl, id, what) => { if (!Object.hasOwn(tbl, id)) throw new Error(`Cannot map ${what} "${id}" to a CCIS name.`); return tbl[id]; };
  for (const e of out.applied.elements) { e.id = get(ELEMENT, e.id, 'element'); e.version = get(VERSION, e.version, 'version'); }
  for (const p of out.applied.pathways) { p.id = get(PATHWAY, p.id, 'pathway'); p.version = get(VERSION, p.version, 'version'); }
  for (const o of out.observations) {
    const id = o.concept.id;
    if (!id.startsWith(PREFIX_EMR)) throw new Error(`Cannot map concept "${id}" to a CCIS name.`);
    const field = id.slice(PREFIX_EMR.length);
    const sel = Object.hasOwn(SELECTS, field) ? SELECTS[field] : null;
    if (!sel && !TIMES.includes(field)) throw new Error(`Cannot map field "${field}" to a CCIS name.`);
    o.concept.id = PREFIX_CCIS + field;
    if (!sel) continue;                                         // times keep kind, value, state
    o.kind = 'code';
    o.concept.codes = [{ system: SYSTEM, systemVersion: SYSTEM_VERSION, code: sel.code, verification: 'unverified' }];
    if (o.state === 'unknown') { delete o.value; continue; }    // explicit unknown stays unknown
    if (typeof o.value !== 'string' || !Object.hasOwn(sel.words, o.value)) throw new Error(`Cannot map value for "${field}" to a CCIS code.`);
    const word = sel.words[o.value];
    if (word === null) { delete o.value; o.state = 'explicitly-negative'; }
    else o.value = { system: SYSTEM, code: word };
  }
  return out;
}

module.exports = { mapEnvelope };
