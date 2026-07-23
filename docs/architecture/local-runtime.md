# Local runtime architecture

Superself initially runs as a dedicated loopback process with its interface in the user's default browser.

```text
Browser
  → Vite React interface
  → same-origin Hono/SPFN API
  → file-backed PGlite database
```

## Identity

There is no account login. The database contains one internal local owner and one default space so domain services can keep explicit actor and space boundaries.

Browser access is paired to a local instance:

1. the instance stores a random secret in its data directory;
2. startup creates a five-minute single-use token;
3. the token is delivered in a URL fragment;
4. the client exchanges it for an HttpOnly, SameSite=Strict cookie;
5. API middleware validates the cookie before injecting the local principal.

## SPFN upstream boundary

Product policy stays in this repository: local identity, pairing, data paths, process lifecycle, and browser launch.

Framework-only compatibility code lives in `apps/local/src/spfn-experiments/`. It must not import Superself schemas, principals, components, or configuration. Current upstream candidates are:

- a generic database provider that accepts PGlite-backed Drizzle PostgreSQL databases;
- a Vite adapter covering the dev proxy, production assets, SPA fallback, code generation, and build orchestration.
