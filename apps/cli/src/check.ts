// The read-only direction check (#417 §6). Given the fold of one project and
// the folds of the registered projects this machine could read, it states what
// is structurally inconsistent about that project's direction graph, what a
// person has to re-judge, and which done work could be cited as evidence — and
// it repairs, covers and records nothing.
//
// Three properties are the whole design, and each one is asserted rather than
// promised:
//
//   - **It reads no machine.** No clock, no filesystem, no `process`, no
//     network. `apps/cli/test/objective-check.test.mjs` cell 41 reads this
//     file's source and holds it to the same five rules
//     `apps/fold/test/purity.test.mjs` holds the fold package to. That is why
//     no rule below reads `MilestoneState.state`: `missed` and `at-risk` are
//     what `today` decides, so a finding resting on one would not be the same
//     finding an hour later. Closure is read through `milestoneClosure`, which
//     the fold extracted for exactly this reason.
//   - **It is a function of its arguments.** Identical folds produce identical
//     findings, in identical order, on any machine and whatever order the logs
//     were merged in. The order is total and every comparison is codepoint
//     order — `localeCompare` answers differently under a different locale,
//     which is the one thing the determinism guarantee cannot allow.
//   - **Uncertainty is never an all-clear.** A contribution whose target
//     project this machine does not hold is reported as unchecked, never as
//     closed and never as fine.
//
// It lives in the CLI rather than in `@superself/fold` because finding 6 reads
// which records answer as a runbook run, and that derivation is `runbooks.ts`
// — a CLI-owned reading of the entity grammar that ARCHITECTURE.md keeps out
// of the package.

import { carriedJudgments, exitStanding, milestoneClosure, MilestoneState, ObjectiveState, openObjectives } from "@superself/fold";
import { DecisionState, isOpenWork, ProjectModel, WorkState } from "./model.js";
import { isRunbookRun } from "./runbooks.js";

/* ── what the check answers with ───────────────────────────────────── */

// A record named the way a reader can act on it: bare where this project owns
// it, and qualified by the owning slug where another project does. The pair is
// also the sort key, so a foreign objective sorts in one place on every
// machine rather than wherever a locale happens to put it.
interface QualifiedId
{
    id: string;
    project?: string;
}

// The seven kinds, fixed by design §6 and by nothing else. The order of this
// list is the order two findings on one record are printed in — the design's
// own numbering, which reads as a story, where alphabetical order would read
// as an accident.
export const FINDING_KINDS = [
    "obsolete-contributions",
    "empty-successor",
    "date-order",
    "judgment-review",
    "evidence-candidate",
    "no-disposition",
    "operational-objective"
] as const;

type FindingKind = (typeof FINDING_KINDS)[number];

// What a reader is being asked to do. `structural` — commands repair the
// relationship, though a person chooses which; `review` — a person re-judges
// the meaning and no command decides it for them; `candidate` — information
// only, which is never acted on by this tool at all.
type FindingClass = "structural" | "review" | "candidate";

interface Finding
{
    kind: FindingKind;
    class: FindingClass;
    // The objective this finding sorts under. Absent puts it in the explicit
    // unassigned group, which sorts after every named objective — a group with
    // a name of its own, rather than findings quietly appended to the end.
    objective?: QualifiedId;
    record: QualifiedId;
    // A further stable identifier inside the record — a criterion address, the
    // decision or the predecessor a finding is about. It is the last term of
    // the sort, so two findings of one kind on one record still order.
    detail: string;
    summary: string;
    // The supported commands that answer it, in the order they are run. Every
    // one is dispatchable on this branch and every one changes the condition
    // the finding states: recording a decision is never offered as clearing a
    // structural finding, because it moves no edge, no date and no criterion.
    commands: string[];
}

// A contribution whose target could not be read here, which is a different
// fact from a contribution that is fine and from one that is closed. The
// owning project is not registered on this machine, is archived, or does not
// hold the id.
interface UncheckedTarget
{
    record: string;
    target: QualifiedId;
    why: string;
}

interface CheckSummary
{
    findings: number;
    structural: number;
    review: number;
    candidates: number;
    unchecked: number;
}

interface CheckReport
{
    project: string;
    findings: Finding[];
    unchecked: UncheckedTarget[];
    summary: CheckSummary;
}

/* ── the entry point ───────────────────────────────────────────────── */

// `available` is every other project's fold this machine could read, and the
// absence of one is the whole of what "not checked" means: an archived, an
// unregistered and an unreadable project all arrive here the same way, which
// is by not arriving.
export function checkDirection(project: ProjectModel, available: readonly ProjectModel[]): CheckReport
{
    const world = { project, available };
    const unchecked: UncheckedTarget[] = [];
    const findings = [
        ...contributionFindings(world, unchecked),
        ...checkpointFindings(world),
        ...candidateFindings(world),
        ...operationalFindings(world)
    ].sort(byPlace);
    return {
        project: project.slug,
        findings,
        unchecked: unchecked.sort(byUnchecked),
        summary: summarize(findings, unchecked)
    };
}

interface World
{
    project: ProjectModel;
    available: readonly ProjectModel[];
}

function summarize(findings: Finding[], unchecked: UncheckedTarget[]): CheckSummary
{
    const count = (kind: FindingClass): number => findings.filter((item) => item.class === kind).length;
    return {
        findings: findings.length,
        structural: count("structural"),
        review: count("review"),
        candidates: count("candidate"),
        unchecked: unchecked.length
    };
}

/* ── the total order ───────────────────────────────────────────────── */

// Qualified objective, then qualified record, then kind, then the finding's
// own detail. Codepoint order throughout, and the unassigned group last: two
// machines holding the same events print the same bytes, whatever their
// locale and whatever order the logs were merged in.
function byPlace(left: Finding, right: Finding): number
{
    return compare(groupKey(left.objective), groupKey(right.objective))
        || compare(qualifiedKey(left.record), qualifiedKey(right.record))
        || FINDING_KINDS.indexOf(left.kind) - FINDING_KINDS.indexOf(right.kind)
        || compare(left.detail, right.detail);
}

function byUnchecked(left: UncheckedTarget, right: UncheckedTarget): number
{
    return compare(left.record, right.record) || compare(qualifiedKey(left.target), qualifiedKey(right.target));
}

// The unassigned group's key begins with a character no id or slug can carry,
// and it sorts after them because it is prefixed rather than because the
// comparator has a special case: a group that sorted by exception would be one
// more rule to keep true.
function groupKey(objective: QualifiedId | undefined): string
{
    return objective === undefined ? "~unassigned" : qualifiedKey(objective);
}

// A local id sorts among local ids; a foreign one sorts under its owning slug.
// The separator is a space, which no slug and no id contains.
function qualifiedKey(record: QualifiedId): string
{
    return record.project === undefined ? record.id : `${record.project} ${record.id}`;
}

function compare(left: string, right: string): number
{
    if (left === right)
    {
        return 0;
    }
    return left < right ? -1 : 1;
}

/* ── reading a target's closure out of the supplied folds ──────────── */

// What one contribution edge resolves to. `open` and `closed` are verdicts;
// `unchecked` is the absence of one, and the three are kept apart because
// reporting the third as either of the first two is the mistake §7 is about.
interface ResolvedTarget
{
    state: "open" | "closed";
    // The objective the finding sorts under: the target itself where it is an
    // objective, and the checkpoint's parent where it is a checkpoint.
    objective: QualifiedId;
    // The record the edge actually names, which is what a repair command has
    // to spell.
    label: QualifiedId;
    reason: string;
}

interface UnresolvedTarget
{
    state: "unchecked";
    target: QualifiedId;
    why: string;
}

type Resolution = ResolvedTarget | UnresolvedTarget;

function isClosed(item: Resolution): item is ResolvedTarget
{
    return item.state === "closed";
}

function isUnchecked(item: Resolution): item is UnresolvedTarget
{
    return item.state === "unchecked";
}

function resolveLocal(model: ProjectModel, id: string): Resolution | null
{
    const objective = model.goals.objectives.find((item) => item.id === id);
    if (objective !== undefined)
    {
        return objectiveResolution(objective, undefined);
    }
    const found = findCheckpoint(model, id);
    return found === null ? null : checkpointResolution(found.objective, found.milestone, undefined);
}

function objectiveResolution(objective: ObjectiveState, project: string | undefined): ResolvedTarget
{
    const place = { id: objective.id, ...(project === undefined ? {} : { project }) };
    return {
        state: openObjectives({ objectives: [objective], proposals: [] }).length > 0 ? "open" : "closed",
        objective: place,
        label: place,
        reason: objective.status
    };
}

function checkpointResolution(objective: ObjectiveState, milestone: MilestoneState, project: string | undefined): ResolvedTarget
{
    const closure = milestoneClosure(milestone, objective);
    const qualify = (id: string): QualifiedId => ({ id, ...(project === undefined ? {} : { project }) });
    return {
        state: closure === undefined && openObjectives({ objectives: [objective], proposals: [] }).length > 0 ? "open" : "closed",
        objective: qualify(objective.id),
        label: qualify(milestone.id),
        reason: closure ?? objective.status
    };
}

function findCheckpoint(model: ProjectModel, id: string): { objective: ObjectiveState; milestone: MilestoneState } | null
{
    for (const objective of model.goals.objectives)
    {
        const milestone = objective.milestones.find((item) => item.id === id);
        if (milestone !== undefined)
        {
            return { objective, milestone };
        }
    }
    return null;
}

// A foreign contribution names a slug and an id, and this machine may hold
// neither. Both misses answer `unchecked` with the reason a reader can act on
// — register or restore the project, or look the id up where it lives.
function resolveForeign(world: World, target: QualifiedId): Resolution
{
    const owner = world.available.find((model) => model.slug === target.project);
    if (owner === undefined)
    {
        return { state: "unchecked", target, why: `${target.project} is not a project this machine can read` };
    }
    const objective = owner.goals.objectives.find((item) => item.id === target.id);
    if (objective !== undefined)
    {
        return objectiveResolution(objective, owner.slug);
    }
    const found = findCheckpoint(owner, target.id);
    return found === null
        ? { state: "unchecked", target, why: `${owner.slug} holds no record ${target.id}` }
        : checkpointResolution(found.objective, found.milestone, owner.slug);
}

// Every current contribution a unit states, resolved. Membership is already
// lineage-local in the fold, so an edge a revision superseded is not in here
// at all — what is left is what the unit contributes to now.
function contributionsOfUnit(world: World, work: WorkState): Resolution[]
{
    return [
        ...work.objectives.map((id) => resolveLocal(world.project, id)),
        ...work.milestones.map((id) => resolveLocal(world.project, id)),
        ...work.foreignObjectives.map((link) => resolveForeign(world, { id: link.id, project: link.project }))
    ].filter((item): item is Resolution => item !== null);
}

/* ── findings 1 and 6: what a live unit contributes to ─────────────── */

function contributionFindings(world: World, unchecked: UncheckedTarget[]): Finding[]
{
    return liveWork(world.project).flatMap((work) => unitFinding(world, work, unchecked));
}

function liveWork(model: ProjectModel): WorkState[]
{
    return model.works.filter(isOpenWork);
}

function unitFinding(world: World, work: WorkState, unchecked: UncheckedTarget[]): Finding[]
{
    const resolved = contributionsOfUnit(world, work);
    const undecidable = resolved.filter(isUnchecked);
    for (const item of undecidable)
    {
        unchecked.push({ record: work.id, target: item.target, why: item.why });
    }
    if (resolved.length === 0)
    {
        return dispositionFinding(world, work);
    }
    // A unit with one contribution this machine could not read is a unit
    // nothing may be concluded about: reporting it as adrift would be a
    // verdict on a log that was never opened.
    return undecidable.length > 0 || resolved.some((item) => item.state === "open")
        ? []
        : [obsoleteFinding(world, work, resolved)];
}

function obsoleteFinding(world: World, work: WorkState, resolved: Resolution[]): Finding
{
    const closed = resolved.filter(isClosed).sort(
        (left, right) => compare(qualifiedKey(left.label), qualifiedKey(right.label)));
    const first = closed[0];
    return {
        kind: "obsolete-contributions",
        class: "structural",
        objective: first.objective,
        record: { id: work.id },
        detail: qualifiedKey(first.label),
        summary: `every outcome ${work.id} contributes to is over — `
            + `${closed.map((item) => `${shown(item.label)} (${item.reason})`).join(", ")}`,
        commands: [
            ...relinkCommands(world, work, closed),
            ...closed.map((item) => `self work unlink ${work.id} ${targetFlag(item.label)}`),
            `self work link ${work.id} --standalone --why "<why it contributes to no outcome>"`,
            `self work retire ${work.id} --why "<why the outcome was given up>"`
        ]
    };
}

// The relink is offered only where the lineage ends somewhere open, which is
// the rule part (b)'s guard already states: a chain that ends closed would
// send a reader into a second refusal. A foreign successor is never offered —
// this fold cannot resolve another project's lineage, and part (b) does not
// either.
function relinkCommands(world: World, work: WorkState, closed: ResolvedTarget[]): string[]
{
    return closed.flatMap((item) => item.label.project !== undefined ? []
        : openSuccessor(world.project, item.label.id).map((successor) =>
            `self work link ${work.id} ${targetFlag(successor)}`));
}

// Single steps down the supersession chain, bounded the way every other walk
// in this tree is, so a cycle a hand-appended line left cannot loop it.
function openSuccessor(model: ProjectModel, id: string): QualifiedId[]
{
    let current = id;
    for (let hops = 0; hops < 1000; hops += 1)
    {
        const next = successorOf(model, current);
        if (next === undefined)
        {
            break;
        }
        current = next;
    }
    const resolution = resolveLocal(model, current);
    return current !== id && resolution?.state === "open" ? [resolution.label] : [];
}

function successorOf(model: ProjectModel, id: string): string | undefined
{
    const objective = model.goals.objectives.find((item) => item.id === id);
    return objective !== undefined ? objective.supersededBy : findCheckpoint(model, id)?.milestone.supersededBy;
}

// An objective and a milestone are named by different flags, and a render that
// guessed would print a command the parser refuses.
function targetFlag(record: QualifiedId): string
{
    return `${record.id.startsWith("m-") ? "--milestone" : "--objective"} ${record.id}`;
}

function shown(record: QualifiedId): string
{
    return record.project === undefined ? record.id : `${record.id} (${record.project})`;
}

// Finding 6. Three dispositions satisfy it and the check reads all three off
// explicit edges: a contribution, a standalone declaration, or an inbound
// `relates` edge a runbook run wrote. Nothing is read out of the unit's
// wording or its dates.
function dispositionFinding(world: World, work: WorkState): Finding[]
{
    if (work.standalone !== undefined || operationalUnits(world.project).has(work.id))
    {
        return [];
    }
    return [{
        kind: "no-disposition",
        class: "structural",
        record: { id: work.id },
        detail: work.id,
        summary: `${work.id} states nothing about what it contributes to`,
        commands: [
            `self work link ${work.id} --objective <id>`,
            `self work link ${work.id} --standalone --why "<why it contributes to no outcome>"`,
            `self work retire ${work.id} --why "<why the outcome was given up>"`
        ]
    }];
}

// The operational classification, and the whole of it (#417 §1): the work ids
// a runbook run names with a `relates` edge, which is what
// `self runbook link <run> --work <id>` writes.
function operationalUnits(model: ProjectModel): Set<string>
{
    return new Set(model.entities.filter(isRunbookRun)
        .flatMap((run) => run.links.filter((link) => link.type === "relates").map((link) => link.target)));
}

/* ── findings 2, 3 and 4: what a live checkpoint says ──────────────── */

function checkpointFindings(world: World): Finding[]
{
    return openObjectives(world.project.goals).flatMap((objective) =>
        objective.milestones.filter((milestone) => milestoneClosure(milestone, objective) === undefined)
            .flatMap((milestone) => [
                ...successorFinding(world, objective, milestone),
                ...dateFinding(objective, milestone),
                ...judgmentFindings(objective, milestone),
                ...assumptionFindings(world.project, objective, milestone)
            ]));
}

// Finding 2. A successor with nothing live on it, beside a predecessor that
// still has live work, is a carry somebody did not make — and no prose
// decision changes it, so none is offered.
function successorFinding(world: World, objective: ObjectiveState, milestone: MilestoneState): Finding[]
{
    const predecessors = allCheckpoints(world.project)
        .filter((item) => item.supersededBy === milestone.id).map((item) => item.id).sort(compare);
    const stranded = predecessors.flatMap((id) => linkedLive(world.project, id));
    if (stranded.length === 0 || linkedLive(world.project, milestone.id).length > 0)
    {
        return [];
    }
    return [{
        kind: "empty-successor",
        class: "structural",
        objective: { id: objective.id },
        record: { id: milestone.id },
        detail: predecessors.join(","),
        summary: `${milestone.id} succeeds ${predecessors.join(", ")} and has no live work, `
            + `while ${stranded.join(", ")} still contributes to the predecessor`,
        commands: [
            ...stranded.map((id) => `self work link ${id} --milestone ${milestone.id}`),
            `self work propose "<plan>" --milestone ${milestone.id} …`,
            `self milestone drop ${milestone.id} --why "<why this checkpoint is not pursued>"`
        ]
    }];
}

function allCheckpoints(model: ProjectModel): MilestoneState[]
{
    return model.goals.objectives.flatMap((objective) => objective.milestones);
}

// The live units whose *current* membership names this checkpoint. Lineage is
// already settled in the fold, so a unit that names both a predecessor and its
// successor answers only for the successor — which is exactly what makes an
// uncarried predecessor visible here.
function linkedLive(model: ProjectModel, milestone: string): string[]
{
    return liveWork(model).filter((work) => work.milestones.includes(milestone)).map((work) => work.id).sort(compare);
}

// Finding 3. Two stated dates, compared as the ISO strings they are. Either
// one absent means the ordering was never checkable, which is not a failure
// and is not turned into one.
function dateFinding(objective: ObjectiveState, milestone: MilestoneState): Finding[]
{
    if (milestone.target === undefined || objective.target === undefined || milestone.target <= objective.target)
    {
        return [];
    }
    return [{
        kind: "date-order",
        class: "structural",
        objective: { id: objective.id },
        record: { id: milestone.id },
        detail: milestone.target,
        summary: `${milestone.id} is dated ${milestone.target}, past ${objective.id}'s ${objective.target}`,
        commands: [
            `self milestone revise ${milestone.id} --target <on-or-before-${objective.target}> --why "<what changed>"`,
            `self objective revise ${objective.id} --target <on-or-after-${milestone.target}> --why "<what changed>"`
        ]
    }];
}

// Finding 4, first half. The judgment context part (b) records, read here from
// the log rather than from the derivation, so the check answers the same way
// whether or not an overlay has run.
function judgmentFindings(objective: ObjectiveState, milestone: MilestoneState): Finding[]
{
    return carriedJudgments(milestone, objective, exitStanding(milestone).live).map((context) => ({
        kind: "judgment-review" as const,
        class: "review" as const,
        objective: { id: objective.id },
        record: { id: milestone.id },
        detail: context.criterion,
        summary: context.condition === "moved"
            ? `${milestone.id} ${context.criterion} was judged under ${context.judgedUnder}, `
                + `and the checkpoint hangs under ${objective.id} now`
            : `${milestone.id} ${context.criterion} was judged before the parent was recorded, `
                + `and the checkpoint has been carried since`,
        commands: [`self milestone recheck ${milestone.id} --criterion ${context.criterion} --why "<what you re-judged>"`]
    }));
}

// Finding 4, second half. A checkpoint keeps naming the decision it was told
// to assume until somebody withdraws the edge, which is the point of part
// (a)'s model — so an assumption whose decision was replaced is a review
// signal, and the repair is the two statements part (a) documented.
function assumptionFindings(model: ProjectModel, objective: ObjectiveState, milestone: MilestoneState): Finding[]
{
    return milestone.assumes.flatMap((id) =>
    {
        const decision = model.decisions.find((item) => item.id === id);
        if (decision === undefined || decision.status === "proposed" || decision.status === "confirmed")
        {
            return [];
        }
        return [{
            kind: "judgment-review" as const,
            class: "review" as const,
            objective: { id: objective.id },
            record: { id: milestone.id },
            detail: id,
            summary: `${milestone.id} assumes ${id}, which is ${decision.status}`,
            commands: assumptionCommands(model, milestone.id, decision)
        }];
    });
}

// A successor decision is linked before the old edge is withdrawn, so the
// checkpoint never stands on nothing in between. Where the decision was
// withdrawn with no successor there is none to invent: the unlink alone is
// offered, and choosing what replaces it is the person's.
function assumptionCommands(model: ProjectModel, milestone: string, decision: DecisionState): string[]
{
    const successor = model.decisions.filter((item) => item.supersedes.includes(decision.id))
        .map((item) => item.id).sort(compare)[0];
    return [
        ...(successor === undefined ? [] : [`self milestone link ${milestone} --decision ${successor}`]),
        `self milestone unlink ${milestone} --decision ${decision.id}`
    ];
}

/* ── finding 5: evidence candidates ────────────────────────────────── */

// Information and nothing else. The template carries a literal `cN`: pairing a
// unit to a criterion would be the text matching the design rules out, and
// covering one is a judgment somebody records.
function candidateFindings(world: World): Finding[]
{
    return openObjectives(world.project.goals).flatMap((objective) =>
        objective.milestones.filter((milestone) => milestoneClosure(milestone, objective) === undefined)
            .flatMap((milestone) => milestoneCandidates(world.project, objective, milestone)));
}

function milestoneCandidates(model: ProjectModel, objective: ObjectiveState, milestone: MilestoneState): Finding[]
{
    const open = exitStanding(milestone).open;
    if (open.length === 0)
    {
        return [];
    }
    const cited = new Set(milestone.coverage.flatMap((claim) => claim.work === undefined ? [] : [claim.work]));
    return model.works
        .filter((work) => work.status === "done" && work.milestones.includes(milestone.id)
            && work.reports.length > 0 && !cited.has(work.id))
        .map((work) => ({
            kind: "evidence-candidate" as const,
            class: "candidate" as const,
            objective: { id: objective.id },
            record: { id: milestone.id },
            detail: work.id,
            summary: `${work.id} is done with reported evidence and contributes to ${milestone.id}, `
                + `whose ${open.join(", ")} ${open.length === 1 ? "is" : "are"} uncovered — a candidate, not a verdict`,
            commands: [`self milestone met ${milestone.id} --criterion cN --why "<how it covers it>" --work ${work.id}`]
        }))
        .sort((left, right) => compare(left.detail, right.detail));
}

/* ── finding 7: an objective whose whole live workload is operational ── */

// A narrow question, never a claim: it asks whether recurring maintenance was
// meant as a product checkpoint. An empty set never triggers it — "all of
// nothing is operational" is not an observation — and it prints no repair,
// because no command answers a question about intent.
function operationalFindings(world: World): Finding[]
{
    const runs = operationalUnits(world.project);
    return openObjectives(world.project.goals).flatMap((objective) =>
    {
        const units = checkpointWork(world.project, objective);
        return units.length === 0 || !units.every((id) => runs.has(id)) ? [] : [{
            kind: "operational-objective" as const,
            class: "review" as const,
            objective: { id: objective.id },
            record: { id: objective.id },
            detail: units.join(","),
            summary: `every live unit under ${objective.id}'s checkpoints is an occurrence of a runbook `
                + `(${units.join(", ")}) — was this maintenance meant as a product checkpoint?`,
            commands: [`self objective show ${objective.id}`]
        }];
    });
}

function checkpointWork(model: ProjectModel, objective: ObjectiveState): string[]
{
    const live = objective.milestones.filter((milestone) => milestoneClosure(milestone, objective) === undefined);
    return [...new Set(live.flatMap((milestone) => linkedLive(model, milestone.id)))].sort(compare);
}

/* ── the renders ───────────────────────────────────────────────────── */

// The page a person or a pipe reads. One fact per line, grouped by the
// objective a finding sits under, with the commands under each finding
// indented beneath it — so the answer to "what do I run" is on the line under
// the answer to "what is wrong".
export function checkLines(report: CheckReport): string[]
{
    const lines = [headerLine(report)];
    for (const group of groups(report.findings))
    {
        lines.push("", group.heading, ...group.findings.flatMap(findingLines));
    }
    if (report.unchecked.length > 0)
    {
        lines.push("", "not checked", ...report.unchecked.map((item) =>
            `  ${item.record} → ${shown(item.target)} — target state not checked: ${item.why}`));
    }
    return lines;
}

// The one line `self status` and `self context` carry, and the header of the
// check's own page. A run with findings never reads `ok`, and neither does one
// that found nothing but could not read a target: silence about a log nobody
// opened is the answer §7 forbids.
export function summaryLine(summary: CheckSummary): string
{
    if (summary.findings === 0 && summary.unchecked === 0)
    {
        return "ok";
    }
    const counted = `${summary.findings} finding${summary.findings === 1 ? "" : "s"} `
        + `(${summary.structural} structural, ${summary.review} to review, ${summary.candidates} candidate`
        + `${summary.candidates === 1 ? "" : "s"})`;
    return summary.unchecked === 0
        ? counted
        : `${counted}, ${summary.unchecked} contribution target${summary.unchecked === 1 ? "" : "s"} not checked`;
}

function headerLine(report: CheckReport): string
{
    return report.summary.findings === 0 && report.summary.unchecked === 0
        ? "no findings"
        : `${report.project} — ${summaryLine(report.summary)}`;
}

// The unassigned group is named rather than left as the tail of the list: work
// that states nothing about what it contributes to is its own answer, and a
// reader scanning for it should not have to notice where the objectives ended.
function groups(findings: Finding[]): { heading: string; findings: Finding[] }[]
{
    const out: { heading: string; findings: Finding[] }[] = [];
    for (const finding of findings)
    {
        const heading = finding.objective === undefined ? "unassigned" : shown(finding.objective);
        const last = out[out.length - 1];
        if (last !== undefined && last.heading === heading)
        {
            last.findings.push(finding);
            continue;
        }
        out.push({ heading, findings: [finding] });
    }
    return out;
}

function findingLines(finding: Finding): string[]
{
    return [`  ${finding.class}: ${finding.summary}`, ...finding.commands.map((command) => `    ${command}`)];
}
