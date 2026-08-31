// The fold's machine-local overlay: everything the log alone cannot decide.
//
// Four inputs, and they are the whole of it — the clock a page is read at, the
// session holding the workspace, the verdicts one machine reached about the
// evidence by asking its own git, and the workspace time zone. Not one of them
// travels with the log, and a server folding the same events has none of them,
// so every one arrives as an argument and nothing here reads a file, an
// environment variable or a clock of its own. `model.ts` is the layer below,
// and it never calls into this one.

import { completionRefusal } from "./completion.js";
import { DEFAULT_ZONE } from "./dates.js";
import { CriterionState, personOwned } from "./entities.js";
import {
    AttentionRow,
    BranchUnshipped,
    DecisionState,
    isOpenWork,
    ProjectModel,
    WaitingItem,
    WorkState
} from "./model.js";
import { deriveGoals } from "./objectives.js";
import { plural } from "./text.js";
import { SelfEvent, Verdict } from "./types.js";

// A proposal nobody answered stops being a live question. A unit nobody has
// touched for this long is one the reader should be told about.
const PROPOSAL_EXPIRY_DAYS = 14;
const STALL_DAYS = 3;

// What one machine knows that the log does not. `verdicts` is required and
// `session` is optional-by-declaration for the same reason: a caller that has
// judged no evidence says so with an empty record rather than by leaving the
// field out, because a missing verdict reads as "not settled" and would put a
// shipped branch back on the unshipped list, while a caller that nobody has
// claimed the workspace from has genuinely nothing to say.
export interface LocalOverlay
{
    // The instant the state is being read at. Ages, expiries and stalls are all
    // measured from it, so two reads of one log at different hours differ here
    // and nowhere else.
    now: Date;
    // The session this read is happening in, so the fold can tell a record this
    // session wrote from one it inherited. Absent when nobody has claimed the
    // workspace.
    session?: string;
    // What the machine holding the project repository decided about each
    // recorded commit.
    verdicts: Record<string, Verdict>;
    // The workspace's time zone. A machine-local setting rather than a logged
    // fact, and the default stands when it is not given.
    zone?: string;
}

// The overlay, applied to a model the log-determined layer produced. The model
// is filled in rather than copied: it is this caller's fold, made a moment ago
// by `foldEvents`, and handing back a second one would leave two answers to
// the same question in the same call.
export function applyLocalOverlay(model: ProjectModel, events: SelfEvent[], local: LocalOverlay): ProjectModel
{
    model.zone = local.zone ?? DEFAULT_ZONE;
    deriveSignals(model, local, events);
    // Read once per fold, not once per row: both derivations below read the
    // same verdicts.
    deriveAttention(model, local.verdicts);
    model.unshipped = unshippedBranches(model.works, local.verdicts);
    return model;
}

function noteProposedObjectives(model: ProjectModel): void
{
    for (const objective of model.goals.objectives.filter((item) => item.status === "proposed"))
    {
        noteWaiting(model, {
            full: `objective ${objective.id} is proposed and not confirmed: ${objective.outcome}`,
            identity: `proposed objective ${objective.id}`,
            recovery: "self objective"
        });
    }
}

function expireProposedDecisions(model: ProjectModel, now: Date): void
{
    for (const decision of model.decisions)
    {
        if (decision.status === "proposed" && ageDays(decision.ts, now) > PROPOSAL_EXPIRY_DAYS)
        {
            decision.expired = true;
        }
    }
}

function deriveWorkSignals(model: ProjectModel, work: WorkState, now: Date): void
{
    // Derived for open units only. A closed unit was already judged by the
    // gate when it was closed, and asking again on a page that says it is done
    // would answer a question nobody can act on.
    if (isOpenWork(work))
    {
        work.owes = completionRefusal(work) ?? undefined;
    }
    if (work.status === "blocked" && work.blockedOn === "decision")
    {
        noteWaiting(model, {
            full: `${work.id} is waiting on a decision: ${work.blockedWhy ?? work.outcome}`,
            identity: `blocked work ${work.id}`,
            recovery: { verb: "work-show", id: work.id }
        });
    }
    if (work.status === "active" && ageDays(work.lastEventTs, now) > STALL_DAYS)
    {
        const days = Math.floor(ageDays(work.lastEventTs, now));
        model.health.push(`${work.id} looks stalled — no events for ${days} days`);
    }
    notePersonOwned(model, work);
}

// A criterion whose task is a person's own waits on the reader, whatever the
// unit around it is doing (#413). One row each, in cN order: two of them are
// two things to do, and a merged row would carry two `--criterion` values in
// one command.
//
// Not on a plan awaiting review: nothing is actionable before the confirm, the
// review already has a row of its own, and asking a person to cover a criterion
// of a plan they have not accepted asks for the wrong act. Not on a closed
// unit, by `isOpenWork` — the same filter every other work signal uses.
//
// The unit's own status is untouched: it is not blocked, and it is not counted
// among blocked units. #408's ruling for the block axis holds for this one.
function notePersonOwned(model: ProjectModel, work: WorkState): void
{
    if (!isOpenWork(work) || work.status === "review")
    {
        return;
    }
    for (const criterion of work.criteria.filter(personOwned))
    {
        noteWaiting(model, personCriterionWait(work, criterion));
    }
}

// The row, and the command that ends it. A blocked one still lists, naming its
// block: the block says why it has not moved and the ownership says whose it
// is, and the person holding it is the one most likely to release it.
function personCriterionWait(work: WorkState, criterion: CriterionState): WaitingItem
{
    const blocked = criterion.blocked;
    const lead = `${work.id} ${criterion.id} ${criterion.text} — yours`
        + (blocked === undefined
            ? ""
            : ` · blocked on ${blocked.on}${blocked.why === undefined ? "" : ` — ${blocked.why}`}`);
    const action = `self work cover ${work.id} --criterion ${criterion.id} --why "<how>"`;
    return {
        full: `${lead} (cover with \`${action}\`)`,
        lead,
        identity: `criterion ${work.id} ${criterion.id}`,
        recovery: { verb: "work-show", id: work.id },
        action
    };
}

// The pair of the ruling that friction stays optional (#380 R3). Nothing is
// refused at capture, so the only place a project can learn it has stopped
// saying what differed is here — one line, and only once the silent reports
// outnumber the ones that spoke.
//
// Deliberately worded "this project's": it counts one project's reports, while
// the sweep that reads the same field counts a whole workspace's. Both say
// "last 30 days", and a reader who took one number for the other would draw
// the wrong conclusion from either.
const FRICTION_WINDOW_DAYS = 30;

function frictionSignals(model: ProjectModel, now: Date): string[]
{
    const recent = model.works.flatMap((work) => work.reports)
        .filter((report) => ageDays(report.ts, now) <= FRICTION_WINDOW_DAYS);
    const silent = recent.filter((report) => report.friction.length === 0).length;
    if (silent * 2 <= recent.length)
    {
        return [];
    }
    return [`no friction on ${silent} of this project's ${plural(recent.length, "report")}`
        + ` in the last ${FRICTION_WINDOW_DAYS} days — self report … --friction "<what differed>"`];
}

// A record is settled by the next append and by nothing else (#390 §2.2), so
// the newest append is the one nobody has built on yet. Saying so on every
// write of this session would be noise — the receipt already said it — so the
// line is scoped to the case that motivates it: a session resumes, and the
// last thing recorded was written by someone else and never looked at.
//
// An annulment is not flagged: it is the answer to this line, not a new
// record awaiting one.
function unreviewedSignal(model: ProjectModel, events: SelfEvent[], session: string | undefined): string[]
{
    const newest = [...events].sort((left, right) =>
        left.ts.localeCompare(right.ts) || left.id.localeCompare(right.id)).at(-1);
    if (newest === undefined || newest.type === "entity.annulled" || newest.type === "entity.restored"
        || newest.origin.session === session)
    {
        return [];
    }
    const named = String(newest.payload.entity ?? newest.refs?.work ?? "");
    const text = model.entities.find((item) => item.id === named)?.text ?? String(newest.payload.text ?? "");
    return [`the last record is unreviewed: ${`${named} ${text}`.trim()} [${newest.id}]`
        + " — `self undo` takes it back"];
}

function deriveSignals(model: ProjectModel, local: LocalOverlay, events: SelfEvent[]): void
{
    const now = local.now;
    model.health.push(...deriveGoals(model.goals, model.works, now, model.zone));
    model.health.push(...frictionSignals(model, now));
    model.health.push(...unreviewedSignal(model, events, local.session));
    noteProposedObjectives(model);
    expireProposedDecisions(model, now);
    for (const work of model.works)
    {
        deriveWorkSignals(model, work, now);
    }
}

// The band, and the inversion that makes it possible, in one pass over the
// live proposals. Both sides are indexed first — units by id, superseded ids by
// the proposals claiming them — so the cost stays linear in decisions plus work
// rather than the product of the two.
function deriveAttention(model: ProjectModel, verdicts: Record<string, Verdict>): void
{
    const live = model.decisions
        .filter((decision) => decision.status === "proposed" && !decision.expired)
        .sort((left, right) => left.ts.localeCompare(right.ts) || left.id.localeCompare(right.id));
    const band: BandIndex = {
        works: new Map(model.works.map((work) => [work.id, work])),
        verdicts,
        open: new Set(live.map((decision) => decision.id)),
        claimed: supersessionClaims(live)
    };
    for (const decision of live)
    {
        gate(band, decision);
        const row = attentionRow(decision, band);
        model.attention[row.group].push(row);
    }
}

// Everything one pass needs to place a row, indexed once. Built here rather
// than looked up per row: a decision asks about work, about the proposals still
// open, and about what they collide over, and each of those is a scan.
interface BandIndex
{
    works: Map<string, WorkState>;
    verdicts: Record<string, Verdict>;
    open: Set<string>;
    claimed: Map<string, string[]>;
}

function gate(band: BandIndex, decision: DecisionState): void
{
    for (const id of decision.blocks)
    {
        const gated = band.works.get(id);
        if (gated !== undefined && !gated.gatedBy.includes(decision.id))
        {
            gated.gatedBy.push(decision.id);
        }
    }
}

function attentionRow(decision: DecisionState, band: BandIndex): AttentionRow
{
    const flags = attentionFlags(decision, band);
    // A proposal that gates nothing can never be in effect: there is no landed
    // work to read the rule off, and silence is not evidence.
    const inEffect = decision.blocks.length > 0
        && decision.blocks.every((id) => landed(band.works.get(id), band.verdicts));
    return {
        decision: decision.id,
        text: decision.text,
        // Being already in force outranks a flag: what still stands between the
        // rule and the record does not change that the work ran under it.
        group: inEffect ? "inEffect" : flags.length > 0 ? "undecidable" : "unblocks",
        blocks: decision.blocks,
        after: decision.after,
        flags
    };
}

// An event id in the log names something that already happened, so only a
// proposal still open can hold another one back. Anything else `--after` names
// — a report, a merge, an event this clone has not pulled — is not a wait.
function attentionFlags(decision: DecisionState, band: BandIndex): string[]
{
    const flags: string[] = [];
    if (decision.after !== undefined && band.open.has(decision.after))
    {
        flags.push(`waiting on ${decision.after}`);
    }
    const rival = decision.supersedes
        .flatMap((id) => band.claimed.get(id) ?? [])
        .find((id) => id !== decision.id);
    if (rival !== undefined)
    {
        flags.push(`conflict with ${rival}`);
    }
    return flags;
}

// Two live proposals that retire the same decision cannot both be confirmed as
// written — confirming either one leaves the other describing a rule that is no
// longer there.
function supersessionClaims(live: DecisionState[]): Map<string, string[]>
{
    const claimed = new Map<string, string[]>();
    for (const decision of live)
    {
        for (const id of decision.supersedes)
        {
            claimed.set(id, [...claimed.get(id) ?? [], decision.id]);
        }
    }
    return claimed;
}

// A gated unit landed only when it is done and every commit it offered is
// settled — reachable from the default branch. Provisional, unknown and
// unverifiable each read as not landed, and so does a unit that offered no
// commits at all: calling a rule live on evidence nobody can reach would retire
// a decision the person never made.
function landed(work: WorkState | undefined, verdicts: Record<string, Verdict>): boolean
{
    return work !== undefined
        && work.status === "done"
        && work.evidence.length > 0
        && work.evidence.every((hash) => verdicts[hash] === "settled");
}

// The key an unrecorded branch is grouped under. No git branch can be named
// the empty string, so it can never collide with one that was recorded.
const NO_BRANCH = "";

// What a unit reported from each branch. Attribution follows the report that
// carried the commits, because only a report says which commits were produced;
// `WorkState.branches` is the union of the same ref across every event kind and
// cannot say which branch a given hash came from.
function evidenceByBranch(work: WorkState): Map<string, Set<string>>
{
    const perBranch = new Map<string, Set<string>>();
    for (const report of work.reports)
    {
        const key = report.branch ?? NO_BRANCH;
        // A set, not a list scanned per hash: one commit reported twice from
        // one branch is still one commit, and a fold runs on every event.
        const hashes = perBranch.get(key) ?? new Set<string>();
        report.commits.forEach((hash) => hashes.add(hash));
        perBranch.set(key, hashes);
    }
    return perBranch;
}

// Open work only, and every surface says so in the words it counts with.
// A closed unit's verdicts stop being recomputed — `evidenceOf` in
// `reachability.ts` leaves the archive alone so that recording state does not
// cost more the longer a project lives — so its commits keep whatever verdict
// they held the day it closed. Stating one here would mean a unit marked done
// while its branch was unmerged claims that branch as unshipped for good,
// including long after the merge, and no action a reader takes clears it. The
// statement is worth having only where it is checked on every fold, so it
// covers exactly the work that is: an omission under a stated scope is honest,
// a frozen claim is not. Retired work is excluded by the same filter and would
// be anyway, having already said it will not be delivered here.
//
// The other side — refreshing the archive so closed units could be stated — is
// the cost #128 exists to keep out: unsettled evidence never settles after a
// squash merge, so the recheck set would grow with the project and every event
// append would pay for it.
function stated(works: WorkState[]): WorkState[]
{
    return works.filter(isOpenWork);
}

// A verdict that cannot locate the commit cannot say whether it shipped.
// `unknown` is the fold admitting it can tell neither a merge from a discard;
// `unverifiable` is the object being gone from the database. Neither is a
// weaker `provisional` — `provisional` asserts the work has not landed, and
// these assert nothing at all — so neither carries a branch here.
//
// `landed` one section up counts them as not-landed, and that is right there
// for a reason that reverses here. It gates a decision on completed work, so
// the expensive mistake is a false yes: calling a rule live on evidence nobody
// can reach retires a decision the person never made. This section makes the
// opposite claim, that work has NOT shipped, so the expensive mistake is the
// false yes in the other direction — and it is the one squash and rebase merges
// produce every time, since both rewrite the hash and delete the branch.
//
// `stated` above already refuses to make a claim that no action can clear, in
// the words "an omission under a stated scope is honest, a frozen claim is
// not". This is the same frozen claim on a unit that happens to still be open:
// by that comment's own account unsettled evidence never settles after a squash
// merge, so nothing a reader does will ever retire the line.
const CANNOT_LOCATE: ReadonlySet<Verdict> = new Set<Verdict>(["unknown", "unverifiable"]);

// What has not shipped, per branch. A branch carries a unit when some commit
// the unit reported from it is positively not settled: `provisional`,
// `abandoned`, or not yet judged — an unjudged hash must not drop out before
// the first fold reaches it. A branch with nothing unsettled gets no line.
export function unshippedBranches(works: WorkState[], verdicts: Record<string, Verdict>): BranchUnshipped[]
{
    const branches = new Map<string, BranchUnshipped>();
    for (const work of stated(works))
    {
        for (const [key, hashes] of evidenceByBranch(work))
        {
            const unsettled = [...hashes]
                .filter((hash) => verdicts[hash] !== "settled" && !CANNOT_LOCATE.has(verdicts[hash])).length;
            if (unsettled === 0)
            {
                continue;
            }
            const state = branches.get(key) ?? { branch: key === NO_BRANCH ? undefined : key, unshipped: [] };
            state.unshipped.push({ work: work.id, status: work.status, evidence: hashes.size, unsettled });
            branches.set(key, state);
        }
    }
    // Sorted by id rather than left in log order: a union merge orders two
    // clones' lines differently, and the same store must render the same bytes
    // on either machine.
    for (const state of branches.values())
    {
        state.unshipped.sort((left, right) => compareBytes(left.work, right.work));
    }
    return [...branches.values()].sort(compareBranch);
}

// UTF-8 byte order, never `localeCompare`: the default collator is built from
// LC_ALL and LANG, so the same store folded on two machines — or by one
// machine whose environment changed between runs — would order these lines
// differently. A branch name is bytes the store recorded; comparing it by
// those bytes is the only comparison the environment cannot move.
function compareBytes(left: string, right: string): number
{
    return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

// Named branches first and in name order, the unrecorded line last: it is the
// one group a reader cannot act on by checking out.
function compareBranch(left: BranchUnshipped, right: BranchUnshipped): number
{
    if (left.branch === undefined || right.branch === undefined)
    {
        return (left.branch === undefined ? 1 : 0) - (right.branch === undefined ? 1 : 0);
    }
    return compareBytes(left.branch, right.branch);
}

// The single site that answers "what waits on a person": every renderer reads
// either list, so an item can never appear in one and be missing from the other.
function noteWaiting(model: ProjectModel, item: WaitingItem): void
{
    model.openQuestions.push(item.full);
    model.waiting.push(item);
}

function ageDays(ts: string, now: Date): number
{
    return (now.getTime() - new Date(ts).getTime()) / 86_400_000;
}
