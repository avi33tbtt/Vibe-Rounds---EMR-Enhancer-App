# Core rules (never change)

**Product:** documentation + trajectory layer. Chart = blank narrative + added element sets/pathways. Not a full hospital EMR.

**Architecture**
- Own model is system of record. FHIR R4 is export boundary only.
- SDC Questionnaires import/export into the same internal model.
- Stack: Node.js + PostgreSQL, flat repo root, numbered migrations (never edit applied ones).

**Safety**
- Not for clinical use; synthetic data only until the go-live gate.
- No LLM-supplied doses, thresholds or protocol bands. AI only drafts/ranks; off by default. Payload is a whitelist (diagnosis + applied set titles/ids), never patient fields or narrative. Key in browser for the pilot; server-side before real use.
- Rules/bands arrive disabled until a local doctor enables them.

**Data**
- Never hard-delete clinical data. Signed notes immutable (amend with reason). Cases archived, not deleted.
- Case pins element-set versions; update is an explicit action.
- Signer/author/approver come from the session, never typed or sent in a body.
- Server enforces permissions and read-only content, not the UI.

**Codes**
- Verified = code exists on terminology server AND display matches.
- Unverified codes are never exported as FHIR `Coding`. Coding is optional everywhere.

**Marketplace (later)**
- Registration data never in marketplace. Packages are declarative data only. Installed content read-only; fork to edit.
