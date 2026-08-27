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
import { approvedIn, demoWorkspace, git, machine, must, selfIn, workIdIn } from "./harness.mjs";

/* ── the floor every cell stands on ────────────────────────────────── */

async function floor()
{
    const box = machine();
    const { ws, demo } = await demoWorkspace(box);
    return { box, ws, demo, self: (args, cwd = demo) => selfIn(box, cwd, args) };
}

function entityIn(text)
{
    const match = text.match(/\be-[0-9a-z]{5}\b/);
    assert.ok(match !== null, `no entity id in: ${text}`);
    return match[0];
}

async function addRunbook(ground, name, stages, at = ground.demo)
{
    const args = ["runbook", "add", name];
    for (const stage of stages)
    {
        args.push("--stage", stage);
    }
    return entityIn((await must(ground.box, at, args)).out);
}

async function startRun(ground, definition, key)
{
    return entityIn((await must(ground.box, ground.demo, ["runbook", "start", definition, "--instance", key])).out);
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
async function revise(ground, definition, stages, why = "the procedure moved")
{
    const args = ["runbook", "revise", definition, "--why", why];
    for (const stage of stages)
    {
        args.push("--stage", stage);
    }
    const proposed = entityIn((await must(ground.box, ground.demo, args)).out);
    await must(ground.box, ground.demo, ["state", "confirm", proposed]);
    return proposed;
}

/* ── group E: stopping and resuming ────────────────────────────────── */

// A run part-way through the procedure, which is where every stop cell starts.
async function running(ground, stages = ["plan", "draft", "publish"])
{
    const id = await addRunbook(ground, "content loop", stages);
    const run = await startRun(ground, id, "E001");
    await must(ground.box, ground.demo, ["runbook", "advance", "E001", "--why", "planned it"]);
    return { id, run };
}

/* ── group A: the definition ───────────────────────────────────────── */

test("A1: a project with no runbooks says so and names the verb that registers one", async () =>
{
    const ground = await floor();
    const listed = await ground.self(["runbook"]);
    assert.equal(listed.code, 0, listed.out);
    assert.match(listed.out, /no runbooks registered/);
    assert.match(listed.out, /self runbook add/);
});

test("A2: an add records one definition with an entity id, at edition v1", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft", "publish"]);
    assert.match(id, /^e-[0-9a-z]{5}$/);
    const listed = (await must(ground.box, ground.demo, ["runbook"])).out;
    assert.match(listed, new RegExp(`${id} content loop v1`));
    assert.match(listed, /3 stages/);
    const created = events(ground.ws).find((event) => event.payload.entity === id);
    assert.equal(created.type, "entity.confirmed");
    assert.deepEqual(created.payload.criteria, ["plan", "draft", "publish"]);
    assert.deepEqual(created.payload.labels, ["runbook"]);
});

test("A3: an add naming no stage is refused — a runbook is its stages", async () =>
{
    const ground = await floor();
    const refused = await ground.self(["runbook", "add", "empty loop"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /names none/);
    assert.match(refused.out, /--stage/);
});

test("A4: a stage named twice is refused, and the refusal names the repeat", async () =>
{
    const ground = await floor();
    const refused = await ground.self(["runbook", "add", "loop", "--stage", "draft", "--stage", "draft"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /"draft" is named twice/);
});

test("A5: --file reads the file's list items as the stages, in order", async () =>
{
    const ground = await floor();
    writeFileSync(join(ground.demo, "spec.md"), "how we make one\n\n- plan\n- draft\n- publish\n\nand that is it\n");
    const id = entityIn((await must(ground.box, ground.demo, ["runbook", "add", "content loop", "--file", "spec.md"])).out);
    const shown = (await must(ground.box, ground.demo, ["runbook", "show", id])).out;
    assert.match(shown, /1\. plan[\s\S]*2\. draft[\s\S]*3\. publish/);
});

test("A6: --file naming a document with no list is refused, and names --stage", async () =>
{
    const ground = await floor();
    writeFileSync(join(ground.demo, "prose.md"), "we plan, then we draft, then we publish.\n");
    const refused = await ground.self(["runbook", "add", "content loop", "--file", "prose.md"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /no stage list was found/);
    assert.match(refused.out, /--stage/);
});

test("A7: --file naming no file is refused, and the refusal names the path", async () =>
{
    const ground = await floor();
    const refused = await ground.self(["runbook", "add", "content loop", "--file", "missing.md"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /"missing.md"/);
    assert.match(refused.out, /no file there/);
});

test("A8: --file outside the project reads, and the record carries the stages and no path", async () =>
{
    const ground = await floor();
    const outside = join(ground.box.root, "elsewhere.md");
    writeFileSync(outside, "- plan\n- draft\n");
    const id = entityIn((await must(ground.box, ground.demo, ["runbook", "add", "content loop", "--file", outside])).out);
    const created = events(ground.ws).find((event) => event.payload.entity === id);
    assert.deepEqual(created.payload.criteria, ["plan", "draft"]);
    assert.ok(!JSON.stringify(created).includes(ground.box.root), "the machine-local path reached the record");
});

test("A9: --stage and --file together are refused — a procedure has one stage list", async () =>
{
    const ground = await floor();
    writeFileSync(join(ground.demo, "spec.md"), "- plan\n");
    const refused = await ground.self(["runbook", "add", "loop", "--stage", "draft", "--file", "spec.md"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /both state the stage list/);
});

test("A10: show prints the name, the edition, the stages and the runs", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft", "publish"]);
    const shown = (await must(ground.box, ground.demo, ["runbook", "show", id])).out;
    assert.match(shown, /content loop/);
    assert.match(shown, /Edition: v1/);
    assert.match(shown, /1\. plan/);
    assert.match(shown, /## Runs/);
    assert.match(shown, /no runs yet/);
});

test("A11: show answers to the runbook's name exactly as it answers to its id", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft"]);
    assert.equal((await must(ground.box, ground.demo, ["runbook", "show", "content loop"])).out,
        (await must(ground.box, ground.demo, ["runbook", "show", id])).out);
});

test("A12: revise proposes a new edition superseding the current one, and nothing has moved yet", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft", "publish"]);
    const asked = await must(ground.box, ground.demo,
        ["runbook", "revise", id, "--stage", "plan", "--stage", "draft", "--stage", "review", "--stage", "publish",
            "--why", "a review step was missing"]);
    const proposed = asked.out.split("\n").map((line) => line.trim()).find((line) => /^e-[0-9a-z]{5}$/.test(line));
    assert.ok(proposed !== undefined, asked.out);
    const written = events(ground.ws).find((event) => event.payload.entity === proposed);
    assert.equal(written.type, "entity.proposed");
    assert.deepEqual(written.payload.criteria, ["plan", "draft", "review", "publish"]);
    assert.deepEqual(written.payload.links, [{ type: "supersedes", target: id }]);
    // v1 still holds: a proposal displaces nothing.
    assert.match((await must(ground.box, ground.demo, ["runbook"])).out, new RegExp(`${id} content loop v1`));
    assert.match(asked.out, new RegExp(`self state confirm ${proposed}`));
});

test("A12b: the proposed edition waits on a person in context", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft"]);
    await must(ground.box, ground.demo, ["runbook", "revise", id, "--stage", "plan", "--stage", "ship", "--why", "renamed"]);
    const context = (await must(ground.box, ground.demo, ["context"])).out;
    assert.match(context, /## Waiting on you/);
    assert.match(context, /proposed entity e-[0-9a-z]{5}: content loop \(confirm with `self state confirm e-[0-9a-z]{5}`\)/);
});

test("A12c: confirming the proposal supersedes the old edition and makes the new one the head", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft"]);
    const second = await revise(ground, id, ["plan", "draft", "publish"]);
    const listed = (await must(ground.box, ground.demo, ["runbook"])).out;
    assert.match(listed, new RegExp(`${id} content loop v2`), listed);
    const shown = (await must(ground.box, ground.demo, ["runbook", "show", id])).out;
    assert.match(shown, new RegExp(`v1 ${id} — superseded`));
    assert.match(shown, new RegExp(`v2 ${second} — holds now`));
});

test("A12d: the confirm lands from a pipe — `state confirm` is the person's verb and carries no terminal gate", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft"]);
    const proposed = entityIn((await must(ground.box, ground.demo,
        ["runbook", "revise", id, "--stage", "plan", "--stage", "ship", "--why", "renamed"])).out.split("\n").slice(1).join("\n"));
    const confirmed = await ground.self(["state", "confirm", proposed]);
    assert.equal(confirmed.code, 0, confirmed.out);
    assert.match((await must(ground.box, ground.demo, ["runbook"])).out, /content loop v2/);
});

test("A12e: the chain's root id is the stable workflow id, and show reads the whole chain from it", async () =>
{
    const ground = await floor();
    const root = await addRunbook(ground, "content loop", ["plan", "draft"]);
    const second = await revise(ground, root, ["plan", "draft", "publish"]);
    const fromRoot = (await must(ground.box, ground.demo, ["runbook", "show", root])).out;
    const fromHead = (await must(ground.box, ground.demo, ["runbook", "show", second])).out;
    assert.equal(fromRoot, fromHead);
    assert.match(fromRoot, new RegExp(`# ${root} — content loop`));
    assert.match(fromRoot, /Edition: v2/);
});

test("A13: a revision restating the same stages is refused, and records nothing", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft"]);
    const before = events(ground.ws).length;
    const refused = await ground.self(["runbook", "revise", id, "--stage", "plan", "--stage", "draft", "--why", "no change"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /already states exactly these stages/);
    assert.equal(events(ground.ws).length, before);
});

test("A14: a revision without --why is refused by the gate that names every missing option", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft"]);
    const refused = await ground.self(["runbook", "revise", id, "--stage", "plan", "--stage", "ship"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /needs --why/);
});

test("A15: a runbook is withdrawn at a terminal like any record, and leaves the listing", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft"]);
    const taken = await approvedIn(ground.box, ground.demo, ["state", "retract", id, "--why", "the loop was abandoned"], id);
    assert.equal(taken.code, 0, taken.out);
    assert.match((await must(ground.box, ground.demo, ["runbook"])).out, /no runbooks registered/);
});

test("A16: a runbook is found by search, because it is a record like any other", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft"]);
    const found = (await must(ground.box, ground.demo, ["search", "content loop", "--all"])).out;
    assert.match(found, new RegExp(`${id}[\\s\\S]*content loop`));
    // And the default set leaves it out for the one reason every index record
    // is left out: the context render already shows it (#212 R1). A runbook
    // gets no exemption from the rule, which is the point of the cell.
    assert.match((await must(ground.box, ground.demo, ["search", "content loop"])).out, /no matches/);
});

test("A17: the fold writes one canonical page per procedure, named by the chain's root", async () =>
{
    const ground = await floor();
    const root = await addRunbook(ground, "content loop", ["plan", "draft"]);
    await revise(ground, root, ["plan", "draft", "publish"]);
    const page = readFileSync(join(stateDir(ground.ws), "runbook", `${root}.md`), "utf8");
    assert.match(page, new RegExp(`# ${root} — content loop`));
    assert.match(page, /Edition: v2/);
    assert.deepEqual(readdirSync(join(stateDir(ground.ws), "runbook")), [`${root}.md`],
        "a second page was left behind for the superseded edition");
});

test("A18: a project with no runbooks folds byte-identically and grows no runbook directory", async () =>
{
    const ground = await floor();
    const before = readdirSync(stateDir(ground.ws)).sort();
    const hashes = readFileSync(join(stateDir(ground.ws), ".hashes.json"), "utf8");
    await must(ground.box, ground.demo, ["fold"]);
    assert.deepEqual(readdirSync(stateDir(ground.ws)).sort(), before);
    assert.equal(readFileSync(join(stateDir(ground.ws), ".hashes.json"), "utf8"), hashes);
    assert.equal(existsSync(join(stateDir(ground.ws), "runbook")), false);
});

test("A19: past the index cap the add is refused until --demote names what frees the room", async () =>
{
    const ground = await floor();
    setCaps(ground.ws, { indexTokens: 20 });
    await addRunbook(ground, "first loop", ["plan"]);
    const refused = await ground.self(["runbook", "add", "second loop", "--stage", "plan"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--demote/);
});

test("A20: revising an edition that was already replaced proposes against the one that holds", async () =>
{
    const ground = await floor();
    const root = await addRunbook(ground, "content loop", ["plan", "draft"]);
    const second = await revise(ground, root, ["plan", "draft", "publish"]);
    const third = entityIn((await must(ground.box, ground.demo,
        ["runbook", "revise", root, "--stage", "plan", "--stage", "ship", "--why", "simplified"]))
        .out.split("\n").slice(1).join("\n"));
    const written = events(ground.ws).find((event) => event.payload.entity === third);
    assert.deepEqual(written.payload.links, [{ type: "supersedes", target: second }]);
});

test("A21: neither label is a root verb — `self run` and `self runbook-run` are unknown commands", async () =>
{
    const ground = await floor();
    for (const verb of ["run", "runbook-run"])
    {
        const refused = await ground.self([verb, "some text"]);
        assert.notEqual(refused.code, 0, `\`self ${verb}\` dispatched`);
        assert.match(refused.out, /unknown command/);
    }
    const help = (await must(ground.box, ground.demo, ["--help"])).out;
    assert.match(help, /runbook/);
    assert.ok(!/\brunbook-run\b/.test(help), `the root usage offers "runbook-run":\n${help}`);
});

/* ── group B: starting a run ───────────────────────────────────────── */

test("B1: starting a run of a runbook this project has not registered is refused", async () =>
{
    const ground = await floor();
    const refused = await ground.self(["runbook", "start", "e-zzzzz", "--instance", "E001"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /no runbook here answers to "e-zzzzz"/);
    assert.match(refused.out, /self runbook/);
});

test("B2: a run copies the definition's stages and starts on the first of them", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft", "publish"]);
    const run = await startRun(ground, id, "E001");
    const created = events(ground.ws).find((event) => event.payload.entity === run);
    assert.equal(created.type, "entity.confirmed");
    assert.deepEqual(created.payload.criteria, ["plan", "draft", "publish"]);
    assert.deepEqual(created.payload.labels, ["runbook-run", "E001"]);
    assert.deepEqual(created.payload.links, [{ type: "member-of", target: id }]);
    assert.match(runbookBlock((await must(ground.box, ground.demo, ["context"])).out), /E001 · content loop v1 · 1\/3 plan/);
});

test("B3: a key already in use is refused, naming the run that holds it", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft"]);
    const run = await startRun(ground, id, "E001");
    const refused = await ground.self(["runbook", "start", id, "--instance", "E001"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`${run} is already the run "E001"`));
});

test("B4: a start with no --instance is refused, naming the flag it needs", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan"]);
    const refused = await ground.self(["runbook", "start", id]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /needs --instance/);
});

test("B5: a blank key is refused and records nothing — the same gate answers a blank flag and a missing one", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan"]);
    const before = events(ground.ws).length;
    for (const blank of ["", "   "])
    {
        const refused = await ground.self(["runbook", "start", id, "--instance", blank]);
        assert.notEqual(refused.code, 0, `"${blank}" started a run`);
        assert.match(refused.out, /--instance/);
    }
    assert.equal(events(ground.ws).length, before);
});

test("B6: two runs of one runbook keep independent state", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft", "publish"]);
    await startRun(ground, id, "E001");
    await startRun(ground, id, "E002");
    await must(ground.box, ground.demo, ["runbook", "advance", "E001", "--why", "planned"]);
    const block = runbookBlock((await must(ground.box, ground.demo, ["context"])).out);
    assert.match(block, /E001 · content loop v1 · 2\/3 draft/);
    assert.match(block, /E002 · content loop v1 · 1\/3 plan/);
});

test("B7: a finished run's key is not reused — a new run needs a new key", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan"]);
    const run = await startRun(ground, id, "E001");
    await must(ground.box, ground.demo, ["runbook", "advance", "E001", "--why", "planned"]);
    await must(ground.box, ground.demo, ["state", "done", run, "--report", "it shipped"]);
    const refused = await ground.self(["runbook", "start", id, "--instance", "E001"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /already the run "E001"/);
});

test("B8: a withdrawn runbook has no edition to start a run of", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan"]);
    await approvedIn(ground.box, ground.demo, ["state", "retract", id, "--why", "abandoned"], id);
    const refused = await ground.self(["runbook", "start", id, "--instance", "E001"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /no edition of it holds/);
});

test("B9: a started run renders in context with its key, edition, place, stage and next action", async () =>
{
    const ground = await floor();
    const root = await addRunbook(ground, "content loop", ["plan", "draft", "publish"]);
    await startRun(ground, root, "E001");
    const block = runbookBlock((await must(ground.box, ground.demo, ["context"])).out);
    assert.match(block, /E001 · content loop v1 · 1\/3 plan · next: draft/);
    assert.match(block, new RegExp(`self runbook show ${root}`));
});

test("B10: a run passes its first stage straight after starting — it was recorded confirmed, not proposed", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft"]);
    await startRun(ground, id, "E001");
    const passed = await ground.self(["runbook", "advance", "E001", "--why", "planned it"]);
    assert.equal(passed.code, 0, passed.out);
    assert.match(passed.out, /E001 passed "plan" — next: draft/);
});

test("B11: starting from the root id copies the edition that holds, and links member-of that edition", async () =>
{
    const ground = await floor();
    const root = await addRunbook(ground, "content loop", ["plan", "draft"]);
    const second = await revise(ground, root, ["plan", "draft", "publish"]);
    const run = await startRun(ground, root, "E003");
    const created = events(ground.ws).find((event) => event.payload.entity === run);
    assert.deepEqual(created.payload.criteria, ["plan", "draft", "publish"]);
    assert.deepEqual(created.payload.links, [{ type: "member-of", target: second }]);
});

/* ── group C: advancing a run ──────────────────────────────────────── */

test("C1: advance passes the stage the run is on and moves it to the next", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft", "publish"]);
    const run = await startRun(ground, id, "E001");
    await must(ground.box, ground.demo, ["runbook", "advance", "E001", "--why", "the assets are made"]);
    const covered = events(ground.ws).filter((event) => event.type === "entity.covered");
    assert.equal(covered.length, 1);
    assert.deepEqual({ entity: covered[0].payload.entity, criterion: covered[0].payload.criterion },
        { entity: run, criterion: "plan" });
    assert.match(runbookBlock((await must(ground.box, ground.demo, ["context"])).out), /2\/3 draft/);
});

test("C2: naming the stage with --to records exactly what advancing without it records", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft", "publish"]);
    await startRun(ground, id, "E001");
    const passed = await must(ground.box, ground.demo, ["runbook", "advance", "E001", "--to", "plan", "--why", "planned"]);
    assert.match(passed.out, /E001 passed "plan" — next: draft/);
    assert.equal(events(ground.ws).filter((event) => event.type === "entity.covered")[0].payload.criterion, "plan");
});

test("C3: --to naming a later stage is refused, and the refusal names what would be skipped", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft", "publish"]);
    await startRun(ground, id, "E001");
    const refused = await ground.self(["runbook", "advance", "E001", "--to", "publish", "--why", "skipping"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /would skip "plan", "draft"/);
});

test("C4: --to naming a stage the run does not have is refused, and the refusal lists the stages", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft"]);
    await startRun(ground, id, "E001");
    const refused = await ground.self(["runbook", "advance", "E001", "--to", "measure", "--why", "w"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /"measure" is not a stage of E001/);
    assert.match(refused.out, /"plan" → "draft"/);
});

test("C5: an advance without --why is refused by the gate that names every missing option", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft"]);
    await startRun(ground, id, "E001");
    const refused = await ground.self(["runbook", "advance", "E001"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /needs --why/);
});

test("C6: passing the last stage records it, and the run is not done for it", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft"]);
    const run = await startRun(ground, id, "E001");
    await must(ground.box, ground.demo, ["runbook", "advance", "E001", "--why", "planned"]);
    const last = await must(ground.box, ground.demo, ["runbook", "advance", "E001", "--why", "drafted"]);
    assert.match(last.out, new RegExp(`close it with \`self state done ${run}`));
    assert.equal(events(ground.ws).some((event) => event.type === "entity.done"), false);
    assert.match(runbookBlock((await must(ground.box, ground.demo, ["context"])).out), /2\/2 every stage passed/);
});

test("C7: with every stage passed there is nothing to advance, and the refusal names the close", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan"]);
    const run = await startRun(ground, id, "E001");
    await must(ground.box, ground.demo, ["runbook", "advance", "E001", "--why", "planned"]);
    const refused = await ground.self(["runbook", "advance", "E001", "--why", "again"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /has passed every stage/);
    assert.match(refused.out, new RegExp(`self state done ${run} --report`));
});

test("C8: `state done --report` closes the run and it leaves the runbook section", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan"]);
    const run = await startRun(ground, id, "E001");
    await must(ground.box, ground.demo, ["runbook", "advance", "E001", "--why", "planned"]);
    const closed = await must(ground.box, ground.demo, ["state", "done", run, "--report", "the video is published"]);
    assert.match(closed.out, /entity\.done/);
    assert.equal(runbookBlock((await must(ground.box, ground.demo, ["context"])).out).trim(), "");
});

test("C8b: a close with no --report is refused by the evidence gate this surface does not reimplement", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan"]);
    const run = await startRun(ground, id, "E001");
    await must(ground.box, ground.demo, ["runbook", "advance", "E001", "--why", "planned"]);
    const refused = await ground.self(["state", "done", run]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /needs --report/);
});

test("C9: a stage already passed is refused — a stage is passed once", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft"]);
    await startRun(ground, id, "E001");
    await must(ground.box, ground.demo, ["runbook", "advance", "E001", "--to", "plan", "--why", "planned"]);
    const refused = await ground.self(["runbook", "advance", "E001", "--to", "plan", "--why", "again"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /already passed "plan"/);
});

test("C10: link states which work unit is carrying the run", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft"]);
    const run = await startRun(ground, id, "E001");
    const work = workIdIn((await must(ground.box, ground.demo, ["work", "add", "cut the video"])).out);
    const linked = await must(ground.box, ground.demo, ["runbook", "link", "E001", "--work", work]);
    assert.match(linked.out, new RegExp(`E001 is carried by ${work}`));
    const event = events(ground.ws).find((item) => item.type === "entity.linked" && item.payload.entity === run);
    assert.deepEqual(event.payload.link, { type: "relates", target: work });
    assert.match((await must(ground.box, ground.demo, ["runbook", "show", id])).out, new RegExp(`carried by ${work}`));
});

test("C11: link naming a work unit the log does not hold is refused", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan"]);
    await startRun(ground, id, "E001");
    const refused = await ground.self(["runbook", "link", "E001", "--work", "w-zzzzz"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /w-zzzzz/);
});

test("C12: a run may name more than one work unit, and naming the same one twice is refused", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan"]);
    await startRun(ground, id, "E001");
    const first = workIdIn((await must(ground.box, ground.demo, ["work", "add", "cut the video"])).out);
    const second = workIdIn((await must(ground.box, ground.demo, ["work", "add", "write the caption"])).out);
    await must(ground.box, ground.demo, ["runbook", "link", "E001", "--work", first]);
    await must(ground.box, ground.demo, ["runbook", "link", "E001", "--work", second]);
    const shown = (await must(ground.box, ground.demo, ["runbook", "show", id])).out;
    assert.match(shown, new RegExp(`carried by ${first}, ${second}`));
    const repeated = await ground.self(["runbook", "link", "E001", "--work", first]);
    assert.notEqual(repeated.code, 0);
    assert.match(repeated.out, /one edge is one link/);
});

test("C13: show lists every run of the procedure with the stage each is on", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft", "publish"]);
    await startRun(ground, id, "E001");
    await startRun(ground, id, "E002");
    await must(ground.box, ground.demo, ["runbook", "advance", "E001", "--why", "planned"]);
    const shown = (await must(ground.box, ground.demo, ["runbook", "show", id])).out;
    assert.match(shown, /E001 \(e-[0-9a-z]{5}\) — following v1, 2\/3 draft, in-progress/);
    assert.match(shown, /E002 \(e-[0-9a-z]{5}\) — following v1, 1\/3 plan, in-progress/);
});

test("C14: the coverage a stage records reads back on the log", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft"]);
    await startRun(ground, id, "E001");
    await must(ground.box, ground.demo, ["runbook", "advance", "E001", "--why", "the assets are made"]);
    const log = (await must(ground.box, ground.demo, ["log", "-n", "5"])).out;
    assert.match(log, /entity\.covered/);
    assert.match(log, /plan/);
});

test("C15: the fold renders a page per live run, showing which stages are passed and why", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft"]);
    const run = await startRun(ground, id, "E001");
    await must(ground.box, ground.demo, ["runbook", "advance", "E001", "--why", "the assets are made"]);
    const page = readFileSync(join(stateDir(ground.ws), "runbook-run", `${run}.md`), "utf8");
    assert.match(page, /# E001 — content loop/);
    assert.match(page, /Stage: 2\/2 draft/);
    assert.match(page, /\[x\] plan — \d{4}-\d{2}-\d{2}, the assets are made/);
    assert.match(page, /\[ \] draft/);
});

test("E1: stop gives the run up, and it leaves the runbook section", async () =>
{
    const ground = await floor();
    const { run } = await running(ground);
    const stopped = await approvedIn(ground.box, ground.demo,
        ["runbook", "stop", "E001", "--why", "the story was dropped"], run);
    assert.equal(stopped.code, 0, stopped.out);
    assert.equal(events(ground.ws).some((event) => event.type === "entity.retired"), true);
    assert.equal(runbookBlock((await must(ground.box, ground.demo, ["context"])).out).trim(), "");
});

test("E2: a stopped run is not resumed — giving up an outcome is terminal", async () =>
{
    const ground = await floor();
    const { run } = await running(ground);
    await approvedIn(ground.box, ground.demo, ["runbook", "stop", "E001", "--why", "dropped"], run);
    const refused = await ground.self(["runbook", "resume", "E001"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /E001 is stopped — its working state is terminal/);
});

test("E3: a stopped run passes no further stage", async () =>
{
    const ground = await floor();
    const { run } = await running(ground);
    await approvedIn(ground.box, ground.demo, ["runbook", "stop", "E001", "--why", "dropped"], run);
    const refused = await ground.self(["runbook", "advance", "E001", "--why", "carrying on"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /terminal/);
});

test("E4: a stop with no --why is refused by the gate that names every missing option", async () =>
{
    const ground = await floor();
    await running(ground);
    const refused = await ground.self(["runbook", "stop", "E001"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /needs --why/);
});

test("E5: a held run can still be given up", async () =>
{
    const ground = await floor();
    const { run } = await running(ground);
    await must(ground.box, ground.demo, ["runbook", "hold", "E001", "--why", "waiting on legal"]);
    const stopped = await approvedIn(ground.box, ground.demo,
        ["runbook", "stop", "E001", "--why", "legal said no"], run);
    assert.equal(stopped.code, 0, stopped.out);
});

test("E6: a closed run is not stopped — its working state is already terminal", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan"]);
    const run = await startRun(ground, id, "E001");
    await must(ground.box, ground.demo, ["runbook", "advance", "E001", "--why", "planned"]);
    await must(ground.box, ground.demo, ["state", "done", run, "--report", "it shipped"]);
    const refused = await ground.self(["runbook", "stop", "E001", "--why", "too late"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /E001 is closed — its working state is terminal/);
});

test("E7: show marks the stopped run as stopped", async () =>
{
    const ground = await floor();
    const { id, run } = await running(ground);
    await approvedIn(ground.box, ground.demo, ["runbook", "stop", "E001", "--why", "dropped"], run);
    assert.match((await must(ground.box, ground.demo, ["runbook", "show", id])).out, /E001 \(e-[0-9a-z]{5}\) — .*retired/);
});

test("E8: the stop reads back on the log", async () =>
{
    const ground = await floor();
    const { run } = await running(ground);
    await approvedIn(ground.box, ground.demo, ["runbook", "stop", "E001", "--why", "the story was dropped"], run);
    assert.match((await must(ground.box, ground.demo, ["log", "-n", "5"])).out, /entity\.retired/);
});

test("E9: a fresh session reads the stage, the next action and the inspect command out of context alone", async () =>
{
    const ground = await floor();
    const { id } = await running(ground);
    const block = runbookBlock((await must(ground.box, ground.demo, ["context"])).out);
    assert.match(block, /E001 · content loop v1 · 2\/3 draft · next: publish/);
    assert.match(block, new RegExp(`self runbook show ${id}`));
});

test("E10: a run that has passed no stage yet is stopped like any other", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft"]);
    const run = await startRun(ground, id, "E001");
    const stopped = await approvedIn(ground.box, ground.demo,
        ["runbook", "stop", "E001", "--why", "started by mistake"], run);
    assert.equal(stopped.code, 0, stopped.out);
});

test("E11: resume picks a parked run back up, and a held one says approve instead", async () =>
{
    const ground = await floor();
    const { run } = await running(ground);
    const resumed = await ground.self(["runbook", "resume", "E001"]);
    assert.equal(resumed.code, 0, resumed.out);
    assert.match(resumed.out, /E001 is moving again/);
    await must(ground.box, ground.demo, ["runbook", "hold", "E001", "--why", "waiting on legal"]);
    const refused = await ground.self(["runbook", "resume", "E001"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`${run} is already blocked`));
    assert.match(refused.out, /self runbook approve E001/);
});

/* ── group F: editions and drift ───────────────────────────────────── */

test("F1: a run following the only edition there is says nothing about drift", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft"]);
    await startRun(ground, id, "E001");
    const block = runbookBlock((await must(ground.box, ground.demo, ["context"])).out);
    assert.match(block, /content loop v1 ·/);
    assert.ok(!block.includes("the definition is on"), block);
});

test("F2: once the edition is replaced, the run in flight says which edition it follows", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft"]);
    await startRun(ground, id, "E001");
    await revise(ground, id, ["plan", "draft", "publish"]);
    assert.match(runbookBlock((await must(ground.box, ground.demo, ["context"])).out),
        /E001 · content loop v1 \(the definition is on v2\)/);
});

test("F3: show names the whole chain and which edition each run follows", async () =>
{
    const ground = await floor();
    const root = await addRunbook(ground, "content loop", ["plan", "draft"]);
    await startRun(ground, root, "E001");
    const second = await revise(ground, root, ["plan", "draft", "publish"]);
    await startRun(ground, root, "E002");
    const shown = (await must(ground.box, ground.demo, ["runbook", "show", root])).out;
    assert.match(shown, new RegExp(`v1 ${root} — superseded`));
    assert.match(shown, new RegExp(`v2 ${second} — holds now`));
    assert.match(shown, /E001 \(e-[0-9a-z]{5}\) — following v1/);
    assert.match(shown, /E002 \(e-[0-9a-z]{5}\) — following v2/);
});

test("F4: a run following an older edition keeps advancing — the difference is shown, not blocking", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft"]);
    await startRun(ground, id, "E001");
    await revise(ground, id, ["plan", "draft", "publish"]);
    const passed = await ground.self(["runbook", "advance", "E001", "--why", "planned it"]);
    assert.equal(passed.code, 0, passed.out);
    assert.match(passed.out, /E001 passed "plan" — next: draft/);
});

test("F5: a run started after the replacement copies the edition that holds", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft"]);
    await revise(ground, id, ["plan", "draft", "publish"]);
    await startRun(ground, id, "E002");
    const block = runbookBlock((await must(ground.box, ground.demo, ["context"])).out);
    assert.match(block, /E002 · content loop v2 · 1\/3 plan/);
    assert.ok(!block.includes("the definition is on"), block);
});

test("F6: two replacements later, the run still names the edition it is on and the one that holds", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft"]);
    await startRun(ground, id, "E001");
    await revise(ground, id, ["plan", "draft", "publish"]);
    await revise(ground, id, ["plan", "draft", "publish", "measure"]);
    assert.match(runbookBlock((await must(ground.box, ground.demo, ["context"])).out),
        /E001 · content loop v1 \(the definition is on v3\)/);
});

test("F7: a run whose runbook was withdrawn keeps rendering — it holds its own copy of the stages", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft"]);
    await startRun(ground, id, "E001");
    await approvedIn(ground.box, ground.demo, ["state", "retract", id, "--why", "the loop was abandoned"], id);
    assert.match(runbookBlock((await must(ground.box, ground.demo, ["context"])).out), /E001 · content loop v1 · 1\/2 plan/);
});

test("F8: a run whose runbook was withdrawn keeps advancing", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft"]);
    await startRun(ground, id, "E001");
    await approvedIn(ground.box, ground.demo, ["state", "retract", id, "--why", "the loop was abandoned"], id);
    const passed = await ground.self(["runbook", "advance", "E001", "--why", "planned it"]);
    assert.equal(passed.code, 0, passed.out);
});

test("F9: an edition that changed nothing but the wording raises no drift note", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft"]);
    await startRun(ground, id, "E001");
    // The stages are the fingerprint, so a new edition restating them with one
    // extra and then the same set back leaves the run on identical stages.
    const proposed = entityIn((await must(ground.box, ground.demo,
        ["runbook", "revise", id, "--stage", "plan", "--stage", "draft", "--stage", "ship", "--why", "added ship"]))
        .out.split("\n").slice(1).join("\n"));
    await must(ground.box, ground.demo, ["state", "confirm", proposed]);
    const back = entityIn((await must(ground.box, ground.demo,
        ["runbook", "revise", id, "--stage", "plan", "--stage", "draft", "--why", "ship was a mistake"]))
        .out.split("\n").slice(1).join("\n"));
    await must(ground.box, ground.demo, ["state", "confirm", back]);
    const block = runbookBlock((await must(ground.box, ground.demo, ["context"])).out);
    assert.match(block, /E001 · content loop v1 ·/);
    assert.ok(!block.includes("the definition is on"), block);
});

test("F10: a proposed edition nobody confirmed yet moves no run's edition", async () =>
{
    const ground = await floor();
    const id = await addRunbook(ground, "content loop", ["plan", "draft"]);
    await startRun(ground, id, "E001");
    await must(ground.box, ground.demo, ["runbook", "revise", id, "--stage", "plan", "--stage", "publish", "--why", "later"]);
    const block = runbookBlock((await must(ground.box, ground.demo, ["context"])).out);
    assert.match(block, /E001 · content loop v1 ·/);
    assert.ok(!block.includes("the definition is on"), block);
});

/* ── group G: project scope ────────────────────────────────────────── */

test("G1: a runbook registered in one project is not listed in another", async () =>
{
    const ground = await floor();
    await addRunbook(ground, "content loop", ["plan"]);
    const beta = join(ground.ws, "beta");
    mkdirSync(beta, { recursive: true });
    git(ground.box, beta, ["init", "-q", "-b", "main"]);
    await must(ground.box, beta, ["project", "init", "--name", "beta", "--no-connect"]);
    assert.match((await must(ground.box, beta, ["runbook"])).out, /no runbooks registered/);
});

test("G2: an add outside a registered project is refused by the project resolver", async () =>
{
    const ground = await floor();
    const loose = join(ground.box.root, "loose");
    mkdirSync(loose, { recursive: true });
    const refused = await selfIn(ground.box, loose, ["runbook", "add", "loop", "--stage", "plan"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /project/);
});

test("G3: an archived project refuses the add, like every other append", async () =>
{
    const ground = await floor();
    await must(ground.box, ground.ws, ["project", "archive", "demo", "--why", "nobody is working on it"]);
    const refused = await ground.self(["runbook", "add", "loop", "--stage", "plan"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /archived/);
});

test("G4: --project reads another registered project's runbooks", async () =>
{
    const ground = await floor();
    await addRunbook(ground, "content loop", ["plan"]);
    assert.match((await must(ground.box, ground.ws, ["runbook", "--project", "demo"])).out, /content loop v1/);
});

test("G5: --project is not a flag a write verb takes", async () =>
{
    const ground = await floor();
    const refused = await ground.self(["runbook", "add", "loop", "--stage", "plan", "--project", "demo"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /unknown option '--project'/);
});
