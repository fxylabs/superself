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
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../dist/main.js";
import { checkContract } from "../dist/contract.js";
import { commandUsage } from "../dist/help.js";
import { DEFAULT_AGENT_SCOPES, WORKSPACE_SCOPES } from "../dist/login.js";
import { WORKSPACE_FILE } from "../dist/mode.js";
import { firstCatchUp } from "../dist/puller.js";
import { approvedIn, drive, git, machine, must, selfIn } from "./harness.mjs";
import { SELF_BIN as selfBin, credentialsFile, writeCredential } from "./pr7-lib.mjs";
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
        // What a workspace actually holds. Every event this CLI sends carries
        // its origin, and the first catch-up now refuses a delta it cannot
        // apply rather than reporting a store it half filled — so a fixture
        // that left the field off would be staging an event no server has.
        origin: { actor: "agent", confirmed: true },
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

/* ── I14: an agent's process at a terminal is asked nothing at all ─── */

// The two questions `self init` asks after the mode and the workspace used to
// read `isTTY` alone, so a runner-stamped process with a real terminal was
// asked them and waited forever — the second of the two *after* the store had
// been written. The harness expresses that caller exactly: both ends of a
// terminal, an attempt marker, and nobody typing.
//
// A timeout is stated on each of these because the defect they are about is a
// hang: without one, the fix coming out would stop the file rather than fail a
// case.

test("init I14 agent-with-pty-cloud: a marked process at a terminal is asked neither the language nor the agents question",
    { timeout: 20_000 }, async (t) =>
{
    const box = machine();
    const server = await servedWorkspace(t);
    signedIn(box, server);
    const room = emptyRoom(box);
    const made = await drive(box, room, ["init", "--cloud", "--workspace", server.wsId],
        { tty: true, extra: cloudEnv({ SUPERSELF_ATTEMPT_ID: "att_01J8INIT" }) });

    assert.equal(made.code, 0, made.out);
    assert.doesNotMatch(made.out, /language for the HTML views/, "a marked process was asked which language");
    assert.doesNotMatch(made.out, /tell the agents on this machine/, "a marked process was asked about its agents");
    assert.equal(JSON.parse(readFileSync(join(room, ".superself", "config.json"), "utf8")).lang, "en",
        "the non-interactive default language was not used");
});

test("init I14 agent-with-pty-git: the git branch answers a marked process the same way",
    { timeout: 20_000 }, async () =>
{
    const box = machine();
    const room = emptyRoom(box);
    const made = await drive(box, room, ["init", "--git"],
        { tty: true, extra: { SUPERSELF_ATTEMPT_ID: "att_01J8INIT" } });

    assert.equal(made.code, 0, made.out);
    assert.doesNotMatch(made.out, /language for the HTML views/);
    assert.doesNotMatch(made.out, /tell the agents on this machine/);
    assert.match(made.out, /views in "en"/);
});

test("init I14 person-at-a-terminal: a person is still asked both, and their answers are used",
    { timeout: 20_000 }, async () =>
{
    const box = machine();
    const room = emptyRoom(box);
    const made = await drive(box, room, ["init", "--git"], { tty: true, answer: "ko" });

    assert.equal(made.code, 0, made.out);
    assert.match(made.out, /language for the HTML views/, "a person at the terminal was not asked which language");
    assert.match(made.out, /tell the agents on this machine/, "a person at the terminal was not asked about agents");
    assert.equal(JSON.parse(readFileSync(join(room, ".superself", "config.json"), "utf8")).lang, "ko");
});

test("init I14 piped: nobody at all still defaults to en and to no agent block", async () =>
{
    const box = machine();
    const room = emptyRoom(box);
    const made = await must(box, room, ["init", "--git"]);

    assert.match(made.out, /views in "en"/);
    assert.doesNotMatch(made.out, /agents on this machine now know/, "a piped caller was given the agent block");
});

/* ── G5–G7: the shortage names a remedy that clears it ─────────────── */

// Every command reads the profile the credential file's own `default` field
// names; `self login` with no flag writes the one literally called `default`.
// A machine whose first login named a profile therefore used to be told to run
// a login that wrote a profile nothing would read — and the same shortage came
// back, word for word, forever.

test("login G5 named-profile: the shortage names the profile that will be read, and that login clears it", async (t) =>
{
    const box = machine();
    const server = await servedWorkspace(t);
    // A file whose `default` pointer is `work`, which is what `self login
    // --profile work` produced before the workspace scopes existed.
    writeCredential(box, { profile: "work", account: ACCOUNT, apiBase: server.url, scopes: ["email.send"] });
    const refused = await selfIn(box, emptyRoom(box, "before"), ["init", "--cloud", "--workspace", server.wsId], cloudEnv());

    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /self login --profile work/, "the remedy does not name the profile this machine reads");
    assert.match(refused.out, /profile "work"/, "the refusal does not say which credential it read");

    // What that remedy writes, staged exactly where it would land.
    writeCredential(box, { profile: "work", account: ACCOUNT, apiBase: server.url, scopes: WORKSPACE_SCOPES });
    const made = await must(box, emptyRoom(box, "after"), ["init", "--cloud", "--workspace", server.wsId], cloudEnv());

    assert.match(made.out, new RegExp(server.wsId), "following the stated remedy did not clear the shortage");
});

test("login G6 unset-profile: a profile that is not in the file starts the login rather than misreading the scopes", async (t) =>
{
    const box = machine();
    const server = await servedWorkspace(t, { answer: deviceFlow(ACCOUNT, WORKSPACE_SCOPES) });
    writeCredential(box, { account: ACCOUNT, apiBase: server.url, scopes: WORKSPACE_SCOPES });
    const room = emptyRoom(box);
    const made = await must(box, room, ["init", "--cloud", "--workspace", server.wsId],
        cloudEnv({ SUPERSELF_PROFILE: "other", SUPERSELF_API_BASE: server.url }));

    assert.ok(server.calls.some((call) => call.path === "/api/device/start"),
        "a machine with no such profile was told its scopes were old instead of being signed in");
    assert.equal(JSON.parse(readFileSync(credentialsFile(box), "utf8")).profiles.other.account_id, ACCOUNT,
        "the inline login wrote a profile other than the one this machine reads");
    assert.match(made.out, new RegExp(server.wsId));
});

test("login G7 abbreviated-scopes: a granted list written with the contract's family shorthand is not a shortage", async (t) =>
{
    const box = machine();
    const server = await servedWorkspace(t);
    // C1 §3 writes the granted list as `self.*` and calls it an abbreviation.
    signedIn(box, server, ["self.*", "artifact.*", "repo.read", "project.manage"]);
    const made = await must(box, emptyRoom(box), ["init", "--cloud", "--workspace", server.wsId], cloudEnv());

    assert.match(made.out, new RegExp(server.wsId), "an abbreviated granted list was read as a shortage");
});

/* ── I15: nothing outside the store escapes the rollback ───────────── */

test("init I15 interrupted-catch-up: ctrl-c during the first catch-up leaves no store and the pointer where it was",
    { timeout: 20_000 }, async (t) =>
{
    const box = machine();
    // The signal is sent while the CLI is waiting on the first delta, which is
    // the longest wait the command has and the one the default handler used to
    // kill the process in the middle of.
    const server = await servedWorkspace(t, {
        projects: [{ slug: "atlas" }, { slug: "beta" }],
        answer: (call) =>
        {
            if (call.path.endsWith("/events"))
            {
                process.emit("SIGINT");
            }
            return undefined;
        }
    });
    signedIn(box, server);
    const elsewhere = emptyRoom(box, "elsewhere");
    await must(box, elsewhere, ["init", "--git"]);
    const room = emptyRoom(box);
    const refused = await selfIn(box, room, ["init", "--cloud", "--workspace", server.wsId], cloudEnv());

    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /interrupted/);
    nothingWasMade(box, room);
    assert.equal(JSON.parse(readFileSync(join(box.env.XDG_CONFIG_HOME, "superself", "machine.json"), "utf8")).workspace,
        elsewhere, "an aborted flow moved a pointer that named another workspace");
});

// Ctrl-C twice, through the real binary and real signals.
//
// The in-process driver cannot see this: `process.emit("SIGINT")` is a
// synthetic emit and never reaches Node's default disposition, which is the
// thing a second signal used to land on. So this cell spawns the child, waits
// for the workspace to be asked for a delta, and sends two.
//
// The window between the two presses is the one the flow spends waiting out the
// pull it interrupted — nothing is printed there, which is exactly when a
// person presses again — so it is sampled at three points inside it.
async function killedTwice(box, room, server, apart)
{
    const seen = server.calls.length;
    const child = spawn(process.execPath, [selfBin, "init", "--cloud", "--workspace", server.wsId],
        { cwd: room, env: { ...box.env, ...cloudEnv() }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    // Judged by *this* child having asked the workspace for a delta rather than
    // by a sleep: under a loaded runner a fixed wait can land before the store
    // has been written, and the run before this one left calls behind.
    while (!server.calls.slice(seen).some((call) => call.path.endsWith("/events")))
    {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    child.kill("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, apart));
    child.kill("SIGINT");
    const ended = await new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
    return { ...ended, out };
}

test("init I15 double-interrupt: a second ctrl-c during the cleanup still leaves no store", { timeout: 90_000 },
    async (t) =>
{
    const box = machine();
    // The delta the flow is waiting on when the first signal lands, answered
    // three seconds later — so every second press below falls inside the wait
    // the flow spends on the pull it is not allowed to abandon.
    const server = await servedWorkspace(t, {
        projects: [{ slug: "atlas" }, { slug: "beta" }],
        answer: (call) => call.path.endsWith("/events") && call.method === "GET"
            ? new Promise((ready) => setTimeout(ready, 3000))
            : undefined
    });
    signedIn(box, server);
    for (const apart of [300, 1000, 2500])
    {
        const room = emptyRoom(box, `room-${apart}`);
        const ended = await killedTwice(box, room, server, apart);

        assert.equal(ended.signal, null, `a second ctrl-c ${apart}ms in killed the process: ${ended.out}`);
        assert.notEqual(ended.code, 0, `${apart}ms: ${ended.out}`);
        nothingWasMade(box, room);
    }
});

test("init I15 pointer-write-fails: a failing pointer write takes the store and the exclude line back", async (t) =>
{
    const box = machine();
    const server = await servedWorkspace(t);
    signedIn(box, server);
    const room = emptyRoom(box);
    git(box, room, ["init", "-q", "-b", "main"]);
    // The machine pointer, readable and not writable — so the flow reads a
    // machine attached to nothing, makes the store, adds the exclude line, and
    // then fails on the last write of all.
    const pointer = join(box.env.XDG_CONFIG_HOME, "superself", "machine.json");
    mkdirSync(join(box.env.XDG_CONFIG_HOME, "superself"), { recursive: true });
    writeFileSync(pointer, "{}\n");
    chmodSync(pointer, 0o444);
    const refused = await selfIn(box, room, ["init", "--cloud", "--workspace", server.wsId], cloudEnv());

    assert.notEqual(refused.code, 0);
    assert.ok(!existsSync(join(room, ".superself")), "the store outlived the step that failed after it");
    const excludes = readFileSync(join(room, ".git", "info", "exclude"), "utf8");
    assert.doesNotMatch(excludes, /^\.superself\/$/m, "an exclude line was left behind for a store that is gone");
    // A file this CLI can name is never answered with a stack — `machine.ts`
    // says so about the read next door, and the write is the same file.
    assert.doesNotMatch(refused.out, /\n\s+at /, "a pointer this CLI can name was answered with a Node stack");
    assert.doesNotMatch(refused.out, /Node\.js v/);
    assert.match(refused.out, /which workspace this machine points at/, "the refusal does not say what the file is");
});

test("init I15 exclude-restored: an exclude line taken back out leaves the file byte-for-byte as it was", async (t) =>
{
    const box = machine();
    const server = await servedWorkspace(t);
    signedIn(box, server);
    const room = emptyRoom(box);
    git(box, room, ["init", "-q", "-b", "main"]);
    // A file whose last line has no newline on it, which is the shape the
    // append has to add one to start its own line on — and the shape a restore
    // that rebuilds the file from its lines quietly changes.
    const excludeFile = join(room, ".git", "info", "exclude");
    const before = "build/\ntmp";
    writeFileSync(excludeFile, before);
    const pointer = join(box.env.XDG_CONFIG_HOME, "superself", "machine.json");
    mkdirSync(join(box.env.XDG_CONFIG_HOME, "superself"), { recursive: true });
    writeFileSync(pointer, "{}\n");
    chmodSync(pointer, 0o444);
    const refused = await selfIn(box, room, ["init", "--cloud", "--workspace", server.wsId], cloudEnv());

    assert.notEqual(refused.code, 0);
    assert.equal(readFileSync(excludeFile, "utf8"), before, "the undone exclude line did not leave the file as it was");
});

test("init I15 removal-fails: a rollback step that cannot run does not replace the cause or stop the next one",
    async (t) =>
{
    const box = machine();
    const room = emptyRoom(box);
    // A store directory this process cannot remove, made unremovable once the
    // catch-up has filled it — so the failure below reaches a rollback whose
    // first step raises.
    const server = await servedWorkspace(t, {
        projects: [{ slug: "atlas" }, { slug: "beta" }],
        answer: (call) =>
        {
            if (call.path.endsWith("/beta/events"))
            {
                chmodSync(join(room, ".superself", "projects", "atlas"), 0o000);
            }
            return undefined;
        }
    });
    // One record in atlas, so that atlas has a state directory to make
    // unremovable by the time the walk reaches beta.
    server.state.log.get("atlas").push({
        id: "01J8INITEVENT0000000000010",
        server_seq: 1,
        ts: "2026-08-31T00:00:00.000Z",
        type: "entity.confirmed",
        origin: { actor: "agent", confirmed: true },
        project: "atlas",
        actor_account: ACCOUNT,
        payload: { kind: "goal", id: "g-1", title: "a record that lands before the rollback" }
    });
    signedIn(box, server);
    git(box, room, ["init", "-q", "-b", "main"]);
    const pointer = join(box.env.XDG_CONFIG_HOME, "superself", "machine.json");
    mkdirSync(join(box.env.XDG_CONFIG_HOME, "superself"), { recursive: true });
    writeFileSync(pointer, "{}\n");
    chmodSync(pointer, 0o444);
    const refused = await selfIn(box, room, ["init", "--cloud", "--workspace", server.wsId], cloudEnv());
    chmodSync(join(room, ".superself", "projects", "atlas"), 0o755);

    assert.notEqual(refused.code, 0);
    assert.ok(existsSync(join(room, ".superself")), "the removal this case is about did not actually fail");
    assert.match(refused.out, /which workspace this machine points at/,
        "a rollback step that raised replaced the failure a person needs to read");
    assert.doesNotMatch(refused.out, /\n\s+at /, "a rollback answered with a stack");
    assert.doesNotMatch(readFileSync(join(room, ".git", "info", "exclude"), "utf8"), /^\.superself\/$/m,
        "a rollback step that raised skipped the step after it");
});

test("init I15 half-store: a server-backed store this machine never attached to is named with its remedy", async (t) =>
{
    const box = machine();
    const server = await servedWorkspace(t);
    signedIn(box, server);
    const room = emptyRoom(box);
    await must(box, room, ["init", "--cloud", "--workspace", server.wsId], cloudEnv());
    // What a killed flow leaves: the store, and a machine pointing at nothing.
    rmSync(join(box.env.XDG_CONFIG_HOME, "superself", "machine.json"));
    const refused = await selfIn(box, room, ["init", "--cloud"], cloudEnv());

    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /this machine is not using it/, "an unattached store was reported as attached already");
    assert.match(refused.out, /self workspace /, "the refusal names no way forward");
});

/* ── I16: the first catch-up is the one that may not report success ── */

// A slug this filesystem cannot hold a directory for. The delta arrives, the
// write of it fails, and the question is what the flow does about it: every
// other catch-up swallows a local failure because the command behind it reads
// what this machine already holds, and this one has nothing behind it.
const UNWRITABLE_SLUG = "b".repeat(300);

test("init I16 delta-write-fails: one project's delta failing mid-catch-up leaves no store at all", async (t) =>
{
    const box = machine();
    const server = await servedWorkspace(t, { projects: [{ slug: "atlas" }, { slug: UNWRITABLE_SLUG }] });
    server.state.log.get(UNWRITABLE_SLUG).push({
        id: "01J8INITEVENT0000000000009",
        server_seq: 1,
        ts: "2026-08-31T00:00:00.000Z",
        type: "entity.confirmed",
        origin: { actor: "agent", confirmed: true },
        project: UNWRITABLE_SLUG,
        actor_account: ACCOUNT,
        payload: { kind: "goal", id: "g-1", title: "a record that cannot land here" }
    });
    signedIn(box, server);
    const room = emptyRoom(box);
    const refused = await selfIn(box, room, ["init", "--cloud", "--workspace", server.wsId], cloudEnv());

    assert.notEqual(refused.code, 0, "a catch-up that could not write a project reported the store as made");
    nothingWasMade(box, room);
});

// The first catch-up's bound is per project and moves with the work, so the two
// cases below are about *progress* rather than about size: a workspace this
// machine keeps getting through is read however long that takes, and one it has
// stopped getting through is refused however few projects are left.
//
// Both call `firstCatchUp` the way the flow calls it, with a small allowance —
// the seam `pullEverySlug`'s own comment says exists for this. What follows a
// refusal is the caller's and is I9's and I16 `delta-write-fails`'s: the same
// `orRemove` takes the store off the disk for every way this can end short.
async function inTheStore(box, work)
{
    const was = { ...process.env };
    Object.assign(process.env, box.env, cloudEnv());
    try
    {
        return await work();
    }
    finally
    {
        Object.keys(process.env).forEach((key) => delete process.env[key]);
        Object.assign(process.env, was);
    }
}

// A workspace that answers every delta after a wait. `slow` is per request, so
// a walk over `count` projects takes `count` times it.
async function slowWorkspace(t, count, slow)
{
    return servedWorkspace(t, {
        projects: Array.from({ length: count }, (unused, index) => ({ slug: `p${index + 1}` })),
        answer: (call) => call.path.endsWith("/events") && call.method === "GET"
            ? new Promise((ready) => setTimeout(ready, slow))
            : undefined
    });
}

// The three files `writeStore` writes, written here so the pass under test is
// the catch-up alone: what a case about the bound must not depend on is a
// second catch-up having already run.
function bareStore(box, room, server)
{
    const storeDir = join(room, ".superself");
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(join(storeDir, "registry.jsonl"), "");
    writeFileSync(join(storeDir, "config.json"), JSON.stringify({ lang: "en" }) + "\n");
    writeFileSync(join(storeDir, WORKSPACE_FILE),
        JSON.stringify({ base: server.url, wsId: server.wsId, mode: "api" }) + "\n");
    return storeDir;
}

test("init I16 long-catch-up: a walk that keeps finishing projects is read out however long it takes",
    { timeout: 30_000 }, async (t) =>
{
    const box = machine();
    // Eight projects at 200ms each is over a second and a half of walking
    // against an allowance of one second per project — a workspace whose
    // *total* is well past the bound and every one of whose projects is well
    // inside it. A flat bound refuses this and destroys the store, and every
    // retry refuses again at the same place; there is no size of workspace this
    // CLI cannot attach to.
    const server = await slowWorkspace(t, 8, 200);
    signedIn(box, server);
    const room = emptyRoom(box);
    const storeDir = bareStore(box, room, server);

    const started = Date.now();
    await inTheStore(box, () => firstCatchUp(storeDir, { each: 1000 }));

    assert.ok(Date.now() - started > 1000, "the walk did not outlast the bound one project is given");
    assert.equal(JSON.parse(readFileSync(join(storeDir, "sync.place"), "utf8")).slug, "p8",
        "a walk that finished every project inside its own allowance stopped before the last one");
});

test("init I16 stalled-catch-up: a walk that stops getting through projects is a refusal, not a store", async (t) =>
{
    const box = machine();
    // Every delta takes four times what one project is given, so no project
    // finishes inside its allowance and the pass has stopped rather than slowed.
    const server = await slowWorkspace(t, 3, 600);
    signedIn(box, server);
    const room = emptyRoom(box);
    const storeDir = bareStore(box, room, server);

    await inTheStore(box, () => assert.rejects(() => firstCatchUp(storeDir, { each: 150 }),
        /stopped getting through it/, "a pass that stalled on its first project reported a finished catch-up"));
});

test("init I16 lock-stays-fresh: a long first catch-up is never the stale lock another process may steal",
    { timeout: 30_000 }, async (t) =>
{
    const box = machine();
    const server = await slowWorkspace(t, 8, 200);
    signedIn(box, server);
    const room = emptyRoom(box);
    const storeDir = bareStore(box, room, server);

    // What another process on this machine sees while the walk runs: the age of
    // the lock, and whose it is. `SYNC_LEASE_MS` rests on a live holder never
    // reaching the stealing age, and a bound that keeps extending while the
    // stamp does not move is exactly how a live holder would.
    const held = new Set();
    let oldest = 0;
    const watching = setInterval(() =>
    {
        const record = readLock(storeDir);
        if (record !== null)
        {
            held.add(record.nonce);
            oldest = Math.max(oldest, Date.now() - Date.parse(record.at));
        }
    }, 20);
    try
    {
        await inTheStore(box, () => firstCatchUp(storeDir, { each: 1000 }));
    }
    finally
    {
        clearInterval(watching);
    }

    assert.equal(held.size, 1, "one walk was seen holding the lock under more than one nonce");
    assert.ok(oldest < 1000, `the lock was seen ${oldest}ms old during a walk bounded at 1000ms per project`);
});

function readLock(storeDir)
{
    try
    {
        return JSON.parse(readFileSync(join(storeDir, "sync.lock"), "utf8"));
    }
    catch
    {
        return null;
    }
}

test("init I16 unreadable-list: a project list that is not a list is an unreachable workspace, not an empty one", async (t) =>
{
    const box = machine();
    const server = await servedWorkspace(t, {
        answer: (call) => call.method === "GET" && call.path.endsWith("/projects")
            ? { status: 200, body: { projects: [] } }
            : undefined
    });
    signedIn(box, server);
    const room = emptyRoom(box);
    const refused = await selfIn(box, room, ["init", "--cloud", "--workspace", server.wsId], cloudEnv());

    assert.notEqual(refused.code, 0, "a body this CLI cannot read was reported as a workspace with no projects");
    nothingWasMade(box, room);
});

/* ── I17: the store that appeared while the login was running ──────── */

test("init I17 store-appeared: a directory that became a store during the login is refused, never truncated", async (t) =>
{
    const box = machine();
    const room = emptyRoom(box);
    const server = await servedWorkspace(t, {
        answer: (call) =>
        {
            // The other `self init` in the same directory, finishing while
            // this one waits for a person to approve a device.
            if (call.path === "/api/device/poll")
            {
                mkdirSync(join(room, ".superself"), { recursive: true });
                writeFileSync(join(room, ".superself", "registry.jsonl"), '{"slug":"already-here"}\n');
            }
            return deviceFlow(ACCOUNT, WORKSPACE_SCOPES)(call);
        }
    });
    const refused = await selfIn(box, room, ["init", "--cloud", "--workspace", server.wsId],
        cloudEnv({ SUPERSELF_API_BASE: server.url }));

    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /another `self init` is running/);
    assert.match(readFileSync(join(room, ".superself", "registry.jsonl"), "utf8"), /already-here/,
        "the store that appeared was truncated or removed");
});

test("init I17 bad-lang: a language code is refused before a person is sent to approve a device", async (t) =>
{
    const box = machine();
    const server = await servedWorkspace(t, { answer: deviceFlow(ACCOUNT, WORKSPACE_SCOPES) });
    const room = emptyRoom(box);
    const refused = await selfIn(box, room, ["init", "--cloud", "--workspace", server.wsId, "--lang", "not a code"],
        cloudEnv({ SUPERSELF_API_BASE: server.url }));

    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /is not a language code/);
    assert.deepEqual(server.calls, [], "a device approval was spent before the language code was read");
    nothingWasMade(box, room);
});

/* ── I18–I20: the workspace is chosen from a list ──────────────────── */

// An account can be a member of several workspaces, so an id alone is
// something a person has to have written down. `GET /api/workspaces` (C1
// v0.9.6) is the one route outside the workspace segment, and it is what makes
// the question answerable: these are yours, choose one.

// Two memberships with the served one second, so a pick that answered the
// first row by accident would attach to the wrong workspace and the marker
// would say so.
async function twoMemberships(t)
{
    const server = await servedWorkspace(t, { workspaces: [] });
    server.state.memberships = [{ id: "ws_01J8OTHER", name: "Another Team", status: "active" },
        { id: server.wsId, name: "Atlas Team", status: "active" }];
    return server;
}

test("init I18 list-pick: the workspaces this account is a member of are shown, and a number chooses one", async (t) =>
{
    const box = machine();
    const server = await twoMemberships(t);
    signedIn(box, server);
    const room = emptyRoom(box);
    const made = await drive(box, room, ["init", "--cloud", "--lang", "en", "--agents"],
        { tty: true, answer: "2", extra: cloudEnv() });

    assert.equal(made.code, 0, made.out);
    assert.match(made.out, /1\) Another Team \(ws_01J8OTHER\)/, "the list did not show every membership by name");
    assert.match(made.out, /2\) Atlas Team/);
    assert.deepEqual(markerIn(room), { base: server.url, wsId: server.wsId, mode: "api" });
});

test("init I18 list-pick-by-id: an id pasted into the same question is taken as the choice", async (t) =>
{
    const box = machine();
    const server = await twoMemberships(t);
    signedIn(box, server);
    const room = emptyRoom(box);
    const made = await drive(box, room, ["init", "--cloud", "--lang", "en", "--agents"],
        { tty: true, answer: server.wsId, extra: cloudEnv() });

    assert.equal(made.code, 0, made.out);
    assert.deepEqual(markerIn(room), { base: server.url, wsId: server.wsId, mode: "api" });
});

test("init I18 list-pick-not-a-number: an answer that is not a number on the list and not an id on it is refused",
    async (t) =>
{
    const box = machine();
    const server = await twoMemberships(t);
    signedIn(box, server);
    const room = emptyRoom(box);
    // `Number` reads all three of these as integers. None of them was written
    // on the list, so none of them is an answer to the question that was asked.
    for (const typed of ["0x2", "2e0", "+2"])
    {
        const refused = await drive(box, emptyRoom(box, `room-${typed.trim()}`), ["init", "--cloud", "--lang", "en"],
            { tty: true, answer: typed, extra: cloudEnv() });

        assert.notEqual(refused.code, 0, `"${typed}" chose a workspace off the list`);
        assert.match(refused.out, /neither a number on that list nor an id on it/);
    }
    assert.deepEqual(readdirSync(room), [], "a refused pick made a store");
});

test("init I18 list-pick-numeric-id: a workspace whose id reads as a number is chosen by that id", async (t) =>
{
    const box = machine();
    // openapi 0.9.4 puts no pattern on `Workspace.id`, so this is a conformant
    // list — and reading the answer as a place on it would attach this machine
    // to the first row instead of to the workspace the person named.
    const server = await servedWorkspace(t, { wsId: "2", workspaces: [] });
    server.state.memberships = [{ id: "ws_01J8OTHER", name: "Another Team", status: "active" },
        { id: "2", name: "Atlas Team", status: "active" }];
    signedIn(box, server);
    const room = emptyRoom(box);
    const made = await drive(box, room, ["init", "--cloud", "--lang", "en", "--agents"],
        { tty: true, answer: "2", extra: cloudEnv() });

    assert.equal(made.code, 0, made.out);
    assert.equal(markerIn(room).wsId, "2", "a numeric id was read as a place on the list");
});

test("init I11 pointer-through-a-symlink: a machine pointed at a symlinked path is using the store behind it",
    async (t) =>
{
    const box = machine();
    const server = await servedWorkspace(t);
    signedIn(box, server);
    const room = emptyRoom(box);
    await must(box, room, ["init", "--cloud", "--workspace", server.wsId], cloudEnv());
    // `self workspace` records what it was given, resolved but not followed, so
    // this is the ordinary state of a machine pointed at a store through a link.
    const link = join(box.root, "link");
    symlinkSync(room, link);
    await must(box, room, ["workspace", link]);
    const refused = await selfIn(box, room, ["init", "--cloud"], cloudEnv());

    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /attached to a workspace already/,
        "a store this machine is using through a link was reported as one it is not using");
});

test("init I19 workspace-not-listed: an id this account is not a member of is refused, naming the ones it is", async (t) =>
{
    const box = machine();
    const server = await servedWorkspace(t);
    signedIn(box, server);
    const room = emptyRoom(box);
    const refused = await selfIn(box, room, ["init", "--cloud", "--workspace", "ws_01J8SOMEBODYELSE"], cloudEnv());

    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /ws_01J8SOMEBODYELSE/);
    assert.match(refused.out, new RegExp(server.wsId), "the refusal does not say which workspaces this account can reach");
    assert.match(refused.out, /self login/);
    nothingWasMade(box, room);
});

test("init I19 closed-workspace: a closed workspace is shown on the list and refused as a choice", async (t) =>
{
    const box = machine();
    const server = await servedWorkspace(t, {
        workspaces: [{ id: "ws_01J8CLOSED", name: "Last Year's Team", status: "closed" }]
    });
    signedIn(box, server);
    const shown = await drive(box, emptyRoom(box, "shown"), ["init", "--cloud", "--lang", "en", "--agents"],
        { tty: true, answer: "1", extra: cloudEnv() });

    assert.notEqual(shown.code, 0);
    assert.match(shown.out, /Last Year's Team.*closed/s, "a closed workspace was not shown as closed");
    assert.match(shown.out, /is closed/);
    nothingWasMade(box, join(box.root, "shown"));

    const flagged = await selfIn(box, emptyRoom(box, "flagged"), ["init", "--cloud", "--workspace", "ws_01J8CLOSED"], cloudEnv());

    assert.notEqual(flagged.code, 0);
    assert.match(flagged.out, /is closed/, "`--workspace` reached a closed workspace the question refuses");
    nothingWasMade(box, join(box.root, "flagged"));
});

test("init I20 no-memberships: an account that is a member of nothing is told so, and asked nothing", async (t) =>
{
    const box = machine();
    const server = await servedWorkspace(t, { workspaces: [] });
    signedIn(box, server);
    const room = emptyRoom(box);
    const refused = await drive(box, room, ["init", "--cloud", "--lang", "en", "--agents"],
        { tty: true, answer: "", extra: cloudEnv() });

    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /not a member of any workspace yet/);
    assert.doesNotMatch(refused.out, /choose a number/, "an empty list was still put to somebody as a question");
    assert.doesNotMatch(refused.out, /at .*\.js:\d+|node:internal/, "a stack reached the caller");
    nothingWasMade(box, room);
});
