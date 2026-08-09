// The one place a command's answer reaches stdout. A handler works out what it
// has to say and returns it as blocks; the dispatcher hands them here and this
// prints them. Before the gate, every surface called `console.log` itself, so
// "what does a piped run print" had as many answers as there were call sites,
// and a rule about output — a total line, a recovery pointer, a render mode —
// had nowhere to live but in each of them.
//
// The gate is staged. Stage 1 was this module, the dispatcher's call to it and
// one migrated verb; stage 2 moved every write verb whose answer is a receipt.
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
import { bold } from "./style.js";
import { CommandOutput, OutputBlock, Pointer } from "./types.js";

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
        block.rows.forEach((row) => console.log(row));
        return;
    }
    block.lines.forEach((line) => console.log(line));
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
