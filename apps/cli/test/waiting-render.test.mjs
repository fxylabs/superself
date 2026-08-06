// What a person at a terminal is shown about approvals (#264). Every case here
// is a cell of the issue's table: one waiting-row kind against the two renders,
// asserting that the row is present and that the command ruling on it is
// printed in full. The terminal render had no coverage at all before this file,
// which is how a whole waiting kind went missing from it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { demoWorkspace, machine, must, workIdIn } from "./harness.mjs";

const box = machine();
const { demo } = demoWorkspace(box);

// The render a person gets. Forced by flag rather than by a terminal: a test
// has no terminal, and the flag is the same answer `resolveRender` gives one.
function terminal(args = ["context"])
{
    return must(box, demo, [...args, "--pretty"]).out;
}

function piped(args = ["context"])
{
    return must(box, demo, [...args, "--plain"]).out;
}

function entityIn(text)
{
    const match = text.match(/\be-[0-9a-z]{5}\b/);
    if (match === null)
    {
        throw new Error(`no entity id in: ${text}`);
    }
    return match[0];
}

// Every id used below is minted once, so the assertions read against one store
// holding one of each waiting kind at the same time — which is also the case
// where a band that drops a kind is easiest to miss.
const rule = entityIn(must(box, demo, ["state", "add", "a standing rule", "--exposure", "full"]).out);
must(box, demo, ["state", "place", rule, "--exposure", "index", "--why", "too broad for full", "--proposed"]);

const proposedDecision = must(box, demo, ["decide", "a rule nobody confirmed", "--why", "it needs a ruling", "--proposed"])
    .out.match(/\b[0-9a-z]{26}\b/)[0];

// A proposal is made against an objective, and an objective against a goal.
must(box, demo, ["goal", "add", "a direction"]);
const objective = must(box, demo, ["objective", "add", "a measurable outcome", "--target", "2099-01-01"])
    .out.match(/\bo-[0-9a-z]{5}\b/)[0];

const proposal = workIdIn(must(box, demo, ["work", "propose", "a proposed direction", "--objective", objective,
    "--value", "closes the gap", "--success", "it ships", "--stop", "if superseded",
    "--risk", "low", "--capacity", "one round", "--evidence-plan", "a recorded run",
    "--confidence", "high", "--expires", "2099-01-01"]).out).slice(0, 8);

const blocked = workIdIn(must(box, demo, ["work", "add", "an outcome waiting on a ruling"]).out);
must(box, demo, ["work", "block", blocked, "--on", "decision", "--why", "the ruling above settles it"]);

test("a pending placement reaches the terminal render with the command that confirms it", () =>
{
    const shown = terminal();
    assert.ok(shown.includes(`proposed placement of ${rule}`),
        `the terminal render dropped the pending placement:\n${shown}`);
    assert.ok(shown.includes(`self state confirm ${rule}`),
        `the command only a person can run was not printed:\n${shown}`);
});

test("a work proposal carries its accept command, which the row text never swallows", () =>
{
    const shown = terminal();
    assert.ok(shown.includes(`work proposal ${proposal}`), `the proposal row is missing:\n${shown}`);
    // The brief is six lines and the accept command is the last of them, so a
    // render that prints the first line alone loses it entirely.
    assert.ok(shown.includes(`self work accept ${proposal}`), `the accept command was truncated away:\n${shown}`);
});

test("a proposed decision carries its confirm command in the attention band", () =>
{
    assert.ok(terminal().includes(`self decide confirm ${proposedDecision}`));
});

test("a unit blocked on a decision carries the command that shows it", () =>
{
    const shown = terminal();
    assert.ok(shown.includes(blocked), `the blocked unit is missing from the band:\n${shown}`);
    assert.ok(shown.includes(`self work show ${blocked}`), `the blocked row named no command:\n${shown}`);
});

test("the band is legible with no colour at all", () =>
{
    const shown = terminal();
    // Off a terminal nothing is painted, which is the same text `NO_COLOR`
    // produces at one. The marker and the command's own line are what carry
    // the meaning there, so both have to hold without an escape sequence.
    assert.ok(!shown.includes("\u001b["), "the render painted output that was never going to a terminal");
    assert.match(shown, /▸ proposed placement of/);
});

test("waiting rows lead the page, ahead of the work roll-up", () =>
{
    const shown = terminal();
    assert.ok(shown.indexOf("WAITING ON YOU") < shown.indexOf("WORK ("),
        `the approval band sank below the work table:\n${shown}`);
    assert.ok(shown.indexOf("WAITING ON YOU") < shown.indexOf("DECISIONS WAITING"),
        "the two approval bands are no longer adjacent at the top");
});

test("status shows the same band with the same commands", () =>
{
    const shown = terminal(["status"]);
    assert.ok(shown.includes(`self state confirm ${rule}`), `status dropped the confirm command:\n${shown}`);
    assert.ok(shown.includes(`self work accept ${proposal}`), `status dropped the accept command:\n${shown}`);
});

test("the piped render still says everything in one sentence per row", () =>
{
    const shown = piped();
    // The machine contract: the command travels inside the row's own sentence,
    // where it has always been, rather than on a line of its own.
    assert.ok(shown.includes(`- proposed placement of ${rule}: exposure index (too broad for full) (confirm with \`self state confirm ${rule}\`)`),
        `the piped sentence changed shape:\n${shown}`);
    assert.ok(shown.includes(`self work accept ${proposal}`));
    assert.ok(!shown.includes("▸"), "a terminal marker reached the piped render");
});
