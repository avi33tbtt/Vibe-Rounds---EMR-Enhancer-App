// CCIS COMPILER (row 2.4): canonical form, checksum, equivalence harness. Fails closed.
// Prototype. Synthetic data only. Not for clinical use.
//
// Pure library: no file access, no network, no clock, no randomness. The only import is `createHash` from
// `node:crypto`, which is deterministic (row 3.7 must give the same bytes in the browser through Web Crypto).
// The same input gives byte-identical output (CCIS-REQ-067). A checksum proves the bytes are the same bytes. It says
// nothing about who published them or whether they are clinically safe.
//
//   canonicalize(input)            -> { ok: true, text } | { ok: false, code, reason, path }
//   checksumOf(text)               -> 'sha256:<64 lower-case hex>'
//   verifyChecksum(text, checksum) -> { ok, reason }
//   compileArtefact(input, opts)   -> { ok: true, compiled } | { ok: false, code, reason, path?, diagnostics }
//   compareRoutes(routes)          -> { identical, routes, firstDifference }
//
// Canonical form `ccis-canonical-json/1`: UTF-8 JSON, no insignificant whitespace, member names sorted in code-unit
// order, array order kept, numbers as JavaScript writes them (-0 as 0), strings as JSON.stringify writes them,
// `x-` members kept and covered, nothing filled in, no trailing newline.

import { createHash } from 'node:crypto';
import { validateArtefact, LAYER_NAMES } from './ccis-validator.js';

export const CANONICAL_FORM = 'ccis-canonical-json/1';
export const COMPILER = { name: 'ccis-compile', version: '0.1.0' };

export const COMPILE_REFUSALS = [
  { code: 'CCIS-C-001', summary: 'The text is not valid JSON (line and column of the break).' },
  { code: 'CCIS-C-002', summary: 'An object holds the same member name twice.' },
  { code: 'CCIS-C-003', summary: 'A number cannot be held safely (not finite, an integer beyond 2^53 - 1, or more than 17 significant digits).' },
  { code: 'CCIS-C-004', summary: 'The value is not plain JSON (undefined, function, symbol, bigint, class instance, Date, Map, sparse array) or refers to itself.' },
  { code: 'CCIS-C-005', summary: 'A string or member name holds a lone surrogate, so it is not valid Unicode.' },
  { code: 'CCIS-C-006', summary: 'A member is named __proto__.' },
  { code: 'CCIS-C-007', summary: 'The artefact did not pass all eight validation layers.' },
  { code: 'CCIS-C-008', summary: 'The artefact has no manifest with an id, type and version, so it cannot be named or pinned.' },
];

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const MAX_DEPTH = 200;
const MAX_SIGNIFICANT_DIGITS = 17;

class Refusal extends Error {
  constructor(code, reason, path = '', position = null) { super(reason); this.code = code; this.reason = reason; this.path = path; this.position = position; }
}
const refuse = (code, reason, path, position) => { throw new Refusal(code, reason, path, position); };
const pointer = (path) => path.map((s) => `/${String(s).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');

// ---------------------------------------------------------------------------------------------
// Text route: a strict JSON reader that sees what JSON.parse hides (duplicate names, unsafe numbers)
// ---------------------------------------------------------------------------------------------

function readText(text) {
  let i = 0;
  const n = text.length;
  const at = (k) => {
    let line = 1; let column = 1;
    for (let j = 0; j < k && j < n; j += 1) { if (text[j] === '\n') { line += 1; column = 1; } else column += 1; }
    return { line, column };
  };
  const stop = (k = i) => { const p = at(k); refuse('CCIS-C-001', `The text is not valid JSON at line ${p.line}, column ${p.column}.`, '', p); };
  const skip = () => { while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i += 1; };

  const string = () => {
    const start = i;
    i += 1;
    while (i < n && text[i] !== '"') {
      const c = text.charCodeAt(i);
      if (c < 0x20) stop();
      if (text[i] === '\\') {
        i += 1;
        if (i >= n) stop();
        if (text[i] === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) stop(i);
          i += 4;
        } else if (!'"\\/bfnrt'.includes(text[i])) stop(i);
      }
      i += 1;
    }
    if (i >= n) stop(start);
    i += 1;
    return JSON.parse(text.slice(start, i));
  };

  const number = (path) => {
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) stop();
    const token = m[0];
    const mantissa = token.replace(/[eE].*$/, '').replace(/^-/, '').replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
    const v = Number(token);
    const where = at(i);
    if (!Number.isFinite(v)) refuse('CCIS-C-003', `A number at ${pointer(path) || 'the top level'} is too large to hold.`, pointer(path), where);
    if (Number.isInteger(v) && Math.abs(v) > Number.MAX_SAFE_INTEGER) refuse('CCIS-C-003', `An integer at ${pointer(path) || 'the top level'} is beyond the safe range and would lose digits.`, pointer(path), where);
    if (mantissa.length > MAX_SIGNIFICANT_DIGITS) refuse('CCIS-C-003', `A number at ${pointer(path) || 'the top level'} has more than ${MAX_SIGNIFICANT_DIGITS} significant digits and would lose digits.`, pointer(path), where);
    i += token.length;
    return v;
  };

  const value = (path, depth) => {
    if (depth > MAX_DEPTH) stop();
    skip();
    if (i >= n) stop();
    const c = text[i];
    if (c === '{') {
      i += 1;
      const o = {};
      skip();
      if (text[i] === '}') { i += 1; return o; }
      for (;;) {
        skip();
        if (text[i] !== '"') stop();
        const key = string();
        const here = [...path, key];
        if (!key.isWellFormed()) refuse('CCIS-C-005', `A member name at ${pointer(path) || 'the top level'} is not valid Unicode.`, pointer(path));
        if (key === '__proto__') refuse('CCIS-C-006', `A member named __proto__ is not allowed (at ${pointer(path) || 'the top level'}).`, pointer(here));
        if (Object.prototype.hasOwnProperty.call(o, key)) refuse('CCIS-C-002', `The same member name appears twice in the object at ${pointer(path) || 'the top level'}.`, pointer(here));
        skip();
        if (text[i] !== ':') stop();
        i += 1;
        o[key] = value(here, depth + 1);
        skip();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === '}') { i += 1; return o; }
        stop();
      }
    }
    if (c === '[') {
      i += 1;
      const a = [];
      skip();
      if (text[i] === ']') { i += 1; return a; }
      for (;;) {
        a.push(value([...path, a.length], depth + 1));
        skip();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === ']') { i += 1; return a; }
        stop();
      }
    }
    if (c === '"') {
      const s = string();
      if (!s.isWellFormed()) refuse('CCIS-C-005', `A string at ${pointer(path) || 'the top level'} is not valid Unicode.`, pointer(path));
      return s;
    }
    if (c === '-' || (c >= '0' && c <= '9')) return number(path);
    for (const [word, v] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(word, i)) { i += word.length; return v; }
    }
    return stop();
  };

  const v = value([], 0);
  skip();
  if (i < n) stop();
  return v;
}

// ---------------------------------------------------------------------------------------------
// In-memory route and writer
// ---------------------------------------------------------------------------------------------

function write(v, path, stack) {
  const here = pointer(path) || 'the top level';
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'string') {
    if (!v.isWellFormed()) refuse('CCIS-C-005', `A string at ${here} is not valid Unicode.`, pointer(path));
    return JSON.stringify(v);
  }
  if (t === 'number') {
    if (!Number.isFinite(v)) refuse('CCIS-C-003', `A number at ${here} is not finite.`, pointer(path));
    if (Number.isInteger(v) && Math.abs(v) > Number.MAX_SAFE_INTEGER) refuse('CCIS-C-003', `An integer at ${here} is beyond the safe range.`, pointer(path));
    return JSON.stringify(v);
  }
  if (t !== 'object') refuse('CCIS-C-004', `A ${t} at ${here} is not plain JSON.`, pointer(path));
  if (stack.has(v)) refuse('CCIS-C-004', `The value at ${here} refers to itself.`, pointer(path));
  stack.add(v);
  let out;
  if (Array.isArray(v)) {
    if (Object.getPrototypeOf(v) !== Array.prototype) refuse('CCIS-C-004', `The array at ${here} is not a plain array.`, pointer(path));
    const parts = [];
    for (let k = 0; k < v.length; k += 1) {
      if (!(k in v)) refuse('CCIS-C-004', `The array at ${here} has a gap (a sparse array).`, pointer(path));
      parts.push(write(v[k], [...path, k], stack));
    }
    out = `[${parts.join(',')}]`;
  } else {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) refuse('CCIS-C-004', `The object at ${here} is not a plain object (a class instance, Date or Map).`, pointer(path));
    if (Object.getOwnPropertySymbols(v).length > 0) refuse('CCIS-C-004', `The object at ${here} has a symbol key.`, pointer(path));
    const keys = Object.getOwnPropertyNames(v).sort();
    const parts = keys.map((k) => {
      const d = Object.getOwnPropertyDescriptor(v, k);
      if (!('value' in d) || !d.enumerable) refuse('CCIS-C-004', `A member at ${here} is not a plain data member.`, pointer([...path, k]));
      if (k === '__proto__') refuse('CCIS-C-006', `A member named __proto__ is not allowed (at ${here}).`, pointer([...path, k]));
      if (!k.isWellFormed()) refuse('CCIS-C-005', `A member name at ${here} is not valid Unicode.`, pointer(path));
      return `${JSON.stringify(k)}:${write(d.value, [...path, k], stack)}`;
    });
    out = `{${parts.join(',')}}`;
  }
  stack.delete(v);
  return out;
}

export function canonicalize(input) {
  try {
    const value = typeof input === 'string' ? readText(input) : input;
    return { ok: true, text: write(value, [], new Set()) };
  } catch (e) {
    if (e instanceof Refusal) {
      const r = { ok: false, code: e.code, reason: e.reason, path: e.path };
      if (e.position) r.position = e.position;
      return r;
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Checksum
// ---------------------------------------------------------------------------------------------

export const checksumOf = (text) => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

export function verifyChecksum(text, checksum) {
  if (typeof text !== 'string') return { ok: false, reason: 'The canonical text must be a string.' };
  if (typeof checksum !== 'string') return { ok: false, reason: 'The checksum must be a string.' };
  const m = /^([a-z0-9-]+):/.exec(checksum);
  if (!m) return { ok: false, reason: 'The checksum does not name an algorithm.' };
  if (m[1] !== 'sha256') return { ok: false, reason: 'The checksum names an algorithm this version does not support.' };
  if (!/^sha256:[0-9a-f]{64}$/.test(checksum)) return { ok: false, reason: 'The checksum is not 64 lower-case hexadecimal characters after the algorithm.' };
  if (checksumOf(text) !== checksum) return { ok: false, reason: 'The checksum does not match the bytes.' };
  return { ok: true, reason: '' };
}

// ---------------------------------------------------------------------------------------------
// Compile: validate, then canonicalise, then checksum. All or nothing (CCIS-REQ-064, 065)
// ---------------------------------------------------------------------------------------------

export function compileArtefact(input, options = {}) {
  const c = canonicalize(input);
  if (!c.ok) return { ok: false, code: c.code, reason: c.reason, path: c.path, diagnostics: [] };

  const result = validateArtefact(input, options);
  const failed = LAYER_NAMES.find((name) => result.layers[name].outcome !== 'passed');
  if (result.outcome !== 'no-errors-so-far' || failed) {
    return {
      ok: false,
      code: 'CCIS-C-007',
      reason: `The artefact did not pass all eight validation layers (layer ${LAYER_NAMES.indexOf(failed) + 1}, ${failed}, did not pass), so nothing was compiled.`,
      diagnostics: result.diagnostics.filter((d) => d.severity === 'error'),
    };
  }

  const doc = typeof input === 'string' ? JSON.parse(input) : input;
  const m = isObj(doc) ? doc.manifest : null;
  if (!isObj(m) || typeof m.id !== 'string' || typeof m.type !== 'string' || typeof m.version !== 'string') {
    return { ok: false, code: 'CCIS-C-008', reason: 'The artefact has no manifest with an id, type and version, so it cannot be named or pinned. Nothing was compiled.', diagnostics: [] };
  }

  const warnings = result.diagnostics.filter((d) => d.severity === 'warning').map((d) => ({ ruleId: d.ruleId, path: d.path }));
  return {
    ok: true,
    compiled: {
      subject: { id: m.id, type: m.type, version: m.version },
      canonicalForm: CANONICAL_FORM,
      compiler: { ...COMPILER },
      checksum: checksumOf(c.text),
      canonical: c.text,
      warnings,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Equivalence harness: do several routes to one artefact give identical canonical bytes?
// It canonicalises only (it never validates) and shows paths and kinds, never values.
// ---------------------------------------------------------------------------------------------

const kindOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const child = (path, key) => `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

function firstDifference(a, b, path = '') {
  const ka = kindOf(a); const kb = kindOf(b);
  if (ka !== kb) return { path, kind: 'different-value-kind' };
  if (ka === 'array') {
    const k = Math.min(a.length, b.length);
    for (let j = 0; j < k; j += 1) { const d = firstDifference(a[j], b[j], child(path, j)); if (d) return d; }
    return a.length === b.length ? null : { path, kind: 'array-length' };
  }
  if (ka === 'object') {
    const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of names) {
      if (!(k in a) || !(k in b)) return { path: child(path, k), kind: 'member-only-in-one' };
      const d = firstDifference(a[k], b[k], child(path, k));
      if (d) return d;
    }
    return null;
  }
  return a === b ? null : { path, kind: 'different-value' };
}

export function compareRoutes(routes) {
  if (!Array.isArray(routes) || routes.length < 2) {
    return { identical: false, routes: [], firstDifference: null, reason: 'At least two routes are needed to compare.' };
  }
  const done = routes.map((r) => {
    const c = canonicalize(r.input);
    return c.ok ? { name: r.name, ok: true, checksum: checksumOf(c.text), text: c.text } : { name: r.name, ok: false, code: c.code, path: c.path };
  });
  const summary = done.map((d) => (d.ok ? { name: d.name, ok: true, checksum: d.checksum } : { name: d.name, ok: false, code: d.code }));
  const refused = done.find((d) => !d.ok);
  if (refused) return { identical: false, routes: summary, firstDifference: { route: refused.name, path: refused.path, kind: 'route-refused' } };
  const base = done[0];
  for (const d of done.slice(1)) {
    if (d.text !== base.text) {
      const diff = firstDifference(JSON.parse(base.text), JSON.parse(d.text)) ?? { path: '', kind: 'different-value' };
      return { identical: false, routes: summary, firstDifference: { route: d.name, ...diff } };
    }
  }
  return { identical: true, routes: summary, firstDifference: null };
}
