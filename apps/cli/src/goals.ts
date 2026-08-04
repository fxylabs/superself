import { parseArgs } from "node:util";
import { presetRow } from "./aliases.js";
import { branch, Command, CommandInput, CommandLeaf, leaf, rawLeaf } from "./contract.js";
import { validDate } from "./dates.js";
import { requireSupersedeKind } from "./entities.js";
import { renderMilestoneBody, renderObjectiveBody } from "./fold.js";
import { milestoneId, objectiveId, workId } from "./ids.js";
import { buildModel, ProjectModel, WorkState } from "./model.js";
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
    readScopes,
    requireProject,
    SCOPE_OPTIONS,
    WORKSPACE_SCOPE_OPTIONS
} from "./paths.js";
import { makeEvent, recordEvent, recordEvents } from "./pipeline.js";
import { recordCoverage } from "./state.js";
import { dim, errYellow, markdownHeadings, styled } from "./style.js";
import { CliError } from "./types.js";

const CONFIDENCE = ["low", "medium", "high"];

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
    supersedes: { type: "string", multiple: true }
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
    supersedes: { type: "string" }
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
        "  --why <text>          the reason for a revision or a decline, and for a close that drops"
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
            leaf("decline", WHY_OPTION, 1, declineObjective),
            leaf("revise", OBJECTIVE_REVISE_OPTIONS, 1, objectiveRevise),
            leaf("close", OBJECTIVE_CLOSE_OPTIONS, 1, objectiveClose)
        ]
    })
};

function objectiveList({ values }: CommandInput<typeof WORKSPACE_SCOPE_OPTIONS>): void
{
    const scopes = readScopes(process.cwd(), values);
    if (values.workspace !== true)
    {
        printObjectives(scopeModel(scopes[0]));
        return;
    }
    scopes.forEach((scope, index) =>
    {
        console.log(`${index === 0 ? "" : "\n"}${styled ? dim(scope.project) : scope.project}`);
        printObjectives(scopeModel(scope));
    });
}

function objectiveShow({ values, positionals }: CommandInput<typeof SCOPE_OPTIONS>): void
{
    const objective = requireObjective(scopeModel(readScopes(process.cwd(), values)[0]), positionals[0]);
    console.log(markdownHeadings(renderObjectiveBody(objective).trimEnd()));
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

function objectiveAdd({ values, positionals }: CommandInput<typeof OBJECTIVE_ADD_OPTIONS>): void
{
    const { ctx, model } = writeTarget();
    const outcome = requireText(positionals[0], 'objective add "<desired outcome>"');
    const id = objectiveId();
    const row = presetRow(ctx.storeDir, "objective");
    const proposed = values.proposed === true;
    // The horizon enum was removed as structure and kept as optional metadata
    // (#197 §7, #207 B7): whatever span the caller states is recorded.
    const payload: Record<string, unknown> = {
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
    recordEvent(ctx, makeEvent(ctx.project, proposed ? "entity.proposed" : "entity.confirmed", strip(payload), undefined, !proposed), `${id} ${outcome}`);
    console.log(id);
}

function confirmObjective({ positionals }: CommandInput): void
{
    const { ctx, model } = writeTarget();
    const objective = requireObjective(model, positionals[0]);
    if (objective.status !== "proposed")
    {
        throw new CliError(`${objective.id} is already ${objective.status}`);
    }
    recordEvent(ctx, makeEvent(ctx.project, "entity.confirmed", { entity: objective.id }, { confirms: objective.id }, true), objective.outcome);
}

// The other answer to a proposal. Confirming says the objective is the
// project's; declining says it is not, and the reason is the whole record.
// One withdrawal event in the shared grammar; the record keeps "declined".
function declineObjective({ values, positionals }: CommandInput<typeof WHY_OPTION>): void
{
    const { ctx, model } = writeTarget();
    const objective = requireObjective(model, positionals[0]);
    const why = requireText(values.why, 'objective decline <id> --why "<why it was turned down>"');
    if (objective.status !== "proposed")
    {
        throw new CliError(`${objective.id} is already ${objective.status} — only a proposed objective can be declined`);
    }
    recordEvent(ctx, makeEvent(ctx.project, "entity.retracted", { entity: objective.id, why }, { declines: objective.id }, true), objective.outcome);
}

// A revision is a supersession (#207 B9): a new objective entity carries the
// links and the revised fields, the predecessor reads superseded, and prior
// coverage under it is stale by construction — the record id changes.
function objectiveRevise({ values, positionals }: CommandInput<typeof OBJECTIVE_REVISE_OPTIONS>): void
{
    const { ctx, model } = writeTarget();
    const objective = requireObjective(model, positionals[0]);
    const why = requireText(values.why, 'objective revise <id> --why "<what changed and why>"');
    if (isTerminalObjective(objective) || objective.status === "superseded")
    {
        throw new CliError(`${objective.id} is already ${objective.status} — a closed objective is not revised; add a new one`);
    }
    const changes = [values.outcome, values.horizon, values.target, values.priority, values.success, values.stop];
    if (changes.every((value) => value === undefined))
    {
        throw new CliError("objective revise needs at least one of --outcome, --horizon, --target, --priority, --success, --stop");
    }
    const id = objectiveId();
    const carried = carriedPlacement(model, objective.id);
    const payload: Record<string, unknown> = {
        entity: id,
        text: restated(values.outcome, "objective") ?? objective.outcome,
        labels: [presetRow(ctx.storeDir, "objective").label],
        links: [{ type: "supersedes", target: objective.id }],
        criteria: [],
        ...carried,
        horizon: revisedField(values.horizon, objective.horizon),
        target: revisedField(withdrawable(values.target, validDate) as string | null | undefined, objective.target),
        rank: revisedField(withdrawable(values.priority, validPriority) as number | null | undefined, objective.priority),
        success: values.success ?? objective.success,
        stop: values.stop ?? objective.stop,
        why
    };
    recordEvent(ctx, makeEvent(ctx.project, "entity.confirmed", strip(payload), undefined, true), `${id} ${why}`);
    console.log(id);
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

function objectiveClose({ values, positionals }: CommandInput<typeof OBJECTIVE_CLOSE_OPTIONS>): void
{
    const { ctx, model } = writeTarget();
    const objective = requireObjective(model, positionals[0]);
    if (values.as !== "reached" && values.as !== "dropped")
    {
        throw new CliError("objective close requires --as reached|dropped");
    }
    // Dropping is a withdrawal, and every withdrawal in the lifecycle carries
    // its reason: an objective given up on with no reason recorded leaves the
    // next reader unable to tell it from one nobody got to. Reaching one needs
    // no reason — the coverage it was reached on is the record.
    if (values.as === "dropped")
    {
        requireText(values.why, 'objective close <id> --as dropped --why "<why it was given up>"');
    }
    // The fold refuses a transition on a terminal objective, so recording one
    // would print "recorded" and change nothing.
    if (isTerminalObjective(objective))
    {
        throw new CliError(`${objective.id} is already ${objective.status}${objective.closedWhy === undefined ? "" : ` — ${objective.closedWhy}`}`);
    }
    const open = objective.milestones.filter((milestone) => milestone.state !== "reached" && milestone.state !== "closed");
    if (values.as === "reached" && open.length > 0)
    {
        throw new CliError(`${objective.id} still has unreached milestones (${open.map((m) => m.id).join(", ")}) — reach or supersede them first`);
    }
    // Reached is the criteria-gated done claim; dropped is the retirement
    // (#207 B10) — the outcome layer speaks the execution grammar too.
    const payload = values.as === "reached"
        ? strip({ entity: objective.id, report: values.why })
        : { entity: objective.id, why: values.why };
    recordEvent(ctx, makeEvent(ctx.project, values.as === "reached" ? "entity.done" : "entity.retired", payload, undefined, true), `${objective.id} ${values.as}`);
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
        "  --why <text>          how the evidence covers it, what was re-judged, or why it was dropped"
    ],
    guard: rejectManualProgress,
    node: branch({
        name: "milestone",
        unnamed: "options",
        refusal: MILESTONE_USAGE,
        children: [
            leaf("", SCOPE_OPTIONS, 0, milestoneList),
            leaf("list", SCOPE_OPTIONS, 0, milestoneList),
            leaf("add", MILESTONE_ADD_OPTIONS, 1, milestoneAdd),
            leaf("show", SCOPE_OPTIONS, 1, milestoneShow),
            leaf("revise", MILESTONE_REVISE_OPTIONS, 1, milestoneRevise),
            leaf("drop", WHY_OPTION, 1, milestoneDrop),
            leaf("met", COVERAGE_OPTIONS, 1, milestoneMet),
            leaf("reach", {}, 1, milestoneReach),
            leaf("recheck", COVERAGE_OPTIONS, 1, milestoneRecheck)
        ]
    })
};

function milestoneList({ values }: CommandInput<typeof SCOPE_OPTIONS>): void
{
    printMilestones(scopeModel(readScopes(process.cwd(), values)[0]));
}

function milestoneShow({ values, positionals }: CommandInput<typeof SCOPE_OPTIONS>): void
{
    const found = requireMilestone(scopeModel(readScopes(process.cwd(), values)[0]), positionals[0]);
    console.log(markdownHeadings(renderMilestoneBody(found.milestone, found.objective).trimEnd()));
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

function milestoneAdd({ values, positionals }: CommandInput<typeof MILESTONE_ADD_OPTIONS>): void
{
    const { ctx, model } = writeTarget();
    const outcome = requireText(positionals[0], 'milestone add "<outcome>" --objective <id> --exit "<criterion>"');
    const objective = requireObjective(model, requireText(values.objective, 'milestone add … --objective <id>'));
    if (values.exit === undefined || values.exit.length === 0)
    {
        throw new CliError(`${objective.id} milestones need explicit exit criteria — pass --exit "<criterion>" at least once`);
    }
    const id = milestoneId();
    const row = presetRow(ctx.storeDir, "milestone");
    const links: Record<string, unknown>[] = [{ type: "member-of", target: objective.id }];
    if (values.supersedes !== undefined)
    {
        requireSupersedeKind(model.entities, values.supersedes, "milestone");
        links.push({ type: "supersedes", target: requireSibling(objective, values.supersedes) });
    }
    const payload: Record<string, unknown> = {
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
    recordEvent(ctx, makeEvent(ctx.project, "entity.confirmed", strip(payload), undefined, true), `${id} ${outcome}`);
    console.log(id);
}

// A revision is a supersession (#207 B12): a new milestone entity carries the
// revised criteria and the grouping, the predecessor reads superseded, and
// its coverage is stale by construction — claims bind to the entity id.
function milestoneRevise({ values, positionals }: CommandInput<typeof MILESTONE_REVISE_OPTIONS>): void
{
    const { ctx, model, milestone, objective } = milestoneTarget(positionals[0]);
    const why = requireText(values.why, 'milestone revise <id> --why "<what changed and why>"');
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
    recordEvent(ctx, makeEvent(ctx.project, "entity.confirmed", strip(payload), undefined, true), `${id} ${why}`);
    console.log(id);
}

// A checkpoint given up on, with nothing taking its place. Revising it would
// say the target moved; dropping it says nobody is going to reach it — the
// retirement of the execution grammar (#207 B12).
function milestoneDrop({ values, positionals }: CommandInput<typeof WHY_OPTION>): void
{
    const { ctx, milestone } = milestoneTarget(positionals[0]);
    const why = requireText(values.why, 'milestone drop <id> --why "<why it is not being reached>"');
    if (milestone.state === "reached")
    {
        throw new CliError(`${milestone.id} was already reached — dropping it would unsay evidence that landed`);
    }
    if (milestone.state === "closed")
    {
        throw new CliError(`${milestone.id} is already closed — ${milestone.reason}`);
    }
    recordEvent(ctx, makeEvent(ctx.project, "entity.retired", { entity: milestone.id, why }, undefined, true), `${milestone.id} ${why}`);
}

// Sugar over the coverage grammar (#207 C5): `met` records the same
// `entity.covered` a `state cover` records, with the criterion named by its
// cN id and the work reference held to a stated contribution.
function milestoneMet({ values, positionals }: CommandInput<typeof COVERAGE_OPTIONS>): void
{
    const { ctx, model, milestone } = milestoneTarget(positionals[0]);
    const criterion = requireCriterion(milestone, requireText(values.criterion, "milestone met <id> --criterion <c1>"));
    const why = requireText(values.why, 'milestone met <id> --criterion c1 --why "<how the evidence covers it>"');
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
    const why = requireText(values.why, 'milestone recheck <id> --criterion c1 --why "<what you re-judged>"');
    if (values.criterion === undefined)
    {
        throw new CliError("milestone recheck re-covers a criterion on the current record — pass --criterion <c>; "
            + "a revision is a supersession now, so its successor starts uncovered");
    }
    const { milestone } = currentMilestone(model, named.milestone);
    const criterion = requireCriterion(milestone, values.criterion);
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
// dispatcher's declaration. Their handlers still parse with node's parseArgs
// directly — the second argument-parse path recorded as debt (#111) — so they
// are declared raw, over the same option objects those parsers read.
const LINK_OPTIONS = { objective: { type: "string" }, milestone: { type: "string" } } as const;

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

export const WORK_GOAL_LEAVES: CommandLeaf[] = [
    rawLeaf("link", LINK_OPTIONS, (args) => cmdWorkLink(requireProject(process.cwd()), args, true)),
    rawLeaf("unlink", LINK_OPTIONS, (args) => cmdWorkLink(requireProject(process.cwd()), args, false)),
    rawLeaf("propose", PROPOSAL_OPTIONS, (args) => cmdPropose(requireProject(process.cwd()), args), ["depends"]),
    rawLeaf("accept", WHY_OPTION, (args) => cmdProposalDecision(requireProject(process.cwd()), args, true)),
    rawLeaf("decline", WHY_OPTION, (args) => cmdProposalDecision(requireProject(process.cwd()), args, false))
];

// Stating what a unit contributes to is a grouping edge in the shared
// grammar (#207 B13): one `entity.linked` per named outcome, `member-of`
// pointing at the objective or the milestone.
function cmdWorkLink(ctx: ProjectContext, args: string[], link: boolean): void
{
    const { values, positionals } = parseArgs({
        args,
        options: LINK_OPTIONS,
        allowPositionals: true
    });
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const work = requireWork(model, positionals[0]);
    if (values.objective === undefined && values.milestone === undefined)
    {
        throw new CliError(`self work ${link ? "link" : "unlink"} <work-id> --objective <id> | --milestone <id>`);
    }
    const targets: string[] = [];
    if (values.objective !== undefined)
    {
        targets.push(requireObjective(model, values.objective).id);
    }
    if (values.milestone !== undefined)
    {
        targets.push(requireMilestone(model, values.milestone).milestone.id);
    }
    const type = link ? "entity.linked" : "entity.unlinked";
    recordEvents(ctx, targets.map((target) =>
        makeEvent(ctx.project, type, { entity: work.id, link: { type: "member-of", target } }, undefined, true)),
        `${work.id} ${work.outcome}`);
}

/* ── goal-gap proposals ────────────────────────────────────────────── */

const PROPOSAL_FIELDS: [string, string][] = [
    ["value", "what reaching this buys the objective"],
    ["risk", "what could go wrong and how it would show"],
    ["capacity", "the effort this is expected to cost"],
    ["evidence-plan", "what evidence will prove it done"],
    ["confidence", "low|medium|high"],
    ["expires", "YYYY-MM-DD after which the proposal is stale"]
];

// A proposal is a proposed work entity (#207 B13): the brief rides the
// creation event, and accepting is confirming — the proposal's id is the
// unit's id.
function cmdPropose(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseArgs({
        args,
        options: PROPOSAL_OPTIONS,
        allowPositionals: true
    });
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
    console.log(id);
}

// A proposal that cannot say what it buys, what stops it, and when it goes
// stale is not a proposal an agent may act on, so the command refuses it
// rather than recording a gap the reader has to fill in later.
function proposalPayload(model: ProjectModel, outcome: string, values: Record<string, string | string[] | undefined>): Record<string, unknown>
{
    for (const [flag, hint] of PROPOSAL_FIELDS)
    {
        if (typeof values[flag] !== "string" || (values[flag] as string).trim() === "")
        {
            throw new CliError(`work propose needs --${flag}: ${hint}`);
        }
    }
    if (!CONFIDENCE.includes(values.confidence as string))
    {
        throw new CliError(`work propose --confidence must be one of ${CONFIDENCE.join(", ")}`);
    }
    if (values.objective === undefined && values.milestone === undefined)
    {
        throw new CliError("work propose needs --objective or --milestone: a proposal states the gap it closes");
    }
    const success = (values.success ?? []) as string[];
    const stop = (values.stop ?? []) as string[];
    if (success.length === 0 || stop.length === 0)
    {
        throw new CliError('work propose needs at least one --success and one --stop criterion');
    }
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
        throw new CliError(`proposal ${clash.id.slice(0, 8)} already proposes this outcome for ${target} — accept or decline it instead`);
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
function cmdProposalDecision(ctx: ProjectContext, args: string[], accept: boolean): void
{
    const { values, positionals } = parseArgs({ args, options: WHY_OPTION, allowPositionals: true });
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const proposal = requireProposal(model, positionals[0]);
    if (!accept)
    {
        const why = requireText(values.why, 'work decline <proposal-id> --why "<why it was turned down>"');
        recordEvent(ctx, makeEvent(ctx.project, "entity.retracted", { entity: proposal.id, why }, { declines: proposal.id }, true), `${proposal.outcome}`);
        return;
    }
    const target = proposal.milestone ?? proposal.objective;
    const events = [makeEvent(ctx.project, "entity.confirmed", { entity: proposal.id }, { confirms: proposal.id }, true)];
    if (target !== undefined)
    {
        events.push(makeEvent(ctx.project, "entity.linked", { entity: proposal.id, link: { type: "member-of", target } }, undefined, true));
    }
    recordEvents(ctx, events, `${proposal.id} ${proposal.outcome}`);
    console.log(proposal.id);
}

/* ── console output ────────────────────────────────────────────────── */

function printObjectives(model: ProjectModel): void
{
    const objectives = openObjectives(model.goals);
    if (objectives.length === 0)
    {
        console.log('no objectives — the long-term goal is separate; add one with `self objective add "<outcome>"`');
        return;
    }
    for (const objective of objectives)
    {
        const target = objective.target === undefined ? "" : ` · ${objective.horizon ?? "target"} ${objective.target}`;
        console.log(`${objective.id}  ${stateMark(objective.state)}  ${objective.outcome}${styled ? dim(target) : target}`);
        for (const milestone of objective.milestones)
        {
            console.log(`  ${milestone.id}  ${stateMark(milestone.state)}  ${milestone.outcome} — ${milestone.reason}`);
        }
    }
}

function printMilestones(model: ProjectModel): void
{
    // Closed checkpoints are left out for the same reason every other current
    // render leaves them out: dropped, superseded, or belonging to a closed
    // objective, none of them is a checkpoint anybody is working toward.
    // `self milestone show` and `self search --type milestone` still answer.
    const milestones = allMilestones(model.goals).filter((milestone) => milestone.state !== "closed");
    if (milestones.length === 0)
    {
        console.log("no milestones — add one with `self milestone add \"<outcome>\" --objective <id> --exit \"<criterion>\"`");
        return;
    }
    for (const milestone of milestones)
    {
        const flags = [
            milestone.criticalPath ? "critical path" : "",
            milestone.works.length === 0 ? "no work linked" : `${milestone.works.length} work unit(s)`
        ].filter((flag) => flag !== "").join(" · ");
        console.log(`${milestone.id}  ${stateMark(milestone.state)}  ${milestone.outcome} — ${milestone.reason} [${flags}]`);
    }
}

function stateMark(state: string): string
{
    return styled ? state.padEnd(9) : state;
}

/* ── lookups and validation ────────────────────────────────────────── */

export function requireObjective(model: ProjectModel, id: string | undefined): ObjectiveState
{
    const wanted = requireText(id, "… <objective-id> — run `self objective` to list ids");
    const objective = model.goals.objectives.find((item) => item.id === wanted);
    if (objective === undefined)
    {
        throw new CliError(`unknown objective "${wanted}" — run \`self objective\` to list ids`);
    }
    return objective;
}

export function requireMilestone(model: ProjectModel, id: string | undefined): { objective: ObjectiveState; milestone: MilestoneState }
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

function requireProposal(model: ProjectModel, prefix: string | undefined): WorkProposal
{
    const wanted = requireText(prefix, "… <proposal-id> — run `self context` to list open proposals");
    const matches = model.goals.proposals.filter((proposal) => proposal.id.startsWith(wanted));
    if (matches.length !== 1)
    {
        throw new CliError(matches.length === 0
            ? `no work proposal matches "${wanted}"`
            : `proposal id "${wanted}" is ambiguous (${matches.length} matches)`);
    }
    if (matches[0].status !== "open")
    {
        throw new CliError(`proposal ${matches[0].id.slice(0, 8)} is already ${matches[0].status}`);
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
