// The push table, row by row (#424).
//
// Every cell is named for the row it holds — `push P6 unknown-project` — because
// the table in `pusher.ts` is the contract and this file is what says the code
// implements it. A row with no cell is a path nothing proves.
//
// The staging is always the same shape: a queued append that has not gone, a
// command that runs and sends before it returns, and an assertion about the two
// files this machine keeps. What varies is what the workspace server answers,
// and that comes from the contract mock — which implements the contract and
// nothing else, so a case needing an answer the contract has no state for stages
// it explicitly rather than teaching the mock a behaviour the server lacks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { must, selfIn } from "./harness.mjs";
import {
    ACCOUNT, appends, blocks, connectedMachine, event, logRows, queueAppend,
    registryRows, sentMarks, syncEnv, unsent
} from "./transport-lib.mjs";

// Anything that is not a write. A cell about the push must not have its own
// command adding a second append to the queue it is asserting about.
const READ = ["project", "list"];

// A staged answer for the pushes only. The pull and the project list that a
// command also makes are the mock's own business, and a case that answered them
// too would be staging the whole conversation rather than the one turn it is
// about.
function pushes(...staged)
{
    let seen = 0;
    return (call) =>
    {
        if (call.method !== "POST" || !call.path.endsWith("/events"))
        {
            return undefined;
        }
        seen += 1;
        return staged[seen - 1];
    };
}

// Registered for closing whatever the case does. A loopback server left
// listening holds the whole run open, so a failing assertion would turn one red
// cell into a suite that never finishes — which hides every cell after it.
async function connected(t, options = {})
{
    const built = await connectedMachine({ projects: [{ slug: "demo" }], ...options });
    t.after(() => built.server.close());
    return built;
}

/* ── P1: the server took it ────────────────────────────────────────── */

test("push P1 accepted: a queued append reaches the server and nothing local changes", async (t) =>
{
    const { box, ws, demo, server } = await connected(t);
    const queued = queueAppend(ws);
    await must(box, demo, READ, syncEnv());
    assert.deepEqual(server.eventsIn("demo").map((row) => row.event_id), [queued.events[0].id],
        "the server holds the record");
    assert.equal(sentMarks(ws).length, 0, "a 200 writes no mark — the pull does that");
    assert.equal(blocks(ws).length, 0, "and nothing is blocked");
    assert.equal(logRows(ws).length, 0, "the server's copy is written by the pull, which ran before the push");
});

test("push P1 tombstone: the next command's pull brings it back and settles the append", async (t) =>
{
    const { box, ws, demo, server } = await connected(t);
    const queued = queueAppend(ws);
    await must(box, demo, READ, syncEnv());
    await must(box, demo, READ, syncEnv());
    assert.deepEqual(logRows(ws).map((row) => row.id), [queued.events[0].id], "the server's copy now holds it");
    assert.equal(appends(ws).length, 0, "and the append it settles is out of the queue");
});

test("push P1 duplicates: re-sending an append the server already has is absorbed", async (t) =>
{
    const { box, ws, demo, server } = await connected(t);
    queueAppend(ws);
    await must(box, demo, READ, syncEnv());
    // The queue still holds it — the mark is the pull's — so the next command
    // sends it again, and the server counts it rather than storing it twice.
    await selfIn(box, demo, READ, syncEnv());
    assert.equal(server.eventsIn("demo").length, 1, "one record, however many times it was sent");
});

/* ── P2, P3: refused as a bad request ──────────────────────────────── */

test("push P2 actor-mismatch: an append written by another account is blocked and says so", async (t) =>
{
    const { box, ws, demo, server } = await connected(t);
    const queued = queueAppend(ws, { events: [event({ account: "acct_01J8SOMEBODYELSE" })] });
    await must(box, demo, READ, syncEnv());
    const blocked = blocks(ws);
    assert.equal(blocked.length, 1, "the append stops");
    assert.equal(blocked[0].blocked, queued.append_id);
    assert.equal(blocked[0].code, "actor_mismatch", "the code is the one the server named");
    assert.equal(unsent(ws).length, 0, "and it is out of what is still to send");
});

test("push P3 bad-request: a 400 with no code of its own blocks the append too", async (t) =>
{
    const { box, ws, demo, server } = await connected(t, {
        answer: pushes({ status: 400, body: { code: "invalid_request", message: "an event is missing a field" } })
    });
    queueAppend(ws);
    await must(box, demo, READ, syncEnv());
    assert.equal(blocks(ws)[0]?.code, "invalid_request");
    assert.match(blocks(ws)[0]?.detail ?? "", /missing a field/, "the server's own words reach the row");
});

/* ── P4: one append disagrees, the rest go ─────────────────────────── */

test("push P4 conflict: the batch is re-sent one append at a time and only the clashing one stops", async (t) =>
{
    // The refusal is staged rather than provoked. What this cell is about is
    // the split — a batch the server rejected whole, re-sent one append at a
    // time — and the mock's own conflict detection is the next cell's subject.
    const bad = "apx_disagrees";
    const { box, ws, demo, server } = await connected(t, {
        answer: (call) => call.method === "POST" && call.path.endsWith("/events")
            && call.body.events.some((one) => one.append_id === bad)
            ? { status: 409, body: { code: "event_conflict", message: "already recorded differently" } }
            : undefined
    });
    queueAppend(ws, { appendId: bad, events: [event({ id: "evt_conflicted" })] });
    const good = queueAppend(ws, { appendId: "apx_agrees", events: [event({ id: "evt_innocent" })] });
    await must(box, demo, READ, syncEnv());
    assert.deepEqual(blocks(ws).map((row) => row.blocked), [bad], "only the append that clashed");
    assert.deepEqual(server.eventsIn("demo").map((row) => row.event_id), ["evt_innocent"],
        "the append behind it was not held up by it");
    assert.deepEqual(unsent(ws).map((row) => row.append_id), [good.append_id],
        "and the one that went is still queued until a pull settles it");
});

test("push P4 other-stream: the same event id on another project's log is a conflict, not a duplicate", async (t) =>
{
    const { box, ws, demo, server } = await connected(t, { projects: [{ slug: "demo" }, { slug: "other" }] });
    const shared = event({ id: "evt_two_streams" });
    await push(server, "other", [shared]);
    const queued = queueAppend(ws, { events: [shared] });
    await must(box, demo, READ, syncEnv());
    assert.equal(blocks(ws)[0]?.blocked, queued.append_id, "the stream is part of what makes two records the same");
    assert.equal(server.eventsIn("demo").length, 0);
});

/* ── P5: the batch was too big ─────────────────────────────────────── */

test("push P5 too-large: a 413 splits the batch on append boundaries and each one goes", async (t) =>
{
    // The first request carries both appends and is refused for its size; the
    // mock answers the re-sends itself, which is the point — the split is what
    // gets them through.
    const { box, ws, demo, server } = await connected(t, {
        answer: pushes({ status: 413, body: { code: "too_large", message: "split this batch" } })
    });
    const first = queueAppend(ws, { events: [event({ id: "evt_first" })] });
    const second = queueAppend(ws, { events: [event({ id: "evt_second" })] });
    await must(box, demo, READ, syncEnv());
    assert.deepEqual(server.eventsIn("demo").map((row) => row.event_id), ["evt_first", "evt_second"],
        "both appends arrive, in the order they were made");
    assert.equal(blocks(ws).length, 0, "and neither is blocked");
    assert.deepEqual(unsent(ws).map((row) => row.append_id), [first.append_id, second.append_id]);
});

test("push P5 unsplittable: a single append the server still calls too large stops rather than looping", async (t) =>
{
    const { box, ws, demo, server } = await connected(t, {
        answer: pushes({ status: 413, body: { code: "too_large", message: "over the limit" } })
    });
    queueAppend(ws);
    await must(box, demo, READ, syncEnv());
    assert.equal(blocks(ws)[0]?.code, "too_large", "there is nothing left to split, so it is the append's own refusal");
    assert.equal(server.calls.filter((call) => call.method === "POST").length, 1, "and it was sent once");
});

/* ── P6: the server has no such project ────────────────────────────── */

test("push P6 unknown-project: a project this machine made is created once and the records follow", async (t) =>
{
    const { box, ws, demo, server } = await connected(t, { projects: [] });
    const queued = queueAppend(ws);
    await must(box, demo, READ, syncEnv());
    assert.equal(server.projectId("demo"), "prj_1", "the project was created");
    assert.deepEqual(server.eventsIn("demo").map((row) => row.event_id), [queued.events[0].id],
        "and the queue went straight after it");
    assert.equal(registryRows(ws).find((row) => row.slug === "demo")?.id, "prj_1",
        "the server's id is cached, so this is never done twice");
    assert.equal(blocks(ws).length, 0);
});

test("push P6 deleted-elsewhere: a project whose id is cached is never re-created", async (t) =>
{
    const { box, ws, demo, server } = await connected(t, { projects: [{ slug: "demo", id: "prj_gone" }] });
    // The workspace listed it, so the id is cached; then it is removed from the
    // server, which is what another machine deleting it looks like from here.
    await must(box, demo, READ, syncEnv());
    server.state.projects.delete("demo");
    server.state.log.delete("demo");
    const queued = queueAppend(ws);
    await must(box, demo, READ, syncEnv());
    assert.equal(blocks(ws)[0]?.blocked, queued.append_id);
    assert.equal(blocks(ws)[0]?.code, "unknown_project");
    assert.equal(server.calls.filter((call) => call.method === "POST" && call.path.endsWith("/projects")).length, 0,
        "nothing tried to raise a project somebody deliberately removed");
});

test("push P6 slug-taken: a creation refused for the name says the project exists and is out of reach", async (t) =>
{
    // The slug is occupied by a project this machine is not a member of: the
    // push and the listing both answer the concealing 404, and the creation is
    // the one answer that admits the name is taken. The mock holds no
    // membership, so that one answer is staged; that the mock refuses a genuinely
    // taken slug the same way is `mock slug-taken`.
    const { box, ws, demo, server } = await connected(t, {
        projects: [],
        answer: (call) => call.method === "POST" && call.path.endsWith("/projects")
            ? { status: 409, body: { code: "slug_taken", message: "this workspace already has a project \"demo\"" } }
            : undefined
    });
    queueAppend(ws);
    await must(box, demo, READ, syncEnv());
    assert.equal(blocks(ws)[0]?.code, "project_taken");
    assert.match(blocks(ws)[0]?.detail ?? "", /ask an owner/);
});

test("push P6 creation-denied: a creation the workspace refuses points at logging in again", async (t) =>
{
    const { box, ws, demo, server } = await connected(t, {
        projects: [],
        answer: (call) => call.method === "POST" && call.path.endsWith("/projects")
            ? { status: 404, body: { code: "not_found", message: "no such workspace" } }
            : undefined
    });
    queueAppend(ws);
    await must(box, demo, READ, syncEnv());
    assert.equal(blocks(ws)[0]?.code, "project_denied");
    assert.match(blocks(ws)[0]?.detail ?? "", /self login/);
});

/* ── P7: this CLI is out of date ───────────────────────────────────── */

test("push P7 version-mismatch: a 426 leaves the append queued rather than blocking it", async (t) =>
{
    const { box, ws, demo, server } = await connected(t, {
        answer: pushes({ status: 426, body: { code: "api_version_mismatch", message: "update the CLI" } })
    });
    const queued = queueAppend(ws);
    await must(box, demo, READ, syncEnv());
    assert.equal(blocks(ws).length, 0, "a CLI that is out of date is not a record that is wrong");
    assert.deepEqual(appends(ws).map((row) => row.append_id), [queued.append_id], "it waits for a newer CLI");
});

/* ── P8: every other refusal ───────────────────────────────────────── */

test("push P8 other-4xx: a refusal this CLI has no name for is blocked and carries the server's words", async (t) =>
{
    const { box, ws, demo, server } = await connected(t, {
        answer: pushes({ status: 403, body: { code: "forbidden", message: "this grant may not write here" } })
    });
    queueAppend(ws);
    await must(box, demo, READ, syncEnv());
    assert.equal(blocks(ws)[0]?.code, "http_403");
    assert.match(blocks(ws)[0]?.detail ?? "", /may not write here/);
});

/* ── P9: the workspace is not ready yet ────────────────────────────── */

test("push P9 retry-after: a 503 is waited out once and the second attempt goes", async (t) =>
{
    const { box, ws, demo, server } = await connected(t, {
        answer: pushes({ status: 503, headers: { "retry-after": "0" }, body: { code: "not_ready" } })
    });
    const queued = queueAppend(ws);
    await must(box, demo, READ, syncEnv());
    assert.equal(server.calls.filter((call) => call.method === "POST").length, 2, "sent, waited, sent again");
    assert.deepEqual(server.eventsIn("demo").map((row) => row.event_id), [queued.events[0].id]);
    assert.equal(blocks(ws).length, 0);
});

test("push P9 still-not-ready: a second 503 leaves the append queued and unblocked", async (t) =>
{
    const { box, ws, demo, server } = await connected(t, {
        answer: (call) => call.method === "POST" && call.path.endsWith("/events")
            ? { status: 503, headers: { "retry-after": "0" }, body: { code: "not_ready" } }
            : undefined
    });
    const queued = queueAppend(ws);
    await must(box, demo, READ, syncEnv());
    assert.equal(server.calls.filter((call) => call.method === "POST").length, 2, "one wait, and no more");
    assert.equal(blocks(ws).length, 0);
    assert.deepEqual(appends(ws).map((row) => row.append_id), [queued.append_id]);
});

/* ── P10: the server is down, or this machine is offline ───────────── */

test("push P10 server-error: a 500 leaves the append queued with nothing said", async (t) =>
{
    const { box, ws, demo, server } = await connected(t, {
        answer: pushes({ status: 500, body: { code: "internal" } })
    });
    const queued = queueAppend(ws);
    const ran = await must(box, demo, READ, syncEnv());
    assert.equal(blocks(ws).length, 0);
    assert.deepEqual(appends(ws).map((row) => row.append_id), [queued.append_id]);
    assert.doesNotMatch(ran.out, /500/, "a server having a bad day is not this command's news");
});

test("push P10 connection-dropped: a socket that dies mid-request leaves the append queued", async (t) =>
{
    const { box, ws, demo, server } = await connected(t, { answer: pushes({ destroy: true }) });
    const queued = queueAppend(ws);
    await must(box, demo, READ, syncEnv());
    assert.equal(blocks(ws).length, 0, "an unknown outcome is not a refusal");
    assert.deepEqual(appends(ws).map((row) => row.append_id), [queued.append_id]);
});

test("push P10 unreachable: a workspace at an address nothing answers on leaves the queue whole", async (t) =>
{
    const { box, ws, demo, server } = await connected(t);
    const queued = queueAppend(ws);
    await server.close();
    await must(box, demo, READ, syncEnv());
    assert.equal(blocks(ws).length, 0);
    assert.deepEqual(appends(ws).map((row) => row.append_id), [queued.append_id]);
});

/* ── seeding the server ────────────────────────────────────────────── */

// A record the workspace already holds when the CLI first speaks to it, put
// there through the API itself rather than into the mock's map: a case that
// reached past the API would be asserting against records the server would
// never have accepted.
async function push(server, slug, events)
{
    const response = await fetch(`${server.url}/api/workspaces/${server.wsId}/projects/${slug}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Superself-Api": "1" },
        body: JSON.stringify({
            events: events.map((one) => ({
                ...one,
                event_id: one.id,
                append_id: `apx_seed_${one.id}`,
                actor_account: one.actor?.account ?? ACCOUNT,
                actor_agent: null
            }))
        })
    });
    assert.equal(response.status, 200, await response.text());
}

// Named so a reader of a failure knows which directory the queue is in.
export function queueFile(ws, slug = "demo")
{
    return join(projectDir(ws, slug), "pending.jsonl");
}
