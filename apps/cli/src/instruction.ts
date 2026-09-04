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
// **An instruction is text a session is told to follow, and anyone who can
// append to this store can write one.** The store is synced between machines
// and clones, so a rule appended anywhere is read everywhere, by every session
// that runs the render. The CLI's part in that is one thing only: it prints
// what the store holds. It never runs a line an instruction names, never
// fetches anything one points at, and gives an instruction no authority over
// the harness or the system prompt above it — a session decides what to do
// with what it reads, exactly as it does with `self context`.
//
// It is outside the 3,000-token context render budget because it is not in
// the context projection at all: one predicate in `projectContextSections`
// (`views.ts`) excludes a full-exposure instruction, and `instruction render`
// is a separate command a caller concatenates. Splicing it into `context`
// would zero every other section — `fitKeeps` never cuts `head` and measures
// the whole string.
//
// Being outside that projection, it charges neither retention tier at any
// exposure (#446): the tier caps exist so `context` fits its budget, and a
// record nothing ever elides has no business competing for room with the
// records that are elided. `instructionTokens` is the cap it does charge —
// its own, per render target, 2,000 tokens by default — and this module's
// listing closes with the share of it this project holds.

import { EntityState, entityCharacters } from "@superself/fold";
import { Requirement, required, requireText } from "./args.js";
import { branch, Command, CommandInput, leaf } from "./contract.js";
import {
    chargesInstructionCap,
    INSTRUCTION_KINDS,
    INSTRUCTION_LABEL,
    instructionLines,
    InstructionKind,
    InstructionSection,
    instructionSections,
    isInstruction
} from "./instructions.js";
import { buildModel, ProjectModel, renderedIn, workspaceModels } from "./model.js";
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
import { composedEntityAdd, estimateNote, scopeLabel } from "./state.js";
import { oneLine, tokensOf } from "./style.js";
import { CliError, CommandOutput, JsonValue } from "./types.js";

const INSTRUCTION_USAGE = 'usage: self instruction | add "<text>" --kind rule|tool|procedure'
    + " | render [--project <slug>]";

const ADD_USAGE = 'instruction add "<text>" --kind rule|tool|procedure';

const EMPTY_LISTING = "no instructions recorded — record one with"
    + ' `self instruction add "<text>" --kind rule|tool|procedure`';

const ADD_OPTIONS = {
    // Repeatable so a second one is refused by name (#238's rule), exactly as
    // `skill.ts` declares `--command`: an instruction renders under one
    // section, and a single option would let the parser keep the last value
    // and drop the first without a word.
    kind: { type: "string", multiple: true },
    priority: { type: "string" },
    workspace: { type: "boolean" },
    scope: { type: "string" },
    supersedes: { type: "string", multiple: true },
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
                + " [--workspace|--scope <slug>] [--supersedes <id>] [--proposed] [--why w]",
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
        "it is still an ordinary record: a correction is --supersedes, a withdrawal is",
        "`self state retract`, and `self undo` takes an add back. What it does not do is",
        "charge a retention tier. `fullTokens` and `indexTokens` bound what `self",
        "context` renders, and an instruction is in no part of that projection, so it",
        "charges neither of them at any exposure and demoting a goal, an objective or a",
        "convention frees it nothing.",
        "",
        "it is bounded by `instructionTokens` instead — its own cap in the store's",
        "config.json, 2,000 tokens by default, counted per render target. Past it the",
        "add is refused rather than quietly trimmed, and the room is made among the",
        "instructions: retire one, supersede one with a shorter text, or raise the cap.",
        "`self instruction` closes with the share of it this project holds.",
        "",
        "  --kind <rule|tool|procedure>  which section it renders under: a rule is a",
        "                        judgement or execution rule, a tool is a note about a",
        "                        command, a procedure is steps in a fixed order",
        "  --priority <n>        the order inside its section, lowest first; 50 by default",
        "  --workspace           record at workspace scope: the instruction renders in",
        "                        every project; its record stays in this project's store",
        "  --scope <slug>        render it in another registered project instead",
        "  --supersedes <id>     the instruction this one replaces; the predecessor retires",
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
        text: requireOneLine(requireText(positionals[0], ADD_USAGE)),
        kind: requireOneKind(values.kind),
        ...requireScope(values)
    };
}

// An instruction is one line by construction, and this is where that becomes
// true. `sanitize.ts` admits `0x0a`, so a multi-line text is recordable, and
// every surface that renders one flattens it — the listing and the render
// through `oneLine`, while `--json` hands the caller the breaks the render
// hid. Refused here, the way `skill.ts` refuses a multi-line `--command`, so
// no surface has to decide what a second line meant. Trimmed first, as
// `skill.ts`'s `requireLine` trims, so padding and a trailing newline record
// clean rather than carrying whitespace nobody meant.
//
// The refusal covers every control character `oneLine` collapses, not just
// `\n`/`\r`: a tab or another control byte breaks the same flatten-to-one-line
// promise, and refusing it here is what keeps this wording accurate for
// whatever a caller typed.
//
// The first 40 characters are quoted back flattened: the refusal names the
// record the caller meant without printing the break it is about.
function requireOneLine(text: string): string
{
    const trimmed = text.trim();
    if (/[\x00-\x1f\x7f]/.test(trimmed))
    {
        throw new CliError(`an instruction is one line — "${oneLine(trimmed).slice(0, 40)}…" holds a line break;`
            + " record each step as its own --kind procedure instruction, ordered by --priority");
    }
    return trimmed;
}

// One section, from one flag. Two `--kind`s state two sections for one record,
// which is not a narrower ask, so it is refused rather than resolved to
// whichever the parser read last.
function requireOneKind(stated: string[] | undefined): InstructionKind
{
    if ((stated ?? []).length > 1)
    {
        throw new CliError("--kind states the one section this instruction renders under, and was passed twice"
            + " — pass rule, tool, or procedure once");
    }
    return requireKind(required((stated ?? [])[0]));
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
    const models = workspaceModels(ctx.storeDir, ctx.project);
    const sections = instructionSections(renderedIn(models, ctx.project));
    const entries = sections.flatMap((section) => section.entries);
    // The share is what the cap holds, so the empty wording answers to the cap
    // and not to the render: a store whose instructions are all demoted has a
    // manual and is told its size, and only a store holding none at all is
    // told to record one (§D-6). A store the cap holds something for but whose
    // sections are all empty is every charged instruction demoted out of the
    // render, and gets a line of its own beside the share so a reader does not
    // read the bare number as "nothing is recorded".
    const shares = shareLines(ctx, models);
    const rows = shares.length === 0
        ? [EMPTY_LISTING]
        : sections.length === 0 ? [...shares, ALL_DEMOTED_NOTE] : [...listRows(sections), ...shares];
    return [{ kind: "listing", rows, total: entries.length, noun: "instruction" }];
}

const ALL_DEMOTED_NOTE = "every instruction is demoted — self context carries them as index lines;"
    + " instruction render prints none";

function listRows(sections: InstructionSection[]): string[]
{
    // Guarded rather than left to `instructionList`'s branch alone: an empty
    // `sections` here means every entry list is empty too, and `Math.max` of
    // no widths is `-Infinity`, not a usable one.
    if (sections.length === 0)
    {
        return [];
    }
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

// One line per occupied render target (§D-6). A `--workspace` instruction
// charges the workspace instruction cap and a project-scoped one charges this
// project's, so adding them together would produce a number neither cap
// governs.
//
// The estimate note closes the last line and no other: it is one statement
// about where every number on the page came from, and saying it once per tier
// would print the same sentence twice for a store holding both.
function shareLines(ctx: ProjectContext, models: ProjectModel[]): string[]
{
    const config = readStoreConfig(ctx.storeDir);
    const scale = tokenScale(config);
    const cap = retentionCaps(config).instruction;
    const shares = [ctx.project, "workspace"]
        .map((target) => ({ target, held: chargedAt(models, target) }))
        .filter((group) => group.held.length > 0)
        .map((group) => shareLine(scopeLabel(group.target, ctx.project), group.held, cap, scale));
    return shares.map((share, at) => at === shares.length - 1 ? share + estimateNote(scale) : share);
}

// What one instruction cap holds, through `chargesInstructionCap` — the same
// predicate `state.ts` sums the cap itself with, so the share and the number a
// cap refusal states can never be two answers about one store. Counted off the
// records rather than off the rows above it: a demoted instruction prints no
// row and is still in the manual the cap bounds (§D-6).
function chargedAt(models: ProjectModel[], target: string): EntityState[]
{
    return models.flatMap((model) => model.entities
        .filter((item) => chargesInstructionCap(item, model.slug, target)));
}

// What the line counts is the instructions and nothing else (§D-6) — which is
// also, since #446, exactly what the cap it is a share of counts, so the two
// numbers answer one question. The line still names its subject rather than
// leaving a reader to read it in: what the full tier beside it holds is a
// different figure, and its own cap refusal is where that one is stated.
//
// The line prints wherever the cap holds anything, at whatever exposure, so a
// store whose instructions are all demoted still reads its manual's size; only
// the instructions charging a cap this project stands in are counted — its own
// and the workspace's — never every instruction the store holds.
function shareLine(scope: string, held: EntityState[], cap: number, scale: TokenScale): string
{
    const tokens = tokensOf(held.reduce((sum, entry) => sum + entityCharacters(entry), 0), scale.perCharacter);
    return `instructions hold ${tokens} tokens — ${tokens} of the ${cap}-token ${scope} instruction cap`
        + ` (${Math.round((tokens / cap) * 100)}%)`;
}

/* ── the render itself ─────────────────────────────────────────────── */

function instructionRender({ values }: CommandInput<typeof RENDER_OPTIONS>): CommandOutput
{
    const scope = readScopes(process.cwd(), values)[0];
    const rendered = renderedIn(workspaceModels(scope.storeDir, scope.project), scope.project);
    return [{
        kind: "payload",
        data: { project: scope.project, sections: instructionSections(rendered).map(sectionPayload) },
        plain: () => instructionLines(rendered)
    }];
}

// The machine shape, section for section and entry for entry with the render
// above it (§D-11): the two are built from one ordering, so a caller reading
// the payload and a session reading the text can never be handed two answers.
// `text` is flattened through `oneLine`, the same transform the render
// applies, so the string this emits and the line the render prints are the
// same string for every record — including one a raw `state add` minted,
// which `requireOneLine` never saw.
//
// `priority` and `why` are present only when the record carries them: an
// absent optional field is omitted, the way `login.ts` omits `console_base`,
// rather than written as `null` for the caller's reader to branch on.
function sectionPayload(section: InstructionSection): JsonValue
{
    return {
        kind: section.kind,
        heading: section.heading,
        entries: section.entries.map((entry) => ({
            id: entry.id,
            text: oneLine(entry.text),
            ...(entry.priority === undefined ? {} : { priority: entry.priority }),
            scope: entry.scope,
            ...(entry.why === undefined ? {} : { why: entry.why })
        }))
    };
}
