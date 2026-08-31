import { EntityState, rendersIn, scopeTarget } from "@superself/fold";
import { ProjectModel, ReportEntry, WorkState } from "./model.js";
import { CliError } from "./types.js";

// The decision-bound design gate (#316).
//
// A design report is a proposal to turn a recorded decision into code, and the
// failure it exists against is a real one: a session proposed a scope cut that
// contradicted the decision defining that scope, because nothing forced the
// ledger to be re-read at the proposal moment. Prose rules did not bind — a
// stronger instruction in the conversation always won — so this is a refusal
// in code, the same mechanic `work done` already uses against evidence-less
// claims.
//
// One judgment, two callers. `self report --design` runs it at submission, so
// a design that cites a dead decision is never recorded; `self work start`
// runs it again at dispatch, because a decision can be superseded between the
// two and the approval said nothing about that. Both read `judge` below —
// there is no second answer to "is this citation still good".

// What the receipt echoes back, so a mismatch between the design and the
// decision is visible at the moment of submission rather than at review.
export interface CitedDecision
{
    id: string;
    text: string;
    status: string;
    project: string;
}

type Judgment = { cited: CitedDecision } | { refusal: string };

// The one liveness judgment. `viewer` is the project the work unit belongs to,
// never the directory the command ran in: a report about another project's
// unit is recorded into that project's log, so reachability is that project's
// question (#181 D3).
function judge(models: ProjectModel[], viewer: string, wanted: string): Judgment
{
    const found = locate(models, wanted);
    if (found === null)
    {
        return { refusal: `${wanted} is not a decision this project knows — run \`self search --type decision\` to list the ids` };
    }
    const { entity, home } = found;
    if ((entity.source ?? "entity") !== "decision")
    {
        return { refusal: `${entity.id} is a ${entity.source ?? "plain"} record, and --implements cites a decision — record the decision with \`self decide\` and cite that` };
    }
    if (!rendersIn(entity, home, viewer))
    {
        return { refusal: `${entity.id} renders in project ${scopeTarget(entity, home)} and not in ${viewer}, so this work cannot implement it — place it with \`self state place ${entity.id} --scope ${viewer}\` or record the decision where the work lives` };
    }
    return closedRefusal(entity) ?? { cited: { id: entity.id, text: entity.text, status: entity.status, project: home } };
}

// The three dead states, each naming what to do instead. A superseded decision
// names its successor, which is the whole of the override path: the way to
// change direction is to supersede the decision and cite what replaced it.
function closedRefusal(entity: EntityState): { refusal: string } | null
{
    if (entity.status === "superseded")
    {
        const successor = entity.supersededBy ?? "its successor";
        return { refusal: `${entity.id} was superseded by ${successor} — cite the successor: --implements ${successor}` };
    }
    if (entity.status === "retracted")
    {
        const why = entity.closedWhy === undefined ? "" : ` — ${entity.closedWhy}`;
        const verb = entity.confirmedOnce ? "retracted" : "declined";
        return { refusal: `${entity.id} was ${verb}${why}, so no design implements it — record a decision that holds with \`self decide\` and cite that` };
    }
    return null;
}

interface Located
{
    entity: EntityState;
    home: string;
}

// Exact id first, then a unique prefix, across every project's fold — the same
// two-step every other id argument in the CLI takes. Records that do not
// render here are searched too, so citing one is refused by naming where it
// lives rather than as an unknown id.
function locate(models: ProjectModel[], wanted: string): Located | null
{
    const all = models.flatMap((model) => model.entities.map((entity) => ({ entity, home: model.slug })));
    const exact = all.find((item) => item.entity.id === wanted);
    if (exact !== undefined)
    {
        return exact;
    }
    const matches = all.filter((item) => item.entity.id.startsWith(wanted));
    if (matches.length > 1)
    {
        throw new CliError(`decision id "${wanted}" is ambiguous (${matches.length} records match) — spell more of it`);
    }
    return matches[0] ?? null;
}

// Submission. Every citation is judged before anything is written, and the
// first bad one is the refusal: a design report is one statement, so it is
// recorded whole or not at all.
export function requireCitations(models: ProjectModel[], viewer: string, ids: string[]): CitedDecision[]
{
    return ids.map((id) =>
    {
        const verdict = judge(models, viewer, id);
        if ("refusal" in verdict)
        {
            throw new CliError(verdict.refusal);
        }
        return verdict.cited;
    });
}

// Repeatable and comma-separable, because a design implementing three
// decisions is the ordinary case and three flags to say it is not.
export function citedIds(values: string[] | undefined): string[]
{
    const ids = (values ?? []).flatMap((value) => value.split(",")).map((value) => value.trim()).filter((value) => value !== "");
    return [...new Set(ids)];
}

// What the receipt says back. The decision's own text, not its id alone: an id
// echoed at a session that never read the decision proves nothing, and the
// point of the echo is that a person or an agent notices the mismatch here.
export function citationLines(cited: CitedDecision[]): string[]
{
    return cited.map((item) => `  implements ${item.id} (${item.status}) — ${item.text}`);
}

/* ── the dispatch gate ─────────────────────────────────────────────── */

// Dispatch. A unit carrying no design report is not what this gate is about
// and passes untouched; a unit that carries one may only be picked up against
// an approved design, whose approval names the exact bytes, and whose citations
// are still live *now* rather than when it was approved.
export function dispatchRefusal(models: ProjectModel[], viewer: string, work: WorkState): string | null
{
    const designs = work.reports.filter((report) => report.design === true);
    if (designs.length === 0)
    {
        return null;
    }
    const problems: string[] = [];
    for (const design of [...designs].reverse())
    {
        const problem = designProblem(models, viewer, design);
        if (problem === null)
        {
            return null;
        }
        problems.push(problem);
    }
    return `${work.id} cannot be picked up yet — ${problems[0]}`;
}

// Why one design report does not admit a dispatch, or null when it does. The
// three conditions are the three halves of "approved design" that can each be
// missing on their own: a ruling, the bytes it ruled on, and a decision the
// ruling still stands under.
function designProblem(models: ProjectModel[], viewer: string, design: ReportEntry): string | null
{
    if (design.approval === undefined)
    {
        return `its design ${design.id} is waiting on an approval: \`self report confirm ${design.id}\``;
    }
    if (design.approval.digest === undefined)
    {
        return `the approval on design ${design.id} names no artifact hash, so it does not say which design was approved — resubmit the design with --artifact <path> and have it approved again`;
    }
    return staleCitation(models, viewer, design);
}

function staleCitation(models: ProjectModel[], viewer: string, design: ReportEntry): string | null
{
    for (const id of design.implements)
    {
        const verdict = judge(models, viewer, id);
        if ("refusal" in verdict)
        {
            return `the decision its approved design ${design.id} implements no longer holds: ${verdict.refusal}`;
        }
    }
    return design.implements.length === 0
        ? `its approved design ${design.id} cites no decision, so nothing says what it implements`
        : null;
}

/* ── what a reader sees ────────────────────────────────────────────── */

// The one sentence a design report adds wherever reports are listed: what it
// implements, and whether a person has ruled on it.
export function designNote(report: ReportEntry): string
{
    if (report.design !== true)
    {
        return "";
    }
    const cites = report.implements.length === 0 ? "citing nothing" : `implementing ${report.implements.join(", ")}`;
    return ` (design ${cites}, ${report.approval === undefined ? "not approved" : `approved ${report.approval.ts.slice(0, 10)}`})`;
}
