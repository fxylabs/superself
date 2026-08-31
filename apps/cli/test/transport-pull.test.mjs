// The pull table, row by row, and what a round trip through the workspace
// leaves behind (#424).
//
// Cells are named for the row they hold — `pull L2 unknown-project` — because
// the table in `puller.ts` is the contract and this file is what says the code
// implements it.
//
// The one property every row of the table shares is asserted in every cell:
// the command ran. A catch-up cannot refuse anything. What the workspace says
// changes what is on disk afterwards and what is said on the way past, and never
// whether the person got their answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { approvedIn, must, mustPerson, workIdIn } from "./harness.mjs";
import {
    ACCOUNT, appends, blocks, connectedMachine, detachedEnv, event, eventually, logRows,
    projectDir, queueAppend, registryRows, sentMarks, syncEnv, unsent
} from "./transport-lib.mjs";

const READ = ["project", "list"];

// A machine deliberately not talking to its workspace. What "offline" is staged
// with everywhere below: a closed socket and a switched-off sync are the same
// thing to everything downstream of the request, and only one of them can be
// turned back on in the middle of a case.
const OFFLINE = { SUPERSELF_DEV: "1", SUPERSELF_SYNC: "off" };

async function connected(t, options = {})
{
    const built = await connectedMachine({ projects: [{ slug: "demo" }], ...options });
    t.after(() => built.server.close());
    return built;
}

// A record put into the workspace by another machine: through the API, so it is
// a record the server would actually have accepted.
async function recordElsewhere(server, slug, one, appendId = `apx_${one.id}`)
{
    const response = await fetch(`${server.url}/api/workspaces/${server.wsId}/projects/${slug}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Superself-Api": "1" },
        body: JSON.stringify({
            events: [{ ...one, event_id: one.id, append_id: appendId, actor_account: ACCOUNT, actor_agent: null }]
        })
    });
    assert.equal(response.status, 200, await response.text());
    return one;
}

function pulls(answer)
{
    return (call) => call.method === "GET" && call.path.endsWith("/events") ? answer : undefined;
}

/* ── L1: the delta arrives ─────────────────────────────────────────── */

test("pull L1 delta: another machine's record lands in the server's copy and is read", async (t) =>
{
    const { box, ws, demo, server } = await connected(t);
    const elsewhere = await recordElsewhere(server, "demo", event({ id: "evt_from_elsewhere" }));
    const listed = await must(box, demo, ["work"], syncEnv());
    assert.deepEqual(logRows(ws).map((row) => row.id), [elsewhere.id], "the server's copy holds it");
    assert.equal(logRows(ws)[0].server_seq, 1, "with the position the server gave it");
    assert.equal(listed.code, 0);
});

test("pull L1 cursor: a second pull asks after the sequence the copy ends at", async (t) =>
{
    const { box, ws, demo, server } = await connected(t);
    await recordElsewhere(server, "demo", event({ id: "evt_one" }));
    await must(box, demo, READ, syncEnv());
    await recordElsewhere(server, "demo", event({ id: "evt_two" }));
    await must(box, demo, READ, syncEnv());
    const asked = server.calls.filter((call) => call.method === "GET" && call.path.endsWith("/events"));
    assert.deepEqual(asked.map((call) => call.query.after), ["0", "1"], "the cursor is the copy's own last row");
    assert.deepEqual(logRows(ws).map((row) => row.id), ["evt_one", "evt_two"], "and nothing is written twice");
});

test("pull L1 tombstone: an append that came back is marked sent and compacted out", async (t) =>
{
    const { box, ws, demo, server } = await connected(t);
    const queued = queueAppend(ws);
    await must(box, demo, READ, syncEnv());
    await must(box, demo, READ, syncEnv());
    assert.equal(unsent(ws).length, 0, "the append is settled");
    assert.equal(appends(ws).length, 0, "and the compaction dropped the settled history");
    assert.deepEqual(logRows(ws).map((row) => row.id), [queued.events[0].id]);
});

test("pull L1 partial: an append only half arrived is not settled", async (t) =>
{
    const { box, ws, demo, server } = await connected(t);
    const pair = [event({ id: "evt_half_one" }), event({ id: "evt_half_two" })];
    const queued = queueAppend(ws, { events: pair });
    // Only the first of the two is in the workspace, which is what a pull cut
    // off mid-record leaves behind.
    await recordElsewhere(server, "demo", pair[0], queued.append_id);
    await must(box, demo, READ, syncEnv({ SUPERSELF_SYNC: "off" }));
    await must(box, demo, ["project", "list"], syncEnv({ SUPERSELF_SYNC: "inline" }));
    assert.equal(sentMarks(ws).length, 0, "an append is one transaction, so half of it settles nothing");
    assert.equal(unsent(ws).length, 1, "and it is still on its way");
});

test("pull L1 refold: what arrived is in the folded state without a second command", async (t) =>
{
    const { box, ws, demo, server } = await connected(t);
    // Recorded by a second machine through the verb that records it, so what
    // arrives is the record the workspace would really hold rather than this
    // cell's idea of one.
    const other = await connectedMachine({ server });
    await mustPerson(other.box, other.demo, ["goal", "add", "one shared direction"], syncEnv());
    await must(box, demo, READ, syncEnv());
    assert.match(readFileSync(join(projectDir(ws), "state.md"), "utf8"), /one shared direction/,
        "the fold ran on what the pull brought in, with no second command");
});

test("pull L1 after-a-crash: a copy written without its mark is settled by the next pull", async (t) =>
{
    const { box, ws, demo, server } = await connected(t);
    const queued = queueAppend(ws);
    await must(box, demo, READ, syncEnv());
    // What a machine that died between writing the copy and writing the mark
    // leaves behind: the record is in `log.jsonl`, and the queue still says it
    // has not gone.
    const arrived = server.eventsIn("demo");
    writeFileSync(join(projectDir(ws), "log.jsonl"), arrived.map((row) => JSON.stringify(row) + "\n").join(""));
    assert.equal(unsent(ws).length, 1);

    // The next pull asks after the sequence the copy now ends at and gets
    // nothing back. The mark still goes down, because it is decided by reading
    // the copy rather than by remembering what a pull happened to receive.
    await must(box, demo, READ, syncEnv());
    const asked = server.calls.filter((call) => call.method === "GET" && call.path.endsWith("/events")).pop();
    assert.equal(asked.query.after, String(arrived.length), "it asked from where the file ends");
    assert.equal(unsent(ws).length, 0, "and settled the append off the ids already in the file");
    assert.equal(logRows(ws).filter((row) => row.id === queued.events[0].id).length, 1, "nothing was written twice");
});

/* ── L2 to L5: the command runs anyway ─────────────────────────────── */

test("pull L2 unknown-project: a 404 lets the command through and names the remedy", async (t) =>
{
    const { box, ws, demo, server } = await connected(t, { projects: [] });
    const ran = await must(box, demo, ["work"], syncEnv());
    assert.equal(ran.code, 0, "a workspace that will not answer does not refuse a read");
    assert.match(ran.out, /no project "demo" for this machine/);
    assert.match(ran.out, /self login/);
});

test("pull L3 version-mismatch: a 426 lets the command through and says to update", async (t) =>
{
    const { box, ws, demo, server } = await connected(t, {
        answer: pulls({ status: 426, body: { code: "api_version_mismatch" } })
    });
    const ran = await must(box, demo, ["work"], syncEnv());
    assert.equal(ran.code, 0);
    assert.match(ran.out, /newer API than this CLI/);
});

test("pull L4 not-ready: a 503 is not waited out — a read cannot be deferred", async (t) =>
{
    const { box, ws, demo, server } = await connected(t, {
        answer: pulls({ status: 503, headers: { "retry-after": "30" }, body: { code: "not_ready" } })
    });
    const began = Date.now();
    const ran = await must(box, demo, ["work"], syncEnv());
    assert.ok(Date.now() - began < 5_000, "the command waited on a header it should have ignored");
    assert.equal(server.calls.filter((call) => call.method === "GET" && call.path.endsWith("/events")).length, 1,
        "asked once, and not again");
    assert.match(ran.out, /not ready yet/);
});

test("pull L5 other: an answer the table has no row for lets the command through with one line", async (t) =>
{
    const { box, ws, demo, server } = await connected(t, { answer: pulls({ status: 500, body: { code: "internal" } }) });
    const ran = await must(box, demo, ["work"], syncEnv());
    assert.equal(ran.code, 0);
    assert.match(ran.out, /answered 500/);
});

test("pull L5 offline: a workspace nothing answers on reads locally and says so once", async (t) =>
{
    const { box, ws, demo, server } = await connected(t);
    await server.close();
    const ran = await must(box, demo, ["work"], syncEnv());
    assert.equal(ran.code, 0);
    assert.equal(ran.out.match(/could not reach its workspace/g)?.length, 1, "said once, for one project");
});

test("pull L5 unparseable: a refusal whose body is not JSON is still read off its status", async (t) =>
{
    const { box, ws, demo, server } = await connected(t, {
        answer: pulls({ status: 403, body: undefined, headers: { "content-type": "text/html" } })
    });
    const ran = await must(box, demo, ["work"], syncEnv());
    assert.match(ran.out, /answered 403/, "a body nothing can read is not a server nothing could reach");
    assert.doesNotMatch(ran.out, /could not reach/);
});

test("pull L5 hung: a request that gets no answer at all ends and the command runs", { timeout: 60_000 }, async (t) =>
{
    // The slow cell of the suite, and the only way to assert the distinction it
    // is about: a socket that stays open and answers nothing is not a status,
    // and a client that waited on it forever would be a CLI a workspace could
    // hang by saying nothing.
    const { box, ws, demo, server } = await connected(t, {
        answer: (call) => call.method === "GET" && call.path.endsWith("/events") ? { hang: true } : undefined
    });
    const ran = await must(box, demo, ["work"], syncEnv());
    assert.equal(ran.code, 0);
    assert.match(ran.out, /could not reach its workspace/, "a timeout leaves the same question open as a refused socket");
});

/* ── V7: what a background push had no way to say ──────────────────── */

test("blocked surfaced: the next command says it once and never again", async (t) =>
{
    const { box, ws, demo, server } = await connected(t, {
        answer: (call) => call.method === "POST" && call.path.endsWith("/events")
            ? { status: 403, body: { code: "forbidden", message: "this grant may not write here" } }
            : undefined
    });
    queueAppend(ws);
    const first = await must(box, demo, READ, syncEnv());
    assert.equal(blocks(ws).length, 1, "the push recorded the refusal");
    const second = await must(box, demo, READ, syncEnv());
    const third = await must(box, demo, READ, syncEnv());
    assert.match(second.out, /not going to the workspace/, "the next command with somewhere to print says it");
    assert.doesNotMatch(third.out, /not going to the workspace/, "and the one after that does not");
    assert.doesNotMatch(first.out, /not going to the workspace/,
        "not the command that recorded it — the refusal arrived after its output was decided");
});

test("blocked skipped: a blocked append is not sent again by any later push", async (t) =>
{
    const { box, ws, demo, server } = await connected(t, {
        answer: (call, state, nth) => call.method === "POST" && call.path.endsWith("/events") && nth < 3
            ? { status: 403, body: { code: "forbidden", message: "no" } }
            : undefined
    });
    queueAppend(ws);
    await must(box, demo, READ, syncEnv());
    const after = server.calls.filter((call) => call.method === "POST" && call.path.endsWith("/events")).length;
    await must(box, demo, READ, syncEnv());
    await must(box, demo, READ, syncEnv());
    assert.equal(server.calls.filter((call) => call.method === "POST" && call.path.endsWith("/events")).length, after,
        "a refusal that may not be retried is not retried");
});

/* ── V2: two machines, one fold ────────────────────────────────────── */

test("round trip: a record made while offline reaches a second machine and folds the same", async (t) =>
{
    const { box, ws, demo, server } = await connected(t);
    // Offline: nothing is sent, and the record is made anyway.
    const work = workIdIn((await mustPerson(box, demo, ["work", "add", "ship the transport"], OFFLINE)).out);
    assert.equal(server.calls.length, 0, "nothing crossed the wire");
    assert.equal(unsent(ws).length, 1, "and the record is in the queue and nowhere else");

    // Back on the network.
    await must(box, demo, READ, syncEnv());
    assert.equal(server.eventsIn("demo").length, 1, "the workspace has it now");

    // A second machine, which has never seen the record.
    const other = await connectedMachine({ server });
    await must(other.box, other.demo, READ, syncEnv());
    assert.match((await must(other.box, other.demo, ["work"], syncEnv())).out, /ship the transport/,
        "the second machine reads the first machine's work");
    assert.equal(logRows(other.ws).length, 1, "off the server's copy, in the server's order");
    assert.equal(unsent(other.ws).length, 0, "and it has nothing of its own to send");
});

/* ── V8: a late-arriving ending ────────────────────────────────────── */

test("late ending: a retire arriving after a done converges and both stay in the history", async (t) =>
{
    const { box, ws, demo, server } = await connected(t);
    const work = workIdIn((await mustPerson(box, demo, ["work", "add", "a contested unit"], syncEnv())).out);
    await must(box, demo, ["work", "start", work], syncEnv());

    // A second machine, caught up to the unit being under way and no further.
    const other = await connectedMachine({ server });
    await must(other.box, other.demo, READ, syncEnv());

    // The first machine finishes it.
    await must(box, demo, ["report", work, "the work landed"], syncEnv());
    await must(box, demo, ["work", "done", work, "--report", "landed and verified"], syncEnv());
    await must(box, demo, READ, syncEnv());

    // The second gives it up, knowing nothing of that, and its record arrives
    // after. `OFFLINE` is what keeps it from learning first — a machine that
    // caught up would not be the case this cell is about.
    await approvedIn(other.box, other.demo, ["work", "retire", work, "--why", "given up on the other machine"], work, OFFLINE);
    await must(other.box, other.demo, READ, syncEnv());
    assert.ok(server.eventsIn("demo").some((row) => row.type === "entity.retired"), "the workspace took the later record");

    await must(box, demo, READ, syncEnv());

    // The fold's rule decides, and its rule is that the first ending is the
    // ending: a line merged from a machine that had not seen the completion
    // cannot reopen the unit. So the two machines converge — on the same
    // answer, not on the later one — and the record that lost is in the log on
    // both of them rather than dropped.
    assert.match((await must(box, demo, ["work", "show", work], syncEnv())).out, /Status: done/);
    assert.match((await must(other.box, other.demo, ["work", "show", work], syncEnv())).out, /Status: done/,
        "the machine that gave it up reads the same state as the machine that finished it");
    assert.match((await must(box, demo, ["log", "-n", "10"], syncEnv())).out, /entity\.retired.*given up on the other machine/,
        "and what it recorded is visible contention rather than a silent loss");
    assert.deepEqual(logRows(ws).map((row) => row.server_seq), [...Array(logRows(ws).length).keys()].map((n) => n + 1),
        "one gapless order, the workspace's own");
});

/* ── the workspace's own project list ──────────────────────────────── */

test("registry reconciled: another machine's project shows up in this one's list", async (t) =>
{
    const { box, ws, demo, server } = await connected(t, {
        projects: [{ slug: "demo" }, { slug: "made-elsewhere", description: "another machine's" }]
    });
    await must(box, demo, READ, syncEnv());
    const row = registryRows(ws).find((entry) => entry.slug === "made-elsewhere");
    assert.ok(row !== undefined, "the project is registered here now");
    assert.equal(row.description, "another machine's", "with the workspace's description");
    assert.equal(row.id, "prj_2", "and the server's own id cached");
});

test("registry kept: a project this machine still has records for is never unregistered", async (t) =>
{
    const { box, ws, demo, server } = await connected(t);
    await must(box, demo, READ, syncEnv());
    server.state.projects.delete("demo");
    queueAppend(ws);
    await must(box, demo, READ, syncEnv());
    assert.ok(registryRows(ws).some((entry) => entry.slug === "demo"),
        "records in a queue nothing iterates would be records nothing could ever send or say");
});

test("registry dropped: a project deleted elsewhere with nothing queued leaves this machine's list", async (t) =>
{
    const { box, ws, demo, server } = await connected(t, { projects: [{ slug: "demo" }, { slug: "spare" }] });
    await must(box, demo, READ, syncEnv());
    assert.ok(registryRows(ws).some((entry) => entry.slug === "spare"));
    server.state.projects.delete("spare");
    await must(box, demo, READ, syncEnv());
    assert.ok(!registryRows(ws).some((entry) => entry.slug === "spare"));
});

/* ── the process the command leaves behind ─────────────────────────── */

test("detached push: the sending outlives the command that queued it", async (t) =>
{
    const { box, ws, demo, server } = await connected(t);
    const queued = queueAppend(ws);
    await must(box, demo, READ, detachedEnv());
    await eventually(() => server.eventsIn("demo").length === 1,
        "the process the command left behind sent the queue");
    assert.deepEqual(server.eventsIn("demo").map((row) => row.event_id), [queued.events[0].id]);
});

test("nothing queued: a command with an empty queue starts no process at all", async (t) =>
{
    const { box, ws, demo, server } = await connected(t);
    await must(box, demo, READ, detachedEnv());
    assert.equal(server.calls.filter((call) => call.method === "POST").length, 0);
});

/* ── the machine that is deliberately alone ────────────────────────── */

test("sync off: a machine told not to talks to nothing and still records and reads", async (t) =>
{
    const { box, ws, demo, server } = await connected(t);
    await mustPerson(box, demo, ["work", "add", "recorded while alone"], { SUPERSELF_SYNC: "off" });
    assert.equal(server.calls.length, 0, "not one request");
    assert.equal(unsent(ws).length, 1, "and the record is queued for when it is allowed to");
});
