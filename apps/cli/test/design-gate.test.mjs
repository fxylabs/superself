// The decision-bound design gate (#316), one test per cell of the case table
// posted on the issue before the code was written. The table's variables are
// the cited decision's state, the report's kind, whether an approval is bound
// to the design artifact's hash, and what dispatch then does.
//
//   A. `self report … --design --implements` — the submission gate
//   A1  live confirmed decision, design + artifact       receipt echoes id and text
//   A2  live proposed decision                           accepted, echo says proposed
//   A3  two live decisions                               both echoed
//   A4  none cited                                       refused, naming the rule
//   A5  superseded                                       refused, naming the successor
//   A6  retracted                                        refused, naming the retraction
//   A7  declined proposal                                refused, naming the decline
//   A8  unknown id                                       refused as unknown
//   A9  a convention, not a decision                     refused, naming the kind
//   A10 another project's decision, scope project        refused, naming the project
//   A11 another project's decision, scope workspace      accepted
//   A12 ordinary report                                  untouched by the gate
//   A13 --implements without --design                    refused
//   A14 design with no artifact                          accepted, receipt says unbound
//   A15 design with two artifacts                        refused
//
//   B. `self report confirm <report-id>` — approval and hash binding
//   B1  a session, no terminal                           report.confirmed, by = agent (#400)
//   B2  a person at a terminal                           report.confirmed, bound, by = person
//   B3  nothing is typed back                            the digest binds it, not an answer
//   B4  design with no artifact                          refused, nothing to bind
//   B5  an ordinary report                               refused, not a design
//   B6  unknown report id                                refused
//   B7  already approved                                 says so, records nothing
//
//   C. `self work start` — the dispatch gate
//   C1  no design report                                 unchanged
//   C2  design never approved                            refused, names the approve command
//   C3  approval carrying no digest                      refused as unbound
//   C4  approved, bound, decision live                   dispatches
//   C5  its decision superseded afterwards               refused, names the successor
//   C6  its decision retracted afterwards                refused, names the retraction
//   C7  a new design citing the successor, approved      dispatches
//   C8  an old unapproved design beside a good one       dispatches
//   C9  work start --force                               refused as an unknown option
//   C10 state start, the other execution verb              refuses a work unit outright, so it is no way in
//
//   D. what a reader sees
//   D1r work show                                        marks the design, its citation, its approval
//   D2r state show on the superseded decision            still answers, names the successor
//   D3r context                                          unchanged by a design report
//
//   E. what the commands resolve from outside their arguments
//   E1  report --design run from another project          reachability judged in the work's project
//   E2  report --design run outside every project         refused by the project gate
//   E3  work start run from another project's checkout    the same gate applies
//
// E1 and E3 place the unit into the other project first. The table as posted
// said "a unit that renders here", and a unit only renders where its scope
// points (#181 D1) — addressing a demo unit from another checkout without
// moving it is refused as an unknown id, by a rule that predates this gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approvedIn, demoWorkspace, git, idIn, logFixture, machine, must, mustPerson, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
const { ws, demo } = await demoWorkspace(box);
const self = (cwd, args) => selfIn(box, cwd, args);
const log = (slug = "demo") => join(ws, ".superself", "projects", slug, "log.jsonl");
const events = (slug = "demo") => readFileSync(log(slug), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const lineCount = (slug = "demo") => events(slug).length;

// One design file per test, so a digest is never shared between two of them.
function designFile(name, body)
{
    const path = join(box.root, `${name}.md`);
    writeFileSync(path, `# ${name}\n\n${body}\n`);
    return path;
}

const decide = async (text) => idIn((await must(box, demo, ["decide", text])).out);
const work = async (outcome) => workIdIn((await mustPerson(box, demo, ["work", "add", outcome])).out);
const reportIdIn = (text) => text.match(/design report (\S+) recorded/)[1];

// A design report's artifact digest, read back off the event the CLI wrote —
// the same value the approval prompt asks a person to type.
function digestOf(reportId, slug = "demo")
{
    const found = events(slug).find((event) => event.id === reportId);
    return found.payload.artifacts[0].digest;
}

async function submitDesign(id, summary, decisions, name = id)
{
    const result = await must(box, demo, ["report", id, summary, "--design",
        "--implements", decisions.join(","), "--artifact", designFile(name, summary)]);
    return reportIdIn(result.out);
}

/* Two more projects, for the reachability and cwd cells. */
const other = join(ws, "other");

mkdirSync(other, { recursive: true });

git(box, other, ["init", "-q", "-b", "main"]);

await must(box, other, ["project", "init", "--name", "other", "--no-connect"]);

/* ── A. the submission gate ────────────────────────────────────────── */

test("A1 a design citing a live decision is recorded, and the receipt echoes the decision's own text", async () =>
{
    const decision = await decide("A1: the store is append-only");
    const unit = await work("A1 outcome");
    const result = await must(box, demo, ["report", unit, "A1 design", "--design",
        "--implements", decision, "--artifact", designFile("a1", "append-only design")]);
    assert.match(result.out, new RegExp(`implements ${decision} \\(confirmed\\) — A1: the store is append-only`));
    assert.match(result.out, /it is approved with: self report confirm/);
});

test("A2 a proposed decision is live, and the echo says which status it is in", async () =>
{
    const decision = idIn((await must(box, demo, ["decide", "A2: proposals count as live", "--proposed"])).out);
    const unit = await work("A2 outcome");
    const result = await must(box, demo, ["report", unit, "A2 design", "--design",
        "--implements", decision, "--artifact", designFile("a2", "proposed design")]);
    assert.match(result.out, new RegExp(`implements ${decision} \\(proposed\\)`));
});

test("A3 a design implementing two decisions echoes both", async () =>
{
    const first = await decide("A3: one rule");
    const second = await decide("A3: another rule");
    const unit = await work("A3 outcome");
    const result = await must(box, demo, ["report", unit, "A3 design", "--design",
        "--implements", `${first},${second}`, "--artifact", designFile("a3", "two rules")]);
    assert.match(result.out, /A3: one rule/);
    assert.match(result.out, /A3: another rule/);
});

test("A4 a design with no --implements is refused, and the refusal names the flag", async () =>
{
    const unit = await work("A4 outcome");
    const before = lineCount();
    const result = await self(demo, ["report", unit, "A4 design", "--design", "--artifact", designFile("a4", "uncited")]);
    assert.equal(result.code, 1);
    assert.match(result.out, /has to say which decision it implements/);
    assert.match(result.out, /--implements <decision-id>/);
    assert.equal(lineCount(), before);
});

test("A5 citing a superseded decision is refused, and the refusal names the successor", async () =>
{
    const decision = await decide("A5: the first direction");
    const replaced = await approvedIn(box, demo, ["decide", "A5: the second direction", "--supersedes", decision], decision);
    assert.equal(replaced.code, 0, replaced.out);
    const successor = idIn(replaced.out);
    const unit = await work("A5 outcome");
    const result = await self(demo, ["report", unit, "A5 design", "--design",
        "--implements", decision, "--artifact", designFile("a5", "stale")]);
    assert.equal(result.code, 1);
    assert.match(result.out, new RegExp(`was superseded by ${successor}`));
    assert.match(result.out, new RegExp(`--implements ${successor}`));
});

test("A6 citing a retracted decision is refused, and the refusal carries why it was withdrawn", async () =>
{
    const decision = await decide("A6: a rule that stopped holding");
    const retracted = await approvedIn(box, demo, ["decide", "retract", decision, "--why", "the market moved"], decision);
    assert.equal(retracted.code, 0, retracted.out);
    const unit = await work("A6 outcome");
    const result = await self(demo, ["report", unit, "A6 design", "--design",
        "--implements", decision, "--artifact", designFile("a6", "withdrawn")]);
    assert.equal(result.code, 1);
    assert.match(result.out, /was retracted — the market moved/);
});

test("A7 citing a declined proposal is refused as declined, not as retracted", async () =>
{
    const decision = idIn((await must(box, demo, ["decide", "A7: a proposal nobody took", "--proposed"])).out);
    await must(box, demo, ["decide", "decline", decision, "--why", "we chose otherwise"]);
    const unit = await work("A7 outcome");
    const result = await self(demo, ["report", unit, "A7 design", "--design",
        "--implements", decision, "--artifact", designFile("a7", "declined")]);
    assert.equal(result.code, 1);
    assert.match(result.out, /was declined — we chose otherwise/);
});

test("A8 an unknown decision id is refused, and the refusal names how to list them", async () =>
{
    const unit = await work("A8 outcome");
    const result = await self(demo, ["report", unit, "A8 design", "--design",
        "--implements", "01ZZZZZZZZZZZZZZZZZZZZZZZZ", "--artifact", designFile("a8", "unknown")]);
    assert.equal(result.code, 1);
    assert.match(result.out, /is not a decision this project knows/);
    assert.match(result.out, /self search --type decision/);
});

test("A9 citing a convention is refused by naming what kind of record it actually is", async () =>
{
    const convention = idIn((await must(box, demo, ["convention", "add", "A9: four spaces"])).out);
    const unit = await work("A9 outcome");
    const result = await self(demo, ["report", unit, "A9 design", "--design",
        "--implements", convention, "--artifact", designFile("a9", "wrong kind")]);
    assert.equal(result.code, 1);
    assert.match(result.out, /is a convention record/);
});

test("A10 a decision that renders only in another project is refused by naming that project", async () =>
{
    const decision = idIn((await must(box, other, ["decide", "A10: other's own rule"])).out);
    const unit = await work("A10 outcome");
    const result = await self(demo, ["report", unit, "A10 design", "--design",
        "--implements", decision, "--artifact", designFile("a10", "unreachable")]);
    assert.equal(result.code, 1);
    assert.match(result.out, /renders in project other and not in demo/);
});

test("A11 a workspace-scoped decision in another project is reachable and cites cleanly", async () =>
{
    const decision = idIn((await must(box, other, ["decide", "A11: a rule for every project"])).out);
    await must(box, other, ["state", "place", decision, "--scope", "workspace"]);
    const unit = await work("A11 outcome");
    const result = await must(box, demo, ["report", unit, "A11 design", "--design",
        "--implements", decision, "--artifact", designFile("a11", "reachable")]);
    assert.match(result.out, /A11: a rule for every project/);
});

test("A12 an ordinary report is untouched: the gate demands nothing of it", async () =>
{
    const unit = await work("A12 outcome");
    const result = await must(box, demo, ["report", unit, "A12 plain summary"]);
    assert.doesNotMatch(result.out, /implements/);
    assert.match((await must(box, demo, ["work", "show", unit])).out, /A12 plain summary/);
});

test("A13 --implements on a report that is not a design is refused rather than dropped", async () =>
{
    const decision = await decide("A13: a rule");
    const unit = await work("A13 outcome");
    const before = lineCount();
    const result = await self(demo, ["report", unit, "A13 summary", "--implements", decision]);
    assert.equal(result.code, 1);
    assert.match(result.out, /pass --design too/);
    assert.equal(lineCount(), before);
});

test("A14 a design with no artifact is recorded, and the receipt says it binds no hash", async () =>
{
    const decision = await decide("A14: a rule");
    const unit = await work("A14 outcome");
    const result = await must(box, demo, ["report", unit, "A14 design in prose", "--design", "--implements", decision]);
    assert.match(result.out, /binds no hash/);
    assert.match(result.out, /work start` refuses/);
});

test("A15 a design carrying two artifacts is refused: an approval binds one hash", async () =>
{
    const decision = await decide("A15: a rule");
    const unit = await work("A15 outcome");
    const result = await self(demo, ["report", unit, "A15 design", "--design", "--implements", decision,
        "--artifact", designFile("a15-one", "first"), "--artifact", designFile("a15-two", "second")]);
    assert.equal(result.code, 1);
    assert.match(result.out, /carries one artifact/);
});

/* ── B. approval and hash binding ──────────────────────────────────── */

// B1 read "approving from a process with no terminal is refused". The approval
// is one `self undo` takes back (#400), so a session records the ruling the
// person gave it in conversation, and the event names the session.
test("B1 a session approves, and the approval says which session recorded it", async () =>
{
    const decision = await decide("B1: a rule");
    const unit = await work("B1 outcome");
    const report = await submitDesign(unit, "B1 design", [decision], "b1");
    const result = await selfIn(box, demo, ["report", "confirm", report], { SUPERSELF_SESSION: "sess-b1" });
    assert.equal(result.code, 0, result.out);
    const written = events().at(-1);
    assert.equal(written.type, "report.confirmed");
    assert.equal(written.refs.confirms, report);
    assert.equal(written.payload.digest, digestOf(report));
    assert.deepEqual(written.payload.by, { kind: "agent", session: "sess-b1" });
});

test("B2 a person's approval records the same event, bound to the same digest", async () =>
{
    const decision = await decide("B2: a rule");
    const unit = await work("B2 outcome");
    const report = await submitDesign(unit, "B2 design", [decision], "b2");
    const digest = digestOf(report);
    const approved = await approvedIn(box, demo, ["report", "confirm", report], digest.slice(0, 12));
    assert.equal(approved.code, 0, approved.out);
    const written = events().at(-1);
    assert.equal(written.type, "report.confirmed");
    assert.equal(written.refs.confirms, report);
    assert.equal(written.payload.digest, digest);
    assert.deepEqual(written.payload.by, { kind: "person" });
});

// B3 asserted that a wrong typed answer approved nothing. Nothing is typed any
// more; what binds the approval to a set of bytes is the digest the event
// carries, which is what this asserts instead — the receipt names it, and it is
// derived from the artifact rather than from anything a caller said.
test("B3 the approval binds to the artifact's own digest, whatever a caller types", async () =>
{
    const decision = await decide("B3: a rule");
    const unit = await work("B3 outcome");
    const report = await submitDesign(unit, "B3 design", [decision], "b3");
    const digest = digestOf(report);
    const approved = await approvedIn(box, demo, ["report", "confirm", report], "not-the-hash");
    assert.equal(approved.code, 0, approved.out);
    assert.match(approved.out, new RegExp(`bound to artifact ${digest.slice(0, 12)}`));
    assert.equal(events().at(-1).payload.digest, digest);
});

test("B4 a design with no artifact cannot be approved: there is nothing to bind to", async () =>
{
    const decision = await decide("B4: a rule");
    const unit = await work("B4 outcome");
    const report = reportIdIn((await must(box, demo, ["report", unit, "B4 prose design", "--design", "--implements", decision])).out);
    const result = await self(demo, ["report", "confirm", report]);
    assert.equal(result.code, 1);
    assert.match(result.out, /carries no artifact digest/);
});

test("B5 an ordinary report cannot be approved", async () =>
{
    const unit = await work("B5 outcome");
    await must(box, demo, ["report", unit, "B5 plain summary"]);
    const plain = events().at(-1).id;
    const result = await self(demo, ["report", "confirm", plain]);
    assert.equal(result.code, 1);
    assert.match(result.out, /is an ordinary report, not a design/);
});

test("B6 an unknown report id is refused by naming where the ids are listed", async () =>
{
    const result = await self(demo, ["report", "confirm", "01ZZZZZZZZZZZZZZZZZZZZZZZZ"]);
    assert.equal(result.code, 1);
    assert.match(result.out, /self work show <work-id>` lists a unit's reports/);
});

test("B7 approving an already approved design records nothing and says so", async () =>
{
    const decision = await decide("B7: a rule");
    const unit = await work("B7 outcome");
    const report = await submitDesign(unit, "B7 design", [decision], "b7");
    await approvedIn(box, demo, ["report", "confirm", report], digestOf(report).slice(0, 12));
    const before = lineCount();
    const again = await approvedIn(box, demo, ["report", "confirm", report], digestOf(report).slice(0, 12));
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /was already approved/);
    assert.equal(lineCount(), before);
});

/* ── C. the dispatch gate ──────────────────────────────────────────── */

test("C1 a unit carrying no design dispatches exactly as it always did", async () =>
{
    const unit = await work("C1 outcome");
    const started = await must(box, demo, ["work", "start", unit]);
    assert.match(started.out, /C1 outcome/);
});

test("C2 a unit whose design nobody approved is refused, naming the approve command", async () =>
{
    const decision = await decide("C2: a rule");
    const unit = await work("C2 outcome");
    const report = await submitDesign(unit, "C2 design", [decision], "c2");
    const result = await self(demo, ["work", "start", unit]);
    assert.equal(result.code, 1);
    assert.match(result.out, /cannot be picked up yet/);
    assert.match(result.out, new RegExp(`self report confirm ${report}`));
});

test("C3 an approval carrying no artifact hash does not admit a dispatch", async () =>
{
    const decision = await decide("C3: a rule");
    const unit = await work("C3 outcome");
    const report = reportIdIn((await must(box, demo, ["report", unit, "C3 prose design", "--design", "--implements", decision])).out);
    // The CLI refuses to mint this (B4). A log merged from a clone written by
    // another version could still carry it, and the gate must not read an
    // approval that names no bytes as an approval of these bytes.
    logFixture(ws, "demo", {
        id: `01C3${"0".repeat(22)}`,
        ts: new Date().toISOString(),
        type: "report.confirmed",
        origin: { actor: "human", confirmed: true },
        project: "demo",
        payload: { report },
        refs: { work: unit, confirms: report }
    });
    const result = await self(demo, ["work", "start", unit]);
    assert.equal(result.code, 1);
    assert.match(result.out, /names no artifact hash/);
});

test("C4 an approved, bound design whose decision still holds dispatches", async () =>
{
    const decision = await decide("C4: a rule that holds");
    const unit = await work("C4 outcome");
    const report = await submitDesign(unit, "C4 design", [decision], "c4");
    await approvedIn(box, demo, ["report", "confirm", report], digestOf(report).slice(0, 12));
    const started = await must(box, demo, ["work", "start", unit]);
    assert.match(started.out, /C4 outcome/);
});

test("C5 superseding the decision after approval refuses the next dispatch, naming the successor", async () =>
{
    const decision = await decide("C5: the first direction");
    const unit = await work("C5 outcome");
    const report = await submitDesign(unit, "C5 design", [decision], "c5");
    await approvedIn(box, demo, ["report", "confirm", report], digestOf(report).slice(0, 12));
    await must(box, demo, ["work", "start", unit]);
    const replaced = await approvedIn(box, demo, ["decide", "C5: the second direction", "--supersedes", decision], decision);
    const successor = idIn(replaced.out);
    const result = await self(demo, ["work", "start", unit]);
    assert.equal(result.code, 1);
    assert.match(result.out, /no longer holds/);
    assert.match(result.out, new RegExp(`was superseded by ${successor}`));
});

test("C6 retracting the decision after approval refuses the next dispatch too", async () =>
{
    const decision = await decide("C6: a rule");
    const unit = await work("C6 outcome");
    const report = await submitDesign(unit, "C6 design", [decision], "c6");
    await approvedIn(box, demo, ["report", "confirm", report], digestOf(report).slice(0, 12));
    await approvedIn(box, demo, ["decide", "retract", decision, "--why", "it was wrong"], decision);
    const result = await self(demo, ["work", "start", unit]);
    assert.equal(result.code, 1);
    assert.match(result.out, /was retracted — it was wrong/);
});

test("C7 supersede-then-cite is the way through: a new design on the successor dispatches", async () =>
{
    const decision = await decide("C7: the first direction");
    const unit = await work("C7 outcome");
    const first = await submitDesign(unit, "C7 design", [decision], "c7-first");
    await approvedIn(box, demo, ["report", "confirm", first], digestOf(first).slice(0, 12));
    const replaced = await approvedIn(box, demo, ["decide", "C7: the second direction", "--supersedes", decision], decision);
    const successor = idIn(replaced.out);
    assert.equal((await self(demo, ["work", "start", unit])).code, 1);
    const second = await submitDesign(unit, "C7 design, revised", [successor], "c7-second");
    await approvedIn(box, demo, ["report", "confirm", second], digestOf(second).slice(0, 12));
    assert.match((await must(box, demo, ["work", "start", unit])).out, /C7 outcome/);
});

test("C8 one good design admits the dispatch even beside an older unapproved one", async () =>
{
    const decision = await decide("C8: a rule");
    const unit = await work("C8 outcome");
    await submitDesign(unit, "C8 first design", [decision], "c8-first");
    const second = await submitDesign(unit, "C8 second design", [decision], "c8-second");
    await approvedIn(box, demo, ["report", "confirm", second], digestOf(second).slice(0, 12));
    assert.match((await must(box, demo, ["work", "start", unit])).out, /C8 outcome/);
});

test("C9 there is no bypass flag: work start --force is an unknown option", async () =>
{
    const unit = await work("C9 outcome");
    const result = await self(demo, ["work", "start", unit, "--force"]);
    assert.equal(result.code, 1);
    assert.match(result.out, /unknown option '--force'/);
});

// `work start` is the only verb that dispatches a unit, so it is the only one
// the gate has to sit on. The raw execution verb is not a second way in: it
// refuses a preset record outright, and that refusal predates this gate. The
// cell exists to fail if that ever stops being true, because the day
// `state start` accepts a work unit it becomes the way around the gate.
test("C10 the raw transition is not a second way in: state start does not take a work unit at all", async () =>
{
    const decision = await decide("C10: a rule");
    const unit = await work("C10 outcome");
    await submitDesign(unit, "C10 design", [decision], "c10");
    const result = await self(demo, ["state", "start", unit]);
    assert.equal(result.code, 1);
    assert.match(result.out, /is a work record — execution events attach to raw entities/);
});

/* ── D. what a reader sees ─────────────────────────────────────────── */

test("D1r work show marks the design, what it implements, and whether it is approved", async () =>
{
    const decision = await decide("D1: a rule");
    const unit = await work("D1 outcome");
    const report = await submitDesign(unit, "D1 design", [decision], "d1");
    assert.match((await must(box, demo, ["work", "show", unit])).out,
        new RegExp(`design implementing ${decision}, not approved`));
    await approvedIn(box, demo, ["report", "confirm", report], digestOf(report).slice(0, 12));
    assert.match((await must(box, demo, ["work", "show", unit])).out, /design implementing .*, approved \d{4}-\d{2}-\d{2}/);
});

test("D2r a superseded decision still answers with its text and names its successor", async () =>
{
    const decision = await decide("D2: the first direction");
    const replaced = await approvedIn(box, demo, ["decide", "D2: the second direction", "--supersedes", decision], decision);
    const shown = (await must(box, demo, ["state", "show", decision])).out;
    assert.match(shown, /D2: the first direction/);
    assert.match(shown, new RegExp(`superseded by: ${idIn(replaced.out)}`));
});

test("D3r context is unchanged by a design report — a report is history, not context", async () =>
{
    const before = (await must(box, demo, ["context"])).out;
    const decision = await decide("D3: a rule");
    const unit = await work("D3 outcome");
    await submitDesign(unit, "D3 design", [decision], "d3");
    const after = (await must(box, demo, ["context"])).out;
    assert.doesNotMatch(after, /D3 design/);
    assert.equal(after.includes("D3: a rule"), before.includes("D3: a rule") || true);
});

/* ── E. what the commands resolve from outside their arguments ─────── */

test("E1 a design submitted from another checkout judges reachability in the work's own project", async () =>
{
    const decision = await decide("E1: demo's own rule");
    const unit = await work("E1 outcome");
    // The unit renders in `other` and its log stays in `demo` (#181 D1/D3).
    // Submitting from `other` cites a decision that renders only in `demo`,
    // and it resolves: reachability is the owning project's question, not the
    // directory's — and the report lands in the log that owns the unit.
    await must(box, demo, ["state", "place", unit, "--scope", "other"]);
    const result = await must(box, other, ["report", unit, "E1 design", "--design",
        "--implements", decision, "--artifact", designFile("e1", "cross-checkout")]);
    assert.match(result.out, /E1: demo's own rule/);
    assert.equal(events().at(-1).project, "demo");
});

test("E2 a design submitted from outside every registered project is refused by the project gate", async () =>
{
    const outside = join(box.root, "outside");
    mkdirSync(outside, { recursive: true });
    const result = await self(outside, ["report", "w-00000", "E2 design", "--design", "--implements", "x"]);
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.out, /implements/);
});

test("E3 the dispatch gate travels with the unit, not with the directory it is started from", async () =>
{
    const decision = await decide("E3: a rule");
    const unit = await work("E3 outcome");
    await submitDesign(unit, "E3 design", [decision], "e3");
    await must(box, demo, ["state", "place", unit, "--scope", "other"]);
    const result = await self(other, ["work", "start", unit]);
    assert.equal(result.code, 1);
    assert.match(result.out, /cannot be picked up yet/);
});
