import { presetRow } from "./aliases.js";
import { required, Requirement } from "./args.js";
import { branch, Command, CommandInput, CommandLeaf, leaf } from "./contract.js";
import { validDate } from "./dates.js";
import { Exposure, requireSupersedeKind } from "./entities.js";
import { renderMilestoneBody, renderObjectiveBody } from "./fold.js";
import { milestoneId, objectiveId, workId } from "./ids.js";
import { buildModel, ProjectModel, workspaceModels, WorkState } from "./model.js";
import {
    allMilestones,
    findMilestone,
    isTerminalObjective,
    MilestoneState,
    ObjectiveState,
    openObjectives,
    WorkProposal
} from "./objectives.js";
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
import { recordRetirement, retirementIntent, supersedeTargets } from "./retirement.js";
import { admittingDemotions, confirmEntityUnit, demotionEvents, Placed, recordCoverage, recordOwner, tierOf } from "./state.js";
import { countCharacters, dim, errYellow, markdownHeadings, styled } from "./style.js";
import { CliError, CommandOutput, ListingBlock } from "./types.js";

const CONFIDENCE = ["low", "medium", "high"];

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
const MILESTONE_USAGE = 'usage: self milestone [list] | add "<outcome>" --objective <id> --exit "<criterion>" | show <id> | revise <id> --why w | drop <id> --why w | met <id> --criterion c1 --why w | reach <id> | recheck <id> --criterion c1 --why w';

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
    demote: { type: "string", multiple: true }
} as const;

const MILESTONE_REVISE_OPTIONS = {
    outcome: { type: "string" },
    target: { type: "string" },
    exit: { type: "string", multiple: true },
    "drop-exit": { type: "string", multiple: true },
    why: { type: "string" }
} as const;

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
            syntax: 'objective add "<outcome>" [--horizon week|month|quarter|year] [--target d]',
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
        "scope flag at all and record into the project they run in.",
        "",
        "an objective answers with linked work from every registered project: a unit",
        "another project linked to it lists with that project's slug beside it.",
        "",
        "  --project <slug>      read this registered project instead of this directory's",
        "  --workspace           list every registered project's objectives (list only)",
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
            leaf("add", OBJECTIVE_ADD_OPTIONS, 1, objectiveAdd),
            leaf("show", SCOPE_OPTIONS, 1, objectiveShow),
            leaf("confirm", {}, 1, confirmObjective),
            leaf("decline", WHY_OPTION, 1, declineObjective, { requires: [WHY_TURNED_DOWN] }),
            leaf("revise", OBJECTIVE_REVISE_OPTIONS, 1, objectiveRevise, { requires: [WHY_CHANGED] }),
            leaf("close", OBJECTIVE_CLOSE_OPTIONS, 1, objectiveClose, {
                requires: [{ flags: ["as"], value: "reached|dropped", hint: "whether the outcome was reached or given up" }]
            })
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
        return [objectiveListing(models[0], contributorsTo(scopes[0].project, models))];
    }
    // One block per project, each stating its own size: the workspace form is
    // that many listings printed together, not one listing of everything, and a
    // reader asking how many one project has is answered under its own heading.
    return scopes.map((scope, index) =>
    {
        const model = models.find((item) => item.slug === scope.project) as ProjectModel;
        const listing = objectiveListing(model, contributorsTo(scope.project, models));
        const heading = `${index === 0 ? "" : "\n"}${styled ? dim(scope.project) : scope.project}`;
        return { ...listing, rows: [heading, ...listing.rows] };
    });
}

function objectiveShow({ values, positionals }: CommandInput<typeof SCOPE_OPTIONS>): CommandOutput
{
    const scope = readScopes(process.cwd(), values)[0];
    const models = workspaceModels(scope.storeDir, scope.project);
    const objective = requireObjective(models[0], positionals[0]);
    const linked = [
        ...openLocalWork(models[0], objective),
        ...contributorsTo(scope.project, models).get(objective.id) ?? []
    ];
    return [{
        kind: "document",
        plain: () => markdownHeadings(renderObjectiveBody(objective, linked).trimEnd()).split("\n")
    }];
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
// credit included. An objective or milestone is born at project scope.
function presetGate(ctx: ProjectContext, models: ProjectModel[], usage: string, exposure: Exposure,
    values: { demote?: string[]; proposed?: boolean }, outcome: string, payload: Record<string, unknown>): Placed[]
{
    return admittingDemotions(ctx, models, values, tierOf(ctx.project, exposure),
        usage, countCharacters(outcome), supersedeTargets(payload));
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
        scope: "project",
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
    recordRetirement(ctx, retirementIntent(model, "supersede", proposed ? [] : supersedeTargets(payload)), model,
        (confirmation) => [makeEvent(ctx.project, proposed ? "entity.proposed" : "entity.confirmed",
            strip(confirmation === undefined ? payload : { ...payload, confirmation }), undefined, !proposed),
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
    recordRetirement(ctx, retirementIntent(model, "supersede", [objective.id]), model,
        (confirmation) => [makeEvent(ctx.project, "entity.confirmed",
            strip(confirmation === undefined ? payload : { ...payload, confirmation }), undefined, true)],
        `${id} ${why}`);
    return [{ kind: "receipt", text: id }];
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
    recordRetirement(ctx, retirementIntent(model, "retire", values.as === "reached" ? [] : [objective.id]), model,
        (confirmation) => [makeEvent(ctx.project, values.as === "reached" ? "entity.done" : "entity.retired",
            confirmation === undefined ? payload : { ...payload, confirmation }, undefined, true)],
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
        { syntax: 'milestone add "<outcome>" --objective <id> --exit "<criterion>" [--target d] [--after m] [--supersedes m]', verbs: ["add"] },
        {
            syntax: "milestone show <id> [--project <slug>]",
            description: ["print a milestone, its exit criteria, and its coverage"],
            verbs: ["show"]
        },
        {
            syntax: "milestone revise <id> --why w [--outcome t] [--target d] [--exit e] [--drop-exit c1]",
            description: ["a revision supersedes: a new milestone id carries the revised criteria"],
            verbs: ["revise"]
        },
        {
            syntax: 'milestone drop <id> --why "<reason>"',
            description: ["give up on a checkpoint with nothing replacing it"],
            verbs: ["drop"]
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
        "list and show read and take --project; every other verb writes into the",
        "project it runs in. There is no --workspace form: a milestone hangs under",
        "an objective, so `self objective --workspace` is the workspace-wide roll-up.",
        "",
        "  --project <slug>      read this registered project instead of this directory's",
        "  --objective <id>      the objective the milestone belongs to",
        "  --exit <criterion>    an exit criterion, repeatable",
        "  --target <date>       the date the checkpoint is judged on",
        "  --after <id>          order it after another milestone",
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
            leaf("add", MILESTONE_ADD_OPTIONS, 1, milestoneAdd, {
                requires: [
                    { flags: ["objective"], value: "<id>", hint: "the objective this checkpoint sits under" },
                    { flags: ["exit"], value: "<criterion>", hint: "what has to be true to call it reached, repeatable" }
                ]
            }),
            leaf("show", SCOPE_OPTIONS, 1, milestoneShow),
            leaf("revise", MILESTONE_REVISE_OPTIONS, 1, milestoneRevise, { requires: [WHY_CHANGED] }),
            leaf("drop", WHY_OPTION, 1, milestoneDrop, {
                requires: [{ flags: ["why"], hint: "why it is not being reached" }]
            }),
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

function milestoneShow({ values, positionals }: CommandInput<typeof SCOPE_OPTIONS>): CommandOutput
{
    const found = requireMilestone(scopeModel(readScopes(process.cwd(), values)[0]), positionals[0]);
    return [{
        kind: "document",
        plain: () => markdownHeadings(renderMilestoneBody(found.milestone, found.objective).trimEnd()).split("\n")
    }];
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
    const objective = requireObjective(model, required(values.objective));
    const id = milestoneId();
    const row = presetRow(ctx.storeDir, "milestone");
    const links: Record<string, unknown>[] = [{ type: "member-of", target: objective.id }];
    if (values.supersedes !== undefined)
    {
        requireSupersedeKind(model.entities, values.supersedes, "milestone");
        links.push({ type: "supersedes", target: requireSibling(objective, values.supersedes) });
    }
    const payload = milestoneAddPayload(id, outcome, row, links, objective, values);
    const demotions = presetGate(ctx, models, 'milestone add "<outcome>"', row.exposure, values, outcome, payload);
    recordRetirement(ctx, retirementIntent(model, "supersede", supersedeTargets(payload)), model,
        (confirmation) => [makeEvent(ctx.project, "entity.confirmed",
            strip(confirmation === undefined ? payload : { ...payload, confirmation }), undefined, true),
        ...demotionEvents(demotions, id, false)],
        `${id} ${outcome}`);
    return [{ kind: "receipt", text: id }];
}

function refuseMilestoneRevise(milestone: MilestoneState, values: CommandInput<typeof MILESTONE_REVISE_OPTIONS>["values"]): void
{
    if (milestone.supersededBy !== undefined || milestone.droppedWhy !== undefined)
    {
        throw new CliError(`${milestone.id} is already closed — a withdrawn or replaced checkpoint is not revised`);
    }
    if (values.outcome === undefined && values.target === undefined
        && (values.exit === undefined || values.exit.length === 0)
        && (values["drop-exit"] === undefined || values["drop-exit"].length === 0))
    {
        throw new CliError("milestone revise needs at least one of --outcome, --target, --exit, --drop-exit");
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
    const dropped = new Set((values["drop-exit"] ?? []).map((id) => requireCriterion(milestone, id).id));
    const criteria = [
        ...milestone.exit.filter((item) => item.dropped !== true && !dropped.has(item.id)).map((item) => item.text),
        ...values.exit ?? []
    ];
    const id = milestoneId();
    const payload: Record<string, unknown> = {
        entity: id,
        text: restated(values.outcome, "milestone") ?? milestone.outcome,
        labels: [presetRow(ctx.storeDir, "milestone").label],
        links: [{ type: "member-of", target: objective.id }, { type: "supersedes", target: milestone.id }],
        criteria,
        ...carriedPlacement(model, milestone.id),
        after: milestone.after,
        target: revisedField(withdrawable(values.target, validDate) as string | null | undefined, milestone.target),
        why
    };
    recordRetirement(ctx, retirementIntent(model, "supersede", [milestone.id]), model,
        (confirmation) => [makeEvent(ctx.project, "entity.confirmed",
            strip(confirmation === undefined ? payload : { ...payload, confirmation }), undefined, true)],
        `${id} ${why}`);
    return [{ kind: "receipt", text: id }];
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
    recordRetirement(ctx, retirementIntent(model, "retire", [milestone.id]), model,
        (confirmation) => [makeEvent(ctx.project, "entity.retired",
            { entity: milestone.id, why, ...(confirmation === undefined ? {} : { confirmation }) }, undefined, true)],
        `${milestone.id} ${why}`);
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
    milestone: { type: "string" }
} as const;

const LINK_TARGET: Requirement = { flags: ["objective", "milestone"], value: "<id>", hint: "what the unit contributes to" };

const PROPOSAL_OPTIONS = {
    objective: { type: "string" },
    milestone: { type: "string" },
    value: { type: "string" },
    success: { type: "string", multiple: true },
    stop: { type: "string", multiple: true },
    depends: { type: "string", multiple: true },
    risk: { type: "string" },
    capacity: { type: "string" },
    "evidence-plan": { type: "string" },
    confidence: { type: "string" },
    expires: { type: "string" }
} as const;

// One statement of what a proposal has to say for itself, read by the gate
// that refuses a call missing any of it and by the help page that lists them.
// The gap a proposal closes is the requirement a project can be unable to
// satisfy yet, so it carries the verb that creates one.
const PROPOSAL_REQUIRED: Requirement[] = [
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
        unblock: 'no objective yet? `self objective add "<outcome>" --proposed`, then `self objective confirm <id>`'
    }
];

export const WORK_GOAL_LEAVES: CommandLeaf[] = [
    leaf("link", LINK_OPTIONS, 1, (input) => cmdWorkLink(input, true), { requires: [LINK_TARGET] }),
    leaf("unlink", LINK_OPTIONS, 1, (input) => cmdWorkLink(input, false), { requires: [LINK_TARGET] }),
    leaf("propose", PROPOSAL_OPTIONS, 1, cmdPropose, { undocumented: ["depends"], requires: PROPOSAL_REQUIRED }),
    leaf("accept", WHY_OPTION, 1, (input) => cmdProposalDecision(input, true)),
    leaf("decline", WHY_OPTION, 1, (input) => cmdProposalDecision(input, false), { requires: [WHY_TURNED_DOWN] })
];

// Stating what a unit contributes to is a grouping edge in the shared
// grammar (#207 B13): one `entity.linked` per named outcome, `member-of`
// pointing at the objective or the milestone.
function cmdWorkLink({ values, positionals }: CommandInput<typeof LINK_OPTIONS>, link: boolean): void
{
    const ctx = requireProject(process.cwd());
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const work = requireWork(model, positionals[0]);
    const links = linkEdges(ctx, model, values, link ? "work link" : "work unlink");
    const type = link ? "entity.linked" : "entity.unlinked";
    recordEvents(ctx, links.map((edge) =>
        makeEvent(ctx.project, type, { entity: work.id, link: edge }, undefined, true)),
        `${work.id} ${work.outcome}`);
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

/* ── goal-gap proposals ────────────────────────────────────────────── */

// A proposal is a proposed work entity (#207 B13): the brief rides the
// creation event, and accepting is confirming — the proposal's id is the
// unit's id.
function cmdPropose({ values, positionals }: CommandInput<typeof PROPOSAL_OPTIONS>): CommandOutput
{
    const ctx = requireProject(process.cwd());
    const outcome = requireText(positionals[0], 'work propose "<required outcome>" --milestone <id> …');
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const brief = proposalPayload(model, outcome, values as Record<string, string | string[] | undefined>);
    requireNovel(model, outcome, brief);
    const row = presetRow(ctx.storeDir, "work");
    const id = workId();
    const { outcome: text, ...rest } = brief;
    void text;
    const payload: Record<string, unknown> = {
        entity: id,
        text: outcome,
        labels: [row.label],
        links: [],
        criteria: [],
        exposure: row.exposure,
        scope: "project",
        priority: row.priority,
        ...rest
    };
    recordEvent(ctx, makeEvent(ctx.project, "entity.proposed", strip(payload)), `${outcome}`);
    return [{ kind: "receipt", text: id }];
}

// The gate refused a proposal missing any of its required options before this
// ran, so what is left is whether the values it was given are ones the record
// can keep.
function proposalPayload(model: ProjectModel, outcome: string, values: Record<string, string | string[] | undefined>): Record<string, unknown>
{
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
    const target = (payload.milestone ?? payload.objective) as string;
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

// Two outcomes are the same when they carry the same letters and numbers in
// the same order, whatever spacing, case or punctuation they were typed with.
// The classes are Unicode ones on purpose: a script-by-script allow list drops
// every language nobody thought to add, and text that loses all its characters
// stops comparing as itself and starts comparing as everything else. NFC is
// applied first so the same word typed decomposed keys the same way.
function normalize(text: string): string
{
    return text.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// Accept is confirm and decline is the withdrawal (#207 B13): the proposal
// entity becomes the unit under its own id, and the grouping edge toward the
// outcome it closes lands in the same append.
//
// Both resolve their project from the proposal rather than from the directory
// (#302): `self work accept <id>` is the call to action a `--project` context
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
        recordEvent(ctx, makeEvent(ctx.project, "entity.retracted", { entity: proposal.id, why }, { declines: proposal.id }, true), `${proposal.outcome}`);
        return [];
    }
    const target = proposal.milestone ?? proposal.objective;
    const events = [makeEvent(ctx.project, "entity.confirmed", { entity: proposal.id }, { confirms: proposal.id }, true)];
    if (target !== undefined)
    {
        events.push(makeEvent(ctx.project, "entity.linked", { entity: proposal.id, link: { type: "member-of", target } }, undefined, true));
    }
    recordEvents(ctx, events, `${proposal.id} ${proposal.outcome}`);
    return [{ kind: "receipt", text: proposal.id }];
}

/* ── console output ────────────────────────────────────────────────── */

// The size is the objectives, not the lines: a checkpoint renders indented
// under the objective it belongs to, and counting those rows would tell a
// reader they have more outcomes than they have.
function objectiveListing(model: ProjectModel, contributors: Map<string, string[]>): ListingBlock
{
    const objectives = openObjectives(model.goals);
    return {
        kind: "listing",
        rows: objectives.length === 0
            ? ['no objectives — the long-term goal is separate; add one with `self objective add "<outcome>"`']
            : objectives.flatMap((objective) => [
                objectiveRow(model, objective, contributors),
                ...objective.milestones.map((milestone) =>
                    `  ${milestone.id}  ${stateMark(milestone.state)}  ${milestone.outcome} — ${milestone.reason}`)
            ]),
        total: objectives.length,
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
        throw new CliError(`unknown objective "${wanted}" — run \`self objective\` to list ids`);
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
        throw new CliError(`unknown objective "${wanted}" — no registered project has it; run \`self objective --workspace\` to list ids`);
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
        throw new CliError(`unknown milestone "${wanted}" — run \`self milestone\` to list ids`);
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
        throw new CliError(`unknown work id "${wanted}" — run \`self work\` to list ids`);
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

// Whether `requireProposal` would find anything here, asked of a whole project
// so `recordOwner` can pick the one whose lookup is about to succeed. Status is
// deliberately not part of it: a proposal already accepted or declined is held
// by its project, and "it is already declined" is the answer a reader needs —
// not "no registered project holds it".
function holdsProposal(model: ProjectModel, wanted: string): boolean
{
    return model.goals.proposals.some((proposal) => proposal.id.startsWith(wanted));
}

function requireProposal(model: ProjectModel, prefix: string | undefined): WorkProposal
{
    const wanted = requireText(prefix, PROPOSAL_USAGE);
    const matches = model.goals.proposals.filter((proposal) => proposal.id.startsWith(wanted));
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
