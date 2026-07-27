import { parseArgs } from "node:util";
import { validDate } from "./dates.js";
import { renderMilestoneBody, renderObjectiveBody } from "./fold.js";
import { milestoneId, objectiveId, workId } from "./ids.js";
import { buildModel, ProjectModel, WorkState } from "./model.js";
import {
    allMilestones,
    findMilestone,
    MilestoneState,
    ObjectiveState,
    openObjectives,
    WorkProposal
} from "./objectives.js";
import { ProjectContext } from "./paths.js";
import { makeEvent, recordEvent } from "./pipeline.js";
import { dim, errYellow, markdownHeadings, styled } from "./style.js";
import { CliError, EventRefs } from "./types.js";

const HORIZONS = ["day", "week", "month", "quarter", "year"];
const CONFIDENCE = ["low", "medium", "high"];

const OBJECTIVE_USAGE = 'usage: self objective [list] | add "<outcome>" | show <id> | confirm <id> | revise <id> --why w | close <id> --as reached|dropped';
const MILESTONE_USAGE = 'usage: self milestone [list] | add "<outcome>" --objective <id> --exit "<criterion>" | show <id> | revise <id> --why w | met <id> --criterion c1 --why w | reach <id>';

/* ── objectives ────────────────────────────────────────────────────── */

export function cmdObjective(ctx: ProjectContext, rest: string[]): void
{
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const verb = rest[0] ?? "list";
    const args = rest.slice(1);
    if (verb === "list")
    {
        printObjectives(model);
        return;
    }
    if (verb === "add")
    {
        objectiveAdd(ctx, model, args);
        return;
    }
    const objective = requireObjective(model, rest[1]);
    if (verb === "show")
    {
        console.log(markdownHeadings(renderObjectiveBody(objective).trimEnd()));
        return;
    }
    if (verb === "confirm")
    {
        confirmObjective(ctx, objective);
        return;
    }
    if (verb === "revise")
    {
        objectiveRevise(ctx, objective, args.slice(1));
        return;
    }
    if (verb === "close")
    {
        objectiveClose(ctx, objective, args.slice(1));
        return;
    }
    throw new CliError(OBJECTIVE_USAGE);
}

function objectiveAdd(ctx: ProjectContext, model: ProjectModel, args: string[]): void
{
    const { values, positionals } = parseArgs({
        args,
        options: {
            horizon: { type: "string" },
            target: { type: "string" },
            success: { type: "string", multiple: true },
            stop: { type: "string", multiple: true },
            priority: { type: "string" },
            proposed: { type: "boolean" },
            supersedes: { type: "string", multiple: true }
        },
        allowPositionals: true
    });
    const outcome = requireText(positionals[0], 'objective add "<desired outcome>"');
    const id = objectiveId();
    const payload: Record<string, unknown> = { objective: id, outcome, success: values.success ?? [], stop: values.stop ?? [] };
    payload.horizon = values.horizon === undefined ? undefined : validHorizon(values.horizon);
    payload.target = values.target === undefined ? undefined : validDate(values.target);
    payload.priority = values.priority === undefined ? undefined : validPriority(values.priority);
    payload.proposed = values.proposed === true;
    const refs = values.supersedes === undefined ? undefined
        : { supersedes: values.supersedes.map((prefix) => requireObjective(model, prefix).id) };
    recordEvent(ctx, makeEvent(ctx.project, "objective.created", strip(payload), refs, values.proposed !== true), `${id} ${outcome}`);
    console.log(id);
}

function confirmObjective(ctx: ProjectContext, objective: ObjectiveState): void
{
    if (objective.status !== "proposed")
    {
        throw new CliError(`${objective.id} is already ${objective.status}`);
    }
    recordEvent(ctx, makeEvent(ctx.project, "objective.confirmed", { objective: objective.id }, undefined, true), objective.outcome);
}

// A revision is the record that the target moved, so it demands a reason and
// at least one change — an empty revision would only invalidate coverage.
function objectiveRevise(ctx: ProjectContext, objective: ObjectiveState, args: string[]): void
{
    const { values } = parseArgs({
        args,
        options: {
            outcome: { type: "string" },
            horizon: { type: "string" },
            target: { type: "string" },
            priority: { type: "string" },
            success: { type: "string", multiple: true },
            stop: { type: "string", multiple: true },
            why: { type: "string" }
        }
    });
    const why = requireText(values.why, 'objective revise <id> --why "<what changed and why>"');
    const payload: Record<string, unknown> = { objective: objective.id, why, outcome: values.outcome, success: values.success, stop: values.stop };
    payload.horizon = values.horizon === undefined ? undefined : validHorizon(values.horizon);
    payload.target = values.target === undefined ? undefined : validDate(values.target);
    payload.priority = values.priority === undefined ? undefined : validPriority(values.priority);
    if (Object.keys(strip(payload)).length === 2)
    {
        throw new CliError("objective revise needs at least one of --outcome, --horizon, --target, --priority, --success, --stop");
    }
    recordEvent(ctx, makeEvent(ctx.project, "objective.revised", strip(payload), undefined, true), `${objective.id} ${why}`);
}

function objectiveClose(ctx: ProjectContext, objective: ObjectiveState, args: string[]): void
{
    const { values } = parseArgs({ args, options: { as: { type: "string" }, why: { type: "string" } } });
    if (values.as !== "reached" && values.as !== "dropped")
    {
        throw new CliError("objective close requires --as reached|dropped");
    }
    const open = objective.milestones.filter((milestone) => milestone.state !== "reached" && milestone.state !== "closed");
    if (values.as === "reached" && open.length > 0)
    {
        throw new CliError(`${objective.id} still has unreached milestones (${open.map((m) => m.id).join(", ")}) — reach or supersede them first`);
    }
    const payload = strip({ objective: objective.id, as: values.as, why: values.why });
    recordEvent(ctx, makeEvent(ctx.project, "objective.closed", payload, undefined, true), `${objective.id} ${values.as}`);
}

/* ── milestones ────────────────────────────────────────────────────── */

export function cmdMilestone(ctx: ProjectContext, rest: string[]): void
{
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const verb = rest[0] ?? "list";
    const args = rest.slice(2);
    if (verb === "list")
    {
        printMilestones(model);
        return;
    }
    if (verb === "add")
    {
        milestoneAdd(ctx, model, rest.slice(1));
        return;
    }
    const found = requireMilestone(model, rest[1]);
    if (verb === "show")
    {
        console.log(markdownHeadings(renderMilestoneBody(found.milestone, found.objective).trimEnd()));
        return;
    }
    if (verb === "revise")
    {
        milestoneRevise(ctx, found.milestone, args);
        return;
    }
    if (verb === "met")
    {
        milestoneMet(ctx, model, found.milestone, found.objective, args);
        return;
    }
    if (verb === "reach")
    {
        milestoneReach(ctx, found.milestone, found.objective);
        return;
    }
    throw new CliError(MILESTONE_USAGE);
}

function milestoneAdd(ctx: ProjectContext, model: ProjectModel, args: string[]): void
{
    const { values, positionals } = parseArgs({
        args,
        options: {
            objective: { type: "string" },
            target: { type: "string" },
            exit: { type: "string", multiple: true },
            after: { type: "string", multiple: true },
            supersedes: { type: "string" }
        },
        allowPositionals: true
    });
    const outcome = requireText(positionals[0], 'milestone add "<outcome>" --objective <id> --exit "<criterion>"');
    const objective = requireObjective(model, requireText(values.objective, 'milestone add … --objective <id>'));
    if (values.exit === undefined || values.exit.length === 0)
    {
        throw new CliError(`${objective.id} milestones need explicit exit criteria — pass --exit "<criterion>" at least once`);
    }
    const id = milestoneId();
    const payload: Record<string, unknown> = {
        objective: objective.id,
        milestone: id,
        outcome,
        exit: values.exit.map((text, index) => ({ id: `c${index + 1}`, text })),
        after: (values.after ?? []).map((prefix) => requireSibling(objective, prefix)),
        target: values.target === undefined ? undefined : validDate(values.target),
        supersedes: values.supersedes === undefined ? undefined : requireSibling(objective, values.supersedes)
    };
    recordEvent(ctx, makeEvent(ctx.project, "milestone.created", strip(payload), undefined, true), `${id} ${outcome}`);
    console.log(id);
}

function milestoneRevise(ctx: ProjectContext, milestone: MilestoneState, args: string[]): void
{
    const { values } = parseArgs({
        args,
        options: {
            outcome: { type: "string" },
            target: { type: "string" },
            exit: { type: "string", multiple: true },
            "drop-exit": { type: "string", multiple: true },
            why: { type: "string" }
        }
    });
    const why = requireText(values.why, 'milestone revise <id> --why "<what changed and why>"');
    const payload: Record<string, unknown> = {
        milestone: milestone.id,
        why,
        outcome: values.outcome,
        target: values.target === undefined ? undefined : validDate(values.target),
        addExit: nextCriteria(milestone, values.exit ?? []),
        dropExit: (values["drop-exit"] ?? []).map((id) => requireCriterion(milestone, id).id)
    };
    if (Object.keys(strip(payload)).length === 2)
    {
        throw new CliError("milestone revise needs at least one of --outcome, --target, --exit, --drop-exit");
    }
    recordEvent(ctx, makeEvent(ctx.project, "milestone.revised", strip(payload), undefined, true), `${milestone.id} ${why}`);
}

// Criterion ids are never reused: a dropped c2 stays dropped so coverage
// recorded against it keeps pointing at what it actually satisfied.
function nextCriteria(milestone: MilestoneState, texts: string[]): { id: string; text: string }[]
{
    const highest = milestone.exit.reduce((max, criterion) => Math.max(max, Number(criterion.id.slice(1)) || 0), 0);
    return texts.map((text, index) => ({ id: `c${highest + index + 1}`, text }));
}

function milestoneMet(ctx: ProjectContext, model: ProjectModel, milestone: MilestoneState, objective: ObjectiveState, args: string[]): void
{
    const { values } = parseArgs({
        args,
        options: { criterion: { type: "string" }, why: { type: "string" }, work: { type: "string" }, evidence: { type: "string", multiple: true } }
    });
    const criterion = requireCriterion(milestone, requireText(values.criterion, "milestone met <id> --criterion <c1>"));
    const why = requireText(values.why, 'milestone met <id> --criterion c1 --why "<how the evidence covers it>"');
    if (milestone.met.includes(criterion.id))
    {
        throw new CliError(`${milestone.id} ${criterion.id} is already covered — revise the milestone if the criterion changed`);
    }
    const refs: EventRefs = {};
    if (values.work !== undefined)
    {
        refs.work = requireLinkedWork(model, milestone, values.work).id;
    }
    const commits = values.evidence ?? [];
    if (commits.length > 0)
    {
        refs.commits = commits;
    }
    const payload = { milestone: milestone.id, criterion: criterion.id, why, objectiveRevision: objective.revision, milestoneRevision: milestone.revision };
    recordEvent(ctx, makeEvent(ctx.project, "milestone.covered", payload, refs, true), `${milestone.id} ${criterion.id} ${why}`);
}

// Work reaching done is not a milestone being reached: the exit criteria are
// the gate, and they are checked here rather than inferred from a transition.
function milestoneReach(ctx: ProjectContext, milestone: MilestoneState, objective: ObjectiveState): void
{
    if (milestone.reached !== undefined)
    {
        throw new CliError(`${milestone.id} was already reached on ${milestone.reached.ts.slice(0, 10)}`);
    }
    if (milestone.open.length > 0)
    {
        const open = milestone.exit.filter((criterion) => milestone.open.includes(criterion.id));
        throw new CliError(`${milestone.id} has uncovered exit criteria — ` +
            open.map((criterion) => `${criterion.id} ${criterion.text}`).join("; ") +
            `\n  cover each with \`self milestone met ${milestone.id} --criterion <id> --why "<how>"\``);
    }
    const waiting = milestone.after.filter((id) => id !== milestone.id);
    if (waiting.length > 0)
    {
        console.error(`${errYellow("warning:")} ${milestone.id} depends on ${waiting.join(", ")} — check they are reached`);
    }
    const payload = {
        milestone: milestone.id,
        objectiveRevision: objective.revision,
        milestoneRevision: milestone.revision,
        criteria: milestone.met,
        evidence: milestone.evidence
    };
    recordEvent(ctx, makeEvent(ctx.project, "milestone.reached", payload, undefined, true), `${milestone.id} ${milestone.outcome}`);
}

/* ── work links ────────────────────────────────────────────────────── */

export function cmdWorkLink(ctx: ProjectContext, args: string[], link: boolean): void
{
    const { values, positionals } = parseArgs({
        args,
        options: { objective: { type: "string" }, milestone: { type: "string" } },
        allowPositionals: true
    });
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const work = requireWork(model, positionals[0]);
    if (values.objective === undefined && values.milestone === undefined)
    {
        throw new CliError(`self work ${link ? "link" : "unlink"} <work-id> --objective <id> | --milestone <id>`);
    }
    const payload: Record<string, unknown> = { work: work.id };
    if (values.objective !== undefined)
    {
        payload.objective = requireObjective(model, values.objective).id;
    }
    if (values.milestone !== undefined)
    {
        payload.milestone = requireMilestone(model, values.milestone).milestone.id;
    }
    const type = link ? "work.linked" : "work.unlinked";
    recordEvent(ctx, makeEvent(ctx.project, type, payload, undefined, true), `${work.id} ${work.outcome}`);
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

export function cmdPropose(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseArgs({
        args,
        options: {
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
        },
        allowPositionals: true
    });
    const outcome = requireText(positionals[0], 'work propose "<required outcome>" --milestone <id> …');
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const payload = proposalPayload(model, outcome, values as Record<string, string | string[] | undefined>);
    requireNovel(model, outcome, payload);
    recordEvent(ctx, makeEvent(ctx.project, "work.proposed", payload), `${outcome}`);
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
    const target = (payload.milestone ?? payload.objective) as string;
    const clash = model.goals.proposals.find((proposal) =>
        proposal.status === "open" && !proposal.expired && normalize(proposal.outcome) === key
        && (proposal.milestone ?? proposal.objective) === target);
    if (clash !== undefined)
    {
        throw new CliError(`proposal ${clash.id.slice(0, 8)} already proposes this outcome for ${target} — accept or decline it instead`);
    }
    const existing = model.works.find((work) => work.status !== "done" && normalize(work.outcome) === key
        && [...work.objectives, ...work.milestones].includes(target));
    if (existing !== undefined)
    {
        throw new CliError(`${existing.id} already carries this outcome for ${target}`);
    }
}

function normalize(text: string): string
{
    return text.toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").trim();
}

export function cmdProposalDecision(ctx: ProjectContext, args: string[], accept: boolean): void
{
    const { values, positionals } = parseArgs({ args, options: { why: { type: "string" } }, allowPositionals: true });
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const proposal = requireProposal(model, positionals[0]);
    if (!accept)
    {
        const payload = strip({ proposal: proposal.id, why: values.why });
        recordEvent(ctx, makeEvent(ctx.project, "work.declined", payload, undefined, true), `${proposal.outcome}`);
        return;
    }
    const id = workId();
    const created = makeEvent(ctx.project, "work.created", { work: id, outcome: proposal.outcome }, undefined, true);
    recordEvent(ctx, created, `${id} ${proposal.outcome}`);
    const link = strip({ work: id, objective: proposal.objective, milestone: proposal.milestone });
    recordEvent(ctx, makeEvent(ctx.project, "work.linked", link, undefined, true), `${id} ${proposal.outcome}`);
    recordEvent(ctx, makeEvent(ctx.project, "work.accepted", { proposal: proposal.id, work: id }, undefined, true), `${id} ${proposal.outcome}`);
    console.log(id);
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
    const milestones = allMilestones(model.goals);
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

function validHorizon(value: string): string
{
    if (!HORIZONS.includes(value))
    {
        throw new CliError(`"${value}" is not a horizon — use one of ${HORIZONS.join(", ")}`);
    }
    return value;
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
export function rejectManualProgress(args: string[]): void
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
