# Chunk D5a-fhir-capability: FHIR Mode: supported profile and capability matrix

_Ch8/Ch10. Needs the frozen CCIS 0.1 baseline (C9). Needs: C9._

**Core rules:** attach `01-core.md` too.

**Read only:** `sdc.js`; FHIR export code in `emr-enhancer.html`; Ch10 section 6.

**Build:**
1. Write `ccis/FHIR-MODE.md`: supported FHIR release (R4), resources, profiles, extensions, terminology bindings; for each mapping state lossless / conditionally lossless / lossy, preserve source ids and provenance, and where no direct representation exists use a documented extension or linked CCIS artefact.
2. Capability matrix table: supported / transformed / out of profile.

**Done when:** a published matrix exists and matches what the code actually does.

**Size guard:** docs only plus a small test that the matrix lists every resource the exporter emits.
