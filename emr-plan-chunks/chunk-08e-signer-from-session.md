# Chunk 08e: Signer, author and amender from the session

_Added by the audit. Closes known gap (a) and its `test.todo`. Core rule: signer/author/approver come from the session._

**Core rules:** attach `01-core.md` too.

**Read only:** `emr-enhancer.html`: `grep -n "Signing as\|user()\|vr_user\|signNote\|amendNote"`; the FHIR export author code; `test/safety-data.test.js`.

**Build:**
1. Replace the typed 'Signing as' box with the signed-in user from `/api/me`. If nobody is signed in, signing and amending are disabled with a clear message.
2. FHIR export author also from the session.
3. Remove the `vr_user` localStorage path. Convert the matching `test.todo` into real tests, including: a typed or injected name is never used.

**Done when:** no code path takes the signer name from a typed field; the todo test passes.

**Size guard:** Page plus the existing safety-data test and existing note tests.

**Notes:** Honest limit to state in the reply: notes still live in the browser, so the server cannot enforce this yet.
