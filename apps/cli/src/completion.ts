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
// `work.required` / `work.covered` grammar. #305 stopped folding those events,
// so the criteria a unit carries are its entity's, judged by
// `requireCriteriaCovered` on the `self state done` path; what is left here is
// the evidence gate, which every unit of every kind still passes through.

// What the completion check reads about a work unit. Kept structural rather
// than importing WorkState, so the check stays a function of the fold instead
// of a second consumer of the model's shape.
interface Completable
{
    id: string;
    reports: { commits: string[]; artifacts: unknown[] }[];
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
// The gate applies at verb write time only. The fold never refuses history.
export function completionRefusal(work: Completable, doneReport?: string): string | null
{
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
