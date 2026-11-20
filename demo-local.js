'use strict';
/**
 * D4: turns generateDemo output into Demo-mode (localStorage) cases. Pure: no storage, no network, names no set or field.
 * Browser: window.DemoLocal.toLocalCases(data). Node: require('./demo-local.js').
 * Demo mode has no server records, so the patient is the typed demo fields on the case (name, ageSex, bed, mrn).
 * A merge (D-08) is a server idea: here both charts load and are marked demo:true.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DemoLocal = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const FALLBACK = '2026-11-01T08:00:00Z';
  const vk = (s, f) => s + '/' + f;

  function toLocalCases(data) {
    const pBy = {}, eBy = {}, rowsBy = {};
    (data.patients || []).forEach((p) => { pBy[p.key] = p; });
    (data.encounters || []).forEach((e) => { eBy[e.key] = e; });
    (data.rows || []).forEach((w) => { (rowsBy[w.caseId] = rowsBy[w.caseId] || []).push(w); });

    return (data.cases || []).map((c) => {
      const p = pBy[c.patientKey] || {}, e = c.encounterKey ? eBy[c.encounterKey] : null, rows = rowsBy[c.id] || [];
      const times = rows.map((w) => w.rowTime).filter(Boolean).sort();
      const iso = (e && e.startAt) || times[0] || FALLBACK;
      const applied = (c.applied || []).map((a) => ({ setId: typeof a === 'string' ? a : a.setId, addedAt: (a && a.addedAt) || iso }));
      const out = {
        id: c.id, demo: true, demoKey: p.syntheticKey || '', saved: iso, updatedAt: iso,
        narrative: c.narrative || '', applied, pathways: c.pathways || [], values: {}, notes: [], ns: true, rp: true,
        patient: {
          name: p.name || '',
          ageSex: [p.ageYears != null ? p.ageYears + ' y' : '', p.sex && p.sex !== 'unknown' ? p.sex : ''].filter(Boolean).join(' · '),
          bed: e ? [e.ward, e.bed].filter(Boolean).join(' / ') : '',
          mrn: String(p.syntheticKey || '').toUpperCase(),          // typed marker, never a real-looking MRN
        },
      };
      rows.forEach((w) => {
        if (!out.applied.some((a) => a.setId === w.setId)) out.applied.push({ setId: w.setId, addedAt: iso });
        const r = Object.assign({}, w.row, { __id: w.id });
        if (w.rowTime) r.__at = w.rowTime;                           // rows with no time stay without one, as generated
        if (w.errorReason) { r.__status = 'entered_in_error'; r.__errorReason = w.errorReason; }
        const k = vk(w.setId, '@' + w.groupId);
        (out.values[k] = out.values[k] || []).push(r);
      });
      return out;
    });
  }
  return { toLocalCases };
});
