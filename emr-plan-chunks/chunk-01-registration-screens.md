# Chunk 01 — Registration screens

**Goal:** screens for the patient registration that already exists on the server.
**Read only:** the patients API routes and the current banner code.
**Build:**
1. Patients list with search by name/MRN and archived filter.
2. Register form (duplicate warning from the server; no merge UI yet).
3. Real patient banner (name, MRN, age/sex) replacing the synthetic one.
4. Encounter open/close on the case screen (one open encounter per bed shown as an error).
**Do not:** touch element sets, codes or marketplace.
**Done when:** register a patient, see a duplicate warning, open a case from the list, banner shows real data, audit log records each action.
**Test:** nurse can register; viewer cannot. Permission enforced on server.
