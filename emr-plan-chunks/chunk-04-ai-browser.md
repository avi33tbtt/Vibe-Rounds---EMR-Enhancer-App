# Chunk 04 — AI in the browser, minimal payload

**Goal:** keep AI in the browser (no server), but make it safe for the pilot by sending only a fixed, structured payload.
**Read only:** the generate and callLLM code, the settings panel, the Suggest function.
**Build:**
1. Payload builder with a whitelist. Allowed: primary diagnosis, titles/ids of applied element sets and pathways, optional author instructions. Never: name, MRN, age, sex, dates, entered values, narrative, notes.
2. Remove the "Vignette" field, or relabel it "do not enter patient details" and warn if it is filled.
3. Preview dialog showing the exact payload before every call; send only after a click.
4. AI switch in Settings, default OFF. When off, hide or disable AI buttons (Generate, AI ranking).
5. Optional: AI ranking for Suggest using the same payload.
6. Settings note: the key is stored in this browser only; use your own key; synthetic data only.
**Do not:** add a server, de-identification of free text, or send any case field not on the whitelist.
**Done when:** with the switch off nothing is sent; with it on, the preview matches the network request exactly; a test case with patient details in the narrative shows none of them in the payload.
**Limit:** browser keys can be read by anyone using that browser. For real deployment, move AI to the server (later chunk, still required by the go-live gate).
