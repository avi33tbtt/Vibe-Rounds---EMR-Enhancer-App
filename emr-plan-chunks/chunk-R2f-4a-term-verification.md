# R2f-4a: verify bindings against local terms (docs, written before the build)

Split from R2f-4 (size guard). R2f-4b (restore local codes on the demo glucose, DKA and vitals sets through new versions) follows.

- A binding `{system:'local', code, display, version?}` is VERIFIED only if a PUBLISHED `local_terms` row has that code AND the same display (exact, after trim). Anything else is unverified, with a reason: not published, display missing, display differs, version differs.
- A binding may carry `version` (digits in text, for example "2", because stored sets hold no numbers). If present and different from the published version, it is unverified ("term version changed"). It is optional; sets without it still verify on code and display.
- Other systems stay unverified on the server (unchanged). Unknown never passes.
- Server lint at submit (`review.js`) loads the published rows for the set's local codes in the same transaction and passes a synchronous `bindingState` to the shared lint. `lint.js` is not changed.
- `sets.js` allows the optional `version` key on a binding (digit string, 1 to 999999999). No other key is added.
- Verification happens at submit time. Publishing a set does not re-check; a term retired later is caught when the next set version is submitted.
- Context impact: bindings may carry system `local` and `version`. Agree with CCIS before the envelope exports any (not done here).
