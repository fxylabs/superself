import {
    allMilestones,
    awaitsReview,
    contributionsOf,
    criteriaNote,
    entityCharacters,
    EntityState,
    Exposure,
    findMilestone,
    isCurrent,
    isTerminalObjective,
    isWorkProposal,
    MilestoneState,
    ObjectiveState,
    openObjectives,
    payloadArtifact,
    rendersIn,
    requireSupersedeKind,
    scopeTarget,
    standaloneEdge,
    supersedeSpelling,
    WorkProposal
} from "@superself/fold";
import { presetRow } from "./aliases.js";
import { required, Requirement, requireOptions } from "./args.js";
import { attachedArtifactLines } from "./artifact.js";
import { branch, Command, CommandInput, CommandLeaf, leaf } from "./contract.js";
import { validDate } from "./dates.js";
import { renderMilestoneBody, renderObjectiveBody } from "./fold.js";
import { WrittenBy, writtenBy } from "./human.js";
import { milestoneId, objectiveId, workId, wrongKindHint } from "./ids.js";
import { claimNote } from "./ledger.js";
import { readEvents } from "./logfile.js";
import { sessionToken } from "./machine.js";
import { buildModel, ProjectModel, reportProjection, workspaceModels, WorkState } from "./model.js";
import {
    ProjectContext,
    ProjectScope,
    readRegistry,
    readScopes,
    requireProject,
    requireRegistered,
    SCOPE_OPTIONS,
    WORKSPACE_SCOPE_OPTIONS
} from "./paths.js";
import { makeEvent, recordEvent, recordEvents } from "./pipeline.js";
import { recordRetirement, retiring, retirementIntent, supersedeTargets, supersedingRecord } from "./retirement.js";
import { admittingDemotions, confirmEntityUnit, Declaration, declarationOf, DECLARE_OPTIONS, demotionEvents, Placed, recordCoverage, recordOwner, requireDecision, tierOf } from "./state.js";
import { dim, errYellow, firstLine, markdownHeadings, plural, styled } from "./style.js";
import { CliError, CommandOutput, ListingBlock, SelfEvent } from "./types.js";

const CONFIDENCE = ["low", "medium", "high"];

// What to do when the project has nothing to attach to yet. Two surfaces say
// it — the proposal gate, which refuses without a gap, and `work add`, which
// refuses nothing — so it is one sentence in one place rather than two
// spellings of the same advice.
export const NO_OBJECTIVE_HINT =
    'no objective yet? `self objective add "<outcome>" --proposed`, then `self objective confirm <id>`';

// What each verb cannot run without, declared once: the parse gate refuses
// every missing one in a single answer and the help page states them, so an
// agent never discovers this contract a refusal at a time (#106).
const WHY_TURNED_DOWN: Requirement = { flags: ["why"], hint: "why it was turned down" };

const WHY_CHANGED: Requirement = { flags: ["why"], hint: "what changed and why" };

const COVERAGE_REQUIRED: Requirement[] = [
    { flags: ["criterion"], value: "<c1>", hint: "the declared criterion being judged" },
    { flags: ["why"], hint: "how the evidence covers it" }
];

const RECHECK_REQUIRED: Requirement[] = [
    {
        flags: ["criterion"],
        value: "<c1>",
        hint: "the criterion to re-judge on the current record — a revision is a supersession, so its successor starts uncovered"
    },
    { flags: ["why"], hint: "what you re-judged" }
];

const OBJECTIVE_USAGE = 'usage: self objective [list] | add "<outcome>" | show <id> | confirm <id> | decline <id> --why w | revise <id> --why w | close <id> --as reached|dropped [--why w]';
const MILESTONE_USAGE = 'usage: self milestone [list] | add "<outcome>" --objective <id> --exit "<criterion>" | show <id> | revise <id> --why w | drop <id> --why w | link|unlink <id> --decision <id> | met <id> --criterion c1 --why w | reach <id> | recheck <id> --criterion c1 --why w';

// `met` and `recheck` are one intake read twice, so they declare one option set
// rather than two that can drift apart.
const COVERAGE_OPTIONS = {
    criterion: { type: "string" },
    why: { type: "string" },
    work: { type: "string" },
    evidence: { type: "string", multiple: true }
} as const;

const WHY_OPTION = { why: { type: "string" } } as const;

const OBJECTIVE_ADD_OPTIONS = {
    horizon: { type: "string" },
    target: { type: "string" },
    success: { type: "string", multiple: true },
    stop: { type: "string", multiple: true },
    priority: { type: "string" },
    proposed: { type: "boolean" },
    // A placement value, not a read scope (#287): `--project` on a write is
    // still refused by the option table, and this one states where the new
    // objective renders rather than which project is being read.
    workspace: { type: "boolean" },
    supersedes: { type: "string", multiple: true },
    demote: { type: "string", multiple: true }
} as const;

const OBJECTIVE_REVISE_OPTIONS = {
    outcome: { type: "string" },
    horizon: { type: "string" },
    target: { type: "string" },
    priority: { type: "string" },
    success: { type: "string", multiple: true },
    stop: { type: "string", multiple: true },
    why: { type: "string" }
} as const;

const OBJECTIVE_CLOSE_OPTIONS = { as: { type: "string" }, why: { type: "string" } } as const;

const MILESTONE_ADD_OPTIONS = {
    objective: { type: "string" },
    target: { type: "string" },
    exit: { type: "string", multiple: true },
    after: { type: "string", multiple: true },
    supersedes: { type: "string" },
    decision: { type: "string", multiple: true },
    demote: { type: "string", multiple: true }
} as const;

const MILESTONE_REVISE_OPTIONS = {
    outcome: { type: "string" },
    target: { type: "string" },
    exit: { type: "string", multiple: true },
    "drop-exit": { type: "string", multiple: true },
    decision: { type: "string", multiple: true },
    why: { type: "string" }
} as const;

// One checkpoint, one decision, one edge. Repeatable because a checkpoint
// rests on as many decisions as it names (#417 §2), and stated rather than
// inferred: an assumption nobody wrote down is not one anybody can withdraw.
const MILESTONE_LINK_OPTIONS = { decision: { type: "string", multiple: true } } as const;

const ASSUMED_DECISION: Requirement = { flags: ["decision"], value: "<id>", hint: "the decision this checkpoint assumes" };

/* ── objectives ────────────────────────────────────────────────────── */

// Listing and showing are reads, so they answer for any project the workspace
// knows; every verb that writes still records into the project this directory
// belongs to, and resolves it only once the arguments are known to be good. A
// bare `--` is not a listing flag — the contract's unnamed "options" form
// keeps it a subcommand mistake that `subcommand()` explains.
export const OBJECTIVE_COMMAND: Command = {
    name: "objective",
    usage: [
        {
            syntax: "objective [--project <slug>] [--workspace]",
            description: [
                "list objectives and their milestones",
                "(--project reads another project, --workspace every registered one)"
            ],
            verbs: ["", "list"]
        },
        {
            syntax: 'objective add "<outcome>" [--horizon week|month|quarter|year] [--target d] [--workspace]',
            description: ["create a time-boxed objective under the goal"],
            verbs: ["add"]
        },
        {
            syntax: "objective show <id> [--project <slug>] | confirm <id>",
            description: ["print an objective, or confirm a proposed one"],
            verbs: ["show", "confirm"]
        },
        {
            syntax: "objective decline <id> --why w",
            description: ["turn down a proposed objective; it leaves waiting at once"],
            verbs: ["decline"]
        },
        {
            syntax: "objective revise <id> --why w [--outcome t] [--target d] [--success s] [--stop s]",
            description: [
                "a revision supersedes: a new objective id carries the revised fields",
                "and every live milestone, with its coverage and work, moves under it",
                "(an empty --target/--horizon/--priority withdraws that field)"
            ],
            verbs: ["revise"]
        },
        { syntax: "objective close <id> --as reached|dropped [--why w]", description: ["--why is required when it is dropped"], verbs: ["close"] }
    ],
    detail: [
        "keep the time-boxed objectives that break the goal down, each with the",
        "reason for its state. Progress is never a percentage.",
        "",
        "list and show read: without a scope flag they answer for the project this",
        "directory belongs to. add, confirm, revise and close write, so they take no",
        "read scope flag — --project is refused on a write — and record into the",
        "project they run in. --workspace on add is not a read scope: it states",
        "where the new objective renders, and its record still lands in this",
        "project's store.",
        "",
        "an objective answers with linked work from every registered project: a unit",
        "another project linked to it lists with that project's slug beside it.",
        "",
        "  --project <slug>      read this registered project instead of this directory's",
        "  --workspace           on list, every registered project's objectives; on add,",
        "                        record at workspace scope: the objective renders in every",
        "                        project's context, above that project's own objectives",
        "  --horizon <span>      week, month, quarter, or year",
        "  --target <date>       the date the outcome is judged on",
        "  --success <text>      what reached looks like",
        "  --stop <text>         the condition that ends it early",
        "  --priority <n>        smaller sorts first",
        "  --proposed            record as a proposal the user has not confirmed",
        "  --supersedes <id>     retire an earlier objective",
        "  --as <state>          how `close` ends it: reached or dropped",
        "  --why <text>          the reason for a revision or a decline, and for a close that drops",
        "  --demote <id>         past a retention cap: the confirmed entity that frees its place by",
        "                        moving one tier down (full → index, index → search); repeatable"
    ],
    guard: rejectManualProgress,
    // An unknown verb is answered before the id is resolved: telling someone
    // who mistyped a verb that they are missing an id sends them looking for
    // the wrong thing, and hides the list of verbs they wanted.
    node: branch({
        name: "objective",
        unnamed: "options",
        refusal: OBJECTIVE_USAGE,
        children: [
            leaf("", WORKSPACE_SCOPE_OPTIONS, 0, objectiveList),
            leaf("list", WORKSPACE_SCOPE_OPTIONS, 0, objectiveList),
            retiring(leaf("add", OBJECTIVE_ADD_OPTIONS, 1, objectiveAdd)),
            leaf("show", SCOPE_OPTIONS, 1, objectiveShow),
            leaf("confirm", {}, 1, confirmObjective),
            leaf("decline", WHY_OPTION, 1, declineObjective, { requires: [WHY_TURNED_DOWN] }),
            retiring(leaf("revise", OBJECTIVE_REVISE_OPTIONS, 1, objectiveRevise, { requires: [WHY_CHANGED] })),
            retiring(leaf("close", OBJECTIVE_CLOSE_OPTIONS, 1, objectiveClose, {
                requires: [{ flags: ["as"], value: "reached|dropped", hint: "whether the outcome was reached or given up" }]
            }))
        ]
    })
};

function objectiveList({ values }: CommandInput<typeof WORKSPACE_SCOPE_OPTIONS>): CommandOutput
{
    const scopes = readScopes(process.cwd(), values);
    // One fold per registered project, however many scopes are listed: the
    // linked work an objective answers with can live in any other log (#244).
    const models = workspaceModels(scopes[0].storeDir, scopes[0].project);
    if (values.workspace !== true)
    {
        // The viewer is the project being read — this directory's, or the one
        // `--project <slug>` named — never the directory the command ran in.
        const viewer = scopes[0].project;
        return [objectiveListing(models[0], contributorsTo(viewer, models),
            foreignRows(foreignWorkspaceObjectives(models, viewer), models))];
    }
    // One block per project, each stating its own size: the workspace form is
    // that many listings printed together, not one listing of everything, and a
    // reader asking how many one project has is answered under its own heading.
    // Nothing is merged into these: every workspace objective already appears
    // under the project whose log owns it, and merging would print it again in
    // every other block.
    return scopes.map((scope, index) =>
    {
        const model = models.find((item) => item.slug === scope.project) as ProjectModel;
        const listing = objectiveListing(model, contributorsTo(scope.project, models));
        const heading = `${index === 0 ? "" : "\n"}${styled ? dim(scope.project) : scope.project}`;
        return { ...listing, rows: [heading, ...listing.rows] };
    });
}

// An objective and the fold that owns it, which is not always the fold doing
// the reading: a workspace-scoped objective renders in every project, and its
// linked work and contributors are counted against the log that owns it.
interface OwnedObjective
{
    slug: string;
    model: ProjectModel;
    objective: ObjectiveState;
}

// Every other project's live workspace-scoped objectives (#287), owner first
// by slug and, within one owner, in that project's own listing order — so the
// rows above a project's own objectives are in one order on every machine.
function foreignWorkspaceObjectives(models: ProjectModel[], viewer: string): OwnedObjective[]
{
    return [...models].filter((model) => model.slug !== viewer)
        .sort((left, right) => left.slug.localeCompare(right.slug))
        .flatMap((model) => openObjectives(model.goals)
            .filter((objective) => isWorkspaceScoped(model, objective.id))
            .map((objective) => ({ slug: model.slug, model, objective })));
}

// `ObjectiveState` carries a priority and no placement, so where a record
// renders is read from the entity of the same id and nowhere else.
function isWorkspaceScoped(model: ProjectModel, id: string): boolean
{
    return model.entities.some((entity) => entity.id === id && entity.source === "objective"
        && entity.status === "confirmed" && isCurrent(entity)
        && scopeTarget(entity, model.slug) === "workspace");
}

// Each row is built from the owning fold, never the viewer's: `objectiveRow`
// counts the objective's own open units, and counting them in a log that does
// not hold them would report zero for every workspace objective.
function foreignRows(foreign: OwnedObjective[], models: ProjectModel[]): string[]
{
    return foreign.map((owned) =>
        `${objectiveRow(owned.model, owned.objective, contributorsTo(owned.slug, models))} (${owned.slug})`);
}

function objectiveShow({ values, positionals }: CommandInput<typeof SCOPE_OPTIONS>): CommandOutput
{
    const scope = readScopes(process.cwd(), values)[0];
    const models = workspaceModels(scope.storeDir, scope.project);
    const owned = locateObjective(models, scope.project, positionals[0]);
    const linked = [
        ...openLocalWork(owned.model, owned.objective),
        ...contributorsTo(owned.slug, models).get(owned.objective.id) ?? []
    ];
    return [{
        kind: "document",
        plain: () => markdownHeadings(renderObjectiveBody(owned.objective, linked).trimEnd()).split("\n")
    }];
}

// The objective this read is about, with the fold that owns it: the viewer's
// own first, then the workspace-scoped ones rendering here from another log.
// An id neither answers to gets the refusal it always got, so a prefix reads
// as unknown here exactly as it does locally.
function locateObjective(models: ProjectModel[], viewer: string, id: string | undefined): OwnedObjective
{
    const local = models[0].goals.objectives.find((item) => item.id === id);
    if (local !== undefined)
    {
        return { slug: viewer, model: models[0], objective: local };
    }
    return foreignWorkspaceObjectives(models, viewer).find((owned) => owned.objective.id === id)
        ?? { slug: viewer, model: models[0], objective: requireObjective(models[0], id) };
}

// The read-time merge (#244): every other project's units that state a
// contribution to an objective this project owns, labeled with their slug.
// Done and retired units drop out — the same open-work rule the local list
// applies (D3) — and nothing is copied: each unit stays the fold of its own
// log, read here because the owning objective answers for it.
function contributorsTo(owner: string, models: ProjectModel[]): Map<string, string[]>
{
    const map = new Map<string, string[]>();
    for (const model of models.filter((item) => item.slug !== owner))
    {
        for (const work of model.works.filter(isOpenWork))
        {
            for (const link of work.foreignObjectives.filter((item) => item.project === owner))
            {
                map.set(link.id, [...map.get(link.id) ?? [], `${work.id} (${model.slug})`]);
            }
        }
    }
    return map;
}

function isOpenWork(work: WorkState): boolean
{
    return work.status !== "done" && work.status !== "retired";
}

// The objective's own open units. `objective.works` also carries the units
// its milestones hold, so this is the one membership every count and listing
// under the objective reads.
function openLocalWork(model: ProjectModel, objective: ObjectiveState): string[]
{
    return objective.works.filter((id) => model.works.some((work) => work.id === id && isOpenWork(work)));
}

// The project a write records into, and its state, resolved together: a write
// verb never takes a scope flag, so this is the only project it can mean.
function writeTarget(): { ctx: ProjectContext; model: ProjectModel }
{
    const ctx = requireProject(process.cwd());
    return { ctx, model: buildModel(ctx.storeDir, ctx.project, new Date()) };
}

function scopeModel(scope: ProjectScope): ProjectModel
{
    return buildModel(scope.storeDir, scope.project, new Date());
}

// The same cap gate `state add` passes (#240 R1): the tier this record
// enters is judged by the one shared check, `--demote` and the supersession
// credit included. The tier is read off the payload's own scope, so a
// workspace objective (#287) is weighed against the workspace tier and a
// milestone — always project-scoped — against the project's, exactly as
// `presetDemotions` decides it for goals and conventions.
function presetGate(ctx: ProjectContext, models: ProjectModel[], usage: string, exposure: Exposure,
    values: { demote?: string[]; proposed?: boolean }, outcome: string, payload: Record<string, unknown>): Placed[]
{
    const target = payload.scope === "workspace" ? "workspace" : ctx.project;
    return admittingDemotions(ctx, models, values, tierOf(target, exposure),
        usage, entityCharacters({ text: outcome, artifact: payloadArtifact(payload) }), supersedeTargets(payload));
}

// The horizon enum was removed as structure and kept as optional metadata
// (#197 §7, #207 B7): whatever span the caller states is recorded.
function objectiveAddPayload(id: string, outcome: string, row: ReturnType<typeof presetRow>, model: ProjectModel,
    values: CommandInput<typeof OBJECTIVE_ADD_OPTIONS>["values"]): Record<string, unknown>
{
    return {
        entity: id,
        text: outcome,
        labels: [row.label],
        links: (values.supersedes ?? []).map((prefix) =>
        {
            requireSupersedeKind(model.entities, prefix, "objective");
            return { type: "supersedes", target: requireObjective(model, prefix).id };
        }),
        criteria: [],
        exposure: row.exposure,
        scope: values.workspace === true ? "workspace" : "project",
        priority: row.priority,
        horizon: values.horizon,
        target: values.target === undefined ? undefined : validDate(values.target),
        rank: values.priority === undefined ? undefined : validPriority(values.priority),
        success: values.success ?? [],
        stop: values.stop ?? []
    };
}

function objectiveAdd({ values, positionals }: CommandInput<typeof OBJECTIVE_ADD_OPTIONS>): CommandOutput
{
    const ctx = requireProject(process.cwd());
    const models = workspaceModels(ctx.storeDir, ctx.project);
    const model = models[0];
    const outcome = requireText(positionals[0], 'objective add "<desired outcome>"');
    const id = objectiveId();
    const row = presetRow(ctx.storeDir, "objective");
    const proposed = values.proposed === true;
    // The horizon enum was removed as structure and kept as optional metadata
    // (#197 §7, #207 B7): whatever span the caller states is recorded.
    const payload = objectiveAddPayload(id, outcome, row, model, values);
    const demotions = presetGate(ctx, models, 'objective add "<outcome>"', row.exposure, values, outcome, payload);
    recordRetirement(ctx, retirementIntent(model, "supersede", proposed ? [] : supersedeTargets(payload),
        { successor: supersedingRecord(payload) }), model,
        (by) => [makeEvent(ctx.project, proposed ? "entity.proposed" : "entity.confirmed",
            strip({ ...payload, by }), undefined, !proposed),
        ...demotionEvents(demotions, id, proposed)],
        `${id} ${outcome}`);
    return [{ kind: "receipt", text: id }];
}

function confirmObjective({ positionals }: CommandInput): void
{
    const { ctx, model } = writeTarget();
    const objective = requireObjective(model, positionals[0]);
    if (objective.status !== "proposed")
    {
        throw new CliError(`${objective.id} is already ${objective.status}`);
    }
    // The shared confirm path (#240 R3): the same room gate `state confirm`
    // runs, paired demotions included — a proposal past a cap is refused
    // here, never at propose time.
    confirmEntityUnit(ctx, objective.id);
}

// The other answer to a proposal. Confirming says the objective is the
// project's; declining says it is not, and the reason is the whole record.
// One withdrawal event in the shared grammar; the record keeps "declined".
function declineObjective({ values, positionals }: CommandInput<typeof WHY_OPTION>): void
{
    const { ctx, model } = writeTarget();
    const objective = requireObjective(model, positionals[0]);
    const why = required(values.why);
    if (objective.status !== "proposed")
    {
        throw new CliError(`${objective.id} is already ${objective.status} — only a proposed objective can be declined`);
    }
    recordEvent(ctx, makeEvent(ctx.project, "entity.retracted", { entity: objective.id, why }, { declines: objective.id }, true), objective.outcome);
}

// A revision is a supersession (#207 B9): a new objective entity carries the
// links and the revised fields, the predecessor reads superseded, and prior
// coverage under it is stale by construction — the record id changes.
function refuseObjectiveRevise(objective: ObjectiveState, values: CommandInput<typeof OBJECTIVE_REVISE_OPTIONS>["values"]): void
{
    if (isTerminalObjective(objective) || objective.status === "superseded")
    {
        throw new CliError(`${objective.id} is already ${objective.status} — a closed objective is not revised; add a new one`);
    }
    const changes = [values.outcome, values.horizon, values.target, values.priority, values.success, values.stop];
    if (changes.every((value) => value === undefined))
    {
        throw new CliError("objective revise needs at least one of --outcome, --horizon, --target, --priority, --success, --stop");
    }
}

function objectiveRevise({ values, positionals }: CommandInput<typeof OBJECTIVE_REVISE_OPTIONS>): CommandOutput
{
    const { ctx, model } = writeTarget();
    const objective = requireObjective(model, positionals[0]);
    const why = required(values.why);
    refuseObjectiveRevise(objective, values);
    const id = objectiveId();
    const payload: Record<string, unknown> = {
        entity: id,
        text: restated(values.outcome, "objective") ?? objective.outcome,
        labels: [presetRow(ctx.storeDir, "objective").label],
        links: [{ type: "supersedes", target: objective.id }],
        criteria: [],
        ...carriedPlacement(model, objective.id),
        horizon: revisedField(values.horizon, objective.horizon),
        target: revisedField(withdrawable(values.target, validDate) as string | null | undefined, objective.target),
        rank: revisedField(withdrawable(values.priority, validPriority) as number | null | undefined, objective.priority),
        success: values.success ?? objective.success,
        stop: values.stop ?? objective.stop,
        why
    };
    const carried = liveMilestones(objective);
    recordRetirement(ctx, retirementIntent(model, "supersede", [objective.id],
        { successor: supersedingRecord(payload) }), model,
        (by) => [makeEvent(ctx.project, "entity.confirmed",
            strip({ ...payload, by }), undefined, true),
        ...carryEvents(ctx, carried, id)],
        `${id} ${why}`);
    return [{ kind: "receipt", text: `${id} — carried ${plural(carried.length, "milestone")} from ${objective.id}` }];
}

// The checkpoints a revision carries to the successor (#333): every one not
// dropped and not already replaced. A reached one carries too — its evidence
// belongs to the plan, not to the wording that just changed — and a dropped
// or superseded one stays where it ended, because the successor owes nothing
// on it.
function liveMilestones(objective: ObjectiveState): MilestoneState[]
{
    return objective.milestones.filter((milestone) => milestone.droppedWhy === undefined && milestone.supersededBy === undefined);
}

// The carry is one grouping edge per milestone in the shared grammar, the
// same `entity.linked` a `work link` records, written in the successor's own
// append so no reader finds the objective without its checkpoints. The edge to
// the predecessor is left standing: the fold reads the newest edge as the
// current objective and every older one as where the milestone came from.
function carryEvents(ctx: ProjectContext, milestones: MilestoneState[], successor: string): SelfEvent[]
{
    return milestones.map((milestone) => makeEvent(ctx.project, "entity.linked",
        { entity: milestone.id, link: { type: "member-of", target: successor } }, undefined, true));
}

// What a revision does to one field: absent keeps the predecessor's value, a
// value replaces it, an empty spelling (already read as null) withdraws it.
function revisedField<T>(value: T | null | undefined, current: T | undefined): T | undefined
{
    if (value === null)
    {
        return undefined;
    }
    return value ?? current;
}

// The successor of a revision keeps the predecessor's placement: the record
// moved, not its place in context. Falls back to the preset defaults for a
// record whose entity the store cannot see, which cannot happen from here.
function carriedPlacement(model: ProjectModel, id: string): Record<string, unknown>
{
    const entity = model.entities.find((item) => item.id === id);
    const carried: Record<string, unknown> = {
        exposure: entity?.exposure ?? "full",
        scope: entity?.scope ?? "project"
    };
    if (entity?.priority !== undefined)
    {
        carried.priority = entity.priority;
    }
    return carried;
}

// Everything that refuses the call, in one pass, before anything is recorded.
function refuseObjectiveClose(objective: ObjectiveState, as: string | undefined, why: string | undefined): void
{
    // The gate demanded --as; what is left is whether the closure it names is
    // one the lifecycle has.
    if (as !== "reached" && as !== "dropped")
    {
        throw new CliError(`objective close --as must be reached or dropped — "${as}" is neither`);
    }
    // Dropping is a withdrawal, and every withdrawal in the lifecycle carries
    // its reason: an objective given up on with no reason recorded leaves the
    // next reader unable to tell it from one nobody got to. Reaching one needs
    // no reason — the coverage it was reached on is the record.
    if (as === "dropped")
    {
        requireText(why, 'objective close <id> --as dropped --why "<why it was given up>"');
    }
    // The fold refuses a transition on a terminal objective, so recording one
    // would print "recorded" and change nothing.
    if (isTerminalObjective(objective))
    {
        throw new CliError(`${objective.id} is already ${objective.status}${objective.closedWhy === undefined ? "" : ` — ${objective.closedWhy}`}`);
    }
    const open = objective.milestones.filter((milestone) => milestone.state !== "reached" && milestone.state !== "closed");
    if (as === "reached" && open.length > 0)
    {
        throw new CliError(`${objective.id} still has unreached milestones (${open.map((m) => m.id).join(", ")}) — reach or supersede them first`);
    }
}

function objectiveClose({ values, positionals }: CommandInput<typeof OBJECTIVE_CLOSE_OPTIONS>): void
{
    const { ctx, model } = writeTarget();
    const objective = requireObjective(model, positionals[0]);
    refuseObjectiveClose(objective, values.as, values.why);
    // Reached is the criteria-gated done claim; dropped is the retirement
    // (#207 B10) — the outcome layer speaks the execution grammar too.
    const payload = values.as === "reached"
        ? strip({ entity: objective.id, report: values.why })
        : { entity: objective.id, why: values.why };
    recordRetirement(ctx, retirementIntent(model, "retire", values.as === "reached" ? [] : [objective.id],
        { why: values.why }), model,
        (by) => [makeEvent(ctx.project, values.as === "reached" ? "entity.done" : "entity.retired",
            { ...payload, by }, undefined, true)],
        `${objective.id} ${values.as}`);
}

/* ── milestones ────────────────────────────────────────────────────── */

// Scoped exactly as `objective` is, minus the workspace form: a milestone
// hangs under an objective, so `self objective --workspace` is the
// workspace-wide roll-up and a second one here would print the same state
// stripped of what gives it meaning.
export const MILESTONE_COMMAND: Command = {
    name: "milestone",
    usage: [
        {
            syntax: "milestone [--project <slug>]",
            description: ["list milestones with state, reason, and linked work"],
            verbs: ["", "list"]
        },
        {
            syntax: 'milestone add "<outcome>" --objective <id> --exit "<criterion>" [--target d] [--after m] [--supersedes m] [--decision d]',
            verbs: ["add"]
        },
        {
            syntax: "milestone show <id> [--project <slug>]",
            description: [
                "print a milestone, its exit criteria, and its coverage",
                "(with every linked work unit: its state, its criteria, its holder, its latest report)"
            ],
            verbs: ["show"]
        },
        {
            syntax: "milestone revise <id> --why w [--outcome t] [--target d] [--exit e] [--drop-exit c1] [--decision d]",
            description: ["a revision supersedes: a new milestone id carries the revised criteria"],
            verbs: ["revise"]
        },
        {
            syntax: 'milestone drop <id> --why "<reason>"',
            description: ["give up on a checkpoint with nothing replacing it"],
            verbs: ["drop"]
        },
        {
            syntax: "milestone link|unlink <id> --decision <id>",
            description: [
                "state, or withdraw, a decision this checkpoint assumes",
                "(replacing one is linking the successor and then unlinking the old decision)"
            ],
            verbs: ["link", "unlink"]
        },
        { syntax: "milestone met <id> --criterion c1 --why w [--work id] [--evidence c]", verbs: ["met"] },
        { syntax: "milestone reach <id>", description: ["record a milestone as reached once every criterion is covered"], verbs: ["reach"] },
        {
            syntax: "milestone recheck <id> --criterion c1 --why w",
            description: ["re-cover a criterion on the current record — a revision's successor starts uncovered"],
            verbs: ["recheck"]
        }
    ],
    detail: [
        "keep the checkpoints under an objective. A milestone is reached only when",
        "every exit criterion is covered by evidence — finishing work never",
        "reaches one on its own.",
        "",
        "a checkpoint may rest on decisions this project settled. State each one,",
        "and a checkpoint whose ground moved is corrected by naming the successor",
        "and then withdrawing the old one — never by rewriting the set:",
        "",
        "  self milestone link <id> --decision <decision-id>",
        "  self milestone unlink <id> --decision <old-decision-id>",
        "",
        "Nothing reads an assumption out of the wording of a checkpoint. An edge is",
        "what there is to withdraw, so an assumption nobody stated is one nobody can",
        "take back.",
        "",
        "list and show read and take --project; every other verb writes into the",
        "project it runs in. There is no --workspace form: a milestone hangs under",
        "an objective, so `self objective --workspace` is the workspace-wide roll-up.",
        "",
        "  --project <slug>      read this registered project instead of this directory's",
        "  --objective <id>      the objective the milestone belongs to",
        "  --exit <criterion>    an exit criterion, repeatable",
        "  --target <date>       the date the checkpoint is judged on",
        "  --after <id>          order it after another milestone",
        "  --decision <id>       a decision this checkpoint assumes, repeatable — stated on the",
        "                        add or the revision, and linked or withdrawn on its own after",
        "  --criterion <c>       the criterion `met` or `recheck` speaks about",
        "  --work <id>           the work unit whose evidence covers it",
        "  --evidence <hash>     a commit recorded with the coverage",
        "  --why <text>          how the evidence covers it, what was re-judged, or why it was dropped",
        "  --demote <id>         past a retention cap: the confirmed entity that frees its place by",
        "                        moving one tier down (full → index, index → search); repeatable"
    ],
    guard: rejectManualProgress,
    node: branch({
        name: "milestone",
        unnamed: "options",
        refusal: MILESTONE_USAGE,
        children: [
            leaf("", SCOPE_OPTIONS, 0, milestoneList),
            leaf("list", SCOPE_OPTIONS, 0, milestoneList),
            retiring(leaf("add", MILESTONE_ADD_OPTIONS, 1, milestoneAdd, {
                requires: [
                    { flags: ["objective"], value: "<id>", hint: "the objective this checkpoint sits under" },
                    { flags: ["exit"], value: "<criterion>", hint: "what has to be true to call it reached, repeatable" }
                ]
            })),
            leaf("show", SCOPE_OPTIONS, 1, milestoneShow),
            retiring(leaf("revise", MILESTONE_REVISE_OPTIONS, 1, milestoneRevise, { requires: [WHY_CHANGED] })),
            retiring(leaf("drop", WHY_OPTION, 1, milestoneDrop, {
                requires: [{ flags: ["why"], hint: "why it is not being reached" }]
            })),
            leaf("link", MILESTONE_LINK_OPTIONS, 1, (input) => milestoneLink(input, true), { requires: [ASSUMED_DECISION] }),
            leaf("unlink", MILESTONE_LINK_OPTIONS, 1, (input) => milestoneLink(input, false), { requires: [ASSUMED_DECISION] }),
            leaf("met", COVERAGE_OPTIONS, 1, milestoneMet, { requires: COVERAGE_REQUIRED }),
            leaf("reach", {}, 1, milestoneReach),
            leaf("recheck", COVERAGE_OPTIONS, 1, milestoneRecheck, { requires: RECHECK_REQUIRED })
        ]
    })
};

function milestoneList({ values }: CommandInput<typeof SCOPE_OPTIONS>): CommandOutput
{
    return [milestoneListing(scopeModel(readScopes(process.cwd(), values)[0]))];
}

// The milestone's page — its own body, where its linked work stands (#406),
// and then what `--for` attached to it (#407). Both additions are composed
// here rather than folded onto the milestone: they are read at command time,
// so the canonical page the fold writes carries neither.
function milestoneShow({ values, positionals }: CommandInput<typeof SCOPE_OPTIONS>): CommandOutput
{
    const scope = readScopes(process.cwd(), values)[0];
    const model = scopeModel(scope);
    const found = requireMilestone(model, positionals[0]);
    const progress = milestoneProgressLines(model, found.milestone);
    const body = renderMilestoneBody(found.milestone, found.objective, progress).trimEnd();
    const attached = attachedArtifactLines(scope.storeDir, scope.project, found.milestone.id);
    return [{ kind: "document", plain: () => markdownHeadings([body, ...attached].join("\n")).split("\n") }];
}

/* ── where the linked work stands (#406) ───────────────────────────── */

// The one screen that answers "where are we": every unit linked to the
// checkpoint, beside the criteria it is meant to close. Composed here rather
// than in `fold.ts` because it names who holds a unit, which is this machine's
// judgment and must not reach a synced page — the reason `main.ts` composes
// `self work show`'s holder line outside `renderWorkBody`.
//
// The linked ids come from `milestone.works`, which `deriveMilestone` already
// resolved and ordered; a second scan of `model.works` here would be a second
// answer to which units a checkpoint has.
function milestoneProgressLines(model: ProjectModel, milestone: MilestoneState): string[]
{
    const byId = new Map(model.works.map((work) => [work.id, work]));
    return milestone.works.flatMap((id) =>
    {
        const work = byId.get(id);
        return work === undefined ? [] : unitProgressLines(work);
    });
}

// One unit as the milestone page states it: where it stands, how much of what
// it declared is covered, who holds it, and the opening line of its newest
// report under all three.
function unitProgressLines(work: WorkState): string[]
{
    const marks = [unitStanding(work), ...criteriaMark(work), ...holderNote(work)];
    return [`- **${work.id}** ${work.outcome} — ${marks.join(", ")}`, ...latestReportLines(work)];
}

// The working state in the vocabulary `self work show` prints it in, with the
// dependency `work block --on` named and its reason where one was recorded. A
// milestone page that renamed the states would be a second spelling of one
// answer, and the reader who follows an id from here would meet the other one.
function unitStanding(work: WorkState): string
{
    if (work.status !== "blocked")
    {
        return work.status;
    }
    return `blocked on ${work.blockedOn}${work.blockedWhy === undefined ? "" : `: ${work.blockedWhy}`}`;
}

// What the unit declared for itself, in the sentence `self work`, `self
// context` and `self work show` print for the same unit (#408 cell 85) — each
// blocked criterion named with the `--on` its block was recorded with, and
// each one a person owns marked `(person)` (#413). A unit that declared
// nothing says nothing: the count would read as progress toward a bar it never
// set.
function criteriaMark(work: WorkState): string[]
{
    const note = criteriaNote(work.criteria);
    return note === undefined ? [] : [note];
}

function holderNote(work: WorkState): string[]
{
    const held = claimNote(work.claim, sessionToken(), work.process);
    return held === null ? [] : [held];
}

// The newest report's opening line, hung under the unit it belongs to. A
// report can be pages; what this screen has room for is the sentence that says
// where the unit got to, and `self work show <id>` prints the rest.
function latestReportLines(work: WorkState): string[]
{
    const latest = reportProjection(work.reports)[0];
    return latest === undefined ? [] : [`  - report ${latest.ts.slice(0, 10)}: ${firstLine(latest.text)}`];
}

// What a milestone write speaks about: the project it runs in, that project's
// state, and the milestone with the objective it hangs under.
interface MilestoneTarget
{
    ctx: ProjectContext;
    model: ProjectModel;
    milestone: MilestoneState;
    objective: ObjectiveState;
}

function milestoneTarget(id: string | undefined): MilestoneTarget
{
    const { ctx, model } = writeTarget();
    return { ctx, model, ...requireMilestone(model, id) };
}

function milestoneAddPayload(id: string, outcome: string, row: ReturnType<typeof presetRow>,
    links: Record<string, unknown>[], objective: ObjectiveState,
    values: CommandInput<typeof MILESTONE_ADD_OPTIONS>["values"]): Record<string, unknown>
{
    return {
        entity: id,
        text: outcome,
        labels: [row.label],
        links,
        criteria: values.exit,
        exposure: row.exposure,
        scope: "project",
        priority: row.priority,
        after: (values.after ?? []).map((prefix) => requireSibling(objective, prefix)),
        target: values.target === undefined ? undefined : validDate(values.target)
    };
}

function milestoneAdd({ values, positionals }: CommandInput<typeof MILESTONE_ADD_OPTIONS>): CommandOutput
{
    const ctx = requireProject(process.cwd());
    const models = workspaceModels(ctx.storeDir, ctx.project);
    const model = models[0];
    const outcome = requireText(positionals[0], 'milestone add "<outcome>" --objective <id> --exit "<criterion>"');
    const objective = requireOwnObjective(models, ctx.project, required(values.objective));
    const id = milestoneId();
    const row = presetRow(ctx.storeDir, "milestone");
    const links: Record<string, unknown>[] = [{ type: "member-of", target: objective.id }];
    if (values.supersedes !== undefined)
    {
        requireSupersedeKind(model.entities, values.supersedes, "milestone");
        links.push({ type: "supersedes", target: requireSibling(objective, values.supersedes) });
    }
    links.push(...statedAssumptions(model, values.decision));
    const payload = milestoneAddPayload(id, outcome, row, links, objective, values);
    const demotions = presetGate(ctx, models, 'milestone add "<outcome>"', row.exposure, values, outcome, payload);
    recordRetirement(ctx, retirementIntent(model, "supersede", supersedeTargets(payload),
        { successor: supersedingRecord(payload) }), model,
        (by) => [makeEvent(ctx.project, "entity.confirmed",
            strip({ ...payload, by }), undefined, true),
        ...demotionEvents(demotions, id, false)],
        `${id} ${outcome}`);
    return [{ kind: "receipt", text: id }];
}

// A checkpoint is the objective owner's own plan, and it renders in that
// project alone — a milestone is project-scoped even under a workspace
// objective. So an objective another project owns is refused by name rather
// than called unknown: it renders here, which is exactly why it is easy to
// name here (#287).
function requireOwnObjective(models: ProjectModel[], viewer: string, id: string): ObjectiveState
{
    const foreign = foreignWorkspaceObjectives(models, viewer).find((owned) => owned.objective.id === id);
    if (foreign !== undefined)
    {
        throw new CliError(`${id} is ${foreign.slug}'s objective — a checkpoint belongs to the project whose log owns `
            + `the objective, so run \`self milestone add\` from ${foreign.slug}`);
    }
    return requireObjective(models[0], id);
}

function refuseMilestoneRevise(milestone: MilestoneState, values: CommandInput<typeof MILESTONE_REVISE_OPTIONS>["values"]): void
{
    if (milestone.supersededBy !== undefined || milestone.droppedWhy !== undefined)
    {
        throw new CliError(`${milestone.id} is already closed — a withdrawn or replaced checkpoint is not revised`);
    }
    if (values.outcome === undefined && values.target === undefined
        && (values.exit === undefined || values.exit.length === 0)
        && (values["drop-exit"] === undefined || values["drop-exit"].length === 0)
        && (values.decision === undefined || values.decision.length === 0))
    {
        throw new CliError("milestone revise needs at least one of --outcome, --target, --exit, --drop-exit, --decision");
    }
}

// A revision is a supersession (#207 B12): a new milestone entity carries the
// revised criteria and the grouping, the predecessor reads superseded, and its
// coverage is stale by construction — claims bind to the entity id.
function milestoneRevise({ values, positionals }: CommandInput<typeof MILESTONE_REVISE_OPTIONS>): CommandOutput
{
    const { ctx, model, milestone, objective } = milestoneTarget(positionals[0]);
    const why = required(values.why);
    refuseMilestoneRevise(milestone, values);
    const id = milestoneId();
    const payload = milestoneRevisePayload(ctx, model, { milestone, objective }, id, values);
    recordRetirement(ctx, retirementIntent(model, "supersede", [milestone.id],
        { successor: supersedingRecord(payload) }), model,
        (by) => [makeEvent(ctx.project, "entity.confirmed",
            strip({ ...payload, by }), undefined, true)],
        `${id} ${why}`);
    return [{ kind: "receipt", text: id }];
}

// What the successor record carries: the criteria the revision leaves standing
// plus the ones it adds, the grouping and supersession edges, and the
// assumptions this call states. The predecessor's own assumptions are not
// carried here — that is #417's part (b) — so a revision names the decisions
// it rests on or names none.
function milestoneRevisePayload(ctx: ProjectContext, model: ProjectModel,
    revised: { milestone: MilestoneState; objective: ObjectiveState }, id: string,
    values: CommandInput<typeof MILESTONE_REVISE_OPTIONS>["values"]): Record<string, unknown>
{
    const { milestone, objective } = revised;
    const dropped = new Set((values["drop-exit"] ?? []).map((item) => requireCriterion(milestone, item).id));
    return {
        entity: id,
        text: restated(values.outcome, "milestone") ?? milestone.outcome,
        labels: [presetRow(ctx.storeDir, "milestone").label],
        links: [
            { type: "member-of", target: objective.id },
            { type: "supersedes", target: milestone.id },
            ...statedAssumptions(model, values.decision)
        ],
        criteria: [
            ...milestone.exit.filter((item) => item.dropped !== true && !dropped.has(item.id)).map((item) => item.text),
            ...values.exit ?? []
        ],
        ...carriedPlacement(model, milestone.id),
        after: milestone.after,
        target: revisedField(withdrawable(values.target, validDate) as string | null | undefined, milestone.target),
        why: required(values.why)
    };
}

// A checkpoint given up on, with nothing taking its place. Revising it would
// say the target moved; dropping it says nobody is going to reach it — the
// retirement of the execution grammar (#207 B12).
function milestoneDrop({ values, positionals }: CommandInput<typeof WHY_OPTION>): void
{
    const { ctx, model, milestone } = milestoneTarget(positionals[0]);
    const why = required(values.why);
    if (milestone.state === "reached")
    {
        throw new CliError(`${milestone.id} was already reached — dropping it would unsay evidence that landed`);
    }
    if (milestone.state === "closed")
    {
        throw new CliError(`${milestone.id} is already closed — ${milestone.reason}`);
    }
    recordRetirement(ctx, retirementIntent(model, "retire", [milestone.id], { why }), model,
        (by) => [makeEvent(ctx.project, "entity.retired",
            { entity: milestone.id, why, by }, undefined, true)],
        `${milestone.id} ${why}`);
}

/* ── the decisions a checkpoint assumes (#417 §2) ──────────────────── */

// One edge per named decision, `assumes` rather than `member-of`: a checkpoint
// is not part of a decision and a decision is not part of a checkpoint — the
// checkpoint rests on what the decision settled, and it may rest on several.
//
// Additive by design. Replacing a superseded assumption is linking the
// successor and then unlinking the old decision, two statements a person can
// see and undo, never a silent rewrite that takes an unrelated assumption with
// it.
function milestoneLink({ values, positionals }: CommandInput<typeof MILESTONE_LINK_OPTIONS>, link: boolean): CommandOutput
{
    const { ctx, model, milestone } = milestoneTarget(positionals[0]);
    const decisions = (values.decision ?? []).map((prefix) => requireDecision(model, prefix).id);
    const edges = decisions.map((id) => assumedEdge(milestone, id, link));
    recordEvents(ctx, edges.map((edge) =>
        makeEvent(ctx.project, link ? "entity.linked" : "entity.unlinked",
            { entity: milestone.id, link: edge }, undefined, true)),
        `${milestone.id} ${milestone.outcome}`);
    return [{
        kind: "receipt",
        text: `${milestone.id} ${link ? "assumes" : "no longer assumes"} ${decisions.join(", ")}`
    }];
}

// Refused before anything is written, and by name: restating an edge the
// record already carries would append an event no reader can tell from the
// first, and withdrawing one it never carried would record a correction of
// nothing.
function assumedEdge(milestone: MilestoneState, decision: string, link: boolean): Record<string, unknown>
{
    const assumed = milestone.assumes.includes(decision);
    if (link && assumed)
    {
        throw new CliError(`${milestone.id} already assumes ${decision} — one edge is one link`);
    }
    if (!link && !assumed)
    {
        throw new CliError(`${milestone.id} does not assume ${decision} — `
            + `state one with \`self milestone link ${milestone.id} --decision <id>\``);
    }
    return { type: "assumes", target: decision };
}

// The assumption edges a creation or a revision states. A revision states its
// own: this part of #417 ships the edges and the verbs, and carrying a
// predecessor's assumptions across a revision is PR(b)'s scope, so a revision
// that names none is a checkpoint that assumes none until somebody says
// otherwise.
function statedAssumptions(model: ProjectModel, decisions: string[] | undefined): Record<string, unknown>[]
{
    return (decisions ?? []).map((prefix) => ({ type: "assumes", target: requireDecision(model, prefix).id }));
}

// Sugar over the coverage grammar (#207 C5): `met` records the same
// `entity.covered` a `state cover` records, with the criterion named by its
// cN id and the work reference held to a stated contribution.
function milestoneMet({ values, positionals }: CommandInput<typeof COVERAGE_OPTIONS>): void
{
    const { ctx, model, milestone } = milestoneTarget(positionals[0]);
    const criterion = requireCriterion(milestone, required(values.criterion));
    const why = required(values.why);
    if (milestone.met.includes(criterion.id))
    {
        throw new CliError(`${milestone.id} ${criterion.id} is already covered — revise the milestone if the criterion changed`);
    }
    if (values.work !== undefined)
    {
        requireLinkedWork(model, milestone, values.work);
    }
    recordCoverage(ctx, model, milestone.id, criterion.text, why, values, "milestone met");
}

// A revision is a supersession now, so what recheck re-judges is the
// successor: coverage binds to the entity id, a superseding revision starts
// uncovered, and recheck covers the current record (#207 C6). Legacy stale
// coverage — judged against a revision that has since moved — re-covers the
// same way.
function milestoneRecheck({ values, positionals }: CommandInput<typeof COVERAGE_OPTIONS>): void
{
    const { ctx, model } = writeTarget();
    const named = requireMilestone(model, positionals[0]);
    const why = required(values.why);
    const { milestone } = currentMilestone(model, named.milestone);
    const criterion = requireCriterion(milestone, required(values.criterion));
    if (milestone.met.includes(criterion.id) && !milestone.stale.some((item) => item.criterion === criterion.id))
    {
        throw new CliError(`${milestone.id} ${criterion.id} is already covered at the current record — nothing to recheck`);
    }
    if (values.work !== undefined)
    {
        requireLinkedWork(model, milestone, values.work);
    }
    recordCoverage(ctx, model, milestone.id, criterion.text, why, values, "milestone recheck");
}

// The record a recheck lands on: the live end of the supersession chain.
// Single steps over folded state, bounded by the milestone count, so a cycle
// a foreign writer appended cannot loop the walk.
function currentMilestone(model: ProjectModel, milestone: MilestoneState): { milestone: MilestoneState }
{
    let current = milestone;
    for (let hops = 0; current.supersededBy !== undefined && hops < 1000; hops += 1)
    {
        const next = findMilestone(model.goals, current.supersededBy);
        if (next === null)
        {
            break;
        }
        current = next.milestone;
    }
    return { milestone: current };
}

// Work reaching done is not a milestone being reached: the exit criteria are
// the gate, and they are checked here rather than inferred from a transition.
// Reached is the criteria-gated done claim of the shared grammar (#207 B12).
function milestoneReach({ positionals }: CommandInput): void
{
    const { ctx, milestone } = milestoneTarget(positionals[0]);
    if (milestone.reached !== undefined)
    {
        throw new CliError(`${milestone.id} was already reached on ${milestone.reached.ts.slice(0, 10)}`);
    }
    requireCovered(milestone);
    const waiting = milestone.after.filter((id) => id !== milestone.id);
    if (waiting.length > 0)
    {
        console.error(`${errYellow("warning:")} ${milestone.id} depends on ${waiting.join(", ")} — check they are reached`);
    }
    recordEvent(ctx, makeEvent(ctx.project, "entity.done", { entity: milestone.id }, undefined, true),
        `${milestone.id} ${milestone.outcome}`);
}

function requireCovered(milestone: MilestoneState): void
{
    if (milestone.open.length === 0)
    {
        return;
    }
    const open = milestone.exit.filter((criterion) => milestone.open.includes(criterion.id));
    throw new CliError(`${milestone.id} has uncovered exit criteria — ` +
        open.map((criterion) => `${criterion.id} ${criterion.text}`).join("; ") +
        `\n  cover each with \`self milestone met ${milestone.id} --criterion <id> --why "<how>"\``);
}

/* ── work links ────────────────────────────────────────────────────── */

// The work verbs this module owns, grafted under `self work` by the
// dispatcher's declaration. They parse through the one gate like every other
// verb: the required-option refusal lives there, so a verb that stated its
// contract in its own parser could not be covered by it (#106, closing #111).
const LINK_OPTIONS = {
    objective: { type: "string" },
    "objective-project": { type: "string" },
    milestone: { type: "string" },
    standalone: { type: "boolean" },
    why: { type: "string" }
} as const;

// Three answers, not two (#417 §1). A unit contributes to an objective, to a
// milestone, or to nothing on purpose — and the third is a statement with a
// reason, which is what tells it apart from a unit nobody has said anything
// about yet.
const LINK_TARGET: Requirement = {
    flags: ["objective", "milestone", "standalone"],
    value: "<id>",
    hint: "what the unit contributes to, or --standalone when it contributes to nothing on purpose"
};

// Demanded only once `--standalone` is given, so it cannot be declared on the
// leaf: a requirement that depends on another flag's value is judged in the
// handler and still refused by the one gate (#106).
const STANDALONE_WHY: Requirement = { flags: ["why"], hint: "why this unit contributes to no outcome" };

const PROPOSAL_OPTIONS = {
    objective: { type: "string" },
    milestone: { type: "string" },
    supersedes: { type: "string" },
    why: { type: "string" },
    standalone: { type: "boolean" },
    value: { type: "string" },
    success: { type: "string", multiple: true },
    stop: { type: "string", multiple: true },
    depends: { type: "string", multiple: true },
    risk: { type: "string" },
    capacity: { type: "string" },
    "evidence-plan": { type: "string" },
    confidence: { type: "string" },
    expires: { type: "string" },
    ...DECLARE_OPTIONS
} as const;

// One statement of what a *gap* proposal has to say for itself. It is applied
// inside the handler rather than declared on the leaf (#356): a standalone
// plan needs none of it, and a requirement that depends on another flag's
// value is not declarable — but it is still refused by the one gate, so a
// call missing four of these is told all four at once.
const GAP_PROPOSAL_REQUIRED: Requirement[] = [
    { flags: ["value"], hint: "what reaching this buys the objective" },
    { flags: ["success"], hint: "what done looks like, repeatable" },
    { flags: ["stop"], hint: "the condition that ends it early, repeatable" },
    { flags: ["risk"], hint: "what could go wrong and how it would show" },
    { flags: ["capacity"], hint: "the effort this is expected to cost" },
    { flags: ["evidence-plan"], value: "<e>", hint: "what evidence will prove it done" },
    { flags: ["confidence"], value: "<level>", hint: "low, medium or high" },
    { flags: ["expires"], value: "<date>", hint: "YYYY-MM-DD after which the proposal is stale" },
    {
        flags: ["objective", "milestone"],
        value: "<id>",
        hint: "the gap this proposal closes",
        unblock: NO_OBJECTIVE_HINT
    }
];

// `--criteria` is declared here only to be refused by name (#408 cell 53). A
// revision restates the plan text and says nothing about the list, so a caller
// who reached for it here is sent to the verb that appends one rather than
// having the flag dropped without a word.
const REVISE_OPTIONS = { why: { type: "string" }, criteria: { type: "string", multiple: true } } as const;

const WHY_PLAN_CHANGED: Requirement = { flags: ["why"], hint: "why the plan changed" };

const REVISE_USAGE = 'work revise <work-id> "<revised plan>" --why "<why the plan changed>"';

const PROPOSE_USAGE = 'work propose "<plan>" [--supersedes <id> --why w] [--objective <id>|--milestone <id> …]';

export const WORK_GOAL_LEAVES: CommandLeaf[] = [
    leaf("link", LINK_OPTIONS, 1, (input) => cmdWorkLink(input, true), { requires: [LINK_TARGET] }),
    leaf("unlink", LINK_OPTIONS, 1, (input) => cmdWorkLink(input, false), { requires: [LINK_TARGET] }),
    leaf("propose", PROPOSAL_OPTIONS, 1, cmdPropose, { undocumented: ["depends"] }),
    // `retiring`, because confirming a plan that carries `--supersedes` retires
    // the unit it replaces (#389). A plan that carries none destroys nothing
    // and is refused as an idle line inside a reviewed set, exactly as a bare
    // `work add` is: marking a leaf that turns out to destroy nothing costs
    // nothing, and forgetting to mark one that does costs a plan a person
    // could have run.
    retiring(leaf("confirm", WHY_OPTION, 1, (input) => cmdProposalDecision(input, true))),
    // The spelling this verb had until #400, still dispatching and no longer
    // documented. It records the identical event: a plan is confirmed the way
    // every other proposed record is, and one grammar across the record kinds
    // is worth more than the word "accept" — but a script or a doc written
    // against the old name keeps working rather than breaking on the rename.
    retiring(leaf("accept", WHY_OPTION, 1, (input) => cmdProposalDecision(input, true), { hidden: true })),
    leaf("decline", WHY_OPTION, 1, (input) => cmdProposalDecision(input, false), { requires: [WHY_TURNED_DOWN] }),
    // Deliberately not `retiring`: a revision destroys nothing — one id, no
    // successor, no supersession — which is the opposite of what `objective
    // revise` and `milestone revise` do, and the help says so.
    leaf("revise", REVISE_OPTIONS, 2, cmdWorkRevise, { requires: [WHY_PLAN_CHANGED], undocumented: ["criteria"] })
];

// Stating what a unit contributes to is a grouping edge in the shared
// grammar (#207 B13): one `entity.linked` per named outcome, `member-of`
// pointing at the objective or the milestone. A standalone declaration rides
// the same two events (#417 §2) — it is a statement about the same axis, and
// a second verb for it would be a second gate that has to agree with this one.
function cmdWorkLink({ values, positionals }: CommandInput<typeof LINK_OPTIONS>, link: boolean): void
{
    const verb = link ? "work link" : "work unlink";
    const ctx = requireProject(process.cwd());
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const work = requireWork(model, positionals[0]);
    const links = [...linkEdges(ctx, model, values, verb), ...standaloneEdges(work, values, link)];
    const type = link ? "entity.linked" : "entity.unlinked";
    recordEvents(ctx, links.map((edge) =>
        makeEvent(ctx.project, type, { entity: work.id, link: edge }, undefined, true)),
        `${work.id} ${work.outcome}`);
}

// The standalone half of one link call, refused before anything is written.
// Declaring it beside an outcome is the one combination that cannot be true:
// a unit that stands alone contributes to nothing, so the two statements are
// made one at a time and the second one is the correction of the first.
function standaloneEdges(work: WorkState, values: CommandInput<typeof LINK_OPTIONS>["values"],
    link: boolean): Record<string, unknown>[]
{
    if (values.standalone !== true)
    {
        return [];
    }
    if (values.objective !== undefined || values.milestone !== undefined)
    {
        throw new CliError("a unit that stands alone contributes to no outcome — state one or the other, "
            + `and withdraw the edge it no longer needs with \`self work unlink ${work.id} --objective|--milestone <id>\``);
    }
    return link ? [declaredStandalone(work, values)] : [withdrawnStandalone(work, values)];
}

function declaredStandalone(work: WorkState, values: CommandInput<typeof LINK_OPTIONS>["values"]): Record<string, unknown>
{
    requireOptions("work link", values, [STANDALONE_WHY]);
    if (work.standalone !== undefined)
    {
        throw new CliError(`${work.id} already stands alone — ${work.standalone.why}; one edge is one link, so restate it `
            + `with \`self work unlink ${work.id} --standalone\` and declare it again`);
    }
    return { ...standaloneEdge(work.id, required(values.why)) };
}

function withdrawnStandalone(work: WorkState, values: CommandInput<typeof LINK_OPTIONS>["values"]): Record<string, unknown>
{
    if (values.why !== undefined)
    {
        throw new CliError("work unlink --standalone withdraws the declaration and states nothing of its own — "
            + "what the unit contributes to now is the link that replaces it");
    }
    if (work.standalone === undefined)
    {
        throw new CliError(`${work.id} does not stand alone — a unit declares it with `
            + `\`self work link ${work.id} --standalone --why "<why it contributes to no outcome>"\``);
    }
    return { ...standaloneEdge(work.id) };
}

// The edges one call states, resolved before anything is written. An objective
// resolves across the workspace (#244); a milestone resolves in the current
// project only, so a foreign milestone id is refused as unknown here. Only a
// foreign objective's edge carries the owning slug — a local link stays
// byte-identical to what it always was.
function linkEdges(ctx: ProjectContext, model: ProjectModel,
    values: CommandInput<typeof LINK_OPTIONS>["values"], verb: string): Record<string, unknown>[]
{
    if (values.objective === undefined && values["objective-project"] !== undefined)
    {
        throw new CliError(`${verb} --objective-project needs --objective <id> to resolve`);
    }
    const edges: Record<string, unknown>[] = [];
    if (values.objective !== undefined)
    {
        const found = findObjectiveAcross(ctx, model, values.objective, values["objective-project"]);
        edges.push(found.slug === ctx.project
            ? { type: "member-of", target: found.objective.id }
            : { type: "member-of", target: found.objective.id, project: found.slug });
    }
    if (values.milestone !== undefined)
    {
        edges.push({ type: "member-of", target: requireMilestone(model, values.milestone).milestone.id });
    }
    return edges;
}

/* ── what a work correction may replace ────────────────────────────── */

// The one answer to "may this unit be retired": known, and not already closed
// as done. Read by `work retire`, by `work add --supersedes`, which records
// the same retirement, and by `work propose --supersedes`, which carries it
// until a person accepts. Already-retired is the caller's case to answer — a
// no-op for one, a refusal for the others.
export function requireRetirable(model: ProjectModel, id: string | undefined): WorkState
{
    const wanted = requireText(id, "work retire <work-id> — run `self work` to list ids");
    const work = model.works.find((item) => item.id === wanted);
    if (work === undefined)
    {
        throw new CliError(wrongKindHint(wanted, "work") ?? `unknown work id "${wanted}" — run \`self work\` to list ids`);
    }
    if (work.status === "done")
    {
        throw new CliError(`${work.id} is already done — retirement records an outcome that was given up, not one that was reached`);
    }
    return work;
}

// The target of `--supersedes` on a work verb, resolved the one way both
// spellings resolve it (#389). `work add` retires it in the same append and
// `work propose` records the intention to; a target one accepts and the other
// refuses would be two corrections wearing one flag.
export function requireSupersedableWork(ctx: ProjectContext, model: ProjectModel, wanted: string): WorkState
{
    requireSupersedeKind(model.entities, wanted, "work");
    refuseForeignTarget(ctx, model, wanted);
    const work = requireRetirable(model, wanted);
    if (work.status === "retired")
    {
        // Not the no-op `work retire` answers with: a record is about to be
        // written claiming a supersession that never happened.
        throw new CliError(`${work.id} is already retired — ${work.retiredWhy}`);
    }
    if (work.status === "review")
    {
        // A plan nobody has accepted is corrected by restating it under its own
        // id (#356), which keeps one plan's history in one record. Superseding
        // it would mint a second id for a plan that was never approved.
        throw new CliError(`${work.id} is a plan still awaiting review — restate it instead: `
            + `\`self work revise ${work.id} "<revised plan>" --why w\` keeps its id`);
    }
    return work;
}

// A correction is recorded in the log that holds the unit it replaces, so an
// id another registered project owns is refused by naming that project rather
// than by calling it unknown: the reader is standing in the wrong checkout,
// not looking at a typo. Only asked where this project does not hold the id,
// so the ordinary path folds nothing extra.
function refuseForeignTarget(ctx: ProjectContext, model: ProjectModel, wanted: string): void
{
    if (model.works.some((item) => item.id === wanted))
    {
        return;
    }
    for (const other of workspaceModels(ctx.storeDir, ctx.project))
    {
        if (other.slug !== ctx.project && other.works.some((item) => item.id === wanted))
        {
            throw new CliError(`${wanted} is ${other.slug}'s unit, and a correction is recorded where the unit is — `
                + `run this in ${other.slug}'s checkout`);
        }
    }
}

/* ── goal-gap proposals ────────────────────────────────────────────── */

// A proposal is a proposed work entity (#207 B13): the brief rides the
// creation event, and accepting is confirming — the proposal's id is the
// unit's id. Since #356 the plain form takes the plan text alone: the brief
// belongs to a proposal that closes a stated gap, not to every proposal.
function cmdPropose({ values, positionals }: CommandInput<typeof PROPOSAL_OPTIONS>): CommandOutput
{
    const ctx = requireProject(process.cwd());
    const outcome = requireText(positionals[0], PROPOSE_USAGE);
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const brief = briefFor(model, outcome, values as Record<string, string | string[] | undefined>);
    requireNovel(model, outcome, brief);
    const id = workId();
    const born = proposedStandalone(id, values);
    const supersedes = proposedSupersession(ctx, model, values);
    const payload = proposedPayload(ctx, id, outcome, brief, supersedes, declarationOf(values, "work propose"), born);
    recordEvent(ctx, makeEvent(ctx.project, "entity.proposed", strip({ ...payload, by: writtenBy() })), `${outcome}`);
    return [{ kind: "receipt", text: proposalReceipt(id, supersedes) }];
}

// The disposition a plan states about the unit it will become (#417 §1). It
// rides the proposal's own creation links, so the acceptance carries it
// without a second statement — confirming a plan is confirming what it said.
//
// A plan that names a gap contributes to that gap by construction, and `--why`
// on this verb already states why a superseded unit gave up its outcome, so
// both pairings are refused rather than half-recorded.
function proposedStandalone(id: string, values: CommandInput<typeof PROPOSAL_OPTIONS>["values"]): Record<string, unknown>[]
{
    if (values.standalone !== true)
    {
        return [];
    }
    if (values.objective !== undefined || values.milestone !== undefined)
    {
        throw new CliError("work propose --standalone plans a unit that closes no stated gap — drop --objective and --milestone, "
            + "or drop --standalone and give the gap proposal its brief");
    }
    if (values.supersedes !== undefined)
    {
        throw new CliError("work propose --why states why the replaced unit gave up its outcome, and --standalone needs a "
            + "reason of its own — propose the correction first, then `self work link <new-id> --standalone --why \"…\"`");
    }
    requireOptions("work propose", values, [STANDALONE_WHY]);
    return [{ ...standaloneEdge(id, required(values.why)) }];
}

function proposedPayload(ctx: ProjectContext, id: string, outcome: string, brief: Record<string, unknown>,
    supersedes: SupersedePlan | undefined, declared: Declaration, links: Record<string, unknown>[]): Record<string, unknown>
{
    const row = presetRow(ctx.storeDir, "work");
    const { outcome: text, ...rest } = brief;
    void text;
    return {
        entity: id,
        text: outcome,
        labels: [row.label],
        links,
        // What the plan declares, in the order it was declared. The hard-coded
        // empty list this carried until #408 is what a call declaring nothing
        // still writes, so a proposal from before this issue is unchanged.
        ...declared,
        exposure: row.exposure,
        scope: "project",
        priority: row.priority,
        ...rest,
        supersedes
    };
}

// What a correction proposed rather than recorded carries (#389): the unit it
// replaces *on acceptance*, and why the outcome moved. It is a payload field
// and not a supersedes link, because a work correction is a retirement with a
// successor — the pair `work add --supersedes` writes — and a link would fold
// the target to a superseded statement instead. Every existing fold pass
// ignores it; `work confirm` is the one reader.
interface SupersedePlan
{
    entity: string;
    why: string;
}

function proposedSupersession(ctx: ProjectContext, model: ProjectModel,
    values: CommandInput<typeof PROPOSAL_OPTIONS>["values"]): SupersedePlan | undefined
{
    if (values.supersedes === undefined)
    {
        // A standalone declaration owns the `--why` on such a call, and
        // `proposedStandalone` has already refused the pair that would make
        // one reason answer for two statements.
        if (values.why !== undefined && values.standalone !== true)
        {
            throw new CliError("work propose --why states why a replaced unit gave up its outcome — "
                + "pass --supersedes <work-id> too, or record the reason with `self report`");
        }
        return undefined;
    }
    const work = requireSupersedableWork(ctx, model, values.supersedes);
    return {
        entity: work.id,
        why: requireText(values.why, `work propose "<plan>" --supersedes ${work.id} --why "<why the outcome moved to the new unit>"`)
    };
}

// The receipt says what acceptance will do, because that is the half a reader
// cannot see: the target is untouched until then, and a plan that quietly
// carried a retirement would be one a person accepted without being told.
function proposalReceipt(id: string, supersedes: SupersedePlan | undefined): string
{
    return supersedes === undefined
        ? id
        : `${id}\n  replaces ${supersedes.entity} on acceptance — ${supersedes.entity} is untouched `
            + `until it is confirmed with \`self work confirm ${id}\``;
}

// What the creation event carries beyond the plan text: a gap proposal's full
// brief, or nothing at all. The link is what the brief hangs on, so it is also
// what decides whether the brief is demanded (#356).
function briefFor(model: ProjectModel, outcome: string, values: Record<string, string | string[] | undefined>): Record<string, unknown>
{
    if (values.objective !== undefined || values.milestone !== undefined)
    {
        return proposalPayload(model, outcome, values);
    }
    refuseStrayBrief(values);
    return {};
}

// The planning flags a gap proposal carries. Named here so the standalone
// form can refuse a stray one by name instead of recording half a brief
// nothing reads.
const BRIEF_FLAGS = ["value", "success", "stop", "depends", "risk", "capacity", "evidence-plan", "confidence", "expires"];

function refuseStrayBrief(values: Record<string, string | string[] | undefined>): void
{
    const stray = BRIEF_FLAGS.find((flag) => values[flag] !== undefined);
    if (stray !== undefined)
    {
        throw new CliError(`work propose --${stray} belongs to a gap proposal — add --objective <id> or --milestone <id>, or drop the planning flags`);
    }
}

// The brief a gap proposal owes, refused through the one required-option gate
// so a call missing several is told all of them at once (#106). Judged here
// rather than declared on the leaf because it depends on another flag's value.
function proposalPayload(model: ProjectModel, outcome: string, values: Record<string, string | string[] | undefined>): Record<string, unknown>
{
    requireOptions("work propose", values, GAP_PROPOSAL_REQUIRED);
    if (!CONFIDENCE.includes(values.confidence as string))
    {
        throw new CliError(`work propose --confidence must be one of ${CONFIDENCE.join(", ")}`);
    }
    const success = (values.success ?? []) as string[];
    const stop = (values.stop ?? []) as string[];
    return strip({
        outcome,
        objective: values.objective === undefined ? undefined : requireObjective(model, values.objective as string).id,
        milestone: values.milestone === undefined ? undefined : requireMilestone(model, values.milestone as string).milestone.id,
        value: values.value,
        success,
        stop,
        depends: (values.depends ?? []) as string[],
        risk: values.risk,
        capacity: values.capacity,
        evidencePlan: values["evidence-plan"],
        confidence: values.confidence,
        expires: validDate(values.expires as string)
    });
}

// Deduplicated against both open proposals and open work already aimed at the
// same outcome, so an agent scanning the same gap twice cannot queue it twice.
function requireNovel(model: ProjectModel, outcome: string, payload: Record<string, unknown>): void
{
    const key = normalize(outcome);
    // An outcome made only of punctuation or emoji carries nothing to compare,
    // and every such outcome would compare equal to every other. Two of them
    // are not the same proposal, so the key that says nothing matches nothing.
    if (key === "")
    {
        return;
    }
    const target = (payload.milestone ?? payload.objective) as string | undefined;
    if (target === undefined)
    {
        requireNovelPlan(model, key);
        return;
    }
    const clash = model.goals.proposals.find((proposal) =>
        proposal.status === "open" && !proposal.expired && normalize(proposal.outcome) === key
        && (proposal.milestone ?? proposal.objective) === target);
    if (clash !== undefined)
    {
        throw new CliError(`proposal ${clash.id} already proposes this outcome for ${target} — accept or decline it instead`);
    }
    const existing = model.works.find((work) => work.status !== "done" && work.status !== "retired" && normalize(work.outcome) === key
        && [...work.objectives, ...work.milestones].includes(target));
    if (existing !== undefined)
    {
        throw new CliError(`${existing.id} already carries this outcome for ${target}`);
    }
}

// A standalone proposal names no gap, so the outcome alone is its key —
// keying on the absent target instead would make every standalone proposal
// clash with every other. Compared against the plans still awaiting review;
// a plan someone already accepted is a unit, and proposing it again is a
// different mistake from queuing the same review twice.
//
// The condition is a function of its own, and exported, because a second
// caller needs the answer without the refusal: `self sweep --record` composes
// several proposals in one append, and a gate that throws would stop the whole
// append at the first cluster somebody already proposed (#381). The two
// alternatives are both worse — a `try/catch` per cluster uses an exception for
// control flow and would swallow whatever else this gate learns to refuse
// later, and a re-check inside the sweep is the duplicated gate condition
// ARCHITECTURE.md forbids. One condition, one implementation, two callers.
export function clashingPlan(model: ProjectModel, key: string): WorkState | undefined
{
    return model.works.find((work) => work.status === "review" && normalize(work.outcome) === key
        && work.objectives.length === 0 && work.milestones.length === 0);
}

function requireNovelPlan(model: ProjectModel, key: string): void
{
    const clash = clashingPlan(model, key);
    if (clash !== undefined)
    {
        throw new CliError(`proposal ${clash.id} already proposes this plan — accept, decline or revise it instead`);
    }
}

// Two outcomes are the same when they carry the same letters and numbers in
// the same order, whatever spacing, case or punctuation they were typed with.
// The classes are Unicode ones on purpose: a script-by-script allow list drops
// every language nobody thought to add, and text that loses all its characters
// stops comparing as itself and starts comparing as everything else. NFC is
// applied first so the same word typed decomposed keys the same way.
//
// Exported since #381: the sweep keys its clusters the same way this gate keys
// its proposals, and a second normalization beside this one would let a cluster
// key that the gate calls novel be the very text it already refuses.
export function normalize(text: string): string
{
    return text.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// Accept is confirm and decline is the withdrawal (#207 B13): the proposal
// entity becomes the unit under its own id, and the grouping edge toward the
// outcome it closes lands in the same append.
//
// Both resolve their project from the proposal rather than from the directory
// (#302): `self work confirm <id>` is the call to action a `--project` context
// prints under Waiting on you, and a reader outside that project was handed a
// line they could not run.
function cmdProposalDecision({ values, positionals }: CommandInput<typeof WHY_OPTION>, accept: boolean): CommandOutput
{
    const wanted = requireText(positionals[0], PROPOSAL_USAGE);
    const { ctx, model } = recordOwner(process.cwd(), wanted, (candidate) => holdsProposal(candidate, wanted));
    const proposal = requireProposal(model, wanted);
    if (!accept)
    {
        const why = required(values.why);
        // Declining answers with the append's own line and nothing more: the
        // proposal is gone, so there is no id left worth handing back.
        recordEvent(ctx, makeEvent(ctx.project, "entity.retracted", { entity: proposal.id, why, by: writtenBy() }, { declines: proposal.id }, true), `${proposal.text}`);
        return [];
    }
    recordAcceptance(ctx, model, proposal);
    return [{ kind: "receipt", text: proposal.id }];
}

// The acceptance itself. A plan that carries no supersession is the append it
// always was; one that carries a correction goes through the retirement path,
// so the confirm and the retirement land as one disclosed append — the pair
// `work add --supersedes` writes today.
function recordAcceptance(ctx: ProjectScope, model: ProjectModel, proposal: Answerable): void
{
    const carried = carriedSupersession(ctx, proposal);
    if (carried === undefined)
    {
        recordEvents(ctx, acceptEvents(ctx, model, proposal, writtenBy()), `${proposal.id} ${proposal.text}`);
        return;
    }
    const target = acceptedTarget(ctx, model, proposal, carried);
    const successor = model.entities.find((item) => item.id === proposal.id);
    recordRetirement(ctx, retirementIntent(model, "supersede", [target.id],
        { successor: supersedingRecord({ text: proposal.text, labels: successor?.labels ?? [] }) }), model,
        (by) => [...acceptEvents(ctx, model, proposal, by),
            makeEvent(ctx.project, "entity.retired", strip({
                entity: target.id, why: carried.why, successor: proposal.id, successorProject: ctx.project, by
            }), undefined, true)],
        `${proposal.id} ${proposal.text}`);
}

// The supersession a proposal carried, read back off its creation event —
// the one caller of `payload.supersedes`, since no fold pass reads it. Nothing
// out of the log is trusted to be its declared shape: a field that is not an
// object naming a work id reads as absent, and the plan accepts as a plain one.
function carriedSupersession(ctx: ProjectScope, proposal: Answerable): SupersedePlan | undefined
{
    const created = readEvents(ctx.storeDir, ctx.project)
        .find((event) => event.type === "entity.proposed" && event.payload.entity === proposal.id);
    const carried = created?.payload.supersedes as Partial<SupersedePlan> | undefined;
    if (typeof carried?.entity !== "string" || carried.entity === "")
    {
        return undefined;
    }
    return { entity: carried.entity, why: typeof carried.why === "string" ? carried.why : "" };
}

// The carried target, judged against the model as it stands now. A unit that
// closed between the proposal and the acceptance is not retired over: the
// acceptance is refused whole, and the plan stays open for a person to revise
// or decline.
function acceptedTarget(ctx: ProjectScope, model: ProjectModel, proposal: Answerable, carried: SupersedePlan): WorkState
{
    const work = model.works.find((item) => item.id === carried.entity);
    if (work === undefined)
    {
        throw driftRefusal(ctx, proposal, carried.entity, `no record here answers to ${carried.entity}`);
    }
    if (work.status === "done")
    {
        throw driftRefusal(ctx, proposal, work.id, `${work.id} is already done`);
    }
    if (work.status === "retired")
    {
        throw driftRefusal(ctx, proposal, work.id, `${work.id} is already retired — ${work.retiredWhy}`);
    }
    return work;
}

function driftRefusal(ctx: ProjectScope, proposal: Answerable, target: string, reason: string): CliError
{
    return new CliError([
        `${proposal.id} proposes to replace ${target}, and ${reason} — nothing was recorded`,
        "",
        `  a person accepts the plan without the replacement by revising it in ${ctx.project}:`,
        `    self work revise ${proposal.id} "<plan>" --why "${target} closed on its own"`,
        "",
        "  or declines it:",
        `    self work decline ${proposal.id} --why "…"`
    ].join("\n"));
}

// The acceptance names the exact revision it approves (#356) — the record's
// own id until the plan was restated — so a plan revised after this was
// written is not authorized by it, however a merged log ordered the two. The
// grouping edge toward the gap rides the same append, and is left alone where
// a re-acceptance would only state it twice.
// `by` rides both halves: the confirm and the grouping edge are one act, and a
// reader asking who confirmed this plan should not have to know which of the
// two events to look at (#400).
function acceptEvents(ctx: ProjectScope, model: ProjectModel, proposal: Answerable,
    by: WrittenBy): SelfEvent[]
{
    const events = [makeEvent(ctx.project, "entity.confirmed",
        { entity: proposal.id, by }, { confirms: proposal.confirms }, true)];
    if (proposal.target !== undefined && !alreadyToward(model, proposal))
    {
        events.push(makeEvent(ctx.project, "entity.linked",
            { entity: proposal.id, link: { type: "member-of", target: proposal.target }, by }, undefined, true));
    }
    return events;
}

function alreadyToward(model: ProjectModel, proposal: Answerable): boolean
{
    return model.entities.some((item) => item.id === proposal.id
        && item.links.some((link) => link.type === "member-of" && link.target === proposal.target));
}

/* ── revising an unstarted plan (#356) ─────────────────────────────── */

// Restating a plan under the id it was proposed under. Append-only: the
// previous version stays in the record's own history, the acceptance that
// approved it stops authorizing a start, and nothing is superseded — which is
// why a started plan cannot come here at all.
function cmdWorkRevise({ values, positionals }: CommandInput<typeof REVISE_OPTIONS>): CommandOutput
{
    const ctx = requireProject(process.cwd());
    const wanted = requireText(positionals[0], REVISE_USAGE);
    const text = requireText(positionals[1], REVISE_USAGE);
    const { entity, owner } = requireRevisable(ctx, wanted);
    // Before the no-op check: the flag is refused whatever the text says,
    // because a revision restates the plan and says nothing about the list.
    if (values.criteria !== undefined)
    {
        throw new CliError("work revise restates the plan text — declare a criterion with "
            + `\`self work criteria add ${entity.id} "<text>"\`, which appends it to the ones already declared`);
    }
    if (entity.text === text)
    {
        throw new CliError(`${entity.id} already states this plan — a revision restates it, and this changes nothing`);
    }
    const why = required(values.why);
    recordEvent(ctx, makeEvent(owner, "entity.revised", { entity: entity.id, text, why }), `${entity.id} ${text}`);
    return [{
        kind: "receipt",
        text: `${entity.id} — v${(entity.plan?.current ?? 1) + 1}; confirm it with \`self work confirm ${entity.id}\``
    }];
}

// The record a revision names, and the log that owns it — the same resolution
// `work start` makes, so a unit scoped in from another project is revised
// where its record lives (#181 D3). Since #305 every folded unit is a record
// here, so a pre-cutover id reads as the unknown id it now is.
function requireRevisable(ctx: ProjectContext, wanted: string): { entity: EntityState; owner: string }
{
    for (const model of workspaceModels(ctx.storeDir, ctx.project))
    {
        const entity = model.entities.find((item) => item.id === wanted);
        if (entity !== undefined && rendersHere(model, entity, ctx.project))
        {
            refuseUnrevisable(entity);
            return { entity, owner: model.slug };
        }
    }
    throw new CliError(wrongKindHint(wanted, "work") ?? `unknown work id "${wanted}" — run \`self work\` to list ids`);
}

// A project's own records answer here whatever project they render in, and
// another project's records answer only where they render — the rule
// `work start` resolves an owner by (#181 D3/D5).
function rendersHere(model: ProjectModel, entity: EntityState, viewer: string): boolean
{
    return model.slug === viewer || rendersIn(entity, model.slug, viewer);
}

// Everything a revision is refused for, in the order a reader needs to hear
// it: what the record is, what has already happened to it, and only then that
// the plan is frozen.
function refuseUnrevisable(entity: EntityState): void
{
    if ((entity.source ?? "entity") !== "work")
    {
        const found = entity.source ?? "plain";
        throw new CliError(`${entity.id} is a ${found} record, and work revise restates a work plan — correct it with ${supersedeSpelling(entity.source ?? "entity", entity.id)}`);
    }
    refuseClosedPlan(entity);
    if (entity.startedOnce === true)
    {
        throw new CliError(`${entity.id} has already been picked up — a plan that has started is corrected with a successor: `
            + supersedeSpelling("work", entity.id));
    }
    if (!isWorkProposal(entity))
    {
        throw new CliError(`${entity.id} was recorded with \`work add\`, which is the already-approved path — correct it with a successor: `
            + supersedeSpelling("work", entity.id));
    }
}

function refuseClosedPlan(entity: EntityState): void
{
    if (entity.execution?.status === "done")
    {
        throw new CliError(`${entity.id} is already done`);
    }
    if (entity.execution?.status === "retired")
    {
        throw new CliError(`${entity.id} is retired — ${entity.execution.why ?? "its outcome was given up"}; see \`self work show ${entity.id}\``);
    }
    if (entity.status === "retracted")
    {
        throw new CliError(`${entity.id} is already ${entity.confirmedOnce ? "withdrawn" : "declined"} — ${entity.closedWhy ?? "it was taken back"}`);
    }
    if (entity.status === "superseded")
    {
        throw new CliError(`${entity.id} was superseded by ${entity.supersededBy ?? "a successor"} — revise the successor instead`);
    }
}

/* ── console output ────────────────────────────────────────────────── */

// What `self work add` prints under the new id (#286). The CLI has always
// believed a unit contributes to something — `work propose` refuses without
// the gap it closes — and `add` was the one path that never said so, which is
// why work created in the ordinary way is unattached by construction.
//
// It names targets and spells out the command; it refuses nothing. The unit is
// already recorded by the time this renders, and superself forces no
// methodology.
export function attachmentListing(model: ProjectModel, work: string, superseded?: WorkState,
    standalone = false): ListingBlock
{
    const objectives = openObjectives(model.goals);
    const rows = [
        ...carriedLinks(model, work, superseded),
        ...(objectives.length === 0
            ? [NO_OBJECTIVE_HINT]
            : objectives.flatMap((objective) => attachmentRows(objective, work))),
        // Not offered to a unit that was born with the declaration: the caller
        // has already answered, and an offer repeated back at them reads as a
        // command that did not take.
        ...(standalone ? [] : standaloneOffer(work))
    ];
    return {
        kind: "listing",
        rows,
        // A person at a terminal is reading the receipt, not this: the whole
        // block is dim so it reads as an offer under the answer.
        pretty: () => rows.map((row) => dim(row)),
        // The objectives, not the lines: a checkpoint, a link command and a
        // carry-over row all render under an objective, and counting those
        // would tell a reader they have more outcomes than they have.
        total: objectives.length,
        noun: "open objective"
    };
}

// The third answer, offered where the other two are (#417 §1). A unit that
// contributes to nothing on purpose says so with a reason, and an offer it
// never sees is one no agent reaches for — which is how work with no stated
// disposition became indistinguishable from work nobody had got to yet.
function standaloneOffer(work: string): string[]
{
    return [
        "contributes to nothing on purpose? say so, with the reason:",
        `    self work link ${work} --standalone --why "<why it contributes to no outcome>"`
    ];
}

// One objective and its checkpoints, each under the command that attaches this
// unit to it. Proposed objectives are offered too, because `work link` accepts
// one — an offer the tool would refuse is worse than no offer.
function attachmentRows(objective: ObjectiveState, work: string): string[]
{
    return [
        `${objective.id}  ${stateMark(objective.state)}  ${objective.outcome}`,
        `    self work link ${work} --objective ${objective.id}`,
        ...objective.milestones.flatMap((milestone) => [
            `  ${milestone.id}  ${stateMark(milestone.state)}  ${milestone.outcome}`,
            `      self work link ${work} --milestone ${milestone.id}`
        ])
    ];
}

// What the unit being replaced was attached to, so a correction does not
// silently drop it. Cross-project links are read separately: `contributionsOf`
// resolves ids in this project's own goal tree, and a foreign objective's id
// is not in it (#244), so reading only that would report "attached to nothing"
// for a unit that was attached all along.
function carriedLinks(model: ProjectModel, work: string, superseded?: WorkState): string[]
{
    if (superseded === undefined)
    {
        return [];
    }
    const carried = [
        ...contributionsOf(model.goals, superseded).flatMap((item) => [
            `  ${item.id}  ${item.outcome}`,
            `    self work link ${work} --${item.kind} ${item.id}`
        ]),
        ...superseded.foreignObjectives.flatMap((link) => [
            `  ${link.id} (${link.project})`,
            `    self work link ${work} --objective ${link.id} --objective-project ${link.project}`
        ])
    ];
    return carried.length === 0 ? [] : [`${superseded.id} was attached to these, and this unit is not yet:`, ...carried, ""];
}

// The size is the objectives, not the lines: a checkpoint renders indented
// under the objective it belongs to, and counting those rows would tell a
// reader they have more outcomes than they have. The workspace objectives
// another project owns (#287) lead the rows and count with them — they are
// outcomes this project is read under, which is what the size is about — and
// their checkpoints stay home, because a milestone is project-scoped.
function objectiveListing(model: ProjectModel, contributors: Map<string, string[]>, leading: string[] = []): ListingBlock
{
    const objectives = openObjectives(model.goals);
    return {
        kind: "listing",
        rows: objectives.length === 0 && leading.length === 0
            ? ['no objectives — the long-term goal is separate; add one with `self objective add "<outcome>"`']
            : [...leading, ...objectives.flatMap((objective) => [
                objectiveRow(model, objective, contributors),
                ...objective.milestones.map((milestone) =>
                    `  ${milestone.id}  ${stateMark(milestone.state)}  ${milestone.outcome} — ${milestone.reason}`)
            ])],
        total: objectives.length + leading.length,
        noun: "open objective"
    };
}

function objectiveRow(model: ProjectModel, objective: ObjectiveState, contributors: Map<string, string[]>): string
{
    const target = objective.target === undefined ? "" : ` · ${objective.horizon ?? "target"} ${objective.target}`;
    const linked = openLocalWork(model, objective).length + (contributors.get(objective.id) ?? []).length;
    const flags = ` [${linked === 0 ? "no work linked" : `${linked} work unit(s)`}]`;
    return `${objective.id}  ${stateMark(objective.state)}  ${objective.outcome}${styled ? dim(target) : target}${flags}`;
}

function milestoneListing(model: ProjectModel): ListingBlock
{
    // Closed checkpoints are left out for the same reason every other current
    // render leaves them out: dropped, superseded, or belonging to a closed
    // objective, none of them is a checkpoint anybody is working toward.
    // `self milestone show` and `self search --type milestone` still answer.
    const milestones = allMilestones(model.goals).filter((milestone) => milestone.state !== "closed");
    return {
        kind: "listing",
        rows: milestones.length === 0
            ? ["no milestones — add one with `self milestone add \"<outcome>\" --objective <id> --exit \"<criterion>\"`"]
            : milestones.map((milestone) =>
                `${milestone.id}  ${stateMark(milestone.state)}  ${milestone.outcome} — ${milestone.reason} [${milestoneFlags(milestone)}]`),
        total: milestones.length,
        noun: "milestone"
    };
}

function milestoneFlags(milestone: MilestoneState): string
{
    return [
        milestone.criticalPath ? "critical path" : "",
        milestone.works.length === 0 ? "no work linked" : `${milestone.works.length} work unit(s)`
    ].filter((flag) => flag !== "").join(" · ");
}

function stateMark(state: string): string
{
    return styled ? state.padEnd(9) : state;
}

/* ── lookups and validation ────────────────────────────────────────── */

function requireObjective(model: ProjectModel, id: string | undefined): ObjectiveState
{
    const wanted = requireText(id, "… <objective-id> — run `self objective` to list ids");
    const objective = model.goals.objectives.find((item) => item.id === wanted);
    if (objective === undefined)
    {
        throw new CliError(wrongKindHint(wanted, "objective") ?? `unknown objective "${wanted}" — run \`self objective\` to list ids`);
    }
    return objective;
}

// An objective and the registered project whose log owns it.
interface FoundObjective
{
    slug: string;
    objective: ObjectiveState;
}

// The `findWorkAcross` precedent (#181, #244): a bare id resolves in the
// current project first and wins there outright; an id held only by other
// projects resolves alone or is refused by naming every holder; the flag
// resolves in the named project without the search.
function findObjectiveAcross(ctx: ProjectContext, model: ProjectModel, id: string | undefined, project: string | undefined): FoundObjective
{
    const wanted = requireText(id, "… --objective <id> — run `self objective` to list ids");
    if (project !== undefined)
    {
        return objectiveIn(ctx, model, wanted, requireRegistered(ctx.storeDir, project));
    }
    const others = readRegistry(ctx.storeDir).map((entry) => entry.slug).filter((slug) => slug !== ctx.project);
    const matches: FoundObjective[] = [];
    for (const slug of [ctx.project, ...others])
    {
        const source = slug === ctx.project ? model : buildModel(ctx.storeDir, slug, new Date());
        const objective = source.goals.objectives.find((item) => item.id === wanted);
        if (objective !== undefined)
        {
            matches.push({ slug, objective });
        }
    }
    return settleObjectiveMatches(ctx, wanted, matches);
}

function settleObjectiveMatches(ctx: ProjectContext, wanted: string, matches: FoundObjective[]): FoundObjective
{
    if (matches.length > 0 && matches[0].slug === ctx.project)
    {
        return matches[0];
    }
    if (matches.length > 1)
    {
        throw new CliError(`objective "${wanted}" exists in more than one project (${matches.map((m) => m.slug).join(", ")}) — pass --objective-project <slug>`);
    }
    if (matches.length === 0)
    {
        throw new CliError(wrongKindHint(wanted, "objective") ?? `unknown objective "${wanted}" — no registered project has it; run \`self objective --workspace\` to list ids`);
    }
    return matches[0];
}

// The flag resolves in the named project alone, and naming the current one
// records the local shape — the mirror of `--successor-project`.
function objectiveIn(ctx: ProjectContext, model: ProjectModel, wanted: string, slug: string): FoundObjective
{
    const source = slug === ctx.project ? model : buildModel(ctx.storeDir, slug, new Date());
    const objective = source.goals.objectives.find((item) => item.id === wanted);
    if (objective === undefined)
    {
        throw new CliError(`no objective "${wanted}" in ${slug} — run \`self objective --project ${slug}\` to list ids`);
    }
    return { slug, objective };
}

function requireMilestone(model: ProjectModel, id: string | undefined): { objective: ObjectiveState; milestone: MilestoneState }
{
    const wanted = requireText(id, "… <milestone-id> — run `self milestone` to list ids");
    const found = findMilestone(model.goals, wanted);
    if (found === null)
    {
        throw new CliError(wrongKindHint(wanted, "milestone") ?? `unknown milestone "${wanted}" — run \`self milestone\` to list ids`);
    }
    return found;
}

function requireSibling(objective: ObjectiveState, id: string): string
{
    if (!objective.milestones.some((milestone) => milestone.id === id))
    {
        throw new CliError(`"${id}" is not a milestone of ${objective.id}`);
    }
    return id;
}

function requireCriterion(milestone: MilestoneState, id: string): { id: string; text: string }
{
    const criterion = milestone.exit.find((item) => item.id === id && item.dropped !== true);
    if (criterion === undefined)
    {
        const live = milestone.exit.filter((item) => item.dropped !== true).map((item) => item.id).join(", ");
        throw new CliError(`"${id}" is not a live exit criterion of ${milestone.id} — it has ${live}`);
    }
    return criterion;
}

function requireWork(model: ProjectModel, id: string | undefined): WorkState
{
    const wanted = requireText(id, "… <work-id> — run `self work` to list ids");
    const work = model.works.find((item) => item.id === wanted);
    if (work === undefined)
    {
        throw new CliError(wrongKindHint(wanted, "work") ?? `unknown work id "${wanted}" — run \`self work\` to list ids`);
    }
    return work;
}

// Coverage cites a work unit only where the contribution was stated first, so
// a milestone can never quietly absorb work nobody linked to it.
function requireLinkedWork(model: ProjectModel, milestone: MilestoneState, id: string): WorkState
{
    const work = requireWork(model, id);
    if (!work.milestones.includes(milestone.id))
    {
        throw new CliError(`${work.id} does not contribute to ${milestone.id} — run \`self work link ${work.id} --milestone ${milestone.id}\` first`);
    }
    return work;
}

const PROPOSAL_USAGE = "… <proposal-id> — run `self context` to list open proposals";

// What `work confirm` and `work decline` answer to, whichever fold carries it:
// a gap proposal, whose brief the goal fold reads, and a standalone plan
// (#356), which only the entity view carries. One shape and one list, so a
// prefix means the same thing on both paths and neither verb grows a second
// resolver.
interface Answerable
{
    id: string;
    text: string;
    // The objective or milestone an acceptance links the unit to, where the
    // proposal named one.
    target?: string;
    // What the acceptance binds to: the current revision (#356), which is the
    // record's own id until the plan has been restated.
    confirms: string;
    status: "open" | "accepted" | "declined";
}

function answerables(model: ProjectModel): Answerable[]
{
    const proposals = model.goals.proposals.map((item) => fromProposal(model, item));
    const named = new Set(proposals.map((item) => item.id));
    return [...proposals, ...model.entities.filter((item) => isWorkProposal(item) && !named.has(item.id)).map(fromRecord)];
}

function fromProposal(model: ProjectModel, proposal: WorkProposal): Answerable
{
    const entity = model.entities.find((item) => item.id === proposal.id);
    return {
        id: proposal.id,
        text: proposal.outcome,
        target: proposal.milestone ?? proposal.objective,
        confirms: entity?.plan?.event ?? proposal.id,
        status: proposal.status
    };
}

function fromRecord(entity: EntityState): Answerable
{
    return {
        id: entity.id,
        text: entity.text,
        confirms: entity.plan?.event ?? entity.id,
        status: awaitsReview(entity) ? "open" : entity.status === "retracted" ? "declined" : "accepted"
    };
}

// Whether `requireProposal` would find anything here, asked of a whole project
// so `recordOwner` can pick the one whose lookup is about to succeed. Status is
// deliberately not part of it: a proposal already accepted or declined is held
// by its project, and "it is already declined" is the answer a reader needs —
// not "no registered project holds it".
function holdsProposal(model: ProjectModel, wanted: string): boolean
{
    return answerables(model).some((proposal) => proposal.id.startsWith(wanted));
}

function requireProposal(model: ProjectModel, prefix: string | undefined): Answerable
{
    const wanted = requireText(prefix, PROPOSAL_USAGE);
    const matches = answerables(model).filter((proposal) => proposal.id.startsWith(wanted));
    if (matches.length !== 1)
    {
        throw new CliError(matches.length === 0
            ? `no work proposal matches "${wanted}"`
            : `proposal id "${wanted}" is ambiguous (${matches.length} matches)`);
    }
    if (matches[0].status !== "open")
    {
        throw new CliError(`proposal ${matches[0].id} is already ${matches[0].status}`);
    }
    return matches[0];
}

// An outcome is the one thing that cannot be withdrawn — a target with no
// statement of what it is for is not a target anyone can judge.
function restated(value: string | undefined, kind: string): string | undefined
{
    if (value !== undefined && value.trim() === "")
    {
        throw new CliError(`--outcome cannot be emptied — the ${kind} would have no stated outcome left to judge`);
    }
    return value;
}

// A timebox someone withdraws has to be able to leave: an empty value records
// an explicit null, which the fold reads as "this field is gone" rather than
// "this field was not mentioned". Without it a date the user took back keeps
// deciding whether the target is missed.
function withdrawable<T>(value: string | undefined, valid: (value: string) => T): T | null | undefined
{
    if (value === undefined)
    {
        return undefined;
    }
    return value.trim() === "" ? null : valid(value);
}

function validPriority(value: string): number
{
    const priority = Number.parseInt(value, 10);
    if (Number.isNaN(priority) || priority < 1 || priority > 5)
    {
        throw new CliError("--priority takes a number from 1 (highest) to 5");
    }
    return priority;
}

// Progress is derived from covered exit criteria and evidence, so a bare
// percentage has nothing behind it and is refused at the door.
function rejectManualProgress(args: string[]): void
{
    if (args.some((arg) => arg === "--progress" || arg.startsWith("--progress=")))
    {
        throw new CliError("progress is derived from covered exit criteria and evidence — cover a criterion with `self milestone met` instead of asserting a percentage");
    }
}

function strip(payload: Record<string, unknown>): Record<string, unknown>
{
    return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}

function requireText(value: string | undefined, usage: string): string
{
    if (value === undefined || value.trim() === "")
    {
        throw new CliError(`usage: self ${usage}`);
    }
    return value;
}
