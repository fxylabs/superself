# Superself Local app

Runnable login-free local Superself application.

The initial vertical slice proves four things:

1. Can a file-backed PGlite database survive a process restart?
2. Can the same Drizzle PostgreSQL schema serve a Hono API without a separate PostgreSQL daemon?
3. Can a Vite-built React UI and the Hono API ship from one foreground Node process?
4. Which SPFN runtime seams must become injectable before the public repository can use PGlite directly?

Run `pnpm proof` for the persistence/API proof and `pnpm build` for the production packaging proof.

## Current result

- PGlite 0.5.4 persists projects, work reports, JSONB, timestamps, and foreign keys on disk.
- The database can be injected into `@spfn/core` with `setDatabase()` at runtime.
- SPFN route registration, TypeBox request validation, and the default transaction helper work.
- A fixed local principal resolves to `local-user` / `default-space` / `owner`, backed by seeded database rows.
- Project and work routes are scoped to the principal's default space.
- Create, read, update, revision increment, and close/reopen persistence are covered by `pnpm proof`.
- Chrome DevTools E2E covers project creation, work creation/completion, page reload, and server restart persistence.
- Loopback Host, Origin, Fetch Metadata, and JSON mutation checks protect the local HTTP surface.
- A persistent per-instance secret backs a five-minute, single-use browser pairing token.
- Pairing exchanges a URL-fragment token for an HttpOnly, SameSite=Strict cookie; API routes reject
  unpaired browsers before injecting the local principal.
- The pairing cookie remains valid across server restarts, while a consumed pairing URL cannot be replayed
  from an isolated browser context.
- The production server can open the default browser after it begins listening; set
  `SUPERSELF_OPEN_BROWSER=false` in tests or headless environments.
- The current `@spfn/core` database TypeScript API is unnecessarily fixed to `PostgresJsDatabase`;
  a public driver-provider interface is the main upstream seam needed for first-class PGlite support.
- SPFN route handlers can access Hono context variables through `c.raw.get()`, but a typed direct accessor
  may be a useful upstream seam for framework-independent principal providers.
- Framework-only compatibility code lives under `src/spfn-experiments/` and has no Superself domain imports.
- A Vite React build is served by the same Hono process as the API.
- Vite 8 and its Rolldown native binding require Node 22.12+; the repository pins Node 22.20 in `.nvmrc`.
