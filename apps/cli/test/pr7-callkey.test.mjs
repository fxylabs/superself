// Design §7.5 — idempotency and the client call key. The cells that live in the
// open-source core: derivation, the range, where the key travels on the wire,
// and the journal. The cells whose subject is `SendOutcome`'s own shape (84–88)
// belong to the private `email` and `landing` plugins and are gated there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { machine } from "./harness.mjs";
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

test("cell 89: the key is echoed in the answer and written to the journal", async () =>
{
    const it = machine();
    installFixture(it, { key: "keyed", entry: keyedPlugin() });
    const rail = await railServer(() => ({ status: 200, body: { ok: true } }));
    try
    {
        writeCredential(it, { apiBase: rail.url });
        const result = await selfAsync(it, it.root, ["keyed", "--json"], railEnv(rail));
        assert.equal(result.code, 0, result.out + result.err);
        assert.match(jsonOf(result.out).idempotency_key, /^ck_[0-9a-f]{32}$/);
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
