// One event records that a project came from another (#75, w-8vgkc).
//
// Every test below is one cell of the case table in the 2026-08-05 comment on
// issue #75, named by its cell id, and asserts that cell's stated outcome.
// The rulings the table stands on:
//
//   R1  the relation is an entity carrying the parent's slug in the reserved
//       metadata key `from`, labelled `derivation`, with the reason in --why
//   R2  the event lands in the child's log; the reverse direction is read by
//       scanning the registered projects' folds
//   R3  the verb is `self project from <parent-slug> --why "<reason>"`
//   R4  a repeat is refused, naming the existing relation; --supersedes corrects
//   R5  the relation renders at index exposure, low priority, charging the cap
//   R6  a cycle is refused, across a chain and not only a pair
//   R7  one relation per project
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approvedIn, git, machine, must, selfIn } from "./harness.mjs";

// A workspace holding the named projects, each its own git repository, so
// every assertion below reads a slug rather than a path.
function workspace(slugs)
{
    const box = machine();
    const ws = join(box.root, "ws");
    mkdirSync(ws, { recursive: true });
    must(box, ws, ["init"]);
    const dirs = {};
    for (const slug of slugs)
    {
        dirs[slug] = register(box, ws, slug);
    }
    return { box, ws, dirs };
}

function register(box, ws, slug, extra = [])
{
    const dir = join(ws, slug);
    mkdirSync(dir, { recursive: true });
    git(box, dir, ["init", "-q", "-b", "main"]);
    must(box, dir, ["project", "add", "--name", slug, "--no-connect", ...extra]);
    return dir;
}

// The relation's own record id: `project from` prints it the way `state add`
// does, because it is the id --supersedes and `state place` take.
function entityIn(text)
{
    const match = text.match(/\be-[0-9a-z]{5}\b/);
    assert.ok(match !== null, `no entity id in: ${text}`);
    return match[0];
}

// One project's answer in `self project`: its own line and the indented lines
// under it, so a test asserting what a row says cannot be satisfied by another
// project's row.
function rowOf(text, slug)
{
    const lines = text.split("\n");
    const at = lines.findIndex((line) => line === slug || line.startsWith(`${slug} `));
    assert.ok(at >= 0, `no row for "${slug}" in:\n${text}`);
    const block = [lines[at]];
    for (let index = at + 1; index < lines.length && lines[index].startsWith("    "); index += 1)
    {
        block.push(lines[index]);
    }
    return block.join("\n");
}

function registryFile(ws)
{
    return join(ws, ".superself", "registry.jsonl");
}

function unregister(ws, slug)
{
    const kept = readFileSync(registryFile(ws), "utf8").split("\n")
        .filter((line) => line.trim() !== "" && JSON.parse(line).slug !== slug);
    writeFileSync(registryFile(ws), kept.map((line) => line + "\n").join(""));
}

function setCaps(ws, caps)
{
    const file = join(ws, ".superself", "config.json");
    const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    // One token per character, so a cap below is the character count of the
    // text it gates (#213).
    writeFileSync(file, JSON.stringify({ ...config, tokensPerCharacter: 1, tokensMeasured: true, ...caps }) + "\n");
}

/* ── T1 — recording the relation ───────────────────────────────────── */

// `solo` never records one: the cells about a call that never reaches the log
// have to run where nothing was recorded before them.
const t1 = workspace(["p", "c", "solo"]);

test("T1.1: a registered parent and --why record the relation, carrying from, the label and the why", () =>
{
    const recorded = must(t1.box, t1.dirs.c, ["project", "from", "p", "--why", "the initiative outgrew p"]);
    const shown = must(t1.box, t1.dirs.c, ["state", "show", entityIn(recorded.out)]).out;
    assert.match(shown, /labels: derivation/);
    assert.match(shown, /from: p/);
    assert.match(shown, /why: the initiative outgrew p/);
});

test("T1.2: --why omitted is refused — the relation exists to carry why it was drawn", () =>
{
    const refused = selfIn(t1.box, t1.dirs.c, ["project", "from", "p"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--why/);
    assert.match(refused.out, /why this project came from that one/);
});

test("T1.3: --why \"\" is refused as empty, the same as every other --why", () =>
{
    const empty = selfIn(t1.box, t1.dirs.c, ["project", "from", "p", "--why", ""]);
    assert.notEqual(empty.code, 0);
    assert.equal(empty.out, selfIn(t1.box, t1.dirs.c, ["project", "from", "p"]).out);
});

test("T1.4: an unregistered parent slug is refused, naming self project as the way to list the slugs", () =>
{
    const refused = selfIn(t1.box, t1.dirs.c, ["project", "from", "ghost", "--why", "it did"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /unknown project "ghost"/);
    assert.match(refused.out, /self project/);
});

test("T1.5: this project's own slug is refused — a project did not come from itself", () =>
{
    const refused = selfIn(t1.box, t1.dirs.c, ["project", "from", "c", "--why", "it did"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /did not come from itself/);
});

test("T1.6: workspace is refused as the parent — it is reserved and names every project", () =>
{
    const refused = selfIn(t1.box, t1.dirs.c, ["project", "from", "workspace", "--why", "it did"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /means every registered project/);
});

test("T1.7: the parent slug omitted is refused with the usage line", () =>
{
    const refused = selfIn(t1.box, t1.dirs.c, ["project", "from", "--why", "it did"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /usage: self project from <parent-slug> --why/);
});

test("T1.8: run outside a registered project it is refused, naming where to run it", () =>
{
    const refused = selfIn(t1.box, t1.ws, ["project", "from", "p", "--why", "it did"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /not inside a registered project/);
});

test("T1.9: a --why holding a home path passes the same sanitization gate every write passes", () =>
{
    const refused = selfIn(t1.box, t1.dirs.solo, ["project", "from", "p", "--why", `it came out of ${t1.box.env.HOME}/notes.txt`]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /absolute path under this machine's home directory/);
    assert.equal(rowOf(must(t1.box, t1.dirs.solo, ["project"]).out, "solo").includes("came from"), false);
});

test("T1.10: state show renders the parent, the why, and the recorded time", () =>
{
    const shown = must(t1.box, t1.dirs.c, ["state", "show", entityIn(listedRelationOf(t1, "c"))]).out;
    assert.match(shown, /from: p/);
    assert.match(shown, /why: the initiative outgrew p/);
    assert.match(shown, /recorded: \d{4}-\d{2}-\d{2}/);
});

// The relation's id read back from the project's own records, so a cell that
// asserts what was recorded does not have to carry it from another test.
function listedRelationOf(fixture, slug)
{
    const listed = must(fixture.box, fixture.dirs[slug], ["state", "list"]).out;
    const row = listed.split("\n").find((line) => line.includes("derivation"));
    assert.ok(row !== undefined, `no derivation record listed in ${slug}:\n${listed}`);
    return row;
}

/* ── T2 — repeat, correction, withdrawal ───────────────────────────── */

const t2 = workspace(["p", "q", "c"]);
const t2First = entityIn(must(t2.box, t2.dirs.c, ["project", "from", "p", "--why", "it began inside p"]).out);

test("T2.1: the same command run twice is refused, naming the existing relation's id", () =>
{
    const refused = selfIn(t2.box, t2.dirs.c, ["project", "from", "p", "--why", "it began inside p"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`${t2First} already records that this project came from "p"`));
    assert.match(refused.out, /--supersedes/);
});

test("T2.2: a second from naming a different parent is refused, naming the existing one to supersede", () =>
{
    const refused = selfIn(t2.box, t2.dirs.c, ["project", "from", "q", "--why", "it began inside q"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`${t2First} records that this project came from "p"`));
    assert.match(refused.out, new RegExp(`--supersedes ${t2First}`));
});

let t2Second = "";

test("T2.3: --supersedes with a new parent records the correction, and the first folds to superseded", async () =>
{
    const corrected = await approvedIn(t2.box, t2.dirs.c,
        ["project", "from", "q", "--why", "p was never where it came from", "--supersedes", t2First], t2First);
    assert.equal(corrected.code, 0, corrected.out);
    t2Second = entityIn(corrected.printed);
    assert.match(must(t2.box, t2.dirs.c, ["state", "show", t2First]).out, /superseded/);
    assert.match(must(t2.box, t2.dirs.c, ["state", "show", t2Second]).out, new RegExp(`link: supersedes ${t2First}`));
    assert.match(rowOf(must(t2.box, t2.dirs.c, ["project"]).out, "c"), /came from q/);
});

let t2Third = "";

test("T2.4: --supersedes with the same parent and a corrected why records under the same lineage rule", async () =>
{
    const corrected = await approvedIn(t2.box, t2.dirs.c,
        ["project", "from", "q", "--why", "the reason was stated wrong", "--supersedes", t2Second], t2Second);
    assert.equal(corrected.code, 0, corrected.out);
    t2Third = entityIn(corrected.printed);
    assert.match(must(t2.box, t2.dirs.c, ["state", "show", t2Second]).out, /superseded/);
    assert.match(must(t2.box, t2.dirs.c, ["state", "show", t2Third]).out, /why: the reason was stated wrong/);
});

test("T2.5: state retract withdraws the relation, and it resolves from neither direction", async () =>
{
    const withdrawn = await approvedIn(t2.box, t2.dirs.c,
        ["state", "retract", t2Third, "--why", "the relation was never true"], t2Third);
    assert.equal(withdrawn.code, 0, withdrawn.out);
    const listed = must(t2.box, t2.dirs.c, ["project"]).out;
    assert.equal(rowOf(listed, "c").includes("came from"), false);
    assert.equal(rowOf(listed, "q").includes("came from it"), false);
});

test("T2.6: after a retract the relation is recorded again — nothing withdrawn blocks a fresh claim", () =>
{
    const again = must(t2.box, t2.dirs.c, ["project", "from", "p", "--why", "it did come out of p after all"]);
    assert.match(rowOf(must(t2.box, t2.dirs.c, ["project"]).out, "c"), /came from p/);
    assert.notEqual(entityIn(again.out), t2Third);
});

test("T2.7: --supersedes naming a record that is not a relation is refused", () =>
{
    const other = entityIn(must(t2.box, t2.dirs.c, ["state", "add", "T2.7 an ordinary note"]).out);
    const refused = selfIn(t2.box, t2.dirs.c, ["project", "from", "q", "--why", "it did", "--supersedes", other]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`"${other}" is not it`));
});

const t28 = workspace(["gp", "gq", "gc"]);

test("T2.8: a superseded relation is absent from both directions, and its successor answers", async () =>
{
    const first = entityIn(must(t28.box, t28.dirs.gc, ["project", "from", "gp", "--why", "it began inside gp"]).out);
    const corrected = await approvedIn(t28.box, t28.dirs.gc,
        ["project", "from", "gq", "--why", "gq is where it began", "--supersedes", first], first);
    assert.equal(corrected.code, 0, corrected.out);
    const listed = must(t28.box, t28.dirs.gc, ["project"]).out;
    assert.match(rowOf(listed, "gc"), /came from gq/);
    assert.equal(rowOf(listed, "gc").includes("came from gp"), false);
    assert.match(rowOf(listed, "gq"), /came from it: gc/);
    assert.equal(rowOf(listed, "gp").includes("came from it"), false);
});

/* ── T3 — resolution in both directions ────────────────────────────── */

const t3 = workspace(["p", "c", "d", "g", "c2"]);
must(t3.box, t3.dirs.c, ["project", "from", "p", "--why", "it began as work inside p"]);

test("T3.1: self project in the child names the parent as where it came from", () =>
{
    assert.match(rowOf(must(t3.box, t3.dirs.c, ["project"]).out, "c"), /came from p/);
});

test("T3.2: self project in the parent names the child among what came from it", () =>
{
    assert.match(rowOf(must(t3.box, t3.dirs.p, ["project"]).out, "p"), /came from it: c/);
});

test("T3.3: an unrelated project's row carries neither direction", () =>
{
    assert.equal(rowOf(must(t3.box, t3.dirs.d, ["project"]).out, "d").includes("came from"), false);
});

test("T3.4: self context in the child carries one index line naming the parent", () =>
{
    const context = must(t3.box, t3.dirs.c, ["context"]).out;
    const rows = context.split("\n").filter((line) => line.includes("[derivation]"));
    assert.equal(rows.length, 1, `expected one derivation line, got:\n${context}`);
    assert.match(rows[0], /came from p — it began as work inside p/);
});

test("T3.5: self context in the parent does not assert the reverse — the parent's log holds no event", () =>
{
    const context = must(t3.box, t3.dirs.p, ["context"]).out;
    assert.equal(context.includes("derivation"), false, context);
    assert.equal(context.includes("came from"), false, context);
});

test("T3.6: two children of one parent are both named on the parent's row", () =>
{
    must(t3.box, t3.dirs.c2, ["project", "from", "p", "--why", "it split off p too"]);
    assert.match(rowOf(must(t3.box, t3.dirs.p, ["project"]).out, "p"), /came from it: c, c2/);
});

test("T3.7: in a chain the child's row names its own parent only", () =>
{
    must(t3.box, t3.dirs.p, ["project", "from", "g", "--why", "p began inside g"]);
    const listed = must(t3.box, t3.dirs.c, ["project"]).out;
    assert.match(rowOf(listed, "c"), /came from p/);
    assert.equal(rowOf(listed, "c").includes("g"), false);
    assert.match(rowOf(listed, "p"), /came from g/);
});

test("T3.8: state show --project resolves the relation from another project", () =>
{
    const id = listedRelationOf(t3, "c").match(/\be-[0-9a-z]{5}\b/)[0];
    const shown = must(t3.box, t3.dirs.d, ["state", "show", id, "--project", "c"]).out;
    assert.match(shown, /from: p/);
});

/* ── T4 — registry changes after the relation exists ───────────────── */

const t41 = workspace(["p", "c"]);
must(t41.box, t41.dirs.c, ["project", "from", "p", "--why", "it began inside p"]);

test("T4.1: with the parent unregistered the relation renders as unresolved, and the fold does not crash", () =>
{
    unregister(t41.ws, "p");
    const listed = must(t41.box, t41.dirs.c, ["project"]);
    assert.equal(listed.code, 0);
    assert.match(rowOf(listed.out, "c"), /came from "p", which is not registered in this workspace/);
});

test("T4.3: re-registering the parent under the same slug resolves the relation again", () =>
{
    appendFileSync(registryFile(t41.ws), JSON.stringify({ slug: "p", added: new Date().toISOString() }) + "\n");
    assert.match(rowOf(must(t41.box, t41.dirs.c, ["project"]).out, "c"), /came from p$/m);
});

const t42 = workspace(["p", "c"]);
must(t42.box, t42.dirs.c, ["project", "from", "p", "--why", "it began inside p"]);

test("T4.2: with the child unregistered the parent's reverse answer drops it, and nothing else changes", () =>
{
    unregister(t42.ws, "c");
    const listed = must(t42.box, t42.dirs.p, ["project"]);
    assert.equal(listed.code, 0);
    assert.equal(rowOf(listed.out, "p").includes("came from it"), false);
    assert.match(listed.out, /^p/m);
});

const t44 = workspace(["p", "c"]);
must(t44.box, t44.dirs.c, ["project", "from", "p", "--why", "it began inside p"]);

test("T4.4: a project registered later under the missing slug answers the relation — the slug is the identity", () =>
{
    unregister(t44.ws, "p");
    register(t44.box, join(t44.box.root, "elsewhere"), "p", ["--desc", "the replacement"]);
    const listed = must(t44.box, t44.dirs.c, ["project"]).out;
    assert.match(rowOf(listed, "p"), /^p — the replacement/);
    assert.match(rowOf(listed, "p"), /came from it: c/);
    assert.match(rowOf(listed, "c"), /came from p$/m);
});

const t45 = workspace(["p", "c", "broken"]);
must(t45.box, t45.dirs.c, ["project", "from", "p", "--why", "it began inside p"]);

test("T4.5: a project whose state cannot be read is skipped with a note, and the rest still answer", () =>
{
    // A directory where the log belongs: unreadable as a file on every host
    // this suite runs on, and nothing about the machine decides it.
    mkdirSync(join(t45.ws, ".superself", "projects", "broken", "log.jsonl"), { recursive: true });
    const listed = must(t45.box, t45.dirs.c, ["project"]);
    assert.equal(listed.code, 0);
    assert.match(listed.out, /^broken: its state could not be read/m);
    assert.match(rowOf(listed.out, "c"), /came from p/);
    assert.match(rowOf(listed.out, "p"), /came from it: c/);
});

/* ── T5 — cycles and chains ────────────────────────────────────────── */

const t51 = workspace(["a", "b"]);
must(t51.box, t51.dirs.a, ["project", "from", "b", "--why", "a came out of b"]);

test("T5.1: A from B then B from A refuses the second, naming the direction that already runs", () =>
{
    const refused = selfIn(t51.box, t51.dirs.b, ["project", "from", "a", "--why", "b came out of a"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /a came from b/);
    assert.match(refused.out, /would close the loop/);
});

const t5 = workspace(["a", "b", "c"]);
must(t5.box, t5.dirs.a, ["project", "from", "b", "--why", "a came out of b"]);
must(t5.box, t5.dirs.b, ["project", "from", "c", "--why", "b came out of c"]);

test("T5.2: the cycle is detected across the chain, not only the pair", () =>
{
    const refused = selfIn(t5.box, t5.dirs.c, ["project", "from", "a", "--why", "c came out of a"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /a came from b came from c/);
    assert.match(refused.out, /would close the loop/);
});

test("T5.3: A from B and B from C both stand — no depth limit", () =>
{
    const listed = must(t5.box, t5.dirs.a, ["project"]).out;
    assert.match(rowOf(listed, "a"), /came from b/);
    assert.match(rowOf(listed, "b"), /came from c/);
    assert.match(rowOf(listed, "c"), /came from it: b/);
});

const t54 = workspace(["a", "b", "c"]);
const t54First = entityIn(must(t54.box, t54.dirs.a, ["project", "from", "b", "--why", "a came out of b"]).out);

test("T5.4: a superseded relation is not a live edge, so the reverse direction is accepted", async () =>
{
    const corrected = await approvedIn(t54.box, t54.dirs.a,
        ["project", "from", "c", "--why", "c is where a came from", "--supersedes", t54First], t54First);
    assert.equal(corrected.code, 0, corrected.out);
    const accepted = selfIn(t54.box, t54.dirs.b, ["project", "from", "a", "--why", "b came out of a"]);
    assert.equal(accepted.code, 0, accepted.out);
    assert.match(rowOf(must(t54.box, t54.dirs.b, ["project"]).out, "b"), /came from a/);
});

/* ── T6 — placement and caps ───────────────────────────────────────── */

const t6 = workspace(["p", "c1", "c2", "c3"]);
setCaps(t6.ws, { indexTokens: 30 });

test("T6.1: with room in the index tier the relation is accepted at index exposure", () =>
{
    const id = entityIn(must(t6.box, t6.dirs.c1, ["project", "from", "p", "--why", "c1 began inside p"]).out);
    assert.match(must(t6.box, t6.dirs.c1, ["state", "show", id]).out, /placement: project · index · priority 50/);
});

test("T6.2: with the index tier exactly full it is refused, and accepted with --demote, as any record", () =>
{
    // Thirty characters exactly, so the tier is at its cap with nothing spare.
    const filler = entityIn(must(t6.box, t6.dirs.c2, ["state", "add", "a".repeat(30)]).out);
    const refused = selfIn(t6.box, t6.dirs.c2, ["project", "from", "p", "--why", "c2 began inside p"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /index tier holds 30 of 30 tokens/);
    assert.match(refused.out, /--demote/);
    const admitted = must(t6.box, t6.dirs.c2, ["project", "from", "p", "--why", "c2 began inside p", "--demote", filler]);
    assert.match(must(t6.box, t6.dirs.c2, ["state", "show", entityIn(admitted.out)]).out, /placement: project · index/);
    assert.match(must(t6.box, t6.dirs.c2, ["state", "show", filler]).out, /placement: project · search/);
});

test("T6.3: place --exposure search takes the relation out of context, and it still resolves", () =>
{
    const id = listedRelationOf(t6, "c1").match(/\be-[0-9a-z]{5}\b/)[0];
    const moved = must(t6.box, t6.dirs.c1, ["state", "place", id, "--exposure", "search", "--why", "it is read rarely"]);
    assert.equal(moved.code, 0);
    assert.equal(must(t6.box, t6.dirs.c1, ["context"]).out.includes("[derivation]"), false);
    assert.match(rowOf(must(t6.box, t6.dirs.c1, ["project"]).out, "c1"), /came from p/);
});

test("T6.4: place --scope moves the relation to another project, as any record", () =>
{
    const id = listedRelationOf(t6, "c2").match(/\be-[0-9a-z]{5}\b/)[0];
    const moved = must(t6.box, t6.dirs.c2, ["state", "place", id, "--scope", "c3"]);
    assert.equal(moved.code, 0);
    assert.match(must(t6.box, t6.dirs.c2, ["state", "show", id]).out, /placement: c3 · index/);
    assert.match(rowOf(must(t6.box, t6.dirs.c2, ["project"]).out, "c2"), /came from p/);
});

test("T6.5: place --scope workspace renders the relation in every project's context", () =>
{
    const id = entityIn(must(t6.box, t6.dirs.c3, ["project", "from", "p", "--why", "c3 began inside p"]).out);
    must(t6.box, t6.dirs.c3, ["state", "place", id, "--scope", "workspace"]);
    for (const dir of [t6.dirs.p, t6.dirs.c1, t6.dirs.c3])
    {
        assert.match(must(t6.box, dir, ["context"]).out, /came from p — c3 began inside p/);
    }
});

test("T6.6: a relation at search exposure is still answered by both directions", () =>
{
    const listed = must(t6.box, t6.dirs.c1, ["project"]).out;
    assert.match(rowOf(listed, "c1"), /came from p/);
    assert.match(rowOf(listed, "p"), /came from it: c1/);
});
