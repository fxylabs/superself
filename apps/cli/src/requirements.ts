import { parseCommand } from "./args.js";
import {
    completionRefusal,
    liveRequirements,
    nextRequirementId,
    requirementOf
} from "./completion.js";
import { attemptMarker, confirmHuman } from "./human.js";
import { findEventByPrefix } from "./logfile.js";
import { buildModel, ProjectModel, WorkState } from "./model.js";
import { ProjectContext } from "./paths.js";
import { makeEvent, recordEvent } from "./pipeline.js";
import { CliError, EventRefs, SelfEvent } from "./types.js";

// The `self work` verbs that write what done means for a unit: the
// requirements it has to cover, the approval it waits on, and the policy its
// implementation had to satisfy. Every one of them extends the noun that
// already owns the unit — there is no second noun for completion.
//
// The shape mirrors `self milestone`: `met --requirement --why` covers,
// `recheck` re-judges what a revision left stale, and a revision invalidates
// coverage rather than rewriting it.

export function cmdWorkRequire(ctx: ProjectContext, args: string[]): void
{
    const { positionals } = parseCommand("work", args, {}, 2);
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const work = requireOpenWork(model, positionals[0]);
    const text = requireText(positionals[1], 'work require <work-id> "<what the outcome must cover>"');
    const id = nextRequirementId(work.completion);
    recordEvent(ctx, makeEvent(ctx.project, "work.required", { work: work.id, requirement: id, text }),
        `${work.id} ${id} ${text}`);
    console.log(id);
}

// A revision is the record that what the unit has to cover changed, so it
// demands a reason — and it invalidates the coverage that was judged against
// the older wording rather than quietly keeping it.
export function cmdWorkRevise(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseCommand(
        "work",
        args,
        { requirement: { type: "string" }, statement: { type: "string" }, why: { type: "string" } },
        1
    );
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const work = requireOpenWork(model, positionals[0]);
    const requirement = requireRequirement(work, values.requirement);
    const text = requireText(values.statement, 'work revise <work-id> --requirement r1 --statement "<restated>" --why "<what changed>"');
    const why = requireText(values.why, 'work revise <work-id> --requirement r1 --statement "<restated>" --why "<what changed and why>"');
    if (text === requirement.text)
    {
        throw new CliError(`${work.id} ${requirement.id} already reads exactly that — a revision that changes nothing would only invalidate its coverage`);
    }
    const payload = { work: work.id, requirement: requirement.id, text, why };
    recordEvent(ctx, makeEvent(ctx.project, "work.requirement-revised", payload, undefined, true), `${work.id} ${requirement.id} ${why}`);
}

export function cmdWorkRetire(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseCommand("work", args, { requirement: { type: "string" }, why: { type: "string" } }, 1);
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const work = requireOpenWork(model, positionals[0]);
    const requirement = requireRequirement(work, values.requirement);
    const why = requireText(values.why, 'work retire <work-id> --requirement r1 --why "<why it is no longer required>"');
    const payload = { work: work.id, requirement: requirement.id, why };
    recordEvent(ctx, makeEvent(ctx.project, "work.requirement-retired", payload, undefined, true), `${work.id} ${requirement.id} ${why}`);
}

export function cmdWorkMet(ctx: ProjectContext, args: string[], recheck: boolean): void
{
    const { values, positionals } = parseCommand(
        "work",
        args,
        {
            requirement: { type: "string" },
            why: { type: "string" },
            evidence: { type: "string", multiple: true },
            artifact: { type: "string", multiple: true },
            report: { type: "string" }
        },
        1
    );
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const work = requireOpenWork(model, positionals[0]);
    const requirement = requireRequirement(work, values.requirement);
    const why = requireText(values.why, recheck
        ? 'work recheck <work-id> --requirement r1 --why "<what you re-judged>"'
        : 'work met <work-id> --requirement r1 --why "<how the evidence covers it>"');
    coverageStateRefusal(work, requirement.id, recheck);
    const refs = coverageRefs(work, values);
    const payload: Record<string, unknown> = { work: work.id, requirement: requirement.id, why, requirementRevision: requirement.revision };
    if (values.report !== undefined)
    {
        payload.report = requireAttachedReport(ctx, work.id, values.report);
    }
    const type = recheck ? "work.rechecked" : "work.covered";
    recordEvent(ctx, makeEvent(ctx.project, type, payload, refs, true), `${work.id} ${requirement.id} ${why}`);
}

// Covering a requirement twice says nothing the log does not already hold, and
// re-covering one whose wording moved is a fresh judgment that has to say so.
// Both refusals are idempotent: running the same command again changes nothing
// and answers the same way.
function coverageStateRefusal(work: WorkState, requirement: string, recheck: boolean): void
{
    const covered = work.completion.covered.includes(requirement);
    const stale = work.completion.stale.some((item) => item.requirement === requirement);
    if (!recheck && covered)
    {
        throw new CliError(stale
            ? `${work.id} ${requirement} was covered against an earlier revision — re-judge it with \`self work recheck ${work.id} --requirement ${requirement} --why "<what you re-judged>"\``
            : `${work.id} ${requirement} is already covered — revise the requirement if what it asks for changed`);
    }
    if (recheck && !covered)
    {
        throw new CliError(`${work.id} ${requirement} has no coverage to recheck — cover it with ` +
            `\`self work met ${work.id} --requirement ${requirement} --why "<how the evidence covers it>"\``);
    }
    if (recheck && !stale)
    {
        throw new CliError(`${work.id} ${requirement} coverage was already judged against its current revision — nothing to recheck`);
    }
}

// Coverage names evidence the work unit already carries. A coverage event that
// cited bytes nobody attached would be prose with a reference in it, which is
// exactly what this whole check exists to refuse.
function coverageRefs(work: WorkState, values: Record<string, unknown>): EventRefs
{
    const commits = (values.evidence ?? []) as string[];
    const artifacts = (values.artifact ?? []) as string[];
    const report = values.report as string | undefined;
    if (commits.length === 0 && artifacts.length === 0 && report === undefined)
    {
        throw new CliError(`covering a requirement names the evidence for it — pass --evidence <commit>, --artifact <id>, or --report <event-id> already attached to ${work.id}`);
    }
    const refs: EventRefs = { work: work.id };
    for (const commit of commits)
    {
        if (!work.evidence.some((attached) => sameCommit(attached, commit)))
        {
            throw new CliError(`${commit} is not evidence attached to ${work.id} — attach it first with \`self report ${work.id} "<summary>" --evidence ${commit}\``);
        }
    }
    for (const artifact of artifacts)
    {
        if (!work.artifacts.some((item) => item.id === artifact))
        {
            throw new CliError(`${artifact} is not an artifact attached to ${work.id} — attach it first with \`self report ${work.id} "<summary>" --artifact <path>\``);
        }
    }
    if (commits.length > 0)
    {
        refs.commits = commits;
    }
    if (artifacts.length > 0)
    {
        refs.artifacts = artifacts;
    }
    return refs;
}

// Evidence reaches the log in whatever length the command that recorded it
// used: a report attaches the abbreviated HEAD, and `--evidence` records
// exactly what was typed. Two ids name the same commit when one is a prefix of
// the other, which is the only comparison that holds across both.
function sameCommit(attached: string, named: string): boolean
{
    return attached.startsWith(named) || named.startsWith(attached);
}

/* ── approval ──────────────────────────────────────────────────────── */

export function cmdWorkApprovalRequired(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseCommand("work", args, { why: { type: "string" } }, 1);
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const work = requireOpenWork(model, positionals[0]);
    if (work.completion.approvalRequired !== undefined)
    {
        throw new CliError(`${work.id} already requires human approval`);
    }
    const payload: Record<string, unknown> = { work: work.id };
    if (values.why !== undefined)
    {
        payload.why = values.why;
    }
    recordEvent(ctx, makeEvent(ctx.project, "work.approval-required", payload), `${work.id} ${work.outcome}`);
}

// The human gate on a work unit, and the durable state the daemon's wake path
// reads. A run inside an attempt is refused before the prompt is even reached:
// the runner marks every child it starts, so an agent asked to approve its own
// work is answered here rather than at a terminal it does not have.
export function cmdWorkApprove(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseCommand("work", args, { by: { type: "string" } }, 1);
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const work = requireOpenWork(model, positionals[0]);
    if (work.completion.approvalRequired === undefined)
    {
        throw new CliError(`${work.id} does not require approval — declare it with \`self work approval-required ${work.id} --why "<what a person has to answer>"\``);
    }
    if (work.completion.approvals.some((item) => item.humanConfirmed))
    {
        throw new CliError(`${work.id} is already approved`);
    }
    const marker = attemptMarker();
    if (marker !== undefined)
    {
        throw new CliError(`${work.id} cannot be approved from an agent attempt — this process carries the attempt marker ${marker}, and an approval is granted by a person at their own terminal`);
    }
    const confirmation = confirmHuman(`completion approval for ${work.id} — ${work.outcome}`, work.id);
    if ("code" in confirmation)
    {
        throw new CliError(`${confirmation.detail} [${confirmation.code}] — next: ${confirmation.next}`);
    }
    const payload = { work: work.id, by: values.by ?? "maintainer", confirmation };
    recordEvent(ctx, makeEvent(ctx.project, "work.approved", payload, undefined, true), `${work.id} ${work.outcome}`);
}

/* ── completion policy ─────────────────────────────────────────────── */

// What the implementation of this unit had to be, rather than what it had to
// produce. Enforced inside the completion check, so it holds with no chat turn
// active — the overnight case this exists for.
export function cmdWorkPolicy(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseCommand(
        "work",
        args,
        { model: { type: "string" }, "fresh-review": { type: "boolean" }, why: { type: "string" } },
        1
    );
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const work = requireOpenWork(model, positionals[0]);
    if (values.model === undefined && values["fresh-review"] !== true)
    {
        throw new CliError(`a completion policy states what the implementation had to be — pass --model <class>, --fresh-review, or both`);
    }
    const payload: Record<string, unknown> = { work: work.id, freshReview: values["fresh-review"] === true };
    if (values.model !== undefined)
    {
        payload.model = requireText(values.model, "work policy <work-id> --model <class>");
    }
    if (values.why !== undefined)
    {
        payload.why = values.why;
    }
    recordEvent(ctx, makeEvent(ctx.project, "work.policy-declared", payload, undefined, true), `${work.id} ${work.outcome}`);
}

/* ── the done admission ────────────────────────────────────────────── */

// The only place a `work.done` event is built. A passing attempt never reaches
// here — settlement records what a run produced and frees the unit, and this is
// the separate, explicitly justified act of calling the outcome reached.
export function doneEvent(ctx: ProjectContext, work: WorkState, why: string | undefined): SelfEvent
{
    const refusal = completionRefusal(work);
    if (refusal !== null)
    {
        throw new CliError(refusal);
    }
    const payload: Record<string, unknown> = { work: work.id };
    if (why !== undefined)
    {
        payload.why = why;
    }
    return makeEvent(ctx.project, "work.done", payload);
}

/* ── lookups ───────────────────────────────────────────────────────── */

function requireOpenWork(model: ProjectModel, id: string | undefined): WorkState
{
    const wanted = requireText(id, "work … <work-id> — run `self work` to list ids");
    const work = model.works.find((item) => item.id === wanted);
    if (work === undefined)
    {
        throw new CliError(`unknown work id "${wanted}" — run \`self work\` to list ids`);
    }
    if (work.status === "done")
    {
        throw new CliError(`${wanted} is already done`);
    }
    return work;
}

function requireRequirement(work: WorkState, id: string | undefined): { id: string; text: string; revision: number }
{
    const wanted = requireText(id, "work … <work-id> --requirement <r1>");
    const requirement = requirementOf(work.completion, wanted);
    if (requirement === undefined)
    {
        const live = liveRequirements(work.completion).map((item) => item.id).join(", ");
        throw new CliError(`"${wanted}" is not a live requirement of ${work.id} — it has ${live === "" ? "none" : live}`);
    }
    return requirement;
}

// A report is named by its event id, the way a decision or a convention is, and
// it has to be one this unit already carries.
function requireAttachedReport(ctx: ProjectContext, work: string, prefix: string): string
{
    const event = findEventByPrefix(ctx.storeDir, ctx.project, prefix);
    if (event.type !== "report.added" || event.refs?.work !== work)
    {
        throw new CliError(`${event.id} is not a report attached to ${work}`);
    }
    return event.id;
}

function requireText(value: string | undefined, usage: string): string
{
    if (value === undefined || value.trim() === "")
    {
        throw new CliError(`usage: self ${usage}`);
    }
    return value;
}
