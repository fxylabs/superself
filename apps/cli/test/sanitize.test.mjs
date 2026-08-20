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

test("an explicit encoding is still refused however ordinary its value reads", () =>
{
    for (const text of ["API_KEY=hunter2correct", 'token: "hunter2correct"', "password = hunter2correct"])
    {
        assert.throws(
            () => assertSanitized(event({ text })),
            (error) => error instanceof CliError && error.message.includes("credential"),
            text
        );
    }
});

test("a prose label carrying key material is refused", () =>
{
    assert.throws(
        () => assertSanitized(event({ text: "rotate the token: 3fK92mQ7bZ1xLp8vR4nT6wY once a month" })),
        (error) => error instanceof CliError && error.message.includes("credential")
    );
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
