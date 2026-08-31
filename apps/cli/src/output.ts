// The one place a command's answer reaches stdout. A handler works out what it
// has to say and returns it as blocks; the dispatcher hands them here and this
// prints them. Before the gate, every surface called `console.log` itself, so
// "what does a piped run print" had as many answers as there were call sites,
// and a rule about output — a total line, a recovery pointer, a render mode —
// had nowhere to live but in each of them.
//
// The gate is staged. Stage 1 was this module, the dispatcher's call to it and
// one migrated verb; stage 2 moved every write verb whose answer is a receipt;
// stage 3 moved the standalone listings, and with them the one rule the move
// was for — a listing states its size, in the same words on every surface.
// Stage 4 moved the pages, and with them the last thing a handler still
// decided for itself: a block that reads two ways carries both renders as
// thunks and this module calls exactly one, so no command surface resolves the
// render mode any more.
// The shapes a command answers with are declared in `types.ts`, which imports
// nothing, so a leaf can name what its handler returns without the CLI surface
// having to reach up into this layer for the declaration.
//
// Two rules hold the module in place:
//
//   - It prints through `console.log` and nothing else. The suite intercepts
//     that function to read what a command said, so writing to the descriptor
//     would make every existing assertion blind.
//   - It never imports upward. `pipeline.ts` and `fold.ts` call `notice` here;
//     this module importing either of them would let a render write state.

import { ParsedArguments } from "./args.js";
import { RenderMode, resolveRender } from "./pretty.js";
import { bold, errRed, plural } from "./style.js";
import { CommandOutput, ErrorFields, JsonValue, ListingBlock, OutputBlock, PayloadBlock, Pointer } from "./types.js";

/* ── machine mode ──────────────────────────────────────────────────── */

// Whether this run answers a machine. Resolved once, by the dispatcher, from
// the flag the leaf declared and the environment — never asked again, so two
// blocks of one command can no more disagree about JSON than they can about
// `--pretty`.
//
// It lives here because the consequence is entirely about printing, and one of
// those consequences is easy to miss: under `--json` an **error** goes to
// stdout, not stderr, so an agent capturing stdout gets parseable JSON on every
// path rather than on the successful ones only.
let machineMode = false;

export function selectJsonMode(on: boolean): void
{
    machineMode = on;
}

export function jsonMode(): boolean
{
    return machineMode;
}

/* ── the gate ──────────────────────────────────────────────────────── */

// The render mode is resolved once for the whole answer, from the flags the
// run was parsed with, so two blocks of one command can never disagree about
// whether this run is for a person or for a pipe. It is resolved through
// `pretty.ts`, which is the one place that answers the question — asking it
// here is another caller of that gate, not a second answer.
//
// The resolution happens after the handler ran, which is where `--pretty
// --plain` together is refused. A write verb that offers those flags therefore
// resolves the render itself, before it records, exactly as it does today: a
// refusal owed for the arguments must not arrive after the state change.
export function renderOutput(output: CommandOutput, values: ParsedArguments["values"] = {}): void
{
    const mode = resolveRender({ pretty: values.pretty === true, plain: values.plain === true });
    for (const block of output)
    {
        printBlock(block, mode);
    }
}

function printBlock(block: OutputBlock, mode: RenderMode): void
{
    if (block.kind === "payload")
    {
        printPayload(block, mode);
        return;
    }
    if (block.kind === "value")
    {
        console.log(block.text);
        return;
    }
    if (block.kind === "receipt")
    {
        console.log(block.text);
        printPointer(block.next, mode);
        return;
    }
    if (block.kind === "listing")
    {
        printListing(block, mode);
        return;
    }
    printLines(mode === "pretty" && block.pretty !== undefined ? block.pretty() : block.plain());
}

// Under `--json` the data is the whole answer: one object, nothing around it,
// and no value shortened — the 2 KB cap is a human-readability measure and a
// truncated DKIM record published to DNS fails silently forever. Otherwise the
// block behaves like every other two-render block.
function printPayload(block: PayloadBlock, mode: RenderMode): void
{
    if (machineMode)
    {
        console.log(JSON.stringify(block.data));
        return;
    }
    printLines(mode === "pretty" && block.pretty !== undefined ? block.pretty() : block.plain());
}

// The one command that emits JSON Lines rather than one object: `self login`
// has to hand the agent a code before approval happens and a result after.
// Printed through the gate like everything else, so this module stays the only
// module that writes to stdout.
export function jsonLine(data: JsonValue): void
{
    console.log(JSON.stringify(data));
}

// A refusal, in whichever form this run reads. In JSON mode it is the one
// envelope of design §2.6 on **stdout**; otherwise it is today's `error:` line
// on stderr, with the hint under it.
export function renderFailure(code: string | undefined, message: string, fields: ErrorFields): void
{
    if (machineMode)
    {
        console.log(JSON.stringify({ error: { code: code ?? "error", message, ...fields } }));
        return;
    }
    console.error(`${errRed("error:")} ${message}`);
    if (fields.hint !== undefined)
    {
        console.error(`    ${fields.hint}`);
    }
}

// Exactly one of a block's two renders runs. A handler no longer asks which
// run it is in — it hands over both ways of saying the same thing and this
// picks, from the one mode the whole answer was resolved with. Calling both
// would compose a render nobody reads, and the terminal one measures the
// terminal: on a piped run there is nothing there to measure.
function printListing(block: ListingBlock, mode: RenderMode): void
{
    if (mode === "pretty" && block.pretty !== undefined)
    {
        printLines(block.pretty());
        return;
    }
    printLines(block.rows);
    printSize(block, mode);
}

function printLines(lines: string[]): void
{
    lines.forEach((line) => console.log(line));
}

// How much there is, under the rows that are some of it. A person at a terminal
// reads a ruled render that frames its own rows; a pipe gets no frame, so this
// is the one line that tells a reader who is not looking at a screen whether
// they have the whole answer — which is why it is written here and not by any
// of the listings, and why it is on the plain render alone.
//
// A listing with nothing in it says nothing: the empty wording each surface
// already prints ("no open work", "no matches") states the size in the words
// that also say what to do about it, and a `0 matches` under it would be the
// same fact twice.
function printSize(block: ListingBlock, mode: RenderMode): void
{
    if (mode !== "plain" || block.total === 0)
    {
        return;
    }
    const size = plural(block.total, block.noun, block.nouns);
    const window = block.window;
    console.log(window === undefined || window.shown >= block.total
        ? size
        : `last ${window.shown} of ${size} · ${window.recover}`);
}

// A command to type, under the line that made it worth typing, indented the
// way the archived-project listing already indents its one way back. Weight is
// the terminal's signal for "this is runnable" (see `pretty.ts`), and a pipe
// gets the same characters without it.
function printPointer(next: Pointer | undefined, mode: RenderMode): void
{
    if (next === undefined)
    {
        return;
    }
    console.log(`    ${mode === "pretty" ? bold(next) : next}`);
}

/* ── notices ───────────────────────────────────────────────────────── */

// What a lower layer has to say while a command is still running: the line an
// append prints once the event is durable, the link a fold pruned on its way
// past. These are not a command's answer — they belong to no block, they can
// arrive before the answer is known, and the layer that emits them cannot
// return anything to the dispatcher.
//
// It prints, and decides nothing. Whether a notice is due at all is the
// caller's judgment — `pipeline.ts` is the one place that answers whether an
// append announces itself — because only the caller knows what the run is for.
export function notice(line: string): void
{
    console.log(line);
}

// A notice about the machine rather than about the command: that its workspace
// could not be reached, that records it made are not going anywhere, that this
// CLI is too old to talk to the server it is pointed at.
//
// On stderr, and that is the whole difference. These arrive before a command
// has even parsed its flags — the catch-up runs in front of every verb — so the
// run may yet turn out to be a `--json` one, and a line of prose on stdout
// ahead of the envelope would be an agent's parse error instead of a person's
// notice. They are also not any command's answer: nothing returns them, no
// block holds them, and the command they precede would have said exactly the
// same thing without them.
export function machineNotice(line: string): void
{
    console.error(line);
}
