# Chunk 08 — Review/approval workflow

**Goal:** draft → automated lint → review → frozen approved version.
**Build:**
1. Shared lint script (schema, bound codes verified, no dose/threshold text without citation, no executable content, no patient-like strings).
2. Informatician role reviews; never the author. Two reviewers for anything with rules, bands or dose-like text.
3. Reviewer and time stamped by the server.
4. Approved version immutable; editing creates a new draft.
5. Local tiers shown: local draft, local reviewed.
**Done when:** author cannot approve own set; a set with rules needs two different reviewers; approved version cannot be changed.
