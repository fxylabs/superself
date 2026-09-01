// `self init` chooses which kind of store it makes, and the cloud answer runs
// the connect flow (#426).
//
// Every cell is named for its row in
// `docs/maintainers/case-tables/426-command-surface.md` — `init I5
// non-tty-no-flag` — because that table is the review surface and a row with no
// cell is a path nothing proves.
//
// Two things are load-bearing across the whole file. Nothing may ask a question
// unless a person is at the terminal, because agents drive this CLI; and no way
// of failing may leave a store behind, because a directory naming a workspace
// nobody confirmed this machine belongs to fails every later command somewhere
// further from the mistake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../dist/main.js";
import { checkContract } from "../dist/contract.js";
import { commandUsage } from "../dist/help.js";
import { DEFAULT_AGENT_SCOPES, WORKSPACE_SCOPES } from "../dist/login.js";
import { WORKSPACE_FILE } from "../dist/mode.js";
import { approvedIn, drive, machine, must, selfIn } from "./harness.mjs";
import { credentialsFile, writeCredential } from "./pr7-lib.mjs";
import { workspaceServer } from "./workspace-server.mjs";

const ACCOUNT = "acct_01J8INIT";

// A directory that could become a workspace, and nothing in it yet.
function emptyRoom(box, name = "room")
{
    const dir = join(box.root, name);
    mkdirSync(dir, { recursive: true });
    return dir;
}

// The environment a cell about the cloud branch runs in: an http loopback base
// is only allowed in development mode, and the sending after the command is not
// this file's subject.
function cloudEnv(extra = {})
{
    return { SUPERSELF_DEV: "1", SUPERSELF_SYNC: "off", ...extra };
}

async function servedWorkspace(t, options = {})
{
    const server = await workspaceServer({ account: ACCOUNT, ...options });
    t.after(() => server.close());
    return server;
}

// A machine already signed in to the workspace the server serves, with every
// scope a workspace store needs.
function signedIn(box, server, scopes = WORKSPACE_SCOPES)
{
    writeCredential(box, { account: ACCOUNT, apiBase: server.url, scopes });
}

// What "no store, no partial files" means, stated once: the directory holds
// exactly what it held, and this machine is not pointing at it.
function nothingWasMade(box, dir)
{
    assert.deepEqual(readdirSync(dir), [], `${dir} was left with files in it`);
    const pointer = join(box.env.XDG_CONFIG_HOME, "superself", "machine.json");
    assert.ok(!existsSync(pointer) || JSON.parse(readFileSync(pointer, "utf8")).workspace !== dir,
        "this machine was pointed at a workspace the flow never finished making");
}

function markerIn(dir)
{
    return JSON.parse(readFileSync(join(dir, ".superself", WORKSPACE_FILE), "utf8"));
}

/* ── I. choosing a mode and making the store ───────────────────────── */

test("init I1 tty-no-flag: a person at the terminal is asked which kind of store, and the answer chooses", async () =>
{
    const box = machine();
    const asked = await approvedIn(box, emptyRoom(box), ["init", "--lang", "en", "--agents"], "g");

    assert.equal(asked.code, 0, asked.out);
    assert.match(asked.out, /git.*cloud|\[g\/c\]/i, "the question named neither kind of store");
    assert.ok(existsSync(join(box.root, "room", ".superself", "registry.jsonl")), "answering `g` made no git store");
    assert.ok(!existsSync(join(box.root, "room", ".superself", WORKSPACE_FILE)), "answering `g` wrote a server marker");
});

test("init I1 tty-answer-cloud: the cloud answer takes the cloud branch and never makes a repository", async (t) =>
{
    const box = machine();
    const server = await servedWorkspace(t);
    signedIn(box, server);
    const room = emptyRoom(box);
    const asked = await drive(box, room, ["init", "--workspace", server.wsId, "--lang", "en", "--agents"],
        { tty: true, answer: "c", extra: cloudEnv() });

    assert.equal(asked.code, 0, asked.out);
    assert.deepEqual(markerIn(room), { base: server.url, wsId: server.wsId, mode: "api" });
    assert.ok(!existsSync(join(room, ".superself", ".git")), "the cloud branch made a git repository");
});

test("init I2 git-flag: `--git` makes the store the shipped command always made", async () =>
{
    const box = machine();
    const room = emptyRoom(box);
    const made = await must(box, room, ["init", "--git"]);

    assert.equal(made.out.trim(), `workspace initialized at ${join(room, ".superself")} (views in "en")`);
    assert.deepEqual(readdirSync(join(room, ".superself")).sort(), [".git", ".gitattributes", "config.json", "registry.jsonl"]);
});

test("init I3 cloud-signed-in: no login is started, the marker is written, and the workspace's projects arrive", async (t) =>
{
    const box = machine();
    const server = await servedWorkspace(t, { projects: [{ slug: "atlas", description: "the other machine's project" }] });
    signedIn(box, server);
    const room = emptyRoom(box);
    const made = await must(box, room, ["init", "--cloud", "--workspace", server.wsId], cloudEnv());

    assert.match(made.out, new RegExp(server.wsId), "the receipt does not name the workspace it attached to");
    assert.deepEqual(markerIn(room), { base: server.url, wsId: server.wsId, mode: "api" });
    const registry = readFileSync(join(room, ".superself", "registry.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(registry.map((row) => [row.slug, row.id]), [["atlas", server.projectId("atlas")]]);
    assert.ok(!server.calls.some((call) => call.path.startsWith("/api/device/")), "a login was started for a machine already signed in");
});

test("init I4 cloud-not-signed-in: the device flow runs inline and the same run goes on to make the store", async (t) =>
{
    const box = machine();
    const server = await servedWorkspace(t, { answer: deviceFlow(ACCOUNT, WORKSPACE_SCOPES) });
    const room = emptyRoom(box);
    const made = await must(box, room, ["init", "--cloud", "--workspace", server.wsId],
        cloudEnv({ SUPERSELF_API_BASE: server.url }));

    assert.match(made.out, new RegExp(server.wsId));
    assert.deepEqual(markerIn(room), { base: server.url, wsId: server.wsId, mode: "api" });
    const profile = JSON.parse(readFileSync(credentialsFile(box), "utf8")).profiles.default;
    assert.equal(profile.account_id, ACCOUNT, "the inline login wrote no credential");
    assert.ok(server.calls.some((call) => call.path === "/api/device/start"), "no device flow was started");
});

test("init I5 non-tty-no-flag: nobody at the terminal is refused, asked nothing, and given the flags", async () =>
{
    const box = machine();
    const room = emptyRoom(box);
    const refused = await selfIn(box, room, ["init"]);

    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--git/);
    assert.match(refused.out, /--cloud/);
    nothingWasMade(box, room);
});

test("init I5 agent-at-a-terminal: a runner's process is not a person, however many terminals it has", async () =>
{
    const box = machine();
    const room = emptyRoom(box);
    // What a runner stamps on every child it starts. A process carrying one is
    // an agent's, and agents state the mode rather than being asked it.
    const refused = await drive(box, room, ["init"], { tty: true, extra: { SUPERSELF_ATTEMPT_ID: "att_01J8INIT" } });

    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--git/);
    assert.doesNotMatch(refused.out, /\[g\/c\]/, "a question was put to a process with nobody behind it");
    nothingWasMade(box, room);
});

test("init I6 both-flags: naming both kinds of store is refused and writes nothing", async () =>
{
    const box = machine();
    const room = emptyRoom(box);
    const refused = await selfIn(box, room, ["init", "--git", "--cloud"]);

    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /one store is one or the other/);
    nothingWasMade(box, room);
});

test("init I6 workspace-with-git: a flag that belongs to the other kind of store is refused, not ignored", async () =>
{
    const box = machine();
    const room = emptyRoom(box);
    const refused = await selfIn(box, room, ["init", "--git", "--workspace", "ws_01J8TEST"]);

    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--cloud/, "the refusal does not say which flag reaches a workspace");
    nothingWasMade(box, room);
});

test("init I7 login-fails: a login that does not complete leaves no store and no partial files", async (t) =>
{
    const box = machine();
    const server = await servedWorkspace(t, {
        answer: (call) => call.path === "/api/device/start"
            ? { status: 400, body: { code: "invalid_scope", message: "this client asked for a scope it may not have" } }
            : undefined
    });
    const room = emptyRoom(box);
    const refused = await selfIn(box, room, ["init", "--cloud", "--workspace", server.wsId],
        cloudEnv({ SUPERSELF_API_BASE: server.url }));

    assert.notEqual(refused.code, 0);
    nothingWasMade(box, room);
});

test("init I8 no-workspace-named: nobody to ask is refused by name, and writes nothing", async () =>
{
    const box = machine();
    signedIn(box, { url: "https://app.superselfs.com" });
    const room = emptyRoom(box);
    const refused = await selfIn(box, room, ["init", "--cloud"], cloudEnv());

    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--workspace/);
    nothingWasMade(box, room);
});

test("init I8 workspace-pick-abandoned: a person who names nothing gets a refusal and no store", async (t) =>
{
    const box = machine();
    const server = await servedWorkspace(t);
    signedIn(box, server);
    const room = emptyRoom(box);
    const refused = await drive(box, room, ["init", "--cloud", "--lang", "en", "--agents"],
        { tty: true, answer: "", extra: cloudEnv() });

    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /no workspace was named/);
    nothingWasMade(box, room);
});

test("init I9 first-pull-unreachable: a workspace that does not answer leaves no store", async (t) =>
{
    const box = machine();
    const server = await servedWorkspace(t, { answer: () => ({ destroy: true }) });
    signedIn(box, server);
    const room = emptyRoom(box);
    const refused = await selfIn(box, room, ["init", "--cloud", "--workspace", server.wsId], cloudEnv());

    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /could not reach/);
    nothingWasMade(box, room);
});

test("init I10 second-machine: naming a workspace that already holds a project attaches to it", async (t) =>
{
    const box = machine();
    const server = await servedWorkspace(t, { projects: [{ slug: "atlas" }] });
    server.state.log.get("atlas").push({
        id: "01J8INITEVENT0000000000001",
        server_seq: 1,
        ts: "2026-08-31T00:00:00.000Z",
        type: "entity.confirmed",
        project: "atlas",
        actor_account: ACCOUNT,
        payload: { kind: "goal", id: "g-atlas", title: "a goal another machine recorded" }
    });
    signedIn(box, server);
    const room = emptyRoom(box);
    await must(box, room, ["init", "--cloud", "--workspace", server.wsId], cloudEnv());

    const log = readFileSync(join(room, ".superself", "projects", "atlas", "log.jsonl"), "utf8");
    assert.match(log, /01J8INITEVENT0000000000001/, "the project's log did not arrive from the workspace");
    assert.match((await must(box, room, ["project", "list"], cloudEnv())).out, /atlas/);
});

test("init I11 already-a-store: both kinds answer as they did, and neither asks anything", async (t) =>
{
    const box = machine();
    const server = await servedWorkspace(t);
    signedIn(box, server);
    const gitRoom = emptyRoom(box, "git-room");
    await must(box, gitRoom, ["init", "--git"]);
    const cloudRoom = emptyRoom(box, "cloud-room");
    await must(box, cloudRoom, ["init", "--cloud", "--workspace", server.wsId], cloudEnv());

    assert.match((await must(box, gitRoom, ["init"])).out, /already initialized/);
    assert.match((await must(box, gitRoom, ["init", "--git"])).out, /already initialized/);
    assert.match((await selfIn(box, gitRoom, ["init", "--cloud"], cloudEnv())).out, /git-backed workspace store/);
    for (const args of [["init"], ["init", "--git"], ["init", "--cloud"]])
    {
        const refused = await selfIn(box, cloudRoom, args, cloudEnv());
        assert.notEqual(refused.code, 0, `self ${args.join(" ")} answered a server-backed store as a no-op`);
        assert.match(refused.out, /server-backed workspace store/);
        assert.match(refused.out, /one store is one or the other/);
    }
});

test("init I12 old-credential: a credential without the workspace scopes is refused before anything is made", async (t) =>
{
    const box = machine();
    const server = await servedWorkspace(t);
    signedIn(box, server, ["email.send", "wallet.read"]);
    const room = emptyRoom(box);
    const refused = await selfIn(box, room, ["init", "--cloud", "--workspace", server.wsId], cloudEnv());

    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /self login/);
    nothingWasMade(box, room);
    assert.deepEqual(server.calls, [], "the workspace was asked about a credential the local check had already answered");
});

test("init I13 not-a-member: a workspace the server conceals leaves no store and names the account", async (t) =>
{
    const box = machine();
    const server = await servedWorkspace(t);
    signedIn(box, server);
    const room = emptyRoom(box);
    const refused = await selfIn(box, room, ["init", "--cloud", "--workspace", "ws_01J8SOMEBODYELSE"], cloudEnv());

    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /self login/);
    nothingWasMade(box, room);
});

/* ── G. the scopes, and the shortage found without asking ──────────── */

test("login G1 fresh: the workspace scopes are requested beside the rail's, and the granted list is kept", async (t) =>
{
    const box = machine();
    const server = await servedWorkspace(t, { answer: deviceFlow(ACCOUNT, DEFAULT_AGENT_SCOPES) });
    await must(box, box.root, ["login", "--no-open"], cloudEnv({ SUPERSELF_API_BASE: server.url }));

    const started = server.calls.find((call) => call.path === "/api/device/start");
    assert.deepEqual([...WORKSPACE_SCOPES].sort(), WORKSPACE_SCOPES.filter((scope) => started.body.scopes.includes(scope)).sort(),
        "the login asked for fewer than the seven workspace scopes");
    assert.equal(WORKSPACE_SCOPES.length, 7);
    const profile = JSON.parse(readFileSync(credentialsFile(box), "utf8")).profiles.default;
    assert.deepEqual(profile.scopes, DEFAULT_AGENT_SCOPES, "the granted list was not stored beside the credential");
});

test("login G2 short-scopes: the shortage is found locally and the answer names the login that fixes it", async (t) =>
{
    const box = machine();
    const server = await servedWorkspace(t);
    signedIn(box, server, WORKSPACE_SCOPES.filter((scope) => scope !== "project.manage"));
    const refused = await selfIn(box, emptyRoom(box), ["init", "--cloud", "--workspace", server.wsId], cloudEnv());

    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /project\.manage/, "the answer does not say which scope is missing");
    assert.match(refused.out, /self login/);
});

test("login G3 unreadable-scopes: a scope list this CLI cannot read is the same shortage, with no stack", async (t) =>
{
    const box = machine();
    const server = await servedWorkspace(t);
    for (const damaged of [{ scopes: "self.sync" }, null])
    {
        signedIn(box, server);
        const file = credentialsFile(box);
        writeFileSync(file, damaged === null ? "{ this is not json" : JSON.stringify({
            version: 1,
            default: "default",
            profiles: { default: { ...JSON.parse(readFileSync(file, "utf8")).profiles.default, ...damaged } }
        }), { mode: 0o600 });
        const refused = await selfIn(box, emptyRoom(box, `damaged-${damaged === null ? "json" : "shape"}`),
            ["init", "--cloud", "--workspace", server.wsId], cloudEnv());

        assert.notEqual(refused.code, 0);
        assert.match(refused.out, /self login/);
        assert.doesNotMatch(refused.out, /at .*\.js:\d+|node:internal/, "a stack reached the caller");
    }
});

test("login G4 no-request: the shortage answer is the local list's alone — the workspace is not asked", async (t) =>
{
    const box = machine();
    const server = await servedWorkspace(t);
    signedIn(box, server, []);
    await selfIn(box, emptyRoom(box), ["init", "--cloud", "--workspace", server.wsId], cloudEnv());

    assert.deepEqual(server.calls, [], "a 404 was what the guidance was read off");
});

/* ── H. the help and the parser say the same thing ─────────────────── */

test("help H1 init-flags: the page states the flags and the parser takes exactly those", async () =>
{
    const page = commandUsage(COMMANDS.find((command) => command.name === "init"));
    for (const flag of ["--git", "--cloud", "--workspace <id>"])
    {
        assert.match(page, new RegExp(flag.replace(/[<>]/g, ".")), `\`self init --help\` does not state ${flag}`);
    }
    const box = machine();
    const room = emptyRoom(box);
    assert.equal((await must(box, room, ["init", "--git", "--lang", "en"])).code, 0);
    assert.match((await selfIn(box, emptyRoom(box, "other"), ["init", "--mode", "cloud"])).out, /unknown option/);
});

test("help H2 declared-surface: no option a page omits, and no page for a leaf that is not reachable", () =>
{
    assert.deepEqual(checkContract(COMMANDS), []);
});

/* ── the device flow, staged ───────────────────────────────────────── */

// The mock workspace server implements the contract and nothing else, and the
// device flow is not in the contract — it is the rail's, and it is what `self
// login` has always spoken. So a case that needs one stages it through the
// mock's own injection point rather than teaching that file a route the
// Workspace API does not have.
function deviceFlow(account, scopes)
{
    return (call) =>
    {
        if (call.path === "/api/device/start")
        {
            return {
                status: 200,
                body: {
                    device_code: "dev_01J8INIT",
                    user_code: "INIT-CODE",
                    verification_url: "https://app.superselfs.com/device/approve",
                    expires_in: 600,
                    interval: 1
                }
            };
        }
        if (call.path === "/api/device/poll")
        {
            return {
                status: 200,
                body: {
                    status: "approved",
                    account,
                    grant_id: "grant_01J8INIT",
                    access_token: "sa_access_init",
                    refresh_token: "sr_refresh_init",
                    scopes,
                    expires_at: new Date(Date.now() + 3600_000).toISOString()
                }
            };
        }
        return undefined;
    };
}
