// The derived reading of an instruction record (#440): which records the
// instruction render answers with, which section each one falls under, the
// order the sections and their entries print in, and the lines they print as.
// Domain layer — it reads the entity fold and its own peers only, never the
// model that calls it. Which records answer in one project is the store walk
// `renderedIn` (`model.ts`), one layer up: every surface here is handed that
// set rather than collecting one of its own.
//
// Nothing here is stored. An instruction is an entity labelled `instruction`
// whose `source` is undefined: the rule is its text, its section a second
// label beside it — `rule`, `tool` or `procedure` — its order the existing
// `priority`, and which projects render it the existing `EntityScope`.
// **No new event type, no new reducer, no new reserved metadata key, no new
// row in `BUILTIN_ROWS`, and no `@superself/fold` change: `FOLD_VERSION`
// stays at 1.**

import {
    entityCharacters,
    EntitySource,
    EntityState,
    Exposure,
    EXPOSURES,
    isCurrent,
    occupiesTier,
    orderEntities
} from "@superself/fold";
import { oneLine } from "./style.js";

// The one label this surface records under. Never a row in `BUILTIN_ROWS` —
// see `INSTRUCTION_ROW` in `instruction.ts` for why.
export const INSTRUCTION_LABEL = "instruction";

// The three sections an instruction can fall under, in the order a record's
// own labels are read for one: membership, never position, exactly as
// `sourceOf` (`entities.ts`) reads a preset source. A raw `state add` carrying
// two of them reads as the first of these it holds.
export const INSTRUCTION_KINDS = ["rule", "tool", "procedure"] as const;

export type InstructionKind = typeof INSTRUCTION_KINDS[number];

// The order the render prints, which is deliberately not the order above: a
// session reads what its tools are before the rules it judges by and the
// procedures it follows. `Unclassified` is last — a record with no kind label
// is what a raw `state add` mints, and it renders where a reader finds it
// after the sections they came for (§D-1).
const SECTIONS: { kind?: InstructionKind; heading: string }[] = [
    { kind: "tool", heading: "Tools" },
    { kind: "rule", heading: "Rules" },
    { kind: "procedure", heading: "Procedures" },
    { heading: "Unclassified" }
];

// What a concatenating caller splices, and the one line an empty store still
// prints: a command that printed nothing would make an empty store
// indistinguishable from a failed run (§D-3).
export const INSTRUCTION_HEAD = "# Instructions — follow; do not restate.";

// The `source` guard is what keeps a record carrying a preset label — which
// `sourceOf` folds into an `EntitySource` — from being read as an
// instruction, exactly as `isSkill` guards a skill.
export function isInstruction(entity: EntityState): boolean
{
    return entity.labels.includes(INSTRUCTION_LABEL) && entity.source === undefined;
}

// The labels the fold reads as an `EntitySource`, written as a total map over
// that union rather than as a list: a kind added to `SOURCE_LABELS`
// (`entities.ts`) fails this build instead of silently widening what counts as
// an instruction. Needed because the cap gate judges a record before it exists,
// where there is no folded `source` to read (#446 §D-14).
const SOURCE_LABELS: Record<EntitySource, true> = {
    goal: true, decision: true, convention: true, objective: true, milestone: true, work: true
};

// The same rule as `isInstruction`, read off the labels a payload is about to
// be written with. One rule, two readings — the label is the mechanism, so
// `instruction add` and a raw `state add --label instruction` are judged alike.
//
// `Object.hasOwn` rather than `in`: a label is caller-supplied text, and `in`
// walks `Object.prototype`, so `--label constructor` — or `toString`, or
// `__proto__` — would read as a preset source and take the record out of the
// instruction cap into a retention tier no `sourceOf` ever puts it in.
export function labelsAreInstruction(labels: string[]): boolean
{
    return labels.includes(INSTRUCTION_LABEL) && !labels.some((label) => Object.hasOwn(SOURCE_LABELS, label));
}

/* ── what the instruction cap holds (#446) ─────────────────────────── */

// Whether a record charges the instruction cap at a render target: a live
// instruction that renders there, at **any** exposure. The cap bounds the
// store's manual, and a demoted instruction is still one of its records —
// where a retention tier asks which projection a record is in, this asks
// whether the manual holds it at all (§D-14).
export function chargesInstructionCap(entity: EntityState, home: string, target: string): boolean
{
    return isInstruction(entity)
        && EXPOSURES.some((exposure) => occupiesTier(entity, home, target, exposure));
}

// What the instruction cap holds at one target, in characters. Summed through
// `occupiesTier` rather than beside it, so what this counts and what a tier
// counts can never drift into two answers about one record.
export function instructionCharacters(entities: EntityState[], home: string, target: string): number
{
    return sumCharacters(entities.filter((item) => chargesInstructionCap(item, home, target)));
}

// What the instructions inside one retention tier cost it — the number the CLI
// subtracts from `tierCharacters`, which keeps counting them because the fold
// does not change and `FOLD_VERSION` stays at 1. The fold's own count and
// `holdsSeat`'s (`state.ts`) are the same rule stated twice, for the two
// places that need it: this one corrects `tierCharacters`' sum after the
// fact, `holdsSeat` excludes an instruction from a demotion's credit before
// one is ever summed.
export function instructionTierCharacters(entities: EntityState[], home: string,
    target: string, exposure: Exposure): number
{
    return sumCharacters(entities.filter((item) => isInstruction(item)
        && occupiesTier(item, home, target, exposure)));
}

function sumCharacters(entities: EntityState[]): number
{
    return entities.reduce((sum, item) => sum + entityCharacters(item), 0);
}

function instructionKind(entity: EntityState): InstructionKind | undefined
{
    return INSTRUCTION_KINDS.find((kind) => entity.labels.includes(kind));
}

// The instructions a render answers with: confirmed, current, and at full
// exposure. A demoted one has left the render for `self context`'s index
// block, a proposal is not yet held, and a withdrawn or superseded one has
// left both. The argument is the set that renders in one project — its own
// records plus every other project's workspace-scoped ones — so an entry
// exists here exactly where a row renders.
function renderedInstructions(rendered: EntityState[]): EntityState[]
{
    return orderEntities(rendered.filter((item) => isInstruction(item)
        && item.status === "confirmed" && isCurrent(item) && item.exposure === "full"));
}

export interface InstructionSection
{
    kind: InstructionKind | "unclassified";
    heading: string;
    entries: EntityState[];
}

// The render, sectioned. An empty section is absent rather than printed empty
// (§D-2): the render is read verbatim into a session's context, where a
// heading promising rules and holding none is a line that costs tokens and
// says nothing.
export function instructionSections(rendered: EntityState[]): InstructionSection[]
{
    const instructions = renderedInstructions(rendered);
    return SECTIONS
        .map((section): InstructionSection => ({
            kind: section.kind ?? "unclassified",
            heading: section.heading,
            entries: instructions.filter((item) => instructionKind(item) === section.kind)
        }))
        .filter((section) => section.entries.length > 0);
}

// The lines the render prints, composed here so the command, its `--json`
// payload and the handoff packet can never describe one set three ways.
export function instructionLines(rendered: EntityState[]): string[]
{
    return [INSTRUCTION_HEAD, ...instructionSections(rendered).flatMap(sectionLines)];
}

function sectionLines(section: InstructionSection): string[]
{
    return ["", `## ${section.heading}`, ...section.entries.map((entry) => `- ${oneLine(entry.text)}`)];
}
