// The Workspace API, as far as this repository's tests need it to exist.
//
// It answers on loopback and implements the semantics of the checked-in
// contract — `X-Superself-Api` on every request, one indistinguishable 404 for
// everything hidden, idempotent event push, delta pull by server sequence, and
// the three answers project creation has. It exists so the CLI's own tables can
// be asserted against something that behaves like the thing they are about,
// rather than against a stub that returns whatever a case asked for.
//
// Two rules govern what goes in here, and both are about the same danger — a
// mock that is kinder, stricter or simply different from the server, so that a
// green suite says nothing about the real thing:
//
//   1. Nothing is implemented that the contract does not state. Where a case
//      needs an answer the contract has no rule for, the case injects it
//      (`answer`) rather than this file growing a behaviour.
//   2. The order the checks run in is the contract's stated priority, first
//      match wins: 426, then the concealing 404, then 503, then 413, then 400,
//      then 409. A mock that checked in a different order would let the CLI
//      pass on a precedence the server does not have.
//
// State is per-server and in memory: projects, and one gapless sequence of
// events per project.
import { createServer } from "node:http";

export const API_VERSION = "1";

// The contract's limits. Stated here because this is the side that enforces
// them; the CLI carries the same numbers and refuses an oversized append where
// it is made, which is a different guarantee about the same numbers.
export const MAX_BATCH_EVENTS = 1000;
export const MAX_BATCH_BYTES = 1024 * 1024;
export const MAX_PAYLOAD_BYTES = 256 * 1024;

/* ── the workspace ─────────────────────────────────────────────────── */

// One workspace's records. `projects` is keyed by slug and holds the server id
// the CLI caches; `log` is keyed by slug and holds stored events in the order
// they were accepted, which is what makes `server_seq` a position rather than a
// timestamp.
// `memberships` is the calling account's, which is a fact about the account
// rather than about this workspace's records — it is here because it is state a
// case adjusts, and the default is the one workspace this server serves, which
// is what a case that says nothing about memberships means.
function workspace(options)
{
    const projects = new Map();
    const log = new Map();
    (options.projects ?? []).forEach((project, index) => define(projects, log, {
        id: project.id ?? `prj_${index + 1}`,
        slug: project.slug,
        description: project.description,
        workspace: options.wsId
    }));
    return {
        projects,
        log,
        nextId: (options.projects ?? []).length,
        memberships: options.workspaces
            ?? [{ id: options.wsId, name: options.wsName ?? "the test workspace", status: "active" }]
    };
}

function define(projects, log, project)
{
    projects.set(project.slug, project);
    log.set(project.slug, log.get(project.slug) ?? []);
}

/* ── serving ───────────────────────────────────────────────────────── */

// `answer(call, state)` may return — or resolve to — a response to send instead
// of the one the rules below would produce. That is how a case stages something the contract
// states but this file has no state to reach — a 503 from a runtime that is not
// ready, a 5xx, a body that will not parse — without teaching the mock a
// behaviour the server does not have.
export async function workspaceServer(options = {})
{
    const wsId = options.wsId ?? "ws_01J8TEST";
    const account = options.account ?? "acct_01J8TEST";
    const state = workspace({ ...options, wsId });
    const calls = [];
    const server = createServer((request, response) =>
    {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", async () =>
        {
            const call = received(request, Buffer.concat(chunks).toString("utf8"));
            calls.push(call);
            // Awaited, so a case can answer with a promise. A workspace that
            // takes a while is a real thing the CLI has rules about and there
            // is no state in this file to reach it from — it is staged the
            // same way a 503 is, by the case saying so.
            const staged = await options.answer?.(call, state, calls.length);
            reply(response, staged ?? route(call, { wsId, account, state }));
        });
    });
    await new Promise((listening) => server.listen(0, "127.0.0.1", listening));
    return {
        url: `http://127.0.0.1:${server.address().port}`,
        wsId,
        account,
        state,
        calls,
        eventsIn: (slug) => (state.log.get(slug) ?? []).slice(),
        projectId: (slug) => state.projects.get(slug)?.id,
        close: () => new Promise((closed) =>
        {
            server.closeAllConnections();
            server.close(closed);
        })
    };
}

function received(request, raw)
{
    const url = new URL(request.url, "http://127.0.0.1");
    return {
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: request.headers,
        body: parse(raw),
        raw
    };
}

function parse(raw)
{
    try
    {
        return raw === "" ? null : JSON.parse(raw);
    }
    catch
    {
        return raw;
    }
}

function reply(response, given)
{
    if (given.hang === true)
    {
        // The connection stays open and nothing is ever written to it. A
        // client's own timeout is the only thing that ends this.
        return;
    }
    if (given.destroy === true)
    {
        // The connection dies with no response at all, which the CLI has to
        // read as "it is not known whether the server acted".
        response.socket.destroy();
        return;
    }
    response.writeHead(given.status, {
        "content-type": "application/json",
        "X-Superself-Api": API_VERSION,
        ...(given.headers ?? {})
    });
    // `raw` is sent exactly as written, for the one thing a contract response
    // can never be: the page a web server standing in front of the API answers
    // with (#434). `body` stays JSON, so no case sends one by accident.
    response.end(given.raw ?? (given.body === undefined ? "" : JSON.stringify(given.body)));
}

/* ── the response priority ─────────────────────────────────────────── */

// The contract's stated order, and the reason this function is one list of
// early returns rather than a switch on the route: the priority is a property
// of every route, so a route that answered its own 404 before the version check
// would be a route with a priority of its own.
function route(call, ctx)
{
    if (call.headers["x-superself-api"] !== API_VERSION)
    {
        return { status: 426, body: { code: "api_version_mismatch", message: "this client speaks an older API" } };
    }
    const seen = resolve(call, ctx);
    if (seen === null)
    {
        return hidden();
    }
    return seen;
}

// Everything a non-member, an out-of-scope call, a token that belongs to
// another workspace and an absent resource get: one 404 with nothing in it that
// tells them apart.
function hidden()
{
    return { status: 404, body: { code: "not_found", message: "no such workspace, project or record" } };
}

function resolve(call, ctx)
{
    // The one route outside the workspace segment (C1 v0.9.6, openapi 0.9.4):
    // the calling account's active memberships, closed workspaces included and
    // marked by status so a client can show them and refuse them. A Runtime
    // token gets the concealing 404 here — this mock holds no token kinds, so
    // that half of the rule is the CLI's own and is not staged.
    if (call.path === "/api/workspaces")
    {
        return call.method === "GET" ? { status: 200, body: ctx.state.memberships } : null;
    }
    const projects = `/api/workspaces/${ctx.wsId}/projects`;
    if (call.path === projects)
    {
        return call.method === "GET" ? listProjects(ctx) : createProject(call, ctx);
    }
    const events = call.path.match(new RegExp(`^${escaped(projects)}/([^/]+)/events$`));
    if (events === null)
    {
        return null;
    }
    const slug = decodeURIComponent(events[1]);
    return call.method === "GET" ? pullEvents(call, ctx, slug) : pushEvents(call, ctx, slug);
}

function escaped(text)
{
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ── projects ──────────────────────────────────────────────────────── */

// Archived projects included, and marked by a field. Leaving them out would
// make a CLI reconciling its cache read an archived project as a deleted one.
function listProjects(ctx)
{
    return { status: 200, body: [...ctx.state.projects.values()] };
}

// The three answers the contract gives creation. The 409 is the one place a
// member is told a slug is taken — the fact of the name being occupied is not a
// secret from a member of the workspace, while everything in the project still
// is.
function createProject(call, ctx)
{
    const slug = call.body?.slug;
    if (typeof slug !== "string" || slug === "")
    {
        return { status: 400, body: { code: "invalid_request", message: "a project is created with a slug" } };
    }
    if (ctx.state.projects.has(slug))
    {
        return { status: 409, body: { code: "slug_taken", message: `this workspace already has a project "${slug}"` } };
    }
    ctx.state.nextId += 1;
    const project = { id: `prj_${ctx.state.nextId}`, slug, workspace: ctx.wsId, created_at: new Date().toISOString() };
    if (typeof call.body.description === "string")
    {
        project.description = call.body.description;
    }
    define(ctx.state.projects, ctx.state.log, project);
    return { status: 201, body: project };
}

/* ── the delta pull ────────────────────────────────────────────────── */

function pullEvents(call, ctx, slug)
{
    const stored = ctx.state.log.get(slug);
    if (stored === undefined)
    {
        return null;
    }
    const after = Number(call.query.after ?? 0);
    return {
        status: 200,
        body: { events: stored.filter((event) => event.server_seq > after), head_seq: { project: headSeq(stored) } }
    };
}

function headSeq(stored)
{
    return stored.length === 0 ? 0 : stored[stored.length - 1].server_seq;
}

/* ── the push ──────────────────────────────────────────────────────── */

// One batch, one transaction: every check below runs over the whole batch
// before a single event is stored, so a refused batch leaves the log exactly as
// it was and a resend of it is a resend of all of it.
function pushEvents(call, ctx, slug)
{
    const stored = ctx.state.log.get(slug);
    if (stored === undefined || mismatchedProject(call, ctx, slug))
    {
        return null;
    }
    const events = call.body?.events;
    if (!Array.isArray(events) || events.length === 0)
    {
        return { status: 400, body: { code: "invalid_request", message: "a push carries at least one event" } };
    }
    return oversized(call, events) ?? malformed(events, ctx) ?? conflicted(events, ctx.state.log, stored)
        ?? accept(events, stored);
}

// The cached server id the CLI may send. A slug that was deleted and made again
// is a different project, and this is what stops a queue written against the
// old one joining the new one — answered as the same 404 everything hidden gets.
function mismatchedProject(call, ctx, slug)
{
    const expected = call.body?.expected_project;
    return typeof expected === "string" && ctx.state.projects.get(slug)?.id !== expected;
}

// The limits, all three answered with 413 and all three the contract's rule
// rather than the schema's: a batch too long, a batch too large, and one event
// carrying too much.
function oversized(call, events)
{
    const over = events.length > MAX_BATCH_EVENTS
        || Buffer.byteLength(call.raw) > MAX_BATCH_BYTES
        || events.some((event) => Buffer.byteLength(JSON.stringify(event.payload ?? null)) > MAX_PAYLOAD_BYTES);
    return over ? { status: 413, body: { code: "too_large", message: "split this batch on append boundaries" } } : null;
}

// The author check, and the shape check beside it. Both are 400; only the
// author check names a code, because it is the one a client has to tell apart
// — the records were written by an account this machine is no longer using.
function malformed(events, ctx)
{
    if (events.some((event) => event.actor_account !== ctx.account))
    {
        return {
            status: 400,
            body: { code: "actor_mismatch", message: "these records name an author other than the account sending them" }
        };
    }
    const required = ["event_id", "append_id", "ts", "type", "payload"];
    return events.every((event) => required.every((field) => event[field] !== undefined))
        ? null
        : { status: 400, body: { code: "invalid_request", message: "an event is missing a required field" } };
}

// An event id already stored is a no-op where the record is identical, and
// refuses the whole batch where anything about it differs. The stream is part
// of that comparison and is decided by the request path, which is why an id
// resent against another project's log is a conflict rather than a duplicate:
// the stored row is looked up across the workspace, not within this log.
function conflicted(events, logs, stored)
{
    const clash = events.find((event) =>
    {
        const held = storedAnywhere(logs, stored, event.event_id);
        return held !== undefined && differs(held.event, event, held.sameStream);
    });
    return clash === undefined
        ? null
        : { status: 409, body: { code: "event_conflict", message: `event ${clash.event_id} was already recorded differently` } };
}

// The workspace's whole set of logs, because an event id is unique across the
// workspace and the check has to see a row that landed in another project's log.
function storedAnywhere(logs, stored, id)
{
    for (const log of logs.values())
    {
        const event = log.find((row) => row.event_id === id);
        if (event !== undefined)
        {
            return { event, sameStream: log === stored };
        }
    }
    return undefined;
}

function differs(held, sent, sameStream)
{
    return !sameStream
        || held.type !== sent.type
        || held.actor_account !== sent.actor_account
        || held.actor_agent !== sent.actor_agent
        || JSON.stringify(held.payload) !== JSON.stringify(sent.payload);
}

// Accepted, or counted as a duplicate. What is stored is what was sent, with
// the sequence added: the contract's event carries the four names the API asks
// for, and a client that sends more than that is sending a record whose extra
// fields are its own to keep.
function accept(events, stored)
{
    let accepted = 0;
    let duplicates = 0;
    for (const event of events)
    {
        if (stored.some((row) => row.event_id === event.event_id))
        {
            duplicates += 1;
            continue;
        }
        stored.push({ ...event, server_seq: headSeq(stored) + 1 });
        accepted += 1;
    }
    return { status: 200, body: { accepted, duplicates, head_seq: { project: headSeq(stored) } } };
}
