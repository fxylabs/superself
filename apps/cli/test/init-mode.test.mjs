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
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../dist/main.js";
import { checkContract } from "../dist/contract.js";
import { commandUsage } from "../dist/help.js";
import { DEFAULT_AGENT_SCOPES, WORKSPACE_SCOPES } from "../dist/login.js";
import { WORKSPACE_FILE } from "../dist/mode.js";
import { firstCatchUp } from "../dist/puller.js";
import { approvedIn, drive, git, machine, must, selfIn } from "./harness.mjs";
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
        answer: (call) => (call.path.endsWith("/events") ? process.emit("SIGINT") : undefined) && undefined
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

test("init I16 short-catch-up: a catch-up that ran out of its lease is a refusal, not a store", async (t) =>
{
    const box = machine();
    const server = await servedWorkspace(t, { projects: [{ slug: "atlas" }, { slug: "beta" }] });
    signedIn(box, server);
    const room = emptyRoom(box);
    await must(box, room, ["init", "--cloud", "--workspace", server.wsId], cloudEnv());

    // The lease is a bound on the pass rather than on the function, so a case
    // states one: this is the same call the flow makes, with a deadline that
    // has already gone by. There is no way to reach it through the command
    // surface without waiting out `PULLER_LEASE_MS`.
    const was = { ...process.env };
    Object.assign(process.env, box.env, cloudEnv());
    try
    {
        await assert.rejects(() => firstCatchUp(join(room, ".superself"), Date.now() - 1),
            /did not finish reading it/, "a pass that reached no project at all reported a finished catch-up");
    }
    finally
    {
        Object.keys(process.env).forEach((key) => delete process.env[key]);
        Object.assign(process.env, was);
    }
});

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
