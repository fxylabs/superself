// Design §7.4 (server outcome × exit code and shape), §7.7 (output mode),
// §7.8 (non-regression) and §8.8 (the six JSON schema contract families).
//
// Every error asserted here is the **one envelope of §2.6**. That is the point
// of the schema half: one shape validates every command's failures, so an agent
// writes one parser rather than six.
//
// Cells whose subject is a mini-app's own payload — `SendOutcome`'s
// `human_review`, `stopped_reason` and demo shapes (62, 71, 72), the money
// scale (76), the bundle properties (58, 129, 130), the recipient cap (146) and
// the domain resolution (122–125) — are gated in the private plugin packages,
// where those shapes are actually produced.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { machine, demoWorkspace, selfIn } from "./harness.mjs";
import { COMMANDS } from "../dist/main.js";
import { checkContract, commandLeaves } from "../dist/contract.js";
import {
    EXIT_2_ACCOUNT_AUTHORIZE, EXIT_2_ACCOUNT_GATE, EXIT_2_CODES, EXIT_2_EMAIL, EXIT_2_LANDING,
    EXIT_2_OTHER, EXIT_2_WALLET, EXIT_3_CODES, UNREACHABLE_CODES,
    commandDeadlineMs, errorCode, exitFor, normalizeError, sanitizeText, toSnake
} from "../dist/rail.js";
import { DEFAULT_AGENT_SCOPES } from "../dist/login.js";
import { installFixture, jsonOf, railEnv, railServer, selfAsync, selfSplit, writeCredential } from "./pr7-lib.mjs";

function box()
{
    const created = machine();
    return { ...created, demo: created.root };
}

// A fixture plugin whose one leaf makes one rail call and hands the answer
// straight back — the thinnest thing that still exercises the whole path.
function railPlugin(extra = "")
{
    return `export default function register(host)
{
    return [{
        name: "probe",
        usage: [{ syntax: "probe [--json]", description: ["fixture"], verbs: [""] }],
        detail: ["fixture", "", "  --json                machine-readable output"],
        node: host.contract.leaf("", { json: { type: "boolean" } }, 0, async () =>
        {
            ${extra}
            const answer = await host.rail.request({
                method: "POST", path: "/api/email/send", body: { campaignName: "c" },
                scopes: ["email.send"], callKey: "derive"
            });
            return [host.output.payload(answer.body, () => ["ok"])];
        })
    }];
}
`;
}

async function probe(answer, args = ["probe", "--json"], plugin = railPlugin())
{
    const it = box();
    installFixture(it, { key: "probe", verbs: ["probe"], entry: plugin });
    const rail = await railServer(() => answer);
    try
    {
        writeCredential(it, { apiBase: rail.url });
        const result = await selfAsync(it, it.demo, args, railEnv(rail));
        return { ...result, it, calls: rail.calls };
    }
    finally
    {
        await rail.close();
    }
}

/* ── the one envelope (design §2.6, §8.8) ──────────────────────────── */

// Field name → whether it is required. The whole schema, in one place, because
// the design puts the whole shape in one place.
const ENVELOPE = {
    code: true, message: true, hint: false, console_url: false, retry_after_s: false,
    idempotency_key: false, request_id: false, rule_hits: false, refusals: false,
    review_id: false, min_version: false, reason: false
};

function assertEnvelope(text, expected = {})
{
    const parsed = jsonOf(text);
    assert.deepEqual(Object.keys(parsed), ["error"], "an error answer carried something beside `error`");
    const error = parsed.error;
    for (const [field, required] of Object.entries(ENVELOPE))
    {
        if (required)
        {
            assert.equal(typeof error[field], "string", `the envelope is missing ${field}`);
        }
    }
    for (const field of Object.keys(error))
    {
        assert.ok(field in ENVELOPE, `the envelope carried an undeclared field ${field}`);
        assert.notEqual(error[field], null, `${field} was sent as null rather than omitted`);
    }
    Object.entries(expected).forEach(([field, value]) => assert.deepEqual(error[field], value, `envelope.${field}`));
    return error;
}

/* ── cells 51–57, 60–61: reading what the server actually sends ────── */

test("cell 51: a 200 is the payload verbatim, snake_cased", async () =>
{
    const result = await probe({ status: 200, body: { campaignId: "cmp_1", retryAfterS: 4, stoppedReason: null } });
    assert.equal(result.code, 0, result.all);
    assert.deepEqual(jsonOf(result.out), { campaign_id: "cmp_1", retry_after_s: 4, stopped_reason: null });
});

test("cell 52: a 409 reads its code from details, never from the framework's error.code", async () =>
{
    const result = await probe({
        status: 409,
        body: {
            error: { code: "ConflictError", message: "wrapped", requestId: "req_01J8" },
            details: { code: "insufficient_balance", message: "not enough", hint: "top up" }
        }
    });
    assert.equal(result.code, 2, result.all);
    assertEnvelope(result.out, { code: "insufficient_balance", message: "not enough", hint: "top up", request_id: "req_01J8" });
});

test("cell 53: the framework's class name never reaches an agent", () =>
{
    assert.equal(errorCode({ error: { code: "ConflictError" }, details: { code: "slug_taken" } }), "slug_taken");
    assert.equal(errorCode({ error: { code: "ConflictError" }, __type: "ConflictError" }), "ConflictError");
    // `code` at the body root wins, which is where AuthFlowError puts it.
    assert.equal(errorCode({ code: "expired_token", details: { code: "other" } }), "expired_token");
});

test("cell 54: an AuthFlowError's top-level code is read from the body root", async () =>
{
    const result = await probe({ status: 400, body: { code: "invalid_request", message: "bad shape" } });
    assert.equal(result.code, 2, result.all);
    assertEnvelope(result.out, { code: "invalid_request" });
});

test("cells 55, 57, 60: the policy refusals are exit 2 and keep their code", async () =>
{
    for (const code of ["settlement_required", "auto_recharge_cap_exhausted", "slug_reserved", "slug_taken",
        "email_not_verified", "demo_quota_exceeded", "demo_sending_stopped", "demo_recipient_not_allowed"])
    {
        const result = await probe({ status: 409, body: { details: { code, message: code, hint: "see the console" } } });
        assert.equal(result.code, 2, `${code}: ${result.all}`);
        assertEnvelope(result.out, { code, hint: "see the console" });
    }
});

test("cell 56: validation_refused carries rule_hits, and a night-window violation lives inside them", async () =>
{
    const result = await probe({
        status: 409,
        body: {
            details: {
                code: "validation_refused", message: "refused",
                ruleHits: [{ rule: "night_window_advertising", detail: "21:00-08:00 KST" }]
            }
        }
    });
    assert.equal(result.code, 2, result.all);
    const error = assertEnvelope(result.out, { code: "validation_refused" });
    assert.deepEqual(error.rule_hits, [{ rule: "night_window_advertising", detail: "21:00-08:00 KST" }]);
});

test("cell 61: the exit-2 account group has two producers, and they are asserted apart", () =>
{
    // (a) the authorize-produced subset is exactly ACCOUNT_STATUSES minus the
    // credential-usable ones. A status added server-side fails here instead of
    // reaching the exit-1 catch-all.
    const ACCOUNT_STATUSES = ["active", "paused", "suspended", "closing", "closed"];
    const CREDENTIAL_USABLE = ["active", "paused"];
    const generated = ACCOUNT_STATUSES.filter((status) => !CREDENTIAL_USABLE.includes(status))
        .map((status) => `account_${status}`);
    assert.deepEqual([...EXIT_2_ACCOUNT_AUTHORIZE].sort(), [...generated].sort());

    // (b) `account_paused` cannot come from that difference — `paused` is in
    // the usable set by construction — so it is asserted separately as the
    // member the rail's admission gate produces.
    assert.deepEqual(EXIT_2_ACCOUNT_GATE, ["account_paused"]);
    assert.equal(generated.includes("account_paused"), false);
    ["account_paused", "account_suspended", "account_closing", "account_closed"]
        .forEach((code) => assert.equal(exitFor(code), 2, `${code} is not exit 2`));
});

/* ── cells 63–68: the pending-retryable set ────────────────────────── */

test("cells 63–65: recharging, call_in_progress and deploy_superseded are exit 3 with their pace", async () =>
{
    const paces = { recharging: 20, call_in_progress: 2 };
    for (const code of ["recharging", "call_in_progress", "deploy_superseded"])
    {
        const result = await probe({ status: 409, body: { details: { code, message: code } } });
        assert.equal(result.code, 3, `${code}: ${result.all}`);
        const error = assertEnvelope(result.out, { code });
        assert.equal(error.retry_after_s, paces[code]);
        assert.match(error.idempotency_key, /^ck_[0-9a-f]{32}$/,
            "an exit 3 from a call-key-carrying command must echo the key, or the retry is a new charge");
    }
});

test("cell 66: a 429 is rate_limited with the pace the server declared", async () =>
{
    const result = await probe({ status: 429, body: {}, headers: { "retry-after": "7" } });
    assert.equal(result.code, 3, result.all);
    assertEnvelope(result.out, { code: "rate_limited", retry_after_s: 7 });
});

test("cell 67: 502/503/504 after three attempts is server_unavailable, exit 3", async () =>
{
    for (const status of [502, 503, 504])
    {
        const it = box();
        installFixture(it, { key: "probe", verbs: ["probe"], entry: railPlugin() });
        let attempts = 0;
        const rail = await railServer((call) =>
        {
            if (call.path === "/api/email/send")
            {
                attempts += 1;
            }
            return { status, body: { message: "later" } };
        });
        try
        {
            writeCredential(it, { apiBase: rail.url });
            const result = await selfAsync(it, it.demo, ["probe", "--json"], railEnv(rail));
            assert.equal(result.code, 3, `${status}: ${result.all}`);
            assertEnvelope(result.out, { code: "server_unavailable" });
            assert.equal(attempts, 3, `${status}: ${attempts} attempts rather than three`);
        }
        finally
        {
            await rail.close();
        }
    }
});

test("cell 68: an unreachable rail is network_unavailable, exit 3, with no retry storm", async () =>
{
    const it = box();
    installFixture(it, { key: "probe", verbs: ["probe"], entry: railPlugin() });
    // A port nothing is listening on: the connection is refused immediately,
    // three times, and then the client stops.
    writeCredential(it, { apiBase: "http://127.0.0.1:1" });
    const result = await selfAsync(it, it.demo, ["probe", "--json"], { SUPERSELF_DEV: "1", SUPERSELF_NO_JOURNAL: "1" });
    assert.equal(result.code, 3, result.all);
    assertEnvelope(result.out, { code: "network_unavailable" });
});

/* ── cells 69–70, 74–75: the rest of the mapping ───────────────────── */

test("cell 69: a 400 with no app code is bad_request, exit 1", async () =>
{
    const result = await probe({ status: 400, body: { error: { code: "ValidationError", message: "bad" }, message: "bad" } });
    assert.equal(result.code, 1, result.all);
    assertEnvelope(result.out, { code: "bad_request" });
});

test("cell 70: a 426 is client_too_old, exit 1, carrying min_version", async () =>
{
    const result = await probe({
        status: 426,
        body: { code: "client_too_old", message: "update the mini-app", hint: "self app update email", min_version: "0.2.0" }
    });
    assert.equal(result.code, 1, result.all);
    assertEnvelope(result.out, { code: "client_too_old", min_version: "0.2.0", hint: "self app update email" });
});

test("cell 74: a stack from a non-production server is dropped, never rendered", async () =>
{
    const result = await probe({
        status: 409,
        body: { details: { code: "slug_taken", message: "taken" }, stack: "at /srv/app/src/server/routes/landing.ts:100" }
    });
    assert.equal(result.code, 2);
    assert.equal(result.all.includes("/srv/app"), false, "a server filesystem path reached the agent");
    assertEnvelope(result.out, { code: "slug_taken" });
});

test("the exit-2 vocabulary is the four groups and nothing else, with no code in two of them", () =>
{
    // Grouped the way the rail's own vocabulary is grouped, so a code added
    // server-side has an obvious home — and so a code silently landing in two
    // groups, which would make the table ambiguous, fails here.
    const groups = [EXIT_2_WALLET, EXIT_2_ACCOUNT_AUTHORIZE, EXIT_2_ACCOUNT_GATE,
        EXIT_2_EMAIL, EXIT_2_LANDING, EXIT_2_OTHER];
    const flattened = groups.flat();
    assert.deepEqual([...flattened].sort(), [...EXIT_2_CODES].sort(),
        "the exit-2 table is not exactly its declared groups");
    assert.equal(new Set(flattened).size, flattened.length, "a code appears in two groups");
    flattened.forEach((code) => assert.equal(exitFor(code), 2, `${code} is not exit 2`));
    // And no code is both refused-by-policy and pending-retryable.
    Object.keys(EXIT_3_CODES).forEach((code) => assert.equal(EXIT_2_CODES.includes(code), false,
        `${code} is in both the exit-2 and exit-3 tables`));
});

test("cell 75: the CLI's table does not claim the codes that are never constructed", () =>
{
    for (const code of UNREACHABLE_CODES)
    {
        assert.equal(EXIT_2_CODES.includes(code), false, `${code} is declared and never constructed`);
        assert.equal(Object.prototype.hasOwnProperty.call(EXIT_3_CODES, code), false);
        assert.equal(exitFor(code), 1, `${code} must fall to the catch-all, not be branched on`);
    }
});

test("cell 73: a low-balance block on a 200 passes through untouched", async () =>
{
    const result = await probe({
        status: 200,
        body: { status: "sent", lowBalance: { remaining: 120, sendsRemaining: 4, hint: "top up soon" } }
    });
    assert.equal(result.code, 0, result.all);
    assert.deepEqual(jsonOf(result.out).low_balance, { remaining: 120, sends_remaining: 4, hint: "top up soon" });
});

/* ── cells 101–112, 145, 157: output mode ──────────────────────────── */

test("cell 101: --json puts one object on stdout and nothing else", async () =>
{
    const result = await probe({ status: 200, body: { ok: true } });
    assert.equal(result.code, 0, result.all);
    assert.equal(result.out.trim().split("\n").length, 1);
    assert.deepEqual(JSON.parse(result.out), { ok: true });
});

test("cell 102: under --json the error object is on stdout, not stderr", async () =>
{
    const result = await probe({ status: 409, body: { details: { code: "slug_taken", message: "taken" } } });
    assert.equal(result.code, 2);
    assert.deepEqual(Object.keys(JSON.parse(result.out.trim())), ["error"]);
    assert.equal(result.err.trim(), "", "an agent capturing stdout would have missed part of the answer");
});

test("cell 103: in human mode an error is `error: …` on stderr, as it always was", async () =>
{
    const result = await probe({ status: 409, body: { details: { code: "slug_taken", message: "that slug is taken" } } }, ["probe"]);
    assert.equal(result.code, 2);
    assert.match(result.err, /error: that slug is taken/);
    assert.equal(result.out.trim(), "");
});

test("cells 104–105: keys are converted and values are never rewritten", () =>
{
    assert.deepEqual(toSnake({ campaignId: "cmp", retryAfterS: 3, dkimTokens: ["aB-cD"], autoRecharge: { monthlyCap: 1 } }),
        { campaign_id: "cmp", retry_after_s: 3, dkim_tokens: ["aB-cD"], auto_recharge: { monthly_cap: 1 } });
    // A value that looks like a key is still a value.
    assert.deepEqual(toSnake({ note: "campaignId" }), { note: "campaignId" });
});

test("cell 106: an explicit --json on a leaf with no machine contract is refused by name", () =>
{
    const created = machine();
    const it = { ...created, ...demoWorkspace(created) };
    const result = selfIn(it, it.demo, ["work", "add", "x", "--json"]);
    assert.equal(result.code, 1);
    assert.match(result.out, /no --json contract yet/);
});

test("cell 157: SUPERSELF_JSON=1 is ignored by a leaf with no machine contract", () =>
{
    const created = machine();
    const it = { ...created, ...demoWorkspace(created) };
    for (const args of [["work", "add", "an ordinary unit"], ["alias"], ["state", "list"]])
    {
        const plain = selfIn(it, it.demo, args);
        const exported = selfIn(it, it.demo, args, { SUPERSELF_JSON: "1" });
        assert.equal(exported.code, plain.code, `${args.join(" ")} changed its exit code`);
        if (args[0] !== "work")
        {
            // A write verb records something new each time; the read verbs are
            // byte-comparable, which is the assertion that matters.
            assert.equal(exported.out, plain.out, `${args.join(" ")} changed its output`);
        }
    }
    // And the flag is still a named refusal on the same command, so 106 and 157
    // are asserting two different selectors rather than one.
    assert.equal(selfIn(it, it.demo, ["alias", "--json"]).code, 1);
});

test("cell 111: SUPERSELF_JSON=1 selects machine mode on a leaf that carries one", async () =>
{
    const it = box();
    writeCredential(it, {});
    const result = await selfAsync(it, it.demo, ["whoami"], { SUPERSELF_JSON: "1", SUPERSELF_DEV: "1" });
    assert.equal(result.code, 0, result.all);
    assert.equal(jsonOf(result.out).account, "acct_01J8TEST");
});

test("cells 108–109, 145: escapes are stripped in both modes, and only human mode truncates", async () =>
{
    // Control characters and ANSI escapes go, unconditionally and in both
    // modes: a terminal escape in a server string is an injection surface.
    assert.equal(sanitizeText("[31mred[0m text "), "red text");
    // Tab and newline survive, because a DNS record set is made of them.
    assert.equal(sanitizeText("a\tb\nc"), "a\tb\nc");

    // A DKIM value well over 2 KB reaches the agent byte-for-byte. A truncated
    // one published to DNS never fails loudly — verification simply never
    // succeeds, with nothing anywhere pointing at the CLI.
    const dkim = "v=DKIM1; k=rsa; p=".concat("A".repeat(3000));
    const result = await probe({ status: 200, body: { dnsRecords: [{ name: "x._domainkey", value: dkim }] } });
    assert.equal(result.code, 0, result.all);
    assert.equal(jsonOf(result.out).dns_records[0].value, dkim, "a --json value was truncated");
});

test("cell 112: NODE_TLS_REJECT_UNAUTHORIZED=0 refuses every rail command", async () =>
{
    const it = box();
    installFixture(it, { key: "probe", verbs: ["probe"], entry: railPlugin() });
    const rail = await railServer(() => ({ status: 200, body: { ok: true } }));
    try
    {
        writeCredential(it, { apiBase: rail.url });
        const result = await selfAsync(it, it.demo, ["probe", "--json"],
            { ...railEnv(rail), NODE_TLS_REJECT_UNAUTHORIZED: "0" });
        assert.equal(result.code, 1, result.all);
        assertEnvelope(result.out, { code: "tls_verification_disabled" });
        assert.equal(rail.calls.length, 0, "a credential was sent with certificate verification off");
    }
    finally
    {
        await rail.close();
    }
});

test("cell 107: a command needing confirmation refuses rather than prompting under --json", async () =>
{
    const destructive = `export default function register(host)
{
    return [{
        name: "wipe",
        usage: [{ syntax: "wipe [--yes] [--json]", description: ["fixture"], verbs: [""] }],
        detail: ["fixture", "", "  --yes                 confirm", "  --json                machine-readable output"],
        node: host.contract.leaf("", { yes: { type: "boolean" }, json: { type: "boolean" } }, 0, () =>
            [host.output.payload({ wiped: true }, () => ["wiped"])])
    }];
}
`;
    const it = box();
    installFixture(it, { key: "wipe", verbs: ["wipe"], entry: destructive });
    writeCredential(it, {});
    const refused = await selfAsync(it, it.demo, ["wipe", "--json"], { SUPERSELF_DEV: "1" });
    assert.equal(refused.code, 1, refused.all);
    assertEnvelope(refused.out, { code: "confirmation_required" });
    assert.doesNotMatch(refused.all, /\?\s*$/, "machine mode asked a question");

    const allowed = await selfAsync(it, it.demo, ["wipe", "--yes", "--json"], { SUPERSELF_DEV: "1" });
    assert.equal(allowed.code, 0, allowed.all);
    assert.deepEqual(jsonOf(allowed.out), { wiped: true });
});

/* ── cells 113–118: non-regression ─────────────────────────────────── */

test("cell 113: every pre-existing leaf still resolves and still exits only 0 or 1", () =>
{
    const created = machine();
    const it = { ...created, ...demoWorkspace(created) };
    const added = ["login", "logout", "whoami", "app"];
    const leaves = COMMANDS.filter((command) => !added.includes(command.name))
        .flatMap((command) => commandLeaves(command).map((entry) => [command.name, ...entry.verb.split(" ")].filter((word) => word !== "")));
    for (const argv of leaves)
    {
        const result = selfIn(it, it.demo, argv);
        assert.ok(result.code === 0 || result.code === 1,
            `self ${argv.join(" ")} exited ${result.code}, outside the 0/1 vocabulary it shipped with`);
    }
});

test("cell 114: checkContract over the composed command list is still empty", () =>
{
    assert.deepEqual(checkContract(COMMANDS), []);
});

test("cell 117: a machine with no credential and no plugins behaves as 0.6.x did", () =>
{
    const created = machine();
    const it = { ...created, ...demoWorkspace(created) };
    const workflow = [
        ["work", "add", "ship the thing"],
        ["work"],
        ["context"],
        ["status"],
        ["log"],
        ["search", "ship"]
    ];
    workflow.forEach((argv) => assert.equal(selfIn(it, it.demo, argv).code, 0, `self ${argv.join(" ")} broke`));
});

test("cell 118: 0.6.x ignores the plugin directory and the credential file", () =>
{
    // Nothing to undo: both live outside the store, so a downgrade reads a
    // workspace it fully understands and leaves the rest on disk untouched.
    const it = box();
    installFixture(it, { key: "probe", verbs: ["probe"], entry: railPlugin() });
    writeCredential(it, {});
    const store = readFileSync(new URL("../../../ARCHITECTURE.md", import.meta.url), "utf8");
    assert.match(store, /Credential \| `credentials\.ts`/);
});

/* ── §8.8: the six schema contract families ────────────────────────── */

// Each family validates its errors against the single envelope above, and its
// exit-3 shape, rather than restating a shape of its own.
const FAMILIES = ["login", "wallet", "email send", "email stats", "email domains", "landing deploy"];

test("§8.8: six families, each with an exit-3 shape, all against one envelope", async () =>
{
    assert.equal(FAMILIES.length, 6);
    // The two families whose routes reject an agent credential today (Q1) are
    // driven here against the contract rather than the server, which is the
    // whole point of the envelope being one shape: the client half is testable
    // before the server half lands.
    for (const code of ["recharging", "call_in_progress", "deploy_superseded"])
    {
        const result = await probe({ status: 409, body: { details: { code, message: code, retryAfterS: 9 } } });
        assert.equal(result.code, 3);
        assertEnvelope(result.out, { code, retry_after_s: 9 });
    }
    // And a success in every family is the payload verbatim, with no `error`.
    const success = await probe({ status: 200, body: { status: "sent", campaignId: "cmp_1" } });
    assert.equal(success.code, 0);
    assert.equal(jsonOf(success.out).error, undefined);
});

test("§8.8: the envelope has exactly the declared fields, and optional means omitted", async () =>
{
    const full = await probe({
        status: 409,
        body: {
            error: { requestId: "req_1" },
            details: {
                code: "validation_refused", message: "m", hint: "h",
                ruleHits: [1], refusals: [2], reviewId: "rv_1", minVersion: "0.2.0"
            }
        }
    });
    const error = assertEnvelope(full.out, { code: "validation_refused" });
    assert.deepEqual(Object.keys(error).sort(),
        ["code", "hint", "message", "min_version", "refusals", "request_id", "review_id", "rule_hits"]);

    const bare = await probe({ status: 400, body: { code: "invalid_request", message: "m" } });
    assert.deepEqual(Object.keys(assertEnvelope(bare.out)).sort(), ["code", "message"],
        "an optional field with no value was sent rather than omitted");
});

/* ── the constants the design fixes (§10) ──────────────────────────── */

test("the derived per-command deadline is the outer bound, not a competitor to the request timeout", () =>
{
    assert.equal(commandDeadlineMs(30_000), 60_000);
    assert.equal(commandDeadlineMs(120_000), 135_000);
});

test("the six default agent scopes are the whole August vocabulary", () =>
{
    assert.deepEqual([...DEFAULT_AGENT_SCOPES].sort(),
        ["email.domain.manage", "email.read", "email.send", "landing.deploy", "landing.read", "wallet.read"]);
});

test("normalizeError never lets a server field through unnamed", () =>
{
    const { code, message, fields } = normalizeError({
        error: { code: "ConflictError", message: "wrapped", requestId: "req_9" },
        details: { code: "recharging", message: "topping up", hint: "wait", retryAfterS: 20 },
        stack: "at /srv/secret/path.ts:1"
    });
    assert.equal(code, "recharging");
    assert.equal(message, "topping up");
    assert.deepEqual(fields, { hint: "wait", retry_after_s: 20, request_id: "req_9" });
});

test("a response past the 8 MB cap is refused while it arrives, not after it is in memory", async () =>
{
    const it = box();
    installFixture(it, { key: "probe", verbs: ["probe"], entry: railPlugin() });
    // Nine megabytes, streamed. Buffering it and measuring afterwards is the
    // version of this check a hostile server defeats simply by answering.
    const rail = await railServer(() => ({ status: 200, body: `[${"0,".repeat(4_600_000)}0]` }));
    try
    {
        writeCredential(it, { apiBase: rail.url });
        const result = await selfAsync(it, it.demo, ["probe", "--json"], railEnv(rail));
        assert.equal(result.code, 1, result.all.slice(0, 200));
        assertEnvelope(result.out, { code: "response_too_large" });
    }
    finally
    {
        await rail.close();
    }
});

test("§4.2: a command that passes its deadline is exit 3, echoing the call key so the retry is the same call", async () =>
{
    const slow = `export default function register(host)
{
    return [{
        name: "probe",
        usage: [{ syntax: "probe [--json] [--timeout s]", description: ["fixture"], verbs: [""] }],
        detail: ["fixture", "", "  --json                machine-readable output", "  --timeout <s>         replace the derived deadline"],
        node: host.contract.leaf("", { json: { type: "boolean" }, timeout: { type: "string" } }, 0, async () =>
        {
            const answer = await host.rail.request({
                method: "POST", path: "/api/email/send", body: { campaignName: "c" },
                scopes: ["email.send"], callKey: "derive"
            });
            return [host.output.payload(answer.body, () => ["ok"])];
        })
    }];
}
`;
    const it = box();
    installFixture(it, { key: "probe", verbs: ["probe"], entry: slow });
    // A rail that accepts the request and never answers it. Without a deadline
    // the command would sit for the full request timeout; with one it gives the
    // agent back its own control flow.
    const rail = await railServer(() => new Promise(() => undefined));
    try
    {
        writeCredential(it, { apiBase: rail.url });
        const result = await selfAsync(it, it.demo, ["probe", "--json", "--timeout", "1"], railEnv(rail));
        assert.equal(result.code, 3, result.all);
        const error = assertEnvelope(result.out, { code: "command_deadline_exceeded", retry_after_s: 5 });
        assert.match(error.idempotency_key, /^ck_[0-9a-f]{32}$/,
            "a deadline hit is an unknown outcome, so the retry has to be the same call");
    }
    finally
    {
        await rail.close();
    }
});
