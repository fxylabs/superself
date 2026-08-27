// The one end-to-end check: the built CLI, spawned as a process, against a
// throwaway workspace. Everything of substance is asserted in the unit tests;
// this proves the binary starts, resolves a workspace, records state, and
// refuses what was cut.
//
// Cell 20 of #371's table. The rest of the suite drives the CLI inside the
// test process now, so this file is the only place the shebang, the `bin`
// mapping and the module resolution of a published install are exercised at
// all. It spawns on purpose and never stops: the exec count going to zero is
// the one way that migration could hide a broken binary behind a green suite.
// The exit-code half of the same guarantee is cell 21 in driver.test.mjs,
// which runs each code both ways and compares.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bin = fileURLToPath(new URL("../bin/self.mjs", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "self-smoke-"));
const workspace = join(home, "workspace");
mkdirSync(workspace);

const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".state"),
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_AUTHOR_NAME: "smoke",
    GIT_AUTHOR_EMAIL: "smoke@test",
    GIT_COMMITTER_NAME: "smoke",
    GIT_COMMITTER_EMAIL: "smoke@test"
};

function self(args, cwd = workspace)
{
    try
    {
        return { code: 0, out: execFileSync(process.execPath, [bin, ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
    }
    catch (error)
    {
        return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
    }
}

test("the root usage carries the surviving surface and none of the cut one", () =>
{
    const { out } = self(["--help"]);
    assert.match(out, /work add/);
    assert.match(out, /decide/);
    for (const gone of ["integration register", "review ingest", "work require", "approval-required", "daemon start", "overnight", "spec apply"])
    {
        assert.ok(!out.includes(gone), `usage still offers "${gone}"`);
    }
});

test("init creates a workspace this machine resolves", () =>
{
    const init = self(["init"]);
    assert.equal(init.code, 0, init.out);
    const status = self(["status"]);
    assert.equal(status.code, 0, status.out);
});

test("a cut verb refuses as an unknown command", () =>
{
    const { code, out } = self(["integration"]);
    assert.notEqual(code, 0);
    assert.match(out, /unknown command/);
});

test("a write outside a registered project is refused with the remedy", () =>
{
    const { code, out } = self(["work", "add", "outcome"]);
    assert.notEqual(code, 0);
    assert.match(out, /not inside a registered project/);
});

// Cell 3 of #389, and the strongest form of it: a child spawned with
// `stdio: ["ignore", …]` has no keyboard at all, which no driver can stand in
// for. What it records instead is a proposal, which is the line the refusal
// hands back — so the same process proves both halves of the rule.
test("inside a project, a process with no terminal cannot record confirmed work, and proposes instead", () =>
{
    const project = join(workspace, "project");
    mkdirSync(project);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project, env, stdio: "ignore" });
    assert.equal(self(["project", "init", "--name", "smoke", "--desc", "the smoke project", "--no-connect"], project).code, 0);
    const refused = self(["work", "add", "an outcome recorded with nobody there"], project);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /recording confirmed work is a person's call/);
    assert.match(refused.out, /self work propose "an outcome recorded with nobody there"/);
    const proposed = self(["work", "propose", "an outcome recorded with nobody there"], project);
    assert.equal(proposed.code, 0, proposed.out);
    const accepted = self(["work", "accept", proposed.out.match(/\bw-[0-9a-z]{5}\b/)[0]], project);
    assert.notEqual(accepted.code, 0);
    assert.match(accepted.out, /accepting a plan is a person's call/);
});
