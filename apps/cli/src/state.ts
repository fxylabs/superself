// The raw verb of the state engine (#197 §7): record, confirm, retract and
// read entities without a preset. The preset record kinds — goal, decision,
// convention, objective, milestone — keep their own verbs and vocabulary;
// this surface is the extensibility promise: user-defined labels over the
// same record kind, folded by `entities.ts` into one view.

import { requireText } from "./args.js";
import { branch, Command, CommandInput, leaf } from "./contract.js";
import { validDate } from "./dates.js";
import {
    DEMOTION_TARGET,
    EntityLink,
    EntitySource,
    EntityState,
    executionSummary,
    Exposure,
    EXPOSURES,
    fullTierCharacters,
    indexTierCount,
    isDemotion,
    isLive,
    LINK_TYPES,
    LinkType,
    orderEntities,
    pendingSummary
} from "./entities.js";
import { entityId } from "./ids.js";
import { buildModel, ProjectModel } from "./model.js";
import { ProjectContext, readScopes, readStoreConfig, requireProject, retentionCaps, RetentionCaps, SCOPE_OPTIONS } from "./paths.js";
import { makeEvent, recordEvent, recordEvents } from "./pipeline.js";
import { countCharacters } from "./style.js";
import { CliError, SelfEvent } from "./types.js";

const STATE_USAGE = 'usage: self state add "<text>" | show <id> | list | place <id> | confirm <id> | retract <id> --why w'
    + ' | start <id> | block <id> | unblock <id> | done <id> --report r | retire <id> --why w';
const ADD_USAGE = 'state add "<text>" [--label l] [--priority n] [--exposure full|index|search] '
    + "[--target YYYY-MM-DD] [--criteria c] [--link [type:]<id>] [--why w] [--proposed] [--demote <id>]";
const PLACE_USAGE = "state place <id> [--priority <n>] [--exposure full|index|search] "
    + '[--why "<reason>"] [--proposed] [--demote <id>]';
const RETRACT_USAGE = 'state retract <id> --why "<why it no longer holds>"';

const ADD_OPTIONS = {
    label: { type: "string", multiple: true },
    priority: { type: "string" },
    exposure: { type: "string" },
    target: { type: "string" },
    criteria: { type: "string", multiple: true },
    link: { type: "string", multiple: true },
    why: { type: "string" },
    proposed: { type: "boolean" },
    demote: { type: "string", multiple: true }
} as const;

const PLACE_OPTIONS = {
    priority: { type: "string" },
    exposure: { type: "string" },
    why: { type: "string" },
    proposed: { type: "boolean" },
    demote: { type: "string", multiple: true }
} as const;

const WHY_OPTION = { why: { type: "string" } } as const;

const BLOCK_OPTIONS = { on: { type: "string" }, why: { type: "string" } } as const;

const DONE_OPTIONS = { report: { type: "string" } } as const;

const RETIRE_OPTIONS = { why: { type: "string" }, successor: { type: "string" } } as const;

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
            syntax: 'state add "<text>" [--label l] [--priority n] [--exposure full|index|search]',
            description: ["record one raw entity; --link supersedes:<id> replaces an earlier one"],
            verbs: ["add"]
        },
        { syntax: "state show <id> [--project <slug>]", description: ["print an entity's current values"], verbs: ["show"] },
        {
            syntax: "state place <id> [--priority <n>] [--exposure full|index|search]",
            description: ["move an entity in context: render order, render form; a demotion needs --why"],
            verbs: ["place"]
        },
        { syntax: "state confirm <id>", description: ["confirm a proposed entity, or a placement waiting on you"], verbs: ["confirm"] },
        { syntax: 'state retract <id> --why "<reason>"', description: ["withdraw an entity with nothing replacing it"], verbs: ["retract"] },
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
        "add, place, confirm, retract and the execution verbs (start, block,",
        "unblock, done, retire) write: they take no scope flag and record into the",
        "project they run in. list and show read for the project this directory",
        "resolves to; there is no --workspace form yet — workspace-scoped entities",
        "arrive with a later phase.",
        "",
        "the execution verbs record facts about doing, not assertions: no --proposed",
        "form exists on them, and each records its actor. done must carry evidence —",
        "--report states what verifiably happened — and an entity carrying criteria",
        "refuses done until every criterion is covered.",
        "",
        "a demotion — exposure moving toward less-rendered (full → index → search) —",
        "always records --why; a priority change alone is not one. Demotion out of",
        "full is human-owned: an agent passes --proposed, and the move waits until",
        "a person runs `state confirm <id>`.",
        "",
        "retention caps (config.json fullCap and indexCap; defaults 4,000 characters",
        "of full-exposure text and 50 index entities, per scope) gate add and place",
        "into a tier: past a cap the verb refuses until --demote names what frees",
        "the room. An agent adds --proposed to land the add and the demotion as a",
        "pair that waits on a person; rendering itself never refuses.",
        "",
        "  --label <text>        free label, repeatable; presets use goal, objective, convention, …",
        "  --priority <n>        render order: a whole number, 0 first; leave gaps (0, 10, 20)",
        "  --exposure <form>     how context renders it: full, index, or search",
        "  --target <date>       a YYYY-MM-DD deadline for the derived views to judge",
        "  --criteria <text>     an exit criterion that gates done claims, repeatable",
        "  --link [type:]<id>    typed edge, repeatable: --link supersedes:<id> replaces an",
        "                        earlier entity, member-of:<id> groups, relates:<id> (a bare id) refers",
        "  --why <text>          rationale recorded with the entity, its placement, its retraction,",
        "                        a block, or a retirement",
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
            leaf("retract", WHY_OPTION, 1, stateRetract),
            leaf("start", {}, 1, stateStart),
            leaf("block", BLOCK_OPTIONS, 1, stateBlock),
            leaf("unblock", {}, 1, stateUnblock),
            leaf("done", DONE_OPTIONS, 1, stateDone),
            leaf("retire", RETIRE_OPTIONS, 1, stateExecRetire)
        ]
    })
};

/* ── the write verbs ───────────────────────────────────────────────── */

function stateAdd({ values, positionals }: CommandInput<typeof ADD_OPTIONS>): void
{
    const ctx = requireProject(process.cwd());
    const text = requireText(positionals[0], ADD_USAGE);
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const exposure = validExposure(values.exposure ?? "index");
    const caps = retentionCaps(readStoreConfig(ctx.storeDir));
    const demotions = demotionsFor(model, values.demote ?? [], cappedTier(exposure), undefined, ADD_USAGE);
    requireRoom(model, caps, cappedTier(exposure), countCharacters(text), demotions);
    requireDemotionRoom(model, caps, demotions, false);
    const id = entityId();
    const proposed = values.proposed === true;
    const events = [
        makeEvent(ctx.project, proposed ? "entity.proposed" : "entity.confirmed", addPayload(model, id, text, exposure, values), undefined, !proposed),
        ...demotionEvents(ctx.project, demotions, id, proposed)
    ];
    recordEvents(ctx, events, `${id} ${text}`);
    console.log(id);
}

function addPayload(model: ProjectModel, id: string, text: string, exposure: Exposure, values: CommandInput<typeof ADD_OPTIONS>["values"]): Record<string, unknown>
{
    const payload: Record<string, unknown> = {
        entity: id,
        text,
        labels: (values.label ?? []).map((label) => validText(label, "--label", "the label's text")),
        links: parseLinks(model, values.link ?? []),
        criteria: (values.criteria ?? []).map((criterion) => validText(criterion, "--criteria", "one criterion's text")),
        exposure,
        scope: "project"
    };
    if (values.priority !== undefined)
    {
        payload.priority = validPriority(values.priority);
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
    requirePlacementChange(entity, priority, exposure);
    const why = requireDemotionWhy(entity, exposure, values.why);
    const caps = retentionCaps(readStoreConfig(ctx.storeDir));
    const tier = enteredTier(entity, exposure);
    const demotions = demotionsFor(model, values.demote ?? [], tier, entity.id, PLACE_USAGE);
    requireRoom(model, caps, tier, countCharacters(entity.text), demotions);
    requireDemotionRoom(model, caps, demotions, entity.exposure === "index");
    const proposed = values.proposed === true;
    const events = [
        makeEvent(ctx.project, "entity.placed", placePayload(entity.id, priority, exposure, why, proposed), undefined, !proposed),
        ...demotionEvents(ctx.project, demotions, entity.id, proposed)
    ];
    recordEvents(ctx, events, `${entity.id} ${entity.text}`);
}

function placePayload(entity: string, priority: number | undefined, exposure: Exposure | undefined, why: string | undefined, proposed: boolean): Record<string, unknown>
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

function requirePlacementChange(entity: EntityState, priority: number | undefined, exposure: Exposure | undefined): void
{
    if (priority === undefined && exposure === undefined)
    {
        throw new CliError("state place changes placement — pass --priority <n>, --exposure full|index|search, or both");
    }
    if ((exposure === undefined || exposure === entity.exposure) && (priority === undefined || priority === entity.priority))
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

/* ── the retention caps (#197 §4) ──────────────────────────────────── */

// The tiers the caps guard. Search is unbounded by design — it renders
// nothing — so an add into it, and any move toward it, passes without
// gating. That open floor is what keeps a store past its caps from ever
// wedging: a chain of demotions always terminates at search.
function cappedTier(exposure: Exposure): "full" | "index" | undefined
{
    return exposure === "search" ? undefined : exposure;
}

// Which capped tier a placement moves its record into. Direction does not
// matter: a full → index demotion enters index exactly as a promotion does
// and can overfill it the same way, so both are gated. A full → index move
// past the index cap names an index → search demotion beside it, and
// index → search itself enters nothing.
function enteredTier(entity: EntityState, exposure: Exposure | undefined): "full" | "index" | undefined
{
    if (exposure === undefined || exposure === entity.exposure || exposure === "search")
    {
        return undefined;
    }
    return exposure;
}

function requireRoom(model: ProjectModel, caps: RetentionCaps, tier: "full" | "index" | undefined, adding: number, demotions: EntityState[]): void
{
    if (tier === "full")
    {
        requireFullRoom(model, caps.full, adding, demotions);
    }
    else if (tier === "index")
    {
        requireIndexRoom(model, caps.index, demotions);
    }
}

// One refusal hands the whole contract: the cap, the current usage, and the
// exact command shape that names a demotion.
function requireFullRoom(model: ProjectModel, cap: number, adding: number, demotions: EntityState[]): void
{
    const usage = fullTierCharacters(model.entities, "project");
    if (usage + adding <= cap)
    {
        requireDemotionsNeeded(demotions, "full");
        return;
    }
    if (demotions.length === 0)
    {
        throw new CliError(`the project full tier holds ${usage} of ${cap} characters and this text adds ${adding} more — `
            + "name what demotes: pass `--demote <id>` (that full entity moves to index), "
            + 'or demote first with `self state place <id> --exposure index --why "<reason>"`');
    }
    const freed = demotions.reduce((sum, item) => sum + countCharacters(item.text), 0);
    if (usage - freed + adding > cap)
    {
        throw new CliError(`still ${usage - freed + adding - cap} characters over the ${cap}-character full cap `
            + `after the named demotion${demotions.length === 1 ? "" : "s"} — name more with --demote`);
    }
}

function requireIndexRoom(model: ProjectModel, cap: number, demotions: EntityState[]): void
{
    const usage = indexTierCount(model.entities, "project");
    if (usage < cap)
    {
        requireDemotionsNeeded(demotions, "index");
        return;
    }
    if (demotions.length === 0)
    {
        throw new CliError(`the project index tier holds ${usage} of ${cap} entities — `
            + "name what demotes: pass `--demote <id>` (that index entity moves to search), "
            + 'or demote first with `self state place <id> --exposure search --why "<reason>"`');
    }
    const over = usage - demotions.length + 1 - cap;
    if (over > 0)
    {
        throw new CliError(`still ${over} over the ${cap}-entity index cap after `
            + `${demotions.length} named demotion${demotions.length === 1 ? "" : "s"} — name more with --demote`);
    }
}

// A named full → index demotion enters the index tier itself — the gating
// rule has no exception for the remedy — so the pair is refused while its
// destination lacks room, toward the drain that always fits: index → search.
// `vacates` is the seat the placed record itself frees when it leaves index
// for full, so a swap at an exactly-full cap still passes.
function requireDemotionRoom(model: ProjectModel, caps: RetentionCaps, demotions: EntityState[], vacates: boolean): void
{
    const entering = demotions.filter((item) => item.exposure === "full").length;
    if (entering === 0)
    {
        return;
    }
    const after = indexTierCount(model.entities, "project") + entering - (vacates ? 1 : 0);
    if (after > caps.index)
    {
        throw new CliError(`the named demotion${entering === 1 ? "" : "s"} would put the project index tier at `
            + `${after} of ${caps.index} entities — free index room first with `
            + '`self state place <id> --exposure search --why "<reason>"`');
    }
}

// One seat movement a confirm would apply: where the record stands now (a
// proposed record stands nowhere), and where it would sit.
interface SeatMove
{
    from?: Exposure;
    to: Exposure;
    characters: number;
}

function unitMoves(unit: ConfirmMember[]): SeatMove[]
{
    return unit.flatMap((member): SeatMove[] =>
    {
        const characters = countCharacters(member.entity.text);
        if (member.kind === "record")
        {
            return [{ to: member.entity.exposure, characters }];
        }
        const to = member.entity.pending?.exposure;
        return to === undefined || to === member.entity.exposure
            ? []
            : [{ from: member.entity.exposure, to, characters }];
    });
}

// What a confirm admits must fit at confirm time (review F2), judged as the
// unit's net movement (review F3): a tier the unit enters must end within
// its cap, credited with every seat the unit itself vacates there — the
// same crediting the write path does — under the same counts the write
// verbs gate on. A tier the unit only drains is never gated, so an over-cap
// store keeps its way down.
function requireUnitRoom(model: ProjectModel, caps: RetentionCaps, unit: ConfirmMember[]): void
{
    for (const tier of ["full", "index"] as const)
    {
        requireTierRoom(model, caps, tier, unitMoves(unit));
    }
}

function requireTierRoom(model: ProjectModel, caps: RetentionCaps, tier: "full" | "index", moves: SeatMove[]): void
{
    const weigh = (move: SeatMove): number => tier === "full" ? move.characters : 1;
    const entering = moves.filter((move) => move.to === tier).reduce((sum, move) => sum + weigh(move), 0);
    if (entering === 0)
    {
        return;
    }
    const usage = tier === "full" ? fullTierCharacters(model.entities, "project") : indexTierCount(model.entities, "project");
    const cap = tier === "full" ? caps.full : caps.index;
    const leaving = moves.filter((move) => move.from === tier).reduce((sum, move) => sum + weigh(move), 0);
    if (usage + entering - leaving > cap)
    {
        throw new CliError(`confirming this would put the project ${tier} tier over its cap `
            + `(${usage} of ${cap} ${tier === "full" ? "characters" : "entities"} held) — `
            + `free room first with \`self state place <id> --exposure ${DEMOTION_TARGET[tier]} --why "<reason>"\``);
    }
}

// A demotion named where no cap demands one would demote a record as a side
// effect of an unrelated command — refused toward the direct verb instead.
function requireDemotionsNeeded(demotions: EntityState[], tier: "full" | "index"): void
{
    if (demotions.length > 0)
    {
        throw new CliError(`the project ${tier} tier is not over its cap — nothing needs to demote; `
            + `demote directly with \`self state place <id> --exposure ${DEMOTION_TARGET[tier]} --why "<reason>"\``);
    }
}

function demotionsFor(model: ProjectModel, raw: string[], tier: "full" | "index" | undefined, exclude: string | undefined, usage: string): EntityState[]
{
    if (raw.length === 0)
    {
        return [];
    }
    if (tier === undefined)
    {
        throw new CliError("--demote frees room in the capped tier a record enters — this command enters none, so nothing needs to demote");
    }
    const demotions = raw.map((value) => requireDemotable(model, value, tier, exclude, usage));
    for (const [index, entity] of demotions.entries())
    {
        if (demotions.findIndex((item) => item.id === entity.id) !== index)
        {
            throw new CliError(`--demote ${entity.id} is repeated — one record frees its place once`);
        }
    }
    return demotions;
}

function requireDemotable(model: ProjectModel, value: string, tier: "full" | "index", exclude: string | undefined, usage: string): EntityState
{
    const entity = requireEntity(model, value, usage);
    if (entity.id === exclude)
    {
        throw new CliError(`--demote ${entity.id} names the record being placed — another entity has to free the room`);
    }
    if (entity.status === "proposed")
    {
        throw new CliError(`--demote ${entity.id} is still proposed — it holds no place in the ${tier} tier until confirmed`);
    }
    if (!isLive(entity))
    {
        throw new CliError(`--demote ${entity.id} was already ${entity.status} — it holds no place in the ${tier} tier`);
    }
    if (entity.scope !== "project")
    {
        throw new CliError(`--demote ${entity.id} is workspace-scoped — the project ${tier} cap frees only by demoting project-scoped records`);
    }
    if (entity.exposure !== tier)
    {
        throw new CliError(`--demote ${entity.id} sits at ${entity.exposure} exposure — name a record at ${tier} exposure, the tier being entered`);
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
    requireUnitRoom(model, retentionCaps(readStoreConfig(ctx.storeDir)), unit);
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
    const why = requireText(values.why, RETRACT_USAGE);
    recordEvent(ctx, makeEvent(ctx.project, "entity.retracted", { entity: entity.id, why }, { retracts: entity.id }, true), entity.text);
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
// additionally gated on covering them. Raw entities have no coverage grammar
// yet — that arrives with the preset unification — so a criterion declared
// here holds the claim open until then. Done is allowed while blocked
// (ruling ①): completion is a judgment on the outcome, not on the block.
function stateDone({ values, positionals }: CommandInput<typeof DONE_OPTIONS>): void
{
    const { ctx, entity } = executionTarget(positionals[0], 'state done <id> --report "<what verifiably happened>"');
    requireMovable(entity, "done");
    if (entity.criteria.length > 0)
    {
        throw new CliError(`${entity.id} declared criteria its done claim is gated on, and none is covered — `
            + entity.criteria.map((criterion) => `"${criterion}"`).join("; ")
            + " — cover them once coverage ships, or retire the entity if the outcome was given up");
    }
    if (values.report === undefined || values.report.trim() === "")
    {
        throw new CliError(`done must carry evidence — state what verifiably happened with \`self state done ${entity.id} --report "<what happened>"\``);
    }
    recordEvent(ctx, makeEvent(ctx.project, "entity.done", { entity: entity.id, report: values.report.trim() }), entity.text);
}

function stateExecRetire({ values, positionals }: CommandInput<typeof RETIRE_OPTIONS>): void
{
    const usage = 'state retire <id> --why "<why the outcome was given up or moved>" [--successor <id>]';
    const { ctx, model, entity } = executionTarget(positionals[0], usage);
    requireMovable(entity, "retire");
    const why = requireText(values.why, usage);
    const payload: Record<string, unknown> = { entity: entity.id, why };
    if (values.successor !== undefined)
    {
        payload.successor = requireSuccessor(model, entity, values.successor).id;
    }
    recordEvent(ctx, makeEvent(ctx.project, "entity.retired", payload), entity.text);
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
    goal: 'a goal leaves by replacement — `self goal set "<text>"`',
    decision: "run `self decide retract <id> --why w` (or `decide decline` for a proposal)",
    convention: "run `self convention drop <id> --why w`",
    objective: "run `self objective close <id> --as dropped --why w` (or `objective decline` for a proposal)",
    milestone: "run `self milestone drop <id> --why w`"
};

/* ── the read verbs ────────────────────────────────────────────────── */

function stateList({ values }: CommandInput<typeof SCOPE_OPTIONS>): void
{
    const scope = readScopes(process.cwd(), values)[0];
    const live = buildModel(scope.storeDir, scope.project, new Date()).entities.filter(isLive);
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
        requireSupersedable(entity);
    }
    return { type: type as LinkType, target };
}

function requireSupersedable(entity: EntityState): void
{
    if (entity.source !== undefined)
    {
        throw new CliError(`${entity.id} is a ${entity.source} record — replace it with ${OWNING_REPLACE[entity.source]}`);
    }
    if (!isLive(entity))
    {
        throw new CliError(`${entity.id} was already ${entity.status} — nothing is left to supersede`);
    }
}

// Where each preset record kind's own replacement lives.
const OWNING_REPLACE: Record<EntitySource, string> = {
    goal: '`self goal set "<text>"` (the latest goal supersedes the previous one)',
    decision: '`self decide "<text>" --supersedes <id>`',
    convention: '`self convention add "<text>" --supersedes <id>`',
    objective: '`self objective add "<outcome>" --supersedes <id>`',
    milestone: "`self milestone add … --supersedes <id>`"
};

// Sparse whole numbers (#197 §3): 0 is the top of context and gaps leave room
// to insert later. Anything else is refused rather than rounded — including a
// number too large to keep exactly, which would fold back as a different
// priority than the one this verb confirmed.
function validPriority(value: string): number
{
    const priority = Number(value.trim());
    if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(priority))
    {
        throw new CliError(`--priority takes a whole number, 0 or higher, small enough to keep exactly — "${value}" is not one`);
    }
    return priority;
}

function validExposure(value: string): Exposure
{
    if (!(EXPOSURES as readonly string[]).includes(value))
    {
        throw new CliError(`"${value}" is not an exposure — use full (whole text in context), index (one line), or search (found only by search)`);
    }
    return value as Exposure;
}

function validText(value: string, flag: string, what: string): string
{
    if (value.trim() === "")
    {
        throw new CliError(`${flag} takes ${what} — it cannot be empty`);
    }
    return value.trim();
}
