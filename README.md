# Superself

**Build with agents. Ship like a team.**

Superself is the agent workspace for shipping AI-built products. It turns goals
into agent-sized work, live reports, artifacts, and durable project memory so a
project keeps moving beyond the demo toward a real release.

> [!IMPORTANT]
> Superself is in an early architecture and packaging phase. The current code is
> a tested vertical slice, not a published end-user release.

## Why Superself

AI makes it remarkably easy to reach a first demo. Shipping still requires
clear goals, scoped work, current status, reviewable outputs, decisions, and
follow-through. Those pieces are usually scattered across chat histories,
terminals, files, and provider-specific sessions.

Superself is building the delivery layer above those sessions:

- **Work** has an identity, state, current report, and revision history.
- **Artifacts** remain connected to the work that produced them.
- **Memory** survives individual agent and model sessions.
- **Projects, milestones, goals, and routines** give delegated work a
  longer-lived direction.
- **Local-first ownership** keeps the primary workspace on your machine.

Superself is not another model provider, chat client, or agent runtime. It is an
agent workspace where builders can direct, inspect, and finish work across the
AI tools they already use.

## What works today

The first vertical slice proves the local runtime and its security boundary:

- Vite + React interface;
- Hono server with SPFN routes;
- file-backed PGlite database with restart persistence;
- login-free local user and default space;
- five-minute, single-use browser pairing;
- HttpOnly, SameSite=Strict local session cookie;
- loopback Host, Origin, Fetch Metadata, and JSON mutation checks;
- project and work create/read/update flow;
- production UI and API served by one Node process.

The browser is the first application shell. Native desktop packaging is a later
decision; the initial distribution target is a local CLI.

## Quick start

Requires Node.js 22.12 or newer and pnpm 10. The repository pins Node 22.20 for
contributors using nvm.

```bash
git clone https://github.com/fxylabs/superself.git
cd superself
nvm use
pnpm install
pnpm build
pnpm start
```

For development:

```bash
pnpm dev
```

The server binds to `127.0.0.1`, creates its local data directory, and opens a
single-use pairing link in the default browser.

## Verify a checkout

```bash
pnpm typecheck
pnpm proof
pnpm build
```

`pnpm proof` exercises local pairing, security checks, SPFN routes, PGlite
persistence, revisions, and restart recovery without requiring a browser.

## Repository layout

```text
apps/
└─ local/                 Vite UI and Hono local runtime

docs/
├─ architecture/          runtime decisions and upstream boundaries
├─ maintainers/           branch, version, and release policy
└─ strategy/              public positioning decisions under discussion
```

Framework-level compatibility seams stay under
`apps/local/src/spfn-experiments/` until they are ready to move upstream to
SPFN. Superself-specific principal, security, data, and lifecycle policy remains
in this repository.

See [the local runtime architecture](docs/architecture/local-runtime.md) for the
current boundary.

## Project status

The near-term sequence is:

1. establish the local runtime and contribution contract;
2. implement the complete project and agent-work surfaces;
3. add milestones, Definition of Done, and release readiness;
4. attach test, build, deployment, and review evidence to work reports;
5. add artifact and memory flows;
6. add agent/MCP integration;
7. add backup, restore, and migration guarantees;
8. publish a local CLI preview;
9. evaluate native desktop packaging after the runtime stabilizes.

## Community and contributions

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull
  request.
- Use the structured GitHub issue forms for reproducible bugs, concrete feature
  proposals, and maintenance work.
- Do not open a pull request until a maintainer has accepted the related issue
  and assigned it to you.
- Sign off every commit to certify the [Developer Certificate of Origin](DCO).
- Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).
- Read the [release policy](docs/maintainers/releases.md) before proposing
  version or tag changes.

Superself accepts implementation pull requests only after a maintainer accepts
and assigns the related issue. Contributions are licensed under Apache-2.0 as
described in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Superself is licensed under the [Apache License 2.0](LICENSE).
