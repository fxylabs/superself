// The CLI's end of the fold. The calculation itself is `@superself/fold`,
// which reads events and knows nothing about a store; this module is the one
// place that turns a store directory into the arguments that calculation takes
// — the log, the registry's description, the workspace zone, the session, and
// the verdicts this machine reached about the evidence.
//
// The fold's own vocabulary is re-exported below rather than reached for
// twice: every module that already asked `./model.js` what a `ProjectModel` is
// still asks it, and there is one import line to change the day the package
// moves.

import { applyLocalOverlay, EntityState, foldEvents, isCurrent, ProjectModel, rendersIn } from "@superself/fold";
import { readEvents } from "./logfile.js";
import { sessionToken } from "./machine.js";
import { activeProjects, readRegistry, readStoreConfig, readVerdicts } from "./paths.js";

export {
    applicableConventions,
    ATTENTION_ORDER,
    AttentionGroup,
    AttentionRow,
    branchLabel,
    branchTotals,
    BranchUnshipped,
    closedRecords,
    currentConventions,
    DecisionState,
    ForeignObjectiveLink,
    foreignToward,
    HandoffConvention,
    isOpenWork,
    liveGoals,
    LogPage,
    otherGoals,
    planNote,
    ProjectModel,
    projectGoalLine,
    RecoveryTarget,
    ReportEntry,
    reportProjection,
    reviewRefusal,
    reviewWork,
    ScopableVerb,
    STATEMENT_TYPES,
    unshippedBranches,
    WaitingItem,
    workScope,
    WorkState
} from "@superself/fold";

// One project's state as this machine reads it: the log-determined fold, then
// the overlay of everything the log cannot decide. The four machine-local
// inputs are gathered here and nowhere else, so a reader asking what this CLI
// adds to a shared log has one function to read.
export function buildModel(storeDir: string, slug: string, now: Date): ProjectModel
{
    // The store is read in the order it always was — registry, config, log —
    // because a store nothing can read must fail on the same file it used to,
    // and `readableModels` prints the message it fails with.
    const description = readRegistry(storeDir).find((item) => item.slug === slug)?.description;
    const local = { now, session: sessionToken(), verdicts: readVerdicts(storeDir, slug), zone: readStoreConfig(storeDir).timezone };
    // One read of the log, both layers: the overlay reads the events again to
    // date the newest append, and a second walk of the file would double the
    // cost of every fold.
    const events = readEvents(storeDir, slug);
    return applyLocalOverlay(foldEvents(events, { slug, description }), events, local);
}

// Every active project's fold, the named one first. A record renders where its
// scope points rather than where its log sits (#181 D1), so answering for one
// project — what it renders, what its tiers hold — reads every store. An
// archived project is not among them (#283): it is out of every workspace-wide
// answer until it is restored, and `--project <slug>` is how its own state is
// still read.
export function workspaceModels(storeDir: string, first?: string): ProjectModel[]
{
    const now = new Date();
    const rest = foldedOthers(storeDir, activeProjects(storeDir).map((entry) => entry.slug)
        .filter((slug) => slug !== first), now);
    return first === undefined ? rest : [buildModel(storeDir, first, now), ...rest];
}

// The folds of the projects an answer is not about — every one that reads, and a
// line on stderr naming each one that does not. Exported because the workspace
// answer is folded in more than one shape: this module builds the list a command
// reasons over, and `views.ts` builds the one it renders from, and both of them
// are the same rule about somebody else's damaged store.
export function foldedOthers(storeDir: string, slugs: string[], now: Date): ProjectModel[]
{
    return slugs.flatMap((slug) => isolated(storeDir, slug, now));
}

// One project's unreadable state is that project's problem. A workspace-wide
// answer folds every registered log, and a server-backed store puts a second
// file beside each one that a half-written line can damage — so without this, a
// queue nobody has looked at in a month takes down `self status` for the four
// projects that are fine.
//
// The project an answer is about never comes through here, and that is the whole
// of the distinction. `self work` asks for the workspace so a record can render
// where its scope points, but the project it is *about* is the one it named:
// swallowing that one's failure would answer about a project out of a log that
// would not read, which is the quiet wrong answer this file otherwise refuses to
// give. It is folded directly by its caller, and its refusal is the loud one it
// has always been.
//
// The line goes to stderr, and names the project so the sentence underneath it
// can be acted on: a piped read still gets exactly the bytes it always got.
function isolated(storeDir: string, slug: string, now: Date): ProjectModel[]
{
    try
    {
        return [buildModel(storeDir, slug, now)];
    }
    catch (error)
    {
        noteUnreadable(slug, (error as Error).message);
        return [];
    }
}

// Once per project per invocation. A single command folds the workspace several
// times over — every surface that asks what another project holds asks again —
// and the same sentence five times reads as five broken projects.
const noted = new Set<string>();

export function resetUnreadableNotices(): void
{
    noted.clear();
}

function noteUnreadable(slug: string, why: string): void
{
    if (!noted.has(slug))
    {
        noted.add(slug);
        console.error(`project "${slug}" is left out of this answer — its state could not be read: ${why}`);
    }
}

// Every record that answers in one project: its own confirmed current records
// plus every other project's workspace-scoped ones. `rendersIn` is the rule
// the context projection already collects by, so a record reaches a listing
// exactly where a row renders.
//
// It sits here, with the store walks, because three surfaces read it — the
// skill listing, the instruction render and the handoff packet — and a copy
// beside each one is how two surfaces come to answer with two different sets.
export function renderedIn(models: ProjectModel[], viewer: string): EntityState[]
{
    return models.flatMap((model) => model.entities.filter((item) => item.status === "confirmed"
        && isCurrent(item) && rendersIn(item, model.slug, viewer)));
}

// Which registered projects hold the record a call names (#302). A confirm
// answers to a record that already exists and already has an owning project,
// so the project is never asked for — it is found, and the caller says what
// "holds it" means for the record kind it is about to act on.
//
// The directory's own project answers first and ends the search, so a call
// made from the right checkout costs exactly the one fold it always did. Only
// a call made from outside pays for the enumeration, which is the call that
// could not be made at all before.
//
// The archived projects are in it. Whether an archived project may be written
// into is the append gate's one rule (#283); leaving them out here would
// answer "no project holds this record" where the truth is "restore it first".
//
// The fold travels with the answer, because the caller is about to look the
// record up in exactly this model: handing back the slug alone would make
// every confirm read and fold its project's log twice.
type Holding = { project: string; model: ProjectModel };

export function projectsHolding(storeDir: string, holds: (model: ProjectModel) => boolean, first?: string): Holding[]
{
    const now = new Date();
    if (first !== undefined)
    {
        const model = buildModel(storeDir, first, now);
        if (holds(model))
        {
            return [{ project: first, model }];
        }
    }
    return readRegistry(storeDir)
        .map((entry) => entry.slug)
        .filter((slug) => slug !== first)
        .flatMap((project) => holding(storeDir, project, now, holds));
}

// Only the matches are kept: a workspace of thirty projects folds thirty logs
// to answer this, and holding every one of them for the one the caller wants
// is memory spent on projects the answer already ruled out.
function holding(storeDir: string, project: string, now: Date,
    holds: (model: ProjectModel) => boolean): Holding[]
{
    const model = buildModel(storeDir, project, now);
    return holds(model) ? [{ project, model }] : [];
}

// What a workspace-wide listing reads: every registered project that folds,
// and a line naming each one that does not (#75 T4.5). `self project` answers
// about the workspace as a whole — which slugs exist, and which project came
// from which — so one store nothing can read must not take the answer for
// every other project down with it. Every other surface still folds through
// `workspaceModels`, where an unreadable store is a failure worth stopping on.
//
// The active projects, and only those: `self project --archived` is the one
// listing an archived project belongs in, and it prints from the archive state
// rather than from a fold (#283).
export function readableModels(storeDir: string): { models: ProjectModel[]; unreadable: string[] }
{
    const now = new Date();
    const models: ProjectModel[] = [];
    const unreadable: string[] = [];
    for (const entry of activeProjects(storeDir))
    {
        try
        {
            models.push(buildModel(storeDir, entry.slug, now));
        }
        catch (error)
        {
            unreadable.push(`${entry.slug}: its state could not be read, so it is skipped here — ${(error as Error).message}`);
        }
    }
    return { models, unreadable };
}
