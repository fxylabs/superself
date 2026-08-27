// Cell 26 of issue #302's case table, alone in a file because of what it takes
// to reach: `self status` prints its waiting rows — and the call to action on
// each — only at a terminal, and `style.ts` answers "is this run styled" once,
// when it is first imported. A test that wants that render has to say so before
// the built modules load and run the command in this process, the way
// render-gate-tty.test.mjs does.
//
// The cell itself is the convention's: an output that advertises a command is
// read somewhere, and the command has to run there. `self context` carries the
// same cell in confirm-owner.test.mjs, where the piped render prints the lines.
process.stdout.isTTY = true;
process.env.TERM = "xterm";
delete process.env.NO_COLOR;

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// `mustSpawn`/`spawnIn` rather than `must`/`selfIn`, as in the other two files
// that set `isTTY` above their imports: the styled decision is already made, so
// a command driven in this process would answer painted (#371, cell 23).
const { approvedIn, git, machine, mustSpawn, personIn } = await import("./harness.mjs");
const { styled } = await import("../dist/style.js");

const box = machine();
const ws = join(box.root, "ws");
const alpha = join(ws, "alpha");
mkdirSync(alpha, { recursive: true });
mustSpawn(box, ws, ["init"]);
git(box, alpha, ["init", "-q", "-b", "main"]);
mustSpawn(box, alpha, ["project", "init", "--name", "alpha", "--no-connect"]);
mustSpawn(box, alpha, ["goal", "add", "a direction"]);
const objective = mustSpawn(box, alpha, ["objective", "add", "a measurable outcome", "--target", "2099-01-01"])
    .out.match(/\bo-[0-9a-z]{5}\b/)[0];

mustSpawn(box, alpha, ["work", "propose", "an outcome a terminal reader is shown", "--objective", objective,
    "--value", "closes the gap", "--success", "it ships", "--stop", "if superseded", "--risk", "low",
    "--capacity", "one round", "--evidence-plan", "a recorded run", "--confidence", "high",
    "--expires", "2099-01-01"]);
mustSpawn(box, alpha, ["decide", "a direction a terminal reader is shown", "--why", "it was weighed", "--proposed"]);
mustSpawn(box, alpha, ["state", "add", "a record a terminal reader is shown", "--proposed"]);

const ADVERTISED = /self (work accept [^\s`]+|decide confirm [^\s`]+|state confirm [^\s`]+)/g;

// The styled render carries escape sequences around the notes, and a command
// with one inside it is not the command a reader copies.
function plain(text)
{
    // eslint-disable-next-line no-control-regex
    return text.replace(/\[[0-9;]*m/g, "");
}

test("this file loads with a styled stdout, or its cell asserts nothing", () =>
{
    assert.equal(styled, true);
});

test("cell 26: every line self status --project prints at a terminal runs where it was read", async () =>
{
    const read = await approvedIn(box, ws, ["status", "--project", "alpha"], "");
    assert.equal(read.code, 0, read.out);
    const lines = [...plain(read.out).matchAll(ADVERTISED)].map((match) => match[1].split(" "));
    // Two kinds, not three: `renderStatus` prints the decisions-waiting band as
    // a count and leaves the rows to `self context`, so `self decide confirm` is
    // advertised there and not here. What this cell holds is that every command
    // this render does print runs where the render was read.
    const kinds = new Set(lines.map((argv) => argv.slice(0, 2).join(" ")));
    assert.deepEqual([...kinds].sort(), ["state confirm", "work accept"],
        `self status --project advertised something other than the two kinds it prints:\n${plain(read.out)}`);
    for (const argv of lines)
    {
        // Driven in this process with a keyboard, not spawned: one of the two
        // advertised lines is `work accept`, which a process with no person at
        // it cannot run (#389), and a child cannot be given one. Only the exit
        // code is read here, so the painted output costs this cell nothing.
        const ran = await personIn(box, ws, argv);
        assert.equal(ran.code, 0, `\`self ${argv.join(" ")}\` failed where the render was read:\n${ran.out}`);
    }
});
