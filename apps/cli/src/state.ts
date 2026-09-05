// The raw verb of the state engine (#197 §7): record, confirm, retract and
// read entities without a preset. The preset record kinds — goal, decision,
// convention, objective, milestone — keep their own verbs and vocabulary;
// this surface is the extensibility promise: user-defined labels over the
// same record kind, folded by `@superself/fold` `entities.ts` into one view.

import {
    criteriaRefusal,
    CRITERION_BLOCKED,
    CRITERION_DECLARED,
    CRITERION_UNBLOCKED,
    CriterionState,
    DecisionState,
    DEMOTION_TARGET,
    entityCharacters,
    EntityLink,
    EntitySource,
    EntityState,
    executionSummary,
    Exposure,
    EXPOSURES,
    HOME_SCOPE,
    isCurrent,
    isDemotion,
    isLive,
    LINK_TYPES,
    LinkType,
    occupiesTier,
    orderEntities,
    pendingSummary,
    PERSON_OWNER,
    rendersIn,
    requireSupersedeKind,
    scopeTarget,
    tierCharacters
} from "@superself/fold";
import { required, requireText, Requirement } from "./args.js";
import { resolveArtifactRef } from "./artifact.js";
import { branch, Command, CommandInput, leaf } from "./contract.js";
import { validDate } from "./dates.js";
import { bareRevisionRefusal, requireRevision } from "./gitutil.js";
import { writtenBy } from "./human.js";
import { entityId, wrongKindHint } from "./ids.js";
import {
    chargesInstructionCap,
    instructionCharacters,
    instructionTierCharacters,
    isInstruction,
    labelsAreInstruction
} from "./instructions.js";
import { claimMoves, claimNote, noteSessionSeen } from "./ledger.js";
import { sessionToken } from "./machine.js";
import { buildModel, ProjectModel, projectsHolding, workspaceModels } from "./model.js";
import { RUNBOOK_LABEL, RUNBOOK_RUN_LABEL } from "./runbooks.js";
import {
    ProjectContext,
    ProjectScope,
    projectScope,
    readRegistry,
    readScopes,
    readStoreConfig,
    refuseArchived,
    requireProject,
    requireWorkspace,
    retentionCaps,
    RetentionCaps,
    SCOPE_OPTIONS,
    tokenScale,
    TokenScale
} from "./paths.js";
import { notice } from "./output.js";
import { makeEvent, recordEvent, recordEvents } from "./pipeline.js";
import { recordRetirement, retiring, retirementIntent, supersedeTargets, supersedingRecord } from "./retirement.js";
import { tokensOf } from "./style.js";
import { CliError, CommandOutput, EventRefs, SelfEvent } from "./types.js";
import { historyOutput } from "./views.js";

const STATE_USAGE = 'usage: self state add "<text>" | show <id> | list | place <id> | confirm <id> | retract <id> --why w'
    + ' | cover <id> --criterion c --why w | start <id> | block <id> | unblock <id> | done <id> --report r | retire <id> --why w';
const ADD_USAGE = 'state add "<text>" [--label l] [--priority n] [--exposure full|index|search] [--scope <slug>|workspace] '
    + "[--target YYYY-MM-DD] [--criteria c] [--artifact <id|path>] [--supersedes <id>] [--link [type:]<id>] [--why w] "
    + "[--proposed] [--demote <id>]";
const PLACE_USAGE = "state place <id> [--priority <n>] [--exposure full|index|search] [--scope <slug>|workspace] "
    + '[--why "<reason>"] [--proposed] [--demote <id>]';
const RETRACT_USAGE = 'state retract <id> --why "<why it no longer holds>"';
const COVER_USAGE = 'state cover <id> --criterion "<c>" --why "<how the evidence covers it>" [--evidence <commit>] [--work <id>]';

const ADD_OPTIONS = {
    label: { type: "string", multiple: true },
    priority: { type: "string" },
    exposure: { type: "string" },
    scope: { type: "string" },
    target: { type: "string" },
    criteria: { type: "string", multiple: true },
    // Taken as repeatable so a second one is refused by name (#238). A record
    // references one artifact, and a single option would let the parser keep
    // the last value and drop the first without a word.
    artifact: { type: "string", multiple: true },
    supersedes: { type: "string", multiple: true },
    link: { type: "string", multiple: true },
    why: { type: "string" },
    proposed: { type: "boolean" },
    demote: { type: "string", multiple: true }
} as const;

// The option set an alias verb's `add` parses with — exactly the raw verb's,
// so a table-resolved verb accepts what `state add` accepts (#207 A2).
export const ALIAS_ADD_OPTIONS = ADD_OPTIONS;

const PLACE_OPTIONS = {
    priority: { type: "string" },
    exposure: { type: "string" },
    scope: { type: "string" },
    why: { type: "string" },
    proposed: { type: "boolean" },
    demote: { type: "string", multiple: true }
} as const;

// The completion conditions an add verb declares (#408), repeatable and
// ordered c1..cN. `--verify` and `--owner` (#413) each name the criterion they
// speak for, because one call declares several and nothing else in either flag
// says which. Declared here rather than beside either add verb, so `work add`
// and `work propose` cannot come to accept different halves of one grammar.
export const DECLARE_OPTIONS = {
    criteria: { type: "string", multiple: true },
    verify: { type: "string", multiple: true },
    owner: { type: "string", multiple: true }
} as const;

// Exported so `work cover` parses with exactly the raw verb's option set: the
// alias is the same handler, and a second declaration would let the two
// spellings drift into two verbs (#408).
export const COVER_OPTIONS = {
    criterion: { type: "string" },
    why: { type: "string" },
    evidence: { type: "string", multiple: true },
    work: { type: "string" }
} as const;

// `show` reads for one project and, with `--history`, prints that record's own
// events (#212 R3) — the one path to history, since no global history search
// remains.
const SHOW_OPTIONS = { ...SCOPE_OPTIONS, history: { type: "boolean" }, page: { type: "string" } } as const;

const WHY_OPTION = { why: { type: "string" } } as const;

const BLOCK_OPTIONS = { on: { type: "string" }, why: { type: "string" } } as const;

const DONE_OPTIONS = { report: { type: "string" } } as const;

const RETIRE_OPTIONS = { why: { type: "string" }, successor: { type: "string" } } as const;

// What each of these verbs cannot run without, declared once for the gate that
// refuses them together and the help page that states them (#106).
const WHY_NO_LONGER_HOLDS: Requirement = { flags: ["why"], hint: "why the record no longer holds" };

const RETIRE_WHY: Requirement = { flags: ["why"], hint: "why the outcome was given up or moved" };

const DONE_REPORT: Requirement = { flags: ["report"], hint: "what verifiably happened — done must carry evidence" };

export const COVERAGE_REQUIRED: Requirement[] = [
    { flags: ["criterion"], value: "<c>", hint: "the declared criterion this claim covers" },
    { flags: ["why"], hint: "how the evidence covers it" }
];

// A bare `--` is not a listing flag: the contract's unnamed "options" form
// keeps it a subcommand mistake that `subcommand()` explains.
export const STATE_COMMAND: Command = {
    name: "state",
    usage: [
        {
            syntax: "state [--project <slug>]",
            description: [
                "list live entities — the record every stated assertion folds to",
                "(goals, decisions, conventions, objectives, milestones read as entities too)"
            ],
            verbs: ["", "list"]
        },
        {
            syntax: 'state add "<text>" [--label l] [--priority n] [--exposure full|index|search] [--scope <slug>|workspace]',
            description: ["record one raw entity; --supersedes <id> replaces an earlier one"],
            verbs: ["add"]
        },
        {
            syntax: "state show <id> [--history [--page n]] [--project <slug>]",
            description: ["print an entity's current values; --history prints its own events instead"],
            verbs: ["show"]
        },
        {
            syntax: "state place <id> [--priority <n>] [--exposure full|index|search] [--scope <slug>|workspace]",
            description: ["move an entity in context: render order, render form, the project it renders in"],
            verbs: ["place"]
        },
        { syntax: "state confirm <id>", description: ["confirm a proposed entity, or a placement waiting on you"], verbs: ["confirm"] },
        { syntax: 'state retract <id> --why "<reason>"', description: ["withdraw an entity with nothing replacing it"], verbs: ["retract"] },
        {
            syntax: 'state cover <id> --criterion "<c>" --why "<how>" [--evidence <commit>] [--work <id>]',
            description: ["record a coverage claim against a declared criterion; done is gated on full coverage"],
            verbs: ["cover"]
        },
        {
            syntax: "state start|block|unblock <id>",
            description: ["record the working state as a fact: started, blocked (--on, --why), unblocked"],
            verbs: ["start", "block", "unblock"]
        },
        {
            syntax: 'state done <id> --report "<what verifiably happened>"',
            description: ["record completion; the claim must carry evidence, and criteria gate it"],
            verbs: ["done"]
        },
        {
            syntax: 'state retire <id> --why "<reason>" [--successor <id>]',
            description: ["record the outcome as given up or moved, never reached"],
            verbs: ["retire"]
        }
    ],
    detail: [
        "the raw record of the state engine: one entity, with free labels, typed",
        "links, reserved metadata, and placement. The preset record kinds — goal,",
        "decision, convention, objective, milestone — fold into the same view, so",
        "`state list`, `state show` and `state place` answer for them too; their",
        "own verbs keep owning their lifecycle.",
        "",
        "add, place, confirm, retract, cover and the execution verbs (start, block,",
        "unblock, done, retire) write: they take no read-scope flag and record into",
        "the project they run in. list and show read for the project this directory",
        "resolves to. --scope is a placement value, not a read scope: it names the",
        "project a record renders in — this one by default, another registered one",
        "by slug, or every one of them with workspace — while its events stay in the",
        "store that already holds them. place resolves any record rendering here,",
        "so a record moved in from elsewhere can be moved on or moved back.",
        "",
        "the execution verbs record facts about doing, not assertions: no --proposed",
        "form exists on them, and each records its actor. done must carry evidence —",
        "--report states what verifiably happened — and an entity carrying criteria",
        "refuses done until every criterion carries a coverage claim (`state cover`).",
        "",
        "a demotion — exposure moving toward less-rendered (full → index → search) —",
        "always records --why; a priority change alone is not one. Demotion out of",
        "full is human-owned: an agent passes --proposed, and the move waits until",
        "a person runs `state confirm <id>`.",
        "",
        "retention caps (config.json fullTokens and indexTokens; defaults 1,000 and",
        "12,000 context tokens, per scope) gate add and place into a tier: past a",
        "cap the verb refuses until --demote names what frees the room, and every",
        "number in that refusal is a token count. An agent adds --proposed to land",
        "the add and the demotion as a pair that waits on a person; rendering itself",
        "never refuses. `self tokens` records what a character costs.",
        "",
        "history is per record and explicit: `state show <id> --history` prints the",
        "events of that record alone, oldest first, ten to a page. A superseded,",
        "retracted or retired record answers there too — nothing is made unreachable,",
        "and a superseded record names its successor rather than folding it in.",
        "",
        "  --history             print this record's own events instead of its values",
        "  --page <n>            which page of that history, ten events to a page",
        "  --label <text>        free label, repeatable; presets use goal, objective, convention, …",
        "  --priority <n>        render order: a whole number, 0 first; leave gaps (0, 10, 20)",
        "  --exposure <form>     how context renders it: full, index, or search",
        "  --scope <where>       where the record renders: omit for this project, another",
        "                        registered project's slug, or workspace (every project's",
        "                        context); caps count per destination",
        "  --target <date>       a YYYY-MM-DD deadline for the derived views to judge",
        "  --criteria <text>     an exit criterion that gates done claims, repeatable",
        "  --artifact <id|path>  a registered artifact this record points at: an `a-` id this",
        "                        project stores, or a path registered now. One per record; the",
        "                        pointer counts against the cap and the document does not",
        "  --criterion <c>       the declared criterion a coverage claim answers — its text, or cN",
        "  --evidence <commit>   a commit recorded with the coverage claim, repeatable",
        "  --work <id>           the work unit whose evidence covers the criterion",
        "  --supersedes <id>     the entity this one replaces, repeatable — the correction path",
        "                        every add verb spells the same way; --link supersedes:<id> records",
        "                        the same edge, and naming one target both ways records it once",
        "  --link [type:]<id>    typed edge, repeatable: --link supersedes:<id> replaces an",
        "                        earlier entity, member-of:<id> groups, relates:<id> (a bare id) refers",
        "  --why <text>          rationale recorded with the entity, its placement, its retraction,",
        "                        a coverage claim, a block, or a retirement",
        "  --on <what>           what a blocked entity waits on, free text",
        "  --report <text>       what verifiably happened — the evidence a done claim must carry",
        "  --successor <id>      the entity that carries a retired outcome now",
        "  --proposed            record as a proposal; `state confirm` makes it hold",
        "  --demote <id>         past a retention cap: the confirmed entity that frees its place by",
        "                        moving one tier down (full → index, index → search); repeatable",
        "  --project <slug>      read this registered project instead of this directory's"
    ],
    node: branch({
        name: "state",
        unnamed: "options",
        refusal: STATE_USAGE,
        children: [
            leaf("", SCOPE_OPTIONS, 0, stateList),
            leaf("list", SCOPE_OPTIONS, 0, stateList),
            retiring(leaf("add", ADD_OPTIONS, 1, stateAdd)),
            leaf("show", SHOW_OPTIONS, 1, stateShow),
            leaf("place", PLACE_OPTIONS, 1, statePlace),
            leaf("confirm", {}, 1, stateConfirm),
            retiring(leaf("retract", WHY_OPTION, 1, stateRetract, { requires: [WHY_NO_LONGER_HOLDS] })),
            leaf("cover", COVER_OPTIONS, 1, coverRecord, { requires: COVERAGE_REQUIRED }),
            leaf("start", {}, 1, stateStart),
            leaf("block", BLOCK_OPTIONS, 1, stateBlock),
            leaf("unblock", {}, 1, stateUnblock),
            leaf("done", DONE_OPTIONS, 1, stateDone, { requires: [DONE_REPORT] }),
            retiring(leaf("retire", RETIRE_OPTIONS, 1, stateExecRetire, { requires: [RETIRE_WHY] }))
        ]
    })
};

/* ── the write verbs ───────────────────────────────────────────────── */

// The label an alias verb records, and the placement it defaults to — the
// merged alias-table row, declared structurally so this module never imports
// the table that reads it back through `aliasEntityAdd`.
interface AliasDefaults
{
    label: string;
    priority?: number;
    exposure: Exposure;
}

function stateAdd({ values, positionals }: CommandInput<typeof ADD_OPTIONS>): CommandOutput
{
    return entityAdd(values, positionals, undefined);
}

// The add path a table-resolved verb runs (#207 A2): the row supplies the
// label and the default placement, explicit flags beat it (A8), and
// everything else — caps, links, criteria, proposals — is the raw verb's.
export function aliasEntityAdd(row: AliasDefaults, { values, positionals }: CommandInput<typeof ADD_OPTIONS>): CommandOutput
{
    return entityAdd(values, positionals, row);
}

// What a verb that composes its own record still hands the raw add path: the
// reason it carries, the record it corrects, and the demotion a full tier
// demands. Everything else about such a record — its text, its label, its
// placement, its reserved metadata — is the verb's own statement.
interface ComposedValues
{
    why?: string;
    supersedes?: string[];
    demote?: string[];
    // Where the composed record renders, in the raw verb's own spelling: a
    // registered project's slug, or `workspace`. Handed over rather than
    // written into the reserved payload, so the retention cap is charged
    // against the tier the record is actually born into (#391).
    scope?: string;
    // The artifact the composed record points at — an `a-` id this project
    // stores, or a path registered now. Taken here rather than resolved by the
    // caller so a `--file` skill's pointer is charged to the cap by the one
    // site that already counts it, and the registration keeps its place: after
    // every other refusal, before the record's own event (#238).
    artifact?: string[];
    // The order the composed record takes inside its tier. `addOptionalFields`
    // already prefers a stated priority over the row's; without this field a
    // composed add could only fall back to its `AliasDefaults` row constant,
    // and `instruction add --priority` would silently record 50 (#440).
    priority?: string;
    // Whether the composed record is proposed rather than asserted. A verb
    // that replaces a standing record on a person's say-so — `runbook revise`
    // (#171) — records the successor as a proposal so nothing is displaced
    // until the confirm, which is the same propose/confirm timing the raw add
    // already has rather than a second one.
    proposed?: boolean;
}

// The add path a verb runs when it composes the record itself (#75): the
// caller states the label, the placement and the reserved metadata, and the
// caps, the supersession and the retirement gate stay where they already are.
// A second add path would be a second answer to what a tier holds.
export function composedEntityAdd(row: AliasDefaults, reserved: Record<string, unknown>,
    values: ComposedValues, text: string): CommandOutput
{
    return entityAdd(values, [text], row, reserved);
}

function entityAdd(values: CommandInput<typeof ADD_OPTIONS>["values"], positionals: string[],
    row: AliasDefaults | undefined, reserved: Record<string, unknown> = {}): CommandOutput
{
    const ctx = requireProject(process.cwd());
    const usageText = row === undefined ? ADD_USAGE : `${row.label} add "<text>"`;
    const text = requireText(positionals[0], usageText);
    const models = workspaceModels(ctx.storeDir, ctx.project);
    const exposure = values.exposure !== undefined ? validExposure(values.exposure) : row?.exposure ?? "index";
    const target = values.scope === undefined ? ctx.project : validScope(ctx, values.scope);
    const id = entityId();
    // Resolved before the record's own event, but before the cap gate below
    // it too: a path registers here whichever way that gate answers, so a
    // refusal past the instruction cap can still leave an artifact nothing
    // points at (#238) — the "does not cover" list says why nothing closes it.
    const artifact = resolveArtifactRef(ctx, values.artifact);
    const payload = { ...addPayload(models[0], id, text, exposure, writtenScope(target, ctx.project), values, row),
        ...(artifact === undefined ? {} : { artifact }), ...reserved };
    // Read back off the composed payload, where `reserved` has already spread
    // last, so the cap judged is the one the record the log will hold charges
    // (#446 §D-14): the label is the mechanism, so the raw verb follows it.
    const entered = chargedCap(labelsAreInstruction(payloadLabels(payload)), target, exposure);
    const demotions = admittingDemotions(ctx, models, values, entered,
        usageText, entityCharacters({ text, artifact }), supersedeTargets(payload));
    recordAdd(ctx, models, { id, text, payload }, demotions, values.proposed === true);
    return [{ kind: "receipt", text: id }];
}

// The write itself, once the cap has admitted it. A proposal displaces
// nothing: its supersedes links wait for the confirm that makes them real, so
// the gate belongs there rather than here.
function recordAdd(ctx: ProjectContext, models: ProjectModel[],
    record: { id: string; text: string; payload: Record<string, unknown> },
    demotions: Placed[], proposed: boolean): void
{
    const payload = record.payload;
    const displaced = proposed ? [] : supersedeTargets(payload);
    recordRetirement(ctx, retirementIntent(models[0], "supersede", displaced,
        { successor: supersedingRecord(payload) }), models[0],
        (by) => [
            makeEvent(ctx.project, proposed ? "entity.proposed" : "entity.confirmed",
                { ...payload, by }, undefined, !proposed),
            ...demotionEvents(demotions, record.id, proposed)
        ],
        `${record.id} ${record.text}`);
}

// The labels a composed payload will be written with, read back where the cap
// has to be judged before the record exists — the same read-back
// `payloadArtifact` (`entities.ts`) does for a reference.
function payloadLabels(payload: Record<string, unknown>): string[]
{
    return Array.isArray(payload.labels) ? payload.labels.filter((label) => typeof label === "string") : [];
}

// What the cap gate reads off a verb's arguments: the demotions it names, and
// whether the record is proposed rather than held.
export interface CapGateValues
{
    demote?: string[];
    proposed?: boolean;
}

// The cap gate an add passes: what the destination tier holds, what this text
// adds to it, what the named demotions free there, and what the write itself
// vacates — all read against the tier the record is being born into, wherever
// that project's log sits. One implementation, called by `state add`, the
// alias adds and every preset add alike (#240 R1).
export function admittingDemotions(ctx: ProjectContext, models: ProjectModel[], values: CapGateValues,
    entered: CappedTier | undefined, usageText: string, adding: number, displaced: string[]): Placed[]
{
    const config = readStoreConfig(ctx.storeDir);
    const caps = retentionCaps(config);
    const scale = tokenScale(config);
    const usage = usageReader(models, scale);
    const records = allRecords(models);
    const demotions = demotionsFor(records, values.demote ?? [], entered, undefined, usageText, ctx.project);
    const vacates = vacatedTokens(records, displaced, entered, scale);
    requireRoom(usage, caps, entered, adding, demotions, scale, ctx.project, vacates, values.proposed === true);
    requireDemotionRoom(usage, caps, entered?.target ?? ctx.project, demotions, 0, scale, ctx.project);
    return demotions;
}

// The room the write itself frees in the tier it enters: a predecessor named
// by --supersedes leaves that tier in the same append, so the cap judges the
// net effect rather than refusing an exact swap (#240 T5.1). A predecessor
// holding a seat in another tier or scope frees nothing here (T5.3).
function vacatedTokens(records: Placed[], displaced: string[], entered: CappedTier | undefined, scale: TokenScale): number
{
    if (entered === undefined || displaced.length === 0)
    {
        return 0;
    }
    const leaving = records.filter((item) => displaced.includes(item.entity.id)
        && holdsSeat(item.entity, item.owner, entered));
    return tokensOf(leaving.reduce((sum, item) => sum + entityCharacters(item.entity), 0), scale.perCharacter);
}

function addPayload(
    model: ProjectModel,
    id: string,
    text: string,
    exposure: Exposure,
    scope: string,
    values: CommandInput<typeof ADD_OPTIONS>["values"],
    row: AliasDefaults | undefined
): Record<string, unknown>
{
    const extra = (values.label ?? []).map((label) => validText(label, "--label", "the label's text"));
    const labels = row === undefined ? extra : [row.label, ...extra.filter((label) => label !== row.label)];
    const payload: Record<string, unknown> = {
        entity: id,
        text,
        labels,
        links: supersedeLinks(model, values.link ?? [], values.supersedes ?? []),
        // Through the shared declaration grammar since #408, so the raw path
        // cannot mint a record whose criteria nothing can address: two with one
        // text fold to one criterion, and a record declaring both would be
        // gated forever on a `cN` that resolves to the other.
        ...declarationOf(values, "state add"),
        exposure,
        scope
    };
    addOptionalFields(payload, values, row);
    return payload;
}

// Fields the record carries only when the call named them, or the alias row
// carries a default worth writing down.
function addOptionalFields(payload: Record<string, unknown>,
    values: CommandInput<typeof ADD_OPTIONS>["values"], row: AliasDefaults | undefined): void
{
    const priority = values.priority !== undefined ? validPriority(values.priority) : row?.priority;
    if (priority !== undefined)
    {
        payload.priority = priority;
    }
    if (values.target !== undefined)
    {
        payload.target = validDate(values.target);
    }
    if (values.why !== undefined)
    {
        payload.why = values.why;
    }
}

/* ── the placement move (#181) ─────────────────────────────────────── */

// One record and the log that owns it. A record scoped in from another project
// resolves here and its writes land in its home log (#181 D3), so every
// placement carries the owner it was found under rather than assuming the
// project the command ran in.
export interface Placed
{
    entity: EntityState;
    owner: string;
    model: ProjectModel;
}

function allRecords(models: ProjectModel[]): Placed[]
{
    return models.flatMap((model) => model.entities.map((entity) => ({ entity, owner: model.slug, model })));
}

// What answers to an id here: this project's own records whatever scope they
// now render in — the home log always answers for its own record — plus every
// record another project's log scoped in here (#181 D5). Without the second
// half a move would be one-way.
function resolvableRecords(records: Placed[], here: string): Placed[]
{
    return records.filter((item) => item.owner === here || rendersIn(item.entity, item.owner, here));
}

// What a placement asks for, resolved against the record it names: the values
// to write, and the capped tier the move enters.
interface Placement
{
    priority?: number;
    exposure?: Exposure;
    target?: string;
    why?: string;
    entered?: CappedTier;
}

function statePlace({ values, positionals }: CommandInput<typeof PLACE_OPTIONS>): void
{
    const ctx = requireProject(process.cwd());
    // One fold of every registered project, read three ways: to resolve the id,
    // to count the tier it enters, and to name the record that frees a seat.
    const models = workspaceModels(ctx.storeDir, ctx.project);
    const records = allRecords(models);
    const found = requirePlaceable(resolvableRecords(records, ctx.project), positionals[0]);
    const move = requestedPlacement(ctx, found, values);
    const config = readStoreConfig(ctx.storeDir);
    const caps = retentionCaps(config);
    const scale = tokenScale(config);
    const usage = usageReader(models, scale);
    const demotions = demotionsFor(records, values.demote ?? [], move.entered, found.entity.id, PLACE_USAGE, ctx.project);
    // A proposal holds no seat in the tier it names until it is confirmed, and
    // the confirm is where the cap judges it — the same rule `state add
    // --proposed` passes under (#240 R3).
    requireRoom(usage, caps, move.entered, entityCharacters(found.entity), demotions, scale, ctx.project, 0,
        found.entity.status === "proposed");
    const from = scopeTarget(found.entity, found.owner);
    requireDemotionRoom(usage, caps, move.entered?.target ?? from, demotions, vacatedSeat(found, move.entered), scale, ctx.project);
    const proposed = values.proposed === true;
    recordEvents(ctx, [
        makeEvent(found.owner, "entity.placed", { ...placePayload(found, move, proposed), by: writtenBy() }, undefined, !proposed),
        ...demotionEvents(demotions, found.entity.id, proposed)
    ], `${found.entity.id} ${found.entity.text}`);
}

function requestedPlacement(ctx: ProjectContext, found: Placed, values: CommandInput<typeof PLACE_OPTIONS>["values"]): Placement
{
    const priority = values.priority === undefined ? undefined : validPriority(values.priority);
    const exposure = values.exposure === undefined ? undefined : validExposure(values.exposure);
    const target = values.scope === undefined ? undefined : validScope(ctx, values.scope);
    requirePlacementChange(found, priority, exposure, target);
    refuseDemotedProposal(found.entity, exposure);
    return {
        priority,
        exposure,
        target,
        // A cross-project move is not a demotion: only exposure moving toward
        // less-rendered demands a reason, so a move records --why when the
        // caller offers one and nothing when it does not (#181 T2.17).
        why: requireDemotionWhy(found.entity, exposure, values.why),
        entered: enteredTier(found, exposure, target)
    };
}

// The room the placed record itself frees when it leaves the tier it is
// entering — index for full at the same target — so a swap at an exactly-full
// cap still passes.
function vacatedSeat(found: Placed, entered: CappedTier | undefined): number
{
    return entered !== undefined && scopeTarget(found.entity, found.owner) === entered.target
        && found.entity.exposure === "index" ? entityCharacters(found.entity) : 0;
}

// The scope as the owning log records it: the home sentinel when the record
// renders in the project that holds it, and the absolute name otherwise. The
// fold reads the sentinel against its own slug, so a log stays readable
// without knowing which project it was written from.
function writtenScope(target: string, owner: string): string
{
    return target === owner ? HOME_SCOPE : target;
}

function placePayload(found: Placed, move: Placement, proposed: boolean): Record<string, unknown>
{
    const payload: Record<string, unknown> = { entity: found.entity.id };
    if (move.priority !== undefined)
    {
        payload.priority = move.priority;
    }
    if (move.exposure !== undefined)
    {
        payload.exposure = move.exposure;
    }
    if (move.target !== undefined)
    {
        payload.scope = writtenScope(move.target, found.owner);
    }
    if (move.why !== undefined)
    {
        payload.why = move.why;
    }
    if (proposed)
    {
        payload.proposed = true;
    }
    return payload;
}

// Placement moves live records: a withdrawn or replaced one no longer renders
// at all, so it has no placement left to change.
//
// A proposal does move (#400). It renders nowhere yet, so widening its scope or
// raising its priority hides nothing from anybody and settles where the record
// lands the moment it is confirmed. What it cannot do is demote its own
// exposure, which is refused below by the move rather than by the status.
function requirePlaceable(records: Placed[], value: string | undefined): Placed
{
    const found = requirePlaced(records, value, PLACE_USAGE);
    const entity = found.entity;
    if (entity.status === "retracted")
    {
        throw new CliError(`${entity.id} was retracted — a withdrawn record no longer renders, so it has no placement to change`);
    }
    if (entity.status === "superseded")
    {
        throw new CliError(`${entity.id} was superseded by ${entity.supersededBy ?? "a later record"} — place the successor instead`);
    }
    return found;
}

function requirePlacementChange(found: Placed, priority: number | undefined, exposure: Exposure | undefined, target: string | undefined): void
{
    const entity = found.entity;
    if (priority === undefined && exposure === undefined && target === undefined)
    {
        throw new CliError("state place changes placement — pass --priority <n>, --exposure full|index|search, --scope <slug>|workspace, or several");
    }
    if ((exposure === undefined || exposure === entity.exposure)
        && (priority === undefined || priority === entity.priority)
        && (target === undefined || target === scopeTarget(entity, found.owner)))
    {
        throw new CliError(`${entity.id} already sits at that placement — nothing changes`);
    }
}

// The one move a proposal cannot make (#400). Every other placement value on a
// proposal states where it will land once confirmed, and nothing is hidden by
// stating it. A demotion is the exception in the other direction: a proposal
// renders nowhere to be demoted *from*, so the move asserts a loss that never
// happened, and the record it would describe reads as one that used to render.
function refuseDemotedProposal(entity: EntityState, exposure: Exposure | undefined): void
{
    if (entity.status !== "proposed" || exposure === undefined || !isDemotion(entity.exposure, exposure))
    {
        return;
    }
    throw new CliError(`${entity.id} is still proposed, so it renders nowhere to be demoted from — `
        + `confirm it with \`self state confirm ${entity.id}\` and demote it then, or propose it at ${exposure} instead`);
}

// --why is demanded exactly where a record leaves rendered ground: exposure
// moving toward less-rendered. A promotion or a priority move carries --why
// only if the caller offers one.
function requireDemotionWhy(entity: EntityState, exposure: Exposure | undefined, why: string | undefined): string | undefined
{
    if (exposure === undefined || !isDemotion(entity.exposure, exposure))
    {
        return why;
    }
    if (why === undefined || why.trim() === "")
    {
        throw new CliError(`demoting ${entity.id} from ${entity.exposure} to ${exposure} needs --why "<reason>" — a record leaves the rendered set only with its reason on record`);
    }
    return why;
}

/* ── the retention caps (#197 §4, #207 D) ──────────────────────────── */

// One capped tier: an exposure at a render target. Caps count per target
// (#207 D4, #181 D4) — every project's tiers and the workspace tier fill and
// gate independently — and search is unbounded by design at any target: it
// renders nothing, so an add into it, and any move toward it, passes without
// gating. That open floor is what keeps a store past its caps from ever
// wedging: a chain of demotions always terminates at search.
//
// `instruction` is the third cap and not a tier at all (#446 §D-14): it is
// charged by exposure-blind occupancy, so nothing demotes into or out of it,
// and it stands here only because every cap is read, compared and refused
// through one path.
type CapKind = "full" | "index" | "instruction";

interface CappedTier
{
    target: string;
    tier: CapKind;
}

export function tierOf(target: string, exposure: Exposure): CappedTier | undefined
{
    return exposure === "search" ? undefined : { target, tier: exposure };
}

// The cap a record charges at a target: its own if it is an instruction, at any
// exposure, and the retention tier of its exposure otherwise.
function chargedCap(instruction: boolean, target: string, exposure: Exposure): CappedTier | undefined
{
    return instruction ? { target, tier: "instruction" } : tierOf(target, exposure);
}

function capOf(caps: RetentionCaps, tier: CapKind): number
{
    return { full: caps.full, index: caps.index, instruction: caps.instruction }[tier];
}

// Whether a record holds a seat in one cap — the fold's own answer for a
// retention tier, and the exposure-blind one for the instruction cap. The
// tier branch subtracts the instructions for the same reason `heldCharacters`
// does (#446 §D-14): the fold still counts a full-exposure instruction into
// the full tier, and a record the tier's own usage never charges cannot be
// credited to it either — a `--supersedes` or `--demote` target that freed
// room nothing was paying for would admit a write the cap should refuse.
function holdsSeat(entity: EntityState, owner: string, at: CappedTier): boolean
{
    return at.tier === "instruction"
        ? chargesInstructionCap(entity, owner, at.target)
        : occupiesTier(entity, owner, at.target, at.tier) && !isInstruction(entity);
}

// How a tier reads to the caller: the project it ran in is "project", exactly
// as it always was, and any other destination is named by its slug so a
// refusal says where the room ran out (#181 T5.2). Exported because a tier is
// named on more than one surface: `instruction list` closes with a share of
// the tier its records occupy, and a listing that spelled the same tier a
// second way would be two vocabularies for one number.
export function scopeLabel(target: string, here: string): string
{
    return target === here ? "project" : target;
}

// Which capped tier a placement moves its record into. Direction does not
// matter: a full → index demotion enters index exactly as a promotion does
// and can overfill it the same way, and a scope change enters the destination
// project's tier at the record's exposure. Any move whose destination pair is
// the one the record already holds — or whose destination is search — enters
// nothing.
function enteredTier(found: Placed, exposure: Exposure | undefined, target: string | undefined): CappedTier | undefined
{
    // A placement of an instruction enters nothing (#446 §D-16): no retention
    // tier holds it at any exposure, and the instruction cap counts it whatever
    // its exposure, so no move `state place` can spell changes what a cap sees.
    // A `--scope` move does change which target's manual holds it, and is
    // admitted anyway — the table's "does not cover" list says why.
    if (isInstruction(found.entity))
    {
        return undefined;
    }
    const from = scopeTarget(found.entity, found.owner);
    const to = target ?? from;
    const toExposure = exposure ?? found.entity.exposure;
    if (toExposure === "search" || (to === from && toExposure === found.entity.exposure))
    {
        return undefined;
    }
    return { target: to, tier: toExposure };
}

// What a cap currently holds, in tokens. A cap belongs to the project a record
// renders in rather than to the store that holds it (#181 D1), so every one —
// a project's and the workspace's alike — is counted across every registered
// store, and only the count travels. Characters are summed across stores and
// converted once, so the answer never drifts by a rounding per store. Memoized
// per invocation: the folds behind it are not free.
type UsageReader = (target: string, tier: CapKind) => number;

function usageReader(models: ProjectModel[], scale: TokenScale): UsageReader
{
    const cache = new Map<string, number>();
    return (target, tier) =>
    {
        const key = `${target} ${tier}`;
        const found = cache.get(key);
        if (found !== undefined)
        {
            return found;
        }
        const total = tokensOf(models.reduce((sum, model) => sum + heldCharacters(model, target, tier), 0),
            scale.perCharacter);
        cache.set(key, total);
        return total;
    };
}

// The fold counts every full-exposure record into a retention tier, including
// the instructions, and #446 changes no fold — so the subtraction is here,
// where the cap is read. What a tier holds is what it holds minus the
// instructions sitting in it; what the instruction cap holds is those records
// at every exposure, at the target they render in.
function heldCharacters(model: ProjectModel, target: string, tier: CapKind): number
{
    if (tier === "instruction")
    {
        return instructionCharacters(model.entities, model.slug, target);
    }
    return tierCharacters(model.entities, model.slug, target, tier)
        - instructionTierCharacters(model.entities, model.slug, target, tier);
}

// Every cap is measured the same way now (#213, #446), so one check answers
// for all three: what the cap holds in tokens, what this text adds, and what
// the named demotions free. `vacates` is what the write itself frees there, and
// `proposed` marks a record that holds no seat until a person confirms it.
function requireRoom(usage: UsageReader, caps: RetentionCaps, entered: CappedTier | undefined,
    adding: number, demotions: Placed[], scale: TokenScale, here: string, vacates: number, proposed: boolean): void
{
    if (entered === undefined)
    {
        return;
    }
    requireTokenRoom(usage, entered, capOf(caps, entered.tier), tokensOf(adding, scale.perCharacter),
        demotions, scale, here, vacates, proposed);
}

// One refusal hands the whole contract: the cap, what the tier holds, what
// this adds, and the exact command shape that names a demotion. Every number
// is in tokens, and an unmeasured scale says so — a caller choosing what to
// demote is owed a real number rather than a row count (#213).
function requireTokenRoom(usage: UsageReader, entered: CappedTier, cap: number,
    adding: number, demotions: Placed[], scale: TokenScale, here: string, vacates: number, proposed: boolean): void
{
    // Held once the write's own supersession displacement lands (#240 T5.1).
    const held = usage(entered.target, entered.tier) - vacates;
    if (held + adding <= cap)
    {
        requireDemotionsNeeded(demotions, entered, here);
        return;
    }
    // Propose passes, confirm gates (#240 R3): a proposal takes its seat only
    // at the confirm, where requireUnitRoom judges the room.
    if (proposed)
    {
        return;
    }
    const tier = entered.tier;
    if (tier === "instruction")
    {
        throw new CliError(instructionCapRefusal(entered.target, held, cap, adding, scale, here));
    }
    if (demotions.length === 0)
    {
        throw new CliError(`the ${scopeLabel(entered.target, here)} ${tier} tier holds ${held} of ${cap} tokens `
            + `and this text adds ${adding} more${estimateNote(scale)} — name what demotes: pass `
            + `\`--demote <id>\` (that ${tier} entity moves to ${DEMOTION_TARGET[tier]}), or demote `
            + `first with \`self state place <id> --exposure ${DEMOTION_TARGET[tier]} --why "<reason>"\``);
    }
    requireDemotionsEnough(demotions, entered, cap, held + adding, scale);
}

// The named demotions were the caller's answer to the refusal above, so what
// they still owe is stated as one number rather than as the whole contract a
// second time. `wanted` is what the tier would hold with this text in it.
function requireDemotionsEnough(demotions: Placed[], entered: CappedTier, cap: number,
    wanted: number, scale: TokenScale): void
{
    // Through `holdsSeat`, never the raw characters: what a demotion frees is
    // what the tier was charging for it, and the tier charges nothing for an
    // instruction (#446 §D-14).
    const leaving = demotions.filter((item) => holdsSeat(item.entity, item.owner, entered));
    const freed = tokensOf(leaving.reduce((sum, item) => sum + entityCharacters(item.entity), 0), scale.perCharacter);
    const tier = entered.tier;
    if (wanted - freed > cap)
    {
        throw new CliError(`still ${wanted - freed - cap} tokens over the ${cap}-token ${tier} cap `
            + `after the named demotion${demotions.length === 1 ? "" : "s"}, which free ${freed} — name more with --demote`);
    }
}

// The room is made among the rules (#446 §D-15). Nothing here names
// `--demote`, a goal, an objective or a convention: an instruction charges no
// retention tier, so demoting a strategic record frees nothing it can use, and
// advertising that was the defect #446 reported. The two remedies that do work
// are a shorter successor and a larger cap, and the refusal states both.
const INSTRUCTION_REMEDY = "retire or supersede one with a shorter text,"
    + " or raise instructionTokens in config.json";

function instructionCapRefusal(target: string, held: number, cap: number,
    adding: number, scale: TokenScale, here: string): string
{
    return `instructions hold ${held} of the ${cap}-token ${scopeLabel(target, here)} instruction cap `
        + `and this text adds ${adding} more — ${INSTRUCTION_REMEDY}${estimateNote(scale)}`;
}

// Said once wherever a token number is printed, so a reader always knows
// whether the figure came from a measurement or from the shipped estimate.
export function estimateNote(scale: TokenScale): string
{
    return scale.measured ? "" : ` (estimated at ${scale.perCharacter} tokens per character; \`self tokens\` records a measurement)`;
}

// A named full → index demotion enters the index tier itself — the gating
// rule has no exception for the remedy — so the pair is refused while its
// destination lacks room, toward the drain that always fits: index → search.
// `vacates` is the seat the placed record itself frees when it leaves that
// scope's index for full, so a swap at an exactly-full cap still passes.
function requireDemotionRoom(usage: UsageReader, caps: RetentionCaps, target: string,
    demotions: Placed[], vacates: number, scale: TokenScale, here: string): void
{
    const arriving = demotions.filter((item) => item.entity.exposure === "full");
    if (arriving.length === 0)
    {
        return;
    }
    const entering = tokensOf(arriving.reduce((sum, item) => sum + entityCharacters(item.entity), 0), scale.perCharacter);
    const after = usage(target, "index") + entering - tokensOf(vacates, scale.perCharacter);
    if (after > caps.index)
    {
        throw new CliError(`the named demotion${arriving.length === 1 ? "" : "s"} would put the `
            + `${scopeLabel(target, here)} index tier at `
            + `${after} of ${caps.index} tokens${estimateNote(scale)} — free index room first with `
            + '`self state place <id> --exposure search --why "<reason>"`');
    }
}

// One seat movement a confirm would apply: the cap the record sits in now (a
// proposed record sits in none), and the cap it would sit in — scope and
// exposure both, because a pending placement can move either. A move into
// nothing is a move toward `search`, which no cap bounds.
interface SeatMove
{
    from?: CappedTier;
    to?: CappedTier;
    characters: number;
}

function unitMoves(unit: ConfirmMember[], home: string): SeatMove[]
{
    return unit.flatMap((member): SeatMove[] =>
    {
        const entity = member.entity;
        const characters = entityCharacters(entity);
        const at = scopeTarget(entity, home);
        const instruction = isInstruction(entity);
        if (member.kind === "record")
        {
            return [{ to: chargedCap(instruction, at, entity.exposure), characters }];
        }
        // A placement moves an instruction's seat nowhere a cap can see it, the
        // same way `state place` on one is ungated (#446 §D-16).
        const pending = instruction ? undefined : entity.pending;
        const target = pending?.scope === undefined ? at : scopeTarget({ scope: pending.scope }, home);
        const exposure = pending?.exposure ?? entity.exposure;
        return target === at && exposure === entity.exposure
            ? []
            : [{ from: tierOf(at, entity.exposure), to: tierOf(target, exposure), characters }];
    });
}

// What a confirm admits must fit at confirm time (review F2), judged as the
// unit's net movement (review F3): a tier the unit enters must end within
// its cap, credited with every seat the unit itself vacates there — the
// same crediting the write path does — under the same counts the write
// verbs gate on. A tier the unit only drains is never gated, so an over-cap
// store keeps its way down.
function requireUnitRoom(usage: UsageReader, caps: RetentionCaps, unit: ConfirmMember[], scale: TokenScale, home: string): void
{
    const moves = unitMoves(unit, home);
    for (const at of enteredCaps(moves))
    {
        requireTierRoom(usage, caps, at, moves, scale, home);
    }
}

// Every cap the unit enters, once each: one check per (target, cap) pair the
// moves land in, and none at all for a unit that only drains.
function enteredCaps(moves: SeatMove[]): CappedTier[]
{
    const entered = new Map<string, CappedTier>();
    for (const move of moves)
    {
        if (move.to !== undefined)
        {
            entered.set(`${move.to.target} ${move.to.tier}`, move.to);
        }
    }
    return [...entered.values()];
}

function requireTierRoom(usage: UsageReader, caps: RetentionCaps, at: CappedTier, moves: SeatMove[], scale: TokenScale, here: string): void
{
    const weigh = (move: SeatMove): number => tokensOf(move.characters, scale.perCharacter);
    const inTier = (seat: CappedTier | undefined): boolean =>
        seat !== undefined && seat.target === at.target && seat.tier === at.tier;
    const entering = moves.filter((move) => inTier(move.to)).reduce((sum, move) => sum + weigh(move), 0);
    const held = usage(at.target, at.tier);
    const cap = capOf(caps, at.tier);
    const leaving = moves.filter((move) => inTier(move.from)).reduce((sum, move) => sum + weigh(move), 0);
    if (entering > 0 && held + entering - leaving > cap)
    {
        throw new CliError(confirmRefusal(at, held, cap, scale, here));
    }
}

// The confirm's half of §D-15, in `requireTierRoom`'s own family: the same
// clause opens it and the same numbers close it, and only the remedy differs —
// an instruction's room is made among the instructions.
function confirmRefusal(at: CappedTier, held: number, cap: number, scale: TokenScale, here: string): string
{
    const scope = scopeLabel(at.target, here);
    const tier = at.tier;
    if (tier === "instruction")
    {
        return `confirming this would put the ${scope} instructions over their cap `
            + `(${held} of ${cap} tokens held)${estimateNote(scale)} — ${INSTRUCTION_REMEDY}`;
    }
    return `confirming this would put the ${scope} ${tier} tier over its cap `
        + `(${held} of ${cap} tokens held)${estimateNote(scale)} — `
        + `free room first with \`self state place <id> --exposure ${DEMOTION_TARGET[tier]} --why "<reason>"\``;
}

// A demotion named where no cap demands one would demote a record as a side
// effect of an unrelated command — refused toward the direct verb instead.
function requireDemotionsNeeded(demotions: Placed[], entered: CappedTier, here: string): void
{
    const tier = entered.tier;
    // The instruction cap names no demotion at all, so `demotionsFor` has
    // already refused one; this gate answers for the tiers alone.
    if (demotions.length === 0 || tier === "instruction")
    {
        return;
    }
    throw new CliError(`the ${scopeLabel(entered.target, here)} ${tier} tier is not over its cap — nothing needs to demote; `
        + `demote directly with \`self state place <id> --exposure ${DEMOTION_TARGET[tier]} --why "<reason>"\``);
}

function demotionsFor(records: Placed[], raw: string[], entered: CappedTier | undefined,
    exclude: string | undefined, usage: string, here: string): Placed[]
{
    if (raw.length === 0)
    {
        return [];
    }
    if (entered === undefined)
    {
        throw new CliError("--demote frees room in the capped tier a record enters — this command enters none, so nothing needs to demote");
    }
    // Reachable only from a raw `state add --label instruction --demote <id>`:
    // `instruction add` declares no such flag (#446 §D-16), and a placement of
    // an instruction enters no cap, so it takes the refusal above instead.
    if (entered.tier === "instruction")
    {
        throw new CliError("--demote frees room in a retention tier and an instruction charges none — retire or"
            + " supersede an instruction with a shorter text, or raise instructionTokens in config.json");
    }
    const demotions = raw.map((value) => requireDemotable(records, value, entered, exclude, usage, here));
    for (const [index, item] of demotions.entries())
    {
        if (demotions.findIndex((other) => other.entity.id === item.entity.id) !== index)
        {
            throw new CliError(`--demote ${item.entity.id} is repeated — one record frees its place once`);
        }
    }
    return demotions;
}

// A demotion frees a seat in the tier being entered, so it has to hold one:
// the same render target, the same exposure, confirmed — whichever project's
// log holds it, because the tier belongs to the project the seat renders in
// rather than to the store the record sits in (#181 D4).
function requireDemotable(records: Placed[], value: string, entered: CappedTier,
    exclude: string | undefined, usage: string, here: string): Placed
{
    const found = requirePlaced(records, value, usage);
    const entity = found.entity;
    if (entity.id === exclude)
    {
        throw new CliError(`--demote ${entity.id} names the record being placed — another entity has to free the room`);
    }
    // Named before the proposed and lifecycle clauses below, and every clause
    // in requireDemotableSeat: what kind of record this is settles the answer
    // regardless of what its lifecycle says, and a proposed or withdrawn
    // instruction is still an instruction (#446 §D-16, round 2).
    if (isInstruction(entity))
    {
        throw new CliError(`--demote ${entity.id} is an instruction — it charges no retention tier, so `
            + "demoting it frees no room; name a goal, decision, convention or index record with --demote");
    }
    if (entity.status === "proposed")
    {
        throw new CliError(`--demote ${entity.id} is still proposed — it holds no place in the ${entered.tier} tier until confirmed`);
    }
    if (!isLive(entity))
    {
        throw new CliError(`--demote ${entity.id} was already ${entity.status} — it holds no place in the ${entered.tier} tier`);
    }
    requireDemotableSeat(found, entered, here);
    return found;
}

function requireDemotableSeat(found: Placed, entered: CappedTier, here: string): void
{
    const at = scopeLabel(scopeTarget(found.entity, found.owner), here);
    const into = scopeLabel(entered.target, here);
    if (at !== into)
    {
        throw new CliError(`--demote ${found.entity.id} is ${at}-scoped — the ${into} ${entered.tier} cap frees only by demoting ${into}-scoped records`);
    }
    if (found.entity.exposure !== entered.tier)
    {
        throw new CliError(`--demote ${found.entity.id} sits at ${found.entity.exposure} exposure — name a record at ${entered.tier} exposure, the tier being entered`);
    }
}

// The paired demotion, appended in the same write as the add or placement it
// makes room for: `refs.admits` is the machine-readable pairing the confirm
// surface applies the pair as one unit by, and the why says the same thing
// to the person reading it. --proposed marks both halves, so neither applies
// until a person answers.
// The demotion lands in the log that owns the record it demotes, which is not
// always the log the admitted record is written to (#181 D3): a seat in the
// destination's tier is freed by a record the destination's own log holds.
// It carries the same `by` the add or placement beside it does (#400): a seat
// freed is a record moved, and a reader asking who moved it is owed an answer
// on the event that moved it rather than on the one it made room for.
export function demotionEvents(demotions: Placed[], admit: string, proposed: boolean): SelfEvent[]
{
    const by = writtenBy();
    return demotions.map((item) => makeEvent(item.owner, "entity.placed", {
        entity: item.entity.id,
        exposure: DEMOTION_TARGET[item.entity.exposure as "full" | "index"],
        why: `demoted to admit ${admit} under the ${item.entity.exposure} cap`,
        ...(proposed ? { proposed: true } : {}),
        by
    }, { admits: admit }, !proposed));
}

function stateConfirm({ positionals }: CommandInput): void
{
    const wanted = requireText(positionals[0], "state confirm <id>");
    // The owner's own fold is rebuilt by `workspaceModels`, which this needs
    // whole: the caps count a tier across every store, so the room judgment
    // reads every project rather than the one the record sits in.
    const { ctx } = recordOwner(process.cwd(), wanted, (model) => holdsEntity(model, wanted));
    const models = workspaceModels(ctx.storeDir, ctx.project);
    const model = models[0];
    const entity = requireEntity(model, wanted, "state confirm <id>");
    const unit = confirmableUnit(model, entity);
    const config = readStoreConfig(ctx.storeDir);
    const scale = tokenScale(config);
    requireUnitRoom(usageReader(models, scale), retentionCaps(config), unit, scale, ctx.project);
    recordEvents(ctx, unit.map((member) => confirmEvent(ctx.project, member)), entity.text);
}

// One confirmable thing a record carries: its own proposal, or a placement
// pending on it. A confirm answers to the entity's own id either way, and
// the placement axis is entity-owned, so this holds for the preset record
// kinds too.
interface ConfirmMember
{
    entity: EntityState;
    kind: "record" | "placement";
}

function waitingMember(entity: EntityState | undefined): ConfirmMember | null
{
    if (entity === undefined)
    {
        return null;
    }
    if (entity.status === "proposed")
    {
        return { entity, kind: "record" };
    }
    return entity.status === "confirmed" && entity.pending !== undefined ? { entity, kind: "placement" } : null;
}

// A cap-driven pair is one confirmable unit (review F3): from either half's
// id, the admitted record and every demotion still paired to it land in one
// append. No ordering exists to get wrong, no in-between state exists for a
// cap to be exceeded in, and an exact swap of two full tiers cannot
// deadlock. A demotion whose admitted record already landed — or left by
// retraction or supersession — confirms alone.
function confirmableUnit(model: ProjectModel, entity: EntityState): ConfirmMember[]
{
    const own = waitingMember(entity);
    if (own === null)
    {
        throw new CliError(`${entity.id} is already ${entity.status}`);
    }
    // Only a decision or an objective can stand proposed among the legacy
    // readings, so the remedy below always has a confirm verb to name.
    if (own.kind === "record" && entity.source !== undefined)
    {
        throw new CliError(`${entity.id} is a ${entity.source} record — run \`self ${entity.source === "decision" ? "decide" : entity.source} confirm ${entity.id}\``);
    }
    return pairedUnit(model, entity, own);
}

function pairedUnit(model: ProjectModel, entity: EntityState, own: ConfirmMember): ConfirmMember[]
{
    const admitted = own.kind === "placement" && entity.pending?.admits !== undefined
        ? waitingMember(model.entities.find((item) => item.id === entity.pending?.admits))
        : null;
    const centre = own.kind === "placement" && entity.pending?.admits !== undefined ? admitted ?? own : own;
    const members = new Map<string, ConfirmMember>([[centre.entity.id, centre]]);
    for (const item of model.entities)
    {
        const paired = item.pending?.admits === centre.entity.id ? waitingMember(item) : null;
        if (paired !== null)
        {
            members.set(item.id, paired);
        }
    }
    members.set(entity.id, own);
    return [...members.values()];
}

// Exact id first, then a unique prefix, over the folded records — legacy
// decisions and native decision entities answer through one lookup.
export function requireDecision(model: ProjectModel, prefix: string | undefined): DecisionState
{
    const wanted = requireText(prefix, "decide … <decision-id>");
    const exact = model.decisions.find((item) => item.id === wanted);
    if (exact !== undefined)
    {
        return exact;
    }
    const matches = model.decisions.filter((item) => item.id.startsWith(wanted));
    if (matches.length > 1)
    {
        throw new CliError(`decision id "${wanted}" is ambiguous (${matches.length} matches) — spell more of it`);
    }
    if (matches.length === 0)
    {
        throw new CliError(`${wanted} is not a decision`);
    }
    return matches[0];
}

// Whether `requireDecision` would find anything here, asked of a whole project
// so `recordOwner` can pick the one whose lookup is about to succeed. A prefix
// is what makes this worth stating: two projects can both answer to one, which
// is the ambiguity `recordOwner` refuses by naming them.
export function holdsDecision(model: ProjectModel, wanted: string): boolean
{
    return model.decisions.some((item) => item.id === wanted || item.id.startsWith(wanted));
}

// The project a confirm records into, found from the record it names (#302).
// Every call to action a `--project` context prints is one of these verbs, and
// a reader outside that project — an agent session in another one, a person at
// the workspace root — could not run the line they were handed, because the
// verb resolved its project from the directory instead of from the id it was
// given. Nothing here reads the checkout, so the answer holds even when the
// project's own checkout is on another machine.
//
// `holds` is the caller's, because what counts as holding the record is the
// record kind's question: an entity id, a decision id matched by prefix, an
// open work proposal. Finding the project is all this does — the verb still
// runs its own lookup on the model, so every refusal it already had is the
// refusal a reader still gets.
//
// The fold comes back with the context: finding the project meant folding it,
// and the caller's own lookup runs on that same model rather than reading the
// log a second time.
export function recordOwner(cwd: string, wanted: string,
    holds: (model: ProjectModel) => boolean): { ctx: ProjectScope; model: ProjectModel }
{
    const ctx = requireWorkspace(cwd);
    const owners = projectsHolding(ctx.storeDir, holds, ctx.project);
    if (owners.length > 1)
    {
        throw new CliError(`"${wanted}" names a record in ${owners.map((owner) => owner.project).join(", ")} — `
            + "spell more of the id, or run this inside the checkout of the project you mean");
    }
    if (owners.length === 1)
    {
        return { ctx: projectScope(ctx, owners[0].project), model: owners[0].model };
    }
    if (ctx.project === undefined)
    {
        noOwner(ctx.storeDir, wanted);
    }
    // Standing in a project that does not hold it, the verb's own "that is not
    // a decision" is a better answer than a workspace-wide miss, so hand that
    // project back and let the lookup speak.
    return { ctx: ctx as ProjectScope, model: buildModel(ctx.storeDir, ctx.project, new Date()) };
}

function noOwner(storeDir: string, wanted: string): never
{
    const slugs = readRegistry(storeDir).map((entry) => entry.slug);
    throw new CliError(slugs.length === 0
        ? `no registered project holds "${wanted}" — this workspace has no registered projects`
        : `no registered project holds "${wanted}" — it was looked for in ${slugs.join(", ")}`);
}

// The confirm a preset verb applies (#240 R3): the same unit collection and
// the same room judgment `state confirm` runs, reached from the verb that
// owns the record's vocabulary — so a proposed decision or objective is gated
// at confirm exactly as a raw entity is, paired demotions included.
export function confirmEntityUnit(ctx: ProjectScope, id: string): void
{
    const models = workspaceModels(ctx.storeDir, ctx.project);
    const model = models[0];
    const entity = model.entities.find((item) => item.id === id);
    const own = waitingMember(entity);
    if (entity === undefined || own === null)
    {
        throw new CliError(`${id} has nothing waiting to confirm`);
    }
    const unit = pairedUnit(model, entity, own);
    const config = readStoreConfig(ctx.storeDir);
    const scale = tokenScale(config);
    requireUnitRoom(usageReader(models, scale), retentionCaps(config), unit, scale, ctx.project);
    recordEvents(ctx, unit.map((member) => confirmEvent(ctx.project, member)), entity.text);
}

function confirmEvent(project: string, member: ConfirmMember): SelfEvent
{
    const confirms = member.kind === "record" ? member.entity.id : member.entity.pending?.event ?? member.entity.id;
    return makeEvent(project, "entity.confirmed", { entity: member.entity.id, by: writtenBy() }, { confirms }, true);
}

/* ── the coverage grammar (#207 C) ─────────────────────────────────── */

// One coverage claim: a declared criterion, judged covered with a reason, on
// any record that carries criteria — raw entities and the preset kinds alike,
// which is what makes `milestone met` sugar over this rather than a second
// grammar. The claim binds to the entity id: a superseding revision starts
// uncovered, and re-covering the successor is what `milestone recheck` does.
//
// `self work cover` is an alias in the strict sense (#408): the same handler,
// the same writer, a byte-identical `entity.covered`. Only the usage line and
// the verb name in the refusals differ, so a session working a unit never has
// to leave the `work` family to say what it finished.
export function coverRecord({ values, positionals }: CommandInput<typeof COVER_OPTIONS>, verb = "state cover", usage = COVER_USAGE): void
{
    const ctx = requireProject(process.cwd());
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const entity = requireCoverable(model, positionals[0], usage);
    const criterion = resolveCriterion(entity, required(values.criterion));
    const why = required(values.why);
    if (entity.covered.some((claim) => claim.criterion === criterion))
    {
        throw new CliError(`${entity.id} "${criterion}" is already covered — a criterion is judged once per record; a superseding revision starts uncovered`);
    }
    recordCoverage(ctx, model, entity.id, criterion, why, values, verb);
}

// The one writer of `entity.covered` — `state cover`, `work cover`, `milestone
// met`, `milestone recheck` and `runbook advance` all land here, so the claim's
// shape cannot drift between the raw verb and its sugar (#207 C5). Since #408
// the claim also says who wrote it, the way every other verb has since #400;
// nothing else about the event moved, so every caller's claim is what it was.
export function recordCoverage(
    ctx: ProjectContext,
    model: ProjectModel,
    entity: string,
    criterion: string,
    why: string,
    values: { work?: string; evidence?: string[] },
    verb: string
): void
{
    const refs: EventRefs = {};
    if (values.work !== undefined)
    {
        refs.work = requireCitedWork(model, values.work);
    }
    const commits = (values.evidence ?? []).map((item) => requireRevision(item, bareRevisionRefusal(verb)));
    if (commits.length > 0)
    {
        refs.commits = commits;
    }
    recordEvent(ctx, makeEvent(ctx.project, "entity.covered", { entity, criterion, why, by: writtenBy() }, refs, true),
        `${entity} ${criterion} ${why}`);
}

function requireCoverable(model: ProjectModel, value: string | undefined, usage: string): EntityState
{
    const entity = requireEntity(model, value, usage);
    if (entity.criteria.length === 0)
    {
        throw new CliError(`${entity.id} declares no criteria — a coverage claim answers a declared criterion; declare them with --criteria at add time`);
    }
    if (entity.status === "proposed")
    {
        throw new CliError(`${entity.id} is still proposed — coverage lands on a record that holds; confirm it first`);
    }
    if (!isLive(entity))
    {
        throw new CliError(entity.status === "retracted"
            ? `${entity.id} was retracted — a withdrawn record has nothing left to cover`
            : `${entity.id} was superseded by ${entity.supersededBy ?? "a later record"} — cover the successor; its criteria start uncovered`);
    }
    return entity;
}

// A criterion is named by its text, or by cN — its 1-based place in the
// declared list, the spelling the milestone surface has always used.
export function resolveCriterion(entity: EntityState, wanted: string): string
{
    if (entity.criteria.includes(wanted))
    {
        return wanted;
    }
    const index = /^c\d+$/.test(wanted) ? Number(wanted.slice(1)) : NaN;
    if (Number.isInteger(index) && index >= 1 && index <= entity.criteria.length)
    {
        return entity.criteria[index - 1];
    }
    throw new CliError(`"${wanted}" is not a declared criterion of ${entity.id} — it declares: `
        + entity.criteria.map((criterion, at) => `c${at + 1} "${criterion}"`).join("; "));
}

/* ── the criterion axis (#408) ─────────────────────────────────────── */

// What an add verb declares, validated before a byte is written. Repeatable
// and ordered: the criteria are addressed c1..cN in the order the flags were
// given, and `--verify` names the one it verifies, because one call declares
// several and nothing else in the flag says which.
export interface Declaration
{
    criteria: string[];
    // Sparse and keyed by position rather than parallel arrays: most criteria
    // carry neither a verification text nor an owner, and an array of holes is
    // a shape every reader has to defend against.
    verify?: Record<string, string>;
    owner?: Record<string, string>;
}

export function declarationOf(values: { criteria?: string[]; verify?: string[]; owner?: string[] },
    verb: string): Declaration
{
    const criteria = (values.criteria ?? []).map((criterion) => validText(criterion, "--criteria", "one criterion's text"));
    const duplicate = criteria.find((text, at) => criteria.indexOf(text) !== at);
    if (duplicate !== undefined)
    {
        throw new CliError(`${verb} --criteria declares "${duplicate}" twice — a criterion is judged once, and two `
            + "with one text could never be told apart");
    }
    return {
        criteria,
        ...keyedFlag(values.verify ?? [], criteria.length, verb, VERIFY_FLAG),
        ...keyedFlag(values.owner ?? [], criteria.length, verb, OWNER_FLAG)
    };
}

// The two flags an add verb states about one of the criteria it declares, each
// naming that criterion by its `cN` prefix because one call declares several
// and nothing else in the flag says which. Read through one parser
// parameterised by what the flag says, so the refusals stay parallel and a
// third such flag cannot drift from either (#413).
interface KeyedFlag
{
    key: "verify" | "owner";
    // what the flag states, in the refusal a call with no `--criteria` gets
    states: string;
    // what its value has to begin with, named as the reader would name it
    begins: string;
    // the shape a caller is shown when theirs did not parse
    shape: string;
    // why one criterion takes one of them
    once: string;
    // What the value itself may be, where the flag admits an enum rather than
    // prose. A property of the flag rather than a branch inside the parser,
    // which is what keeps `--verify`'s free text free.
    value: (raw: string, verb: string) => string;
}

const VERIFY_FLAG: KeyedFlag = {
    key: "verify",
    states: "states how one declared criterion is checked",
    begins: "the criterion it verifies",
    shape: "c1 <how it is checked>",
    once: "one criterion states one verification method",
    value: (raw) => raw
};

const OWNER_FLAG: KeyedFlag = {
    key: "owner",
    states: "states whose task one declared criterion is",
    begins: "the criterion it names",
    shape: `c1 ${PERSON_OWNER}`,
    once: "one criterion has one owner",
    value: (raw, verb) => requirePersonOwner(raw, verb)
};

// The one value an owner takes. Stated here so `work criteria add`, whose
// `--owner` is bare, refuses in the same words as the `cN`-prefixed form.
export function requirePersonOwner(value: string, verb: string): string
{
    if (value !== PERSON_OWNER)
    {
        throw new CliError(`${verb} --owner takes "${PERSON_OWNER}" — it is the only owner a criterion states, and one `
            + "with no owner is the session's own task");
    }
    return value;
}

// One `cN`-prefixed flag, read into the sparse map the creation event carries.
// Every refusal names the range this call actually declares, so a caller who
// miscounted is told the number rather than left to guess it.
function keyedFlag(stated: string[], declared: number, verb: string, flag: KeyedFlag): Partial<Declaration>
{
    const map: Record<string, string> = {};
    for (const text of stated)
    {
        const [at, value] = keyedValue(text, declared, verb, flag);
        if (map[at] !== undefined)
        {
            throw new CliError(`${verb} --${flag.key} names ${at} twice — ${flag.once}`);
        }
        map[at] = value;
    }
    return Object.keys(map).length === 0 ? {} : { [flag.key]: map };
}

function keyedValue(stated: string, declared: number, verb: string, flag: KeyedFlag): [string, string]
{
    if (declared === 0)
    {
        throw new CliError(`${verb} --${flag.key} ${flag.states} — pass --criteria "<text>" too`);
    }
    const named = /^(c[1-9]\d*)\s+(\S.*)$/.exec(stated.trim());
    if (named === null)
    {
        throw new CliError(`${verb} --${flag.key} must begin with ${flag.begins} — "${flag.shape}"; `
            + `this call declares ${declaredRange(declared)}`);
    }
    if (Number(named[1].slice(1)) > declared)
    {
        throw new CliError(`${verb} --${flag.key} names ${named[1]}, and this call declares ${declaredRange(declared)}`);
    }
    return [named[1], flag.value(named[2], verb)];
}

function declaredRange(declared: number): string
{
    return declared === 1 ? "c1" : `c1–c${declared}`;
}

// The two record kinds no criterion may be declared on, refused by the writer
// rather than by one verb's id check: a runbook run's stages *are* its
// criteria, copied from the edition it follows, so appending one would drift
// `stageDigest` from the procedure it claims to be running. The guard lives
// here so a later `state criteria add` cannot slip past it.
const NO_DECLARING: Record<string, (id: string) => string> = {
    [RUNBOOK_RUN_LABEL]: (id) => `${id} is a runbook run — its stages come from the procedure it follows, and a `
        + `stage is added by revising the runbook (\`self runbook revise <id> --stage "<text>" --why w\`)`,
    [RUNBOOK_LABEL]: (id) => `${id} is a runbook — its stages are the procedure itself, and one is added by `
        + `\`self runbook revise ${id} --stage "<text>" --why w\`, which mints the next edition`
};

// The one writer of `entity.criterion-declared`. Appends a completion
// condition to a record that already holds: nothing removes a criterion, and
// nothing re-states one, so declaring is the only way the list or its
// ownership ever changes and `self undo` is the only way back.
//
// `project` is the store this is written to; `stated.owner` is whose task the
// criterion is. The two are different questions and the parameter names say so.
export function recordDeclaration(ctx: ProjectContext, project: string, entity: EntityState, text: string,
    stated: { verify?: string; owner?: string }): void
{
    const refused = entity.labels.map((label) => NO_DECLARING[label]).find((rule) => rule !== undefined);
    if (refused !== undefined)
    {
        throw new CliError(refused(entity.id));
    }
    const declared = entity.criterionStates.find((item) => item.text === text);
    if (declared !== undefined)
    {
        throw new CliError(`${entity.id} already declares ${declared.id} "${text}" — a criterion is judged once, `
            + "and two with one text could never be told apart");
    }
    const payload = {
        entity: entity.id,
        criterion: text,
        ...(stated.verify === undefined ? {} : { verify: stated.verify }),
        ...(stated.owner === undefined ? {} : { owner: stated.owner }),
        by: writtenBy()
    };
    recordEvent(ctx, makeEvent(project, CRITERION_DECLARED, payload, undefined, true), `${entity.id} ${text}`);
}

// The one writer of the criterion block and its release. The verb is shared
// with the unit's own block — one blocking act, one `--on` enum, the scope
// named by a flag — and only the event type differs, because the fold's answer
// does: a criterion's block never changes the unit's own status.
export function recordCriterionBlock(ctx: ProjectContext, owner: string, entity: EntityState, state: CriterionState,
    on: string, why: string | undefined): void
{
    if (state.covered !== undefined)
    {
        throw new CliError(`${entity.id} ${state.id} is already covered — a covered criterion waits on nothing`);
    }
    if (state.blocked !== undefined)
    {
        throw new CliError(`${entity.id} ${state.id} is already blocked on ${state.blocked.on}`
            + `${state.blocked.why === undefined ? "" : ` — ${state.blocked.why}`}`);
    }
    const payload = { entity: entity.id, criterion: state.text, on, ...(why === undefined ? {} : { why }), by: writtenBy() };
    recordEvent(ctx, makeEvent(owner, CRITERION_BLOCKED, payload, undefined, true), `${entity.id} ${state.text}`);
}

export function recordCriterionUnblock(ctx: ProjectContext, owner: string, entity: EntityState, state: CriterionState): void
{
    if (state.blocked === undefined)
    {
        throw new CliError(`${entity.id} ${state.id} is not blocked — there is nothing to release`);
    }
    const payload = { entity: entity.id, criterion: state.text, by: writtenBy() };
    recordEvent(ctx, makeEvent(owner, CRITERION_UNBLOCKED, payload, undefined, true), `${entity.id} ${state.text}`);
}

// Coverage cites a work unit the log knows; the milestone sugar tightens this
// to a linked one at its own surface.
function requireCitedWork(model: ProjectModel, id: string): string
{
    const work = model.works.find((item) => item.id === id);
    if (work === undefined)
    {
        throw new CliError(wrongKindHint(id, "work") ?? `unknown work id "${id}" — run \`self work\` to list ids`);
    }
    return work.id;
}

function stateRetract({ values, positionals }: CommandInput<typeof WHY_OPTION>): void
{
    const ctx = requireProject(process.cwd());
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const entity = requireEntity(model, positionals[0], RETRACT_USAGE);
    if (entity.source !== undefined)
    {
        throw new CliError(`${entity.id} is a ${entity.source} record — ${OWNING_WITHDRAW[entity.source]}`);
    }
    if (!isLive(entity))
    {
        throw new CliError(entity.status === "retracted"
            ? `${entity.id} was already retracted`
            : `${entity.id} was already superseded by ${entity.supersededBy ?? "a later entity"} — nothing is left to retract`);
    }
    const why = required(values.why);
    recordRetirement(ctx, retirementIntent(model, "retract", [entity.id], { why }), model,
        (by) => [makeEvent(ctx.project, "entity.retracted", { entity: entity.id, why, by }, { retracts: entity.id }, true)],
        entity.text);
}

/* ── the execution verbs (#197 §5, #205) ───────────────────────────── */

// What one execution verb speaks about: the project it runs in, and the live
// entity whose working state it records. Facts land on records that hold — a
// proposal is not yet a record, a withdrawn or replaced one no longer is, and
// a preset record kind's completion belongs to its own verbs.
function executionTarget(id: string | undefined, usage: string): { ctx: ProjectContext; model: ProjectModel; entity: EntityState }
{
    const ctx = requireProject(process.cwd());
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const entity = requireEntity(model, id, usage);
    if (entity.source !== undefined)
    {
        throw new CliError(`${entity.id} is a ${entity.source} record — execution events attach to raw entities; its own verbs own its lifecycle`);
    }
    if (entity.status === "proposed")
    {
        throw new CliError(`${entity.id} is still proposed — execution records facts about a record that holds; confirm it first with \`self state confirm ${entity.id}\``);
    }
    if (!isLive(entity))
    {
        throw new CliError(entity.status === "retracted"
            ? `${entity.id} was retracted — a withdrawn record has no working state to move`
            : `${entity.id} was superseded by ${entity.supersededBy ?? "a later entity"} — record the work on the successor`);
    }
    return { ctx, model, entity };
}

// The terminal row of the transition matrix (#205 table A): done and retired
// end the working state, and every later transition is refused rather than
// recorded — a completed or given-up outcome is not something to keep moving.
function requireMovable(entity: EntityState, verb: string): void
{
    const status = entity.execution?.status;
    if (status === "done")
    {
        throw new CliError(verb === "done"
            ? `${entity.id} is already done`
            : `${entity.id} is already done — its working state is terminal, so nothing is left to ${verb}`);
    }
    if (status === "retired")
    {
        throw new CliError(verb === "retire"
            ? `${entity.id} is already retired`
            : `${entity.id} was retired — its working state is terminal, so nothing is left to ${verb}`);
    }
}

// A start on a record another session already has is disclosed, never refused
// (#231). The refusal that used to stand here read "already started" and
// answered a second session with a lock — on a state it could not tell was
// still live, which is the case a refusal gets wrong. `work start` had already
// been ruled the other way (#230), and one transition cannot answer two ways.
//
// The blocked refusal below stays: it is about the record's own state rather
// than about who put it there, and `state unblock` is the verb that clears it.
function stateStart({ positionals }: CommandInput): void
{
    const { ctx, entity } = executionTarget(positionals[0], "state start <id>");
    requireMovable(entity, "start");
    if (entity.execution?.status === "blocked")
    {
        throw new CliError(`${entity.id} is blocked — unblock it first with \`self state unblock ${entity.id}\``);
    }
    const mine = sessionToken();
    const held = claimNote(entity.claim, mine);
    if (held !== null)
    {
        // A disclosure, not this verb's answer: it is read before the write and
        // it prints where it stood, through the gate's notice.
        notice(held);
    }
    if (claimMoves(entity.claim, mine))
    {
        recordEvent(ctx, makeEvent(ctx.project, "entity.started", { entity: entity.id }), entity.text);
    }
    noteSessionSeen(mine, new Date().toISOString());
}

// The two conditions the block axis judges, and the words each is refused in.
// Lifted out of the verbs below so a surface that blocks for a reason of its
// own — `runbook hold` and `runbook approve` (#171) — refuses in the same
// sentence rather than in a second copy of it that can drift from this one.
// Each returns the refusal or nothing, so the caller decides what to add.
export function alreadyBlocked(entity: EntityState): string | undefined
{
    return entity.execution?.status === "blocked"
        ? `${entity.id} is already blocked${entity.execution.why === undefined ? "" : ` — ${entity.execution.why}`}`
        : undefined;
}

export function notBlocked(entity: EntityState): string | undefined
{
    return entity.execution?.status === "blocked" ? undefined : `${entity.id} is not blocked — there is nothing to unblock`;
}

function stateBlock({ values, positionals }: CommandInput<typeof BLOCK_OPTIONS>): void
{
    const { ctx, entity } = executionTarget(positionals[0], 'state block <id> [--on <what>] [--why "<reason>"]');
    requireMovable(entity, "block");
    const standing = alreadyBlocked(entity);
    if (standing !== undefined)
    {
        throw new CliError(standing);
    }
    const payload: Record<string, unknown> = { entity: entity.id };
    if (values.on !== undefined)
    {
        payload.on = validText(values.on, "--on", "what the entity waits on");
    }
    if (values.why !== undefined)
    {
        payload.why = values.why;
    }
    recordEvent(ctx, makeEvent(ctx.project, "entity.blocked", payload), entity.text);
}

function stateUnblock({ positionals }: CommandInput): void
{
    const { ctx, entity } = executionTarget(positionals[0], "state unblock <id>");
    requireMovable(entity, "unblock");
    const clear = notBlocked(entity);
    if (clear !== undefined)
    {
        throw new CliError(clear);
    }
    recordEvent(ctx, makeEvent(ctx.project, "entity.unblocked", { entity: entity.id }), entity.text);
}

// The evidence gate (#205 table B, user-ruled 2026-08-03): a done claim
// carries what verifiably happened, and a record that declared criteria is
// additionally gated on a coverage claim for every one of them (#207 C3/C4).
// Done is allowed while blocked (ruling ①): completion is a judgment on the
// outcome, not on the block.
function stateDone({ values, positionals }: CommandInput<typeof DONE_OPTIONS>): void
{
    const { ctx, entity } = executionTarget(positionals[0], 'state done <id> --report "<what verifiably happened>"');
    requireMovable(entity, "done");
    requireCriteriaCovered(entity);
    recordEvent(ctx, makeEvent(ctx.project, "entity.done", { entity: entity.id, report: required(values.report).trim() }), entity.text);
}

// The criteria gate, spelled once in `@superself/fold` `completion.ts` and reached from both
// families: the raw path names `self state cover`, the work path names `self
// work cover`, and neither has a second copy of the sentence to keep correct.
function requireCriteriaCovered(entity: EntityState): void
{
    const refusal = criteriaRefusal(entity.id, entity.criterionStates, "state");
    if (refusal !== null)
    {
        throw new CliError(refusal);
    }
}

function stateExecRetire({ values, positionals }: CommandInput<typeof RETIRE_OPTIONS>): void
{
    const usage = 'state retire <id> --why "<why the outcome was given up or moved>" [--successor <id>]';
    const { ctx, model, entity } = executionTarget(positionals[0], usage);
    requireMovable(entity, "retire");
    const why = required(values.why);
    const payload: Record<string, unknown> = { entity: entity.id, why };
    if (values.successor !== undefined)
    {
        payload.successor = requireSuccessor(model, entity, values.successor).id;
    }
    recordRetirement(ctx, retirementIntent(model, "retire", [entity.id], { why }), model,
        (by) => [makeEvent(ctx.project, "entity.retired", { ...payload, by })],
        entity.text);
}

// The successor is resolved before anything is written: an unknown reference
// refuses the retirement instead of recording a pointer nothing can follow,
// and an outcome cannot move to the record that gave it up.
function requireSuccessor(model: ProjectModel, retired: EntityState, value: string): EntityState
{
    const successor = requireEntity(model, value, "state retire <id> --successor <entity-id>");
    if (successor.id === retired.id)
    {
        throw new CliError(`${retired.id} cannot succeed itself — name the entity that carries the outcome now`);
    }
    if (successor.execution?.status === "retired")
    {
        throw new CliError(`successor ${successor.id} is itself retired — the outcome cannot move to a record that gave it up`);
    }
    return successor;
}

// Where each preset record kind's own withdrawal lives, for the refusal that
// points a caller back at the verb owning the record.
const OWNING_WITHDRAW: Record<EntitySource, string> = {
    goal: "run `self goal retract <id> --why w`",
    decision: "run `self decide retract <id> --why w` (or `decide decline` for a proposal)",
    convention: "run `self convention drop <id> --why w`",
    objective: "run `self objective close <id> --as dropped --why w` (or `objective decline` for a proposal)",
    milestone: "run `self milestone drop <id> --why w`",
    work: "run `self work retire <id> --why w` (or `work decline` for a proposal)"
};

/* ── the read verbs ────────────────────────────────────────────────── */

function stateList({ values }: CommandInput<typeof SCOPE_OPTIONS>): CommandOutput
{
    const scope = readScopes(process.cwd(), values)[0];
    // Current records only: done and retired outcomes left the direction the
    // list carries — `state show` and search still answer for them. What the
    // list holds is what renders here (#181 D2), so a record that moved to
    // another project has left it and one moved in has joined it.
    const live = workspaceModels(scope.storeDir, scope.project)
        .flatMap((model) => model.entities.filter((entity) => rendersIn(entity, model.slug, scope.project)))
        .filter(isCurrent);
    // An empty list keeps its own wording and gains nothing under it: "no live
    // entities" already states the size, in the words that also say what the
    // project looks like.
    return [{
        kind: "listing",
        rows: live.length === 0 ? ["no live entities"] : orderEntities(live).map(stateLine),
        total: live.length,
        noun: "live entity",
        nouns: "live entities"
    }];
}

// The page answers for any record this project resolves (#181 D5): its own,
// whatever project they render in, plus the records scoped in from elsewhere.
// A record that moved keeps its page — reading it is how a caller finds out
// where it went. `--history` answers with that record's own events instead:
// history is per-entity and explicit (#212 R3), so it is read here rather than
// on a verb of its own.
function stateShow({ values, positionals }: CommandInput<typeof SHOW_OPTIONS>): CommandOutput
{
    const scope = readScopes(process.cwd(), values)[0];
    const records = allRecords(workspaceModels(scope.storeDir, scope.project));
    const found = requirePlaced(resolvableRecords(records, scope.project), positionals[0],
        "state show <id> [--history [--page n]] [--project <slug>]", FIND_WITH_SEARCH);
    if (values.history !== true)
    {
        return [{ kind: "document", plain: () => renderEntity(found).split("\n") }];
    }
    return historyOutput({
        id: found.entity.id,
        storeDir: scope.storeDir,
        owner: found.owner,
        project: values.project ?? scope.project,
        command: "state",
        model: found.model,
        successor: found.entity.supersededBy
    }, values.page);
}

function stateLine(entity: EntityState): string
{
    const labels = entity.labels.length === 0 ? "-" : entity.labels.join(",");
    const place = entity.priority === undefined ? entity.exposure : `${entity.exposure} p${entity.priority}`;
    const mark = entity.status === "proposed" ? "  (proposed)" : "";
    return `${entity.id}  ${labels}  ${place}  ${truncate(entity.text, 70)}${mark}`;
}

// One declared criterion and what is known about it: its `cN` address and
// text, how it is verified, whose task it is, and what it waits on. The
// shipped `covered:` line below states the claims and is unchanged — every
// judgment stays on record, in landing order, while this says where the
// criterion stands now.
function criterionLines(criterion: CriterionState): string[]
{
    const blocked = criterion.blocked;
    return [
        `criterion: ${criterion.id} ${criterion.text}`,
        ...(criterion.verify === undefined ? [] : [`  verify: ${criterion.verify}`]),
        ...(criterion.owner === undefined ? [] : [`  owner: ${criterion.owner}`]),
        ...(blocked === undefined ? []
            : [`  blocked: on ${blocked.on}${blocked.why === undefined ? "" : ` — ${blocked.why}`}`])
    ];
}

function renderEntity(found: Placed): string
{
    const entity = found.entity;
    const lines = placementLines(found);
    optional(lines, "from", entity.from);
    optional(lines, "why", entity.why);
    optional(lines, "target", entity.target);
    optional(lines, "artifact", entity.artifact);
    entity.criterionStates.forEach((criterion) => lines.push(...criterionLines(criterion)));
    entity.covered.forEach((claim) =>
        lines.push(`covered: ${claim.criterion} — ${claim.why} (${claim.actor} ${claim.ts.slice(0, 10)}${claim.work === undefined ? "" : `, ${claim.work}`})`));
    entity.links.forEach((link) => lines.push(`link: ${link.type} ${link.target}`));
    if (entity.execution !== undefined)
    {
        lines.push(`working: ${executionSummary(entity.execution)}`);
    }
    optional(lines, "superseded by", entity.supersededBy);
    optional(lines, "closed", entity.closedWhy);
    if (entity.pending !== undefined)
    {
        lines.push(`pending placement: ${pendingSummary(entity.pending)} — confirm with \`self state confirm ${entity.id}\``);
    }
    lines.push(`recorded: ${entity.ts.slice(0, 10)}`);
    return lines.join("\n");
}

// The head of the page: what the record is, and where it stands. `stored in`
// is named only where a record renders in one project while its events live in
// another's log (#181 D1) — a reader deciding where to write is owed the log
// that owns it.
function placementLines(found: Placed): string[]
{
    const entity = found.entity;
    const lines = [
        `${entity.id}  ${entity.status}${entity.source === undefined ? "" : `  (from ${entity.source})`}`,
        `text: ${entity.text}`,
        `labels: ${entity.labels.join(", ") || "-"}`,
        `placement: ${entity.scope} · ${entity.exposure}${entity.priority === undefined ? "" : ` · priority ${entity.priority}`}`
    ];
    if (scopeTarget(entity, found.owner) !== found.owner)
    {
        lines.push(`stored in: ${found.owner}`);
    }
    return lines;
}

function optional(lines: string[], name: string, value: string | undefined): void
{
    if (value !== undefined)
    {
        lines.push(`${name}: ${value}`);
    }
}

function truncate(text: string, max: number): string
{
    return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

/* ── argument validation ───────────────────────────────────────────── */

// Exact id first, then a unique prefix — a goal or decision entity carries a
// 26-character event id nobody should have to type whole.
function requireEntity(model: ProjectModel, value: string | undefined, usage: string): EntityState
{
    const wanted = requireText(value, usage);
    const exact = model.entities.find((item) => item.id === wanted);
    if (exact !== undefined)
    {
        return exact;
    }
    const matches = model.entities.filter((item) => item.id.startsWith(wanted));
    if (matches.length > 1)
    {
        throw new CliError(`id "${wanted}" is ambiguous (${matches.length} entities match) — spell more of it`);
    }
    if (matches.length === 0)
    {
        throw new CliError(`unknown entity "${wanted}" — run \`self state list\` for ids`);
    }
    return matches[0];
}

// Whether `requireEntity` would find anything here — the same rule, asked of a
// whole project rather than of one record, so `recordOwner` picks the project
// whose lookup is about to succeed. An id two entities of one project answer to
// still holds: the ambiguity is that project's to refuse, and refusing it here
// would send the reader to a project that does not have the record at all.
function holdsEntity(model: ProjectModel, wanted: string): boolean
{
    return model.entities.some((item) => item.id === wanted || item.id.startsWith(wanted));
}

// The same resolution rule as `requireEntity`, over the records of every
// project a placement may speak about (#181 D5). Exact id first, then a unique
// prefix; a prefix two projects both answer to says nothing about which record
// was meant, so it is refused rather than guessed.
function requirePlaced(records: Placed[], value: string | undefined, usage: string, hint = FIND_BY_LISTING): Placed
{
    const wanted = requireText(value, usage);
    const exact = records.filter((item) => item.entity.id === wanted);
    const matches = exact.length > 0 ? exact : records.filter((item) => item.entity.id.startsWith(wanted));
    if (matches.length > 1)
    {
        throw new CliError(`id "${wanted}" is ambiguous (${matches.length} entities match) — spell more of it`);
    }
    if (matches.length === 0)
    {
        refuseCarried(records, wanted);
        throw new CliError(`unknown entity "${wanted}" — ${hint}`);
    }
    return matches[0];
}

// A placement moves a record the list already shows; a `show` reaches records
// the list does not, including the ones context left out — so search is what
// finds an id there (#212 T6.6).
const FIND_BY_LISTING = "run `self state list` for ids";
const FIND_WITH_SEARCH = 'run `self search "<text>"` to find one, or `self state list` for the rendered ids';

// A report and an artifact are carried by a work unit, never placed on their
// own: they move when the unit moves, so naming one here is answered with the
// record that actually has a placement rather than with "unknown id".
function refuseCarried(records: Placed[], wanted: string): void
{
    for (const model of new Set(records.map((item) => item.model)))
    {
        for (const work of model.works)
        {
            const kind = work.reports.some((report) => report.id === wanted) ? "report"
                : work.artifacts.some((artifact) => artifact.id === wanted) ? "artifact" : null;
            if (kind !== null)
            {
                const article = kind === "artifact" ? "an" : "a";
                throw new CliError(`${wanted} is ${article} ${kind} of ${work.id} — ${article} ${kind} is not independently `
                    + `placed; it moves with its work unit, so place ${work.id} instead`);
            }
        }
    }
}

// `--supersedes <id>` is the one spelling every add verb takes, and here it is
// the edge `--link supersedes:<id>` already records — the same parse, the same
// refusals. One target named in both spellings states one intent and records
// one link; repeating a single spelling is still the typo `parseLinks` names.
function supersedeLinks(model: ProjectModel, raw: string[], supersedes: string[]): EntityLink[]
{
    const links = parseLinks(model, raw);
    for (const target of supersedes)
    {
        const link = parseLink(model, `supersedes:${target}`);
        if (!links.some((item) => item.type === link.type && item.target === link.target))
        {
            links.push(link);
        }
    }
    return links;
}

function parseLinks(model: ProjectModel, raw: string[]): EntityLink[]
{
    const links = raw.map((item) => parseLink(model, item));
    for (const [index, link] of links.entries())
    {
        if (links.findIndex((item) => item.type === link.type && item.target === link.target) !== index)
        {
            throw new CliError(`--link ${link.type}:${link.target} is repeated — one edge is one link`);
        }
    }
    return links;
}

// `--link [type:]<id>` — a bare id relates. A supersedes link is the
// replacement transition, so its target must be a live record this verb owns:
// the preset kinds are replaced through their own verbs.
function parseLink(model: ProjectModel, raw: string): EntityLink
{
    const colon = raw.indexOf(":");
    const type = colon < 0 ? "relates" : raw.slice(0, colon);
    const target = colon < 0 ? raw : raw.slice(colon + 1);
    if (!(LINK_TYPES as readonly string[]).includes(type))
    {
        throw new CliError(`"${type}" is not a link type — use member-of:<id>, supersedes:<id>, or relates:<id>`);
    }
    if (target === "")
    {
        throw new CliError(`--link ${raw} names no entity — a link points at another entity's id`);
    }
    const entity = model.entities.find((item) => item.id === target);
    if (entity === undefined)
    {
        throw new CliError(`unknown entity "${target}" — run \`self state list\` for ids`);
    }
    if (type === "supersedes")
    {
        requireSupersedable(model, entity);
    }
    return { type: type as LinkType, target };
}

// A supersession replaces a live record this verb owns: the preset kinds are
// replaced through their own add verbs, which the shared table names.
function requireSupersedable(model: ProjectModel, entity: EntityState): void
{
    requireSupersedeKind(model.entities, entity.id, "entity");
    if (!isLive(entity))
    {
        throw new CliError(`${entity.id} was already ${entity.status} — nothing is left to supersede`);
    }
}

// Sparse whole numbers (#197 §3): 0 is the top of context and gaps leave room
// to insert later. Anything else is refused rather than rounded — including a
// number too large to keep exactly, which would fold back as a different
// priority than the one this verb confirmed.
export function validPriority(value: string): number
{
    const priority = Number(value.trim());
    if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(priority))
    {
        throw new CliError(`--priority takes a whole number, 0 or higher, small enough to keep exactly — "${value}" is not one`);
    }
    return priority;
}

export function validExposure(value: string): Exposure
{
    if (!(EXPOSURES as readonly string[]).includes(value))
    {
        throw new CliError(`"${value}" is not an exposure — use full (whole text in context), index (one line), or search (found only by search)`);
    }
    return value as Exposure;
}

// A scope names where a record renders (#181 D1): omit the flag for this
// project, name a registered slug for another, `workspace` for all of them.
// The `project` keyword is refused by name rather than read as the omission it
// is equivalent to (D6) — silently accepting it would leave the retired word
// alive in scripts and agent habits with nothing ever saying it is gone.
function validScope(ctx: ProjectContext, raw: string): string
{
    const value = raw.trim();
    if (/^project$/i.test(value))
    {
        throw new CliError('--scope project was retired — omit --scope to place a record in the project you are in, '
            + 'name another registered project with `--scope <slug>`, or `--scope workspace` for every project');
    }
    if (value === "")
    {
        throw new CliError("--scope takes where the record renders — a registered project's slug, or workspace; it cannot be empty");
    }
    if (value.startsWith("workspace="))
    {
        throw new CliError("--scope workspace takes no value — it already means every registered project");
    }
    return value === "workspace" ? value : requireScopeProject(ctx, value);
}

function requireScopeProject(ctx: ProjectContext, slug: string): string
{
    const slugs = readRegistry(ctx.storeDir).map((entry) => entry.slug);
    if (!slugs.includes(slug))
    {
        throw new CliError(`"${slug}" is not a registered project — run \`self project\` to list the slugs, `
            + "or --scope workspace to render the record in every project");
    }
    // A placement names where a record renders, and an archived project renders
    // nowhere (#283): placing a record there would file it out of sight rather
    // than move it.
    refuseArchived(ctx.storeDir, slug, "a record placed there would render nowhere");
    return slug;
}

function validText(value: string, flag: string, what: string): string
{
    if (value.trim() === "")
    {
        throw new CliError(`${flag} takes ${what} — it cannot be empty`);
    }
    return value.trim();
}
