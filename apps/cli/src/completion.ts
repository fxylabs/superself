// Semantic completion, kept apart from physical completion.
//
// An attempt that passes its completion gate has produced a verified result and
// freed the work unit it held. That is the whole of what settlement says. It
// does not say the work is done: what the outcome had to show for itself is a
// statement about the outcome, and it cannot be read off an exit code, a
// published artifact, or an agent's prose.
//
// So `work.done` is its own event, admitted by one check that every caller
// reaches — `self work done` before it records, and the model where it derives
// what an open unit still owes. Nothing here is inferred from a transition.
//
// The declared-criteria half of this gate lived on the pre-cutover
// `work.required` / `work.covered` grammar. #305 stopped folding those events
// and sent the criteria half to `self state done`; #408 brings it back here,
// because a work unit declares criteria of its own and `work done` must read
// the same gate. It is spelled once, with the verb family as a parameter: a
// work unit is never handed a `self state cover` line and a raw entity is
// never handed a `self work` one.

import { CriterionState } from "./entities.js";

// What the completion check reads about a work unit. Kept structural rather
// than importing WorkState, so the check stays a function of the fold instead
// of a second consumer of the model's shape.
interface Completable
{
    id: string;
    criteria: CriterionState[];
    reports: { commits: string[]; artifacts: unknown[] }[];
}

/* ── the criteria gate ─────────────────────────────────────────────── */

// Which family of verbs the refusal speaks in: the record kind decides, so a
// caller never has to spell the recovery line for itself.
type VerbFamily = "work" | "state";

const RETIRED_NOUN: Record<VerbFamily, string> = { work: "unit", state: "entity" };

// The criteria a record declared that carry no coverage claim, refused with
// what each one is waiting on and the line that covers it. Null when the
// record declares none, or when every one of them is covered.
export function criteriaRefusal(id: string, criteria: CriterionState[], family: VerbFamily): string | null
{
    const open = criteria.filter((item) => item.covered === undefined);
    if (open.length === 0)
    {
        return null;
    }
    return [
        `${id} declares ${plural(criteria.length, "criterion", "criteria")} and `
            + `${open.length} ${open.length === 1 ? "is" : "are"} not covered:`,
        ...open.map(openRow),
        `  cover each with \`self ${family} cover ${id} --criterion ${nextToCover(open).id} --why "<how>"\` — a `
            + `covered criterion's block ends with it — or retire the ${RETIRED_NOUN[family]} if the outcome was given up`
    ].join("\n");
}

// A blocked criterion states what it waits on and why, because that is the
// next action; an open one states its own text, because that is.
function openRow(criterion: CriterionState): string
{
    const blocked = criterion.blocked;
    return blocked === undefined
        ? `    ${criterion.id}  open — ${criterion.text}`
        : `    ${criterion.id}  blocked on ${blocked.on}${blocked.why === undefined ? "" : ` — ${blocked.why}`}`;
}

// Which criterion the recovery line names: the first one nothing is standing
// in front of. Covering a blocked criterion is allowed and ends its block, but
// the line a reader pastes should be the one they can act on now.
function nextToCover(open: CriterionState[]): CriterionState
{
    return open.find((item) => item.blocked === undefined) ?? open[0];
}

function plural(count: number, one: string, many: string): string
{
    return `${count} ${count === 1 ? one : many}`;
}

/* ── the completion check ──────────────────────────────────────────── */

// The one function that decides whether a work unit may be called done. Every
// caller reaches it: `self work done` before it records the event, and the
// model when it derives what an open unit still owes.
//
// The evidence gate (#205, user-ruled 2026-08-03): done requires at least one
// checkable item — a report carrying a commit, a report carrying an artifact,
// or a text report supplied at done time that states what verifiably
// happened. A bare summary never satisfies (ruling ②): prose that offered
// nothing checkable when it was written does not become evidence because the
// unit is being closed. The approval, model-policy and fresh-review conditions
// stay removed (decision 01kz2nczhtde554qx5tqpqzrt3).
//
// The criteria clause is judged before the evidence clause (#408): a criterion
// names its own next action and often carries the `--verify` text that says
// how, while the evidence floor sends the reader to a report they may not owe
// yet.
//
// The gate applies at verb write time only. The fold never refuses history.
export function completionRefusal(work: Completable, doneReport?: string): string | null
{
    const uncovered = criteriaRefusal(work.id, work.criteria, "work");
    if (uncovered !== null)
    {
        return uncovered;
    }
    if (work.reports.some((report) => report.commits.length > 0 || report.artifacts.length > 0))
    {
        return null;
    }
    if (doneReport !== undefined && doneReport.trim() !== "")
    {
        return null;
    }
    if (work.reports.length === 0)
    {
        return `${work.id} has no evidence for done — attach a report first `
            + `(\`self report ${work.id} "<summary>" --evidence <commit>\` or \`--artifact <path>\`), `
            + `or state what verifiably happened with \`self work done ${work.id} --report "<what happened>"\``;
    }
    return `${work.id}'s reports carry no commit or artifact evidence, and a bare summary never satisfies done — `
        + `state what verifiably happened with \`self work done ${work.id} --report "<what happened>"\`, `
        + `or attach evidence with \`self report ${work.id} "<summary>" --evidence <commit>\``;
}
