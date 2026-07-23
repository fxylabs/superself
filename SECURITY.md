# Security Policy

## Supported versions

Superself has not published a supported release yet. Security fixes currently
target the latest commit on `main`.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting flow:

https://github.com/fxylabs/superself/security/advisories/new

Do not open a public issue for a vulnerability. Include:

- the affected commit or version;
- operating system and architecture;
- reproduction steps or a minimal proof of concept;
- expected and observed impact;
- whether local data, pairing tokens, cookies, or instance secrets are exposed.

Never include real user data, API keys, credentials, active pairing links, or an
instance secret. Maintainers will acknowledge a report as soon as practical and
coordinate disclosure after a fix is available.

## Current local security boundary

The local server is expected to:

- bind only to `127.0.0.1`;
- validate the Host header;
- reject hostile Origin and cross-site mutation requests;
- accept JSON mutation bodies only;
- require a paired browser session before injecting the local principal;
- exchange a short-lived, one-use fragment token for an HttpOnly,
  SameSite=Strict cookie;
- keep the persistent instance secret readable only by the local user.

Changes that affect these guarantees require an explicit security review in the
accepted issue and pull request. Undisclosed vulnerability fixes use the private
security advisory as the issue record until coordinated disclosure is safe.
