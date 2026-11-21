# Chunk 04 — AI on the server

**Goal:** move LLM calls off the browser. Key only in server environment.
**Read only:** the current LLM call code and the settings panel.
**Build:**
1. Server endpoint that calls the provider; key from env.
2. Admin switch (default OFF), request limits, audit entry per call.
3. De-identify the text before sending; show the user exactly what will be sent and require a click.
4. Buttons follow the admin switch (hidden/disabled when off).
5. Remove the API key field from the browser settings.
**Done when:** with the switch off, nothing is sent; with it on, the preview shows the exact payload; no key appears in browser storage or network calls from the browser to the provider.
