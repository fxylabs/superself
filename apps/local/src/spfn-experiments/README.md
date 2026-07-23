# SPFN upstream experiments

This directory contains framework-level seams discovered while building the Superself local runtime.

Rules:

- Do not import Superself schemas, components, principals, or product configuration.
- Keep every module usable by a different SPFN application.
- Treat these modules as disposable compatibility adapters, not public APIs.
- Promote a module only after its behavior is covered in SPFN itself.

## `database-provider.ts`

PGlite's Drizzle database works with the current SPFN route and transaction runtime, but
`setDatabase()` is typed specifically around `PostgresJsDatabase`. The adapter contains the
single temporary cast. The upstream solution should make the database provider generic rather
than shipping this cast.

## `vite-static.ts`

Mounts Vite production assets on the same Hono origin as SPFN APIs. An upstream Vite adapter
should additionally own dev proxy configuration, SPA fallback, codegen ordering, and build CLI
integration.
