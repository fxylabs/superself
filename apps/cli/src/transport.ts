// The Workspace API, as this CLI speaks it.
//
// One module, and it does two things and no third: it turns a store's marker
// and this machine's credential into an addressed, authenticated request, and
// it turns whatever came back into a status, some headers and a body. It
// decides nothing about what a status means — the tables in `pusher.ts` and
// `puller.ts` decide that, and they are the review surface for it.
//
// It lives outside the state writers on purpose. Those may hold no import path
// to a credential, and this holds one: it is the module that puts the bearer
// token on a request. Everything it wants written is written by asking
// `pending.ts` and `logfile.ts`, which is the direction that keeps the rule
// true — the transport knows the queue, the queue does not know the token.
//
// A failure to reach the server is not a status. `reached: false` is the one
// answer for a refused connection, a name that does not resolve, a socket that
// died mid-response and a request that ran out of time, because every one of
// them leaves the same question open — whether the server acted — and a client
// that told them apart would be inventing certainty it does not have.
import { readWorkspaceMarker } from "./mode.js";
import { assertApiBase, assertTlsPolicy } from "./rail.js";
import { readProfile, resolveProfileName } from "./credentials.js";
import { JsonValue, SelfEvent } from "./types.js";

// Sent on every request and required on every route. A server answering a
// version it does not speak says 426, which both tables treat as "this CLI is
// out of date" rather than as a failure of the record.
const API_VERSION = "1";

const API_VERSION_HEADER = "X-Superself-Api";

// One request's own bound. Well under the lease a background pusher gives
// itself, so a push that hangs is a push that ends rather than a lock nobody
// can take back.
export const REQUEST_TIMEOUT_MS = 15_000;

// The longest this CLI waits on a `Retry-After` before giving up on the
// attempt. The header is the server's number and this is the ceiling over it:
// a machine must not be held by a header saying "an hour".
export const RETRY_AFTER_CAP_MS = 60_000;

export interface WorkspaceSession
{
    base: string;
    wsId: string;
    account: string;
    token: string;
}

// All one request needs: where the server is, and the token to send.
//
// Every route but one is addressed inside a workspace, and a workspace session
// answers this by holding more than it. The exception is the list of workspaces
// the calling account is a member of (C1 v0.9.6), which the connect flow asks
// before there is a store to read a workspace out of — so the address it sends
// is the account's own.
interface Addressed
{
    base: string;
    token: string;
}

// Read once per push or pull run rather than per request. A background pusher
// never refreshes — the foreground holds the credential lock for that, and two
// processes refreshing one grant is what the credential module's whole marker
// dance exists to prevent — so the token this run sends is the token that was
// on disk when it started, and an expired one comes back as a 4xx the table
// already answers.
export function openSession(storeDir: string): WorkspaceSession
{
    assertTlsPolicy();
    const marker = readWorkspaceMarker(storeDir);
    const profile = readProfile(resolveProfileName());
    return {
        base: assertApiBase(marker.base),
        wsId: marker.wsId,
        account: profile.account_id,
        token: profile.access_token
    };
}

export type ApiAnswer =
    | { reached: true; status: number; headers: Record<string, string>; body: JsonValue }
    | { reached: false };

interface ApiSpec
{
    method: "GET" | "POST";
    path: string;
    query?: Record<string, string>;
    body?: JsonValue;
}

async function apiCall(session: Addressed, spec: ApiSpec): Promise<ApiAnswer>
{
    const url = new URL(`${session.base}${spec.path}`);
    Object.entries(spec.query ?? {}).forEach(([key, value]) => url.searchParams.set(key, value));
    try
    {
        return await answerOf(await fetch(url, request(session, spec)));
    }
    catch
    {
        // A refused connection, an unresolvable name, a socket cut mid-body, a
        // timeout. The table calls all of them the same thing.
        return { reached: false };
    }
}

function request(session: Addressed, spec: ApiSpec): RequestInit
{
    return {
        method: spec.method,
        headers: {
            authorization: `Bearer ${session.token}`,
            "content-type": "application/json",
            [API_VERSION_HEADER]: API_VERSION
        },
        body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    };
}

// A body that will not parse is not a failure to reach the server: the status
// is the answer both tables branch on, and every branch that reads the body
// reads one optional field out of it. So an unreadable body reads as `null`
// and the status stands.
async function answerOf(response: Response): Promise<ApiAnswer>
{
    const text = await response.text();
    return {
        reached: true,
        status: response.status,
        headers: Object.fromEntries([...response.headers].map(([key, value]) => [key.toLowerCase(), value])),
        body: parseBody(text)
    };
}

function parseBody(text: string): JsonValue
{
    try
    {
        return text.trim() === "" ? null : JSON.parse(text) as JsonValue;
    }
    catch
    {
        return null;
    }
}

/* ── the events an append sends ────────────────────────────────────── */

// One event on the wire: what the store holds, plus the four names the API
// asks an event to carry.
//
// Nothing is taken away. The API requires `event_id`, `append_id`,
// `actor_account` and `actor_agent`, and this adds exactly those; `origin`,
// `refs` and the rest of the record travel beside them untouched, because they
// are what the fold reads and this CLI is not the thing that gets to decide a
// record means less than it said.
//
// `actor_agent` is null. A device credential may name null or an agent home of
// its own account, and this CLI holds no agent home — a person at a terminal
// wrote the record, whatever else ran on their behalf.
function wireEvent(event: SelfEvent, appendId: string): JsonValue
{
    return {
        ...(event as unknown as Record<string, JsonValue>),
        event_id: event.id,
        append_id: appendId,
        ts: event.ts,
        type: event.type,
        actor_account: event.actor?.account ?? null,
        actor_agent: null
    } as JsonValue;
}

export interface WireAppend
{
    append_id: string;
    events: SelfEvent[];
}

// Several appends in one request. The batch is split only on append
// boundaries: one append is one transaction, so a request carrying three of
// them is three transactions the server may accept together and this CLI may
// re-send apart.
export function pushAppends(session: WorkspaceSession, slug: string, appends: WireAppend[], projectId?: string): Promise<ApiAnswer>
{
    const events = appends.flatMap((append) => append.events.map((event) => wireEvent(event, append.append_id)));
    const body: Record<string, JsonValue> = { events };
    if (projectId !== undefined)
    {
        // The cached server id of the project this slug named when the records
        // were made. A slug deleted and remade by somebody else is a different
        // project, and this is what stops a queue joining it.
        body.expected_project = projectId;
    }
    return apiCall(session, { method: "POST", path: eventsPath(session, slug), body });
}

export function pullAfter(session: WorkspaceSession, slug: string, after: number): Promise<ApiAnswer>
{
    return apiCall(session, { method: "GET", path: eventsPath(session, slug), query: { after: String(after) } });
}

export function listProjects(session: WorkspaceSession): Promise<ApiAnswer>
{
    return apiCall(session, { method: "GET", path: projectsPath(session) });
}

// The workspaces this account is an active member of, closed ones included and
// marked by status (C1 v0.9.6). The only route outside the workspace segment,
// and the reason it exists: an account may belong to several workspaces, so
// `self init --cloud` attaches a machine by choosing from a list rather than by
// knowing an id by heart.
//
// It takes no session and opens none, because there is no store yet to open one
// from. `openSession` reads a store's marker — a store says which server holds
// its records; this reads the profile, because the account is all there is.
export function listWorkspaces(): Promise<ApiAnswer>
{
    assertTlsPolicy();
    const profile = readProfile(resolveProfileName());
    return apiCall({ base: assertApiBase(profile.api_base), token: profile.access_token },
        { method: "GET", path: "/api/workspaces" });
}

export function createProject(session: WorkspaceSession, slug: string, description?: string): Promise<ApiAnswer>
{
    const body: Record<string, JsonValue> = { slug };
    if (description !== undefined)
    {
        body.description = description;
    }
    return apiCall(session, { method: "POST", path: projectsPath(session), body });
}

function projectsPath(session: WorkspaceSession): string
{
    return `/api/workspaces/${encodeURIComponent(session.wsId)}/projects`;
}

function eventsPath(session: WorkspaceSession, slug: string): string
{
    return `${projectsPath(session)}/${encodeURIComponent(slug)}/events`;
}

/* ── reading the two fields a table branches on ────────────────────── */

// The machine-readable reason on a 400. `actor_mismatch` is the one this CLI
// tells apart from every other refusal, because it names a cause a person can
// act on — the records were written by an account this machine is no longer
// logged in as.
export function errorCodeOf(body: JsonValue): string | undefined
{
    const code = (body as { code?: unknown } | null)?.code;
    return typeof code === "string" ? code : undefined;
}

// How long the server asked to be left alone, capped. A header this CLI cannot
// read is treated as no header at all: the tables both have a branch for a 503
// that named no delay.
export function retryAfterMs(headers: Record<string, string>): number | null
{
    const seconds = Number(headers["retry-after"]);
    if (!Number.isFinite(seconds) || seconds < 0)
    {
        return null;
    }
    return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
}
