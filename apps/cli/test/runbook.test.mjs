// A reusable project procedure, and the runs that follow it (#171 part 1).
//
// Every test below is one cell of the case table in
// docs/maintainers/case-tables/171-runbooks.md, named by its cell id, and
// asserts that cell's stated outcome. Groups A (the definition), B (starting a
// run), C (advancing one), F (editions and drift) and G (project scope) land
// here; the human approval gate, stopping and resuming a run, and the link to
// work units are part 2 of the issue.
//
// The rulings the table stands on:
//
//   R1  a definition is an entity labelled `runbook` whose stages are its
//       reserved `criteria`; a run is an entity labelled `runbook-run` that
//       copied them and links `member-of` the edition it started under
//   R2  no new event type: propose/confirm, cover and link do all of it
//   R3  an edition is a place in the supersedes chain, derived and never
//       stored; the chain's root id is the stable workflow id
//   R4  a revision is a new record proposed with a supersedes link, landed by
//       `self state confirm` — `entity.revised` cannot carry criteria
//   R5  a run copies its stages, so a later edition cannot silently change
//       what a run in flight means; the difference is shown, never blocking
//   R6  neither label is a root preset verb: the placement rows are local to
//       `runbook.ts`, out of `BUILTIN_ROWS`
//   R7  there is no completion verb here — `self state done <id> --report r`
//       already carries the evidence gate
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approvedIn, demoWorkspace, git, machine, must, selfIn } from "./harness.mjs";

/* ── the floor every cell stands on ────────────────────────────────── */

function floor()
{
    const box = machine();
    const { ws, demo } = demoWorkspace(box);
    return { box, ws, demo, self: (args, cwd = demo) => selfIn(box, cwd, args) };
}

function entityIn(text)
{
    const match = text.match(/\be-[0-9a-z]{5}\b/);
    assert.ok(match !== null, `no entity id in: ${text}`);
    return match[0];
}

function addRunbook(ground, name, stages, at = ground.demo)
{
    const args = ["runbook", "add", name];
    for (const stage of stages)
    {
        args.push("--stage", stage);
    }
    return entityIn(must(ground.box, at, args).out);
}

function startRun(ground, definition, key)
{
    return entityIn(must(ground.box, ground.demo, ["runbook", "start", definition, "--instance", key]).out);
}

function events(ws, slug = "demo")
{
    return readFileSync(join(ws, ".superself", "projects", slug, "log.jsonl"), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line));
}

function stateDir(ws, slug = "demo")
{
    return join(ws, ".superself", "projects", slug);
}

// Caps are user-set values in the store's config.json, in tokens: one token
// per character here, so the cap A19 sets is a character count.
function setCaps(ws, caps)
{
    const file = join(ws, ".superself", "config.json");
    const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    writeFileSync(file, JSON.stringify({ ...config, tokensPerCharacter: 1, tokensMeasured: true, ...caps }) + "\n");
}

// The `## Runbooks` block of a piped context, without the sections around it.
function runbookBlock(text)
{
    const lines = text.split("\n");
    const at = lines.indexOf("## Runbooks");
    if (at < 0)
    {
        return "";
    }
    const rest = lines.slice(at + 1);
    const end = rest.findIndex((line) => line.startsWith("## "));
    return rest.slice(0, end < 0 ? rest.length : end).join("\n");
}

// A revision, landed: the agent proposes and the person confirms, which is
// the two-step this surface is built on (R4).
function revise(ground, definition, stages, why = "the procedure moved")
{
    const args = ["runbook", "revise", definition, "--why", why];
    for (const stage of stages)
    {
        args.push("--stage", stage);
    }
    const proposed = entityIn(must(ground.box, ground.demo, args).out);
    must(ground.box, ground.demo, ["state", "confirm", proposed]);
    return proposed;
}

/* ── group A: the definition ───────────────────────────────────────── */

test("A1: a project with no runbooks says so and names the verb that registers one", () =>
{
    const ground = floor();
    const listed = ground.self(["runbook"]);
    assert.equal(listed.code, 0, listed.out);
    assert.match(listed.out, /no runbooks registered/);
    assert.match(listed.out, /self runbook add/);
});

test("A2: an add records one definition with an entity id, at edition v1", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft", "publish"]);
    assert.match(id, /^e-[0-9a-z]{5}$/);
    const listed = must(ground.box, ground.demo, ["runbook"]).out;
    assert.match(listed, new RegExp(`${id} content loop v1`));
    assert.match(listed, /3 stages/);
    const created = events(ground.ws).find((event) => event.payload.entity === id);
    assert.equal(created.type, "entity.confirmed");
    assert.deepEqual(created.payload.criteria, ["plan", "draft", "publish"]);
    assert.deepEqual(created.payload.labels, ["runbook"]);
});

test("A3: an add naming no stage is refused — a runbook is its stages", () =>
{
    const ground = floor();
    const refused = ground.self(["runbook", "add", "empty loop"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /names none/);
    assert.match(refused.out, /--stage/);
});

test("A4: a stage named twice is refused, and the refusal names the repeat", () =>
{
    const ground = floor();
    const refused = ground.self(["runbook", "add", "loop", "--stage", "draft", "--stage", "draft"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /"draft" is named twice/);
});

test("A5: --file reads the file's list items as the stages, in order", () =>
{
    const ground = floor();
    writeFileSync(join(ground.demo, "spec.md"), "how we make one\n\n- plan\n- draft\n- publish\n\nand that is it\n");
    const id = entityIn(must(ground.box, ground.demo, ["runbook", "add", "content loop", "--file", "spec.md"]).out);
    const shown = must(ground.box, ground.demo, ["runbook", "show", id]).out;
    assert.match(shown, /1\. plan[\s\S]*2\. draft[\s\S]*3\. publish/);
});

test("A6: --file naming a document with no list is refused, and names --stage", () =>
{
    const ground = floor();
    writeFileSync(join(ground.demo, "prose.md"), "we plan, then we draft, then we publish.\n");
    const refused = ground.self(["runbook", "add", "content loop", "--file", "prose.md"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /no stage list was found/);
    assert.match(refused.out, /--stage/);
});

test("A7: --file naming no file is refused, and the refusal names the path", () =>
{
    const ground = floor();
    const refused = ground.self(["runbook", "add", "content loop", "--file", "missing.md"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /"missing.md"/);
    assert.match(refused.out, /no file there/);
});

test("A8: --file outside the project reads, and the record carries the stages and no path", () =>
{
    const ground = floor();
    const outside = join(ground.box.root, "elsewhere.md");
    writeFileSync(outside, "- plan\n- draft\n");
    const id = entityIn(must(ground.box, ground.demo, ["runbook", "add", "content loop", "--file", outside]).out);
    const created = events(ground.ws).find((event) => event.payload.entity === id);
    assert.deepEqual(created.payload.criteria, ["plan", "draft"]);
    assert.ok(!JSON.stringify(created).includes(ground.box.root), "the machine-local path reached the record");
});

test("A9: --stage and --file together are refused — a procedure has one stage list", () =>
{
    const ground = floor();
    writeFileSync(join(ground.demo, "spec.md"), "- plan\n");
    const refused = ground.self(["runbook", "add", "loop", "--stage", "draft", "--file", "spec.md"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /both state the stage list/);
});

test("A10: show prints the name, the edition, the stages and the runs", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft", "publish"]);
    const shown = must(ground.box, ground.demo, ["runbook", "show", id]).out;
    assert.match(shown, /content loop/);
    assert.match(shown, /Edition: v1/);
    assert.match(shown, /1\. plan/);
    assert.match(shown, /## Runs/);
    assert.match(shown, /no runs yet/);
});

test("A11: show answers to the runbook's name exactly as it answers to its id", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft"]);
    assert.equal(must(ground.box, ground.demo, ["runbook", "show", "content loop"]).out,
        must(ground.box, ground.demo, ["runbook", "show", id]).out);
});

test("A12: revise proposes a new edition superseding the current one, and nothing has moved yet", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft", "publish"]);
    const asked = must(ground.box, ground.demo,
        ["runbook", "revise", id, "--stage", "plan", "--stage", "draft", "--stage", "review", "--stage", "publish",
            "--why", "a review step was missing"]);
    const proposed = asked.out.split("\n").map((line) => line.trim()).find((line) => /^e-[0-9a-z]{5}$/.test(line));
    assert.ok(proposed !== undefined, asked.out);
    const written = events(ground.ws).find((event) => event.payload.entity === proposed);
    assert.equal(written.type, "entity.proposed");
    assert.deepEqual(written.payload.criteria, ["plan", "draft", "review", "publish"]);
    assert.deepEqual(written.payload.links, [{ type: "supersedes", target: id }]);
    // v1 still holds: a proposal displaces nothing.
    assert.match(must(ground.box, ground.demo, ["runbook"]).out, new RegExp(`${id} content loop v1`));
    assert.match(asked.out, new RegExp(`self state confirm ${proposed}`));
});

test("A12b: the proposed edition waits on a person in context", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft"]);
    must(ground.box, ground.demo, ["runbook", "revise", id, "--stage", "plan", "--stage", "ship", "--why", "renamed"]);
    const context = must(ground.box, ground.demo, ["context"]).out;
    assert.match(context, /## Waiting on you/);
    assert.match(context, /proposed entity e-[0-9a-z]{5}: content loop \(confirm with `self state confirm e-[0-9a-z]{5}`\)/);
});

test("A12c: confirming the proposal supersedes the old edition and makes the new one the head", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft"]);
    const second = revise(ground, id, ["plan", "draft", "publish"]);
    const listed = must(ground.box, ground.demo, ["runbook"]).out;
    assert.match(listed, new RegExp(`${id} content loop v2`), listed);
    const shown = must(ground.box, ground.demo, ["runbook", "show", id]).out;
    assert.match(shown, new RegExp(`v1 ${id} — superseded`));
    assert.match(shown, new RegExp(`v2 ${second} — holds now`));
});

test("A12d: the confirm lands from a pipe — `state confirm` is the person's verb and carries no terminal gate", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft"]);
    const proposed = entityIn(must(ground.box, ground.demo,
        ["runbook", "revise", id, "--stage", "plan", "--stage", "ship", "--why", "renamed"]).out.split("\n").slice(1).join("\n"));
    const confirmed = ground.self(["state", "confirm", proposed]);
    assert.equal(confirmed.code, 0, confirmed.out);
    assert.match(must(ground.box, ground.demo, ["runbook"]).out, /content loop v2/);
});

test("A12e: the chain's root id is the stable workflow id, and show reads the whole chain from it", () =>
{
    const ground = floor();
    const root = addRunbook(ground, "content loop", ["plan", "draft"]);
    const second = revise(ground, root, ["plan", "draft", "publish"]);
    const fromRoot = must(ground.box, ground.demo, ["runbook", "show", root]).out;
    const fromHead = must(ground.box, ground.demo, ["runbook", "show", second]).out;
    assert.equal(fromRoot, fromHead);
    assert.match(fromRoot, new RegExp(`# ${root} — content loop`));
    assert.match(fromRoot, /Edition: v2/);
});

test("A13: a revision restating the same stages is refused, and records nothing", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft"]);
    const before = events(ground.ws).length;
    const refused = ground.self(["runbook", "revise", id, "--stage", "plan", "--stage", "draft", "--why", "no change"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /already states exactly these stages/);
    assert.equal(events(ground.ws).length, before);
});

test("A14: a revision without --why is refused by the gate that names every missing option", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft"]);
    const refused = ground.self(["runbook", "revise", id, "--stage", "plan", "--stage", "ship"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /needs --why/);
});

test("A15: a runbook is withdrawn at a terminal like any record, and leaves the listing", async () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft"]);
    const taken = await approvedIn(ground.box, ground.demo, ["state", "retract", id, "--why", "the loop was abandoned"], id);
    assert.equal(taken.code, 0, taken.out);
    assert.match(must(ground.box, ground.demo, ["runbook"]).out, /no runbooks registered/);
});

test("A16: a runbook is found by search, because it is a record like any other", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft"]);
    const found = must(ground.box, ground.demo, ["search", "content loop", "--all"]).out;
    assert.match(found, new RegExp(`${id}[\\s\\S]*content loop`));
    // And the default set leaves it out for the one reason every index record
    // is left out: the context render already shows it (#212 R1). A runbook
    // gets no exemption from the rule, which is the point of the cell.
    assert.match(must(ground.box, ground.demo, ["search", "content loop"]).out, /no matches/);
});

test("A17: the fold writes one canonical page per procedure, named by the chain's root", () =>
{
    const ground = floor();
    const root = addRunbook(ground, "content loop", ["plan", "draft"]);
    revise(ground, root, ["plan", "draft", "publish"]);
    const page = readFileSync(join(stateDir(ground.ws), "runbook", `${root}.md`), "utf8");
    assert.match(page, new RegExp(`# ${root} — content loop`));
    assert.match(page, /Edition: v2/);
    assert.deepEqual(readdirSync(join(stateDir(ground.ws), "runbook")), [`${root}.md`],
        "a second page was left behind for the superseded edition");
});

test("A18: a project with no runbooks folds byte-identically and grows no runbook directory", () =>
{
    const ground = floor();
    const before = readdirSync(stateDir(ground.ws)).sort();
    const hashes = readFileSync(join(stateDir(ground.ws), ".hashes.json"), "utf8");
    must(ground.box, ground.demo, ["fold"]);
    assert.deepEqual(readdirSync(stateDir(ground.ws)).sort(), before);
    assert.equal(readFileSync(join(stateDir(ground.ws), ".hashes.json"), "utf8"), hashes);
    assert.equal(existsSync(join(stateDir(ground.ws), "runbook")), false);
});

test("A19: past the index cap the add is refused until --demote names what frees the room", () =>
{
    const ground = floor();
    setCaps(ground.ws, { indexTokens: 20 });
    addRunbook(ground, "first loop", ["plan"]);
    const refused = ground.self(["runbook", "add", "second loop", "--stage", "plan"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--demote/);
});

test("A20: revising an edition that was already replaced proposes against the one that holds", () =>
{
    const ground = floor();
    const root = addRunbook(ground, "content loop", ["plan", "draft"]);
    const second = revise(ground, root, ["plan", "draft", "publish"]);
    const third = entityIn(must(ground.box, ground.demo,
        ["runbook", "revise", root, "--stage", "plan", "--stage", "ship", "--why", "simplified"])
        .out.split("\n").slice(1).join("\n"));
    const written = events(ground.ws).find((event) => event.payload.entity === third);
    assert.deepEqual(written.payload.links, [{ type: "supersedes", target: second }]);
});

test("A21: neither label is a root verb — `self run` and `self runbook-run` are unknown commands", () =>
{
    const ground = floor();
    for (const verb of ["run", "runbook-run"])
    {
        const refused = ground.self([verb, "some text"]);
        assert.notEqual(refused.code, 0, `\`self ${verb}\` dispatched`);
        assert.match(refused.out, /unknown command/);
    }
    const help = must(ground.box, ground.demo, ["--help"]).out;
    assert.match(help, /runbook/);
    assert.ok(!/\brunbook-run\b/.test(help), `the root usage offers "runbook-run":\n${help}`);
});

/* ── group B: starting a run ───────────────────────────────────────── */

test("B1: starting a run of a runbook this project has not registered is refused", () =>
{
    const ground = floor();
    const refused = ground.self(["runbook", "start", "e-zzzzz", "--instance", "E001"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /no runbook here answers to "e-zzzzz"/);
    assert.match(refused.out, /self runbook/);
});

test("B2: a run copies the definition's stages and starts on the first of them", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft", "publish"]);
    const run = startRun(ground, id, "E001");
    const created = events(ground.ws).find((event) => event.payload.entity === run);
    assert.equal(created.type, "entity.confirmed");
    assert.deepEqual(created.payload.criteria, ["plan", "draft", "publish"]);
    assert.deepEqual(created.payload.labels, ["runbook-run", "E001"]);
    assert.deepEqual(created.payload.links, [{ type: "member-of", target: id }]);
    assert.match(runbookBlock(must(ground.box, ground.demo, ["context"]).out), /E001 · content loop v1 · 1\/3 plan/);
});

test("B3: a key already in use is refused, naming the run that holds it", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft"]);
    const run = startRun(ground, id, "E001");
    const refused = ground.self(["runbook", "start", id, "--instance", "E001"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`${run} is already the run "E001"`));
});

test("B4: a start with no --instance is refused, naming the flag it needs", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan"]);
    const refused = ground.self(["runbook", "start", id]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /needs --instance/);
});

test("B5: a blank key is refused and records nothing — the same gate answers a blank flag and a missing one", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan"]);
    const before = events(ground.ws).length;
    for (const blank of ["", "   "])
    {
        const refused = ground.self(["runbook", "start", id, "--instance", blank]);
        assert.notEqual(refused.code, 0, `"${blank}" started a run`);
        assert.match(refused.out, /--instance/);
    }
    assert.equal(events(ground.ws).length, before);
});

test("B6: two runs of one runbook keep independent state", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft", "publish"]);
    startRun(ground, id, "E001");
    startRun(ground, id, "E002");
    must(ground.box, ground.demo, ["runbook", "advance", "E001", "--why", "planned"]);
    const block = runbookBlock(must(ground.box, ground.demo, ["context"]).out);
    assert.match(block, /E001 · content loop v1 · 2\/3 draft/);
    assert.match(block, /E002 · content loop v1 · 1\/3 plan/);
});

test("B7: a finished run's key is not reused — a new run needs a new key", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan"]);
    const run = startRun(ground, id, "E001");
    must(ground.box, ground.demo, ["runbook", "advance", "E001", "--why", "planned"]);
    must(ground.box, ground.demo, ["state", "done", run, "--report", "it shipped"]);
    const refused = ground.self(["runbook", "start", id, "--instance", "E001"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /already the run "E001"/);
});

test("B8: a withdrawn runbook has no edition to start a run of", async () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan"]);
    await approvedIn(ground.box, ground.demo, ["state", "retract", id, "--why", "abandoned"], id);
    const refused = ground.self(["runbook", "start", id, "--instance", "E001"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /no edition of it holds/);
});

test("B9: a started run renders in context with its key, edition, place, stage and next action", () =>
{
    const ground = floor();
    const root = addRunbook(ground, "content loop", ["plan", "draft", "publish"]);
    startRun(ground, root, "E001");
    const block = runbookBlock(must(ground.box, ground.demo, ["context"]).out);
    assert.match(block, /E001 · content loop v1 · 1\/3 plan · next: draft/);
    assert.match(block, new RegExp(`self runbook show ${root}`));
});

test("B10: a run passes its first stage straight after starting — it was recorded confirmed, not proposed", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft"]);
    startRun(ground, id, "E001");
    const passed = ground.self(["runbook", "advance", "E001", "--why", "planned it"]);
    assert.equal(passed.code, 0, passed.out);
    assert.match(passed.out, /E001 passed "plan" — next: draft/);
});

test("B11: starting from the root id copies the edition that holds, and links member-of that edition", () =>
{
    const ground = floor();
    const root = addRunbook(ground, "content loop", ["plan", "draft"]);
    const second = revise(ground, root, ["plan", "draft", "publish"]);
    const run = startRun(ground, root, "E003");
    const created = events(ground.ws).find((event) => event.payload.entity === run);
    assert.deepEqual(created.payload.criteria, ["plan", "draft", "publish"]);
    assert.deepEqual(created.payload.links, [{ type: "member-of", target: second }]);
});

/* ── group C: advancing a run ──────────────────────────────────────── */

test("C1: advance passes the stage the run is on and moves it to the next", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft", "publish"]);
    const run = startRun(ground, id, "E001");
    must(ground.box, ground.demo, ["runbook", "advance", "E001", "--why", "the assets are made"]);
    const covered = events(ground.ws).filter((event) => event.type === "entity.covered");
    assert.equal(covered.length, 1);
    assert.deepEqual({ entity: covered[0].payload.entity, criterion: covered[0].payload.criterion },
        { entity: run, criterion: "plan" });
    assert.match(runbookBlock(must(ground.box, ground.demo, ["context"]).out), /2\/3 draft/);
});

test("C2: naming the stage with --to records exactly what advancing without it records", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft", "publish"]);
    startRun(ground, id, "E001");
    const passed = must(ground.box, ground.demo, ["runbook", "advance", "E001", "--to", "plan", "--why", "planned"]);
    assert.match(passed.out, /E001 passed "plan" — next: draft/);
    assert.equal(events(ground.ws).filter((event) => event.type === "entity.covered")[0].payload.criterion, "plan");
});

test("C3: --to naming a later stage is refused, and the refusal names what would be skipped", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft", "publish"]);
    startRun(ground, id, "E001");
    const refused = ground.self(["runbook", "advance", "E001", "--to", "publish", "--why", "skipping"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /would skip "plan", "draft"/);
});

test("C4: --to naming a stage the run does not have is refused, and the refusal lists the stages", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft"]);
    startRun(ground, id, "E001");
    const refused = ground.self(["runbook", "advance", "E001", "--to", "measure", "--why", "w"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /"measure" is not a stage of E001/);
    assert.match(refused.out, /"plan" → "draft"/);
});

test("C5: an advance without --why is refused by the gate that names every missing option", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft"]);
    startRun(ground, id, "E001");
    const refused = ground.self(["runbook", "advance", "E001"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /needs --why/);
});

test("C6: passing the last stage records it, and the run is not done for it", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft"]);
    const run = startRun(ground, id, "E001");
    must(ground.box, ground.demo, ["runbook", "advance", "E001", "--why", "planned"]);
    const last = must(ground.box, ground.demo, ["runbook", "advance", "E001", "--why", "drafted"]);
    assert.match(last.out, new RegExp(`close it with \`self state done ${run}`));
    assert.equal(events(ground.ws).some((event) => event.type === "entity.done"), false);
    assert.match(runbookBlock(must(ground.box, ground.demo, ["context"]).out), /2\/2 every stage passed/);
});

test("C7: with every stage passed there is nothing to advance, and the refusal names the close", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan"]);
    const run = startRun(ground, id, "E001");
    must(ground.box, ground.demo, ["runbook", "advance", "E001", "--why", "planned"]);
    const refused = ground.self(["runbook", "advance", "E001", "--why", "again"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /has passed every stage/);
    assert.match(refused.out, new RegExp(`self state done ${run} --report`));
});

test("C8: `state done --report` closes the run and it leaves the runbook section", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan"]);
    const run = startRun(ground, id, "E001");
    must(ground.box, ground.demo, ["runbook", "advance", "E001", "--why", "planned"]);
    const closed = must(ground.box, ground.demo, ["state", "done", run, "--report", "the video is published"]);
    assert.match(closed.out, /entity\.done/);
    assert.equal(runbookBlock(must(ground.box, ground.demo, ["context"]).out).trim(), "");
});

test("C8b: a close with no --report is refused by the evidence gate this surface does not reimplement", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan"]);
    const run = startRun(ground, id, "E001");
    must(ground.box, ground.demo, ["runbook", "advance", "E001", "--why", "planned"]);
    const refused = ground.self(["state", "done", run]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /needs --report/);
});

test("C9: a stage already passed is refused — a stage is passed once", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft"]);
    startRun(ground, id, "E001");
    must(ground.box, ground.demo, ["runbook", "advance", "E001", "--to", "plan", "--why", "planned"]);
    const refused = ground.self(["runbook", "advance", "E001", "--to", "plan", "--why", "again"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /already passed "plan"/);
});

test("C13: show lists every run of the procedure with the stage each is on", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft", "publish"]);
    startRun(ground, id, "E001");
    startRun(ground, id, "E002");
    must(ground.box, ground.demo, ["runbook", "advance", "E001", "--why", "planned"]);
    const shown = must(ground.box, ground.demo, ["runbook", "show", id]).out;
    assert.match(shown, /E001 \(e-[0-9a-z]{5}\) — following v1, 2\/3 draft, in-progress/);
    assert.match(shown, /E002 \(e-[0-9a-z]{5}\) — following v1, 1\/3 plan, in-progress/);
});

test("C14: the coverage a stage records reads back on the log", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft"]);
    startRun(ground, id, "E001");
    must(ground.box, ground.demo, ["runbook", "advance", "E001", "--why", "the assets are made"]);
    const log = must(ground.box, ground.demo, ["log", "-n", "5"]).out;
    assert.match(log, /entity\.covered/);
    assert.match(log, /plan/);
});

test("C15: the fold renders a page per live run, showing which stages are passed and why", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft"]);
    const run = startRun(ground, id, "E001");
    must(ground.box, ground.demo, ["runbook", "advance", "E001", "--why", "the assets are made"]);
    const page = readFileSync(join(stateDir(ground.ws), "runbook-run", `${run}.md`), "utf8");
    assert.match(page, /# E001 — content loop/);
    assert.match(page, /Stage: 2\/2 draft/);
    assert.match(page, /\[x\] plan — \d{4}-\d{2}-\d{2}, the assets are made/);
    assert.match(page, /\[ \] draft/);
});

/* ── group F: editions and drift ───────────────────────────────────── */

test("F1: a run following the only edition there is says nothing about drift", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft"]);
    startRun(ground, id, "E001");
    const block = runbookBlock(must(ground.box, ground.demo, ["context"]).out);
    assert.match(block, /content loop v1 ·/);
    assert.ok(!block.includes("the definition is on"), block);
});

test("F2: once the edition is replaced, the run in flight says which edition it follows", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft"]);
    startRun(ground, id, "E001");
    revise(ground, id, ["plan", "draft", "publish"]);
    assert.match(runbookBlock(must(ground.box, ground.demo, ["context"]).out),
        /E001 · content loop v1 \(the definition is on v2\)/);
});

test("F3: show names the whole chain and which edition each run follows", () =>
{
    const ground = floor();
    const root = addRunbook(ground, "content loop", ["plan", "draft"]);
    startRun(ground, root, "E001");
    const second = revise(ground, root, ["plan", "draft", "publish"]);
    startRun(ground, root, "E002");
    const shown = must(ground.box, ground.demo, ["runbook", "show", root]).out;
    assert.match(shown, new RegExp(`v1 ${root} — superseded`));
    assert.match(shown, new RegExp(`v2 ${second} — holds now`));
    assert.match(shown, /E001 \(e-[0-9a-z]{5}\) — following v1/);
    assert.match(shown, /E002 \(e-[0-9a-z]{5}\) — following v2/);
});

test("F4: a run following an older edition keeps advancing — the difference is shown, not blocking", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft"]);
    startRun(ground, id, "E001");
    revise(ground, id, ["plan", "draft", "publish"]);
    const passed = ground.self(["runbook", "advance", "E001", "--why", "planned it"]);
    assert.equal(passed.code, 0, passed.out);
    assert.match(passed.out, /E001 passed "plan" — next: draft/);
});

test("F5: a run started after the replacement copies the edition that holds", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft"]);
    revise(ground, id, ["plan", "draft", "publish"]);
    startRun(ground, id, "E002");
    const block = runbookBlock(must(ground.box, ground.demo, ["context"]).out);
    assert.match(block, /E002 · content loop v2 · 1\/3 plan/);
    assert.ok(!block.includes("the definition is on"), block);
});

test("F6: two replacements later, the run still names the edition it is on and the one that holds", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft"]);
    startRun(ground, id, "E001");
    revise(ground, id, ["plan", "draft", "publish"]);
    revise(ground, id, ["plan", "draft", "publish", "measure"]);
    assert.match(runbookBlock(must(ground.box, ground.demo, ["context"]).out),
        /E001 · content loop v1 \(the definition is on v3\)/);
});

test("F7: a run whose runbook was withdrawn keeps rendering — it holds its own copy of the stages", async () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft"]);
    startRun(ground, id, "E001");
    await approvedIn(ground.box, ground.demo, ["state", "retract", id, "--why", "the loop was abandoned"], id);
    assert.match(runbookBlock(must(ground.box, ground.demo, ["context"]).out), /E001 · content loop v1 · 1\/2 plan/);
});

test("F8: a run whose runbook was withdrawn keeps advancing", async () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft"]);
    startRun(ground, id, "E001");
    await approvedIn(ground.box, ground.demo, ["state", "retract", id, "--why", "the loop was abandoned"], id);
    const passed = ground.self(["runbook", "advance", "E001", "--why", "planned it"]);
    assert.equal(passed.code, 0, passed.out);
});

test("F9: an edition that changed nothing but the wording raises no drift note", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft"]);
    startRun(ground, id, "E001");
    // The stages are the fingerprint, so a new edition restating them with one
    // extra and then the same set back leaves the run on identical stages.
    const proposed = entityIn(must(ground.box, ground.demo,
        ["runbook", "revise", id, "--stage", "plan", "--stage", "draft", "--stage", "ship", "--why", "added ship"])
        .out.split("\n").slice(1).join("\n"));
    must(ground.box, ground.demo, ["state", "confirm", proposed]);
    const back = entityIn(must(ground.box, ground.demo,
        ["runbook", "revise", id, "--stage", "plan", "--stage", "draft", "--why", "ship was a mistake"])
        .out.split("\n").slice(1).join("\n"));
    must(ground.box, ground.demo, ["state", "confirm", back]);
    const block = runbookBlock(must(ground.box, ground.demo, ["context"]).out);
    assert.match(block, /E001 · content loop v1 ·/);
    assert.ok(!block.includes("the definition is on"), block);
});

test("F10: a proposed edition nobody confirmed yet moves no run's edition", () =>
{
    const ground = floor();
    const id = addRunbook(ground, "content loop", ["plan", "draft"]);
    startRun(ground, id, "E001");
    must(ground.box, ground.demo, ["runbook", "revise", id, "--stage", "plan", "--stage", "publish", "--why", "later"]);
    const block = runbookBlock(must(ground.box, ground.demo, ["context"]).out);
    assert.match(block, /E001 · content loop v1 ·/);
    assert.ok(!block.includes("the definition is on"), block);
});

/* ── group G: project scope ────────────────────────────────────────── */

test("G1: a runbook registered in one project is not listed in another", () =>
{
    const ground = floor();
    addRunbook(ground, "content loop", ["plan"]);
    const beta = join(ground.ws, "beta");
    mkdirSync(beta, { recursive: true });
    git(ground.box, beta, ["init", "-q", "-b", "main"]);
    must(ground.box, beta, ["project", "init", "--name", "beta", "--no-connect"]);
    assert.match(must(ground.box, beta, ["runbook"]).out, /no runbooks registered/);
});

test("G2: an add outside a registered project is refused by the project resolver", () =>
{
    const ground = floor();
    const loose = join(ground.box.root, "loose");
    mkdirSync(loose, { recursive: true });
    const refused = selfIn(ground.box, loose, ["runbook", "add", "loop", "--stage", "plan"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /project/);
});

test("G3: an archived project refuses the add, like every other append", () =>
{
    const ground = floor();
    must(ground.box, ground.ws, ["project", "archive", "demo", "--why", "nobody is working on it"]);
    const refused = ground.self(["runbook", "add", "loop", "--stage", "plan"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /archived/);
});

test("G4: --project reads another registered project's runbooks", () =>
{
    const ground = floor();
    addRunbook(ground, "content loop", ["plan"]);
    assert.match(must(ground.box, ground.ws, ["runbook", "--project", "demo"]).out, /content loop v1/);
});

test("G5: --project is not a flag a write verb takes", () =>
{
    const ground = floor();
    const refused = ground.self(["runbook", "add", "loop", "--stage", "plan", "--project", "demo"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /unknown option '--project'/);
});
