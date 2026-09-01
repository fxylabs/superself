// The contract mock's own contract (#424).
//
// Every table in the two transport suites is asserted against this server, so a
// mock that is kinder, stricter or simply different from the real one would
// make those suites green about nothing. These cells are what say it is the
// thing the contract describes: the idempotence rule, the conflict rule and the
// author rule, the limits, and the order the checks run in.
//
// They talk to it over HTTP rather than through the CLI, because the subject is
// the server and not the client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { workspaceServer } from "./workspace-server.mjs";

const ACCOUNT = "acct_01J8TRANSPORT";

async function serving(t, options = {})
{
    const server = await workspaceServer({ account: ACCOUNT, projects: [{ slug: "demo" }], ...options });
    t.after(() => server.close());
    return server;
}

function wire(options = {})
{
    return {
        event_id: options.id ?? "evt_one",
        append_id: options.appendId ?? "apx_one",
        ts: "2026-08-31T00:00:00.000Z",
        type: options.type ?? "entity.confirmed",
        actor_account: options.account ?? ACCOUNT,
        actor_agent: null,
        payload: options.payload ?? { text: "a record" }
    };
}

async function call(server, method, path, options = {})
{
    const response = await fetch(`${server.url}/api/workspaces/${options.wsId ?? server.wsId}${path}`, {
        method,
        headers: {
            "content-type": "application/json",
            ...(options.version === null ? {} : { "X-Superself-Api": options.version ?? "1" })
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    return { status: response.status, body: await response.json().catch(() => null) };
}

function push(server, slug, events, extra = {})
{
    return call(server, "POST", `/projects/${slug}/events`, { body: { events, ...extra } });
}

/* ── the version header ────────────────────────────────────────────── */

test("mock version-required: a request with no version header is 426", async (t) =>
{
    const server = await serving(t);
    assert.equal((await call(server, "GET", "/projects", { version: null })).status, 426);
});

test("mock version-first: the version is checked before anything is concealed", async (t) =>
{
    const server = await serving(t);
    // A workspace this caller may not see, asked for with the wrong version.
    // The version answer wins, which is the stated priority — a client that got
    // a 404 here would never learn why its requests stopped working.
    const answered = await call(server, "GET", "/projects", { version: "2", wsId: "ws_somebody_else" });
    assert.equal(answered.status, 426);
});

/* ── concealment ───────────────────────────────────────────────────── */

test("mock concealment: another workspace, an absent project and an unknown route are one 404", async (t) =>
{
    const server = await serving(t);
    const answers = [
        await call(server, "GET", "/projects", { wsId: "ws_somebody_else" }),
        await call(server, "GET", "/projects/never-made/events?after=0"),
        await call(server, "GET", "/projects/demo/nothing-here")
    ];
    assert.deepEqual(answers.map((one) => one.status), [404, 404, 404]);
    assert.deepEqual([...new Set(answers.map((one) => one.body.code))], ["not_found"],
        "and nothing in the body tells them apart");
});

/* ── V3: idempotence, conflict, author ─────────────────────────────── */

test("mock resend-identical: the same batch sent twice stores one record and counts a duplicate", async (t) =>
{
    const server = await serving(t);
    const first = await push(server, "demo", [wire()]);
    const again = await push(server, "demo", [wire()]);
    assert.deepEqual([first.body.accepted, first.body.duplicates], [1, 0]);
    assert.deepEqual([again.body.accepted, again.body.duplicates], [0, 1]);
    assert.equal(server.eventsIn("demo").length, 1);
    assert.equal(again.body.head_seq.project, 1, "and the head did not move");
});

test("mock resend-changed: the same event id with a different payload refuses the whole batch", async (t) =>
{
    const server = await serving(t);
    await push(server, "demo", [wire()]);
    const changed = await push(server, "demo", [
        wire({ id: "evt_new" }),
        wire({ payload: { text: "something else" } })
    ]);
    assert.equal(changed.status, 409);
    assert.equal(changed.body.code, "event_conflict");
    assert.equal(server.eventsIn("demo").length, 1, "a batch is one transaction — the innocent event did not land");
});

test("mock resend-other-stream: the same event id on another project's log is a conflict", async (t) =>
{
    const server = await serving(t, { projects: [{ slug: "demo" }, { slug: "other" }] });
    await push(server, "other", [wire()]);
    const elsewhere = await push(server, "demo", [wire()]);
    assert.equal(elsewhere.status, 409, "which log a record belongs to is decided by the path it arrived on");
    assert.equal(server.eventsIn("demo").length, 0);
});

test("mock author: an event naming an account other than the sender is 400 with a code", async (t) =>
{
    const server = await serving(t);
    const refused = await push(server, "demo", [wire({ account: "acct_someone_else" })]);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "actor_mismatch", "the one 400 a client has to tell from the others");
});

test("mock schema: a 400 for a missing field carries no such code", async (t) =>
{
    const server = await serving(t);
    const refused = await push(server, "demo", [{ ...wire(), type: undefined }]);
    assert.equal(refused.status, 400);
    assert.notEqual(refused.body.code, "actor_mismatch");
});

/* ── the limits ────────────────────────────────────────────────────── */

test("mock batch-count: more than a thousand events in one batch is 413", async (t) =>
{
    const server = await serving(t);
    const many = Array.from({ length: 1001 }, (unused, index) => wire({ id: `evt_${index}` }));
    assert.equal((await push(server, "demo", many)).status, 413);
    assert.equal(server.eventsIn("demo").length, 0);
});

test("mock event-size: one event over 256KB is 413", async (t) =>
{
    const server = await serving(t);
    const huge = wire({ payload: { text: "x".repeat(257 * 1024) } });
    assert.equal((await push(server, "demo", [huge])).status, 413);
});

test("mock size-before-author: an oversized batch by the wrong author is 413, not 400", async (t) =>
{
    const server = await serving(t);
    const many = Array.from({ length: 1001 }, (unused, index) => wire({ id: `evt_${index}`, account: "acct_someone_else" }));
    assert.equal((await push(server, "demo", many)).status, 413, "the limit is checked before the author");
});

/* ── the project id ────────────────────────────────────────────────── */

test("mock expected-project: a push naming a project id the slug no longer has is 404", async (t) =>
{
    const server = await serving(t);
    const stale = await push(server, "demo", [wire()], { expected_project: "prj_from_before" });
    assert.equal(stale.status, 404, "a slug remade by somebody else is a different project");
    assert.equal((await push(server, "demo", [wire()], { expected_project: server.projectId("demo") })).status, 200);
});

/* ── creating a project ────────────────────────────────────────────── */

test("mock create: a new slug is 201 and answers with the id the CLI caches", async (t) =>
{
    const server = await serving(t, { projects: [] });
    const made = await call(server, "POST", "/projects", { body: { slug: "fresh", description: "made here" } });
    assert.equal(made.status, 201);
    assert.equal(made.body.slug, "fresh");
    assert.equal(made.body.description, "made here");
    assert.ok(typeof made.body.id === "string" && made.body.id !== "");
});

test("mock slug-taken: creating a slug the workspace already holds is 409", async (t) =>
{
    const server = await serving(t);
    const taken = await call(server, "POST", "/projects", { body: { slug: "demo" } });
    assert.equal(taken.status, 409, "a member is allowed to learn that a name is occupied");
    assert.equal(taken.body.code, "slug_taken");
});

test("mock create-elsewhere: creating in a workspace this caller cannot see is the concealing 404", async (t) =>
{
    const server = await serving(t);
    const denied = await call(server, "POST", "/projects", { wsId: "ws_somebody_else", body: { slug: "fresh" } });
    assert.equal(denied.status, 404);
});

/* ── the delta ─────────────────────────────────────────────────────── */

test("mock delta: a pull answers everything after the cursor, in order, with the head", async (t) =>
{
    const server = await serving(t);
    await push(server, "demo", [wire({ id: "evt_a" }), wire({ id: "evt_b" })]);
    await push(server, "demo", [wire({ id: "evt_c", appendId: "apx_two" })]);
    const all = await call(server, "GET", "/projects/demo/events?after=0");
    assert.deepEqual(all.body.events.map((one) => one.event_id), ["evt_a", "evt_b", "evt_c"]);
    assert.deepEqual(all.body.events.map((one) => one.server_seq), [1, 2, 3], "gapless, and the order of acceptance");
    assert.equal(all.body.head_seq.project, 3);
    const rest = await call(server, "GET", "/projects/demo/events?after=2");
    assert.deepEqual(rest.body.events.map((one) => one.event_id), ["evt_c"]);
});

test("mock listing: the project list carries every project's server id", async (t) =>
{
    const server = await serving(t, { projects: [{ slug: "demo" }, { slug: "other", description: "the second" }] });
    const listed = await call(server, "GET", "/projects");
    assert.deepEqual(listed.body.map((one) => one.slug), ["demo", "other"]);
    assert.ok(listed.body.every((one) => typeof one.id === "string"));
});
