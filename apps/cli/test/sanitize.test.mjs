import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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

// A cookie header keeps the reading both header rules used to share: its value
// is a session credential and nothing else, so it is refused at whatever
// entropy the value happens to have. Asserted here so the auth-header table
// below cannot quietly take it along.
test("a cookie header is refused whatever follows the colon", () =>
{
    for (const text of ["cookie: session-id", "cookie: rotated quarterly", "set-cookie: sid=abc; Path=/"])
    {
        refuses(text, "cookie-header");
    }
});

// The case table for an `Authorization` header (#319). A document about an API
// shows the header's format, and the format is a scheme name and a stand-in
// for the credential — `Authorization: Bearer <token>`. Blanking the value on
// sight refused every such document, which is the whole of #319; judging it
// has to leave a real credential exactly where it was.
//
// The table is the cross product of three things, because every reading that
// was ever wrong here was wrong by holding one of them fixed:
//
//   scheme    Bearer · Basic · Token · a custom one
//   value     the thirteen shapes below
//   position  the value ends the line · prose follows it
//
// The rule column has two entries per refused row and both mean the same
// refusal. `Bearer`, `Basic` and `Token` are the scheme names the `auth-scheme`
// rule already knows, so under those the credential is caught there, one rule
// before the header rule is reached; any other scheme reaches `auth-header`.
//
//   value shape                      example                 Bearer/Basic/Token  custom
//   angle-bracket placeholder        <token>                 records             records
//   $VAR and ${VAR}                  $TOKEN                  records             records
//   bare substitution name           YOUR_ACCESS_TOKEN_HERE  records             records
//   elided                           eyJexample...           records             records
//   short word                       placeholder             records             records
//   16+ unbroken run, letters only   20 letters              auth-scheme         auth-header
//   16+ unbroken run, digits only    16 digits               auth-scheme         auth-header
//   base64 with '/' and '+'          40 chars                auth-scheme         auth-header
//   base64url with '-' and '_'       22 chars                auth-header         auth-header
//   JWT, three segments              published example       auth-scheme         auth-header
//   quoted placeholder               "Bearer <token>"        records             records
//   quoted 16+ run                   "Bearer <20 letters>"   auth-scheme         auth-header
//   generated value in brackets      <22 chars base64url>    auth-header         auth-header
//
// Two rows carry the design. base64url puts '-' and '_' wherever the bytes
// fall, and the reading every prose rule uses splits runs on both, so a
// sixteen-character token in that alphabet has no run left to measure: judging
// the header by that reading alone recorded it four times in ten. And if
// brackets alone excused a value, wrapping a real token in them would be the
// way to write it into a record — so what excuses a bracketed value is the
// name inside reading as a name, one case throughout, which base64url is not.
//
// Every value below is a published example or a dummy of the right length and
// alphabet. None is a credential to anything.
const AUTH_SCHEMES = ["Bearer", "Basic", "Token", "SharedKey"];

const RECORDS = () => null;
const BY_SCHEME = (scheme) => (scheme === "SharedKey" ? "auth-header" : "auth-scheme");
const BY_HEADER = () => "auth-header";

const AUTH_TABLE = [
    { shape: "angle-bracket placeholder", values: ["<token>", "<your-api-token-here>"], rule: RECORDS },
    { shape: "$VAR and ${VAR}", values: ["$TOKEN", "${API_TOKEN}"], rule: RECORDS },
    { shape: "bare substitution name", values: ["YOUR_ACCESS_TOKEN_HERE", "your-token-goes-here"], rule: RECORDS },
    { shape: "elided", values: ["eyJexample...", "eyJ…"], rule: RECORDS },
    { shape: "short word", values: ["placeholder"], rule: RECORDS },
    { shape: "16+ unbroken run, letters only", values: ["abcdefghijklmnopqrst"], rule: BY_SCHEME },
    { shape: "16+ unbroken run, digits only", values: ["1234567890123456"], rule: BY_SCHEME },
    { shape: "base64 with / and +", values: ["wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"], rule: BY_SCHEME },
    { shape: "base64url with - and _", values: ["Zx-9Kq_mR4tVn2Bs7Lw1Yd"], rule: BY_HEADER },
    { shape: "JWT three segments", values: ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"], rule: BY_SCHEME },
    { shape: "quoted placeholder", values: ["<token>"], quoted: true, rule: RECORDS },
    { shape: "quoted 16+ run", values: ["abcdefghijklmnopqrst"], quoted: true, rule: BY_SCHEME },
    { shape: "generated value inside brackets", values: ["<Zx-9Kq_mR4tVn2Bs7Lw1Yd>", "${Zx-9Kq_mR4tVn2Bs7Lw1Yd}"], rule: BY_HEADER }
];

// The third axis. Prose after the value must not change any cell's outcome:
// what the header rule reads is the credential token, and a filename with
// hyphens in it further along the line is not one.
const POSITIONS = [
    { position: "value ends the line", prose: "" },
    { position: "prose follows", prose: " — replace this with the key your tenant was issued" }
];

function headerLine(scheme, value, quoted, prose)
{
    return `Authorization: ${quoted ? `"${scheme} ${value}"` : `${scheme} ${value}`}${prose}`;
}

test("the auth-header case table, one assertion per cell", async (t) =>
{
    for (const { shape, values, quoted, rule } of AUTH_TABLE)
    {
        for (const scheme of AUTH_SCHEMES)
        {
            for (const { position, prose } of POSITIONS)
            {
                await t.test(`${shape} · ${scheme} · ${position}`, () =>
                {
                    for (const value of values)
                    {
                        const text = headerLine(scheme, value, quoted === true, prose);
                        const expected = rule(scheme);
                        if (expected === null)
                        {
                            assertSanitized(event({ text }));
                        }
                        else
                        {
                            refuses(text, expected);
                        }
                    }
                });
            }
        }
    }
});

// A Basic credential is base64 of `user:password`, and a short pair encodes
// shorter than the run bar, so the value is decoded rather than measured. The
// dummy below decodes to a four-letter name and a four-letter password.
test("a basic credential below the run bar is refused, and a basic placeholder is not", () =>
{
    refuses("Authorization: Basic dXNlcjpwYXNz", "auth-scheme");
    for (const text of ["Authorization: Basic <base64>", "Authorization: Basic base64(user:password)"])
    {
        assertSanitized(event({ text }));
    }
});

// `bearer`, `basic` and `token` are English words as often as they are scheme
// names, so a bare scheme keeps the prose reading. Nothing writes
// `Authorization:` in a sentence, which is what licenses the harder reading
// above and confines it to the header.
test("a bare scheme word in a sentence keeps the prose reading", () =>
{
    for (const text of ["the bearer token-refresh-window is 30 days", "refresh token (30d, revocable)"])
    {
        assertSanitized(event({ text }));
    }
});

// The three lines #319 was filed over, verbatim from the issue and its repro.
test("the documentation lines the issue was filed over record", () =>
{
    assertSanitized(event({ text: [
        "## Authentication",
        "",
        "    GET /v1/things",
        "    Authorization: Bearer <token>",
        "    Authorization: Bearer eyJexample...",
        "    Authorization: Basic <base64>",
        "",
        "Set `Authorization: Bearer $ACCESS_TOKEN` from the environment."
    ].join("\n") }));
});

// The table above asserts the shapes a person writes. This asserts the ones
// nobody writes: values straight out of a generator, in the alphabets a real
// key uses, at the lengths a real key has. The table can only cover the
// examples someone thought of, and the reading that shipped in the first cut
// of this change passed every one of them while recording four base64url
// tokens in ten — sampling is what caught it.
const ALPHABETS = {
    "letters only": "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
    lowercase: "abcdefghijklmnopqrstuvwxyz",
    "digits only": "0123456789",
    base64: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
    base64url: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
    hex: "0123456789abcdef"
};

const SAMPLES = 2000;

function generated(alphabet, length)
{
    let value = "";
    for (const byte of randomBytes(length))
    {
        value += alphabet[byte % alphabet.length];
    }
    return value;
}

function recorded(text)
{
    try
    {
        assertSanitized(event({ text }));
        return true;
    }
    catch
    {
        return false;
    }
}

test("no generated value reaches the log through an auth header, at any alphabet", async (t) =>
{
    for (const [name, alphabet] of Object.entries(ALPHABETS))
    {
        for (const length of [16, 24, 40])
        {
            await t.test(`${name}, ${length} chars`, () =>
            {
                for (let sampled = 0; sampled < SAMPLES; sampled += 1)
                {
                    const value = generated(alphabet, length);
                    for (const text of [
                        `Authorization: Bearer ${value}`,
                        `Authorization: SharedKey ${value}`,
                        `Authorization: Bearer <${value}>`
                    ])
                    {
                        assert.equal(recorded(text), false, text);
                    }
                }
            });
        }
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
