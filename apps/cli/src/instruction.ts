// The rules, tool notes and procedures a session receives whole (#440): the
// operating manual for a workspace, beside the judgement records `self
// context` renders under a budget. An instruction is read verbatim and never
// elided, grouped into ordered sections, and still a first-class entity with
// supersession, retraction, undo and placement.
//
// Commands layer — a module beside `skill.ts` for the same reason: `self
// context` has to know what to leave out and `main.ts` is the dispatcher.
// Every verb here composes records out of the `entity.*` grammar that already
// exists: **no new event type, no new reducer, no new reserved metadata key,
// no new row in `BUILTIN_ROWS`, and no `@superself/fold` change —
// `FOLD_VERSION` stays at 1.** An instruction is an entity labelled
// `instruction` whose section is a second label beside it, written through the
// `reserved` spread exactly as `runbook start` writes `[runbook-run, <key>]`.
//
// It is outside the 3,000-token context render budget because it is not in
// the context projection at all: one predicate in `projectContextSections`
// (`views.ts`) excludes a full-exposure instruction, and `instruction render`
// is a separate command a caller concatenates. Splicing it into `context`
// would zero every other section — `fitKeeps` never cuts `head` and measures
// the whole string.

import { EntityState, entityCharacters } from "@superself/fold";
import { Requirement, required, requireText } from "./args.js";
import { branch, Command, CommandInput, leaf } from "./contract.js";
import {
    INSTRUCTION_KINDS,
    INSTRUCTION_LABEL,
    instructionLines,
    InstructionKind,
    InstructionSection,
    instructionSections,
    instructionsRenderedIn,
    isInstruction
} from "./instructions.js";
import { buildModel, workspaceModels } from "./model.js";
import {
    ProjectContext,
    readScopes,
    readStoreConfig,
    requireProject,
    retentionCaps,
    SCOPE_OPTIONS,
    tokenScale,
    TokenScale
} from "./paths.js";
import { composedEntityAdd, estimateNote } from "./state.js";
import { oneLine, tokensOf } from "./style.js";
import { CliError, CommandOutput, JsonValue } from "./types.js";

const INSTRUCTION_USAGE = 'usage: self instruction | add "<text>" --kind rule|tool|procedure'
    + " | render [--project <slug>]";

const ADD_USAGE = 'instruction add "<text>" --kind rule|tool|procedure';

const EMPTY_LISTING = "no instructions recorded — record one with"
    + ' `self instruction add "<text>" --kind rule|tool|procedure`';

const ADD_OPTIONS = {
    kind: { type: "string" },
    priority: { type: "string" },
    workspace: { type: "boolean" },
    scope: { type: "string" },
    supersedes: { type: "string", multiple: true },
    demote: { type: "string", multiple: true },
    proposed: { type: "boolean" },
    why: { type: "string" }
} as const;

// `--project` is deliberately absent here and declared on `render` alone
// (§D-13): the listing closes with a cap share, and a cap share for a tier the
// caller is not standing in is a number about somebody else's store.
const RENDER_OPTIONS = { ...SCOPE_OPTIONS, json: { type: "boolean" } } as const;

const ADD_KIND: Requirement = {
    flags: ["kind"], value: "<rule|tool|procedure>",
    hint: "which section it renders under"
};

// Where an instruction is born: the full tier, priority 50 — the same free
// slot `SKILL_ROW` takes, written into the payload by the row rather than left
// absent, because `orderEntities` sorts a missing priority to
// `MAX_SAFE_INTEGER` and an absent default would put every instruction below
// every priced record in any shared ordering (§D-5).
//
// Module-local, never a row in `BUILTIN_ROWS`: `BUILTIN_VERBS` is that table's
// key set, so a row there would mint `self instruction` as a preset add verb
// recording an instruction with no kind, colliding with the real command.
const INSTRUCTION_ROW = { label: INSTRUCTION_LABEL, exposure: "full" as const, priority: 50 };

export const INSTRUCTION_COMMAND: Command = {
    name: "instruction",
    usage: [
        {
            syntax: "instruction [list]",
            description: ["list the instructions this project renders, by section, with the token total"],
            verbs: ["", "list"]
        },
        {
            syntax: 'instruction add "<text>" --kind rule|tool|procedure [--priority n]'
                + " [--workspace|--scope <slug>] [--supersedes <id>] [--demote <id>] [--proposed] [--why w]",
            description: ["record a rule, a tool note or a procedure every session here is handed whole"],
            verbs: ["add"]
        },
        {
            syntax: "instruction render [--project <slug>] [--json]",
            description: ["print the operating manual, ready to read beside `self context`"],
            verbs: ["render"]
        }
    ],
    detail: [
        "an instruction is an execution rule, a tool note or a procedure every",
        "session in this workspace follows: \"implementation and tests run on the dev",
        "VM\", \"`self report` carries --friction\", \"targeted suites, then commit and",
        "push, then CI as the referee\". `self context` renders judgement records under",
        "a 3,000-token budget that elides from the bottom up; an instruction is not in",
        "that projection at all, so `instruction render` prints every one of them",
        "whole, in a fixed section order, however far the store stands over its caps.",
        "",
        "it is still an ordinary record. It charges the retention caps like any other,",
        "and no cap has an exemption for it — raising `fullTokens` in the store's",
        "config.json is the remedy, as it is for every kind. A correction is",
        "--supersedes, a withdrawal is `self state retract`, and `self undo` takes an",
        "add back.",
        "",
        "  --kind <rule|tool|procedure>  which section it renders under: a rule is a",
        "                        judgement or execution rule, a tool is a note about a",
        "                        command, a procedure is steps in a fixed order",
        "  --priority <n>        the order inside its section, lowest first; 50 by default",
        "  --workspace           record at workspace scope: the instruction renders in",
        "                        every project; its record stays in this project's store",
        "  --scope <slug>        render it in another registered project instead",
        "  --supersedes <id>     the instruction this one replaces; the predecessor retires",
        "  --demote <id>         past a retention cap: the confirmed entity that frees its",
        "                        place by moving one tier down; repeatable",
        "  --proposed            record it as a proposal `self state confirm` lands",
        "  --why <text>          why the instruction holds",
        "  --project <slug>      render this registered project's set instead of this",
        "                        directory's; on render only",
        "",
        "demoting one with `self state place <id> --exposure index --why \"<reason>\"`",
        "takes it out of the render and puts it back in `self context` as one index",
        "line. There is no verb that edits an instruction in place: a record's text is",
        "immutable once confirmed, and the correction is a new one that supersedes it."
    ],
    node: branch({
        name: "instruction",
        unnamed: "options",
        refusal: INSTRUCTION_USAGE,
        children: [
            leaf("", {}, 0, instructionList),
            leaf("list", {}, 0, instructionList),
            leaf("add", ADD_OPTIONS, 1, instructionAdd, { requires: [ADD_KIND] }),
            leaf("render", RENDER_OPTIONS, 0, instructionRender)
        ]
    })
};

/* ── what an add was given ─────────────────────────────────────────── */

// The record an add is about to compose, once every refusal it owes on its
// own arguments has been answered. Built before the project is resolved, so a
// malformed call is refused the same way on a machine with no workspace.
interface AskedInstruction
{
    text: string;
    kind: InstructionKind;
    // The raw verb's own spelling of where the record renders: `workspace`, a
    // registered slug, or nothing for the project the command runs in.
    scope?: string;
}

function requireAdd(values: CommandInput<typeof ADD_OPTIONS>["values"], positionals: string[]): AskedInstruction
{
    return {
        text: requireText(positionals[0], ADD_USAGE),
        kind: requireKind(required(values.kind)),
        ...requireScope(values)
    };
}

// The kind is what decides the section, so an unrecognised one is refused
// rather than filed under `Unclassified`: a caller who typed `--kind harness`
// stated a section, and rendering it somewhere else would answer a question
// they did not ask.
function requireKind(named: string): InstructionKind
{
    const kind = INSTRUCTION_KINDS.find((candidate) => candidate === named.trim());
    if (kind === undefined)
    {
        throw new CliError(`"${named}" is not an instruction kind — pass rule (a judgement or execution rule),`
            + " tool (a note about a command), or procedure (steps in a fixed order)");
    }
    return kind;
}

// Two spellings of one placement. Naming both is not a narrower ask, so it is
// refused rather than resolved to whichever the parser happened to read last
// (§D-12).
function requireScope(values: CommandInput<typeof ADD_OPTIONS>["values"]): { scope?: string }
{
    if (values.workspace === true && values.scope !== undefined)
    {
        throw new CliError("--workspace and --scope name the same thing two ways — pass one of them");
    }
    if (values.workspace === true)
    {
        return { scope: "workspace" };
    }
    return values.scope === undefined ? {} : { scope: values.scope };
}

/* ── recording one ─────────────────────────────────────────────────── */

function instructionAdd({ values, positionals }: CommandInput<typeof ADD_OPTIONS>): CommandOutput
{
    const asked = requireAdd(values, positionals);
    const ctx = requireProject(process.cwd());
    requireInstructionTargets(ctx, values.supersedes ?? []);
    // `reserved` spreads last into the payload, which is how the second label
    // is written and why this verb offers no --label: a caller's own label
    // would be discarded here without a word, so no such flag exists (§A30).
    return composedEntityAdd(INSTRUCTION_ROW, { labels: [INSTRUCTION_LABEL, asked.kind] }, {
        why: values.why,
        supersedes: values.supersedes,
        demote: values.demote,
        scope: asked.scope,
        priority: values.priority,
        proposed: values.proposed === true
    }, asked.text);
}

// Supersession is held to instructions the way `skill.ts` holds it to skills:
// the target is resolved through this verb's own predicate before the add.
// `requireSupersedeKind` reads `entity.source ?? "entity"`, so it can name a
// convention, a goal or a work unit in the fold's own words and cannot tell an
// instruction from a skill, a runbook or a raw `state add` record. Exactly
// those are refused here; everything else keeps the refusal it already had.
function requireInstructionTargets(ctx: ProjectContext, wanted: string[]): void
{
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    for (const id of wanted)
    {
        const found = model.entities.find((item) => item.id === id);
        if (found !== undefined && found.source === undefined && !isInstruction(found))
        {
            throw new CliError(`${found.id} is not an instruction — \`instruction add --supersedes\` replaces an`
                + " instruction; run `self instruction` for the ids it takes");
        }
    }
}

/* ── the read verbs ────────────────────────────────────────────────── */

function instructionList(): CommandOutput
{
    const ctx = requireProject(process.cwd());
    const sections = instructionSections(instructionsRenderedIn(workspaceModels(ctx.storeDir, ctx.project), ctx.project));
    const entries = sections.flatMap((section) => section.entries);
    return [{
        kind: "listing",
        rows: entries.length === 0 ? [EMPTY_LISTING] : [...listRows(sections), ...shareLines(ctx, entries)],
        total: entries.length,
        noun: "instruction"
    }];
}

function listRows(sections: InstructionSection[]): string[]
{
    const width = Math.max(...sections.flatMap((section) =>
        section.entries.map((entry) => String(entry.priority ?? "").length)));
    return sections.flatMap((section) => [section.heading,
        ...section.entries.map((entry) => `  ${entry.id}  ${String(entry.priority ?? "").padStart(width)}`
            + `  ${scopeWord(entry)}  ${oneLine(entry.text)}`)]);
}

function scopeWord(entity: EntityState): string
{
    return entity.scope === "workspace" ? "workspace" : "project  ";
}

// One line per occupied tier (§D-6). A `--workspace` instruction charges the
// workspace full tier and a project-scoped one charges this project's, so
// adding them together would produce a number neither cap governs.
function shareLines(ctx: ProjectContext, entries: EntityState[]): string[]
{
    const config = readStoreConfig(ctx.storeDir);
    const scale = tokenScale(config);
    const cap = retentionCaps(config).full;
    return ["project", "workspace"]
        .map((tier) => ({ tier, held: entries.filter((entry) => tierOfEntry(entry) === tier) }))
        .filter((group) => group.held.length > 0)
        .map((group) => shareLine(group.tier, group.held, cap, scale));
}

// Which capped tier an instruction that renders here occupies: the workspace
// full tier, or this project's. `rendersIn` already settled that no third
// answer reaches this list.
function tierOfEntry(entity: EntityState): string
{
    return entity.scope === "workspace" ? "workspace" : "project";
}

function shareLine(tier: string, held: EntityState[], cap: number, scale: TokenScale): string
{
    const tokens = tokensOf(held.reduce((sum, entry) => sum + entityCharacters(entry), 0), scale.perCharacter);
    return `${tokens} tokens — ${tokens} of the ${cap}-token ${tier} full cap`
        + ` (${Math.round((tokens / cap) * 100)}%)${estimateNote(scale)}`;
}

/* ── the render itself ─────────────────────────────────────────────── */

function instructionRender({ values }: CommandInput<typeof RENDER_OPTIONS>): CommandOutput
{
    const scope = readScopes(process.cwd(), values)[0];
    const rendered = instructionsRenderedIn(workspaceModels(scope.storeDir, scope.project), scope.project);
    return [{
        kind: "payload",
        data: { project: scope.project, sections: instructionSections(rendered).map(sectionPayload) },
        plain: () => instructionLines(rendered)
    }];
}

// The machine shape, section for section and entry for entry with the render
// above it (§D-11): the two are built from one ordering, so a caller reading
// the payload and a session reading the text can never be handed two answers.
function sectionPayload(section: InstructionSection): JsonValue
{
    return {
        kind: section.kind,
        heading: section.heading,
        entries: section.entries.map((entry) => ({
            id: entry.id,
            text: entry.text,
            ...(entry.priority === undefined ? {} : { priority: entry.priority }),
            scope: entry.scope,
            ...(entry.why === undefined ? {} : { why: entry.why })
        }))
    };
}
