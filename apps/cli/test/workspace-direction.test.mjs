// Workspace scope for goals and objectives (#287): the company's own
// direction, recorded in one project's log and read from inside every one.
//
// Nothing here is a new storage shape. A goal and an objective are entities
// already, so `--workspace` writes the placement value `convention add` has
// written since #207 D6, and the machinery that renders it — `rendersIn`,
// `scopedIn`, `tierOf` — was already wired. What the change adds is the flag,
// the tier the cap gate reads off the payload, the objective surfaces that
// answer for another project's workspace objective, one direction block above
// the workspace context, a tie-break that puts workspace records above project
// ones, and the archive refusal that stops a project from taking the company's
// direction quiet with it.
//
// Every test below is one cell of the case table on issue #287, named by its
// cell id, and asserts that cell's stated outcome. The same table, with the
// rules the cells stand on, is the design artifact in
// docs/maintainers/case-tables/287-workspace-direction.md.
//
// State variables: the record's scope (project / workspace), the verb (add,
// confirm, revise, close, retract, list, show), where the read runs (the home
// project, another active project, a project named with `--project`, the
// workspace root), the render form (piped / terminal), the home project's
// state (active / archived / broken store), the record's own state (proposed /
// confirmed), and the cap state (room / workspace tier full / project tier
// full).
//
// | #    | State / operation | Expected outcome |
// |------|-------------------|------------------|
// | A1   | `self goal add "…"`                                    | unchanged: recorded at project scope |
// | A2   | `self goal add "…" --workspace`                         | recorded at workspace scope, same receipt shape |
// | A3   | `… --workspace --supersedes <workspace goal>`           | lineage kept, predecessor superseded, successor workspace-scoped |
// | A4   | `self goal retract <id> --workspace`                    | refused by name — a goal is withdrawn wherever it renders |
// | A5   | `self objective add "…"`                               | unchanged: project scope |
// | A6   | `self objective add "…" --workspace --target … --success …` | workspace scope, target and success recorded |
// | A7   | `self objective add "…" --workspace --proposed`         | a proposal; it occupies no tier until confirmed |
// | A8   | `self objective confirm <id>` on that proposal          | confirmed at workspace scope |
// | A9   | `self objective revise <id> --why …`                    | successor inherits workspace scope (objective-revise-carry.test.mjs) |
// | A10  | `self objective close <id> --as reached`                | leaves every project's context |
// | A11  | `self objective add "…" --workspace --project other`    | refused: `--project` is a read flag, and this is a write |
// | A12  | `self milestone add … --objective <own workspace objective>` | recorded, project-scoped: other projects read the objective with no checkpoint |
// | A13  | `self milestone add … --objective <another project's>`  | refused, naming the project whose log owns it |
// | A14  | `self objective add "…" --workspace --supersedes <another project's>` | refused — supersession resolves inside one fold |
// | B1   | project goal, read at home                              | renders (unchanged) |
// | B2   | project goal, read in another project                   | does not render (unchanged) |
// | B3   | workspace goal, read at home                            | renders |
// | B4   | workspace goal, read in another project                 | renders |
// | B5   | workspace objective with a milestone, other project      | objective renders above that project's own; the milestone does not |
// | B6   | workspace objective, `self objective` in another project | leads the rows with its owner's slug; work counted in the owning fold |
// | B7   | workspace objective, `self objective show` elsewhere     | body plus contributors computed for the owning slug |
// | B8   | `self objective --workspace`                             | listed once, under its owner's block only |
// | B9   | root `self context`, piped                               | one direction block above the project lines; the owner's row states its own goals |
// | B9t  | root `self context`, terminal                            | the same block above the table, and the same GOAL column rule |
// | B10  | `self status` in another project                         | the objective count is the reading project's own |
// | B10r | root `self status`, both renders                         | no direction block — byte-identical to today |
// | B11  | `goal add --workspace` inside an archived project        | refused: an archived project records no event at all |
// | B12  | `self project archive <home>` with live direction        | refused, listing the ids and both ways out |
// | B13  | the same after the direction is folded                   | archives |
// | B14  | home store broken, read in another project               | fails as it does today |
// | B15  | project-scoped records, another project archived         | unchanged (#285 cell 14) |
// | B16  | `self work link <w> --objective <o>` across projects     | works (#254) — cross-link.test.mjs |
// | B17  | two projects each own a workspace objective              | both lead, ordered by owner slug |
// | B18  | `self objective show <id prefix>` elsewhere              | refused — objective lookup takes exact ids only |
// | B19  | only a *proposed* workspace objective                    | archives (project-archive.test.mjs) |
// | B20  | `self search "<word>"` in another project                | absent by default, found with `--all` |
// | B21  | `self objective --project <slug>` from a third project    | the named project is the viewer; each objective appears once |
// | C1   | project tier full, workspace tier free                   | `goal add --workspace` passes |
// | C2   | workspace tier full                                      | refused, naming the workspace tier and its numbers |
// | C3   | workspace tier full                                      | `goal add` with no flag passes |
// | C4   | workspace tier full, `--demote <workspace entity>`        | passes, demotion recorded |
// | C5   | workspace tier full, `--demote <project entity>`          | refused — pinned already by workspace-scope.test.mjs D5 |
// | C6   | workspace tier full, `--workspace --proposed`             | passes; the later confirm is refused |
// | C7   | direction plus a context over budget                      | the direction survives; lower sections are cut |
// | C8   | `self state show <workspace objective>`                   | `placement: workspace · full · priority 10` |
// | D1-4 | `state place` onto and off workspace scope                | scope-move.test.mjs |
// | E1   | workspace and project objective at priority 10            | the workspace one renders above |
// | E2   | workspace and project convention at priority 30           | the workspace one renders above |
// | E3   | the same records, `self state list`                       | the same order as the context |
// | E4   | same priority, same scope                                 | recency then id, as before |
// | E5   | the golden single-project scenario                        | unchanged — golden.test.mjs |
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approvedIn, git, idIn, machine, must, mustPerson, selfIn, workIdIn } from "./harness.mjs";
import { buildModel } from "../dist/model.js";
import { renderWorkspace } from "../dist/pretty.js";
import { workspaceDirectionLines } from "../dist/views.js";

// The home of the direction, a project that reads it, and — where a cell needs
// one — a third that must answer for neither. Registering a project costs a
// fold and a commit, so no cell pays for one it does not read.
async function workspaceOf(...slugs)
{
    const box = machine();
    const ws = join(box.root, "ws");
    const world = { box, ws };
    mkdirSync(ws, { recursive: true });
    await must(box, ws, ["init"]);
    for (const slug of ["alpha", "beta", ...slugs])
    {
        world[slug] = join(ws, slug);
        mkdirSync(world[slug], { recursive: true });
        git(box, world[slug], ["init", "-q", "-b", "main"]);
        await must(box, world[slug], ["project", "init", "--name", slug, "--no-connect"]);
    }
    return world;
}

function objectiveIdIn(text)
{
    const match = text.match(/\bo-[0-9a-z]{5}\b/);
    if (match === null)
    {
        throw new Error(`no objective id in: ${text}`);
    }
    return match[0];
}

// One token per character, so a cap below is the character count of the text
// it gates (#213) — the same dial workspace-scope.test.mjs turns.
function setCaps(ws, caps)
{
    const file = join(ws, ".superself", "config.json");
    const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    writeFileSync(file, JSON.stringify({ ...config, tokensPerCharacter: 1, tokensMeasured: true, ...caps }) + "\n");
}

/* ── A. the write verbs and the flags they take ─────────────────────── */

const a = await workspaceOf();

let workspaceGoal;

let workspaceObjective;

let proposed;

/* ── B. what renders, where it is read, and what the home does ──────── */

const b = await workspaceOf("gamma");

const projectGoal = idIn((await must(b.box, b.alpha, ["goal", "add", "alpha keeps its own aim"])).out);

const companyGoal = idIn((await must(b.box, b.alpha, ["goal", "add", "the company ships weekly", "--workspace"])).out);

const companyObjective = objectiveIdIn((await must(b.box, b.alpha,
    ["objective", "add", "reach a hundred users", "--workspace"])).out);

const gammaObjective = objectiveIdIn((await must(b.box, b.gamma,
    ["objective", "add", "the company writes it down", "--workspace"])).out);

const betaObjective = objectiveIdIn((await must(b.box, b.beta, ["objective", "add", "beta's own quarter"])).out);

/* ── E. the tie-break, and what else sorts through it ───────────────── */

const e = await workspaceOf();

test("A1: goal add with no flag records at project scope, as it always did", async () =>
{
    const goal = idIn((await must(a.box, a.alpha, ["goal", "add", "alpha ships its own thing"])).out);
    // `project` is the sentinel a home-scoped record reports; the workspace
    // records below report the target by name.
    assert.match((await must(a.box, a.alpha, ["state", "show", goal])).out, /placement: project · full · priority 0/);
});

test("A2: goal add --workspace records the placement value, not a second kind of record", async () =>
{
    workspaceGoal = idIn((await must(a.box, a.alpha, ["goal", "add", "the company ships weekly", "--workspace"])).out);
    assert.match((await must(a.box, a.alpha, ["state", "show", workspaceGoal])).out, /placement: workspace · full · priority 0/);
    assert.match((await must(a.box, a.alpha, ["state", "show", workspaceGoal])).out, /stored in: alpha/);
});

test("A3: a workspace goal is replaced by --supersedes, and the successor stays workspace-scoped", async () =>
{
    // Driven as a person's call, which is the caller this cell is about — the
    // supersession itself reaches the same write from a session since #400.
    const printed = (await approvedIn(a.box, a.alpha,
        ["goal", "add", "the company ships twice weekly", "--workspace", "--supersedes", workspaceGoal],
        workspaceGoal)).printed;
    const successor = idIn(printed);
    assert.match((await must(a.box, a.alpha, ["state", "show", successor])).out, /placement: workspace · full/);
    assert.match((await must(a.box, a.alpha, ["state", "show", workspaceGoal])).out, /superseded/);
    workspaceGoal = successor;
});

test("A4: goal retract refuses --workspace by name rather than swallowing it", async () =>
{
    const refused = await selfIn(a.box, a.alpha, ["goal", "retract", workspaceGoal, "--workspace", "--why", "it does not hold"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /goal retract takes no --workspace/);
    assert.match((await must(a.box, a.alpha, ["state", "show", workspaceGoal])).out, /confirmed/);
});

test("A5: objective add with no flag records at project scope, as it always did", async () =>
{
    const objective = objectiveIdIn((await must(a.box, a.alpha, ["objective", "add", "alpha's own quarter"])).out);
    assert.match((await must(a.box, a.alpha, ["state", "show", objective])).out, /placement: project · full · priority 10/);
});

test("A6: objective add --workspace keeps every other field it was given", async () =>
{
    workspaceObjective = objectiveIdIn((await must(a.box, a.alpha, ["objective", "add", "reach a hundred users",
        "--workspace", "--target", "2026-12-31", "--success", "a hundred accounts in use"])).out);
    const shown = (await must(a.box, a.alpha, ["state", "show", workspaceObjective])).out;
    assert.match(shown, /placement: workspace · full · priority 10/);
    assert.match(shown, /target: 2026-12-31/);
    assert.match((await must(a.box, a.alpha, ["objective", "show", workspaceObjective])).out, /a hundred accounts in use/);
});

test("A7: a proposed workspace objective is recorded and occupies no tier yet", async () =>
{
    proposed = objectiveIdIn((await must(a.box, a.alpha,
        ["objective", "add", "double the paying teams", "--workspace", "--proposed"])).out);
    assert.match((await must(a.box, a.alpha, ["state", "show", proposed])).out, /proposed/);
});

test("A8: confirming it puts it at workspace scope", async () =>
{
    await must(a.box, a.alpha, ["objective", "confirm", proposed]);
    assert.match((await must(a.box, a.alpha, ["state", "show", proposed])).out, /confirmed/);
    assert.match((await must(a.box, a.alpha, ["state", "show", proposed])).out, /placement: workspace · full/);
});

test("A10: closing a workspace objective takes it out of every project's context", async () =>
{
    assert.ok((await must(a.box, a.beta, ["context"])).out.includes("double the paying teams"));
    await must(a.box, a.alpha, ["objective", "close", proposed, "--as", "reached"]);
    assert.ok(!(await must(a.box, a.beta, ["context"])).out.includes("double the paying teams"),
        "a closed workspace objective still renders in another project");
});

test("A11: a write verb takes no read scope — --project is refused by the option table", async () =>
{
    const refused = await selfIn(a.box, a.beta, ["objective", "add", "somebody else's outcome", "--workspace", "--project", "alpha"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /unknown option '--project'/);
});

test("A12: a milestone under a workspace objective is added at home, project-scoped", async () =>
{
    const milestone = (await must(a.box, a.alpha, ["milestone", "add", "the first ten are using it",
        "--objective", workspaceObjective, "--exit", "ten accounts active"])).out.match(/\bm-[0-9a-z]{5}\b/)[0];
    assert.match((await must(a.box, a.alpha, ["state", "show", milestone])).out, /placement: project · /);
    assert.ok((await must(a.box, a.alpha, ["objective"])).out.includes(milestone));
    // B5's other half: the objective reaches the other project without it.
    const elsewhere = (await must(a.box, a.beta, ["context"])).out;
    assert.ok(elsewhere.includes("reach a hundred users"));
    assert.ok(!elsewhere.includes(milestone), "a project-scoped milestone rendered in another project");
});

test("A13: a milestone under another project's workspace objective names the owner", async () =>
{
    const refused = await selfIn(a.box, a.beta, ["milestone", "add", "beta's checkpoint",
        "--objective", workspaceObjective, "--exit", "something"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is alpha's objective/);
    assert.match(refused.out, /run `self milestone add` from alpha/);
});

test("A14: supersession resolves inside one fold, so another project's id is unknown here", async () =>
{
    const refused = await selfIn(a.box, a.beta, ["objective", "add", "a replacement", "--workspace", "--supersedes", workspaceObjective]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /unknown objective/);
});

test("B1 and B3: home reads both of its goals", async () =>
{
    const home = (await must(b.box, b.alpha, ["context"])).out;
    assert.ok(home.includes("alpha keeps its own aim"), home);
    assert.ok(home.includes("the company ships weekly"), home);
});

test("B2 and B4: another project reads the workspace goal and not the project one", async () =>
{
    const elsewhere = (await must(b.box, b.beta, ["context"])).out;
    assert.ok(elsewhere.includes("the company ships weekly"), elsewhere);
    assert.ok(!elsewhere.includes("alpha keeps its own aim"), elsewhere);
});

test("B5 and E1: a workspace objective renders above the reading project's own", async () =>
{
    const elsewhere = (await must(b.box, b.beta, ["context"])).out;
    const company = elsewhere.indexOf("reach a hundred users");
    const own = elsewhere.indexOf("beta's own quarter");
    assert.ok(company !== -1 && own !== -1, elsewhere);
    assert.ok(company < own, `a workspace objective sorted below the project's own:\n${elsewhere}`);
});

test("B6: `self objective` elsewhere leads with the owner's slug and counts work in the owning fold", async () =>
{
    // One unit in the owning project and one contributed from a third: both
    // are counted against the objective, which is what the owner's fold holds.
    const owned = workIdIn((await mustPerson(b.box, b.alpha, ["work", "add", "ship the first cut"])).out);
    await must(b.box, b.alpha, ["work", "link", owned, "--objective", companyObjective]);
    const contributed = workIdIn((await mustPerson(b.box, b.gamma, ["work", "add", "write the page"])).out);
    await must(b.box, b.gamma, ["work", "link", contributed, "--objective", companyObjective]);
    const listing = (await must(b.box, b.beta, ["objective"])).out;
    const rows = listing.split("\n");
    assert.match(rows[0], new RegExp(`^${companyObjective}\\b.*reach a hundred users.*2 work unit\\(s\\).*\\(alpha\\)$`),
        `the foreign row did not lead, or counted work in the reading fold:\n${listing}`);
    assert.ok(listing.indexOf(companyObjective) < listing.indexOf(betaObjective), listing);
});

test("B7: `objective show` elsewhere reports contributors for the owning slug", async () =>
{
    const shown = (await must(b.box, b.beta, ["objective", "show", companyObjective])).out;
    assert.match(shown, /reach a hundred users/);
    assert.match(shown, /\(gamma\)/, `contributors were computed for the reading project:\n${shown}`);
});

test("B8: the --workspace listing states each objective once, under its owner", async () =>
{
    const listing = (await must(b.box, b.ws, ["objective", "--workspace"])).out;
    assert.equal(listing.split(companyObjective).length - 1, 1, listing);
    assert.equal(listing.split(gammaObjective).length - 1, 1, listing);
});

test("B17: two owners lead the rows in slug order, above the reading project's own", async () =>
{
    const rows = (await must(b.box, b.beta, ["objective"])).out.split("\n");
    assert.match(rows[0], /\(alpha\)$/, rows.join("\n"));
    assert.match(rows[1], /\(gamma\)$/, rows.join("\n"));
    assert.ok(rows[2].startsWith(betaObjective), rows.join("\n"));
});

test("B18: an id prefix is unknown here exactly as it is at home", async () =>
{
    const refused = await selfIn(b.box, b.beta, ["objective", "show", companyObjective.slice(0, 4)]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /unknown objective/);
    const atHome = await selfIn(b.box, b.alpha, ["objective", "show", companyObjective.slice(0, 4)]);
    assert.notEqual(atHome.code, 0);
    assert.match(atHome.out, /unknown objective/);
});

test("B21: --project names the viewer, and every objective appears once under it", async () =>
{
    const listing = (await must(b.box, b.gamma, ["objective", "--project", "beta"])).out;
    assert.equal(listing.split(companyObjective).length - 1, 1, listing);
    assert.equal(listing.split(gammaObjective).length - 1, 1, listing);
    assert.match(listing.split("\n")[1], /\(gamma\)$/, `gamma's own objective did not read as foreign to beta:\n${listing}`);
});

test("B20: search answers over what context did not show, and --all finds it anyway", async () =>
{
    const byDefault = await selfIn(b.box, b.beta, ["search", "weekly"]);
    assert.equal(byDefault.code, 0, byDefault.out);
    assert.ok(!byDefault.out.includes(companyGoal), byDefault.out);
    const all = await must(b.box, b.beta, ["search", "weekly", "--all"]);
    assert.ok(all.out.includes(companyGoal), all.out);
});

test("B9: the workspace context says the direction once, above the project lines", async () =>
{
    const rendered = (await must(b.box, b.ws, ["context"])).out;
    const direction = rendered.indexOf("## Workspace direction");
    const alphaRow = rendered.indexOf("alpha —");
    assert.ok(direction !== -1 && alphaRow !== -1, rendered);
    assert.ok(direction < alphaRow, rendered);
    assert.equal(rendered.split("the company ships weekly").length - 1, 1,
        `the workspace goal was said twice:\n${rendered}`);
    // The row states this project's own goals, and the counter behind the
    // first one counts the same set — the workspace goal is in neither.
    assert.match(rendered, /alpha — alpha keeps its own aim \(/, rendered);
    assert.ok(!rendered.includes("(+1 more)"), `the row counted a goal it does not state:\n${rendered}`);
});

test("B9t: the terminal render of the workspace context says the same facts", () =>
{
    const models = ["alpha", "beta", "gamma"].map((slug) => buildModel(join(b.ws, ".superself"), slug, new Date()));
    const direction = workspaceDirectionLines(models);
    const table = renderWorkspace(models, direction).join("\n");
    assert.ok(table.indexOf("## Workspace direction") < table.indexOf("PROJECT"), table);
    assert.ok(table.includes("the company ships weekly"), table);
    assert.equal(table.split("the company ships weekly").length - 1, 1, `the goal was said twice:\n${table}`);
    assert.match(table, /alpha\s+.*alpha keeps its own aim/, table);
});

test("B10: another project's status counts its own objectives only", async () =>
{
    assert.match((await must(b.box, b.beta, ["status"])).out, /objectives: 1 open/);
});

test("B10r: the workspace status says no direction, in either render", async () =>
{
    const piped = (await must(b.box, b.ws, ["status"])).out;
    assert.ok(!piped.includes("## Workspace direction"), piped);
    // The status row keeps reading the newest live goal of the project's own
    // log, workspace-scoped or not: it is that project's row, not the
    // workspace's line.
    assert.match(piped, /alpha — the company ships weekly \(/, piped);
    const models = ["alpha", "beta", "gamma"].map((slug) => buildModel(join(b.ws, ".superself"), slug, new Date()));
    const table = renderWorkspace(models).join("\n");
    assert.ok(!table.includes("## Workspace direction"), table);
    assert.ok(table.includes("PROJECT"), table);
    // Today's GOAL column, unchanged: the newest live goal of that project's
    // own log, whatever its placement.
    assert.ok(table.includes("the company ships weekly"), table);
});

test("B15: a project archived elsewhere leaves project-scoped records exactly as they were", async () =>
{
    // A world of its own: the archived project must hold no direction, which
    // is what the gate above refuses, and gamma in the world above holds some.
    const bystander = await workspaceOf("gamma");
    await must(bystander.box, bystander.alpha, ["goal", "add", "alpha keeps its own aim"]);
    await must(bystander.box, bystander.beta, ["objective", "add", "beta's own quarter"]);
    const before = (await must(bystander.box, bystander.beta, ["status"])).out;
    await must(bystander.box, bystander.ws, ["project", "archive", "gamma", "--why", "not this quarter"]);
    const after = (await must(bystander.box, bystander.beta, ["status"])).out;
    assert.match(after, /health: ok/);
    assert.equal(after, before);
});

/* ── B11 to B14. the home project's own state ───────────────────────── */

test("B12: archiving a project that holds live direction is refused, with both ways out", async () =>
{
    const refused = await selfIn(b.box, b.ws, ["project", "archive", "alpha", "--why", "not this quarter"]);
    assert.notEqual(refused.code, 0);
    assert.ok(refused.out.includes(companyGoal), refused.out);
    assert.ok(refused.out.includes(companyObjective), refused.out);
    assert.match(refused.out, /self goal retract <id> --why/);
    assert.match(refused.out, /self objective close <id> --as dropped --why/);
    assert.match(refused.out, /--workspace/);
    assert.match(refused.out, /lineage does not cross projects/);
    // The project-scoped goal is not the company's direction and is not listed.
    assert.ok(!refused.out.includes(projectGoal), refused.out);
});

test("B11: an archived project records no event at all, --workspace included", async () =>
{
    const solo = await workspaceOf();
    await must(solo.box, solo.ws, ["project", "archive", "beta", "--why", "set aside"]);
    const refused = await selfIn(solo.box, solo.beta, ["goal", "add", "a company aim", "--workspace"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /archived/);
});

test("B13: once the direction is folded, the same archive goes through", async () =>
{
    // Driven as a person's call: the two exits the refusal names are the
    // subject here, not which kind of caller takes them.
    const retracted = await approvedIn(b.box, b.alpha,
        ["goal", "retract", companyGoal, "--why", "the company states it elsewhere now"], companyGoal);
    assert.equal(retracted.code, 0, retracted.out);
    const closed = await approvedIn(b.box, b.alpha,
        ["objective", "close", companyObjective, "--as", "dropped", "--why", "restated in gamma"], companyObjective);
    assert.equal(closed.code, 0, closed.out);
    const archived = await must(b.box, b.ws, ["project", "archive", "alpha", "--why", "not this quarter"]);
    assert.match(archived.out, /project "alpha" is archived/);
    await must(b.box, b.ws, ["project", "restore", "alpha"]);
});

test("B14: a broken home store fails the read, exactly as it does today", async () =>
{
    const broken = await workspaceOf();
    await must(broken.box, broken.alpha, ["goal", "add", "the company ships weekly", "--workspace"]);
    appendFileSync(join(broken.ws, ".superself", "projects", "alpha", "log.jsonl"), "not an event\n");
    const failed = await selfIn(broken.box, broken.beta, ["context"]);
    assert.notEqual(failed.code, 0);
});

/* ── C. the caps, and the render budget ─────────────────────────────── */

test("C1 and C3: the project tier and the workspace tier fill and gate apart", async () =>
{
    const caps = await workspaceOf();
    setCaps(caps.ws, { fullTokens: 30 });
    await must(caps.box, caps.alpha, ["goal", "add", "alpha aims here and stops"]);
    const projectFull = await selfIn(caps.box, caps.alpha, ["goal", "add", "one project goal over the line"]);
    assert.notEqual(projectFull.code, 0);
    assert.match(projectFull.out, /the project full tier holds/);
    // C1: the full project tier does not gate the workspace tier.
    await must(caps.box, caps.alpha, ["goal", "add", "the company ships", "--workspace"]);
    // C3: and a full workspace tier does not gate the project's, either.
    setCaps(caps.ws, { fullTokens: 60 });
    await must(caps.box, caps.alpha, ["goal", "add", "alpha adds one more"]);
});

test("C2: past the workspace cap the refusal names that tier and its numbers", async () =>
{
    const caps = await workspaceOf();
    setCaps(caps.ws, { fullTokens: 20 });
    await must(caps.box, caps.alpha, ["goal", "add", "the company ships", "--workspace"]);
    const refused = await selfIn(caps.box, caps.alpha, ["goal", "add", "one company aim too many", "--workspace"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /the workspace full tier holds \d+ of 20 tokens/);
    assert.match(refused.out, /--demote <id>/);
});

test("C4: --demote of a workspace record frees the workspace tier", async () =>
{
    const caps = await workspaceOf();
    setCaps(caps.ws, { fullTokens: 20 });
    const seat = idIn((await must(caps.box, caps.alpha, ["goal", "add", "the company ships", "--workspace"])).out);
    const admitted = await must(caps.box, caps.alpha,
        ["objective", "add", "reach a hundred", "--workspace", "--demote", seat]);
    assert.equal(admitted.code, 0, admitted.out);
    assert.match((await must(caps.box, caps.alpha, ["state", "show", seat])).out, /placement: workspace · index/);
});

test("C6: a proposal passes a full tier, and the confirm is where it is refused", async () =>
{
    const caps = await workspaceOf();
    setCaps(caps.ws, { fullTokens: 20 });
    await must(caps.box, caps.alpha, ["goal", "add", "the company ships", "--workspace"]);
    const proposal = objectiveIdIn((await must(caps.box, caps.alpha,
        ["objective", "add", "reach a hundred users", "--workspace", "--proposed"])).out);
    const refused = await selfIn(caps.box, caps.alpha, ["objective", "confirm", proposal]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /workspace full tier/);
});

test("C7: over budget, the direction is what a project's context keeps", async () =>
{
    const budget = await workspaceOf();
    // Caps out of the way: this cell is about the render budget, which is the
    // other limit — a tier says what a store may hold, the budget says what one
    // render may spend.
    setCaps(budget.ws, { fullTokens: 1_000_000, indexTokens: 1_000_000 });
    await must(budget.box, budget.alpha, ["goal", "add", "the company ships weekly", "--workspace"]);
    // Enough of beta's own low-priority records to spend the render budget:
    // conventions sort at priority 30, below the direction's 0 and 10.
    for (let index = 0; index < 30; index++)
    {
        await must(budget.box, budget.beta, ["convention", "add", `beta rule ${index} — ${"x".repeat(200)}`]);
    }
    const rendered = (await must(budget.box, budget.beta, ["context"])).out;
    assert.ok(rendered.includes("the company ships weekly"), "the direction was cut before the sections below it");
    assert.match(rendered, /omitted/, `nothing was cut, so this cell proves nothing:\n${rendered.slice(0, 400)}`);
});

test("C8: the placement a workspace objective reports is the workspace tier", async () =>
{
    const shown = (await must(b.box, b.gamma, ["state", "show", gammaObjective])).out;
    assert.match(shown, /placement: workspace · full · priority 10/);
});

test("E2 and E3: at equal priority the workspace record leads, in context and in state list", async () =>
{
    await must(e.box, e.alpha, ["convention", "add", "the company reviews every change", "--workspace"]);
    await must(e.box, e.beta, ["convention", "add", "beta squashes its merges"]);
    const rendered = (await must(e.box, e.beta, ["context"])).out;
    const company = rendered.indexOf("the company reviews every change");
    const own = rendered.indexOf("beta squashes its merges");
    assert.ok(company !== -1 && own !== -1, rendered);
    assert.ok(company < own, `a workspace convention sorted below the project's own:\n${rendered}`);
    // E3: one comparator, so the two surfaces cannot disagree.
    const listed = (await must(e.box, e.beta, ["state", "list"])).out;
    assert.ok(listed.indexOf("the company reviews every change") < listed.indexOf("beta squashes its merges"), listed);
});

test("E4: within one scope the old tie-break stands — newest first", async () =>
{
    await must(e.box, e.beta, ["convention", "add", "beta writes its reasons down"]);
    const rendered = (await must(e.box, e.beta, ["context"])).out;
    assert.ok(rendered.indexOf("beta writes its reasons down") < rendered.indexOf("beta squashes its merges"),
        `recency stopped breaking the tie inside one scope:\n${rendered}`);
});
