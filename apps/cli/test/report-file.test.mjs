// What the two commands that record a person's own text accept from it, and
// what they still refuse (#317, #319). A design document about an auth system
// names credentials on every other line and shows the format of an
// `Authorization` header, and neither is carrying one; the refusals are
// asserted beside it, because the gate still has to hold for a file that
// really does carry a key, in each of the shapes a key is written in. The full
// case tables for those shapes are in sanitize.test.mjs; what is here is the
// end-to-end contract that the commands obey them — the surface row of both
// tables, once through `report --file` and once through `state add`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { demoWorkspace, machine, must, selfIn, workIdIn } from "./harness.mjs";

const box = machine();
const { ws, demo } = demoWorkspace(box);
const log = join(ws, ".superself", "projects", "demo", "log.jsonl");

const DESIGN = [
    "# S1 rail design v0.1",
    "",
    "Credential — agent-scoped token: account_id, scopes[], expires_at",
    "- refresh token (30d, revocable)",
    "- api_key: rotated quarterly",
    "- idempotency_key: caller-supplied"
].join("\n");

let seq = 0;

function fileHolding(text)
{
    seq += 1;
    const path = join(box.root, `brief-${seq}.md`);
    writeFileSync(path, `${text}\n`);
    return path;
}

function freshUnit()
{
    seq += 1;
    return workIdIn(must(box, demo, ["work", "add", `outcome ${seq}`]).out);
}

function reportsOf(id)
{
    return readFileSync(log, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line))
        .filter((event) => event.type === "report.added" && event.refs.work === id);
}

test("a design document describing a credential lifecycle attaches in full", () =>
{
    const id = freshUnit();
    const result = selfIn(box, demo, ["report", id, "--file", fileHolding(DESIGN)]);
    assert.equal(result.code, 0, result.out);
    assert.deepEqual(reportsOf(id).map((event) => event.payload.text), [DESIGN]);
});

test("a file carrying a credential is refused, and records nothing", () =>
{
    const id = freshUnit();
    const path = fileHolding(`# rollout\n\nrun it with api_key="abc123secretvalue" set`);
    const result = selfIn(box, demo, ["report", id, "--file", path]);
    assert.equal(result.code, 1);
    assert.match(result.out, /shaped like a credential \(rule secret-assignment/);
    assert.equal(reportsOf(id).length, 0);
});

// The refusal above is a quoted `=` assignment, which is the one shape #317
// never touched — it cannot tell whether the shape #317 did touch still holds.
// This is that shape: a bare colon, an unquoted value, and nothing after it on
// the line, which is how a manifest and a CI variable write a real key. The
// value is a dummy of the length and alphabet a generator produces.
test("a file holding an unquoted key on its own line is refused, and records nothing", () =>
{
    const id = freshUnit();
    const path = fileHolding("# staging\n\napi_key: 7Hs9KpQwErTyUiOpAsDfGhJk");
    const result = selfIn(box, demo, ["report", id, "--file", path]);
    assert.equal(result.code, 1);
    assert.match(result.out, /shaped like a credential \(rule secret-line/);
    assert.equal(reportsOf(id).length, 0);
});

// An API document shows what an `Authorization` header looks like, in every
// spelling a document uses for the part the reader substitutes (#319). Before
// this, one such line refused the whole attachment and the session fell back
// to recording a path, which loses the text for every later session.
const API_DESIGN = [
    "# Things API v0.1",
    "",
    "    GET /v1/things",
    "    Authorization: Bearer <token>",
    "    Authorization: Basic <base64>",
    "    Authorization: SharedKey YOUR_ACCESS_TOKEN_HERE",
    "",
    "The token is elided in the transcript above: `Authorization: Bearer eyJexample...`.",
    "In CI the value comes from `$ACCESS_TOKEN` and never appears in the document."
].join("\n");

test("a design document showing example auth headers attaches in full", () =>
{
    const id = freshUnit();
    const result = selfIn(box, demo, ["report", id, "--file", fileHolding(API_DESIGN)]);
    assert.equal(result.code, 0, result.out);
    assert.deepEqual(reportsOf(id).map((event) => event.payload.text), [API_DESIGN]);
});

// The two shapes a real credential arrives in behind the same header. The
// first is caught by the scheme rule, one rule ahead of the header rule; the
// second is in base64url, whose separators hide it from every reading but the
// header rule's own. Both values are dummies of a generator's length and
// alphabet.
test("a file whose auth header carries a real credential is refused, and records nothing", () =>
{
    for (const [header, rule] of [
        ["Authorization: Bearer 7Hs9KpQwErTyUiOpAsDfGhJk", "auth-scheme"],
        ["Authorization: SharedKey Zx-9Kq_mR4tVn2Bs7Lw1Yd", "auth-header"]
    ])
    {
        const id = freshUnit();
        const path = fileHolding(`# staging\n\n    GET /v1/things\n    ${header}`);
        const result = selfIn(box, demo, ["report", id, "--file", path]);
        assert.equal(result.code, 1, header);
        assert.match(result.out, new RegExp(`shaped like a credential \\(rule ${rule}`));
        assert.equal(reportsOf(id).length, 0);
    }
});

// The same two cells with the header taken away (#347). A transcript quotes a
// credential line without the header in front of it, and a design document
// writes the scheme word into a sentence, so both have to keep working: the
// generated value is refused, and the sentence and the substitution marks are
// not. The base64url value is the shape #347 was filed over — its separators
// hid it from every reading the bare rule had.
const BARE_DESIGN = [
    "# Things API v0.2",
    "",
    "Send the credential as `bearer <token>`, or `basic <base64>` for the",
    "legacy tenants. In CI the value comes from `$ACCESS_TOKEN`.",
    "",
    "The bearer token-refresh-window is 30 days, and each token lives for",
    "thirty days and is revocable."
].join("\n");

test("a design document that writes bare scheme words attaches in full", () =>
{
    const id = freshUnit();
    const result = selfIn(box, demo, ["report", id, "--file", fileHolding(BARE_DESIGN)]);
    assert.equal(result.code, 0, result.out);
    assert.deepEqual(reportsOf(id).map((event) => event.payload.text), [BARE_DESIGN]);
});

test("a file whose bare scheme line carries a real credential is refused, and records nothing", () =>
{
    for (const line of ["bearer Zx-9Kq_mR4tVn2Bs7Lw1Yd", "token <Zx-9Kq_mR4tVn2Bs7Lw1Yd>"])
    {
        const id = freshUnit();
        const path = fileHolding(`# staging\n\n    curl -H '${line}' /v1/things`);
        const result = selfIn(box, demo, ["report", id, "--file", path]);
        assert.equal(result.code, 1, line);
        assert.match(result.out, /shaped like a credential \(rule auth-scheme/);
        assert.equal(reportsOf(id).length, 0);
    }
});

// The other surface the gate guards. `state add` writes the text a person
// typed straight into an event payload, with no file in the way, so the same
// two cells are asserted through it.
function entitiesListed()
{
    return must(box, demo, ["state", "list"]).out;
}

test("state add records an entity that quotes an example auth header", () =>
{
    const text = "API brief: examples show Authorization: Bearer <token> and nothing else";
    assert.equal(selfIn(box, demo, ["state", "add", text]).code, 0);
    assert.ok(entitiesListed().includes("API brief"));
});

test("state add refuses an entity whose auth header carries a credential, and records nothing", () =>
{
    const text = "rollout note: Authorization: SharedKey Zx-9Kq_mR4tVn2Bs7Lw1Yd";
    const result = selfIn(box, demo, ["state", "add", text]);
    assert.equal(result.code, 1);
    assert.match(result.out, /shaped like a credential \(rule auth-header/);
    assert.ok(!entitiesListed().includes("rollout note"));
});

test("state add records an entity that writes a bare scheme word in a sentence", () =>
{
    const text = "auth brief: the bearer token-refresh-window is 30 days and bearer <token> is the format";
    assert.equal(selfIn(box, demo, ["state", "add", text]).code, 0);
    assert.ok(entitiesListed().includes("auth brief"));
});

test("state add refuses an entity whose bare scheme line carries a credential, and records nothing", () =>
{
    const text = "cutover note: bearer Zx-9Kq_mR4tVn2Bs7Lw1Yd";
    const result = selfIn(box, demo, ["state", "add", text]);
    assert.equal(result.code, 1);
    assert.match(result.out, /shaped like a credential \(rule auth-scheme/);
    assert.ok(!entitiesListed().includes("cutover note"));
});
