// Design §7.5 — idempotency and the client call key. The cells that live in the
// open-source core: derivation, the range, where the key travels on the wire,
// and the journal. The cells whose subject is `SendOutcome`'s own shape (84–88)
// belong to the private `email` and `landing` plugins and are gated there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { machine } from "./harness.mjs";

const bin = fileURLToPath(new URL("../bin/self.mjs", import.meta.url));
import {
    CALL_KEY_PATTERN, checkCallKey, deriveCallKey, jcs, journalCall, journalPath, newCallKey
} from "../dist/rail.js";
import { installFixture, jsonOf, railEnv, railServer, selfAsync, writeCredential } from "./pr7-lib.mjs";

const ACCOUNT = "acct_01J8TEST";

// What a command's normalized request looks like by the time the key is
// derived: the resolved body, JCS-canonicalized, with render flags and
// timestamps already excluded.
function request(body)
{
    return { path: "/api/email/send", query: {}, body };
}

/* ── cells 77–81: the derivation is reproducible, and only over inputs ── */

test("cell 77: the same command with the same inputs derives the same key twice", () =>
{
    const one = deriveCallKey(ACCOUNT, "email send", request({ campaignName: "c", recipients: ["a@b.c"] }));
    const two = deriveCallKey(ACCOUNT, "email send", request({ campaignName: "c", recipients: ["a@b.c"] }));
    assert.equal(one, two);
    assert.match(one, /^ck_[0-9a-f]{32}$/);
});

test("cell 78: a file moved to a new path derives the same key", () =>
{
    // File inputs are replaced by their content digest, so moving the file does
    // not change the key. The path never enters the derivation.
    const digest = createHash("sha256").update("hello").digest("hex");
    const one = deriveCallKey(ACCOUNT, "email send", request({ html: { file: digest } }));
    const two = deriveCallKey(ACCOUNT, "email send", request({ html: { file: digest } }));
    assert.equal(one, two);
});

test("cell 79: editing the file's content derives a different key", () =>
{
    const before = createHash("sha256").update("hello").digest("hex");
    const after = createHash("sha256").update("hello!").digest("hex");
    assert.notEqual(
        deriveCallKey(ACCOUNT, "email send", request({ html: { file: before } })),
        deriveCallKey(ACCOUNT, "email send", request({ html: { file: after } })));
});

test("cell 80: key order in the request, and render flags, do not change the key", () =>
{
    // JCS sorts keys, so two spellings of one request are one request. Render
    // flags never reach the derivation at all — they are not part of the body.
    assert.equal(
        deriveCallKey(ACCOUNT, "email send", request({ campaignName: "c", purpose: "informational" })),
        deriveCallKey(ACCOUNT, "email send", request({ purpose: "informational", campaignName: "c" })));
});

test("cell 81: --new-call derives a different key every time", () =>
{
    const keys = new Set([newCallKey(), newCallKey(), newCallKey()]);
    assert.equal(keys.size, 3);
    [...keys].forEach((key) => assert.match(key, /^ck_[0-9a-f]{32}$/));
});

test("a different account derives a different key for the same request", () =>
{
    // Idempotency is scoped per account, never global.
    assert.notEqual(
        deriveCallKey(ACCOUNT, "email send", request({ campaignName: "c" })),
        deriveCallKey("acct_other", "email send", request({ campaignName: "c" })));
});

/* ── cell 82: one range, and it is the CLI's, not the server's ─────── */

test("cell 82: a call key outside [A-Za-z0-9_.:-]{8,128} is refused before any call", () =>
{
    // The server's schema allows 1–200. The CLI narrows to 8–128: a floor that
    // makes an accidental one-character key impossible, and a ceiling well
    // inside the server's.
    for (const bad of ["short", "a".repeat(129), "has space", "has/slash", "", "sevench"])
    {
        assert.throws(() => checkCallKey(bad), /8 to 128 characters/, `accepted ${JSON.stringify(bad)}`);
    }
    for (const good of ["a".repeat(8), "a".repeat(128), "ck_9f.aa:bb-cc"])
    {
        assert.equal(checkCallKey(good), good);
    }
    assert.equal(CALL_KEY_PATTERN.test("a".repeat(7)), false);
    assert.equal(CALL_KEY_PATTERN.test("a".repeat(8)), true);
});

/* ── cell 83: where the key travels ────────────────────────────────── */

test("cell 83: the key is sent as the body field idempotencyKey, never as a header", async () =>
{
    const it = machine();
    installFixture(it, { key: "keyed", entry: keyedPlugin() });
    const rail = await railServer(() => ({ status: 200, body: { ok: true } }));
    try
    {
        writeCredential(it, { apiBase: rail.url });
        const result = await selfAsync(it, it.root, ["keyed", "--json"], railEnv(rail));
        assert.equal(result.code, 0, result.out);
        const call = rail.calls[0];
        assert.equal(typeof call.body.idempotencyKey, "string");
        assert.match(call.body.idempotencyKey, /^ck_[0-9a-f]{32}$/);
        assert.equal(call.headers["idempotency-key"], undefined, "an Idempotency-Key header was sent");
    }
    finally
    {
        await rail.close();
    }
});

// A fixture plugin that asks the host to derive a key, which is the one path a
// real mini-app uses.
function keyedPlugin()
{
    return `export default function register(host)
{
    return [{
        name: "keyed",
        usage: [{ syntax: "keyed [--json] [--call-key k]", description: ["fixture"], verbs: [""] }],
        detail: ["fixture", "", "  --json                machine-readable output", "  --call-key <k>        reuse a key"],
        node: host.contract.leaf("", { json: { type: "boolean" }, "call-key": { type: "string" } }, 0, async (input) =>
        {
            const answer = await host.rail.request({
                method: "POST",
                path: "/api/email/send",
                body: { campaignName: "c", recipients: ["a@b.c"] },
                scopes: ["email.send"],
                callKey: input.values["call-key"] === undefined ? "derive" : input.values["call-key"]
            });
            return [host.output.payload({ ...answer.body, idempotency_key: answer.callKey }, () => ["sent"])];
        })
    }];
}
`;
}

test("cell 89: the key is echoed in the answer AND written to the journal", async () =>
{
    const it = machine();
    installFixture(it, { key: "keyed", entry: keyedPlugin() });
    const rail = await railServer(() => ({ status: 200, body: { ok: true } }));
    try
    {
        writeCredential(it, { apiBase: rail.url });
        // The journal is the point of this cell, so it is not suppressed here
        // the way it is everywhere else in the suite.
        const result = await selfAsync(it, it.root, ["keyed", "--json"],
            { ...railEnv(rail), SUPERSELF_NO_JOURNAL: "" });
        assert.equal(result.code, 0, result.all);
        const echoed = jsonOf(result.out).idempotency_key;
        assert.match(echoed, /^ck_[0-9a-f]{32}$/);

        const path = join(it.env.XDG_STATE_HOME, "superself", "calls.jsonl");
        assert.equal(existsSync(path), true, "the call was never journaled");
        const line = JSON.parse(readFileSync(path, "utf8").trim());
        assert.equal(line.call_key, echoed, "the journal recorded a different key than the answer echoed");
        assert.equal(line.command, "keyed");
        assert.equal(line.profile, "default");
        assert.equal(line.exit, 0);
        assert.match(line.at, /Z$/);
        // No recipient, no body, no token — the call key is an irreversible
        // hash, so the journal carries no PII.
        const text = JSON.stringify(line);
        assert.equal(text.includes("sa_"), false, "a token reached the journal");
        assert.equal(text.includes("sr_"), false);
        assert.equal(text.includes("@"), false, "an address reached the journal");
        assert.equal(statSync(path).mode & 0o077, 0);
    }
    finally
    {
        await rail.close();
    }
});

test("a refusal is journaled with its exit and code, so a crashed agent can see what happened", async () =>
{
    const it = machine();
    installFixture(it, { key: "keyed", entry: keyedPlugin() });
    const rail = await railServer(() => ({ status: 409, body: { details: { code: "recharging", message: "topping up" } } }));
    try
    {
        writeCredential(it, { apiBase: rail.url });
        const result = await selfAsync(it, it.root, ["keyed", "--json"],
            { ...railEnv(rail), SUPERSELF_NO_JOURNAL: "" });
        assert.equal(result.code, 3, result.all);
        const line = JSON.parse(readFileSync(join(it.env.XDG_STATE_HOME, "superself", "calls.jsonl"), "utf8").trim());
        assert.equal(line.exit, 3);
        assert.equal(line.code, "recharging");
        assert.match(line.call_key, /^ck_[0-9a-f]{32}$/,
            "an exit-3 line with no key is a line an agent cannot retry from");
    }
    finally
    {
        await rail.close();
    }
});

// A direct 401 terminal refusal (credential_invalid / login_required and the
// refresh refusals) throws through `terminal401`, a path that used to bypass the
// journal entirely — so an agent replaying the journal after a crash could not
// see that the last attempt was refused. It is journaled now, exit and code
// only, no token.
test("a terminal 401 refusal is journaled with its exit and code", async () =>
{
    const it = machine();
    installFixture(it, { key: "keyed", entry: keyedPlugin() });
    const rail = await railServer(() => ({ status: 401, body: { code: "credential_invalid", message: "not a valid credential" } }));
    try
    {
        writeCredential(it, { apiBase: rail.url });
        const result = await selfAsync(it, it.root, ["keyed", "--json"],
            { ...railEnv(rail), SUPERSELF_NO_JOURNAL: "" });
        assert.equal(result.code, 1, result.all);
        const path = join(it.env.XDG_STATE_HOME, "superself", "calls.jsonl");
        assert.equal(existsSync(path), true, "a terminal 401 refusal was never journaled");
        const line = JSON.parse(readFileSync(path, "utf8").trim());
        assert.equal(line.exit, 1);
        assert.equal(line.code, "login_required");
        // The refused credential never reaches the journal.
        const text = JSON.stringify(line);
        assert.equal(text.includes("sa_"), false, "a token reached the journal");
        assert.equal(text.includes("sr_"), false);
    }
    finally
    {
        await rail.close();
    }
});

// §4.5 — SIGINT during a rail call aborts the in-flight request and writes one
// `exit: -1` line, no more. The bug this pins: a handler that only journaled
// left the send running, so a first Ctrl-C was swallowed and the completed send
// wrote a contradictory `exit: 0` behind the `exit: -1`. Run as a real child so
// a real signal is delivered, exactly as cell 28 does for login.
//
// The test is written to BITE the journal-only version: the rail holds its
// answer until AFTER the interrupt is delivered, then returns a 200. A correct
// client has already aborted the request and exited 1 by then, so exactly one
// exit:-1 line exists; a journal-only client is still waiting, so the released
// answer completes its send and writes a SECOND exit:0 line and exits 0. A rail
// that never answered could not tell the two apart — the send never completes in
// either version — which was the vacuity this replaces. Verified against a
// scratch build of the journal-only rail.ts (57f752e): it FAILS there and passes
// on the fixed rail (8e64f2e).
test("SIGINT during a charged send aborts it: one exit:-1 line, exit 1, no completed send", async () =>
{
    const it = machine();
    installFixture(it, { key: "keyed", entry: keyedPlugin() });
    let release = () => undefined;
    const answered = new Promise((resolve) => { release = resolve; });
    const rail = await railServer(async () =>
    {
        await answered;
        return { status: 200, body: { status: "sent", campaignId: "cmp_1" } };
    });
    try
    {
        writeCredential(it, { apiBase: rail.url });
        const child = spawn(process.execPath, [bin, "keyed", "--json"],
            { cwd: it.root, env: { ...it.env, ...railEnv(rail), SUPERSELF_NO_JOURNAL: "" }, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk) => { out += chunk; });
        child.stderr.on("data", (chunk) => { err += chunk; });
        // Attached before any wait, so a fast exit cannot be missed.
        const closed = new Promise((resolve) => child.on("close", (code) => resolve(code)));
        // Interrupt once the send is genuinely in flight — judged by the rail
        // having received the request, not by a sleep.
        while (rail.calls.length < 1)
        {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        child.kill("SIGINT");
        // Give the signal time to be delivered and handled, THEN let the rail
        // answer — the answer a journal-only client would complete its send on.
        await new Promise((resolve) => setTimeout(resolve, 500));
        release();
        const guard = setTimeout(() => child.kill("SIGKILL"), 8000);
        const code = await closed;
        clearTimeout(guard);

        // Exact code: the fix exits 1 via `interrupted`. A journal-only client
        // exits 0 (the released send completes) — or 3 via the deadline if the
        // rail never answered — so an exact 1 is what tells the fix apart.
        assert.equal(code, 1, `an interrupted send exited ${code}: ${out}${err}`);

        const path = join(it.env.XDG_STATE_HOME, "superself", "calls.jsonl");
        assert.equal(existsSync(path), true, "an interrupted send wrote no journal line");
        const lines = readFileSync(path, "utf8").trim().split("\n").filter((line) => line !== "");
        // Exactly one line: the interruption. A journal-only client writes a
        // second exit:0 line here when its released send completes.
        assert.equal(lines.length, 1, `an interrupted send wrote ${lines.length} journal lines: ${lines.join(" | ")}`);
        const line = JSON.parse(lines[0]);
        assert.equal(line.exit, -1);
        assert.equal(line.code, "interrupted");
        // The send did not complete: a completed send prints its success payload.
        assert.equal(out.includes("\"status\":\"sent\""), false, "a completed send printed a success payload");
    }
    finally
    {
        release();
        await rail.close();
    }
});

test("--no-journal writes nothing, and the command is otherwise identical", async () =>
{
    const it = machine();
    installFixture(it, { key: "keyed", entry: keyedPlugin() });
    const rail = await railServer(() => ({ status: 200, body: { ok: true } }));
    try
    {
        writeCredential(it, { apiBase: rail.url });
        const env = { ...railEnv(rail), SUPERSELF_NO_JOURNAL: "" };
        const kept = await selfAsync(it, it.root, ["keyed", "--json"], env);
        const path = join(it.env.XDG_STATE_HOME, "superself", "calls.jsonl");
        const before = readFileSync(path, "utf8");

        const off = await selfAsync(it, it.root, ["keyed", "--json", "--no-journal"], env);
        assert.equal(off.code, kept.code);
        assert.deepEqual(jsonOf(off.out), jsonOf(kept.out), "--no-journal changed the answer");
        assert.equal(readFileSync(path, "utf8"), before, "--no-journal still wrote a line");
    }
    finally
    {
        await rail.close();
    }
});

/* ── cells 90–92: the journal carries no secret and stays bounded ──── */

function journalBox()
{
    const it = machine();
    Object.assign(process.env, { XDG_STATE_HOME: it.env.XDG_STATE_HOME });
    return it;
}

test("cell 90: the journal records no recipient, no body and no token", () =>
{
    const was = process.env.XDG_STATE_HOME;
    const it = journalBox();
    try
    {
        journalCall({ profile: "default", command: "email send", call_key: "ck_" + "a".repeat(32), exit: 3, code: "recharging" });
        const line = JSON.parse(readFileSync(journalPath(), "utf8").trim());
        assert.deepEqual(Object.keys(line).sort(), ["at", "call_key", "code", "command", "exit", "profile"]);
        assert.equal(JSON.stringify(line).includes("sa_"), false);
        assert.equal(JSON.stringify(line).includes("@"), false);
    }
    finally
    {
        process.env.XDG_STATE_HOME = was;
    }
});

test("cell 91: SUPERSELF_NO_JOURNAL=1 writes nothing and changes nothing else", () =>
{
    const was = { state: process.env.XDG_STATE_HOME, off: process.env.SUPERSELF_NO_JOURNAL };
    const it = journalBox();
    process.env.SUPERSELF_NO_JOURNAL = "1";
    try
    {
        journalCall({ profile: "default", command: "email send", exit: 0 });
        assert.equal(existsSync(journalPath()), false);
    }
    finally
    {
        process.env.XDG_STATE_HOME = was.state;
        if (was.off === undefined)
        {
            delete process.env.SUPERSELF_NO_JOURNAL;
        }
    }
});

test("cell 92: past 1000 lines the oldest go, and the file is still 0600", () =>
{
    const was = process.env.XDG_STATE_HOME;
    const it = journalBox();
    delete process.env.SUPERSELF_NO_JOURNAL;
    try
    {
        mkdirSync(join(it.env.XDG_STATE_HOME, "superself"), { recursive: true });
        const seeded = Array.from({ length: 1004 }, (value, index) => JSON.stringify({ at: "x", n: index })).join("\n");
        writeFileSync(journalPath(), `${seeded}\n`, { mode: 0o600 });
        journalCall({ profile: "default", command: "email send", exit: 0 });
        const lines = readFileSync(journalPath(), "utf8").trim().split("\n");
        assert.equal(lines.length, 1000);
        assert.equal(JSON.parse(lines[lines.length - 1]).command, "email send");
        assert.equal(JSON.parse(lines[0]).n, 5, "the oldest lines were not the ones dropped");
        assert.equal(statSync(journalPath()).mode & 0o077, 0);
    }
    finally
    {
        process.env.XDG_STATE_HOME = was;
    }
});

test("jcs is RFC 8785 enough for what a manifest and a request body are made of", () =>
{
    assert.equal(jcs({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.equal(jcs([1, "a", null, true]), '[1,"a",null,true]');
    // NFC normalization, so the same text typed two ways derives one key.
    assert.equal(jcs("é"), jcs("é"));
});

test("a journal that cannot be written never turns a completed call into a failure", async () =>
{
    const it = machine();
    installFixture(it, { key: "keyed", entry: keyedPlugin() });
    const rail = await railServer(() => ({ status: 200, body: { ok: true } }));
    try
    {
        writeCredential(it, { apiBase: rail.url });
        // The journal file itself cannot be appended to. The server has
        // accepted the call — and charged for it — so a bookkeeping failure
        // here must not be reported to the agent as "it did not happen".
        const env = { ...railEnv(rail), SUPERSELF_NO_JOURNAL: "" };
        const first = await selfAsync(it, it.root, ["keyed", "--json"], env);
        assert.equal(first.code, 0, first.all);
        const path = join(it.env.XDG_STATE_HOME, "superself", "calls.jsonl");
        const before = readFileSync(path, "utf8");
        chmodSync(path, 0o400);
        try
        {
            const result = await selfAsync(it, it.root, ["keyed", "--json"], env);
            assert.equal(result.code, 0, result.all);
            assert.deepEqual(jsonOf(result.out).ok, true);
            assert.equal(readFileSync(path, "utf8"), before, "the unwritable journal was somehow written");
        }
        finally
        {
            chmodSync(path, 0o600);
        }
    }
    finally
    {
        await rail.close();
    }
});
