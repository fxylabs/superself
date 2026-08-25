// `self search` answers over live records, not the log (#212, w-rnvx5).
//
// Every test below is one cell of the case table in the 2026-08-05 comment on
// issue #212, named by its cell id, and asserts that cell's stated outcome.
// The rulings the table stands on:
//
//   R1  the default answer is every live record the current context render
//       does not show — the search tier, plus the index and full records the
//       context budget cut; --exposure names a tier, --all covers every live
//       record, and no flag reaches a dead one
//   R2  --type filters by record kind; an event-type spelling is refused
//   R3  per-entity history is `show <id> --history [--page n]` on the existing
//       `state show` and `work show` — no new verb
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approvedIn, git, idIn, machine, must, selfIn, workIdIn } from "./harness.mjs";

/* ── scratch machines ──────────────────────────────────────────────── */

function workspace(slugs)
{
    const box = machine();
    const ws = join(box.root, "ws");
    mkdirSync(ws, { recursive: true });
    must(box, ws, ["init"]);
    const dirs = {};
    for (const slug of slugs)
    {
        const dir = join(ws, slug);
        mkdirSync(dir, { recursive: true });
        git(box, dir, ["init", "-q", "-b", "main"]);
        must(box, dir, ["project", "init", "--name", slug, "--no-connect"]);
        dirs[slug] = dir;
    }
    return { box, ws, ...dirs };
}

// One token per character, and retention caps far above anything below, so the
// only budget these tests exercise is the context render's own (#213).
function openCaps(ws)
{
    const file = join(ws, ".superself", "config.json");
    const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    writeFileSync(file, JSON.stringify({
        ...config,
        tokensPerCharacter: 1,
        tokensMeasured: true,
        fullTokens: 1_000_000,
        indexTokens: 1_000_000
    }) + "\n");
}

// A raw entity prints its own short id; a preset record is named by the event
// that asserted it, which arrives inside [brackets] on the confirmation line.
function entityIn(text)
{
    const short = text.match(/\b[eomw]-[0-9a-z]{5}\b/);
    if (short !== null)
    {
        return short[0];
    }
    const event = text.match(/\[([^\]]+)\]/);
    assert.ok(event !== null, `no entity id in: ${text}`);
    return event[1];
}

// The rows of an answer. The size line the render gate states under every
// listing (#294) is not one of them: this file is about which records answered
// a query, and how many there are is the subject of stage 3's own cell 10.
function lines(text)
{
    return text.split("\n").filter((line) => line.trim() !== "" && !/^\d+ match(es)?$/.test(line));
}

/* ── the population T1–T4 and T7 read ──────────────────────────────── */

// Two projects, because R1's membership is "what context showed": `roomy`
// renders everything it holds, and `narrow` holds one record so long that the
// budget empties its whole body — so both sides of every lifecycle × exposure
// cell exist in one workspace, and one `self search` sees them all.
const a = workspace(["roomy", "narrow"]);
openCaps(a.ws);

const t11 = entityIn(must(a.box, a.roomy, ["state", "add", "T1-1 the record only search answers for", "--exposure", "search"]).out);
const t13 = entityIn(must(a.box, a.roomy, ["state", "add", "T1-3 the index record context renders", "--exposure", "index", "--priority", "10"]).out);
const t15 = entityIn(must(a.box, a.roomy, ["state", "add", "T1-5 the full record context renders", "--exposure", "full", "--priority", "0"]).out);

const t12 = entityIn(must(a.box, a.narrow, ["state", "add", "T1-2 the index record the budget cut", "--exposure", "index", "--priority", "10"]).out);
const t16 = entityIn(must(a.box, a.narrow, ["state", "add", "T1-6 the proposal waiting on a person", "--proposed"]).out);

const searchIn = (dir, args) => selfIn(a.box, dir, ["search", ...args]);
const found = (dir, args) => must(a.box, dir, ["search", ...args]).out;

// The lifecycle half of T1: one record per terminal state, each recorded and
// then taken out of the current set the way its own verb spells it.
const t17 = idIn(must(a.box, a.narrow, ["decide", "T1-7 the earlier ruling"]).out);
const t111 = idIn((await approvedIn(a.box, a.narrow, ["decide", "T1-11 the later ruling", "--supersedes", t17], t17)).printed);
const t18 = workIdIn(must(a.box, a.narrow, ["work", "add", "T1-8 the outcome given up"]).out);
await approvedIn(a.box, a.narrow, ["work", "retire", t18, "--why", "the outcome moved"], t18);
const t19 = entityIn(must(a.box, a.narrow, ["state", "add", "T1-9 the note taken back"]).out);
await approvedIn(a.box, a.narrow, ["state", "retract", t19, "--why", "it never held"], t19);
const t110 = workIdIn(must(a.box, a.narrow, ["work", "add", "T1-10 the outcome reached"]).out);
must(a.box, a.narrow, ["work", "done", t110, "--report", "T1-10 the proof passed on this branch"]);
const t112 = entityIn(must(a.box, a.narrow, ["state", "add", "T1-12 the wording that was wrong"]).out);
await approvedIn(a.box, a.narrow, ["state", "retract", t112, "--why", "reworded"], t112);
must(a.box, a.narrow, ["state", "add", "T1-12 the wording that holds"]);

// T2: where a query is found.
const t22 = entityIn(must(a.box, a.narrow, ["state", "add", "T2-2 the placed note", "--why", "T2-2 because the loader retries"]).out);
const t23 = entityIn(must(a.box, a.narrow, ["state", "add", "T2-3 the record named by its id"]).out);
must(a.box, a.narrow, ["state", "add", `T2-3 another record mentioning ${t23}`]);
const t25 = entityIn(must(a.box, a.narrow, ["state", "add", "T2-5 the labelled note", "--label", "t2five"]).out);
const t27 = workIdIn(must(a.box, a.narrow, ["work", "add", "T2-7 the unit carrying a report"]).out);
must(a.box, a.narrow, ["report", t27, "T2-7 the loader now retries on 429"]);
const t28 = workIdIn(must(a.box, a.narrow, ["work", "add", "T2-8 the outcome still wanted"]).out);
const t28retired = await approvedIn(a.box, a.narrow, ["work", "retire", t28, "--why", "T2-8 gave up on the ledger"], t28);
must(a.box, a.narrow, ["undo", idIn(t28retired.printed), "--why", "the outcome is still wanted"]);

// T3: one record of every kind.
const t31 = idIn(must(a.box, a.narrow, ["decide", "T3-1 the ruling that holds"]).out);
const t32 = idIn(must(a.box, a.narrow, ["convention", "add", "T3-2 the rule that holds"]).out);
const t33 = entityIn(must(a.box, a.narrow, ["objective", "add", "T3-3 the outcome of this quarter"]).out);
const t34 = entityIn(must(a.box, a.narrow, ["milestone", "add", "T3-4 the checkpoint", "--objective", t33, "--exit", "the proof passes"]).out);
const t35 = idIn(must(a.box, a.narrow, ["goal", "add", "T3-5 the standing direction"]).out);
const t36 = entityIn(must(a.box, a.narrow, ["state", "add", "T3-6 the free note", "--label", "note"]).out);
const t37 = workIdIn(must(a.box, a.narrow, ["work", "add", "T3-7 the open outcome"]).out);
const t38 = workIdIn(must(a.box, a.narrow, ["work", "add", "T3-8 the outcome waiting on something"]).out);
must(a.box, a.narrow, ["work", "start", t38]);
must(a.box, a.narrow, ["work", "block", t38, "--on", "dependency", "--why", "the upstream fix"]);
const t311 = workIdIn(must(a.box, a.narrow, ["work", "add", "T3-11 the unit carrying an artifact"]).out);
writeFileSync(join(a.narrow, "t3-11-evidence.txt"), "T3-11 artifact bytes\n");
must(a.box, a.narrow, ["report", t311, "T3-11 evidence attached", "--artifact", join(a.narrow, "t3-11-evidence.txt")]);
// T4: shape.
const t43 = ["one", "two", "three"].map((word) =>
    entityIn(must(a.box, a.narrow, ["state", "add", `T4-3 the ${word} matching record`]).out));
const t47 = entityIn(must(a.box, a.narrow, ["state", "add", "T4-7 first line\nT4-7 second line"]).out);
must(a.box, a.roomy, ["state", "add", "T4-8 the record in this project", "--exposure", "search"]);
must(a.box, a.narrow, ["state", "add", "T4-8 the record in that project"]);

// Recorded last, and deliberately enormous: it is the newest full-exposure
// record at priority 0, so it heads the block the budget spends first and its
// own length empties the whole body — which makes every record in `narrow` a
// record the render does not show, the state R1's default answers over.
const t14 = entityIn(must(a.box, a.narrow,
    ["state", "add", "T1-4 the full record the budget cut. " + "filler text. ".repeat(400), "--exposure", "full", "--priority", "0"]).out);

/* ── T1 — default answer membership: lifecycle × exposure ──────────── */

test("T1.1: a live record at search exposure is in the default answer", () =>
{
    assert.match(found(a.roomy, ["T1-1 the record only search"]), new RegExp(t11));
});

test("T1.2: a live index record the budget cut is in the default answer", () =>
{
    assert.ok(!must(a.box, a.narrow, ["context"]).out.includes("T1-2 the index record"),
        "the narrow project's context still rendered its index rows");
    assert.match(found(a.narrow, ["T1-2 the index record"]), new RegExp(t12));
});

test("T1.3: a live index record context renders is absent from the default", () =>
{
    assert.ok(must(a.box, a.roomy, ["context"]).out.includes("T1-3 the index record context renders"));
    assert.equal(found(a.roomy, ["T1-3 the index record"]).trim(), "no matches");
});

test("T1.4: a live full record the budget cut is in the default answer", () =>
{
    assert.ok(!must(a.box, a.narrow, ["context"]).out.includes("filler text."),
        "the oversize full record still reached the context body");
    assert.match(found(a.narrow, ["T1-4 the full record"]), new RegExp(t14));
});

test("T1.5: a live full record context renders is absent from the default", () =>
{
    assert.ok(must(a.box, a.roomy, ["context"]).out.includes("T1-5 the full record context renders"));
    assert.equal(found(a.roomy, ["T1-5 the full record"]).trim(), "no matches");
});

test("T1.6: a live proposal is in the answer, marked proposed", () =>
{
    const row = found(a.narrow, ["T1-6 the proposal"]).trim();
    assert.match(row, new RegExp(t16));
    assert.match(row, /\(proposed\)/);
});

test("T1.7: a superseded record is absent", () =>
{
    assert.equal(found(a.narrow, ["T1-7 the earlier ruling"]).trim(), "no matches");
});

test("T1.8: a retired record is absent", () =>
{
    assert.equal(found(a.narrow, ["T1-8 the outcome given up"]).trim(), "no matches");
});

test("T1.9: a retracted record is absent", () =>
{
    assert.equal(found(a.narrow, ["T1-9 the note taken back"]).trim(), "no matches");
});

test("T1.10: a done work unit is absent", () =>
{
    assert.equal(found(a.narrow, ["T1-10 the outcome reached"]).trim(), "no matches");
});

test("T1.11: the superseded record is absent and its successor answers on its own text", () =>
{
    assert.equal(found(a.narrow, [t17]).trim(), "no matches");
    assert.match(found(a.narrow, ["T1-11 the later ruling"]), new RegExp(t111));
});

test("T1.12: text that lives only in a retracted earlier version finds nothing", () =>
{
    assert.equal(found(a.narrow, ["T1-12 the wording that was wrong"]).trim(), "no matches");
    assert.match(found(a.narrow, ["T1-12 the wording that holds"]), /T1-12 the wording that holds/);
});

/* ── T2 — where the match is found ─────────────────────────────────── */

test("T2.1: the record's text is a hit", () =>
{
    assert.match(found(a.narrow, ["T2-3 the record named by its id"]), new RegExp(t23));
});

test("T2.2: the record's --why is a hit, and the row shows why it matched", () =>
{
    const row = found(a.narrow, ["because the loader retries"]).trim();
    assert.match(row, new RegExp(t22));
    assert.match(row, /T2-2 because the loader retries/);
});

test("T2.3: the record's id spelled in full answers with that record alone", () =>
{
    const rows = lines(found(a.narrow, [t23]));
    assert.equal(rows.length, 1, `an exact id answered with more than one record:\n${rows.join("\n")}`);
    assert.match(rows[0], new RegExp(`${t23}\\b`));
    assert.doesNotMatch(rows[0], /another record mentioning/);
});

test("T2.4: the record's id as a prefix is a hit", () =>
{
    assert.match(found(a.narrow, [t23.slice(0, 5)]), new RegExp(t23));
});

test("T2.5: a label on the record is a hit", () =>
{
    assert.match(found(a.narrow, ["t2five"]), new RegExp(t25));
});

test("T2.6: matching stays case-insensitive", () =>
{
    assert.match(found(a.narrow, ["t2-3 THE Record NAMED by ITS id"]), new RegExp(t23));
});

test("T2.7: text present only in a report resolves to its work unit", () =>
{
    const rows = lines(found(a.narrow, ["the loader now retries on 429"]));
    assert.equal(rows.length, 1);
    assert.match(rows[0], new RegExp(t27));
});

test("T2.8: text present only in a dead event of a live record is not a hit", () =>
{
    assert.match(found(a.narrow, ["T2-8 the outcome still wanted"]), new RegExp(t28));
    assert.equal(found(a.narrow, ["gave up on the ledger"]).trim(), "no matches");
});

test("T2.9: the query may be omitted when --type narrows the pull", () =>
{
    const out = found(a.narrow, ["--type", "convention"]);
    assert.match(out, /T3-2 the rule that holds/);
    assert.doesNotMatch(out, /T3-1 the ruling that holds/);
});

test("T2.10: the query omitted with no other flag is refused, naming what narrows it", () =>
{
    const refused = searchIn(a.narrow, []);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--type/);
    assert.match(refused.out, /--exposure/);
    assert.match(refused.out, /--all/);
    assert.match(refused.out, /--project/);
});

/* ── T3 — record kinds ─────────────────────────────────────────────── */

function oneRow(query)
{
    const rows = lines(found(a.narrow, [query]));
    assert.equal(rows.length, 1, `expected one row for "${query}":\n${rows.join("\n")}`);
    return rows[0];
}

test("T3.1: a decision is searchable as one row", () =>
{
    assert.match(oneRow("T3-1 the ruling that holds"), new RegExp(`decision\\s+${t31}`));
});

test("T3.2: a convention is searchable", () =>
{
    assert.match(oneRow("T3-2 the rule that holds"), new RegExp(`convention\\s+${t32}`));
});

test("T3.3: an objective is searchable", () =>
{
    assert.match(oneRow("T3-3 the outcome of this quarter"), new RegExp(`objective\\s+${t33}`));
});

test("T3.4: a milestone is searchable", () =>
{
    assert.match(oneRow("T3-4 the checkpoint"), new RegExp(`milestone\\s+${t34}`));
});

test("T3.5: a goal is searchable", () =>
{
    assert.match(oneRow("T3-5 the standing direction"), new RegExp(`goal\\s+${t35}`));
});

test("T3.6: a raw entity is searchable", () =>
{
    assert.match(oneRow("T3-6 the free note"), new RegExp(`entity\\s+${t36}`));
});

test("T3.7: an open work unit is searchable and its status shows in the row", () =>
{
    const row = oneRow("T3-7 the open outcome");
    assert.match(row, new RegExp(`work\\s+${t37}`));
    assert.match(row, /\(open\)/);
});

test("T3.8: a blocked work unit is searchable and marked blocked", () =>
{
    const row = oneRow("T3-8 the outcome waiting on something");
    assert.match(row, new RegExp(`work\\s+${t38}`));
    assert.match(row, /\(blocked\)/);
});

test("T3.9: a done or retired work unit is absent", () =>
{
    assert.equal(found(a.narrow, ["T1-10 the outcome reached"]).trim(), "no matches");
    assert.equal(found(a.narrow, ["T1-8 the outcome given up"]).trim(), "no matches");
});

test("T3.10: a report is no row of its own; its text resolves to its work unit", () =>
{
    const row = oneRow("T2-7 the loader now retries");
    assert.match(row, new RegExp(`work\\s+${t27}`));
});

test("T3.11: an artifact is no row of its own; it resolves to the record carrying it", () =>
{
    const row = oneRow("t3-11-evidence.txt");
    assert.match(row, new RegExp(`work\\s+${t311}`));
});

/* ── T4 — output shape ─────────────────────────────────────────────── */

test("T4.1: no output line of a hit is a raw event object", () =>
{
    for (const row of lines(found(a.narrow, ["--all"])))
    {
        assert.doesNotMatch(row, /^\s*\{/, `a raw event object reached the answer: ${row}`);
        assert.doesNotMatch(row, /"type":|"payload":|"origin":/, `a raw event object reached the answer: ${row}`);
    }
});

test("T4.2: a multi-thousand-character record truncates to one row carrying its id", () =>
{
    const row = oneRow("T1-4 the full record");
    assert.match(row, new RegExp(t14));
    assert.ok(row.length < 200, `a row of ${row.length} characters is not one readable line`);
    assert.match(row, /…$/);
    assert.match(must(a.box, a.narrow, ["state", "show", t14]).out, /filler text\./);
});

test("T4.3: three hits are three rows", () =>
{
    const rows = lines(found(a.narrow, ["T4-3 the"]));
    assert.equal(rows.length, 3);
    for (const id of t43)
    {
        assert.ok(rows.some((row) => row.includes(id)), `${id} is missing from the answer`);
    }
});

test("T4.4: the matched substring is plain text when output is not styled", () =>
{
    const row = oneRow("T2-5 the labelled note");
    assert.doesNotMatch(row, /\x1b\[/, "a piped row carried an escape sequence");
    assert.ok(row.includes("T2-5 the labelled note"), "the matched substring was not printed verbatim");
});

test("T4.5: no hits answers `no matches`, and the exit status is unchanged", () =>
{
    const empty = searchIn(a.narrow, ["a phrase no record in this workspace carries"]);
    assert.equal(empty.code, 0);
    assert.equal(empty.out.trim(), "no matches");
});

test("T4.6: plain output prints one record per line and no styling", () =>
{
    const rows = lines(found(a.narrow, ["T4-3 the"]));
    assert.equal(rows.length, 3);
    for (const row of rows)
    {
        assert.doesNotMatch(row, /\x1b\[/);
    }
});

test("T4.7: a record whose text contains a newline renders on one line", () =>
{
    const row = oneRow("T4-7 first line");
    assert.match(row, new RegExp(t47));
    assert.match(row, /T4-7 first line T4-7 second line/);
});

test("T4.8: rows from more than one project each name their project", () =>
{
    const rows = lines(found(a.roomy, ["T4-8 the record in"]));
    assert.equal(rows.length, 2);
    assert.ok(rows.some((row) => row.startsWith("roomy  ")), `no roomy row in:\n${rows.join("\n")}`);
    assert.ok(rows.some((row) => row.startsWith("narrow  ")), `no narrow row in:\n${rows.join("\n")}`);
});

/* ── T7 — widening past the default ────────────────────────────────── */

test("T7.1: --exposure search reads the third tier alone, rendered or not", () =>
{
    const out = found(a.roomy, ["--exposure", "search", "--project", "roomy"]);
    assert.match(out, new RegExp(t11));
    assert.doesNotMatch(out, new RegExp(t13));
    assert.doesNotMatch(out, new RegExp(t15));
});

test("T7.2: --exposure index and --exposure full each read that tier alone", () =>
{
    const indexed = found(a.roomy, ["--exposure", "index", "--project", "roomy"]);
    assert.match(indexed, new RegExp(t13), "an index record context renders was not reachable by its tier");
    assert.doesNotMatch(indexed, new RegExp(t11));
    const full = found(a.roomy, ["--exposure", "full", "--project", "roomy"]);
    assert.match(full, new RegExp(t15));
    assert.doesNotMatch(full, new RegExp(t13));
});

test("T7.3: --all covers every live record, and dead ones stay absent", () =>
{
    const out = found(a.roomy, ["--all"]);
    assert.match(out, new RegExp(t13), "--all did not reach a record context renders");
    assert.match(out, new RegExp(t15));
    assert.match(out, new RegExp(t11));
    assert.doesNotMatch(out, new RegExp(t18), "--all reached a retired record");
    assert.doesNotMatch(out, new RegExp(t110), "--all reached a done record");
});

test("T7.4: --all with --exposure is refused as contradictory", () =>
{
    const refused = searchIn(a.roomy, ["--all", "--exposure", "full"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--all/);
    assert.match(refused.out, /--exposure/);
});

test("T7.5: --type decision narrows to decisions", () =>
{
    const out = found(a.narrow, ["--type", "decision"]);
    assert.match(out, new RegExp(t31));
    assert.doesNotMatch(out, new RegExp(t32), "a convention answered a decision query");
    assert.doesNotMatch(out, new RegExp(t37), "a work unit answered a decision query");
});

test("T7.6: --type decision.confirmed is refused, naming the kind to use", () =>
{
    const refused = searchIn(a.narrow, ["--type", "decision.confirmed"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /record kind/);
    assert.match(refused.out, /--type decision\b/);
});

test("T7.7: no widening flag reaches a dead record", () =>
{
    for (const widening of [["--all"], ["--exposure", "search"], ["--type", "work"]])
    {
        const out = found(a.narrow, ["T1-8 the outcome given up", ...widening]);
        assert.equal(out.trim(), "no matches", `${widening.join(" ")} reached a retired record`);
    }
});

/* ── T5 — scope and project ────────────────────────────────────────── */

const b = workspace(["one", "two"]);
openCaps(b.ws);
must(b.box, b.one, ["state", "add", "T5-1 the record in one", "--exposure", "search"]);
must(b.box, b.two, ["state", "add", "T5-1 the record in two", "--exposure", "search"]);
const t54 = entityIn(must(b.box, b.two, ["state", "add", "T5-4 scoped into one", "--exposure", "search", "--scope", "one"]).out);
const t55 = entityIn(must(b.box, b.one, ["state", "add", "T5-5 scoped away to two", "--exposure", "search", "--scope", "two"]).out);
const t56 = entityIn(must(b.box, b.one, ["state", "add", "T5-6 the workspace note", "--exposure", "search", "--scope", "workspace"]).out);

test("T5.1: the default answers over every registered project, the current one first", () =>
{
    const rows = lines(must(b.box, b.one, ["search", "T5-1 the record in"]).out);
    assert.equal(rows.length, 2);
    assert.ok(rows[0].startsWith("one  "), `the current project did not rank first:\n${rows.join("\n")}`);
    assert.ok(rows[1].startsWith("two  "));
});

test("T5.2: --project narrows to that project", () =>
{
    const rows = lines(must(b.box, b.one, ["search", "T5-1 the record in", "--project", "two"]).out);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].startsWith("two  "));
});

test("T5.3: an unregistered slug is refused, naming how to list the registered ones", () =>
{
    const refused = selfIn(b.box, b.one, ["search", "T5-1", "--project", "nowhere"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /unknown project "nowhere"/);
    assert.match(refused.out, /self project/);
});

test("T5.4: a record scoped into this project names the project whose log holds it", () =>
{
    const row = lines(must(b.box, b.one, ["search", "T5-4 scoped into one"]).out)[0];
    assert.ok(row.startsWith("two  "), `the row did not name the log that holds it: ${row}`);
    assert.match(row, new RegExp(t54));
    assert.match(row, /\[renders in one\]/);
});

test("T5.5: a record scoped away from this project stays in the answer, naming its render target", () =>
{
    const row = lines(must(b.box, b.one, ["search", "T5-5 scoped away to two"]).out)[0];
    assert.ok(row.startsWith("one  "));
    assert.match(row, new RegExp(t55));
    assert.match(row, /\[renders in two\]/);
});

test("T5.6: a workspace-scoped record answers with one row, not one per project", () =>
{
    const rows = lines(must(b.box, b.one, ["search", "T5-6 the workspace note"]).out);
    assert.equal(rows.length, 1, `a workspace record answered ${rows.length} times`);
    assert.match(rows[0], new RegExp(t56));
    assert.match(rows[0], /\[renders in every project\]/);
});

test("T5.7: run outside any registered project, search answers over every project", () =>
{
    const outside = selfIn(b.box, b.ws, ["search", "T5-1 the record in"]);
    assert.equal(outside.code, 0, outside.out);
    assert.equal(lines(outside.out).length, 2);
});

// Its own workspace: an unreadable log is a fact about the store, and every
// other cell in this file needs the store it reads to be readable.
const c = workspace(["sound", "broken"]);
openCaps(c.ws);
must(c.box, c.sound, ["state", "add", "T5-8 the record that still answers", "--exposure", "search"]);
must(c.box, c.broken, ["state", "add", "T5-8 the record in the unreadable project", "--exposure", "search"]);
appendFileSync(join(c.ws, ".superself", "projects", "broken", "log.jsonl"), "this line is not an event\n");

test("T5.8: a project whose state cannot be read is skipped with a note; the others still answer", () =>
{
    const out = selfIn(c.box, c.sound, ["search", "T5-8 the record"]);
    assert.equal(out.code, 0, out.out);
    assert.match(out.out, /broken: its state could not be read here/);
    assert.match(out.out, /T5-8 the record that still answers/);
    assert.doesNotMatch(out.out, /T5-8 the record in the unreadable project/);
});

/* ── T6 — per-entity history ───────────────────────────────────────── */

const d = workspace(["hist", "other"]);
openCaps(d.ws);

const h1 = entityIn(must(d.box, d.hist, ["state", "add", "T6-1 the live record"]).out);
must(d.box, d.hist, ["state", "place", h1, "--priority", "3"]);

const h2 = workIdIn(must(d.box, d.hist, ["work", "add", "T6-2 the outcome given up"]).out);
must(d.box, d.hist, ["work", "start", h2]);
await approvedIn(d.box, d.hist, ["work", "retire", h2, "--why", "the outcome moved on"], h2);

const h3 = idIn(must(d.box, d.hist, ["decide", "T6-3 the earlier ruling"]).out);
const h3next = idIn((await approvedIn(d.box, d.hist, ["decide", "T6-3 the later ruling", "--supersedes", h3], h3)).printed);

const h4 = entityIn(must(d.box, d.hist, ["state", "add", "T6-4 the much-placed record"]).out);
for (let priority = 1; priority <= 12; priority += 1)
{
    must(d.box, d.hist, ["state", "place", h4, "--priority", String(priority)]);
}

const h8 = entityIn(must(d.box, d.other, ["state", "add", "T6-8 the record in another project"]).out);

test("T6.1: --history on a live record prints its own events, oldest first, one row each", () =>
{
    const rows = lines(must(d.box, d.hist, ["state", "show", h1, "--history"]).out);
    assert.match(rows[0], new RegExp(`^${h1}  live`));
    assert.equal(rows.length, 3, `expected a head and two event rows:\n${rows.join("\n")}`);
    assert.match(rows[1], /entity\.confirmed/);
    assert.match(rows[2], /entity\.placed/);
});

test("T6.2: --history on a retired record reaches its full history", () =>
{
    const out = must(d.box, d.hist, ["work", "show", h2, "--history"]).out;
    assert.match(out, new RegExp(`^${h2}  retired`));
    assert.match(out, /entity\.confirmed/);
    assert.match(out, /entity\.started/);
    assert.match(out, /entity\.retired/);
});

test("T6.3: --history on a superseded record names the successor rather than folding it in", () =>
{
    const out = must(d.box, d.hist, ["state", "show", h3, "--history"]).out;
    assert.match(out, new RegExp(`^${h3}  superseded · superseded by ${h3next}`));
    assert.match(out, /T6-3 the earlier ruling/);
    assert.doesNotMatch(out, /T6-3 the later ruling/, "the successor's own events were folded into the predecessor's history");
});

test("T6.4: a record with more events than one page prints the first page and how to reach the next", () =>
{
    const out = must(d.box, d.hist, ["state", "show", h4, "--history"]).out;
    const rows = lines(out);
    assert.equal(rows.filter((row) => row.includes("entity.")).length, 10);
    assert.match(out, /… 3 more; run `self state show .* --history --page 2 --project/);
    const second = must(d.box, d.hist, ["state", "show", h4, "--history", "--page", "2"]).out;
    assert.equal(lines(second).filter((row) => row.includes("entity.")).length, 3);
});

test("T6.5: a page beyond the last is an empty page saying so, not an error", () =>
{
    const beyond = selfIn(d.box, d.hist, ["state", "show", h4, "--history", "--page", "9"]);
    assert.equal(beyond.code, 0, beyond.out);
    assert.match(beyond.out, /no events on page 9 — .* has 2 pages/);
});

test("T6.6: an unknown id is refused, naming search as the way to find one", () =>
{
    const entity = selfIn(d.box, d.hist, ["state", "show", "e-zzzzz", "--history"]);
    assert.notEqual(entity.code, 0);
    assert.match(entity.out, /self search/);
    const unit = selfIn(d.box, d.hist, ["work", "show", "w-zzzzz", "--history"]);
    assert.notEqual(unit.code, 0);
    assert.match(unit.out, /self search/);
});

test("T6.7: every history row is readable, never a raw event object", () =>
{
    for (const row of lines(must(d.box, d.hist, ["state", "show", h4, "--history"]).out))
    {
        assert.doesNotMatch(row, /^\s*\{/);
        assert.doesNotMatch(row, /"type":|"payload":|"origin":/);
    }
});

test("T6.8: history of a record in another project resolves with --project", () =>
{
    const out = must(d.box, d.hist, ["state", "show", h8, "--history", "--project", "other"]).out;
    assert.match(out, new RegExp(`^${h8}  live`));
    assert.match(out, /entity\.confirmed/);
});
