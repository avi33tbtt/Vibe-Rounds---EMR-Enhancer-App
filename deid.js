'use strict';
// De-identification of the few free-text strings that may go to the AI provider (diagnosis, instructions, titles).
// Heuristic, NOT a guarantee: it removes the identifiers it can recognise and the user sees the result in the preview
// before anything is sent. Registered patients' names and MRNs are matched exactly, so a typed name is always caught.
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const NAME = "[\\p{Lu}][\\p{L}'’-]+";
const digits = s => (s.match(/\d/g) || []).length;

// [kind, regex, replacement, optional keep(match) -> true leaves the text alone]
const RULES = [
  ['email', /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '[EMAIL]'],
  ['url', /\b(?:https?:\/\/|www\.)\S+/gi, '[URL]'],
  ['date', /\b\d{4}-\d{2}-\d{2}\b/g, '[DATE]'],
  ['date', /(?<![\d.\/-])\d{1,2}([\/.-])\d{1,2}\1(?:\d{4}|\d{2})(?!\d)/g, '[DATE]'],
  ['date', new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\.?,?\\s+\\d{2,4}\\b`, 'gi'), '[DATE]'],
  ['date', new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{2,4}\\b`, 'gi'), '[DATE]'],
  ['date', new RegExp(`\\b${MONTH}\\s+(?:19|20)\\d{2}\\b`, 'gi'), '[DATE]'],
  ['age', /\b\d{1,3}\s*-?\s*(?:year|yr|month|mo|week|wk|day)s?\s*-?\s*old\b/gi, '[AGE]'],
  ['age', /\b\d{1,3}\s*(?:y\/o|y\.o\.|yo|yom|yof)\b/gi, '[AGE]'],
  ['age', /\baged?\s+\d{1,3}\b/gi, '[AGE]'],
  ['id', /\b(?:mrn|uhid|ip\s*no|op\s*no|id|nhs\s*no|aadhaar|ssn)\s*[:#-]?\s*[a-z0-9\/-]{3,}/gi, '[ID]'],
  ['phone', /(?<![\w.])\+?\d[\d\s().-]{6,}\d(?![\w])/g, '[PHONE]', m => digits(m) < 8],
  ['number', /\b\d{6,}\b/g, '[NUMBER]'],
  ['bed', /\bbed\s*(?:no\.?|number|#)?\s*[a-z]{0,4}-?\d+[a-z]?\b/gi, '[BED]'],
  ['name', new RegExp(`\\b(?:[Mm]r|[Mm]rs|[Mm]s|[Mm]iss|[Mm]x|[Dd]r|[Pp]rof|[Ss]hri|[Ss]mt|[Ss]ri|[Mm]aster|[Bb]aby)\\.?\\s+${NAME}(?:\\s+${NAME}){0,2}`, 'gu'), '[NAME]'],
  ['name', new RegExp(`\\b(?:[Pp]atient|[Pp]t|[Nn]ame|[Nn]amed|[Cc]alled|[Ss]on of|[Dd]aughter of|[Ww]ife of|[Hh]usband of)\\s*[:\\-]?\\s+${NAME}(?:\\s+${NAME}){0,2}`, 'gu'), '[NAME]'],
];

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BOUND = alt => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])`, 'giu');

// Build matchers from registered patients (all of them, archived too). Names: full name and each word of 4+ letters.
function buildKnown(rows) {
  const names = new Set(), mrns = new Set();
  for (const r of rows) {
    const full = String(r.name || '').trim().replace(/\s+/g, ' ');
    if (full.length >= 3) names.add(full);
    full.split(/[\s,]+/).forEach(t => { if ([...t].length >= 4) names.add(t); });
    const m = String(r.mrn || '').trim();
    if (m.length >= 3) mrns.add(m);
  }
  const by = set => [...set].sort((a, b) => b.length - a.length).map(esc).join('|');
  return {
    names: names.size ? BOUND(by(names).replace(/\\ /g, '\\s+')) : null,
    mrns: mrns.size ? BOUND(by(mrns)) : null,
    count: rows.length,
  };
}
async function loadKnown(db) {
  const { rows } = await db.query('SELECT name, mrn FROM patients ORDER BY id LIMIT 50000');
  return buildKnown(rows);
}

// Returns { text, counts } where counts is { kind: n }.
function scrub(input, known, counts = {}) {
  let t = String(input == null ? '' : input);
  const hit = (k, n = 1) => { counts[k] = (counts[k] || 0) + n; };
  if (known && known.mrns) t = t.replace(known.mrns, () => { hit('mrn'); return '[ID]'; });
  if (known && known.names) t = t.replace(known.names, () => { hit('name'); return '[NAME]'; });
  for (const [kind, re, rep, keep] of RULES) {
    t = t.replace(re, m => { if (keep && keep(m)) return m; hit(kind); return rep; });
  }
  return { text: t.replace(/\s+/g, ' ').trim(), counts };
}

module.exports = { scrub, buildKnown, loadKnown };
