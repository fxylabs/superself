// A scratch machine whose store is server-backed and whose workspace server is
// the contract mock next door.
//
// Every case in the transport suites starts here, because the three things that
// have to line up — the store's marker, the credential's account, and the
// workspace the server serves — are exactly the three that a case getting one
// of them wrong would fail on for a reason that has nothing to do with its
// subject.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_SCOPES } from "../dist/login.js";
import { WORKSPACE_FILE } from "../dist/mode.js";
import { PENDING_FILE } from "../dist/pending.js";
import { demoWorkspace, machine } from "./harness.mjs";
import { writeCredential } from "./pr7-lib.mjs";
import { workspaceServer } from "./workspace-server.mjs";

export const ACCOUNT = "acct_01J8TRANSPORT";

// What a command runs with when the case is about what crosses the wire: the
// sending happens before the command returns, so a case has something to assert
// when its `await` comes back. `SUPERSELF_DEV` is what lets the base be an http
// loopback address at all.
export function syncEnv(extra = {})
{
    return { SUPERSELF_DEV: "1", SUPERSELF_SYNC: "inline", ...extra };
}

// The shipped behaviour instead: a process of its own, outliving the command.
export function detachedEnv(extra = {})
{
    return { SUPERSELF_DEV: "1", SUPERSELF_SYNC: "on", ...extra };
}

// `server` points a second machine at a workspace an earlier one already made,
// which is the whole staging for anything about two machines sharing a log.
export async function connectedMachine(options = {})
{
    const box = machine();
    const server = options.server ?? await workspaceServer({ account: ACCOUNT, ...options });
    const { ws, demo } = await demoWorkspace(box);
    // Every scope a workspace store needs, unless the case's subject is a
    // credential that is short of one.
    writeCredential(box, { account: ACCOUNT, apiBase: server.url, scopes: options.scopes ?? WORKSPACE_SCOPES });
    markServerBacked(ws, server);
    return { box, ws, demo, server };
}

export function markServerBacked(ws, server)
{
    writeFileSync(join(storeDir(ws), WORKSPACE_FILE),
        JSON.stringify({ base: server.url, wsId: server.wsId, mode: "api" }) + "\n");
}

export function storeDir(ws)
{
    return join(ws, ".superself");
}

export function projectDir(ws, slug = "demo")
{
    return join(storeDir(ws), "projects", slug);
}

export function rows(file)
{
    if (!existsSync(file))
    {
        return [];
    }
    return readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

export function pendingRows(ws, slug = "demo")
{
    return rows(join(projectDir(ws, slug), PENDING_FILE));
}

export function logRows(ws, slug = "demo")
{
    return rows(join(projectDir(ws, slug), "log.jsonl"));
}

export function registryRows(ws)
{
    return rows(join(storeDir(ws), "registry.jsonl"));
}

export function appends(ws, slug = "demo")
{
    return pendingRows(ws, slug).filter((row) => Array.isArray(row.events));
}

// The appends still going somewhere: neither settled by a pull nor stopped by a
// refusal. The same filter the CLI reads the queue through, so a case asserting
// "this is still to send" asserts what the transport would actually send.
export function unsent(ws, slug = "demo")
{
    const rows = pendingRows(ws, slug);
    const settled = new Set(rows.flatMap((row) => [row.sent, row.blocked].filter((id) => typeof id === "string")));
    return appends(ws, slug).filter((row) => !settled.has(row.append_id));
}

export function blocks(ws, slug = "demo")
{
    return pendingRows(ws, slug).filter((row) => typeof row.blocked === "string");
}

export function sentMarks(ws, slug = "demo")
{
    return pendingRows(ws, slug).filter((row) => typeof row.sent === "string");
}

// A queued append written by hand, so a case can stage the state a push starts
// from without driving a verb that would also pull, fold and refold.
export function queueAppend(ws, options = {})
{
    const slug = options.slug ?? "demo";
    const dir = projectDir(ws, slug);
    mkdirSync(dir, { recursive: true });
    const row = {
        append_id: options.appendId ?? `apx_${Math.random().toString(36).slice(2, 10)}`,
        events: options.events ?? [event(options)]
    };
    writeFileSync(join(dir, PENDING_FILE), pendingText(ws, slug) + JSON.stringify(row) + "\n");
    return row;
}

function pendingText(ws, slug)
{
    const file = join(projectDir(ws, slug), PENDING_FILE);
    return existsSync(file) ? readFileSync(file, "utf8") : "";
}

export function event(options = {})
{
    return {
        id: options.id ?? `evt_${Math.random().toString(36).slice(2, 12)}`,
        ts: options.ts ?? "2026-08-31T00:00:00.000Z",
        type: options.type ?? "entity.confirmed",
        origin: { actor: "agent", confirmed: false },
        project: options.slug ?? "demo",
        payload: options.payload ?? { text: "a queued record" },
        actor: { account: options.account ?? ACCOUNT }
    };
}

// The wire form of a local event, as the CLI sends it. Used by the cases that
// seed the server with a record before the CLI ever talks to it.
export function stored(event, appendId, seq)
{
    return {
        ...event,
        event_id: event.id,
        append_id: appendId,
        actor_account: event.actor?.account ?? null,
        actor_agent: null,
        server_seq: seq
    };
}

// A condition the detached pusher will satisfy, waited for rather than slept
// through. Detached is the one mode a case cannot await, so the assertion is
// the wait: it fails by timing out, and the timeout is the failure message.
export async function eventually(check, what, budgetMs = 10_000)
{
    const until = Date.now() + budgetMs;
    while (Date.now() < until)
    {
        if (check())
        {
            return;
        }
        await new Promise((tick) => setTimeout(tick, 25));
    }
    throw new Error(`waited ${budgetMs}ms and ${what} never became true`);
}
