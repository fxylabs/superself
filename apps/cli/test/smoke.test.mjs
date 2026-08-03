// The one end-to-end check: the built CLI, spawned as a process, against a
// throwaway workspace. Everything of substance is asserted in the unit tests;
// this proves the binary starts, resolves a workspace, records state, and
// refuses what was cut.
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
