// The one path every verb takes to destroy a record. Retiring a record is a
// person's call: this gate puts the target in front of whoever is asking and
// then reads a typed confirmation from a terminal, so a process with no
// person at it cannot destroy anything (#173).
//
// The disclosure is rendered once and ends two ways — a refusal inside a
// process with no terminal, a challenge prompt at one — so what an agent
// reads and what a person reads cannot drift apart.
//
// One person's judgment covers one reviewed set, not one record (#312). A
// batch collects the gated calls a whole plan makes, discloses them together,
// and reads one typed confirmation — the same disclosure and the same prompt,
// over more than one call.
import { CommandLeaf } from "./contract.js";
import { EntityState } from "./entities.js";
import { attemptMarker, confirmHuman, HumanConfirmation } from "./human.js";
import { ProjectModel } from "./model.js";
import { CliContext } from "./paths.js";
import { holdAppends, recordCalls, recordEvents } from "./pipeline.js";
import { bold, dim, plural, red } from "./style.js";
import { CliError, SelfEvent } from "./types.js";

// What the three transitions are called where a person reads them. The verb
// each one arrives from varies; what is being lost does not.
type RetirementKind = "supersede" | "retract" | "retire";

// The record a supersession writes in the place of the ones it retires: what
// kind of record it is, and the words it will hold.
interface Successor
{
    kind: string;
    text: string;
}

// What a call carries beyond the records it destroys. Both fields are what the
// disclosure is for, so both are stated by name rather than by position.
interface RetirementDetail
{
    why?: string;
    successor?: Successor;
}

interface RetirementIntent extends RetirementDetail
{
    kind: RetirementKind;
    // The records this call destroys, already resolved and already checked
    // for being destroyable: resolution and its refusals stay with the verb
    // that owns them, so the gate never invents a second way to name a record.
    targets: EntityState[];
    // `why` is the reason this call gives, where its transition carries one. It
    // is half of what a person is judging — the record says what is being lost
    // and this says why the caller thinks it should be — and a reviewed set is
    // unreadable without it.
    //
    // A supersession gives no reason because its successor's text *is* the
    // reason, which is why `--why` is excused there — so a supersession has to
    // disclose that text. Without it a reviewed set asks a person to approve
    // words they were never shown: the old records render, the agent-authored
    // ones replacing them do not, and one answer writes both (#312 review 1).
}

// What a verb hands the gate: the ids it already resolved, read back out of
// the folded model it already built. A target the model does not carry is
// dropped rather than guessed at — the verb's own refusals ran first. Only a
// record that is still standing is a target: a supersedes link naming
// something already superseded destroys nothing, and the trigger is what this
// call displaces now, never which flag was typed.
export function retirementIntent(model: ProjectModel, kind: RetirementKind, ids: string[],
    detail: RetirementDetail = {}): RetirementIntent
{
    const targets: EntityState[] = [];
    for (const id of ids)
    {
        const target = model.entities.find((entity) => entity.id === id);
        if (target !== undefined && target.status === "confirmed")
        {
            targets.push(target);
        }
    }
    return { ...detail, kind, targets };
}

// The successor read off the payload the verb already composed, the way
// `supersedeTargets` reads the links off it: every add and revise verb spells
// its new record the same way once it reaches here, so the disclosure does not
// need one line per verb to learn what is replacing what.
export function supersedingRecord(payload: Record<string, unknown>): Successor | undefined
{
    if (typeof payload.text !== "string")
    {
        return undefined;
    }
    const labels = payload.labels;
    const kind = Array.isArray(labels) && typeof labels[0] === "string" ? labels[0] : "record";
    return { kind, text: payload.text };
}

// The records an add verb's payload displaces. Read off the payload rather
// than off the flags, because every kind spells the correction differently
// (`--supersedes`, `--link supersedes:<id>`, a type's own older spelling) and
// they all arrive here as the same link.
export function supersedeTargets(payload: Record<string, unknown>): string[]
{
    const links = payload.links;
    if (!Array.isArray(links))
    {
        return [];
    }
    return links
        .filter((link) => (link as { type?: string })?.type === "supersedes")
        .map((link) => String((link as { target?: unknown }).target));
}

const SUBJECT: Record<RetirementKind, string> = {
    supersede: "retires",
    retract: "takes back",
    retire: "gives up the outcome of"
};

// What a person types back where the ids are too many to type. `supersede`
// answers "retire" because that is what displacing a record does to it.
const ACTION: Record<RetirementKind, string> = {
    supersede: "retire",
    retract: "retract",
    retire: "retire"
};

// The same three transitions in the past tense, for the line that states the
// reason a call gives. A table rather than `${ACTION[kind]}ed`, because that
// spelled "retireed" on every `work retire`, `objective close --as dropped`,
// `milestone drop` and `state retire` — the one line a person reads to judge
// whether the reason justifies the loss.
const PAST: Record<RetirementKind, string> = {
    supersede: "retired",
    retract: "retracted",
    retire: "retired"
};

// How many references and how much text a person will actually read. A
// disclosure that scrolls past the top of the terminal is not a disclosure.
const REFERENCE_LIMIT = 8;
const TEXT_LINE_LIMIT = 20;

// How much a person is asked to type back. Naming the exact ids is the
// strongest statement of "these ones and no others", and it stays the
// challenge while it is short enough to read and type; past that a person
// copies without reading, which confirms nothing. A reviewed set beyond the
// bound says what is being done and to how many, and the disclosure above it
// says which.
const CHALLENGE_LIMIT = 60;

// What one call — or one line of a reviewed set — puts in front of a person:
// the records it destroys, and the folded model the verb resolved them
// against, so every target is described by the fold its own verb read.
interface Disclosed
{
    intent: RetirementIntent;
    model: ProjectModel;
}

function targetsOf(disclosed: Disclosed[]): EntityState[]
{
    return disclosed.flatMap((one) => one.intent.targets);
}

// The gate. Returns the record of how the person was verified, which the
// caller puts in the event payload — `origin.confirmed` alone is a bit any
// process can set, so the payload carries what was actually typed.
function requireHumanRetirement(disclosed: Disclosed[]): HumanConfirmation
{
    const asked = challenge(disclosed);
    if (attemptMarker() !== undefined || !process.stdin.isTTY || !process.stdout.isTTY)
    {
        throw new CliError(refusal(disclosed, renderDisclosure(disclosed, PLAIN_EMPHASIS)));
    }
    const confirmed = confirmHuman(
        `${red(bold(headline(disclosed)))}\n\n${renderDisclosure(disclosed, PROMPT_EMPHASIS)}`,
        asked,
        `type ${bold(asked)} to confirm exactly what you are approving`);
    if ("code" in confirmed)
    {
        throw new CliError(`${confirmed.detail}\n\n  ${confirmed.next}`);
    }
    return confirmed;
}

function challenge(disclosed: Disclosed[]): string
{
    const ids = targetsOf(disclosed).map((target) => target.id).join(" ");
    return ids.length <= CHALLENGE_LIMIT ? ids : `${action(disclosed)} ${targetsOf(disclosed).length}`;
}

// The word for what the whole set is having done to it. A set that mixes
// transitions is described by the one they share: every record in it is being
// retired from what is true now.
function action(disclosed: Disclosed[]): string
{
    const kinds = new Set(disclosed.map((one) => one.intent.kind));
    return kinds.size === 1 ? ACTION[[...kinds][0]] : ACTION.supersede;
}

// Destroying a record goes through the gate and then through the same single
// writer every other event does: this is a caller of `recordEvents`, never a
// second way into the log.
//
// A call that destroys nothing passes straight through. Every verb that can
// destroy routes through here unconditionally, so whether the gate fires is
// decided by what the call displaces rather than by each verb deciding for
// itself — which is what keeps `decide --proposed --supersedes` out of the
// gate and `decide confirm` on a proposal that carries one inside it.
export function recordRetirement(
    ctx: CliContext,
    intent: RetirementIntent,
    model: ProjectModel,
    events: (confirmation?: HumanConfirmation) => SelfEvent[],
    summary: string
): void
{
    if (intent.targets.length === 0)
    {
        recordEvents(ctx, events(), summary);
        return;
    }
    if (collecting !== null)
    {
        collecting.push({ ctx, intent, model, events, summary });
        return;
    }
    recordEvents(ctx, events(requireHumanRetirement([{ intent, model }])), summary);
}

/* ── which verbs a reviewed set may run ────────────────────────────── */

// The leaves that can reach this gate, declared where they are declared.
//
// Holding the log shut is not enough on its own to keep a plan inside what one
// confirmation covers: the log is not the only thing a verb writes. `remote
// add` rewrites the store's git remote, `theme` and `timezone` rewrite the
// store config, `app install` writes the plugin registry — none of them
// touch the event log, so the hold never sees them, and running one and *then*
// refusing the file printed "nothing in this file was recorded" over a change
// that had already happened. So a plan resolves a line against these leaves
// only, and refuses anything else before it runs rather than after.
//
// Marking a leaf that turns out to destroy nothing costs nothing — the line
// queues no call and is refused for that. Forgetting to mark one that does
// costs a plan that refuses a verb it could have run. Both failures are safe,
// which is the point of putting the mark on the declaration.
const retiringLeaves = new WeakSet<CommandLeaf>();

export function retiring(node: CommandLeaf): CommandLeaf
{
    retiringLeaves.add(node);
    return node;
}

export function retires(node: CommandLeaf): boolean
{
    return retiringLeaves.has(node);
}

/* ── one judgment over a reviewed set (#312) ───────────────────────── */

// A gated call collected rather than asked about: everything the write needs,
// held until the person has seen the whole set it belongs to.
interface Collected extends Disclosed
{
    ctx: CliContext;
    events: (confirmation?: HumanConfirmation) => SelfEvent[];
    summary: string;
}

let collecting: Collected[] | null = null;

export const NESTED_SET_REFUSAL = "a reviewed set cannot open another one — one confirmation covers one file, "
    + "and a plan that applies a plan would put records outside it under the same answer";

// Open the collection, and stop the log accepting anything at all while it is
// open: a verb that records rather than destroys is refused by the append gate
// instead of writing before the person was asked.
export function collectRetirements(): void
{
    if (collecting !== null)
    {
        throw new CliError(NESTED_SET_REFUSAL);
    }
    collecting = [];
    holdAppends(true);
}

// How many gated calls the open collection is holding. A caller runs a line
// and asks whether it added anything: a line that destroys nothing has no
// place in a set one confirmation covers.
export function collectedSoFar(): number
{
    return collecting === null ? 0 : collecting.length;
}

// Dropped with nothing written. Every path that leaves the collection calls
// this, so a refused line cannot leave the next command holding a queue or a
// log that refuses appends.
export function dropCollected(): void
{
    collecting = null;
    holdAppends(false);
}

// The whole set, disclosed once and written only after one typed
// confirmation. Returns how many records were retired, which is what the
// caller answers with.
export function approveCollected(): number
{
    const queued = collecting ?? [];
    dropCollected();
    refuseRepeats(queued);
    const confirmation = requireHumanRetirement(queued);
    const retired = targetsOf(queued).length;
    // One write, not one per line. Every line's events are composed first and
    // handed over together, so a line the sanitizer or the archive gate refuses
    // stops the whole set before a byte is appended. Writing them one at a time
    // meant a second line carrying an absolute home path, or a first line
    // naming an archived project, destroyed the records above it and then
    // exited 1 saying nothing had been recorded (#312 review 1).
    recordCalls(queued.map((one) => ({ ctx: one.ctx, events: one.events(confirmation), summary: one.summary })),
        `${plural(retired, "record")} retired on one confirmation`);
    return retired;
}

// One confirmation covers a set, and a set holds each record once. A second
// line naming a record an earlier one already retires records an event that
// changes nothing, so it is a mistake in the reviewed file rather than a
// no-op to wave through.
function refuseRepeats(queued: Collected[]): void
{
    const seen = new Set<string>();
    for (const target of targetsOf(queued))
    {
        if (seen.has(target.id))
        {
            throw new CliError(`${target.id} is named twice, and one confirmation covers each record once — `
                + "drop the repeated line and run it again");
        }
        seen.add(target.id);
    }
}

// The refusal an agent reads. It ends with the command as it was typed, so
// the person it is handed to runs that rather than rebuilding it.
function refusal(disclosed: Disclosed[], disclosure: string): string
{
    return [
        `this ${subject(disclosed)} ${describe(disclosed)}, and nothing was recorded — ` +
            "retiring a record is a person's call, and this process has no terminal to make it at",
        "",
        disclosure,
        "",
        "  a person runs this in their own terminal:",
        `    ${typedCommand()}`
    ].join("\n");
}

function headline(disclosed: Disclosed[]): string
{
    return `this ${subject(disclosed)} ${describe(disclosed)} — nothing is recorded until you confirm`;
}

// What is happening to the set, in one verb. A set that mixes transitions
// reads as the one thing they all do: it retires the records in it.
function subject(disclosed: Disclosed[]): string
{
    const kinds = new Set(disclosed.map((one) => one.intent.kind));
    return kinds.size === 1 ? SUBJECT[[...kinds][0]] : SUBJECT.supersede;
}

// What is about to be lost, in the words a person uses for it. The label a
// record carries is the noun everywhere else it renders, so it is the noun
// here too — except where the label is a shorthand the sentence cannot use.
const NOUN: Record<string, string> = { work: "work unit" };

function describe(disclosed: Disclosed[]): string
{
    const targets = targetsOf(disclosed);
    const noun = NOUN[commonLabel(targets)] ?? commonLabel(targets);
    return targets.length === 1 ? `a confirmed ${noun}` : `${targets.length} confirmed ${noun}s`;
}

// What the set is made of, where it is made of one thing. A reviewed set that
// mixes kinds is described as records rather than named after whichever one
// happened to be listed first.
function commonLabel(targets: EntityState[]): string
{
    const labels = new Set(targets.map((target) => target.labels[0] ?? "record"));
    return labels.size === 1 ? [...labels][0] : "record";
}

// How a disclosure is weighted where it is read. The prompt is the only styled
// one: a refusal is read by a process, and an escape sequence in text something
// parses is noise it never asked for. Painting is a no-op off a terminal
// anyway, so `PROMPT_EMPHASIS` is safe wherever the prompt itself is reachable.
interface Emphasis
{
    // What the record is, which is what a person scanning for the wrong target
    // reads first.
    head: (text: string) => string;
    // What points at it, which matters only once the target is the right one.
    aside: (text: string) => string;
}

const PLAIN_EMPHASIS: Emphasis = { head: (text) => text, aside: (text) => text };
const PROMPT_EMPHASIS: Emphasis = { head: bold, aside: dim };

// One target, as a person reads it: what it says, when it was confirmed, how
// long ago, and what still points at it. The record's own words are never
// painted — they are the thing being judged.
function renderTarget(target: EntityState, model: ProjectModel, emphasis: Emphasis): string[]
{
    const lines = [emphasis.head(`  ${target.id}  ${target.labels[0] ?? "record"}  confirmed ${target.ts}  (${age(target.ts)})`)];
    lines.push(...quoted(target.text));
    if (target.why !== undefined)
    {
        lines.push(...quoted(target.why, "why: "));
    }
    lines.push(emphasis.aside(`  referenced by: ${references(target.id, model)}`));
    return lines;
}

// One blank line between calls, because a reviewed set of a dozen read as one
// wall of text is a list nobody checks record by record.
function renderDisclosure(disclosed: Disclosed[], emphasis: Emphasis): string
{
    return disclosed.map((one) => renderCall(one, emphasis).join("\n")).join("\n\n");
}

// One call's targets, and under them the reason it gives for retiring them.
// Both halves are what a person judges: the record's own words say what is
// being lost, and the reason says why this call thinks it should be.
function renderCall(one: Disclosed, emphasis: Emphasis): string[]
{
    const lines = one.intent.targets.flatMap((target) => renderTarget(target, one.model, emphasis));
    return [...lines, ...reasonGiven(one.intent)];
}

// Why this call says the records should go. A withdrawal says it in `--why`; a
// supersession says it by writing a successor, so the successor's own words are
// the reason and the disclosure states them — the person is approving that text
// as much as the loss of the text above it.
function reasonGiven(intent: RetirementIntent): string[]
{
    const lines = intent.successor === undefined
        ? []
        : quoted(intent.successor.text, `replaced by this new ${intent.successor.kind}: `);
    return intent.why === undefined
        ? lines
        : [...lines, ...quoted(intent.why, `${PAST[intent.kind]} because: `)];
}

// Everything that still names this record. Read off the same folded model the
// verb already built, so the disclosure costs no extra read.
function references(id: string, model: ProjectModel): string
{
    const naming = model.entities
        .filter((entity) => entity.id !== id && entity.links.some((link) => link.target === id))
        .map((entity) => `${entity.id} (${entity.labels[0] ?? "record"})`);
    if (naming.length === 0)
    {
        return "nothing";
    }
    const shown = naming.slice(0, REFERENCE_LIMIT).join(", ");
    return naming.length > REFERENCE_LIMIT ? `${shown}, +${naming.length - REFERENCE_LIMIT} more` : shown;
}

// The record's own words, never reflowed or translated: the point of the
// disclosure is showing what was written.
function quoted(text: string, lead = ""): string[]
{
    const lines = text.split("\n");
    const shown = lines.slice(0, TEXT_LINE_LIMIT).map((line, index) => `  ${index === 0 ? lead : ""}${line}`);
    if (lines.length > TEXT_LINE_LIMIT)
    {
        shown.push(`  … (+${lines.length - TEXT_LINE_LIMIT} lines)`);
    }
    return shown;
}

// Age is the strongest single signal in the disclosure: retiring something
// confirmed minutes ago is nearly always an accident.
function age(ts: string): string
{
    const minutes = Math.floor((Date.now() - Date.parse(ts)) / 60000);
    if (minutes < 1)
    {
        return "just now";
    }
    if (minutes < 60)
    {
        return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    }
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours} hour${hours === 1 ? "" : "s"} ago` : `${Math.floor(hours / 24)} days ago`;
}

// The command line this invocation was given. `process.argv` answers for the
// **process**, which was the same thing only while one process ran one command.
// It no longer is: `runCli` is called directly, more than once, in a process
// whose own argv is something else entirely — and a refusal whose remedy line
// tells a person to re-run the test runner is worse than one that says nothing.
let typedArgv: string[] = [];

export function recordInvocation(argv: string[]): void
{
    typedArgv = argv;
}

// The command exactly as it was typed. Arguments that carried spaces are
// re-quoted so the line can be pasted back verbatim.
function typedCommand(): string
{
    const args = typedArgv.map((arg) => /[\s"]/.test(arg) ? `"${arg.replace(/"/g, "\\\"")}"` : arg);
    return ["self", ...args].join(" ");
}
