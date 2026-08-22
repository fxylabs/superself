// Stage 5 of the render-gate case table (w-5emx6, #298): the last prints leave
// `main.ts`. The scalar reads answer with a value, the pre-dispatch answers —
// the version and the usage pages, which run before any command resolves — go
// to the gate directly, `work start` hands back its brief as a page, and the
// already-retired line is a receipt.
//
// Every cell asserts today's bytes, because a stage that moves where printing
// happens may not move what a reader sees. Cells 5 and 6 have a terminal half
// as well, in render-gate-tty.test.mjs, and cell 12 is golden.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { demoWorkspace, machine, must, retireFixture, selfIn, workIdIn } from "./harness.mjs";
import { deadExports, diskTree, interactionPrompt, memoryTree, packageRoot, printingModules, printSiteViolations } from "./structure.mjs";
import { COMMANDS } from "../dist/main.js";
import { commandUsage, rootUsage } from "../dist/help.js";

const bin = fileURLToPath(new URL("../bin/self.mjs", import.meta.url));

const box = machine();
const { ws, demo } = demoWorkspace(box);

// A machine that was never initialized: no workspace pointer, no store, no
// project. The answers that run before a command resolves have to come back
// from here too, which is what says the gate needed neither a leaf to be
// resolved nor a workspace to be read.
const bare = machine();

// The merged stream `selfIn` reports cannot say which descriptor a line came
// out of, and cell 8 is about exactly that, so this keeps the two apart.
function spawned(cwd, args, env = box.env)
{
    const result = spawnSync(process.execPath, [bin, ...args], { cwd, env, encoding: "utf8" });
    return { code: result.status, out: result.stdout, err: result.stderr };
}

/* ── cells 1-4: the scalar reads ───────────────────────────────────── */

// A machine with no workspace pointer is answered with the sentence that says
// where to make one. It is the read's value and not a refusal — the exit code
// is the proof — so it moves behind the gate as a value like the path does.
test("stage 5 cell 1: `self workspace` prints the pointer, or the wording for a machine with none", () =>
{
    const empty = selfIn(bare, bare.root, ["workspace"]);
    assert.equal(empty.code, 0);
    assert.equal(empty.out, "no workspace set — run `self init` in the directory that should hold it\n");
    const receipt = must(box, ws, ["workspace", ws]).out;
    const pointer = receipt.trim().replace("this machine now uses the workspace at ", "");
    assert.equal(must(box, ws, ["workspace"]).out, `${pointer}\n`);
});

test("stage 5 cell 2: `self timezone` prints the default, then what was set", () =>
{
    assert.equal(must(box, demo, ["timezone"]).out, "UTC\n");
    must(box, demo, ["timezone", "Asia/Seoul"]);
    assert.equal(must(box, demo, ["timezone"]).out, "Asia/Seoul\n");
});

test("stage 5 cell 3: `self theme` prints the default, then what was set", () =>
{
    assert.equal(must(box, demo, ["theme"]).out, "violet\n");
    must(box, demo, ["theme", "cyan"]);
    assert.equal(must(box, demo, ["theme"]).out, "cyan\n");
});

// The scale reads the same number two ways, and the half that differs is which
// of them it is: a shipped estimate until a measurement replaces it.
test("stage 5 cell 4: `self tokens` names the shipped estimate, then the measurement", () =>
{
    assert.equal(must(box, demo, ["tokens"]).out, "0.25 tokens per character — the shipped estimate\n");
    must(box, demo, ["tokens", "100", "400"]);
    assert.equal(must(box, demo, ["tokens"]).out, "0.25 tokens per character — measured\n");
});

/* ── cells 5-7: the answers with no command behind them ────────────── */

// Read out of the package the binary was built from, which is where the verb
// reads it: the assertion is that the switch still answers with it after the
// switch stopped printing for itself.
function packagedVersion()
{
    return String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
}

test("stage 5 cell 5: `self --version` prints the packaged version and nothing else", () =>
{
    for (const flag of ["--version", "-V"])
    {
        const answer = spawned(demo, [flag]);
        assert.equal(answer.code, 0, answer.err);
        assert.equal(answer.out, `${packagedVersion()}\n`);
        assert.equal(answer.err, "");
    }
});

// The switch runs before a command resolves, so nothing it reaches may need a
// store to read or a project to stand in.
test("stage 5 cell 5: `self --version` answers on a machine with no workspace at all", () =>
{
    const answer = spawned(bare.root, ["--version"], bare.env);
    assert.equal(answer.code, 0, answer.err);
    assert.equal(answer.out, `${packagedVersion()}\n`);
});

// The verb list is rendered from the command contract, so the contract is the
// oracle: what a piped run prints is that render and one newline.
test("stage 5 cell 6: bare `self` prints the rendered verb list", () =>
{
    const answer = spawned(demo, []);
    assert.equal(answer.code, 0, answer.err);
    assert.equal(answer.out, `${rootUsage(COMMANDS)}\n`);
});

// What the CLI can do is the first thing a person asks it, and they ask before
// there is a workspace to ask from.
test("stage 5 cell 6: bare `self` answers the same list on a machine with no workspace", () =>
{
    const answer = spawned(bare.root, [], bare.env);
    assert.equal(answer.code, 0, answer.err);
    assert.equal(answer.out, `${rootUsage(COMMANDS)}\n`);
});

test("stage 5 cell 7: `self work --help` prints that command's rendered page", () =>
{
    const work = COMMANDS.find((command) => command.name === "work");
    const answer = spawned(demo, ["work", "--help"]);
    assert.equal(answer.code, 0, answer.err);
    assert.equal(answer.out, `${commandUsage(work)}\n`);
});

// A verb nobody owns is a mistake, and a mistake is not an answer: it goes to
// stderr with a non-zero exit, and nothing reaches stdout for a caller to read
// the usage text as success.
test("stage 5 cell 8: an unknown verb is refused on stderr, with nothing on stdout", () =>
{
    const answer = spawned(demo, ["nosuch"]);
    assert.equal(answer.code, 1);
    assert.equal(answer.out, "");
    // The refusal line itself is unchanged. PR7 adds the hint under it, in the
    // same shape every other refusal's hint takes, because a first token this
    // CLI does not own may now be a mini-app verb that is simply not installed
    // — and "unknown command" with no way forward is the answer that sends an
    // agent looking in the wrong place.
    assert.equal(answer.err.replace(/\x1b\[[0-9;]*m/g, ""),
        "error: unknown command 'nosuch' — run `self --help` for the syntax\n"
        + "    if it is a mini-app, install it with `self app install nosuch`\n");
});

/* ── cell 9: the brief, under the lines that were said before it ───── */

let seq = 0;

const asSession = (name, pid) => ({ SUPERSELF_SESSION: `${name}-${seq}`, SUPERSELF_SESSION_PID: pid ?? "" });

// A pid this machine had and does not any more, so the holder it stands for
// reads as ended and the claim moves — which is the case that prints all three
// kinds of line at once.
const GONE = String(spawnSync(process.execPath, ["-e", ""]).pid);
const ALIVE = String(process.pid);

function freshUnit()
{
    seq += 1;
    return workIdIn(must(box, demo, ["work", "add", `stage five outcome ${seq}`]).out);
}

test("stage 5 cell 9: the held note, the append's line and the brief keep their order", () =>
{
    const id = freshUnit();
    must(box, demo, ["work", "start", id], asSession("alpha", GONE));
    const taken = selfIn(box, demo, ["work", "start", id], asSession("beta", ALIVE));
    assert.equal(taken.code, 0, taken.out);
    const held = taken.out.indexOf("was held by another session, ended ");
    const announced = taken.out.indexOf("entity.started");
    const brief = taken.out.indexOf(`# ${id} —`);
    assert.ok(held !== -1 && announced !== -1 && brief !== -1, taken.out);
    assert.ok(held < announced, `the disclosure moved under the append line:\n${taken.out}`);
    assert.ok(announced < brief, `the brief moved above the append line:\n${taken.out}`);
});

test("stage 5 cell 9: a live holder is disclosed above the brief and the claim does not move", () =>
{
    const id = freshUnit();
    must(box, demo, ["work", "start", id], asSession("alpha", ALIVE));
    const other = selfIn(box, demo, ["work", "start", id], asSession("beta", ALIVE));
    assert.equal(other.code, 0, other.out);
    const held = other.out.indexOf("held by another session, running since ");
    const brief = other.out.indexOf(`# ${id} —`);
    assert.ok(held !== -1 && brief !== -1, other.out);
    assert.ok(held < brief, other.out);
    assert.ok(!other.out.includes("entity.started"), `the claim moved to a live holder's unit:\n${other.out}`);
});

/* ── cell 10: retiring what is already retired ─────────────────────── */

// Repeating a transition that already holds records nothing and refuses
// nothing, so what comes back is a receipt for the state that stands. The unit
// is retired through a written event rather than the verb, because destroying
// a record needs a person at a terminal (#173).
test("stage 5 cell 10: `self work retire` on a retired unit answers with the line it always printed", () =>
{
    const id = freshUnit();
    retireFixture(box, ws, "demo", "entity.retired", { entity: id, why: "the outcome moved" });
    const again = selfIn(box, demo, ["work", "retire", id, "--why", "asked a second time"]);
    assert.equal(again.code, 0, again.out);
    assert.equal(again.out, `${id} is already retired — the outcome moved\n`);
});

/* ── cell 11: the tree the migration leaves ────────────────────────── */

test("stage 5 cell 11: the printing ratchet is empty and the tree prints only from the gate", () =>
{
    assert.deepEqual([...printingModules], []);
    assert.deepEqual(printSiteViolations(diskTree(packageRoot)), []);
});

test("stage 5 cell 11: the confirmation prompt is the one declared interaction, and it still prints", () =>
{
    assert.equal(interactionPrompt, "src/human.ts");
    assert.match(diskTree(packageRoot).read(interactionPrompt), /process\.stdout\.write/);
});

// The rule walks every module, so emptying the list weakens nothing: a print
// planted anywhere but the gate and the one interaction is named by file, line
// and rule.
test("stage 5 cell 11: a print planted in any other module is still named", () =>
{
    const planted = memoryTree({ "src/pretty.ts": "export function draw()\n{\n    console.log(\"table\");\n}\n" });
    const [violation] = printSiteViolations(planted);
    assert.equal(violation.file, "src/pretty.ts");
    assert.equal(violation.line, 3);
    assert.equal(violation.rule, "print-site");
    assert.match(violation.detail, /console\.log outside the render gate/);
});

test("stage 5 cell 11: no export in the tree has lost its importer", () =>
{
    assert.deepEqual(deadExports(diskTree(packageRoot)), []);
});

/* ── cell 13: a handler with nothing to return is still a handler ──── */

// The dispatcher prints only what comes back as blocks, so a verb whose whole
// answer is the append's own announce line returns nothing and is unaffected.
// `self decide` is one, and the assertion is that it still runs and still says
// exactly what it said.
test("stage 5 cell 13: a leaf whose run returns void dispatches and prints its announce line alone", () =>
{
    const answer = selfIn(box, demo, ["decide", "void stays legal", "--why", "the shapes are what a handler may return, not what it must"]);
    assert.equal(answer.code, 0, answer.out);
    const lines = answer.out.split("\n").filter((line) => line !== "");
    assert.equal(lines.length, 1, answer.out);
    assert.match(lines[0], /^entity\.confirmed recorded \[[0-9abcdefghjkmnpqrstvwxyz]{26}\]$/);
});
