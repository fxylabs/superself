import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approvedIn, demoWorkspace, idIn, machine, must, mustPerson, mustSpawn, selfIn, spawnIn } from "./harness.mjs";

const box = machine();
const { ws, demo } = await demoWorkspace(box);

const logEvents = () => readFileSync(join(ws, ".superself", "projects", "demo", "log.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));

// #400 inverted this cell. It read "a process with no terminal is refused";
// what it proves now is that the same process records, and that the event says
// an agent wrote it. The subject is unchanged — what a terminal-less process
// may do to a record — and the answer moved.
test("a supersede from a process with no terminal records, and the event says an agent wrote it", () =>
{
    const first = idIn(mustSpawn(box, demo, ["decide", "the first policy"]).out);
    const before = logEvents().length;
    // `spawnIn`, and this cell alone in the file uses it (#371, cell 22). A
    // process this suite drives has whatever terminal the driver hands it, and
    // what is under test is a process that really has none.
    const recorded = spawnIn(box, demo, ["decide", "a pointer", "--supersedes", first]);
    assert.equal(recorded.code, 0, recorded.out);
    // The disclosure survived the gate that used to follow it: a caller still
    // reads what it destroyed, and now reads the way back too.
    assert.match(recorded.out, /the first policy/);
    assert.match(recorded.out, /`self undo` takes it back/);
    // One event: a preset supersession records the successor and carries the
    // displacement as a `supersedes` link the fold reads, rather than a second
    // retirement event.
    const written = logEvents().slice(before);
    assert.deepEqual(written.map((event) => event.type), ["entity.confirmed"]);
    assert.deepEqual(written[0].payload.links, [{ type: "supersedes", target: first }]);
    assert.deepEqual(written[0].payload.by, { kind: "agent" });
});

test("a person's supersede records the supersession and says a person wrote it", async () =>
{
    const first = idIn((await must(box, demo, ["decide", "the second policy"])).out);
    const approved = await approvedIn(box, demo, ["decide", "replaces it", "--supersedes", first], first);
    assert.equal(approved.code, 0, approved.out);
    const written = logEvents().at(-1);
    assert.equal(written.type, "entity.confirmed");
    assert.deepEqual(written.payload.links, [{ type: "supersedes", target: first }]);
    assert.deepEqual(written.payload.by, { kind: "person" });
});

// A session's own token rides the record, so a reader of a log written by
// several sessions can tell which one wrote which line.
test("an agent session names itself on the record it destroys", async () =>
{
    const id = idIn((await must(box, demo, ["decide", "a policy a session replaced"])).out);
    const recorded = await selfIn(box, demo, ["decide", "the session's replacement", "--supersedes", id],
        { SUPERSELF_SESSION: "sess-400" });
    assert.equal(recorded.code, 0, recorded.out);
    const written = logEvents().at(-1);
    assert.deepEqual(written.payload.by, { kind: "agent", session: "sess-400" });
});

// The record's own words say what is being lost; the reason the call gives
// says why it should be. A reader judging a withdrawal reads both, and one
// reviewed set (#312) is unreadable without the second.
test("the disclosure states the reason the call gives, beside what the record says", async () =>
{
    const id = idIn((await must(box, demo, ["decide", "a policy whose scope ran out"])).out);
    const recorded = await selfIn(box, demo, ["decide", "retract", id, "--why", "the scope it covered is gone"]);
    assert.equal(recorded.code, 0, recorded.out);
    assert.match(recorded.out, /a policy whose scope ran out/);
    assert.match(recorded.out, /retracted because: the scope it covered is gone/);
});

// The verbs that give up an outcome read "retired", not "retireed": the
// reason line is the one sentence a reader weighs to judge whether the reason
// justifies the loss, and it was misspelled on every one of them.
test("a retirement's reason is spelled retired on every verb that gives one up", async () =>
{
    const unit = (await mustPerson(box, demo, ["work", "add", "an outcome that was given up"])).out.match(/\bw-[0-9a-z]{5}\b/)[0];
    const recorded = await selfIn(box, demo, ["work", "retire", unit, "--why", "the outcome moved to another unit"]);
    assert.equal(recorded.code, 0, recorded.out);
    assert.match(recorded.out, /retired because: the outcome moved to another unit/);
    assert.doesNotMatch(recorded.out, /retireed/);
});

// A supersession carries no `--why` because its successor's text is the
// reason. The disclosure states that text, so what replaced the record is
// never words nobody was shown.
test("the disclosure states the record a supersession would write", async () =>
{
    const first = idIn((await must(box, demo, ["decide", "the policy as first taken"])).out);
    const recorded = await selfIn(box, demo, ["decide", "the policy as it now stands", "--supersedes", first]);
    assert.equal(recorded.code, 0, recorded.out);
    assert.match(recorded.out, /the policy as first taken/);
    assert.match(recorded.out, /replaced by this new decision: the policy as it now stands/);
});

// This cell asserted that a wrong typed answer recorded nothing. There is no
// answer to get wrong any more, and the replacement is the fact that replaced
// it: nothing is read from the terminal, so what a caller types changes neither
// the write nor its `by`.
test("nothing is read from the terminal — a typed answer changes neither the write nor its by", async () =>
{
    const first = idIn((await must(box, demo, ["decide", "the third policy"])).out);
    const before = logEvents().length;
    const recorded = await approvedIn(box, demo, ["decide", "replaces it", "--supersedes", first], "not-the-id");
    assert.equal(recorded.code, 0, recorded.out);
    const written = logEvents().slice(before);
    assert.deepEqual(written.map((event) => event.type), ["entity.confirmed"]);
    assert.deepEqual(written[0].payload.by, { kind: "person" });
});

/* ── undo: taking a destruction back ───────────────────────────────── */

// Cell 19 of #390: the narrow undo. Without `--supersession` this same call is
// cell 20 and takes the successor back too.
test("undo --supersession gives back a superseded record and leaves the successor standing", async () =>
{
    const first = idIn((await must(box, demo, ["decide", "undo: the standing policy"])).out);
    const replacing = await approvedIn(box, demo, ["decide", "undo: the replacement", "--supersedes", first], first);
    assert.equal(replacing.code, 0, replacing.out);
    assert.match((await must(box, demo, ["state", "show", first])).out, /superseded/);
    const undone = await selfIn(box, demo, ["undo", idIn(replacing.printed), "--supersession", "--why", "it added to the policy, it did not replace it"]);
    assert.equal(undone.code, 0, undone.out);
    assert.match((await must(box, demo, ["state", "show", first])).out, /confirmed/);
    const context = (await must(box, demo, ["context"])).out;
    assert.ok(context.includes("undo: the replacement"), "the successor was taken back along with its link");
});

test("undo needs no terminal — reversing a destruction destroys nothing", async () =>
{
    const id = idIn((await must(box, demo, ["convention", "add", "undo: a rule that came back"])).out);
    const dropped = await approvedIn(box, demo, ["convention", "drop", id, "--why", "dropped in error"], id);
    assert.equal(dropped.code, 0, dropped.out);
    assert.ok(!(await must(box, demo, ["context"])).out.includes("undo: a rule that came back"));
    // Spawned as a child: no terminal, and no gate either.
    const undone = await selfIn(box, demo, ["undo", idIn(dropped.printed), "--why", "the rule still holds"]);
    assert.equal(undone.code, 0, undone.out);
    assert.ok((await must(box, demo, ["context"])).out.includes("undo: a rule that came back"));
});

test("undo keeps both halves in the log and refuses a second time", async () =>
{
    const unit = (await mustPerson(box, demo, ["work", "add", "undo: an outcome given up"])).out.match(/\bw-[0-9a-z]{5}\b/)[0];
    const retired = await approvedIn(box, demo, ["work", "retire", unit, "--why", "given up early"], unit);
    const retirement = idIn(retired.printed);
    assert.equal((await selfIn(box, demo, ["undo", retirement, "--why", "it is still wanted"])).code, 0);
    assert.doesNotMatch((await must(box, demo, ["work", "show", unit])).out, /Status: retired/);
    const kept = logEvents().filter((event) => event.id === retirement || event.refs?.annuls === retirement);
    assert.equal(kept.length, 2, "the log dropped a half of what happened");
    const again = await selfIn(box, demo, ["undo", retirement, "--why", "twice"]);
    assert.notEqual(again.code, 0);
    assert.match(again.out, /was already undone/);
});

// Inverted by #390 (cell 3): a plain decision recorded by mistake is the
// cheapest thing in the system to erase, and the ceremony it used to owe is
// what that issue abolishes. `--why` goes with it — "this was a mistake" is
// the whole statement, and the annulment already names what it reversed.
test("undo takes back a decision that replaced nothing, with no --why owed", async () =>
{
    const plain = idIn((await must(box, demo, ["decide", "undo: a decision that replaced nothing"])).out);
    const undone = await selfIn(box, demo, ["undo", plain]);
    assert.equal(undone.code, 0, undone.out);
    assert.doesNotMatch((await must(box, demo, ["context"])).out, /undo: a decision that replaced nothing/);
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
    const id = idIn((await must(box, demo, ["convention", "add", "merge: a rule that survives a reorder"])).out);
    const dropped = await approvedIn(box, demo, ["convention", "drop", id, "--why", "dropped in error"], id);
    await must(box, demo, ["undo", idIn(dropped.printed), "--why", "the rule still holds"]);
    const inOrder = (await must(box, demo, ["state", "show", id])).out;

    const path = join(ws, ".superself", "projects", "demo", "log.jsonl");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    // A union merge orders by neither time nor dependency: put the last line
    // first and read the same question again.
    writeFileSync(path, [lines.at(-1), ...lines.slice(0, -1)].join("\n") + "\n");
    assert.equal((await must(box, demo, ["state", "show", id])).out, inOrder, "log order changed what the undo folded to");
});
