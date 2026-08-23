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
//   base64url with '-' and '_'       22 chars                auth-scheme         auth-header
//   JWT, three segments              published example       auth-scheme         auth-header
//   quoted placeholder               "Bearer <token>"        records             records
//   quoted 16+ run                   "Bearer <20 letters>"   auth-scheme         auth-header
//   generated value in brackets      <22 chars base64url>    auth-scheme         auth-header
//
// Two rows moved from `auth-header` to `auth-scheme` in #347 and nothing else
// changed: the scheme rule now reads its own value the way this one does, so
// under a scheme name it knows it reaches the base64url and bracketed shapes
// one rule earlier. Same refusal, earlier rule.
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

const AUTH_TABLE = [
    { shape: "angle-bracket placeholder", values: ["<token>", "<your-api-token-here>"], rule: RECORDS },
    { shape: "$VAR and ${VAR}", values: ["$TOKEN", "${API_TOKEN}"], rule: RECORDS },
    { shape: "bare substitution name", values: ["YOUR_ACCESS_TOKEN_HERE", "your-token-goes-here"], rule: RECORDS },
    { shape: "elided", values: ["eyJexample...", "eyJ…"], rule: RECORDS },
    { shape: "short word", values: ["placeholder"], rule: RECORDS },
    { shape: "16+ unbroken run, letters only", values: ["abcdefghijklmnopqrst"], rule: BY_SCHEME },
    { shape: "16+ unbroken run, digits only", values: ["1234567890123456"], rule: BY_SCHEME },
    { shape: "base64 with / and +", values: ["wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"], rule: BY_SCHEME },
    { shape: "base64url with - and _", values: ["Zx-9Kq_mR4tVn2Bs7Lw1Yd"], rule: BY_SCHEME },
    { shape: "JWT three segments", values: ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"], rule: BY_SCHEME },
    { shape: "quoted placeholder", values: ["<token>"], quoted: true, rule: RECORDS },
    { shape: "quoted 16+ run", values: ["abcdefghijklmnopqrst"], quoted: true, rule: BY_SCHEME },
    { shape: "generated value inside brackets", values: ["<Zx-9Kq_mR4tVn2Bs7Lw1Yd>", "${Zx-9Kq_mR4tVn2Bs7Lw1Yd}"], rule: BY_SCHEME }
];

// The third axis. Prose after the value must not change any cell's outcome:
// what the header rule reads is the credential token, and a filename with
// hyphens in it further along the line is not one.
const POSITIONS = [
    { position: "value ends the line", prose: "" },
    { position: "prose follows", prose: " — replace this with the key your tenant was issued" }
];

// One line builder for both tables. A quoted cell quotes the scheme and its
// value together, because that is how a transcript quotes the pair; the header
// prefix is the only thing the two tables differ by.
function authLine(prefix, scheme, value, quoted, prose)
{
    return `${prefix}${quoted ? `"${scheme} ${value}"` : `${scheme} ${value}`}${prose}`;
}

async function runTable(t, table, schemes, prefix)
{
    for (const { shape, values, quoted, rule } of table)
    {
        for (const scheme of schemes)
        {
            for (const { position, prose } of POSITIONS)
            {
                await t.test(`${shape} · ${scheme} · ${position}`, () =>
                {
                    for (const value of values)
                    {
                        const text = authLine(prefix, scheme, value, quoted === true, prose);
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
}

test("the auth-header case table, one assertion per cell", async (t) =>
{
    await runTable(t, AUTH_TABLE, AUTH_SCHEMES, "Authorization: ");
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

// The case table for a bare scheme word — `bearer <value>` with no
// `Authorization:` in front of it (#347). The same credential is written both
// ways, so it is judged both ways: the value's token measured whole over the
// base64url alphabet, a `basic` value decoded rather than measured. Reading it
// as prose instead recorded a sixteen-character base64url token four times in
// ten, which is the whole of #347.
//
// What licenses the harder reading without a header name in front of it is the
// span, and that is the axis this table exists to hold down. `bearer`, `basic`
// and `token` are English words as often as scheme names, so the rule's match
// is the scheme word and the one token after it and never a character more:
// prose past that token is outside the match, which is why the position column
// changes no cell here any more than it does above.
//
//   scheme    bearer · basic · token — and digest · SharedKey, which the rule
//             does not know, as the negative control
//   value     the thirteen shapes of the header table, plus the two Basic
//             shapes asserted beside it
//   position  the value ends the line · prose follows it
//
//   value shape                      example                 bearer/basic/token  digest/SharedKey
//   angle-bracket placeholder        <token>                 records             records
//   $VAR                             $TOKEN                  records             records
//   ${VAR}                           ${API_TOKEN}            records             records
//   bare substitution name           YOUR_ACCESS_TOKEN_HERE  records             records
//   elided                           eyJexample...           records             records
//   short word                       placeholder             records             records
//   16+ unbroken run, letters only   20 letters              auth-scheme         records
//   16+ unbroken run, digits only    16 digits               auth-scheme         records
//   base64 with '/' and '+'          40 chars                auth-scheme         records
//   base64url with '-' and '_'       22 chars                auth-scheme         records
//   JWT, three segments              published example       auth-scheme         jwt
//   quoted placeholder               "bearer <token>"        records             records
//   quoted 16+ run                   "bearer <20 letters>"   auth-scheme         records
//   generated value in brackets      <22 chars base64url>    auth-scheme         records
//   Basic valid base64 pair          dXNlcjpwYXNz            basic only          records
//   Basic short or not base64        <base64>                records             records
//
// Only two cells differ from `main`: base64url, and a generated value inside
// brackets. Every other cell is what `main` already did, asserted so this
// change cannot take one with it.
//
// The right-hand column is the negative control and the scope line at once. A
// bare line whose scheme word this rule does not know is prose, and records at
// every shape but a JWT, which its own rule catches. Widening the scheme list
// is a different question from this one.
const BARE_SCHEMES = ["bearer", "basic", "token", "digest", "SharedKey"];
const KNOWN_SCHEMES = ["bearer", "basic", "token"];

const BY_BARE_SCHEME = (scheme) => (KNOWN_SCHEMES.includes(scheme) ? "auth-scheme" : null);
const BY_BASIC = (scheme) => (scheme === "basic" ? "auth-scheme" : null);
const BY_JWT = (scheme) => (KNOWN_SCHEMES.includes(scheme) ? "auth-scheme" : "jwt");

const BARE_TABLE = [
    { shape: "angle-bracket placeholder", values: ["<token>", "<your-api-token-here>"], rule: RECORDS },
    { shape: "$VAR", values: ["$TOKEN"], rule: RECORDS },
    { shape: "${VAR}", values: ["${API_TOKEN}"], rule: RECORDS },
    { shape: "bare substitution name", values: ["YOUR_ACCESS_TOKEN_HERE", "your-token-goes-here"], rule: RECORDS },
    { shape: "elided", values: ["eyJexample...", "eyJ…"], rule: RECORDS },
    { shape: "short word", values: ["placeholder"], rule: RECORDS },
    { shape: "16+ unbroken run, letters only", values: ["abcdefghijklmnopqrst"], rule: BY_BARE_SCHEME },
    { shape: "16+ unbroken run, digits only", values: ["1234567890123456"], rule: BY_BARE_SCHEME },
    { shape: "base64 with / and +", values: ["wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"], rule: BY_BARE_SCHEME },
    { shape: "base64url with - and _", values: ["Zx-9Kq_mR4tVn2Bs7Lw1Yd"], rule: BY_BARE_SCHEME },
    { shape: "JWT three segments", values: ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"], rule: BY_JWT },
    { shape: "quoted placeholder", values: ["<token>"], quoted: true, rule: RECORDS },
    { shape: "quoted 16+ run", values: ["abcdefghijklmnopqrst"], quoted: true, rule: BY_BARE_SCHEME },
    { shape: "generated value inside brackets", values: ["<Zx-9Kq_mR4tVn2Bs7Lw1Yd>", "${Zx-9Kq_mR4tVn2Bs7Lw1Yd}"], rule: BY_BARE_SCHEME },
    { shape: "Basic valid base64 pair", values: ["dXNlcjpwYXNz"], rule: BY_BASIC },
    { shape: "Basic short or not base64", values: ["<base64>", "base64(user:password)"], rule: RECORDS }
];

test("the bare auth-scheme case table, one assertion per cell", async (t) =>
{
    await runTable(t, BARE_TABLE, BARE_SCHEMES, "");
});

// The sentences the table's reading has to leave alone. Each puts a scheme word
// in front of ordinary English, and the word after it is what gets judged.
test("a bare scheme word in a sentence still records", () =>
{
    for (const text of [
        "the bearer token-refresh-window is 30 days",
        "refresh token (30d, revocable)",
        "we use basic authentication on the internal endpoints",
        "the token introspection-endpoint returns the scopes",
        "rotate the token_refresh_window every quarter",
        "each token lives for thirty days and is revocable",
        "token bucket refills at ten per second",
        "reduced token counting overhead",
        "bearer placeholder."
    ])
    {
        assertSanitized(event({ text }));
    }
});

// The cost of the reading, asserted rather than left to be discovered. An
// unbroken sixteen-character run in the credential alphabet, written as the one
// token after a scheme word, is refused whether it is a key or a note: a slash
// and a leading date are both outside what a name reads as. A rephrase away,
// and the refusal names the rule and shows the span.
test("a long hyphenated note written as the token after a scheme word is refused", () =>
{
    for (const text of ["basic auth/token-exchange-flow", "token 2026-08-23-review-note"])
    {
        refuses(text, "auth-scheme");
    }
});

// A trailing period belongs to the sentence, not to the value, and it does not
// buy a credential a way past the run bar.
test("sentence punctuation after a bare credential does not excuse it", () =>
{
    refuses("bearer abcdefghijklmnopqrst.", "auth-scheme");
    refuses("the value is token Zx-9Kq_mR4tVn2Bs7Lw1Yd, rotated weekly", "auth-scheme");
});

// The shape the sampling caught that no hand-written cell had, and the reason
// #346's probe went red once on a pull request that changed nothing here.
//
// A generated base64url value draws '-' and '_' as often as any other
// character, so one in twenty thousand comes out single-case with a separator
// in it and read as a substitution name — the reading that lets
// `your-token-goes-here` record. Both values below did that. What separates
// them from a name is inside the pieces: `0yjr9xyknif2p4` and `SSZEQU9` mix
// letters and digits in one word, and a name's piece is a word or a number and
// never both. Fixed cells, in both forms, because the probe that found them
// draws from a seeded stream now and will not find them again.
const NAME_SHAPED_KEYS = ["o-0yjr9xyknif2p4", "L-0883_SSZEQU9_2"];

test("a generated value that reads like a name is refused, in both auth forms", () =>
{
    for (const value of NAME_SHAPED_KEYS)
    {
        refuses(`bearer ${value}`, "auth-scheme");
        refuses(`Authorization: SharedKey ${value}`, "auth-header");
    }
});

// The floor under that fix, asserted rather than left as a claim so nobody
// reads the probe's 0% as more than it is. A generated value whose every piece
// is a plain word is the same text as `your-token-goes-here`, and no reading
// that records the one can refuse the other — this records, and a document
// spelling its placeholder that way is why. What shrinks it is the draw, not
// the reading: every character has to miss the other case and both digits, so
// it happened five times in two million at sixteen characters and zero times at
// twenty-four or forty.
test("a generated value that spells a single-case phrase is the declared residual", () =>
{
    for (const text of ["bearer h-ohmqqnsm_y-khu", "bearer rbkvv-vwvnxiudtx", "bearer your-token-goes-here"])
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

// The draw is seeded, and that is the difference between a probe and a
// lottery. A sampled test that draws from the system generator fails on some
// runs of code that never changed: #346's probe did exactly that on an
// unrelated pull request, and a rerun passed, which teaches nobody anything and
// trains everyone to rerun. The seed makes every cell the same 2000 values on
// every machine, so a red build is a defect somebody can reproduce by checking
// out the branch — and the value that made it red is a shape to add to the
// table above, not a draw to reroll.
//
// mulberry32, written out because a test that pins its own corpus cannot depend
// on the corpus moving. Each cell gets its own stream, so adding a length or an
// alphabet does not shift the values every other cell sees.
function mulberry32(seed)
{
    let state = seed >>> 0;
    return () =>
    {
        state = (state + 0x6d2b79f5) >>> 0;
        let mixed = Math.imul(state ^ (state >>> 15), state | 1);
        mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
}

function generated(alphabet, length, next)
{
    let value = "";
    for (let at = 0; at < length; at += 1)
    {
        value += alphabet[Math.floor(next() * alphabet.length)];
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

async function probe(t, seed, forms)
{
    let stream = 0;
    for (const [name, alphabet] of Object.entries(ALPHABETS))
    {
        for (const length of [16, 24, 40])
        {
            stream += 1;
            const cell = seed + stream;
            await t.test(`${name}, ${length} chars`, () =>
            {
                const next = mulberry32(cell);
                for (let sampled = 0; sampled < SAMPLES; sampled += 1)
                {
                    const value = generated(alphabet, length, next);
                    for (const text of forms(value))
                    {
                        assert.equal(recorded(text), false, text);
                    }
                }
            });
        }
    }
}

test("no generated value reaches the log through an auth header, at any alphabet", async (t) =>
{
    await probe(t, 0x51190319, (value) => [
        `Authorization: Bearer ${value}`,
        `Authorization: SharedKey ${value}`,
        `Authorization: Bearer <${value}>`
    ]);
});

// The same sampling with the header taken away, which is what #347 was: the
// bare form recorded 39.9% of sixteen-character base64url values, 13.2% at
// twenty-four and 0.8% at forty, and the bracketed form recorded every
// generated value at every alphabet because nothing matched it at all.
test("no generated value reaches the log through a bare scheme word, at any alphabet", async (t) =>
{
    await probe(t, 0x51190347, (value) => [
        `bearer ${value}`,
        `basic ${value}`,
        `token ${value}`,
        `bearer <${value}>`
    ]);
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
