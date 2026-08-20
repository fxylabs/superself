import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { assertSanitized } from "../dist/sanitize.js";
import { CliError } from "../dist/types.js";

function event(payload)
{
    return { id: "01kz0000000000000000000000", type: "work.reported", at: "2026-08-03T00:00:00Z", project: "p", payload, refs: {}, origin: {} };
}

test("a clean payload passes the gate", () =>
{
    assertSanitized(event({ text: "typecheck green, smoke passed", list: ["a", "b"] }));
});

test("a forbidden key is refused however it is spelled", () =>
{
    for (const key of ["env", "envVars", "PIDs", "working_directory", "stdout"])
    {
        assert.throws(() => assertSanitized(event({ [key]: "x" })), CliError, key);
    }
});

test("a home path in a value is refused", () =>
{
    assert.throws(
        () => assertSanitized(event({ text: `built at ${homedir()}/work/checkout` })),
        (error) => error instanceof CliError && error.message.includes("home directory")
    );
});

test("a credential-shaped value is refused", () =>
{
    assert.throws(
        () => assertSanitized(event({ text: 'set api_key="abc123secretvalue" before running' })),
        (error) => error instanceof CliError && error.message.includes("credential")
    );
});

// A design document describing a credential lifecycle names the credential on
// every other line, and naming one is not carrying one (#317).
test("a design document that labels credential fields in prose is recordable", () =>
{
    assertSanitized(event({ text: [
        "## Credential lifecycle",
        "",
        "Credential — agent-scoped token: account_id, scopes[], expires_at",
        "- refresh token (30d, revocable)",
        "- api_key: rotated quarterly",
        "- idempotency_key: caller-supplied"
    ].join("\n") }));
});

function refuses(text, rule)
{
    assert.throws(
        () => assertSanitized(event({ text })),
        (error) => error instanceof CliError && error.message.includes(`rule ${rule}`),
        text
    );
}

// The case table for a secret name followed by a colon or an `=`. It is one
// table because the shapes only make sense against each other: what a value
// means depends on which separator introduced it and on how much of the line
// it takes, and every row that was ever wrong here was wrong by being read
// under the neighbouring row's rule.
//
//   value after `name:`          what follows it   rule                outcome
//   base64 40 chars with '/'     nothing           secret-line         refused
//   letters only, 20 and 30      nothing           secret-line         refused
//   digits only, 18              nothing           secret-line         refused
//   `s3cr3t`                     nothing           secret-line         refused
//   indented under a mapping     nothing           secret-line         refused
//   a short note in words        nothing           —                   records
//   a short note in words        words             —                   records
//   an identifier                a comma list      —                   records
//   a word                       a note in ()      —                   records
//   letters only, 20             a note in ()      secret-label        refused
//   base64 40 chars with '/'     a note in ()      secret-label        refused
//   mixed run, 23                more prose        secret-label        refused
//   `= value` and `= "value"`    anything          secret-assignment   refused
//   `: "value"`                  anything          secret-assignment   refused
//   `"api_key": "abc"`           anything          secret-json-field   refused
//   `authorization: <anything>`  anything          auth-header         refused
//
// The last four rows are the shapes this change did not touch, asserted here
// so a later narrowing of the colon rules cannot quietly take them with it.
//
// Every value below is a published example or a dummy. The generated ones are
// written in the alphabets a real key uses — base64 with the '/' and '+' a
// token split drops, letters only, digits only — because those are the three
// this gate read as prose before (review round 1 on #318).

// The shape a manifest, a compose file and a CI variable write a secret in:
// the value is the whole rest of the line, and nothing follows it.
test("a whole-line value that is not a short note is refused whatever its alphabet", () =>
{
    for (const text of [
        // AWS's own published example secret access key: base64, and the two
        // slashes in it are where a token split used to break the run apart.
        "aws_secret_access_key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        // Letters only, at two lengths. Neither carries a digit, so the
        // mixed-alphabet reading never counted them.
        "password: correcthorsebatterystaple",
        "api_key: abcdefghijklmnopqrstuvwxyzabcd",
        "api_key: qwertyuiopasdfghjklz",
        // Digits only, for the same reason in the other direction.
        "device_code: 123456789012345678",
        // Short, but a digit inside a word is not how prose is written.
        "client_secret: s3cr3t",
        // Indented, the way a manifest actually writes it.
        "spec:\n  api_key: 7Hs9KpQwErTyUiOpAsDf\n"
    ])
    {
        refuses(text, "secret-line");
    }
});

test("a whole-line value that reads as a short note is recordable", () =>
{
    for (const text of [
        "idempotency_key: caller-supplied",
        "access_token: opaque",
        "refresh_token: revocable",
        "api_key: rotated.",
        "  api_key: caller-supplied\n  ttl: 30d\n"
    ])
    {
        assertSanitized(event({ text }));
    }
});

// The same colon with something after the value: the line is a sentence, so
// the value is judged rather than the shape.
test("a value with prose after it is recordable, and refused where it carries key material", () =>
{
    for (const text of [
        "token: account_id, scopes[], expires_at",
        "- api_key: rotated quarterly",
        "api_key: (rotated quarterly)",
        "the token: value pair is written by the operator",
        "refresh token (30d, revocable)"
    ])
    {
        assertSanitized(event({ text }));
    }
    for (const text of [
        "rotate the token: 3fK92mQ7bZ1xLp8vR4nT6wY once a month",
        "api_key: qwertyuiopasdfghjklz (staging)",
        "aws_secret_access_key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY (rotate me)"
    ])
    {
        refuses(text, "secret-label");
    }
});

test("an explicit encoding is still refused however ordinary its value reads", () =>
{
    for (const text of ["API_KEY=hunter2correct", 'token: "hunter2correct"', "password = hunter2correct", 'api_key="abcd"'])
    {
        refuses(text, "secret-assignment");
    }
});

test("a quoted JSON field is refused however ordinary its value reads", () =>
{
    refuses('{"api_key": "abc"}', "secret-json-field");
});

// The header rules read the whole value and are not shape-split, so the change
// above must leave them exactly where they were.
test("an authorization header is refused whatever follows the colon", () =>
{
    for (const text of ["authorization: rotated quarterly", "cookie: session-id", "authorization: caller-supplied"])
    {
        refuses(text, "auth-header");
    }
});

test("a terminal control character is refused by code point", () =>
{
    assert.throws(
        () => assertSanitized(event({ text: "clear\u001b[2Jscreen" })),
        (error) => error instanceof CliError && error.message.includes("U+001B")
    );
});

test("tab, newline and carriage return stay recordable", () =>
{
    assertSanitized(event({ text: "line one\n\tline two\r\n" }));
});
