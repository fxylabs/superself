// The derived reading of an instruction record (#440): which records the
// instruction render answers with, which section each one falls under, the
// order the sections and their entries print in, and the lines they print as.
// Domain layer — it reads the entity fold and its own peers only, never the
// model that calls it.
//
// Nothing here is stored. An instruction is an entity labelled `instruction`
// whose `source` is undefined: the rule is its text, its section a second
// label beside it — `rule`, `tool` or `procedure` — its order the existing
// `priority`, and which projects render it the existing `EntityScope`.
// **No new event type, no new reducer, no new reserved metadata key, no new
// row in `BUILTIN_ROWS`, and no `@superself/fold` change: `FOLD_VERSION`
// stays at 1.**

import { EntityState, isCurrent, orderEntities, ProjectModel, rendersIn } from "@superself/fold";
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

// Every record that answers in one project: its own confirmed current records
// plus every other project's workspace-scoped ones. `rendersIn` is the rule
// the context projection already collects by, so an instruction reaches a
// render exactly where a row renders. Shared by the command and the handoff
// packet, so the two can never answer with two different sets.
export function instructionsRenderedIn(models: ProjectModel[], viewer: string): EntityState[]
{
    return models.flatMap((model) => model.entities.filter((item) => item.status === "confirmed"
        && isCurrent(item) && rendersIn(item, model.slug, viewer)));
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
