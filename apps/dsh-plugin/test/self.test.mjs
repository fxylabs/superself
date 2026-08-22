import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { findProjectRoot, resolveBinary, runSelf, truncate } from "../lib/self.js";
import { parse, scratch } from "./harness.mjs";

function options(s, overrides = {})
{
    return { binary: "self", cwd: s.project, maxOutputChars: 20000, env: s.env, ...overrides };
}

test("defect 1: a self missing from PATH answers with the install line, not a throw", async () =>
{
    const s = scratch();
    const outcome = await runSelf(["context"], options(s, { env: { PATH: s.outside, HOME: s.root } }));
    assert.equal(outcome.ok, false);
    assert.match(outcome.text, /`self` CLI was not found/);
    assert.match(outcome.text, /npm i -g superself/);
    assert.match(outcome.text, /selfBinary/);
});

test("defect 1: the binary resolves through config as a path, then through PATH", () =>
{
    const s = scratch();
    assert.equal(resolveBinary("self", s.env), join(s.bin, "self"));
    assert.equal(resolveBinary(join(s.bin, "self"), { PATH: "" }), join(s.bin, "self"));
    assert.equal(resolveBinary("self", { PATH: s.outside }), undefined);
    assert.equal(resolveBinary(join(s.outside, "self"), s.env), undefined);
});

test("defect 2: the runner walks up from cwd to the `.self` root and says which root it used", async () =>
{
    const s = scratch();
    assert.equal(findProjectRoot(s.deep), s.project);
    const outcome = await runSelf(["context"], options(s, { cwd: s.deep }));
    assert.equal(outcome.ok, true);
    assert.equal(parse(outcome).cwd, s.project);
    assert.match(outcome.text, new RegExp(`\\(ran in project root ${s.project.replaceAll("/", "\\/")}\\)`));
    const atRoot = await runSelf(["context"], options(s));
    assert.doesNotMatch(atRoot.text, /ran in project root/);
});

test("defect 2: no `.self` up the tree answers with `self project init`", async () =>
{
    const s = scratch();
    assert.equal(findProjectRoot(s.outside), undefined);
    const outcome = await runSelf(["context"], options(s, { cwd: s.outside }));
    assert.equal(outcome.ok, false);
    assert.match(outcome.text, /No Superself project at or above/);
    assert.match(outcome.text, /self project init/);
});

test("defect 3: long output keeps its head and ends with a marker naming the command", async () =>
{
    const s = scratch();
    const outcome = await runSelf(["big", "5000"], options(s, { maxOutputChars: 1000 }));
    assert.equal(outcome.ok, true);
    assert.ok(outcome.text.startsWith("x".repeat(1000)));
    assert.match(outcome.text, /truncated 4000 more characters/);
    assert.match(outcome.text, /run `self big 5000` in/);
    assert.equal(truncate("short", 10, "self x", "/p"), "short");
    assert.equal(truncate("abcdef", 3, "self x", "/p"), "abc\n… [truncated 3 more characters — run `self x` in /p for the full output]");
});

test("defect 4: concurrent calls are independent child processes", async () =>
{
    const s = scratch();
    const [a, b] = await Promise.all([
        runSelf(["slow", "150"], options(s)),
        runSelf(["slow", "10"], options(s)),
    ]);
    assert.deepEqual(parse(a).argv, ["slow", "150"]);
    assert.deepEqual(parse(b).argv, ["slow", "10"]);
    assert.notEqual(parse(a).pid, parse(b).pid);
});

test("defect 6: every argv element reaches self verbatim — no shell, no splitting", async () =>
{
    const s = scratch();
    const hostile = "done; rm -rf / && echo $HOME `id` | cat";
    const outcome = await runSelf(["report", "w-abc12", "--", hostile], options(s));
    assert.deepEqual(parse(outcome).argv, ["report", "w-abc12", "--", hostile]);
});

test("a non-zero exit returns stderr trimmed", async () =>
{
    const s = scratch();
    const outcome = await runSelf(["fail", "nope"], options(s));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.text, "refused: nope");
});

test("an aborted call settles as a message rather than hanging", async () =>
{
    const s = scratch();
    const controller = new AbortController();
    const pending = runSelf(["slow", "5000"], options(s, { signal: controller.signal }));
    controller.abort();
    const outcome = await pending;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.text, "`self slow 5000` was cancelled");
});

test("defect 3: a long refusal on stderr is truncated the same way", async () =>
{
    const s = scratch();
    const outcome = await runSelf(["fail", "y".repeat(3000)], options(s, { maxOutputChars: 100 }));
    assert.equal(outcome.ok, false);
    assert.ok(outcome.text.startsWith("refused: " + "y".repeat(91)));
    assert.match(outcome.text, /truncated \d+ more characters/);
});
