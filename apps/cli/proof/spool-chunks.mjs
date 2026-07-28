// Provider output reaches the spool in whatever pieces the pipe happened to
// deliver. A credential broken across two of them matches nothing on either
// side of the break, so redaction that scans each piece on its own writes both
// halves out verbatim.
//
// This drives every possible split of each sample through the raw writer, and
// then drives each sample again as a stream of fixed-size chunks, and asserts
// the same two things every time: no part of the credential appears, and the
// file is byte-for-byte what one single write would have produced — a hold-back
// that loses or duplicates output would be no better than the leak.
//
// A declared literal gets both sweeps because it is the case a line break does
// not settle. Every pattern rule is confined to one line, so cutting at a line
// break is safe for all of them; a private key carries line breaks of its own,
// and a cut on one of those splits the literal into two halves that match
// nothing at all.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact } from "../dist/attempt/redact.js";
import { Spool } from "../dist/attempt/spool.js";

const LITERAL = "DECLAREDLITERALSECRETVALUE";

// The ordinary shape of a multi-line secret: a declared secret is whatever the
// named environment variable holds, and a deploy key or a service-account key
// held in one is several lines.
const PEM = [
    "-----BEGIN PRIVATE KEY-----",
    "LINEONEBODYMATERIALAAAA1111",
    "LINETWOBODYMATERIALBBBB2222",
    "-----END PRIVATE KEY-----"
].join("\n");

const OTHER_PEM = [
    "-----BEGIN EC PRIVATE KEY-----",
    "SECONDKEYBODYMATERIALCCCC3333",
    "-----END EC PRIVATE KEY-----"
].join("\n");

// A provider does not stop writing when it has echoed a key; it goes on
// producing ordinary output, which is what walks the cut back into the key.
const TRAILING = Array.from({ length: 12 }, (_, index) => `log line ${index} of ordinary provider output`).join("\n");

// The sizes the reviewer's reproduction leaked at, plus one above the sample
// length so a single write is covered by the same sweep.
const CHUNK_SIZES = [1, 16, 64, 256, 1024];

const SAMPLES = [
    { name: "bearer header", scope: { literals: [] }, secrets: ["sk-live-AAAABBBBCCCCDDDDEEEEFFFF00001111"], text: "Authorization: Bearer sk-live-AAAABBBBCCCCDDDDEEEEFFFF00001111\n" },
    { name: "shell assignment", scope: { literals: [] }, secrets: ["SHELLFORMSECRETVALUE"], text: "env: api_key=SHELLFORMSECRETVALUE\n" },
    { name: "pretty JSON", scope: { literals: [] }, secrets: ["JSONPRETTYSECRETVALUE1"], text: `${JSON.stringify({ ANTHROPIC_API_KEY: "JSONPRETTYSECRETVALUE1" }, null, 2)}\n` },
    { name: "compact JSON", scope: { literals: [] }, secrets: ["JSONCOMPACTSECRETVALUE3"], text: `${JSON.stringify({ password: "JSONCOMPACTSECRETVALUE3" })}\n` },
    { name: "declared literal across lines", scope: { literals: [LITERAL] }, secrets: [LITERAL], text: `before\n${LITERAL}\nafter\n` },
    { name: "credential on a later line", scope: { literals: [] }, secrets: ["PROMPTINJECTEDSECRETVALUE"], text: "first line of prose\nsecond line\napi_key=PROMPTINJECTEDSECRETVALUE\ntrailing prose\n" },
    // Every line of the key is named separately: the whole literal surviving is
    // the loud failure, and one body line surviving is the same leak.
    { name: "multi-line declared literal", scope: { literals: [PEM] }, secrets: [PEM, ...PEM.split("\n")], text: `preamble line\n${PEM}\ntrailing line\n` },
    { name: "multi-line declared literal, provider keeps writing", scope: { literals: [PEM] }, secrets: [PEM, ...PEM.split("\n")], text: `starting up\n${PEM}\n${TRAILING}\n` },
    { name: "multi-line declared literal at the head of the stream", scope: { literals: [PEM] }, secrets: [PEM, ...PEM.split("\n")], text: `${PEM}\n${TRAILING}\n` },
    { name: "multi-line declared literal with no trailing newline", scope: { literals: [PEM] }, secrets: [PEM, ...PEM.split("\n")], text: `head\n${PEM}` },
    { name: "two multi-line declared literals", scope: { literals: [PEM, OTHER_PEM] }, secrets: [PEM, OTHER_PEM, ...PEM.split("\n"), ...OTHER_PEM.split("\n")], text: `head\n${PEM}\n${OTHER_PEM}\nfoot\n` },
    { name: "the same multi-line literal twice", scope: { literals: [PEM] }, secrets: [PEM, ...PEM.split("\n")], text: `head\n${PEM}\nmiddle\n${PEM}\nfoot\n` }
];

let failures = 0;

function report(message)
{
    console.error(message);
    failures++;
}

// One writer per delivery, into a file of its own, so a sweep of thousands of
// deliveries does not pay for a temporary directory each time.
function writeThrough(dir, name, sample, chunks)
{
    const spool = new Spool(dir, sample.scope);
    for (const chunk of chunks)
    {
        spool.appendRaw(name, chunk);
    }
    spool.flushRaw(name);
    return readFileSync(join(dir, name), "utf8");
}

function check(written, whole, sample, delivery)
{
    const leaked = sample.secrets.find((secret) => written.includes(secret));
    if (leaked !== undefined)
    {
        report(`${sample.name}: ${delivery} left ${leaked.length} bytes of the credential in the log`);
        return;
    }
    if (written !== whole)
    {
        report(`${sample.name}: ${delivery} did not produce what one write produces`);
    }
}

function sliced(text, size)
{
    const chunks = [];
    for (let at = 0; at < text.length; at += size)
    {
        chunks.push(text.slice(at, at + size));
    }
    return chunks;
}

const root = mkdtempSync(join(tmpdir(), "self-spool-chunk-"));
try
{
    for (const [index, sample] of SAMPLES.entries())
    {
        const whole = redact(sample.text, sample.scope);
        const uncovered = sample.secrets.find((secret) => whole.includes(secret));
        if (uncovered !== undefined)
        {
            report(`${sample.name}: redaction misses this credential even in one piece`);
            continue;
        }
        let file = 0;
        for (let at = 0; at <= sample.text.length; at++)
        {
            check(writeThrough(root, `${index}-split-${file++}.log`, sample, [sample.text.slice(0, at), sample.text.slice(at)]), whole, sample, `a split at offset ${at}`);
        }
        // A stream does not arrive in two pieces, it arrives in as many as the
        // pipe felt like. Fixed-size delivery walks the cut across the buffer
        // over and over, which is what puts it inside a literal that has fully
        // arrived while its tail is still being written.
        for (const size of CHUNK_SIZES)
        {
            check(writeThrough(root, `${index}-stream-${file++}.log`, sample, sliced(sample.text, size)), whole, sample, `delivery in ${size}-byte chunks`);
        }
    }

    // The tail is held until the stream closes, so a run that never flushed
    // would silently lose its last line. It must be written, and written once.
    const spool = new Spool(root, { literals: [] });
    spool.appendRaw("flush.log", "no newline at the end of this");
    spool.flushRaw("flush.log");
    spool.flushRaw("flush.log");
    if (readFileSync(join(root, "flush.log"), "utf8") !== "no newline at the end of this")
    {
        report("closing the stream did not write the held tail exactly once");
    }
}
finally
{
    rmSync(root, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
