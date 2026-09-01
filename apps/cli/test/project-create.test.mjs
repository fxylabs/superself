// `self project init` where the store keeps its records on a workspace server
// (#426).
//
// Every cell is named for its row in
// `docs/maintainers/case-tables/426-command-surface.md` — `project J2 taken` —
// and the shape is always the same: the workspace answers, and the assertion is
// about what is left on this machine afterwards. The rule the whole file is
// about is that no answer leaves a project registered here that the workspace
// did not make, because such a project's every record would queue behind a 404
// nobody is watching.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { demoWorkspace, git, machine, must, selfIn } from "./harness.mjs";
import { blocks, connectedMachine, queueAppend, registryRows, syncEnv, unsent } from "./transport-lib.mjs";

// A directory inside the workspace that is a repository of its own and holds no
// project yet — what `self project init` is run in.
function room(box, ws, name)
{
    const dir = join(ws, name);
    mkdirSync(dir, { recursive: true });
    git(box, dir, ["init", "-q", "-b", "main"]);
    return dir;
}

async function connected(t, options = {})
{
    const built = await connectedMachine({ projects: [{ slug: "demo" }], ...options });
    t.after(() => built.server.close());
    return built;
}

// Staged for the creation call alone. The catch-up a command runs first has its
// own answers, and a case that replaced those too would be staging the whole
// conversation rather than the one turn it is about.
function creations(staged)
{
    return (call) => call.method === "POST" && call.path.endsWith("/projects") ? staged : undefined;
}

function registered(ws)
{
    return registryRows(ws).map((row) => row.slug);
}

/* ── J1–J4: the three answers creation has, and no answer at all ───── */

test("project J1 created: a 201 registers the project here and caches the server's id for it", async (t) =>
{
    const { box, ws, server } = await connected(t);
    const atlas = room(box, ws, "atlas");
    await must(box, atlas, ["project", "init", "--name", "atlas", "--desc", "a new one", "--no-connect"], syncEnv());

    assert.equal(server.projectId("atlas"), "prj_2", "the workspace did not make the project");
    const row = registryRows(ws).find((entry) => entry.slug === "atlas");
    assert.equal(row?.id, server.projectId("atlas"), "the registry row does not carry the server's project id");
    assert.equal(row?.description, "a new one");
});

test("project J2 taken: a 409 sends the caller to ask for access and registers nothing here", async (t) =>
{
    const { box, ws, server } = await connected(t, {
        answer: creations({ status: 409, body: { code: "slug_taken", message: 'this workspace already has a project "atlas"' } })
    });
    const atlas = room(box, ws, "atlas");
    const refused = await selfIn(box, atlas, ["project", "init", "--name", "atlas", "--no-connect"], syncEnv());

    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /ask an owner/, "the 409 did not say what a caller can do about it");
    assert.deepEqual(registered(ws), ["demo"], "a project the workspace refused was registered here anyway");
    assert.ok(!existsSync(join(ws, ".superself", "projects", "atlas")), "a local project directory was left behind");
    assert.ok(!existsSync(join(atlas, ".self")), "a marker was written for a project that was not made");
});

test("project J3 denied: a 404 sends the caller to the connection and the account, and registers nothing", async (t) =>
{
    const { box, ws } = await connected(t, {
        answer: creations({ status: 404, body: { code: "not_found", message: "no such workspace, project or record" } })
    });
    const atlas = room(box, ws, "atlas");
    const refused = await selfIn(box, atlas, ["project", "init", "--name", "atlas", "--no-connect"], syncEnv());

    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /self login/);
    assert.deepEqual(registered(ws), ["demo"]);
});

test("project J4 unreachable: a workspace that does not answer is surfaced, and registers nothing", async (t) =>
{
    const { box, ws } = await connected(t, { answer: creations({ destroy: true }) });
    const atlas = room(box, ws, "atlas");
    const refused = await selfIn(box, atlas, ["project", "init", "--name", "atlas", "--no-connect"], syncEnv());

    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /could not reach/);
    assert.deepEqual(registered(ws), ["demo"]);
});

/* ── J5: the store that keeps its records here ─────────────────────── */

test("project J5 git-mode: a git-backed store registers a project without asking anybody", async () =>
{
    const box = machine();
    const { ws } = await demoWorkspace(box);
    const atlas = room(box, ws, "atlas");
    await must(box, atlas, ["project", "init", "--name", "atlas", "--no-connect"]);

    const row = registryRows(ws).find((entry) => entry.slug === "atlas");
    assert.ok(row !== undefined, "the project was not registered");
    assert.equal(row.id, undefined, "a git-backed store cached a server id it has no server for");
});

/* ── J6: the creation and the records that follow it ───────────────── */

test("project J6 creator-acl: a record made right after the creation reaches the project the creation made", async (t) =>
{
    const { box, ws, server } = await connected(t);
    const atlas = room(box, ws, "atlas");
    await must(box, atlas, ["project", "init", "--name", "atlas", "--no-connect"], syncEnv());
    await must(box, atlas, ["goal", "add", "ship the first release"], syncEnv());

    assert.equal(server.eventsIn("atlas").length > 0, true,
        "the push after the creation did not reach the project it had just made");
    assert.equal(blocks(ws, "atlas").length, 0, "the push was refused for a project this machine had just created");
});

/* ── J7: the id cache, from the side that writes it ────────────────── */

test("project J7 no-resurrection: a queued push does not re-create a project another machine deleted", async (t) =>
{
    const { box, ws, server } = await connected(t);
    const atlas = room(box, ws, "atlas");
    await must(box, atlas, ["project", "init", "--name", "atlas", "--no-connect"], syncEnv());
    assert.equal(registryRows(ws).find((entry) => entry.slug === "atlas")?.id, server.projectId("atlas"));

    // What another machine deleting it looks like from here: the workspace
    // stops holding it, and this machine still has a queue for it.
    server.state.projects.delete("atlas");
    server.state.log.delete("atlas");
    const queued = queueAppend(ws, { slug: "atlas" });
    const creates = server.calls.filter((call) => call.method === "POST" && call.path.endsWith("/projects")).length;
    await must(box, ws, ["project", "list"], syncEnv());

    assert.equal(server.calls.filter((call) => call.method === "POST" && call.path.endsWith("/projects")).length, creates,
        "the push re-created a project somebody had deleted");
    assert.equal(blocks(ws, "atlas")[0]?.blocked, queued.append_id, "the records went nowhere and said so");
    assert.deepEqual(unsent(ws, "atlas"), [], "and nothing is still trying");
});

/* ── J8: what an archived project still refuses ────────────────────── */

test("project J8 archived: an archived project refuses a local write, exactly as it did", async (t) =>
{
    const { box, ws, demo } = await connected(t);
    await must(box, ws, ["project", "archive", "demo", "--why", "nobody is working on it"], syncEnv());
    const refused = await selfIn(box, demo, ["goal", "add", "one more thing"], syncEnv());

    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /archived/);
});

/* ── J9: the credential is checked before anything is asked ────────── */

test("project J9 short-scopes: a credential without the workspace scopes is refused before any request", async (t) =>
{
    const { box, ws, server } = await connected(t, { scopes: [] });
    const atlas = room(box, ws, "atlas");
    const seen = server.calls.length;
    const refused = await selfIn(box, atlas, ["project", "init", "--name", "atlas", "--no-connect"],
        { ...syncEnv(), SUPERSELF_SYNC: "off" });

    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /self login/);
    assert.equal(server.calls.length, seen, "the workspace was asked about a credential the local check had answered");
    assert.deepEqual(registered(ws), ["demo"]);
});
