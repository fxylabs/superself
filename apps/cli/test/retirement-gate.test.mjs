import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approvedIn, demoWorkspace, idIn, machine, must, selfIn } from "./harness.mjs";

const box = machine();
const { ws, demo } = demoWorkspace(box);

test("the gate refuses a supersede from a process with no terminal, and records nothing", () =>
{
    const first = idIn(must(box, demo, ["decide", "the first policy"]).out);
    const before = readFileSync(join(ws, ".superself", "projects", "demo", "log.jsonl"), "utf8").trim().split("\n").length;
    const refused = selfIn(box, demo, ["decide", "a pointer", "--supersedes", first]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /nothing was recorded/);
    assert.match(refused.out, /the first policy/);
    assert.match(refused.out, /a person runs this in their own terminal/);
    const after = readFileSync(join(ws, ".superself", "projects", "demo", "log.jsonl"), "utf8").trim().split("\n").length;
    assert.equal(after, before);
});

test("the approved path records the supersession and the confirmation it was typed at", async () =>
{
    const first = idIn(must(box, demo, ["decide", "the second policy"]).out);
    const approved = await approvedIn(box, demo, ["decide", "replaces it", "--supersedes", first], first);
    assert.equal(approved.code, 0, approved.out);
    const events = readFileSync(join(ws, ".superself", "projects", "demo", "log.jsonl"), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line));
    const written = events.at(-1);
    assert.equal(written.type, "entity.confirmed");
    assert.deepEqual(written.payload.links, [{ type: "supersedes", target: first }]);
    assert.equal(written.payload.confirmation.method, "tty");
    assert.equal(written.payload.confirmation.challenge, first);
});

// The record's own words say what is being lost; the reason the call gives
// says why it should be. A person judging a withdrawal reads both, and one
// reviewed set (#312) is unreadable without the second.
test("the disclosure states the reason the call gives, beside what the record says", () =>
{
    const id = idIn(must(box, demo, ["decide", "a policy whose scope ran out"]).out);
    const refused = selfIn(box, demo, ["decide", "retract", id, "--why", "the scope it covered is gone"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /a policy whose scope ran out/);
    assert.match(refused.out, /retracted because: the scope it covered is gone/);
});

// The verbs that give up an outcome read "retired", not "retireed": the
// reason line is the one sentence a person reads to judge whether the reason
// justifies the loss, and it was misspelled on every one of them.
test("a retirement's reason is spelled retired on every verb that gives one up", () =>
{
    const unit = must(box, demo, ["work", "add", "an outcome that was given up"]).out.match(/\bw-[0-9a-z]{5}\b/)[0];
    const refused = selfIn(box, demo, ["work", "retire", unit, "--why", "the outcome moved to another unit"]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /retired because: the outcome moved to another unit/);
    assert.doesNotMatch(refused.out, /retireed/);
});

// A supersession carries no `--why` because its successor's text is the
// reason. The disclosure states that text, so approving a supersession is
// never approving words that were not shown.
test("the disclosure states the record a supersession would write", () =>
{
    const first = idIn(must(box, demo, ["decide", "the policy as first taken"]).out);
    const refused = selfIn(box, demo, ["decide", "the policy as it now stands", "--supersedes", first]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /the policy as first taken/);
    assert.match(refused.out, /replaced by this new decision: the policy as it now stands/);
});

test("a wrong answer at the terminal records nothing", async () =>
{
    const first = idIn(must(box, demo, ["decide", "the third policy"]).out);
    const before = readFileSync(join(ws, ".superself", "projects", "demo", "log.jsonl"), "utf8").trim().split("\n").length;
    const wrong = await approvedIn(box, demo, ["decide", "replaces it", "--supersedes", first], "not-the-id");
    assert.equal(wrong.code, 1);
    const after = readFileSync(join(ws, ".superself", "projects", "demo", "log.jsonl"), "utf8").trim().split("\n").length;
    assert.equal(after, before);
});

/* ── undo: taking a destruction back ───────────────────────────────── */

const events = () => readFileSync(join(ws, ".superself", "projects", "demo", "log.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));

test("undo gives back a superseded record and leaves the successor standing", async () =>
{
    const first = idIn(must(box, demo, ["decide", "undo: the standing policy"]).out);
    const replacing = await approvedIn(box, demo, ["decide", "undo: the replacement", "--supersedes", first], first);
    assert.equal(replacing.code, 0, replacing.out);
    assert.match(must(box, demo, ["state", "show", first]).out, /superseded/);
    const undone = selfIn(box, demo, ["undo", idIn(replacing.printed), "--why", "it added to the policy, it did not replace it"]);
    assert.equal(undone.code, 0, undone.out);
    assert.match(must(box, demo, ["state", "show", first]).out, /confirmed/);
    const context = must(box, demo, ["context"]).out;
    assert.ok(context.includes("undo: the replacement"), "the successor was taken back along with its link");
});

test("undo needs no terminal — reversing a destruction destroys nothing", async () =>
{
    const id = idIn(must(box, demo, ["convention", "add", "undo: a rule that came back"]).out);
    const dropped = await approvedIn(box, demo, ["convention", "drop", id, "--why", "dropped in error"], id);
    assert.equal(dropped.code, 0, dropped.out);
    assert.ok(!must(box, demo, ["context"]).out.includes("undo: a rule that came back"));
    // Spawned as a child: no terminal, and no gate either.
    const undone = selfIn(box, demo, ["undo", idIn(dropped.printed), "--why", "the rule still holds"]);
    assert.equal(undone.code, 0, undone.out);
    assert.ok(must(box, demo, ["context"]).out.includes("undo: a rule that came back"));
});

test("undo keeps both halves in the log and refuses a second time", async () =>
{
    const unit = must(box, demo, ["work", "add", "undo: an outcome given up"]).out.match(/\bw-[0-9a-z]{5}\b/)[0];
    const retired = await approvedIn(box, demo, ["work", "retire", unit, "--why", "given up early"], unit);
    const retirement = idIn(retired.printed);
    assert.equal(selfIn(box, demo, ["undo", retirement, "--why", "it is still wanted"]).code, 0);
    assert.doesNotMatch(must(box, demo, ["work", "show", unit]).out, /Status: retired/);
    const kept = events().filter((event) => event.id === retirement || event.refs?.annuls === retirement);
    assert.equal(kept.length, 2, "the log dropped a half of what happened");
    const again = selfIn(box, demo, ["undo", retirement, "--why", "twice"]);
    assert.notEqual(again.code, 0);
    assert.match(again.out, /was already undone/);
});

test("undo refuses an event that destroyed nothing, and names what it takes back", () =>
{
    const plain = idIn(must(box, demo, ["decide", "undo: a decision that replaced nothing"]).out);
    const refused = selfIn(box, demo, ["undo", plain, "--why", "nothing to take back"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /undo takes back a retirement, a withdrawal, a link, or a record's supersession/);
});

test("undo without --why is refused", () =>
{
    const refused = selfIn(box, demo, ["undo", "01zzzzz"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--why/);
});

/* ── uniformity and merge safety ───────────────────────────────────── */

// The guarantee the whole design rests on: a destructive event cannot reach
// the log except through the gate. Stated as a rule about the source, because
// a case-by-case test would pass while a new verb quietly added a sixteenth
// way around it.
test("no call site hands a destructive event straight to the event writer", () =>
{
    const DESTRUCTIVE = ["entity.retracted", "entity.retired"];
    const offenders = [];
    for (const name of readdirSync(new URL("../src", import.meta.url)))
    {
        if (!name.endsWith(".ts"))
        {
            continue;
        }
        const source = readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
        for (const [index, line] of source.split("\n").entries())
        {
            const writes = /\brecordEvents?\s*\(/.test(line) && DESTRUCTIVE.some((type) => line.includes(`"${type}"`));
            // Turning down a proposal writes the same event type and destroys
            // nothing — the record it names was never held. `refs.declines` is
            // what tells the two apart, in the fold and here alike.
            if (writes && !line.includes("declines:"))
            {
                offenders.push(`${name}:${index + 1}`);
            }
        }
    }
    assert.deepEqual(offenders, [], "a destructive event is recorded without passing the retirement gate");
});

// Annulment binds to an event id, never to log order, which is what lets a
// clone merge a restoration above or below the event it takes back. Shuffling
// the log is the proof: the same lines fold to the same state either way.
test("a shuffled log folds an undo to the same state", async () =>
{
    const id = idIn(must(box, demo, ["convention", "add", "merge: a rule that survives a reorder"]).out);
    const dropped = await approvedIn(box, demo, ["convention", "drop", id, "--why", "dropped in error"], id);
    must(box, demo, ["undo", idIn(dropped.printed), "--why", "the rule still holds"]);
    const inOrder = must(box, demo, ["state", "show", id]).out;

    const path = join(ws, ".superself", "projects", "demo", "log.jsonl");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    // A union merge orders by neither time nor dependency: put the last line
    // first and read the same question again.
    writeFileSync(path, [lines.at(-1), ...lines.slice(0, -1)].join("\n") + "\n");
    assert.equal(must(box, demo, ["state", "show", id]).out, inOrder, "log order changed what the undo folded to");
});
