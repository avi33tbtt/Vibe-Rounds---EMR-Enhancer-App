# Chunk 07a: Container and TLS deployment

_Part 1 of original chunk 07._

**Core rules:** attach `01-core.md` too.

**Read only:** `package.json`, `docker-compose.yml`, `env.txt`, `README.md`, `server.js`.

**Build:**
1. `Dockerfile`: Node 22, `npm ci --omit=dev`, non-root user.
2. Add an `app` service to compose, plus a reverse proxy with automatic TLS (Caddy suggested) with a config file; secrets from an env file that is gitignored. Migrations run at start (already done by `server.js`).
3. Document the steps in README (domain, ports, first start, seed). If a health endpoint is wanted, remember it is a new route and the permission-matrix test must be updated on purpose.
4. Claude may not be able to run Docker in its sandbox. If so, say exactly what was not run and give the user the 3 commands to check it.

**Done when:** `docker compose up` serves the app over HTTPS (a local certificate is fine) and login works.

**Size guard:** Dockerfile, compose, proxy config, README section.
