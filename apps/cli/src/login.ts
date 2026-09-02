// `self login`, `self logout`, `self whoami` — the device-flow client.
//
// The server half is fixed by derivation D7; this is only the client, and three
// of its behaviours are the ones a naive implementation gets wrong:
//
//   - `authorization_pending` and `slow_down` arrive as HTTP **200** with a
//     `status` field, not as errors. Only the terminal refusals are 400.
//   - There is no `retry_after` on poll. The pacing is the `interval` the start
//     call returned, and exceeding it five times does not throttle the client —
//     it permanently expires the grant.
//   - A failed poll is still a poll. A transport failure consumes its interval
//     slot; polling again immediately is the single behaviour that burns the
//     login, so the loop runs on wall-clock slots and a failure never shortens
//     one.
//
// Login appends **no event** to the superself log. Credentials are machine
// state, like `machine.json`, not project state — which removes the sanitizer
// surface entirely rather than relying on it to catch a token.

import { spawnSync } from "node:child_process";
import { hostname, userInfo } from "node:os";
import { Command, CommandInput, leaf } from "./contract.js";
import {
    DEFAULT_API_BASE, Profile, now, profileName, readCredentialFile, readProfile,
    removeMarker, removeProfile, resolveProfileName, withCredentialLock, writeProfile
} from "./credentials.js";
import { cliVersion } from "./help.js";
import { jsonLine, jsonMode } from "./output.js";
import { installedPlugins } from "./plugins.js";
import { localTimestamp } from "./pretty.js";
import {
    PublicAnswer, RailSession, foreignFields, foreignMessage, publicPost, railRequest, sanitizeText
} from "./rail.js";
import { CommandOutput, JsonValue, fail, refuse } from "./types.js";

/* ── constants ─────────────────────────────────────────────────────── */

// The whole August agent vocabulary, compiled in because there is no route
// that offers it: `POST /api/device/start` **requires** the client to enumerate
// scopes and the route map has no discovery endpoint.
//
// This is not commerce logic in the open-source core. They are opaque transport
// strings the CLI sends, stores and compares for equality; it attaches no
// meaning, no price and no product behaviour to any of them. Requesting the
// full set by default is what makes the bootstrap work at all — installing a
// plugin needs a credential, and the scopes are declared by plugins that are
// not installed yet — and the consent gate is the approve page, which shows the
// exact list with the device label, IP, hostname and start time, not the flag.
const RAIL_SCOPES = [
    "email.send", "email.read", "email.domain.manage", "landing.deploy", "landing.read", "wallet.read"
];

// What a workspace store needs, from the vocabulary C1 §3 fixes: the three
// `self.*` scopes the sync layer sends and receives under, the two `artifact.*`
// ones a record's attachments travel under, `repo.read` for the connections a
// project's evidence names, and `project.manage` for creating a project at all.
//
// `repo.manage` is deliberately not here. Creating and deleting a workspace's
// repository connections is not something this CLI does, and a scope requested
// by default is a scope on the approve page a person has to read and decide
// about — asking for one nothing spends is asking for trust with nothing behind
// it.
//
// This list is also the shortage test. A credential granted before these
// existed carries none of them, and the workspace answers one indistinguishable
// 404 for a non-member, an out-of-scope call and an absent project (C1
// invariant 3) — so nothing on the wire can say "your credential is old", and
// this comparison is where that is found out.
export const WORKSPACE_SCOPES = [
    "self.sync", "self.read", "self.write", "artifact.read", "artifact.write", "repo.read", "project.manage"
];

export const DEFAULT_AGENT_SCOPES = [...RAIL_SCOPES, ...WORKSPACE_SCOPES];

// Increment applied on every `slow_down`. The client never polls faster than
// the interval it was given.
const SLOW_DOWN_INCREMENT_MS = 5000;
const APPROVE_SUFFIX = "/device/approve";

/* ── the session a login runs in ───────────────────────────────────── */

function loginSession(profile: string): RailSession
{
    return { profile, client: clientTag(), notice: (line) => console.error(line) };
}

export function clientTag(plugin?: string): string
{
    const base = `self/${cliVersion()}`;
    return plugin === undefined ? `${base} contract/0` : `${base} plugin/${plugin} contract/0`;
}

/* ── the device flow ───────────────────────────────────────────────── */

interface DeviceStart
{
    device_code: string;
    user_code: string;
    verification_url: string;
    expires_in: number;
    interval: number;
}

function asRecord(value: JsonValue): Record<string, JsonValue>
{
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(body: Record<string, JsonValue>, key: string): string
{
    const value = body[key];
    return typeof value === "string" ? sanitizeText(value) : "";
}

function count(body: Record<string, JsonValue>, key: string, fallback: number): number
{
    const value = body[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// The wire field is `device_label`, not `label`: that is the contract's name for
// it, and it is the same name this file stores the value under (`device_label`
// in `profileFrom`). One vocabulary, on the wire and on disk.
async function startDevice(base: string, session: RailSession, label: string, scopes: string[]): Promise<DeviceStart>
{
    const answer = await publicPost(base, "/api/device/start", { device_label: label, scopes }, session);
    const body = asRecord(answer.body);
    // A 200 is not a start unless it is this API's envelope. A proxy in front of
    // the workspace answers a page with 200, and reading a device code out of
    // one produces an empty code that fails four steps further on (#434).
    if (answer.status !== 200 || answer.foreign !== undefined)
    {
        throw deviceRefusal(answer, body);
    }
    return {
        device_code: text(body, "device_code"),
        user_code: text(body, "user_code"),
        verification_url: text(body, "verification_url"),
        expires_in: count(body, "expires_in", 600),
        interval: count(body, "interval", 5)
    };
}

// `access_denied` is the owner refusing, and no retry of any kind changes that,
// so it is exit 2 rather than an error the agent might try again.
function deviceRefusal(answer: PublicAnswer, body: Record<string, JsonValue>): Error
{
    // Before anything is read out of the body, because a rate limiter names no
    // code and a 429 is its own cause whatever it answered with.
    if (answer.status === 429)
    {
        return fail("rate_limited", "too many device-login attempts from this address");
    }
    // Described, never quoted. This used to render up to 2 KB of whatever a web
    // server sent — an HTML error page, a proxy banner, a CDN challenge (#434).
    if (answer.foreign !== undefined)
    {
        return fail("device_login_failed", foreignMessage(answer.foreign), foreignFields(answer.foreign));
    }
    const code = text(body, "code");
    const message = text(body, "message") || "the device login was refused";
    if (code === "access_denied")
    {
        return refuse("access_denied", message);
    }
    return fail(code === "expired_token" ? "device_code_expired" : (code || "device_login_failed"), message);
}

interface Approved
{
    account: string;
    grant_id: string;
    access_token: string;
    refresh_token: string;
    scopes: string[];
    expires_at: string;
}

interface PollState
{
    intervalMs: number;
    deadline: number;
    warned: boolean;
}

// Wall-clock slots of width `interval`, timed from when a slot **started**. A
// transport failure consumes its slot and the next attempt waits out the
// remainder; the timer is never reset, so a flapping network cannot produce an
// early poll and cannot spend one of the five `slow_down` violations that
// permanently expire the grant.
function pollUntilApproved(base: string, session: RailSession, start: DeviceStart, timeoutS?: number): Promise<Approved>
{
    // Ctrl-C during the wait writes nothing at all: the grant exists
    // server-side and a fresh `self login` is the way back. Racing the loop
    // against the signal is what makes that true even mid-request — the
    // default handler would kill the process on a signal number, and the
    // agent would read an exit code that means nothing to it.
    // The flag matters as much as the rejection: `Promise.race` settles the
    // caller but does not stop the loser, and a poll loop left running would
    // keep the process alive — and keep polling — long after the person
    // pressed ctrl-c.
    const cancel = { requested: false };
    let onInterrupt = (): void => undefined;
    const interrupted = new Promise<never>((resolve, reject) =>
    {
        onInterrupt = () =>
        {
            cancel.requested = true;
            reject(fail("login_cancelled", "the device approval was cancelled"));
        };
        process.once("SIGINT", onInterrupt);
    });
    return Promise.race([pollLoop(base, session, start, timeoutS, cancel), interrupted])
        .finally(() => process.removeListener("SIGINT", onInterrupt));
}

interface Cancellation
{
    requested: boolean;
}

async function pollLoop(base: string, session: RailSession, start: DeviceStart,
    timeoutS: number | undefined, cancel: Cancellation): Promise<Approved>
{
    const state: PollState = {
        intervalMs: start.interval * 1000,
        deadline: now().getTime() + (timeoutS ?? start.expires_in) * 1000,
        warned: false
    };
    while (!cancel.requested && now().getTime() < state.deadline)
    {
        const slotStarted = now().getTime();
        const approved = await pollOnce(base, session, start.device_code, state);
        if (approved !== null)
        {
            return approved;
        }
        await waitOutSlot(slotStarted, state.intervalMs, cancel);
    }
    if (cancel.requested)
    {
        throw fail("login_cancelled", "the device approval was cancelled");
    }
    throw fail("login_timeout", "the device approval did not arrive in time", { hint: "self login" });
}

async function pollOnce(base: string, session: RailSession, deviceCode: string, state: PollState): Promise<Approved | null>
{
    let answer: PublicAnswer;
    try
    {
        answer = await publicPost(base, "/api/device/poll", { device_code: deviceCode }, session, false);
    }
    catch
    {
        if (!state.warned)
        {
            state.warned = true;
            console.error("notice: a device poll did not reach the rail; still waiting");
        }
        return null;
    }
    return readPoll(answer, state);
}

function readPoll(answer: PublicAnswer, state: PollState): Approved | null
{
    const body = asRecord(answer.body);
    if (answer.status === 429)
    {
        return rateLimited(state);
    }
    if (answer.status !== 200 || answer.foreign !== undefined)
    {
        throw deviceRefusal(answer, body);
    }
    const status = text(body, "status");
    if (status === "slow_down")
    {
        state.intervalMs += SLOW_DOWN_INCREMENT_MS;
        return null;
    }
    if (status !== "approved")
    {
        return null;
    }
    return approvedFrom(body);
}

// A 429 on poll is the IP rate limiter, not a refusal of this grant — it
// carries no `code` at all. Terminating the login there throws away a grant a
// person may be about to approve, over a limit that clears on its own. So it
// is a consumed slot, widened by the same increment `slow_down` uses, and the
// loop continues to its own deadline (§1.5).
function rateLimited(state: PollState): null
{
    state.intervalMs += SLOW_DOWN_INCREMENT_MS;
    if (!state.warned)
    {
        state.warned = true;
        console.error("notice: the rail is rate-limiting this address; still waiting");
    }
    return null;
}

function approvedFrom(body: Record<string, JsonValue>): Approved
{
    const scopes = body.scopes;
    return {
        account: text(body, "account"),
        grant_id: text(body, "grant_id"),
        access_token: text(body, "access_token"),
        refresh_token: text(body, "refresh_token"),
        scopes: Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === "string") : [],
        expires_at: text(body, "expires_at")
    };
}

// Waited out in short steps rather than one long sleep, so ctrl-c takes effect
// within a tick instead of at the end of a five-second interval. The slot's end
// is still measured from when the slot *started*, which is the property that
// keeps a failed poll from producing an early one.
async function waitOutSlot(slotStarted: number, intervalMs: number, cancel: Cancellation): Promise<void>
{
    while (!cancel.requested && now().getTime() < slotStarted + intervalMs)
    {
        const remaining = slotStarted + intervalMs - now().getTime();
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)));
    }
}

/* ── what login writes ─────────────────────────────────────────────── */

// The server never populates a console URL, so the CLI derives one: the
// verification URL is `${console}/device/approve`, and stripping exactly that
// suffix leaves the base. A URL without the suffix — a future server change —
// leaves `console_base` unset and every synthesized `console_url` omitted
// rather than guessed.
export function consoleBaseOf(verificationUrl: string): string | undefined
{
    return verificationUrl.endsWith(APPROVE_SUFFIX)
        ? verificationUrl.slice(0, verificationUrl.length - APPROVE_SUFFIX.length)
        : undefined;
}

function profileFrom(base: string, start: DeviceStart, approved: Approved, label: string): Profile
{
    const consoleBase = consoleBaseOf(start.verification_url);
    const at = now().toISOString();
    return {
        api_base: base,
        account_id: approved.account,
        grant_id: approved.grant_id,
        scopes: approved.scopes,
        ...(consoleBase === undefined ? {} : { console_base: consoleBase }),
        access_token: approved.access_token,
        access_expires_at: approved.expires_at,
        refresh_token: approved.refresh_token,
        // Never advanced by a rotation: it is the absolute deadline's anchor,
        // and a login is the only thing that sets it.
        grant_started_at: at,
        device_label: label,
        obtained_at: at
    };
}

// A login is a writer of the profile exactly as a refresh is, so it takes the
// same per-profile lock. It waits to the **absolute** bound rather than the
// ordinary 20 s, because the tokens it is holding were just approved by a human
// and dropping them on a timeout would throw that approval away. The only way a
// login ends without writing is SIGINT.
async function commitLogin(profile: string, next: Profile): Promise<void>
{
    // No timeout. The tokens in hand were approved by a person moments ago, and
    // §1.5 permits exactly one way for a login to end without writing them:
    // SIGINT. A bounded wait here would add a second way — and it would fire
    // precisely when the machine is busiest, which is when losing the grant
    // costs the most.
    await withCredentialLock(profile, {
        onWait: () => console.error(`notice: waiting for another process to release profile "${profile}"`)
    }, async () =>
    {
        writeProfile(profile, next);
        // Unconditionally, including a marker written by a refresh this login
        // just displaced: the documented recovery is `self login`, so it has to
        // actually recover.
        removeMarker(profile);
    });
}

/* ── the commands ──────────────────────────────────────────────────── */

const LOGIN_OPTIONS = {
    label: { type: "string" },
    scopes: { type: "string" },
    "no-open": { type: "boolean" },
    timeout: { type: "string" },
    profile: { type: "string" },
    "api-base": { type: "string" },
    json: { type: "boolean" }
} as const;

function apiBaseOf(values: CommandInput<typeof LOGIN_OPTIONS>["values"]): string
{
    return String(values["api-base"] ?? process.env.SUPERSELF_API_BASE ?? DEFAULT_API_BASE);
}

function scopesOf(values: CommandInput<typeof LOGIN_OPTIONS>["values"]): string[]
{
    const named = values.scopes;
    return named === undefined ? DEFAULT_AGENT_SCOPES : String(named).split(",").map((scope) => scope.trim()).filter((scope) => scope !== "");
}

// Which profile a login writes: the flag, then the environment, then the
// literal `default`.
//
// It deliberately does **not** consult the credential file's own `default`
// field the way every other command does. A login with no `--profile` writes
// the profile called `default`; reading the file's pointer instead would make
// a second login silently overwrite whichever account that pointer happened to
// name.
function loginProfile(flag: string | boolean | (string | boolean)[] | undefined): string
{
    const named = flag === undefined ? process.env.SUPERSELF_PROFILE : String(flag);
    return profileName(named === undefined || named === "" ? "default" : named);
}

function timeoutOf(value: string | boolean | (string | boolean)[] | undefined): number | undefined
{
    if (value === undefined)
    {
        return undefined;
    }
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0)
    {
        throw fail("parse_error", `--timeout takes a number of seconds, not "${String(value)}"`);
    }
    return seconds;
}

function defaultLabel(): string
{
    try
    {
        return `${userInfo().username}@${hostname()}`;
    }
    catch
    {
        return `agent@${hostname()}`;
    }
}

// What `self login` asks for, and what asks for it on behalf of somebody else.
//
// The connect flow behind `self init --cloud` starts a login where this machine
// holds no credential, and it starts *this* one rather than a second
// implementation of the device flow — the pacing rules at the top of this file
// are the whole reason a naive second one would burn the grant.
interface DeviceLoginRequest
{
    base?: string;
    profile?: string;
    label?: string;
    scopes?: string[];
    noOpen?: boolean;
    timeoutS?: number;
}

export async function deviceLogin(request: DeviceLoginRequest = {}): Promise<Approved>
{
    const base = request.base ?? process.env.SUPERSELF_API_BASE ?? DEFAULT_API_BASE;
    const profile = request.profile ?? loginProfile(undefined);
    const session = loginSession(profile);
    const label = request.label ?? defaultLabel();
    const start = await startDevice(base, session, label, request.scopes ?? DEFAULT_AGENT_SCOPES);
    announce(start, request.noOpen === true);
    const approved = await pollUntilApproved(base, session, start, request.timeoutS);
    await commitLogin(profile, profileFrom(base, start, approved, label));
    return approved;
}

async function runLogin(input: CommandInput<typeof LOGIN_OPTIONS>): Promise<CommandOutput>
{
    const profile = loginProfile(input.values.profile);
    const approved = await deviceLogin({
        base: apiBaseOf(input.values),
        profile,
        label: input.values.label === undefined ? undefined : String(input.values.label),
        scopes: scopesOf(input.values),
        noOpen: input.values["no-open"] === true,
        timeoutS: timeoutOf(input.values.timeout)
    });
    return signedIn(profile, approved);
}

// The only command that emits JSON Lines. The agent needs the code before
// approval happens and the result after, so one object cannot carry both — an
// asymmetry the contract test asserts rather than leaves to be discovered.
function announce(start: DeviceStart, noOpen: boolean): void
{
    if (jsonMode())
    {
        jsonLine({
            status: "pending",
            verification_url: start.verification_url,
            user_code: start.user_code,
            expires_in: start.expires_in,
            interval: start.interval
        });
        return;
    }
    console.error(`  open this page and enter the code:\n\n    ${start.verification_url}\n    code:  ${start.user_code}\n`);
    console.error(`  waiting for approval …  (expires in ${Math.round(start.expires_in / 60)}:00, ctrl-c to cancel)`);
    maybeOpen(start.verification_url, noOpen);
}

// Attempted only when a person is actually looking at the terminal. Never under
// `--json`, and never when stdout is not a TTY.
function maybeOpen(url: string, noOpen: boolean): void
{
    if (noOpen || jsonMode() || process.stdout.isTTY !== true)
    {
        return;
    }
    const opener = process.platform === "darwin" ? "open" : (process.platform === "win32" ? "start" : "xdg-open");
    try
    {
        spawnSync(opener, [url], { stdio: "ignore" });
    }
    catch
    {
        // A machine with no browser is the ordinary headless case; the URL is
        // already on screen.
    }
}

function signedIn(profile: string, approved: Approved): CommandOutput
{
    const data: JsonValue = {
        status: "approved",
        account: approved.account,
        scopes: approved.scopes,
        expires_at: approved.expires_at
    };
    if (jsonMode())
    {
        jsonLine(data);
        return [];
    }
    return [{
        kind: "value",
        text: `✓ signed in — account ${approved.account} · scopes: ${approved.scopes.join(", ")}\n`
            + `  access expires ${localTimestamp(approved.expires_at)} · profile "${profile}"`
    }];
}

const LOGOUT_OPTIONS = { profile: { type: "string" }, all: { type: "boolean" }, json: { type: "boolean" } } as const;

// Revocation lives on an owner-session route, so an agent cannot revoke its own
// credential. `self logout` says so plainly rather than implying a safety it
// cannot provide.
function runLogout(input: CommandInput<typeof LOGOUT_OPTIONS>): CommandOutput
{
    const file = readCredentialFile();
    const names = input.values.all === true
        ? Object.keys(file?.profiles ?? {})
        : [resolveProfileName(input.values.profile === undefined ? undefined : String(input.values.profile))];
    const profiles = names.map((name) => ({ name, expires: file?.profiles[name]?.access_expires_at }));
    names.forEach((name) => { removeProfile(name); removeMarker(name); });
    const consoleBase = file?.profiles[names[0]]?.console_base;
    return [{
        kind: "payload",
        data: { removed: names, credential_still_valid: true } as JsonValue,
        plain: () => logoutLines(profiles, consoleBase)
    }];
}

function logoutLines(profiles: { name: string; expires?: string }[], consoleBase: string | undefined): string[]
{
    const lines = profiles.map((profile) => `removed local credentials for profile "${profile.name}".`
        + (profile.expires === undefined ? "" : `\nthe credential remains valid on the server until ${localTimestamp(profile.expires)}.`));
    return consoleBase === undefined ? lines : [...lines, `revoke it at ${consoleBase}/credentials`];
}

const WHOAMI_OPTIONS = { profile: { type: "string" }, verify: { type: "boolean" }, json: { type: "boolean" } } as const;

// Local-only by default, so it is usable offline and costs nothing. `--verify`
// spends the one cheap unmetered identity probe that exists.
async function runWhoami(input: CommandInput<typeof WHOAMI_OPTIONS>): Promise<CommandOutput>
{
    const name = resolveProfileName(input.values.profile === undefined ? undefined : String(input.values.profile));
    const profile = readProfile(name);
    const plugins = installedPlugins().map((plugin) => ({ key: plugin.key, version: plugin.version }));
    if (input.values.verify === true)
    {
        await verifyIdentity(name, profile.account_id);
    }
    const data: JsonValue = {
        account: profile.account_id,
        scopes: profile.scopes,
        access_expires_at: profile.access_expires_at,
        profile: name,
        api_base: profile.api_base,
        ...(profile.console_base === undefined ? {} : { console_base: profile.console_base }),
        plugins
    };
    return [{ kind: "payload", data, plain: () => whoamiLines(name, profile, plugins) }];
}

async function verifyIdentity(profile: string, accountId: string): Promise<void>
{
    const answer = await railRequest({
        session: { profile, client: clientTag() },
        spec: { method: "GET", path: "/api/agent/session", scopes: ["wallet.read"] },
        commandPath: "whoami"
    });
    const account = asRecord(answer.body).account;
    if (typeof account === "string" && account !== accountId)
    {
        throw fail("identity_mismatch", `the rail reports account ${account}, and this profile stores ${accountId}`);
    }
}

function whoamiLines(name: string, profile: Profile, plugins: { key: string; version: string }[]): string[]
{
    return [
        `account ${profile.account_id} · profile "${name}"`,
        `scopes: ${profile.scopes.join(", ")}`,
        `access expires ${localTimestamp(profile.access_expires_at)}`,
        `rail ${profile.api_base}`,
        `plugins: ${plugins.length === 0 ? "none" : plugins.map((plugin) => `${plugin.key}@${plugin.version}`).join(", ")}`
    ];
}

export const LOGIN_COMMAND: Command = {
    name: "login",
    usage: [{
        syntax: "login [--label text] [--scopes csv] [--no-open] [--timeout s] [--profile name] [--api-base url] [--json]",
        description: ["obtain an agent credential through a device approval a person confirms"],
        verbs: [""]
    }],
    detail: [
        "prints a URL and a code; a person opens the page, checks the scopes and",
        "approves. the credential is written to the config directory at mode 0600",
        "and no event is appended to the project log.",
        "",
        "  --label <text>        the device label shown on the approve page",
        "  --scopes <csv>        request less than the full agent vocabulary",
        "  --no-open             never launch a browser",
        "  --timeout <s>         give up before the grant expires",
        "  --profile <name>      write a named profile instead of the default",
        "  --api-base <url>      a rail other than the hosted one; SUPERSELF_API_BASE",
        "                        is the same choice made from the environment",
        "  --json                JSON Lines: one pending object, then one approved"
    ],
    node: leaf("", LOGIN_OPTIONS, 0, runLogin)
};

export const LOGOUT_COMMAND: Command = {
    name: "logout",
    usage: [{
        syntax: "logout [--profile name] [--all] [--json]",
        description: ["delete the local credential; the server-side credential stays valid until it expires"],
        verbs: [""]
    }],
    detail: [
        "an agent cannot revoke its own credential — revocation is an owner",
        "action — so this removes the local file and names what is still live.",
        "",
        "  --profile <name>      a named profile instead of the default",
        "  --all                 every profile on this machine",
        "  --json                machine-readable output"
    ],
    node: leaf("", LOGOUT_OPTIONS, 0, runLogout)
};

export const WHOAMI_COMMAND: Command = {
    name: "whoami",
    usage: [{
        syntax: "whoami [--profile name] [--verify] [--json]",
        description: ["what credential this machine holds, and what it can reach"],
        verbs: [""]
    }],
    detail: [
        "local and free by default: it makes no network call, so it answers",
        "offline. --verify spends one unmetered identity probe against the rail.",
        "",
        "  --profile <name>      a named profile instead of the default",
        "  --verify              ask the rail to confirm the credential",
        "  --json                machine-readable output"
    ],
    node: leaf("", WHOAMI_OPTIONS, 0, runWhoami)
};
