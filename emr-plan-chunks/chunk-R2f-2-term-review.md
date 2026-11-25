# R2f-2: local term review workflow (docs, written before the build)

Goal: a local term draft becomes usable only after the same steps an element set needs, so the vocabulary is reviewed by someone other than its author. No licensed system is involved.

Flow: draft -> submit (admin, doctor) -> in_review -> approve or reject with a reason (informatician; never the author or the submitter) -> reviewed -> publish (admin) -> published -> retire (admin) -> retired.
- One approval is enough (terms have no lint, so no two-reviewer rule). One reject is final; the author adds a new version instead.
- Publishing a new version retires the previously published version of the same code in the same transaction (one published version per code).
- Rules are enforced in the database too: reviews table is append-only, reviewer must be an informatician and not author or submitter, `reviewed` needs an approval, `published` needs `reviewed`, `rejected` is final.
- Permissions: `terms:submit` (admin, doctor), `terms:review` (informatician), `terms:publish` (admin; publish and retire). The app role gets column-level UPDATE (status and the who/when columns only), never display, code or definition.
- Routes: POST /api/local-terms/:id/{submit,approve,reject,publish,retire}; GET /api/local-terms/:id now also lists the reviews. Audit actions term.submit, term.approve, term.reject, term.publish, term.retire (no free text in the audit detail).
- Context impact: none.
