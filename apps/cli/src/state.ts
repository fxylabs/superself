// The raw verb of the state engine (#197 §7): record, confirm, retract and
// read entities without a preset. The preset record kinds — goal, decision,
// convention, objective, milestone — keep their own verbs and vocabulary;
// this surface is the extensibility promise: user-defined labels over the
// same record kind, folded by `entities.ts` into one view.

import { required, requireText, Requirement } from "./args.js";
import { branch, Command, CommandInput, leaf } from "./contract.js";
import { validDate } from "./dates.js";
import {
    DEMOTION_TARGET,
    EntityLink,
    EntityScope,
    EntitySource,
    EntityState,
    executionSummary,
    Exposure,
    EXPOSURES,
    isCurrent,
    isDemotion,
    isLive,
    LINK_TYPES,
    LinkType,
    orderEntities,
    pendingSummary,
    requireSupersedeKind,
    tierCharacters,
    uncoveredCriteria
} from "./entities.js";
import { bareRevisionRefusal, requireRevision } from "./gitutil.js";
import { entityId } from "./ids.js";
import { buildModel, ProjectModel } from "./model.js";
import {
    ProjectContext,
    readRegistry,
    readScopes,
    readStoreConfig,
    requireProject,
    retentionCaps,
    RetentionCaps,
    SCOPE_OPTIONS,
    tokenScale,
    TokenScale
} from "./paths.js";
import { makeEvent, recordEvent, recordEvents } from "./pipeline.js";
import { recordRetirement, retirementIntent, supersedeTargets } from "./retirement.js";
import { countCharacters, tokensOf } from "./style.js";
import { CliError, EventRefs, SelfEvent } from "./types.js";

const STATE_USAGE = 'usage: self state add "<text>" | show <id> | list | place <id> | confirm <id> | retract <id> --why w'
    + ' | cover <id> --criterion c --why w | start <id> | block <id> | unblock <id> | done <id> --report r | retire <id> --why w';
const ADD_USAGE = 'state add "<text>" [--label l] [--priority n] [--exposure full|index|search] [--scope project|workspace] '
    + "[--target YYYY-MM-DD] [--criteria c] [--supersedes <id>] [--link [type:]<id>] [--why w] [--proposed] [--demote <id>]";
const PLACE_USAGE = "state place <id> [--priority <n>] [--exposure full|index|search] [--scope project|workspace] "
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

const COVER_OPTIONS = {
    criterion: { type: "string" },
    why: { type: "string" },
    evidence: { type: "string", multiple: true },
    work: { type: "string" }
} as const;

const WHY_OPTION = { why: { type: "string" } } as const;

const BLOCK_OPTIONS = { on: { type: "string" }, why: { type: "string" } } as const;

const DONE_OPTIONS = { report: { type: "string" } } as const;

const RETIRE_OPTIONS = { why: { type: "string" }, successor: { type: "string" } } as const;

// What each of these verbs cannot run without, declared once for the gate that
// refuses them together and the help page that states them (#106).
const WHY_NO_LONGER_HOLDS: Requirement = { flags: ["why"], hint: "why the record no longer holds" };

const RETIRE_WHY: Requirement = { flags: ["why"], hint: "why the outcome was given up or moved" };

const DONE_REPORT: Requirement = { flags: ["report"], hint: "what verifiably happened — done must carry evidence" };

const COVERAGE_REQUIRED: Requirement[] = [
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
            syntax: 'state add "<text>" [--label l] [--priority n] [--exposure full|index|search] [--scope project|workspace]',
            description: ["record one raw entity; --supersedes <id> replaces an earlier one"],
            verbs: ["add"]
        },
        { syntax: "state show <id> [--project <slug>]", description: ["print an entity's current values"], verbs: ["show"] },
        {
            syntax: "state place <id> [--priority <n>] [--exposure full|index|search] [--scope project|workspace]",
            description: ["move an entity in context: render order, render form, scope; a demotion needs --why"],
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
        "resolves to. --scope is a placement value, not a read scope: a",
        "workspace-scoped entity renders in every project's context while its",
        "events stay in this project's store.",
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
        "  --label <text>        free label, repeatable; presets use goal, objective, convention, …",
        "  --priority <n>        render order: a whole number, 0 first; leave gaps (0, 10, 20)",
        "  --exposure <form>     how context renders it: full, index, or search",
        "  --scope <scope>       project (this project's context, the default) or workspace",
        "                        (every project's context); caps count per scope",
        "  --target <date>       a YYYY-MM-DD deadline for the derived views to judge",
        "  --criteria <text>     an exit criterion that gates done claims, repeatable",
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
            leaf("add", ADD_OPTIONS, 1, stateAdd),
            leaf("show", SCOPE_OPTIONS, 1, stateShow),
            leaf("place", PLACE_OPTIONS, 1, statePlace),
            leaf("confirm", {}, 1, stateConfirm),
            leaf("retract", WHY_OPTION, 1, stateRetract, { requires: [WHY_NO_LONGER_HOLDS] }),
            leaf("cover", COVER_OPTIONS, 1, stateCover, { requires: COVERAGE_REQUIRED }),
            leaf("start", {}, 1, stateStart),
            leaf("block", BLOCK_OPTIONS, 1, stateBlock),
            leaf("unblock", {}, 1, stateUnblock),
            leaf("done", DONE_OPTIONS, 1, stateDone, { requires: [DONE_REPORT] }),
            leaf("retire", RETIRE_OPTIONS, 1, stateExecRetire, { requires: [RETIRE_WHY] })
        ]
    })
};

/* ── the write verbs ───────────────────────────────────────────────── */

// The label an alias verb records, and the placement it defaults to — the
// merged alias-table row, declared structurally so this module never imports
// the table that reads it back through `aliasEntityAdd`.
export interface AliasDefaults
{
    label: string;
    priority?: number;
    exposure: Exposure;
}

function stateAdd({ values, positionals }: CommandInput<typeof ADD_OPTIONS>): void
{
    entityAdd(values, positionals, undefined);
}

// The add path a table-resolved verb runs (#207 A2): the row supplies the
// label and the default placement, explicit flags beat it (A8), and
// everything else — caps, links, criteria, proposals — is the raw verb's.
export function aliasEntityAdd(row: AliasDefaults, { values, positionals }: CommandInput<typeof ADD_OPTIONS>): void
{
    entityAdd(values, positionals, row);
}

function entityAdd(values: CommandInput<typeof ADD_OPTIONS>["values"], positionals: string[], row: AliasDefaults | undefined): void
{
    const ctx = requireProject(process.cwd());
    const text = requireText(positionals[0], row === undefined ? ADD_USAGE : `${row.label} add "<text>"`);
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const exposure = values.exposure !== undefined ? validExposure(values.exposure) : row?.exposure ?? "index";
    const scope = validScope(values.scope ?? "project");
    const config = readStoreConfig(ctx.storeDir);
    const caps = retentionCaps(config);
    const scale = tokenScale(config);
    const usage = usageReader(ctx, model, scale);
    const demotions = demotionsFor(model, values.demote ?? [], tierOf(scope, exposure), undefined, row === undefined ? ADD_USAGE : `${row.label} add "<text>"`);
    requireRoom(usage, caps, tierOf(scope, exposure), countCharacters(text), demotions, scale);
    requireDemotionRoom(usage, caps, scope, demotions, 0, scale);
    const id = entityId();
    const proposed = values.proposed === true;
    const payload = addPayload(model, id, text, exposure, scope, values, row);
    // A proposal displaces nothing: its supersedes links wait for the confirm
    // that makes them real, so the gate belongs there rather than here.
    const displaced = proposed ? [] : supersedeTargets(payload);
    recordRetirement(ctx, retirementIntent(model, "supersede", displaced), model,
        (confirmation) => [
            makeEvent(ctx.project, proposed ? "entity.proposed" : "entity.confirmed",
                confirmation === undefined ? payload : { ...payload, confirmation }, undefined, !proposed),
            ...demotionEvents(ctx.project, demotions, id, proposed)
        ],
        `${id} ${text}`);
    console.log(id);
}

function addPayload(
    model: ProjectModel,
    id: string,
    text: string,
    exposure: Exposure,
    scope: EntityScope,
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
        criteria: (values.criteria ?? []).map((criterion) => validText(criterion, "--criteria", "one criterion's text")),
        exposure,
        scope
    };
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
    return payload;
}

function statePlace({ values, positionals }: CommandInput<typeof PLACE_OPTIONS>): void
{
    const ctx = requireProject(process.cwd());
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const entity = requirePlaceable(model, positionals[0]);
    const priority = values.priority === undefined ? undefined : validPriority(values.priority);
    const exposure = values.exposure === undefined ? undefined : validExposure(values.exposure);
    const scope = values.scope === undefined ? undefined : validScope(values.scope);
    requirePlacementChange(entity, priority, exposure, scope);
    const why = requireDemotionWhy(entity, exposure, values.why);
    const config = readStoreConfig(ctx.storeDir);
    const caps = retentionCaps(config);
    const scale = tokenScale(config);
    const usage = usageReader(ctx, model, scale);
    const entered = enteredTier(entity, exposure, scope);
    const demotions = demotionsFor(model, values.demote ?? [], entered, entity.id, PLACE_USAGE);
    requireRoom(usage, caps, entered, countCharacters(entity.text), demotions, scale);
    // The room the placed record itself frees when it leaves that scope's
    // index for full, so a swap at an exactly-full cap still passes.
    const vacates = entered !== undefined && entity.scope === entered.scope && entity.exposure === "index"
        ? countCharacters(entity.text) : 0;
    requireDemotionRoom(usage, caps, entered?.scope ?? entity.scope, demotions, vacates, scale);
    const proposed = values.proposed === true;
    const events = [
        makeEvent(ctx.project, "entity.placed", placePayload(entity.id, priority, exposure, scope, why, proposed), undefined, !proposed),
        ...demotionEvents(ctx.project, demotions, entity.id, proposed)
    ];
    recordEvents(ctx, events, `${entity.id} ${entity.text}`);
}

function placePayload(entity: string, priority: number | undefined, exposure: Exposure | undefined, scope: EntityScope | undefined, why: string | undefined, proposed: boolean): Record<string, unknown>
{
    const payload: Record<string, unknown> = { entity };
    if (priority !== undefined)
    {
        payload.priority = priority;
    }
    if (exposure !== undefined)
    {
        payload.exposure = exposure;
    }
    if (scope !== undefined)
    {
        payload.scope = scope;
    }
    if (why !== undefined)
    {
        payload.why = why;
    }
    if (proposed)
    {
        payload.proposed = true;
    }
    return payload;
}

// Placement moves live, confirmed records: a proposal has nothing rendered to
// move yet, and a withdrawn or replaced record no longer renders at all.
function requirePlaceable(model: ProjectModel, value: string | undefined): EntityState
{
    const entity = requireEntity(model, value, PLACE_USAGE);
    if (entity.status === "proposed")
    {
        throw new CliError(`${entity.id} is still proposed — placement moves confirmed records; confirm it first, or state its placement at add time`);
    }
    if (entity.status === "retracted")
    {
        throw new CliError(`${entity.id} was retracted — a withdrawn record no longer renders, so it has no placement to change`);
    }
    if (entity.status === "superseded")
    {
        throw new CliError(`${entity.id} was superseded by ${entity.supersededBy ?? "a later record"} — place the successor instead`);
    }
    return entity;
}

function requirePlacementChange(entity: EntityState, priority: number | undefined, exposure: Exposure | undefined, scope: EntityScope | undefined): void
{
    if (priority === undefined && exposure === undefined && scope === undefined)
    {
        throw new CliError("state place changes placement — pass --priority <n>, --exposure full|index|search, or both");
    }
    if ((exposure === undefined || exposure === entity.exposure)
        && (priority === undefined || priority === entity.priority)
        && (scope === undefined || scope === entity.scope))
    {
        throw new CliError(`${entity.id} already sits at that placement — nothing changes`);
    }
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

// One capped tier: an exposure at a scope. Caps count per scope value
// (#207 D4) — a project tier and the workspace tier fill and gate
// independently — and search is unbounded by design at either scope: it
// renders nothing, so an add into it, and any move toward it, passes without
// gating. That open floor is what keeps a store past its caps from ever
// wedging: a chain of demotions always terminates at search.
interface CappedTier
{
    scope: EntityScope;
    tier: "full" | "index";
}

function tierOf(scope: EntityScope, exposure: Exposure): CappedTier | undefined
{
    return exposure === "search" ? undefined : { scope, tier: exposure };
}

// Which capped tier a placement moves its record into. Direction does not
// matter: a full → index demotion enters index exactly as a promotion does
// and can overfill it the same way, and a scope change enters the other
// scope's tier at the record's exposure. Any move whose destination pair is
// the one the record already holds — or whose destination is search — enters
// nothing.
function enteredTier(entity: EntityState, exposure: Exposure | undefined, scope: EntityScope | undefined): CappedTier | undefined
{
    const toScope = scope ?? entity.scope;
    const toExposure = exposure ?? entity.exposure;
    if (toExposure === "search" || (toScope === entity.scope && toExposure === entity.exposure))
    {
        return undefined;
    }
    return { scope: toScope, tier: toExposure };
}

// What a capped tier currently holds, in tokens. The project tiers count this
// project's entities; the workspace tier is one rendered set across every
// registered project (#207 D1), so its usage counts workspace-scoped entities
// from every store — the entity's events stay in their home store, and only
// the count travels. Characters are summed across stores and converted once,
// so the answer never drifts by a rounding per store. Memoized per
// invocation: the folds behind it are not free.
type UsageReader = (scope: EntityScope, tier: "full" | "index") => number;

function usageReader(ctx: ProjectContext, model: ProjectModel, scale: TokenScale): UsageReader
{
    const cache = new Map<string, number>();
    return (scope, tier) =>
    {
        const key = `${scope} ${tier}`;
        const cached = cache.get(key);
        if (cached !== undefined)
        {
            return cached;
        }
        let characters = tierCharacters(model.entities, scope, tier);
        if (scope === "workspace")
        {
            for (const entry of readRegistry(ctx.storeDir).filter((item) => item.slug !== ctx.project))
            {
                characters += tierCharacters(buildModel(ctx.storeDir, entry.slug, new Date()).entities, scope, tier);
            }
        }
        const total = tokensOf(characters, scale.perCharacter);
        cache.set(key, total);
        return total;
    };
}

// Both capped tiers are measured the same way now (#213), so one check answers
// for both: what the tier holds in tokens, what this text adds, and what the
// named demotions free.
function requireRoom(usage: UsageReader, caps: RetentionCaps, entered: CappedTier | undefined,
    adding: number, demotions: EntityState[], scale: TokenScale): void
{
    if (entered === undefined)
    {
        return;
    }
    const cap = entered.tier === "full" ? caps.full : caps.index;
    requireTokenRoom(usage, entered, cap, tokensOf(adding, scale.perCharacter), demotions, scale);
}

// One refusal hands the whole contract: the cap, what the tier holds, what
// this adds, and the exact command shape that names a demotion. Every number
// is in tokens, and an unmeasured scale says so — a caller choosing what to
// demote is owed a real number rather than a row count (#213).
function requireTokenRoom(usage: UsageReader, entered: CappedTier, cap: number,
    adding: number, demotions: EntityState[], scale: TokenScale): void
{
    const held = usage(entered.scope, entered.tier);
    if (held + adding <= cap)
    {
        requireDemotionsNeeded(demotions, entered.scope, entered.tier);
        return;
    }
    if (demotions.length === 0)
    {
        throw new CliError(`the ${entered.scope} ${entered.tier} tier holds ${held} of ${cap} tokens `
            + `and this text adds ${adding} more${estimateNote(scale)} — name what demotes: pass `
            + `\`--demote <id>\` (that ${entered.tier} entity moves to ${DEMOTION_TARGET[entered.tier]}), or demote `
            + `first with \`self state place <id> --exposure ${DEMOTION_TARGET[entered.tier]} --why "<reason>"\``);
    }
    const freed = tokensOf(demotions.reduce((sum, item) => sum + countCharacters(item.text), 0), scale.perCharacter);
    if (held - freed + adding > cap)
    {
        throw new CliError(`still ${held - freed + adding - cap} tokens over the ${cap}-token ${entered.tier} cap `
            + `after the named demotion${demotions.length === 1 ? "" : "s"}, which free ${freed} — name more with --demote`);
    }
}

// Said once wherever a token number is printed, so a reader always knows
// whether the figure came from a measurement or from the shipped estimate.
function estimateNote(scale: TokenScale): string
{
    return scale.measured ? "" : ` (estimated at ${scale.perCharacter} tokens per character; \`self tokens\` records a measurement)`;
}

// A named full → index demotion enters the index tier itself — the gating
// rule has no exception for the remedy — so the pair is refused while its
// destination lacks room, toward the drain that always fits: index → search.
// `vacates` is the seat the placed record itself frees when it leaves that
// scope's index for full, so a swap at an exactly-full cap still passes.
function requireDemotionRoom(usage: UsageReader, caps: RetentionCaps, scope: EntityScope,
    demotions: EntityState[], vacates: number, scale: TokenScale): void
{
    const arriving = demotions.filter((item) => item.exposure === "full");
    if (arriving.length === 0)
    {
        return;
    }
    const entering = tokensOf(arriving.reduce((sum, item) => sum + countCharacters(item.text), 0), scale.perCharacter);
    const after = usage(scope, "index") + entering - tokensOf(vacates, scale.perCharacter);
    if (after > caps.index)
    {
        throw new CliError(`the named demotion${arriving.length === 1 ? "" : "s"} would put the ${scope} index tier at `
            + `${after} of ${caps.index} tokens${estimateNote(scale)} — free index room first with `
            + '`self state place <id> --exposure search --why "<reason>"`');
    }
}

// One seat movement a confirm would apply: where the record stands now (a
// proposed record stands nowhere), and where it would sit — scope and
// exposure both, because a pending placement can move either.
interface SeatMove
{
    from?: { scope: EntityScope; exposure: Exposure };
    to: { scope: EntityScope; exposure: Exposure };
    characters: number;
}

function unitMoves(unit: ConfirmMember[]): SeatMove[]
{
    return unit.flatMap((member): SeatMove[] =>
    {
        const characters = countCharacters(member.entity.text);
        const entity = member.entity;
        if (member.kind === "record")
        {
            return [{ to: { scope: entity.scope, exposure: entity.exposure }, characters }];
        }
        const to = { scope: entity.pending?.scope ?? entity.scope, exposure: entity.pending?.exposure ?? entity.exposure };
        return to.scope === entity.scope && to.exposure === entity.exposure
            ? []
            : [{ from: { scope: entity.scope, exposure: entity.exposure }, to, characters }];
    });
}

// What a confirm admits must fit at confirm time (review F2), judged as the
// unit's net movement (review F3): a tier the unit enters must end within
// its cap, credited with every seat the unit itself vacates there — the
// same crediting the write path does — under the same counts the write
// verbs gate on. A tier the unit only drains is never gated, so an over-cap
// store keeps its way down.
function requireUnitRoom(usage: UsageReader, caps: RetentionCaps, unit: ConfirmMember[], scale: TokenScale): void
{
    const moves = unitMoves(unit);
    for (const scope of ["project", "workspace"] as const)
    {
        for (const tier of ["full", "index"] as const)
        {
            requireTierRoom(usage, caps, { scope, tier }, moves, scale);
        }
    }
}

function requireTierRoom(usage: UsageReader, caps: RetentionCaps, at: CappedTier, moves: SeatMove[], scale: TokenScale): void
{
    const weigh = (move: SeatMove): number => tokensOf(move.characters, scale.perCharacter);
    const inTier = (seat: { scope: EntityScope; exposure: Exposure } | undefined): boolean =>
        seat !== undefined && seat.scope === at.scope && seat.exposure === at.tier;
    const entering = moves.filter((move) => inTier(move.to)).reduce((sum, move) => sum + weigh(move), 0);
    if (entering === 0)
    {
        return;
    }
    const held = usage(at.scope, at.tier);
    const cap = at.tier === "full" ? caps.full : caps.index;
    const leaving = moves.filter((move) => inTier(move.from)).reduce((sum, move) => sum + weigh(move), 0);
    if (held + entering - leaving > cap)
    {
        throw new CliError(`confirming this would put the ${at.scope} ${at.tier} tier over its cap `
            + `(${held} of ${cap} tokens held)${estimateNote(scale)} — `
            + `free room first with \`self state place <id> --exposure ${DEMOTION_TARGET[at.tier]} --why "<reason>"\``);
    }
}

// A demotion named where no cap demands one would demote a record as a side
// effect of an unrelated command — refused toward the direct verb instead.
function requireDemotionsNeeded(demotions: EntityState[], scope: EntityScope, tier: "full" | "index"): void
{
    if (demotions.length > 0)
    {
        throw new CliError(`the ${scope} ${tier} tier is not over its cap — nothing needs to demote; `
            + `demote directly with \`self state place <id> --exposure ${DEMOTION_TARGET[tier]} --why "<reason>"\``);
    }
}

function demotionsFor(model: ProjectModel, raw: string[], entered: CappedTier | undefined, exclude: string | undefined, usage: string): EntityState[]
{
    if (raw.length === 0)
    {
        return [];
    }
    if (entered === undefined)
    {
        throw new CliError("--demote frees room in the capped tier a record enters — this command enters none, so nothing needs to demote");
    }
    const demotions = raw.map((value) => requireDemotable(model, value, entered, exclude, usage));
    for (const [index, entity] of demotions.entries())
    {
        if (demotions.findIndex((item) => item.id === entity.id) !== index)
        {
            throw new CliError(`--demote ${entity.id} is repeated — one record frees its place once`);
        }
    }
    return demotions;
}

// A demotion frees a seat in the tier being entered, so it has to hold one:
// same scope, same exposure, confirmed, and in this project's store — a write
// verb records into the project it runs in, so a workspace seat held by
// another project's record frees from that project.
function requireDemotable(model: ProjectModel, value: string, entered: CappedTier, exclude: string | undefined, usage: string): EntityState
{
    const entity = requireEntity(model, value, usage);
    if (entity.id === exclude)
    {
        throw new CliError(`--demote ${entity.id} names the record being placed — another entity has to free the room`);
    }
    if (entity.status === "proposed")
    {
        throw new CliError(`--demote ${entity.id} is still proposed — it holds no place in the ${entered.tier} tier until confirmed`);
    }
    if (!isLive(entity))
    {
        throw new CliError(`--demote ${entity.id} was already ${entity.status} — it holds no place in the ${entered.tier} tier`);
    }
    if (entity.scope !== entered.scope)
    {
        throw new CliError(`--demote ${entity.id} is ${entity.scope}-scoped — the ${entered.scope} ${entered.tier} cap frees only by demoting ${entered.scope}-scoped records`);
    }
    if (entity.exposure !== entered.tier)
    {
        throw new CliError(`--demote ${entity.id} sits at ${entity.exposure} exposure — name a record at ${entered.tier} exposure, the tier being entered`);
    }
    return entity;
}

// The paired demotion, appended in the same write as the add or placement it
// makes room for: `refs.admits` is the machine-readable pairing the confirm
// surface applies the pair as one unit by, and the why says the same thing
// to the person reading it. --proposed marks both halves, so neither applies
// until a person answers.
function demotionEvents(project: string, demotions: EntityState[], admit: string, proposed: boolean): SelfEvent[]
{
    return demotions.map((entity) => makeEvent(project, "entity.placed", {
        entity: entity.id,
        exposure: DEMOTION_TARGET[entity.exposure as "full" | "index"],
        why: `demoted to admit ${admit} under the ${entity.exposure} cap`,
        ...(proposed ? { proposed: true } : {})
    }, { admits: admit }, !proposed));
}

function stateConfirm({ positionals }: CommandInput): void
{
    const ctx = requireProject(process.cwd());
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const entity = requireEntity(model, positionals[0], "state confirm <id>");
    const unit = confirmableUnit(model, entity);
    const config = readStoreConfig(ctx.storeDir);
    const scale = tokenScale(config);
    requireUnitRoom(usageReader(ctx, model, scale), retentionCaps(config), unit, scale);
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

function confirmEvent(project: string, member: ConfirmMember): SelfEvent
{
    const confirms = member.kind === "record" ? member.entity.id : member.entity.pending?.event ?? member.entity.id;
    return makeEvent(project, "entity.confirmed", { entity: member.entity.id }, { confirms }, true);
}

/* ── the coverage grammar (#207 C) ─────────────────────────────────── */

// One coverage claim: a declared criterion, judged covered with a reason, on
// any record that carries criteria — raw entities and the preset kinds alike,
// which is what makes `milestone met` sugar over this rather than a second
// grammar. The claim binds to the entity id: a superseding revision starts
// uncovered, and re-covering the successor is what `milestone recheck` does.
function stateCover({ values, positionals }: CommandInput<typeof COVER_OPTIONS>): void
{
    const ctx = requireProject(process.cwd());
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const entity = requireCoverable(model, positionals[0]);
    const criterion = resolveCriterion(entity, required(values.criterion));
    const why = required(values.why);
    if (entity.covered.some((claim) => claim.criterion === criterion))
    {
        throw new CliError(`${entity.id} "${criterion}" is already covered — a criterion is judged once per record; a superseding revision starts uncovered`);
    }
    recordCoverage(ctx, model, entity.id, criterion, why, values, "state cover");
}

// The one writer of `entity.covered` — `state cover`, `milestone met` and
// `milestone recheck` all land here, so the claim's shape cannot drift
// between the raw verb and its sugar (#207 C5).
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
    recordEvent(ctx, makeEvent(ctx.project, "entity.covered", { entity, criterion, why }, refs, true),
        `${entity} ${criterion} ${why}`);
}

function requireCoverable(model: ProjectModel, value: string | undefined): EntityState
{
    const entity = requireEntity(model, value, COVER_USAGE);
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

// Coverage cites a work unit the log knows; the milestone sugar tightens this
// to a linked one at its own surface.
function requireCitedWork(model: ProjectModel, id: string): string
{
    const work = model.works.find((item) => item.id === id);
    if (work === undefined)
    {
        throw new CliError(`unknown work id "${id}" — run \`self work\` to list ids`);
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
    recordRetirement(ctx, retirementIntent(model, "retract", [entity.id]), model,
        (confirmation) => [makeEvent(ctx.project, "entity.retracted", { entity: entity.id, why, confirmation }, { retracts: entity.id }, true)],
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

function stateStart({ positionals }: CommandInput): void
{
    const { ctx, entity } = executionTarget(positionals[0], "state start <id>");
    requireMovable(entity, "start");
    if (entity.execution?.status === "in-progress")
    {
        throw new CliError(`${entity.id} is already started`);
    }
    if (entity.execution?.status === "blocked")
    {
        throw new CliError(`${entity.id} is blocked — unblock it first with \`self state unblock ${entity.id}\``);
    }
    recordEvent(ctx, makeEvent(ctx.project, "entity.started", { entity: entity.id }), entity.text);
}

function stateBlock({ values, positionals }: CommandInput<typeof BLOCK_OPTIONS>): void
{
    const { ctx, entity } = executionTarget(positionals[0], 'state block <id> [--on <what>] [--why "<reason>"]');
    requireMovable(entity, "block");
    if (entity.execution?.status === "blocked")
    {
        throw new CliError(`${entity.id} is already blocked${entity.execution.why === undefined ? "" : ` — ${entity.execution.why}`}`);
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
    if (entity.execution?.status !== "blocked")
    {
        throw new CliError(`${entity.id} is not blocked — there is nothing to unblock`);
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

// The criteria gate, spelled once: `state done` and the preset done claims —
// `milestone reach`, `objective close --as reached` — refuse through the same
// check, naming the uncovered criteria and the verb that covers one.
export function requireCriteriaCovered(entity: EntityState): void
{
    const open = uncoveredCriteria(entity);
    if (open.length === 0)
    {
        return;
    }
    throw new CliError(`${entity.id} declared criteria its done claim is gated on, and these are uncovered — `
        + open.map((criterion) => `"${criterion}"`).join("; ")
        + ` — cover each with \`self state cover ${entity.id} --criterion "<c>" --why "<how>"\`, or retire the entity if the outcome was given up`);
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
    recordRetirement(ctx, retirementIntent(model, "retire", [entity.id]), model,
        (confirmation) => [makeEvent(ctx.project, "entity.retired", { ...payload, confirmation })],
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

function stateList({ values }: CommandInput<typeof SCOPE_OPTIONS>): void
{
    const scope = readScopes(process.cwd(), values)[0];
    // Current records only: done and retired outcomes left the direction the
    // list carries — `state show` and search still answer for them.
    const live = buildModel(scope.storeDir, scope.project, new Date()).entities.filter(isCurrent);
    if (live.length === 0)
    {
        console.log("no live entities");
        return;
    }
    for (const entity of orderEntities(live))
    {
        console.log(stateLine(entity));
    }
}

function stateShow({ values, positionals }: CommandInput<typeof SCOPE_OPTIONS>): void
{
    const scope = readScopes(process.cwd(), values)[0];
    const model = buildModel(scope.storeDir, scope.project, new Date());
    console.log(renderEntity(requireEntity(model, positionals[0], "state show <id> [--project <slug>]")));
}

function stateLine(entity: EntityState): string
{
    const labels = entity.labels.length === 0 ? "-" : entity.labels.join(",");
    const place = entity.priority === undefined ? entity.exposure : `${entity.exposure} p${entity.priority}`;
    const mark = entity.status === "proposed" ? "  (proposed)" : "";
    return `${entity.id}  ${labels}  ${place}  ${truncate(entity.text, 70)}${mark}`;
}

function renderEntity(entity: EntityState): string
{
    const lines = [
        `${entity.id}  ${entity.status}${entity.source === undefined ? "" : `  (from ${entity.source})`}`,
        `text: ${entity.text}`,
        `labels: ${entity.labels.join(", ") || "-"}`,
        `placement: ${entity.scope} · ${entity.exposure}${entity.priority === undefined ? "" : ` · priority ${entity.priority}`}`
    ];
    optional(lines, "why", entity.why);
    optional(lines, "target", entity.target);
    entity.criteria.forEach((criterion) => lines.push(`criterion: ${criterion}`));
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

export function validScope(value: string): EntityScope
{
    if (value !== "project" && value !== "workspace")
    {
        throw new CliError(`"${value}" is not a scope — use project (this project's context) or workspace (every project's context)`);
    }
    return value;
}

function validText(value: string, flag: string, what: string): string
{
    if (value.trim() === "")
    {
        throw new CliError(`${flag} takes ${what} — it cannot be empty`);
    }
    return value.trim();
}
