// Provider output reaches the spool in whatever pieces the pipe happened to
// deliver. A credential broken across two of them matches nothing on either
// side of the break, so redaction that scans each piece on its own writes both
// halves out verbatim.
//
// This drives every possible split of each sample through the raw writer and
// asserts two things at once: the credential never appears, and the file is
// byte-for-byte what one single write would have produced — a hold-back that
// loses or duplicates output would be no better than the leak.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact } from "../dist/attempt/redact.js";
import { Spool } from "../dist/attempt/spool.js";

const LITERAL = "DECLAREDLITERALSECRETVALUE";

const SAMPLES = [
    { name: "bearer header", scope: { literals: [] }, secret: "sk-live-AAAABBBBCCCCDDDDEEEEFFFF00001111", text: "Authorization: Bearer sk-live-AAAABBBBCCCCDDDDEEEEFFFF00001111\n" },
    { name: "shell assignment", scope: { literals: [] }, secret: "SHELLFORMSECRETVALUE", text: "env: api_key=SHELLFORMSECRETVALUE\n" },
    { name: "pretty JSON", scope: { literals: [] }, secret: "JSONPRETTYSECRETVALUE1", text: `${JSON.stringify({ ANTHROPIC_API_KEY: "JSONPRETTYSECRETVALUE1" }, null, 2)}\n` },
    { name: "compact JSON", scope: { literals: [] }, secret: "JSONCOMPACTSECRETVALUE3", text: `${JSON.stringify({ password: "JSONCOMPACTSECRETVALUE3" })}\n` },
    { name: "declared literal across lines", scope: { literals: [LITERAL] }, secret: LITERAL, text: `before\n${LITERAL}\nafter\n` },
    { name: "credential on a later line", scope: { literals: [] }, secret: "PROMPTINJECTEDSECRETVALUE", text: "first line of prose\nsecond line\napi_key=PROMPTINJECTEDSECRETVALUE\ntrailing prose\n" }
];

let failures = 0;

function report(message)
{
    console.error(message);
    failures++;
}

for (const sample of SAMPLES)
{
    const whole = redact(sample.text, sample.scope);
    if (whole.includes(sample.secret))
    {
        report(`${sample.name}: redaction misses this credential even in one piece`);
        continue;
    }
    for (let at = 0; at <= sample.text.length; at++)
    {
        const dir = mkdtempSync(join(tmpdir(), "self-spool-chunk-"));
        try
        {
            const spool = new Spool(dir, sample.scope);
            spool.appendRaw("raw.log", sample.text.slice(0, at));
            spool.appendRaw("raw.log", sample.text.slice(at));
            spool.flushRaw("raw.log");
            const written = readFileSync(join(dir, "raw.log"), "utf8");
            if (written.includes(sample.secret))
            {
                report(`${sample.name}: a credential split at offset ${at} survived redaction`);
            }
            else if (written !== whole)
            {
                report(`${sample.name}: a split at offset ${at} did not produce what one write produces`);
            }
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true });
        }
    }
}

// The tail is held until the stream closes, so a run that never flushed would
// silently lose its last line. It must be written, and written once.
const dir = mkdtempSync(join(tmpdir(), "self-spool-flush-"));
const spool = new Spool(dir, { literals: [] });
spool.appendRaw("raw.log", "no newline at the end of this");
spool.flushRaw("raw.log");
spool.flushRaw("raw.log");
if (readFileSync(join(dir, "raw.log"), "utf8") !== "no newline at the end of this")
{
    report("closing the stream did not write the held tail exactly once");
}
rmSync(dir, { recursive: true, force: true });

process.exit(failures === 0 ? 0 : 1);
