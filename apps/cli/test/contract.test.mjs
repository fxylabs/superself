// One typed contract drives dispatch, parsing, and help. The checks walk the
// real declaration, and the spawned binary must answer for what it declares:
// a command that is documented but not dispatchable, dispatchable but not
// documented, or parsed against options its page never states fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "../dist/main.js";
import { branch, checkContract, commandLeaves, leaf } from "../dist/contract.js";
import { commandUsage, rootUsage } from "../dist/help.js";

const bin = fileURLToPath(new URL("../bin/self.mjs", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "self-contract-"));

const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".state")
};

function self(args)
{
    try
    {
        return { code: 0, out: execFileSync(process.execPath, [bin, ...args], { cwd: home, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
    }
    catch (error)
    {
        return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
    }
}

test("the declared command surface is one contract, not four that agree today", () =>
{
    assert.deepEqual(checkContract(COMMANDS), []);
});

test("the root help is the contract's own rendering", () =>
{
    const rendered = rootUsage(COMMANDS) + "\n";
    assert.equal(self(["--help"]).out, rendered);
    assert.equal(self([]).out, rendered);
    assert.equal(self(["help"]).out, rendered);
});

test("every declared command answers scoped help with the contract's rendering", () =>
{
    for (const command of COMMANDS)
    {
        const rendered = commandUsage(command) + "\n";
        const asked = self([command.name, "--help"]);
        assert.equal(asked.code, 0, `${command.name} --help failed: ${asked.out}`);
        assert.equal(asked.out, rendered, `${command.name} --help drifted from the contract`);
        assert.equal(self(["help", command.name]).out, rendered, `help ${command.name} drifted from the contract`);
    }
});

test("every declared leaf resolves — an option contract nothing can reach fails", () =>
{
    for (const command of COMMANDS)
    {
        for (const entry of commandLeaves(command))
        {
            assert.ok(entry.leaf.kind === "leaf", `${command.name} "${entry.verb}" is not a leaf`);
        }
    }
});

test("each drift class is named by the checks", () =>
{
    const run = () => {};
    const helpOnly = {
        name: "x",
        usage: [{ syntax: "x ghost", verbs: ["ghost"] }],
        detail: [],
        node: branch({ name: "x", unnamed: "refuse", refusal: "usage", children: [] })
    };
    assert.ok(checkContract([helpOnly]).some((p) => p.includes('"x ghost"')), "a help-only verb went unnamed");
    const dispatchOnly = {
        name: "x",
        usage: [],
        detail: [],
        node: branch({ name: "x", unnamed: "refuse", refusal: "usage", children: [leaf("hidden", {}, 0, run)] })
    };
    assert.ok(checkContract([dispatchOnly]).some((p) => p.includes("no usage line documents it")), "a dispatch-only verb went unnamed");
    const parserOnly = {
        name: "x",
        usage: [{ syntax: "x", verbs: [""] }],
        detail: [],
        node: leaf("", { silent: { type: "string" } }, 0, run)
    };
    assert.ok(checkContract([parserOnly]).some((p) => p.includes("--silent")), "an undocumented option went unnamed");
});

test("the issue-39 behaviors hold: unknown verbs refuse, help tokens keep their place", () =>
{
    const unknown = self(["bogus"]);
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.out, /unknown command 'bogus'/);
    // A `--help` in an option's value position belongs to the option, so the
    // call is not hijacked into a successful help print.
    assert.notEqual(self(["decide", "--why", "--help"]).code, 0);
    // After `--` every token is literal text, never a help request.
    assert.notEqual(self(["report", "--", "--help"]).code, 0);
    // Anywhere a flag could stand, `--help` wins and needs no workspace.
    assert.equal(self(["work", "show", "--help"]).out, commandUsage(COMMANDS.find((c) => c.name === "work")) + "\n");
});
