// The order the release workflow publishes in, read off the workflow (#430).
//
// One tag publishes two packages, and which goes first is the difference
// between a half-run that leaves the registry usable and one that does not: a
// fold version nobody depends on yet is inert, while a CLI whose dependency is
// not on the registry is installable by nobody. That order is a `needs:` edge
// in a yaml file, which no test of either package can see — so it is asserted
// here, from the file itself.
//
// The reader below is not a yaml parser and is not trying to be one. It reads
// the one shape this file is written in: jobs at two spaces, their bodies
// indented past that.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rootKeyViolations } from "../apps/cli/test/structure.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const workflow = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");

function jobs(text)
{
    const from = text.indexOf("\njobs:\n");
    const found = new Map();
    let current = null;
    for (const line of text.slice(from).split("\n").slice(2))
    {
        const named = line.match(/^ {2}([a-z][a-z0-9-]*):\s*$/);
        if (named !== null)
        {
            current = named[1];
            found.set(current, []);
        }
        else if (current !== null && (line.trim() === "" || line.startsWith("    ")))
        {
            found.get(current).push(line);
        }
        else if (line.trim() !== "" && !line.startsWith(" "))
        {
            current = null;
        }
    }
    return new Map([...found].map(([name, lines]) => [name, lines.join("\n")]));
}

const JOBS = jobs(workflow);

test("W1: the workflow fires on a v* tag push and on nothing else", () =>
{
    const trigger = workflow.slice(workflow.indexOf("on:"), workflow.indexOf("permissions:"));
    assert.match(trigger, /push:\s*\n\s*tags: \["v\*"\]/);
    assert.ok(!/pull_request|workflow_dispatch|branches:/.test(trigger), `something else can publish:\n${trigger}`);
});

test("W2: exactly two jobs publish, one per package, each in its own directory", () =>
{
    const publishing = [...JOBS].filter(([, body]) => body.includes("npm publish"));
    assert.deepEqual(publishing.map(([name]) => name), ["publish-fold", "publish-cli"]);
    assert.match(JOBS.get("publish-fold"), /run: npm publish\n\s*working-directory: apps\/fold/);
    assert.match(JOBS.get("publish-cli"), /run: npm publish\n\s*working-directory: apps\/cli/);
    for (const [, body] of publishing)
    {
        assert.equal((body.match(/run: npm publish/g) ?? []).length, 1);
    }
});

test("W3: the CLI cannot publish before the fold, and neither can publish before the gate", () =>
{
    assert.match(JOBS.get("publish-fold"), /^\s*needs: gate\s*$/m);
    assert.match(JOBS.get("publish-cli"), /^\s*needs: publish-fold\s*$/m);
    assert.ok(JOBS.get("gate").includes("runs-on:"), "the gate job read back empty — the workflow's shape moved");
    assert.ok(!JOBS.get("gate").includes("needs:"), "the gate waits for nothing — it is what everything waits for");
});

test("W4: the gate runs the version rules and the pack/install smoke, before either publish", () =>
{
    const gate = JOBS.get("gate");
    assert.match(gate, /node scripts\/release-gate\.mjs --tag "\$GITHUB_REF_NAME" --branch origin\/main/);
    assert.match(gate, /node scripts\/pack-install-smoke\.mjs/);
    assert.match(gate, /fetch-depth: 0/);
    assert.match(gate, /git fetch --no-tags origin \+refs\/heads\/main:refs\/remotes\/origin\/main/);
});

test("W5: the workspace-protocol guard is the last thing each publishing job does before publishing", () =>
{
    for (const name of ["publish-fold", "publish-cli"])
    {
        const body = JOBS.get(name);
        const guard = body.indexOf("scripts/no-workspace-protocol.mjs");
        const publish = body.indexOf("run: npm publish");
        assert.notEqual(guard, -1, `${name} publishes with no workspace-protocol guard`);
        assert.ok(guard < publish, `${name} runs its guard after publishing`);
        assert.ok(!body.slice(guard, publish).includes("- name: "), `${name} puts a step between its guard and the publish`);
    }
});

test("W6: publishing is OIDC — no job reads an npm token", () =>
{
    assert.match(workflow, /id-token: write/);
    assert.ok(!/NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./.test(workflow), "the workflow reads a secret to publish with");
});

// The CLI's `prepublishOnly` refuses a `rootkeys.ts` left pinning a development
// root, and that hook runs inside `publish-cli` — after `publish-fold` has put
// a version on the registry that can never be taken back. It is the one refusal
// able to fail the run halfway, so the gate runs it too: the fixture below is
// the state it refuses, and the command below is the gate's own step, exiting 0
// against the tree as it stands.
test("W7: the pinned-root-key check runs in the gate, so a rotation-state tree refuses before the fold is published", () =>
{
    assert.match(JOBS.get("gate"), /pnpm --filter superself release-keys/);
    const rotating = { paths: ["src/rootkeys.ts"], read: () => `kid: "dev-root-2026a"` };
    assert.equal(rootKeyViolations(rotating)[0]?.rule, "development-trust-anchor");
    assert.equal(rootKeyViolations({ paths: ["src/rootkeys.ts"], read: () => "" })[0]?.rule, "empty-trust-anchor");
    const ran = spawnSync("pnpm", ["--filter", "superself", "release-keys"], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(ran.status, 0, `${ran.stdout ?? ""}${ran.stderr ?? ""}`);
});

// The order proof is a `needs:` edge, and a `needs:` edge only holds while the
// default condition does. `if: always()` on `publish-fold` would run it after a
// failed gate; `continue-on-error: true` on it would let `publish-cli` publish a
// CLI whose fold never uploaded. `gate` is held to the same thing for the same
// reason one job earlier: `continue-on-error: true` there marks a refusal
// successful, and `needs: gate` reads success — so `publish-fold` would upload
// past every sentence the gate exists to print. All three absent — held here
// rather than noticed.
test("W8: no job in the chain carries a condition or swallows its own failure", () =>
{
    for (const name of ["gate", "publish-fold", "publish-cli"])
    {
        const body = JOBS.get(name);
        assert.ok(!/^\s*if:/m.test(body), `${name} carries an if: — a condition can run it past a failure`);
        assert.ok(!/continue-on-error/.test(body), `${name} swallows its own failure`);
    }
});

test("W9: overlapping v* runs queue rather than race the same publish", () =>
{
    assert.match(workflow, /^concurrency:\n {2}group: publish\n {2}cancel-in-progress: false$/m);
});
