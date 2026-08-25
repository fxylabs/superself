// Where a confirm resolves its project from (#302). Every test below is one
// cell of that issue's case table, named by its number, and asserts that
// cell's stated outcome.
//
// The defect the table is drawn around: `self context --project <slug>` prints
// `self work accept`, `self decide confirm` and `self state confirm` beside the
// rows waiting on a person, and each of those verbs resolved its project from
// the working directory — so the line could not be run at the place the context
// was read. The ruling is that the record's own id names the project, which is
// why every cell here runs a verb from somewhere other than the checkout and
// asserts it landed in the project that owns the record.
//
// Two state variables are resolved from outside the arguments and hold cells of
// their own, per the convention adopted after #284: whether the owning
// project's checkout exists on this machine at all (cells 13-16), and whether
// this machine has a workspace (cell 22).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, idIn, machine, must, selfIn, workIdIn } from "./harness.mjs";

const BRIEF = {
    value: "closes the gap",
    success: "it ships",
    stop: "if superseded",
    risk: "low",
    capacity: "one round",
    evidencePlan: "a recorded run",
    confidence: "high",
    expires: "2099-01-01"
};

// A workspace holding two registered projects: `alpha` owns every record the
// cells act on, and `beta` is the other checkout a reader might be standing in.
// The workspace root itself is registered as nothing, which is where a person
// reading `self context --project alpha` actually stands.
function workspace()
{
    const box = machine();
    const ws = join(box.root, "ws");
    const alpha = join(ws, "alpha");
    const beta = join(ws, "beta");
    mkdirSync(alpha, { recursive: true });
    mkdirSync(beta, { recursive: true });
    must(box, ws, ["init"]);
    git(box, alpha, ["init", "-q", "-b", "main"]);
    git(box, beta, ["init", "-q", "-b", "main"]);
    must(box, alpha, ["project", "init", "--name", "alpha", "--no-connect"]);
    must(box, beta, ["project", "init", "--name", "beta", "--no-connect"]);
    must(box, alpha, ["goal", "add", "a direction"]);
    const objective = must(box, alpha, ["objective", "add", "a measurable outcome", "--target", "2099-01-01"])
        .out.match(/\bo-[0-9a-z]{5}\b/)[0];
    return { box, ws, alpha, beta, objective };
}

const { box, ws, alpha, beta, objective } = workspace();

// A project with nothing recorded into it has no log file yet, which is the
// state `beta` is in for most of these cells and is exactly what "the answer
// did not reach it" looks like.
function events(activeBox, project)
{
    const file = join(activeBox.root, "ws", ".superself", "projects", project, "log.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((line) => line !== "").length : 0;
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

/* ── the four verbs, each with the record it answers to ─────────────── */

// One entry per call to action a `--project` context prints. `make` records the
// waiting thing in `alpha` and answers with the id the printed line carries;
// `answer` is that line's argv; `again` is what the verb says when the same
// call is made a second time, which is how a cell proves the first one landed
// without reading the fold twice.
const VERBS = [
    {
        name: "work accept",
        make: (cwd, outcome) => proposalIn(cwd, outcome),
        answer: (id) => ["work", "accept", id],
        again: /is already accepted/
    },
    {
        name: "work decline",
        make: (cwd, outcome) => proposalIn(cwd, outcome),
        answer: (id) => ["work", "decline", id, "--why", "its premises were removed"],
        again: /is already declined/
    },
    {
        name: "decide confirm",
        make: (cwd, text) => decisionIn(cwd, text),
        answer: (id) => ["decide", "confirm", id],
        again: /is not a proposed decision/
    },
    {
        name: "state confirm",
        make: (cwd, text) => recordIn(cwd, text),
        answer: (id) => ["state", "confirm", id],
        again: /already confirmed/
    }
];

// Named rather than written inline in the table above: a driver call inside an
// object property is a call site nothing follows, and the structure check reads
// a file's own named wrappers (#371).
function decisionIn(cwd, text)
{
    return idIn(must(box, cwd, ["decide", text, "--why", "it was weighed", "--proposed"]).out);
}

function recordIn(cwd, text)
{
    return entityIn(must(box, cwd, ["state", "add", text, "--proposed"]).out);
}

function proposalIn(cwd, outcome)
{
    const out = must(box, cwd, ["work", "propose", outcome, "--objective", objective,
        "--value", BRIEF.value, "--success", BRIEF.success, "--stop", BRIEF.stop,
        "--risk", BRIEF.risk, "--capacity", BRIEF.capacity, "--evidence-plan", BRIEF.evidencePlan,
        "--confidence", BRIEF.confidence, "--expires", BRIEF.expires]).out;
    return workIdIn(out);
}

/* ── cells 1-12: the four verbs, from each of the three places ─────── */

const PLACES = [
    { cell: 0, name: "the owning checkout", dir: () => alpha },
    { cell: 1, name: "the workspace root", dir: () => ws },
    { cell: 2, name: "another project's checkout", dir: () => beta }
];

VERBS.forEach((verb, index) =>
{
    for (const place of PLACES)
    {
        const number = index * 3 + place.cell + 1;
        test(`cell ${number}: ${verb.name} run from ${place.name} records into the owning project`, () =>
        {
            const id = verb.make(alpha, `cell ${number}: a record answered from ${place.name}`);
            const ownerWas = events(box, "alpha");
            const otherWas = events(box, "beta");
            const ran = selfIn(box, place.dir(), verb.answer(id));
            assert.equal(ran.code, 0, `the line failed where it was read:\n${ran.out}`);
            assert.ok(events(box, "alpha") > ownerWas, "nothing was recorded into the project that owns the record");
            assert.equal(events(box, "beta"), otherWas, "the answer reached a project the record does not belong to");
            assert.match(selfIn(box, place.dir(), verb.answer(id)).out, verb.again);
        });
    }
});

/* ── cells 13-16: the owning project's checkout is not on this machine ── */

// The ordinary case for a project somebody else is standing in, and the one the
// old resolution could not answer at all: nothing here reads the checkout, so
// deleting it must change nothing about whether the printed line runs.
const goneBox = machine();
const goneWs = join(goneBox.root, "ws");
const goneRecords = {};

test("cells 13-16 setup: the owning project's checkout is removed after its records exist", () =>
{
    const dir = join(goneWs, "alpha");
    mkdirSync(dir, { recursive: true });
    must(goneBox, goneWs, ["init"]);
    git(goneBox, dir, ["init", "-q", "-b", "main"]);
    must(goneBox, dir, ["project", "init", "--name", "alpha", "--no-connect"]);
    must(goneBox, dir, ["goal", "add", "a direction"]);
    const target = must(goneBox, dir, ["objective", "add", "a measurable outcome", "--target", "2099-01-01"])
        .out.match(/\bo-[0-9a-z]{5}\b/)[0];
    const propose = (outcome) => workIdIn(must(goneBox, dir, ["work", "propose", outcome, "--objective", target,
        "--value", BRIEF.value, "--success", BRIEF.success, "--stop", BRIEF.stop,
        "--risk", BRIEF.risk, "--capacity", BRIEF.capacity, "--evidence-plan", BRIEF.evidencePlan,
        "--confidence", BRIEF.confidence, "--expires", BRIEF.expires]).out);
    goneRecords["work accept"] = propose("an outcome answered from a machine without the checkout");
    goneRecords["work decline"] = propose("an outcome turned down from a machine without the checkout");
    goneRecords["decide confirm"] = idIn(must(goneBox, dir, ["decide", "a direction was chosen", "--why", "it was weighed", "--proposed"]).out);
    goneRecords["state confirm"] = entityIn(must(goneBox, dir, ["state", "add", "a record with no checkout left", "--proposed"]).out);
    rmSync(dir, { recursive: true, force: true });
    assert.equal(events(goneBox, "alpha") > 0, true, "the store lost the project's log with its checkout");
});

VERBS.forEach((verb, index) =>
{
    test(`cell ${13 + index}: ${verb.name} resolves when the owning checkout is on another machine`, () =>
    {
        const was = events(goneBox, "alpha");
        const ran = selfIn(goneBox, goneWs, verb.answer(goneRecords[verb.name]));
        assert.equal(ran.code, 0, `the line failed with no checkout to stand in:\n${ran.out}`);
        assert.ok(events(goneBox, "alpha") > was, "nothing was recorded into the project that owns the record");
    });
});

/* ── cells 17-19: what the id resolves to ──────────────────────────── */

test("cell 17: from the workspace root, an id no project holds is refused by naming what was searched", () =>
{
    for (const verb of VERBS)
    {
        const refused = selfIn(box, ws, verb.answer("e-zzzzz"));
        assert.notEqual(refused.code, 0, `${verb.name} answered for an id nothing holds`);
        assert.match(refused.out, /no registered project holds "e-zzzzz"/);
        assert.match(refused.out, /alpha/);
        assert.match(refused.out, /beta/);
    }
});

test("cell 18: inside a project, an id it does not hold keeps the verb's own refusal", () =>
{
    const refusals = [/no work proposal matches/, /no work proposal matches/, /is not a decision/, /unknown entity/];
    for (const [index, verb] of VERBS.entries())
    {
        const refused = selfIn(box, alpha, verb.answer("e-zzzzz"));
        assert.notEqual(refused.code, 0, `${verb.name} answered for an id nothing holds`);
        assert.match(refused.out, refusals[index]);
    }
});

// The prefix is computed from the two ids rather than raced for: a ULID's
// leading characters are the millisecond it was minted in, so how many two
// records share depends on when the suite ran. Taking the shared head of the
// two ids that exist is the same case, stated in a way a slow machine and a
// fast one both reach.
function sharedPrefix(one, other)
{
    let shared = "";
    while (shared.length < one.length && one[shared.length] === other[shared.length])
    {
        shared += one[shared.length];
    }
    return shared;
}

test("cell 19: a prefix two projects both answer to is refused by naming both", () =>
{
    const here = idIn(must(box, alpha, ["decide", "a direction chosen in alpha", "--why", "it was weighed", "--proposed"]).out);
    const there = idIn(must(box, beta, ["decide", "a direction chosen in beta", "--why", "it was weighed", "--proposed"]).out);
    const prefix = sharedPrefix(here, there);
    assert.ok(prefix.length > 0, "the two decision ids share no prefix to be ambiguous about");
    const refused = selfIn(box, ws, ["decide", "confirm", prefix]);
    assert.notEqual(refused.code, 0, "an ambiguous prefix confirmed one of the two records");
    assert.match(refused.out, /names a record in/);
    assert.match(refused.out, /alpha/);
    assert.match(refused.out, /beta/);
});

/* ── cells 20-21: the owning project is archived ───────────────────── */

test("cells 20 and 21: an archived owner is refused by the append gate, wherever the call is made", () =>
{
    const archivedBox = machine();
    const archivedWs = join(archivedBox.root, "ws");
    const dir = join(archivedWs, "alpha");
    mkdirSync(dir, { recursive: true });
    must(archivedBox, archivedWs, ["init"]);
    git(archivedBox, dir, ["init", "-q", "-b", "main"]);
    must(archivedBox, dir, ["project", "init", "--name", "alpha", "--no-connect"]);
    const id = entityIn(must(archivedBox, dir, ["state", "add", "a record set aside with its project", "--proposed"]).out);
    must(archivedBox, archivedWs, ["project", "archive", "alpha", "--why", "nobody is working on it"]);
    const expected = /project "alpha" is archived, so nothing more is recorded into it/;
    const inside = selfIn(archivedBox, dir, ["state", "confirm", id]);
    assert.notEqual(inside.code, 0, "a confirm landed in an archived project");
    assert.match(inside.out, expected);
    const outside = selfIn(archivedBox, archivedWs, ["state", "confirm", id]);
    assert.notEqual(outside.code, 0, "a confirm from outside landed in an archived project");
    assert.match(outside.out, expected,
        "the workspace-root call answered something other than the append gate's refusal");
});

/* ── cell 22: this machine has no workspace ────────────────────────── */

test("cell 22: with no workspace on this machine, every one of the four says so", () =>
{
    const bare = machine();
    const nowhere = mkdtempSync(join(tmpdir(), "self-no-workspace-"));
    for (const verb of VERBS)
    {
        const refused = selfIn(bare, nowhere, verb.answer("e-zzzzz"));
        assert.notEqual(refused.code, 0, `${verb.name} answered without a workspace`);
        assert.match(refused.out, /this machine has no workspace/);
    }
    rmSync(nowhere, { recursive: true, force: true });
});

/* ── cells 23-24: what the room judgment is made against ───────────── */

// A cap is judged against the project that owns the record, never against the
// directory the call was made from. The tiers here are alpha's and beta's is
// empty, so a confirm judged against the wrong project would find room and
// land — which is the defect this cell exists to catch.
function capped()
{
    const capBox = machine();
    const capWs = join(capBox.root, "ws");
    const owner = join(capWs, "alpha");
    const other = join(capWs, "beta");
    mkdirSync(owner, { recursive: true });
    mkdirSync(other, { recursive: true });
    must(capBox, capWs, ["init"]);
    git(capBox, owner, ["init", "-q", "-b", "main"]);
    git(capBox, other, ["init", "-q", "-b", "main"]);
    must(capBox, owner, ["project", "init", "--name", "alpha", "--no-connect"]);
    must(capBox, other, ["project", "init", "--name", "beta", "--no-connect"]);
    return { capBox, capWs, owner };
}

function setCaps(activeBox, caps)
{
    const file = join(activeBox.root, "ws", ".superself", "config.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...config, tokensPerCharacter: 1, tokensMeasured: true, ...caps }) + "\n");
}

test("cell 23: from the workspace root, the room judgment is made against the owning project", () =>
{
    const { capBox, capWs, owner } = capped();
    setCaps(capBox, { indexTokens: 24 });
    must(capBox, owner, ["state", "add", "holds the one index seat"]);
    const added = entityIn(must(capBox, owner, ["state", "add", "wants the seat", "--proposed"]).out);
    const refused = selfIn(capBox, capWs, ["state", "confirm", added]);
    assert.notEqual(refused.code, 0, "the confirm found room in a project that does not own the record");
    assert.match(refused.out, /put the project index tier over its cap/);
});

test("cell 24: from the workspace root, a cap-paired demotion still lands as one unit", () =>
{
    const { capBox, capWs, owner } = capped();
    setCaps(capBox, { indexTokens: 24 });
    const holder = entityIn(must(capBox, owner, ["state", "add", "holds the one index seat"]).out);
    const added = entityIn(must(capBox, owner, ["state", "add", "wants the seat", "--proposed", "--demote", holder]).out);
    const swap = must(capBox, capWs, ["state", "confirm", added]);
    assert.equal([...swap.out.matchAll(/entity\.confirmed/g)].length, 2, `the pair did not land as one unit:\n${swap.out}`);
    assert.ok(must(capBox, capWs, ["state", "show", added, "--project", "alpha"]).out.includes("placement: project · index"));
});

/* ── cells 25-27: the advertised line, and what it was not bought with ── */

// The convention's own cell: an output that advertises a command is read
// somewhere, and the command it prints has to run there. Both renders that
// print these lines get one, because they share the row builder and a fix that
// reached only `self context` would leave `self status` saying the same thing
// and meaning something unrunnable.
const ADVERTISED = /`self (work accept [^`\s]+|decide confirm [^`\s]+|state confirm [^`\s]+)`/g;

function advertisedIn(text)
{
    return [...text.matchAll(ADVERTISED)].map((match) => match[1].split(" "));
}

function waitingRecords(render)
{
    proposalIn(alpha, `an outcome advertised to a ${render} reader outside the project`);
    must(box, alpha, ["decide", `a direction advertised to a ${render} reader outside`, "--why", "it was weighed", "--proposed"]);
    must(box, alpha, ["state", "add", `a record advertised to a ${render} reader outside`, "--proposed"]);
}

// Cell 26 is the same reading of `self status`, which prints its waiting rows
// only at a terminal — so it lives in confirm-owner-tty.test.mjs, where the
// styled render can be reached.
test("cell 25: every line self context --project prints runs where it was read", () =>
{
    waitingRecords("context");
    const read = must(box, ws, ["context", "--project", "alpha"]).out;
    const lines = advertisedIn(read);
    const kinds = new Set(lines.map((argv) => argv.slice(0, 2).join(" ")));
    assert.deepEqual([...kinds].sort(), ["decide confirm", "state confirm", "work accept"],
        `self context --project did not advertise all three kinds:\n${read}`);
    for (const argv of lines)
    {
        const ran = selfIn(box, ws, argv);
        assert.equal(ran.code, 0, `\`self ${argv.join(" ")}\` failed where the render was read:\n${ran.out}`);
    }
});

test("cell 27: none of the four gained a scope flag", () =>
{
    for (const verb of VERBS)
    {
        const refused = selfIn(box, ws, [...verb.answer("e-zzzzz"), "--project", "alpha"]);
        assert.notEqual(refused.code, 0, `${verb.name} accepted --project`);
        assert.match(refused.out, /--project/,
            `${verb.name} dropped --project instead of naming it: ${refused.out}`);
    }
});
