// Reads a plain `self log` rendering on stdin and answers the questions the
// scope suite asks of it. It exists because parsing that rendering by
// whitespace field index is wrong in two ways a proof must not paper over.
//
// A project slug may contain spaces — `self project add --name` accepts them —
// so `awk $2` picks up a slug token and `$4` picks up the timestamp on a
// three-token slug. The key count still matched the line count and the order
// check still reported valid, while the id half was no longer being read at
// all: it passed for the wrong reason (#165 review round 12).
//
// And a summary may contain a newline. `self report --file` reads arbitrary
// text and `sanitize.ts` allows LF, CR and tab, so `eventSummary` can return
// text that wraps the rendered line. A parse that treated every line as an
// event miscounted; one that silently skipped the continuation hid the wrap.
//
// So the line is split on its real separator — two spaces — and every field is
// validated by shape. An event line is one whose second field is a timestamp of
// the form the CLI writes and whose fourth is a bracketed id. A line that
// carries either token but not in those positions is a shifted line, and is
// reported by shape rather than absorbed into a count that agrees with itself.
// Anything else is a continuation of the event above it.
//
// Usage: <rendering> | node proof/log-keys.mjs keys|ids|count|tail [N]

import { readFileSync } from "node:fs";

const SEPARATOR = "  ";
// What `new Date().toISOString()` writes, which is what makeEvent stamps.
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BRACKETED_ID = /^\[[0-9a-zA-Z]+\]$/;

const [mode, count] = process.argv.slice(2);
const lines = readFileSync(0, "utf8").split("\n");

// A line that carries a timestamp or a bracketed id somewhere, but not where an
// event line carries them, is the shifted case. Continuation text from a report
// carries neither, so the two are told apart by what they contain rather than
// by where they happen to sit.
function looksLikeEvent(fields)
{
    return fields.some((field) => TIMESTAMP.test(field) || BRACKETED_ID.test(field));
}

const events = [];
let index = 0;
for (const line of lines)
{
    index += 1;
    if (line === "")
    {
        continue;
    }
    const fields = line.split(SEPARATOR);
    // Field 0 is the project on a workspace rendering and the timestamp on a
    // single-project one, so both shapes are read here: the timestamp and the
    // id are found by shape, at the offset that has them both.
    const offset = TIMESTAMP.test(fields[0] ?? "") ? 0 : 1;
    const stamp = fields[offset];
    const id = fields[offset + 2];
    if (TIMESTAMP.test(stamp ?? "") && BRACKETED_ID.test(id ?? ""))
    {
        events.push({ ts: stamp, id: id.slice(1, -1), start: index, lines: [line] });
        continue;
    }
    if (looksLikeEvent(fields))
    {
        console.error(`line ${index} carries a timestamp or an id but not where an event line does: ` +
            `wanted "<slug>  <YYYY-MM-DDThh:mm:ss.sssZ>  <type>  [<id>]  <summary>", saw "${line}"`);
        process.exit(1);
    }
    if (events.length === 0)
    {
        console.error(`line ${index} is neither an event line nor a continuation of one: "${line}"`);
        process.exit(1);
    }
    events[events.length - 1].lines.push(line);
}

if (mode === "keys")
{
    console.log(events.map((event) => `${event.ts}\t${event.id}`).join("\n"));
}
else if (mode === "ids")
{
    console.log(events.map((event) => event.id).join("\n"));
}
else if (mode === "count")
{
    console.log(String(events.length));
}
else if (mode === "tail")
{
    // The last N events, with every line each of them occupies. `tail -n N`
    // cannot answer this: an event whose summary wrapped owns more than one
    // line, so a line window and an event window are different questions.
    console.log(events.slice(-Number(count)).flatMap((event) => event.lines).join("\n"));
}
else
{
    console.error(`usage: <rendering> | node log-keys.mjs keys|ids|count|tail [N]`);
    process.exit(2);
}
