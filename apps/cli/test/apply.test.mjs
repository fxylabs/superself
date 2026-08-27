// One person's judgment over a reviewed set (#312). An agent prepares the
// gated calls a cleanup needs and hands the file over; the person reads one
// disclosure and confirms once. The proofs below are about what that costs and
// what it cannot do: nothing is written before the confirmation, nothing
// outside the file is written after it, and a file with one bad line writes
// nothing at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approvedIn, demoWorkspace, idIn, machine, must, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
const { ws, demo } = await demoWorkspace(box);

const storeDir = join(ws, ".superself");
const logPath = join(storeDir, "projects", "demo", "log.jsonl");

function events()
{
    return readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

// How many commits the store holds. A reviewed set is one state change, so it
// is one commit however many lines it covered.
function commits()
{
    return Number(execFileSync("git", ["rev-list", "--count", "HEAD"],
        { cwd: storeDir, env: box.env, encoding: "utf8" }).trim());
}

async function decided(text)
{
    return idIn((await must(box, demo, ["decide", text])).out);
}

// A plan as an agent leaves it: notes, blank lines, and the commands with the
// leading `self` a person would have typed.
function plan(name, lines)
{
    const path = join(demo, name);
    writeFileSync(path, lines.join("\n") + "\n");
    return path;
}

test("a plan of three withdrawals refuses without a terminal, discloses all three, and records nothing", async () =>
{
    const ids = [];
    for (const text of ["A1 the duplicate", "A2 the superseded scope", "A3 the spent scope"])
    {
        ids.push(await decided(text));
    }
    const path = plan("audit.txt", [
        "# what the audit found",
        "",
        `self decide retract ${ids[0]} --why "an exact duplicate of A2"`,
        `decide retract ${ids[1]} --why "superseded in practice by A3"`,
        `self decide retract ${ids[2]} --why "the scope is spent"`
    ]);
    const before = events().length;
    const refused = await selfIn(box, demo, ["apply", path]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /this takes back 3 confirmed decisions, and nothing was recorded/);
    ids.forEach((id) => assert.ok(refused.out.includes(id), `${id} was not disclosed`));
    assert.ok(refused.out.includes("A1 the duplicate"), "the record's own text was not disclosed");
    assert.ok(refused.out.includes("retracted because: the scope is spent"),
        "the reason the line carries was not disclosed");
    assert.match(refused.out, /a person runs this in their own terminal/);
    assert.ok(refused.out.includes(`self apply ${path}`), "the refusal did not name the command to hand over");
    assert.equal(events().length, before, "a refused plan wrote to the log");
});

test("one typed confirmation records every withdrawal in the file, each with its own reason", async () =>
{
    const ids = [];
    for (const text of ["B1 the duplicate", "B2 the superseded scope", "B3 the spent scope"])
    {
        ids.push(await decided(text));
    }
    const path = plan("approved.txt", ids.map((id, at) => `decide retract ${id} --why "reason ${at + 1}"`));
    const applied = await approvedIn(box, demo, ["apply", path], "retract 3");
    assert.equal(applied.code, 0, applied.out);
    assert.match(applied.printed, /3 records retired on one confirmation/);
    for (const [at, id] of ids.entries())
    {
        const written = events().find((event) => event.type === "entity.retracted" && event.payload.entity === id);
        assert.ok(written !== undefined, `${id} was not retracted`);
        assert.equal(written.payload.why, `reason ${at + 1}`);
        assert.equal(written.payload.confirmation.method, "tty");
        assert.equal(written.payload.confirmation.challenge, "retract 3");
    }
    assert.doesNotMatch((await must(box, demo, ["context"])).out, /B1 the duplicate/);
});

test("a wrong answer at the terminal records nothing from the plan", async () =>
{
    const ids = [];
    for (const text of ["C1 a live decision", "C2 another live decision"])
    {
        ids.push(await decided(text));
    }
    const path = plan("wrong.txt", ids.map((id) => `decide retract ${id} --why "not this time"`));
    const before = events().length;
    const wrong = await approvedIn(box, demo, ["apply", path], "yes");
    assert.equal(wrong.code, 1);
    assert.equal(events().length, before, "a refused confirmation still wrote to the log");
    for (const id of ids)
    {
        assert.match((await must(box, demo, ["state", "show", id])).out, /confirmed/);
    }
});

test("two ids are short enough to type back, so the challenge is still the ids themselves", async () =>
{
    const ids = [];
    for (const text of ["D1 the duplicate", "D2 the other duplicate"])
    {
        ids.push(await decided(text));
    }
    const path = plan("pair.txt", ids.map((id) => `decide retract ${id} --why "one of a pair"`));
    const applied = await approvedIn(box, demo, ["apply", path], ids.join(" "));
    assert.equal(applied.code, 0, applied.out);
    assert.match(applied.printed, /2 records retired on one confirmation/);
});

test("a line that records rather than destroys refuses the whole plan, with nothing written", async () =>
{
    const live = await decided("E1 a decision the plan leaves alone");
    const path = plan("mixed.txt", [
        `decide retract ${live} --why "this one is spent"`,
        'decide "a rule the plan would slip in"'
    ]);
    const before = events().length;
    const refused = await selfIn(box, demo, ["apply", path]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /line 2 was refused, and nothing in this file was recorded/);
    assert.match(refused.out, /records something rather than destroying a record/);
    assert.equal(events().length, before);
    assert.match((await must(box, demo, ["state", "show", live])).out, /confirmed/);
});

test("a plan the store's own verb refuses names the line, and the earlier lines are not written", async () =>
{
    const live = await decided("F1 a decision that stays");
    const path = plan("stale.txt", [
        `decide retract ${live} --why "the first line is fine"`,
        'decide retract 01zzzzzzzzzzzzzzzzzzzzzzzz --why "no such decision"'
    ]);
    const before = events().length;
    const refused = await selfIn(box, demo, ["apply", path]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /line 2 was refused/);
    assert.equal(events().length, before);
});

test("a plan naming one record twice is refused before anybody is asked", async () =>
{
    const live = await decided("G1 a decision named twice");
    const path = plan("repeat.txt", [
        `decide retract ${live} --why "first"`,
        `decide retract ${live} --why "second"`
    ]);
    const refused = await selfIn(box, demo, ["apply", path]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /is named twice, and one confirmation covers each record once/);
});

test("a plan mixing record kinds says how many records, not how many decisions", async () =>
{
    const decision = await decided("H1 a decision that goes");
    const unit = (await must(box, demo, ["work", "add", "H2 an outcome that is given up"])).out.match(/\bw-[0-9a-z]{5}\b/)[0];
    const path = plan("mixed-kinds.txt", [
        `decide retract ${decision} --why "spent"`,
        `work retire ${unit} --why "the outcome moved"`
    ]);
    const refused = await selfIn(box, demo, ["apply", path]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /this retires 2 confirmed records/);
});

test("a line no command dispatches, an unreadable file, and an empty plan are each named", async () =>
{
    const unknown = await selfIn(box, demo, ["apply", plan("unknown.txt", ["nope whatever"])]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.out, /line 1 was refused/);
    assert.match(unknown.out, /`self nope` is not a verb a plan runs/);

    const missing = await selfIn(box, demo, ["apply", join(demo, "not-written-yet.txt")]);
    assert.equal(missing.code, 1);
    assert.match(missing.out, /no plan to read at/);

    const empty = await selfIn(box, demo, ["apply", plan("notes.txt", ["# nothing but a note", ""])]);
    assert.equal(empty.code, 1);
    assert.match(empty.out, /names no command/);
});

test("a reason carrying spaces and quotes survives the plan file verbatim", async () =>
{
    const live = await decided("I1 a decision with a quoted reason");
    const why = 'the "duplicate" of I0, agreed on 2026-08-16';
    const path = plan("quoted.txt", [`decide retract ${live} --why "the \\"duplicate\\" of I0, agreed on 2026-08-16"`]);
    const applied = await approvedIn(box, demo, ["apply", path], live);
    assert.equal(applied.code, 0, applied.out);
    const written = events().find((event) => event.type === "entity.retracted" && event.payload.entity === live);
    assert.equal(written.payload.why, why);
});

test("an unclosed quote is refused by naming the line it opened on", async () =>
{
    const path = plan("unclosed.txt", ['decide retract 01zzz --why "never closed']);
    const refused = await selfIn(box, demo, ["apply", path]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /line 1: the " quote is never closed/);
});

test("a line that only reads is refused, so nothing rides along inside a reviewed set", async () =>
{
    const live = await decided("K1 a decision the plan retires");
    const path = plan("reader.txt", ["self context", `decide retract ${live} --why "spent"`]);
    const refused = await selfIn(box, demo, ["apply", path]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /line 1 was refused/);
    assert.match(refused.out, /destroys no record/);
});

// An alias verb's `add --supersedes <id>` retires a record like any other, so
// a plan that dedupes alias-recorded notes has to reach it.
test("an alias verb's supersession is a line a plan runs", async () =>
{
    await must(box, demo, ["alias", "add", "note", "--exposure", "search"]);
    const first = (await must(box, demo, ["note", "add", "M1 the note that is replaced"])).out.match(/\be-[0-9a-z]{5}\b/);
    assert.ok(first !== null, "the alias verb recorded no entity id");
    const path = plan("alias.txt", [`note add "M2 the note that replaces it" --supersedes ${first[0]}`]);
    const refused = await selfIn(box, demo, ["apply", path]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /this retires a confirmed note/);
    assert.ok(refused.out.includes(first[0]), "the alias line's target was not disclosed");
});

test("a plan cannot apply another plan", async () =>
{
    const live = await decided("L1 a decision behind a nested plan");
    const inner = plan("inner.txt", [`decide retract ${live} --why "spent"`]);
    const refused = await selfIn(box, demo, ["apply", plan("outer.txt", [`apply ${inner}`])]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /a reviewed set cannot open another one/);
    assert.match((await must(box, demo, ["state", "show", live])).out, /confirmed/);
});

// The hold the collection puts on the append gate is process-wide, so the
// proof has to be in-process: a child would get a fresh module and pass
// whether or not the hold was ever released.
test("a refused plan leaves the next command in the same process able to write", async () =>
{
    const refused = await approvedIn(box, demo, ["apply", plan("bad.txt", ['decide "not a withdrawal"'])], "x");
    assert.equal(refused.code, 1);
    const after = await approvedIn(box, demo, ["decide", "J1 a decision recorded after a refused plan"], "x");
    assert.equal(after.code, 0, after.out);
    assert.ok(events().some((event) => String(event.payload.text ?? "").startsWith("J1 ")));
});

/* ── the set is one write, not one per line ────────────────────────── */

// The refusals above all happen before the confirmation. This is the other
// half: a line that only the writer can refuse — a reason holding an absolute
// path under this machine's home, which the sanitizer refuses — arriving after
// the person already said yes. Writing line by line destroyed the records above
// it and then exited saying nothing had been recorded.
test("a line the writer refuses after the confirmation leaves every earlier line unwritten", async () =>
{
    const ids = [];
    for (const text of ["N1 the first record", "N2 the second record"])
    {
        ids.push(await decided(text));
    }
    const path = plan("sanitize.txt", [
        `decide retract ${ids[0]} --why "the scope is spent"`,
        `decide retract ${ids[1]} --why "written up in ${box.env.HOME}/notes.md"`
    ]);
    const before = events().length;
    const commitsBefore = commits();
    const refused = await approvedIn(box, demo, ["apply", path], ids.join(" "));
    assert.equal(refused.code, 1);
    assert.match(refused.printed, /absolute path under this machine's home directory/);
    assert.equal(events().length, before, "a refused set still wrote to the log");
    assert.equal(commits(), commitsBefore, "a refused set still committed");
    for (const id of ids)
    {
        assert.match((await must(box, demo, ["state", "show", id])).out, /confirmed/);
    }
});

test("a set that is approved lands as one append and one commit", async () =>
{
    const ids = [];
    for (const text of ["O1 one", "O2 two", "O3 three"])
    {
        ids.push(await decided(text));
    }
    const path = plan("onewrite.txt", ids.map((id) => `decide retract ${id} --why "spent"`));
    const before = events().length;
    const commitsBefore = commits();
    const applied = await approvedIn(box, demo, ["apply", path], "retract 3");
    assert.equal(applied.code, 0, applied.out);
    assert.equal(events().length, before + 3);
    assert.equal(commits(), commitsBefore + 1, "a reviewed set is one state change and so one commit");
    assert.match(execFileSync("git", ["log", "-1", "--format=%s"],
        { cwd: storeDir, env: box.env, encoding: "utf8" }), /^entity\.retracted demo: 3 records retired/);
});

// The archive refusal also lives on the write, so it is the same shape: the
// person confirms, and the set is refused whole rather than half-applied.
test("a set whose project was archived after the plan was written records nothing", async () =>
{
    const ids = [];
    for (const text of ["P1 one", "P2 two"])
    {
        ids.push(await decided(text));
    }
    const path = plan("archived.txt", ids.map((id) => `decide retract ${id} --why "spent"`));
    await must(box, ws, ["project", "archive", "demo", "--why", "set aside while the plan sat"]);
    const before = events().length;
    const refused = await approvedIn(box, demo, ["apply", path], ids.join(" "));
    assert.equal(refused.code, 1);
    assert.match(refused.printed, /is archived, so nothing more is recorded into it/);
    assert.equal(events().length, before);
    await must(box, ws, ["project", "restore", "demo", "--why", "back to work"]);
    for (const id of ids)
    {
        assert.match((await must(box, demo, ["state", "show", id])).out, /confirmed/);
    }
});

/* ── nothing outside the reviewed set runs at all ──────────────────── */

// Holding the event log shut is not enough on its own: `remote add` rewrites
// the store's git remote and `theme` rewrites the store config, and neither
// touches the log. Resolving those lines and refusing the file afterwards left
// the change made and the refusal claiming nothing had been recorded.
test("a line that changes something other than a record is refused before it runs", async () =>
{
    const live = await decided("Q1 a decision the plan retires");
    const gitConfig = join(storeDir, ".git", "config");
    const storeConfig = join(storeDir, "config.json");
    const remoteBefore = readFileSync(gitConfig, "utf8");
    const themeBefore = readFileSync(storeConfig, "utf8");

    const remote = await selfIn(box, demo, ["apply", plan("remote.txt", [
        `decide retract ${live} --why "spent"`,
        "remote add https://example.invalid/store.git"
    ])]);
    assert.equal(remote.code, 1);
    assert.match(remote.out, /line 2 was refused, and nothing in this file was recorded/);
    assert.match(remote.out, /`self remote add` destroys no record/);
    assert.equal(readFileSync(gitConfig, "utf8"), remoteBefore, "the plan rewrote the store's git remote");

    const theme = await selfIn(box, demo, ["apply", plan("theme.txt", [
        `decide retract ${live} --why "spent"`,
        "theme cyan"
    ])]);
    assert.equal(theme.code, 1);
    assert.match(theme.out, /`self theme` destroys no record/);
    assert.equal(readFileSync(storeConfig, "utf8"), themeBefore, "the plan rewrote the store config");
    assert.match((await must(box, demo, ["state", "show", live])).out, /confirmed/);
});

/* ── what a supersession is asking to write ────────────────────────── */

// A supersession gives no `--why`: its successor's text is the reason. So the
// disclosure has to state that text, or one answer writes agent-authored
// records the person never read.
test("a supersession discloses the record it would write, not only the one it retires", async () =>
{
    const rule = idIn((await must(box, demo, ["convention", "add", "R1 the rule as first written"])).out);
    const decision = await decided("R2 the decision as first taken");
    await must(box, demo, ["alias", "add", "memo", "--exposure", "search"]);
    const memo = (await must(box, demo, ["memo", "add", "R3 the memo as first written"])).out.match(/\be-[0-9a-z]{5}\b/)[0];
    const refused = await selfIn(box, demo, ["apply", plan("successors.txt", [
        `convention add "R1 the rule as it now reads" --supersedes ${rule}`,
        `decide "R2 the decision as it now stands" --supersedes ${decision}`,
        `memo add "R3 the memo as it now reads" --supersedes ${memo}`
    ])]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /replaced by this new convention: R1 the rule as it now reads/);
    assert.match(refused.out, /replaced by this new decision: R2 the decision as it now stands/);
    assert.match(refused.out, /replaced by this new memo: R3 the memo as it now reads/);
});

// `${ACTION[kind]}ed` spelled this "retireed" on every verb that gives up an
// outcome rather than taking a statement back.
test("a retirement's reason is spelled retired, in a plan and in a single command", async () =>
{
    const unit = workIdIn((await must(box, demo, ["work", "add", "S1 an outcome that moved"])).out);
    const single = await selfIn(box, demo, ["work", "retire", unit, "--why", "the outcome moved to another unit"]);
    assert.equal(single.code, 1);
    assert.match(single.out, /retired because: the outcome moved to another unit/);
    assert.doesNotMatch(single.out, /retireed/);
    const inPlan = await selfIn(box, demo, ["apply",
        plan("retire.txt", [`work retire ${unit} --why "the outcome moved to another unit"`])]);
    assert.equal(inPlan.code, 1);
    assert.match(inPlan.out, /retired because: the outcome moved to another unit/);
    assert.doesNotMatch(inPlan.out, /retireed/);
});
