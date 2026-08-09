// The terminal half of the render-gate case table (w-5emx6 stage 1): cells 2,
// 5 and 8, plus stage 2's cell 2. `style.ts` answers "is this run styled" once, when it is first
// imported, from stdout — so a test that wants the styled answer has to say so
// before the built modules load, and run the command in this process rather
// than in a child whose stdout is a pipe.
process.stdout.isTTY = true;
process.env.TERM = "xterm";
delete process.env.NO_COLOR;

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const { approvedIn, git, machine, must } = await import("./harness.mjs");
const { renderOutput } = await import("../dist/output.js");
const { bold, dim, green, styled } = await import("../dist/style.js");

const box = machine();
const ws = join(box.root, "ws");
const demo = join(ws, "demo");
mkdirSync(demo, { recursive: true });
must(box, ws, ["init"]);
git(box, demo, ["init", "-q", "-b", "main"]);
must(box, demo, ["project", "init", "--name", "demo", "--desc", "the render gate", "--no-connect"]);

test("this file loads with a styled stdout, or its cells assert nothing", () =>
{
    assert.equal(styled, true);
});

// A scalar answer is a value whatever the terminal is. The gate resolves the
// render mode for every run, and the cell that matters is that resolving it
// changed nothing here: the bytes are the piped bytes of cells 4 and 1.
test("cell 5: at a terminal, `self lang ko` prints the same bytes a pipe gets", async () =>
{
    const answer = await approvedIn(box, demo, ["lang", "ko"], "");
    assert.equal(answer.code, 0, answer.out);
    assert.equal(answer.printed, "views now render in \"ko\"\n");
});

test("cell 2: at a terminal, `self lang` prints the same bytes a pipe gets", async () =>
{
    const answer = await approvedIn(box, demo, ["lang"], "");
    assert.equal(answer.code, 0, answer.out);
    assert.equal(answer.printed, "ko\n");
});

// The append's confirmation line is not a command's answer — it is a notice
// from a lower layer, printed while the command is still running. Moving it
// through the gate's `notice` left its styling where it was composed.
test("cell 8: at a styled terminal, an event verb prints today's ✓ line", async () =>
{
    const text = "the gate prints once";
    const answer = await approvedIn(box, demo, ["decide", text, "--proposed"], "");
    assert.equal(answer.code, 0, answer.out);
    // The id is read by its own grammar rather than out of the first brackets:
    // a styled line opens with an escape sequence, and those carry brackets too.
    const id = answer.printed.match(/\[([0-9abcdefghjkmnpqrstvwxyz]{26})\]/)[1];
    assert.equal(answer.printed,
        `${green("✓")} ${bold("entity.proposed")}  ${dim(text)}  ${dim(`[${id}]`)}\n`);
});

// The bare id a work unit is created under is a receipt, and a receipt is the
// same bytes at a terminal as in a pipe. What the terminal changes is the
// announce line above it, which `pipeline.ts` still composes — so this cell is
// the two of them together, in the order they have always been printed in.
test("stage 2 cell 2: at a terminal, `self work add` styles the announce line and leaves the id alone", async () =>
{
    const outcome = "the receipts answer through the gate";
    const answer = await approvedIn(box, demo, ["work", "add", outcome], "");
    assert.equal(answer.code, 0, answer.out);
    const [announced, id] = answer.printed.split("\n");
    const event = announced.match(/\[([0-9abcdefghjkmnpqrstvwxyz]{26})\]/)[1];
    assert.equal(announced, `${green("✓")} ${bold("entity.confirmed")}  ${dim(`${id} ${outcome}`)}  ${dim(`[${event}]`)}`);
    assert.match(answer.printed, /\nw-[0-9abcdefghjkmnpqrstvwxyz]{5}\n$/);
});

// The gate resolves the render once per run and hands it to the blocks that
// have two forms. A receipt's next command is the one stage 1 declares: weight
// is the terminal's signal for "this is runnable" (`pretty.ts`), and a run
// answered plainly gets the same characters without it.
test("the gate prints a receipt's next command under it, weighted only where the run is styled", () =>
{
    const said = [];
    const log = console.log;
    console.log = (...parts) => said.push(parts.join(" "));
    try
    {
        const block = { kind: "receipt", text: "recorded", next: "self work --project demo" };
        renderOutput([block], { plain: true });
        renderOutput([block], { pretty: true });
    }
    finally
    {
        console.log = log;
    }
    assert.deepEqual(said, [
        "recorded",
        "    self work --project demo",
        "recorded",
        `    ${bold("self work --project demo")}`
    ]);
});
