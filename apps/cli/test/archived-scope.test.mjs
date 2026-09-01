// A record whose scope names a project archived after the record was placed
// (#285). Its scope is still valid data — the slug is registered and comes back
// whole with `self project restore` — but every workspace aggregate answers
// from `paths.ts` `activeProjects`, so the record goes quiet with the project
// and used to be named nowhere at all.
//
// Every test below is one cell of the case table on issue #285, named by its
// cell number, and asserts that cell's stated outcome. Cells 1 to 3 are the
// table the issue was accepted with; 4 to 13 extend it along what the commands
// resolve from outside their arguments — the directory the read runs in, the
// `--project` and `--workspace` forms, and the commands the line itself names;
// 14 to 23 close the state space around it. The same table, with the rules the
// cells are derived from, is the design artifact in
// docs/maintainers/case-tables/285-archived-scope.md.
//
// State variables: where the record's scope points (its own project, another
// active project, an archived project, `workspace`), the target project's state
// (active / archived / restored), the record's own state (live / not live), the
// directory the read runs in, and the form of the read.
//
// | #  | State                                                     | Operation                                                  | Expected outcome |
// |----|-----------------------------------------------------------|------------------------------------------------------------|------------------|
// | 1  | record placed in alpha scoped to beta, beta then archived | `self status`, in alpha's checkout                          | health names the record id and "beta", says it renders nowhere, and names both ways out |
// | 2  | same, after `self project restore beta`                   | `self status`, in alpha's checkout                          | health: ok, and the record renders in beta's context again |
// | 3  | no archived project anywhere                              | `self status`, in alpha's checkout                          | byte-identical to the same read with no such record at all |
// | 4  | same as 1                                                 | `self status --project alpha`, from the workspace root      | the same line in the same words — the answer does not depend on the directory |
// | 5  | same as 1                                                 | `self status --project alpha`, from beta's own checkout     | the same line — standing in the archived project changes nothing about what alpha answers |
// | 6  | same as 1                                                 | `self status --workspace`, from the workspace root          | alpha's row carries one health signal; beta has no row at all (#283) |
// | 7  | same as 1                                                 | `self status` with no flag, from the workspace root         | the same rows as cell 6 — a bare read from outside every project is the workspace form |
// | 8  | same as 1                                                 | `self context`, in alpha's checkout                         | a `## Health` section carrying the same line |
// | 9  | same as 1                                                 | `self context --project alpha`, from the workspace root     | the same section and the same line |
// | 10 | same as 1                                                 | `self context` with no flag, from the workspace root        | alpha's row carries one health signal |
// | 11 | same as 1                                                 | `self status`, in a third active project gamma's checkout   | health: ok — the record is alpha's, and only alpha answers for it |
// | 12 | same as 1                                                 | `self project restore beta`, from alpha's checkout          | beta is back and alpha's next read is clean — the way back runs from where the line is read |
// | 13 | same as 1                                                 | `self state place <id> --scope alpha`, from alpha's checkout | the record moves home, the line goes, and beta stays archived |
// | 14 | record in alpha scoped to `workspace`, beta archived      | `self status`, in alpha's checkout                          | not reported — a workspace record renders in every active project, so archiving one takes nothing from it |
// | 15 | same as 1                                                 | `self project`, from the workspace root                     | no dangling-scope line — a dangling scope is a slug that is not registered, an archived one is registered, and the two reports do not double up |
// | 16 | record in alpha scoped to its own project, alpha archived | `self status --project alpha`                               | not reported — the record went with its own project (#283) |
// | 17 | record in the archived beta scoped to active alpha        | `self status`, in alpha's checkout                          | not reported — every record of an archived project goes with it (#283), which is that table's cell |
// | 18 | the record of cell 1 retracted, then beta archived        | `self status`, in alpha's checkout                          | not reported — a withdrawn record renders nowhere by its own state |
// | 19 | two records in alpha scoped to beta, beta archived        | `self status`, in alpha's checkout                          | both named, one line each, each naming its own id |
// | 20 | a work unit in alpha scoped to beta, beta archived        | `self status`, in alpha's checkout                          | named the same way — the report is about a placed record, and a work unit is one |
// | 21 | beta archived, restored, then archived again              | `self status`, in alpha's checkout                          | reported again, exactly once — the report is derived from current state and nothing survives the round trip |
// | 22 | same as 1, and alpha archived too                         | `self status --project alpha` / `self context --project alpha` | still named — an archived project is read by naming it (#283), and naming it must not silence the line |
// | 23 | a proposal, not a confirmed record, scoped to beta        | `self status`, in alpha's checkout                          | named the same way — a proposal in an archived project cannot be confirmed there either |
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { approvedIn, git, machine, must, mustPerson, workIdIn } from "./harness.mjs";

// The record's home and the project it is scoped into and archived. A cell
// that needs a bystander — one that must answer for neither — asks for gamma;
// registering a project costs a fold and a commit, so no cell pays for one it
// does not read.
async function workspaceOf(...slugs)
{
    const box = machine();
    const ws = join(box.root, "ws");
    const world = { box, ws };
    mkdirSync(ws, { recursive: true });
    await must(box, ws, ["init", "--git"]);
    for (const slug of ["alpha", "beta", ...slugs])
    {
        world[slug] = join(ws, slug);
        mkdirSync(world[slug], { recursive: true });
        git(box, world[slug], ["init", "-q", "-b", "main"]);
        await must(box, world[slug], ["project", "init", "--name", slug, "--no-connect"]);
    }
    return world;
}

// The id `state add` prints on its own line after the confirmation line.
function entityIdIn(text)
{
    const match = text.match(/\be-[0-9a-z]{5}\b/);
    if (match === null)
    {
        throw new Error(`no record id in: ${text}`);
    }
    return match[0];
}

async function placedInto(box, dir, scope, text = "the note that renders elsewhere")
{
    return entityIdIn((await must(box, dir, ["state", "add", text, "--scope", scope])).out);
}

function archive(box, cwd, slug = "beta", why = "nobody is on it this quarter")
{
    return must(box, cwd, ["project", "archive", slug, "--why", why]);
}

// What the line has to carry to be worth printing: the record, the slug it
// points at, and each of the two ways out.
function assertReported(text, id, slug = "beta")
{
    assert.match(text, new RegExp(`${id} renders in "${slug}", which is archived, so it renders nowhere`),
        `the archived scope was not reported:\n${text}`);
    assert.match(text, new RegExp(`self project restore ${slug}`), `the way back was not named:\n${text}`);
    assert.match(text, new RegExp(`self state place ${id} --scope`), `the way out was not named:\n${text}`);
}

function assertSilent(text, id)
{
    assert.doesNotMatch(text, new RegExp(`${id} renders in`), `the record was reported where it should not be:\n${text}`);
}

// The state cells 1, 4 to 13, 15, 19 and 21 all start from: one record in
// alpha, scoped into beta, and beta archived afterwards.
async function scopedThenArchived(...slugs)
{
    const world = await workspaceOf(...slugs);
    world.id = await placedInto(world.box, world.alpha, "beta");
    await archive(world.box, world.ws);
    return world;
}

/* ── the three cells the issue was accepted with ───────────────────── */

test("1: a record scoped to a project archived afterwards is named, with its slug, on the reachability read", async () =>
{
    const { box, alpha, id } = await scopedThenArchived();
    assertReported((await must(box, alpha, ["status"])).out, id);
});

test("2: restoring the project clears the report, and the record renders there again", async () =>
{
    const { box, ws, alpha, beta, id } = await scopedThenArchived();
    await must(box, ws, ["project", "restore", "beta"]);
    const status = (await must(box, alpha, ["status"])).out;
    assertSilent(status, id);
    assert.match(status, /health: ok/);
    assert.match((await must(box, beta, ["context"])).out, /the note that renders elsewhere/,
        "the record did not come back with the project");
});

test("3: with no archived project anywhere, the read says exactly what it said before the record existed", async () =>
{
    const { box, alpha } = await workspaceOf();
    const before = (await must(box, alpha, ["status"])).out;
    await placedInto(box, alpha, "beta");
    assert.equal((await must(box, alpha, ["status"])).out, before,
        "a record scoped into an active project changed the reachability read");
});

/* ── where the read runs, and in what form ─────────────────────────── */

test("4: --project answers the same from the workspace root as the directory does from the checkout", async () =>
{
    const { box, ws, alpha, id } = await scopedThenArchived();
    const named = (await must(box, ws, ["status", "--project", "alpha"])).out;
    assert.equal(named, (await must(box, alpha, ["status"])).out);
    assertReported(named, id);
});

test("5: --project answers the same standing inside the archived project's own checkout", async () =>
{
    const { box, alpha, beta, id } = await scopedThenArchived();
    const fromArchived = (await must(box, beta, ["status", "--project", "alpha"])).out;
    assert.equal(fromArchived, (await must(box, alpha, ["status"])).out);
    assertReported(fromArchived, id);
});

test("6: --workspace carries the signal as a count on the record's own row, and gives the archived project no row", async () =>
{
    const { box, ws } = await scopedThenArchived("gamma");
    const rows = (await must(box, ws, ["status", "--workspace"])).out;
    assert.match(rows, /^alpha .*\[1 health signal\(s\)\]/m, `alpha's row carries no signal:\n${rows}`);
    assert.match(rows, /^gamma .*\(0 active/m);
    assert.doesNotMatch(rows, /^gamma .*health signal/m, `gamma answered for alpha's record:\n${rows}`);
    assert.doesNotMatch(rows, /^beta/m, `the archived project still has a row:\n${rows}`);
});

test("7: a bare status from outside every project is the workspace form, and carries the same count", async () =>
{
    const { box, ws } = await scopedThenArchived();
    const bare = (await must(box, ws, ["status"])).out;
    assert.equal(bare, (await must(box, ws, ["status", "--workspace"])).out);
    assert.match(bare, /^alpha .*\[1 health signal\(s\)\]/m);
});

test("8: context prints the same line in its health section", async () =>
{
    const { box, alpha, id } = await scopedThenArchived();
    const context = (await must(box, alpha, ["context"])).out;
    assert.match(context, /## Health/, `context has no health section:\n${context}`);
    assertReported(context, id);
});

test("9: context --project prints that section from the workspace root", async () =>
{
    const { box, ws, alpha, id } = await scopedThenArchived();
    const named = (await must(box, ws, ["context", "--project", "alpha"])).out;
    assert.equal(named, (await must(box, alpha, ["context"])).out);
    assertReported(named, id);
});

test("10: the workspace context carries the signal as a count on the record's own row", async () =>
{
    const { box, ws } = await scopedThenArchived();
    const rows = (await must(box, ws, ["context"])).out;
    assert.match(rows, /^alpha .*\[1 health signal\(s\)\]/m, `alpha's row carries no signal:\n${rows}`);
    assert.doesNotMatch(rows, /^beta/m);
});

test("11: another active project's read does not answer for a record that is not its own", async () =>
{
    const { box, gamma, id } = await scopedThenArchived("gamma");
    const status = (await must(box, gamma, ["status"])).out;
    assertSilent(status, id);
    assert.match(status, /health: ok/);
});

test("12: the way back the line names runs from where the line is read", async () =>
{
    const { box, alpha, id } = await scopedThenArchived();
    const back = await must(box, alpha, ["project", "restore", "beta"]);
    assert.match(back.out, /project "beta" is back/);
    assertSilent((await must(box, alpha, ["status"])).out, id);
});

test("13: the way out the line names moves the record, and leaves the project archived", async () =>
{
    const { box, ws, alpha, id } = await scopedThenArchived();
    await must(box, alpha, ["state", "place", id, "--scope", "alpha"]);
    assertSilent((await must(box, alpha, ["status"])).out, id);
    assert.match((await must(box, alpha, ["state"])).out, new RegExp(id), "the record did not come home");
    assert.match((await must(box, ws, ["project", "--archived"])).out, /^beta —/m, "moving the record un-archived the project");
});

/* ── what is not this report ───────────────────────────────────────── */

test("14: a record scoped to the workspace is untouched by any one project being archived", async () =>
{
    const { box, ws, alpha } = await workspaceOf();
    const id = await placedInto(box, alpha, "workspace", "the note that renders everywhere");
    await archive(box, ws);
    const status = (await must(box, alpha, ["status"])).out;
    assertSilent(status, id);
    assert.match(status, /health: ok/);
});

test("15: the archived scope is not also reported as a dangling scope, which is a different state", async () =>
{
    const { box, ws, id } = await scopedThenArchived();
    const listed = (await must(box, ws, ["project"])).out;
    assert.doesNotMatch(listed, /dangling scope/, `an archived scope was reported as unregistered:\n${listed}`);
    assertSilent(listed, id);
});

test("16: a record scoped to its own project is not reported when that project is archived", async () =>
{
    const { box, ws, alpha } = await workspaceOf();
    const id = entityIdIn((await must(box, alpha, ["state", "add", "the note alpha keeps"])).out);
    await archive(box, ws, "alpha");
    const status = (await must(box, ws, ["status", "--project", "alpha"])).out;
    assertSilent(status, id);
    assert.match(status, /health: ok/);
});

test("17: a record whose own project is archived is not reported by the project it was scoped into", async () =>
{
    const { box, ws, alpha, beta } = await workspaceOf();
    const id = await placedInto(box, beta, "alpha", "the note beta lends to alpha");
    assert.match((await must(box, alpha, ["context"])).out, new RegExp("the note beta lends to alpha"));
    await archive(box, ws);
    const status = (await must(box, alpha, ["status"])).out;
    assertSilent(status, id);
    assert.match(status, /health: ok/);
});

test("18: a withdrawn record is not reported, because it renders nowhere by its own state", async () =>
{
    const { box, ws, alpha } = await workspaceOf();
    const id = await placedInto(box, alpha, "beta");
    await approvedIn(box, alpha, ["state", "retract", id, "--why", "it no longer holds"], id);
    assert.match((await must(box, alpha, ["state", "show", id])).out, /retracted/, "the record was not withdrawn");
    await archive(box, ws);
    const status = (await must(box, alpha, ["status"])).out;
    assertSilent(status, id);
    assert.match(status, /health: ok/);
});

test("19: two records scoped into the archived project are named one line each", async () =>
{
    const { box, ws, alpha } = await workspaceOf();
    const first = await placedInto(box, alpha, "beta", "the first note that renders elsewhere");
    const second = await placedInto(box, alpha, "beta", "the second note that renders elsewhere");
    await archive(box, ws);
    const status = (await must(box, alpha, ["status"])).out;
    assertReported(status, first);
    assertReported(status, second);
    assert.match((await must(box, ws, ["status", "--workspace"])).out, /^alpha .*\[2 health signal\(s\)\]/m);
});

test("20: a work unit scoped into the archived project is named the same way", async () =>
{
    const { box, ws, alpha } = await workspaceOf();
    const unit = workIdIn((await mustPerson(box, alpha, ["work", "add", "the outcome that renders elsewhere"])).out);
    await must(box, alpha, ["state", "place", unit, "--scope", "beta"]);
    await archive(box, ws);
    assertReported((await must(box, alpha, ["status"])).out, unit);
});

test("21: archiving, restoring and archiving again reports once, with nothing left over from the round trip", async () =>
{
    const { box, ws, alpha, id } = await scopedThenArchived();
    await must(box, ws, ["project", "restore", "beta"]);
    assertSilent((await must(box, alpha, ["status"])).out, id);
    await archive(box, ws, "beta", "set aside a second time");
    const status = (await must(box, alpha, ["status"])).out;
    assertReported(status, id);
    assert.equal(status.match(new RegExp(`${id} renders in`, "g")).length, 1,
        `the record was reported more than once:\n${status}`);
});

/* ── the two cells the adversarial pass added ──────────────────────── */

test("22: the record's own project being archived too does not silence the line for a read that names it", async () =>
{
    const { box, ws, alpha, id } = await scopedThenArchived();
    await archive(box, ws, "alpha", "set aside as well");
    assertReported((await must(box, ws, ["status", "--project", "alpha"])).out, id);
    assertReported((await must(box, ws, ["context", "--project", "alpha"])).out, id);
});

test("23: a proposal scoped into the archived project is named the same way a confirmed record is", async () =>
{
    const { box, ws, alpha } = await workspaceOf();
    const proposed = entityIdIn((await must(box, alpha,
        ["state", "add", "a proposal aimed at beta", "--scope", "beta", "--proposed"])).out);
    await archive(box, ws);
    assertReported((await must(box, alpha, ["status"])).out, proposed);
});
