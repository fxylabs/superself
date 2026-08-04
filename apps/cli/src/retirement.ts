// The one path every verb takes to destroy a record. Retiring a record is a
// person's call: this gate puts the target in front of whoever is asking and
// then reads a typed confirmation from a terminal, so a process with no
// person at it cannot destroy anything (#173).
//
// The disclosure is rendered once and ends two ways — a refusal inside a
// process with no terminal, a challenge prompt at one — so what an agent
// reads and what a person reads cannot drift apart.
import { EntityState } from "./entities.js";
import { attemptMarker, confirmHuman, HumanConfirmation } from "./human.js";
import { ProjectModel } from "./model.js";
import { CliContext } from "./paths.js";
import { recordEvents } from "./pipeline.js";
import { CliError, SelfEvent } from "./types.js";

// What the three transitions are called where a person reads them. The verb
// each one arrives from varies; what is being lost does not.
export type RetirementKind = "supersede" | "retract" | "retire";

export interface RetirementIntent
{
    kind: RetirementKind;
    // The records this call destroys, already resolved and already checked
    // for being destroyable: resolution and its refusals stay with the verb
    // that owns them, so the gate never invents a second way to name a record.
    targets: EntityState[];
}

// What a verb hands the gate: the ids it already resolved, read back out of
// the folded model it already built. A target the model does not carry is
// dropped rather than guessed at — the verb's own refusals ran first.
// What a verb hands the gate: the ids it already resolved, read back out of
// the folded model it already built. Only a record that is still standing is
// a target — a supersedes link naming something already superseded destroys
// nothing, and the trigger is what this call displaces now, never which flag
// was typed.
export function retirementIntent(model: ProjectModel, kind: RetirementKind, ids: string[]): RetirementIntent
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
    return { kind, targets };
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

// How many references and how much text a person will actually read. A
// disclosure that scrolls past the top of the terminal is not a disclosure.
const REFERENCE_LIMIT = 8;
const TEXT_LINE_LIMIT = 20;

// The gate. Returns the record of how the person was verified, which the
// caller puts in the event payload — `origin.confirmed` alone is a bit any
// process can set, so the payload carries what was actually typed.
export function requireHumanRetirement(intent: RetirementIntent, model: ProjectModel): HumanConfirmation
{
    const disclosure = renderDisclosure(intent, model);
    const challenge = intent.targets.map((target) => target.id).join(" ");
    if (attemptMarker() !== undefined || !process.stdin.isTTY || !process.stdout.isTTY)
    {
        throw new CliError(refusal(intent, disclosure));
    }
    const confirmed = confirmHuman(`${headline(intent)}\n\n${disclosure}`, challenge);
    if ("code" in confirmed)
    {
        throw new CliError(`${confirmed.detail}\n\n  ${confirmed.next}`);
    }
    return confirmed;
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
    recordEvents(ctx, events(requireHumanRetirement(intent, model)), summary);
}

// The refusal an agent reads. It ends with the command as it was typed, so
// the person it is handed to runs that rather than rebuilding it.
function refusal(intent: RetirementIntent, disclosure: string): string
{
    return [
        `this ${SUBJECT[intent.kind]} ${describe(intent)}, and nothing was recorded — ` +
            "retiring a record is a person's call, and this process has no terminal to make it at",
        "",
        disclosure,
        "",
        "  a person runs this in their own terminal:",
        `    ${typedCommand()}`
    ].join("\n");
}

function headline(intent: RetirementIntent): string
{
    return `this ${SUBJECT[intent.kind]} ${describe(intent)} — nothing is recorded until you confirm`;
}

// What is about to be lost, in the words a person uses for it. The label a
// record carries is the noun everywhere else it renders, so it is the noun
// here too — except where the label is a shorthand the sentence cannot use.
const NOUN: Record<string, string> = { work: "work unit" };

function describe(intent: RetirementIntent): string
{
    const label = intent.targets[0]?.labels[0] ?? "record";
    const noun = NOUN[label] ?? label;
    return intent.targets.length === 1 ? `a confirmed ${noun}` : `${intent.targets.length} confirmed ${noun}s`;
}

// One target, as a person reads it: what it says, when it was confirmed, how
// long ago, and what still points at it.
function renderTarget(target: EntityState, model: ProjectModel): string[]
{
    const lines = [`  ${target.id}  ${target.labels[0] ?? "record"}  confirmed ${target.ts}  (${age(target.ts)})`];
    lines.push(...quoted(target.text));
    if (target.why !== undefined)
    {
        lines.push(...quoted(target.why, "why: "));
    }
    lines.push(`  referenced by: ${references(target.id, model)}`);
    return lines;
}

function renderDisclosure(intent: RetirementIntent, model: ProjectModel): string
{
    return intent.targets.flatMap((target) => renderTarget(target, model)).join("\n");
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

// The command exactly as it was typed. Arguments that carried spaces are
// re-quoted so the line can be pasted back verbatim.
function typedCommand(): string
{
    const args = process.argv.slice(2).map((arg) => /[\s"]/.test(arg) ? `"${arg.replace(/"/g, "\\\"")}"` : arg);
    return ["self", ...args].join(" ");
}
