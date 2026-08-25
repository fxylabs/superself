// The human approval checkpoint on a runbook run (#171, group D).
//
// Alone in a file because of what its cells take to reach: releasing a held
// run needs a person at an interactive terminal, and the only place that path
// can execute is in-process, where `approvedIn` stands a keyboard in for the
// one thing a test cannot supply. The refusals are asserted the other way
// round — through `selfIn`, which is a real piped child process, because that
// is the run the gate is meant to turn away.
//
// Every test is one cell of docs/maintainers/case-tables/171-runbooks.md,
// named by its cell id. The rulings this group stands on:
//
//   R8  a hold is `entity.blocked on:"approval"`; an approval is
//       `entity.unblocked` written only after `confirmHuman` returned
//   R9  the two state refusals — already blocked, not blocked — come from the
//       one place `state block` and `state unblock` write them
//   R10 `--by` records who approved and gates nothing
//   R11 a held run renders in `## Waiting on you` in **both** context
//       assemblies; a non-runbook entity blocked on "approval" still renders
//       in neither, which is the gap this issue does not close
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { approvedIn, demoWorkspace, machine, must, selfIn } from "./harness.mjs";

function floor()
{
    const box = machine();
    const { ws, demo } = demoWorkspace(box);
    return { box, ws, demo, self: (args, extra = {}) => selfIn(box, demo, args, extra) };
}

function entityIn(text)
{
    const match = text.match(/\be-[0-9a-z]{5}\b/);
    assert.ok(match !== null, `no entity id in: ${text}`);
    return match[0];
}

function events(ws)
{
    return readFileSync(join(ws, ".superself", "projects", "demo", "log.jsonl"), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line));
}

// A project with one procedure and one run of it, part-way through and held on
// a person — the state every cell below starts from except where it says not.
function held(why = "the final cut needs a look")
{
    const ground = floor();
    const definition = entityIn(must(ground.box, ground.demo,
        ["runbook", "add", "content loop", "--stage", "plan", "--stage", "approve", "--stage", "publish"]).out);
    const run = entityIn(must(ground.box, ground.demo, ["runbook", "start", definition, "--instance", "E001"]).out);
    must(ground.box, ground.demo, ["runbook", "advance", "E001", "--why", "planned it"]);
    must(ground.box, ground.demo, ["runbook", "hold", "E001", "--why", why]);
    return { ...ground, definition, run };
}

function waitingBlock(text)
{
    const lines = text.split("\n");
    const at = lines.indexOf("## Waiting on you");
    if (at < 0)
    {
        return "";
    }
    const rest = lines.slice(at + 1);
    const end = rest.findIndex((line) => line.startsWith("## "));
    return rest.slice(0, end < 0 ? rest.length : end).join("\n");
}

/* ── holding a run ─────────────────────────────────────────────────── */

test("D1: hold parks the run on a person, as a block the entity grammar already has", () =>
{
    const ground = held();
    const blocked = events(ground.ws).filter((event) => event.type === "entity.blocked");
    assert.equal(blocked.length, 1);
    assert.deepEqual({ entity: blocked[0].payload.entity, on: blocked[0].payload.on },
        { entity: ground.run, on: "approval" });
    assert.match(must(ground.box, ground.demo, ["state", "show", ground.run]).out, /blocked/);
});

test("D2: the held run waits on a person in the piped context, with the command that releases it", () =>
{
    const ground = held();
    const block = waitingBlock(must(ground.box, ground.demo, ["context"]).out);
    assert.match(block, /E001 .* waits on your approval: the final cut needs a look/);
    assert.match(block, /approve with `self runbook approve E001`/);
});

// The ruled render is asked for by name rather than by standing at a terminal:
// `--pretty` settles the mode whatever `isTTY` and `TERM` say, so this cell
// asserts the terminal assembly itself instead of whatever the runner's
// environment happened to resolve to.
test("D2b: the same wait reaches the terminal render, because both assemblies were joined", () =>
{
    const ground = held();
    for (const surface of [["context", "--pretty"], ["status", "--pretty"]])
    {
        const shown = must(ground.box, ground.demo, surface);
        assert.match(shown.out, /E001/, `${surface[0]} lost the run`);
        assert.match(shown.out, /self runbook approve E001/, `${surface[0]} lost the command that releases it`);
    }
});

test("D3: a held run passes no stage until it is released", () =>
{
    const ground = held();
    const refused = ground.self(["runbook", "advance", "E001", "--why", "carrying on"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is already blocked — the final cut needs a look/);
    assert.match(refused.out, /self runbook approve E001/);
});

/* ── the gate ──────────────────────────────────────────────────────── */

test("D4: a piped run cannot approve — the terminal is what makes the approval a person's", () =>
{
    const ground = held();
    const refused = ground.self(["runbook", "approve", "E001", "--by", "rayim"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /no terminal to make it at/);
    assert.match(refused.out, /self runbook approve E001/);
    assert.equal(events(ground.ws).some((event) => event.type === "entity.unblocked"), false);
});

test("D5: a process carrying an agent's mark is refused even where a terminal would answer", async () =>
{
    const ground = held();
    // The mark is read from the environment at the moment of the call, so it
    // is set for this call alone — the in-process runner is otherwise exactly
    // the terminal D7 approves at.
    process.env.SUPERSELF_SESSION = "an agent's process";
    try
    {
        const refused = await approvedIn(ground.box, ground.demo, ["runbook", "approve", "E001"], "E001");
        assert.notEqual(refused.code, 0, refused.out);
        assert.match(refused.out, /no terminal to make it at/);
    }
    finally
    {
        delete process.env.SUPERSELF_SESSION;
    }
    assert.equal(events(ground.ws).some((event) => event.type === "entity.unblocked"), false);
});

test("D6: a wrong answer at the terminal approves nothing and records nothing", async () =>
{
    const ground = held();
    const before = events(ground.ws).length;
    const refused = await approvedIn(ground.box, ground.demo, ["runbook", "approve", "E001"], "E002");
    assert.notEqual(refused.code, 0, refused.out);
    assert.equal(events(ground.ws).length, before);
});

test("D7: the key typed back at a terminal releases the run, and what was typed is in the record", async () =>
{
    const ground = held();
    const approved = await approvedIn(ground.box, ground.demo, ["runbook", "approve", "E001", "--by", "rayim"], "E001");
    assert.equal(approved.code, 0, approved.out);
    const unblocked = events(ground.ws).find((event) => event.type === "entity.unblocked");
    assert.equal(unblocked.payload.entity, ground.run);
    assert.deepEqual(unblocked.payload.confirmation, { method: "tty", challenge: "E001" });
    assert.equal(unblocked.payload.by, "rayim");
    assert.equal(waitingBlock(must(ground.box, ground.demo, ["context"]).out).includes("waits on your approval"), false);
});

test("D8: once released, the run passes its next stage", async () =>
{
    const ground = held();
    await approvedIn(ground.box, ground.demo, ["runbook", "approve", "E001"], "E001");
    const passed = ground.self(["runbook", "advance", "E001", "--why", "the cut was approved"]);
    assert.equal(passed.code, 0, passed.out);
    assert.match(passed.out, /E001 passed "approve" — next: publish/);
});

/* ── the two state refusals, from one place ────────────────────────── */

test("D9: approving a run nobody held is refused in the words `state unblock` writes", () =>
{
    const ground = floor();
    const definition = entityIn(must(ground.box, ground.demo,
        ["runbook", "add", "content loop", "--stage", "plan"]).out);
    const run = entityIn(must(ground.box, ground.demo, ["runbook", "start", definition, "--instance", "E001"]).out);
    const refused = ground.self(["runbook", "approve", "E001"]);
    assert.notEqual(refused.code, 0);
    assert.equal(refused.out.trim(), `error: ${run} is not blocked — there is nothing to unblock`);
    // The same sentence, from the raw verb that owns it.
    assert.equal(ground.self(["state", "unblock", run]).out.trim(), refused.out.trim());
});

test("D10: holding a run that is already held is refused in the words `state block` writes", () =>
{
    const ground = held();
    const refused = ground.self(["runbook", "hold", "E001", "--why", "again"]);
    assert.notEqual(refused.code, 0);
    assert.equal(refused.out.trim(), `error: ${ground.run} is already blocked — the final cut needs a look`);
    assert.equal(ground.self(["state", "block", ground.run]).out.trim(), refused.out.trim());
});

test("D11: the hold and the release both read back on the log", async () =>
{
    const ground = held();
    await approvedIn(ground.box, ground.demo, ["runbook", "approve", "E001"], "E001");
    const log = must(ground.box, ground.demo, ["log", "-n", "6"]).out;
    assert.match(log, /entity\.blocked/);
    assert.match(log, /entity\.unblocked/);
});

/* ── what the surface does not bring back, and does not widen ──────── */

test("D12: the root usage still offers no `approval-required` — the retired name stays retired", () =>
{
    const ground = floor();
    const help = must(ground.box, ground.demo, ["--help"]).out;
    for (const gone of ["approval-required", "work require", "overnight", "spec apply", "daemon start"])
    {
        assert.ok(!help.includes(gone), `the root usage offers "${gone}"`);
    }
    assert.match(help, /runbook hold/);
});

test("D13: an ordinary entity blocked on approval still raises no waiting row — the gap this issue leaves", () =>
{
    const ground = floor();
    const note = entityIn(must(ground.box, ground.demo, ["state", "add", "a record someone must sign off"]).out);
    must(ground.box, ground.demo, ["state", "block", note, "--on", "approval", "--why", "legal has to read it"]);
    const block = waitingBlock(must(ground.box, ground.demo, ["context"]).out);
    assert.equal(block.includes(note), false, `the entity reached the waiting block:\n${block}`);
    assert.equal(block.includes("legal has to read it"), false, block);
});
