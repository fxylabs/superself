// The derived reading of a runbook (#171): which procedures a project has
// registered, which edition each one is on, and how far every instance
// following one has got. Domain layer — it reads the entity fold and its own
// peers only, never the model that calls it.
//
// Nothing here is stored. A runbook is an entity labelled `runbook` whose
// stages live in the reserved metadata `criteria`; an instance is an entity
// labelled `runbook-run` that copied those stages and links `member-of` the
// edition it started under; passing a stage is one `entity.covered`. Every
// number this module reports — the edition, the position in the procedure,
// the drift between an instance and the current edition — is computed from
// those records the way `artifactDigest` computes rather than stores, so no
// stored field can contradict the log.

import { createHash } from "node:crypto";
import { chainHead, chainVersion, EntityState, isCurrent, isLive, supersedesChain, uncoveredCriteria } from "./entities.js";

// The two labels the surface records under. `runbook-run` rather than `run`:
// `run.*` is the attempt namespace and `self work run` is a process, so a
// third reading of the same word would make the log ambiguous. Neither label
// is a preset row — see `RUNBOOK_ROW` in `runbook.ts`.
export const RUNBOOK_LABEL = "runbook";
export const RUNBOOK_RUN_LABEL = "runbook-run";

function isRunbook(entity: EntityState): boolean
{
    return entity.labels.includes(RUNBOOK_LABEL) && entity.source === undefined;
}

export function isRunbookRun(entity: EntityState): boolean
{
    return entity.labels.includes(RUNBOOK_RUN_LABEL) && entity.source === undefined;
}

// The stage list's fingerprint, twelve characters of sha256 over the stages
// joined by a newline. Derived on every read: an edition that only changed its
// name keeps the same fingerprint, which is what lets a version difference
// stay quiet when the procedure itself did not move.
export function stageDigest(stages: string[]): string
{
    return createHash("sha256").update(stages.join("\n")).digest("hex").slice(0, 12);
}

/* ── the edition chain ─────────────────────────────────────────────── */

// The whole chain a runbook id belongs to, oldest edition first. The walk
// itself is `entities.ts` `supersedesChain`, shared with every other kind that
// versions itself by supersession (#391); what is a runbook is this module's
// to say, and that is all this wrapper adds.
export function runbookChain(entities: EntityState[], id: string): EntityState[]
{
    return supersedesChain(entities, id, isRunbook);
}

/* ── what a project has registered, and what is running ────────────── */

// The procedures a project can start an instance of: one per chain, the
// confirmed edition that holds. A retracted runbook has left, and a revision
// nobody confirmed yet is not a procedure to start.
export function runbookDefinitions(entities: EntityState[]): EntityState[]
{
    return entities.filter((entity) => isRunbook(entity) && entity.status === "confirmed" && isCurrent(entity));
}

// Every instance the log still holds a live record of, whatever its working
// state. A caller that only wants the moving ones filters on `isCurrent`,
// which is what drops a finished or stopped instance out of context.
export function runbookInstances(entities: EntityState[]): EntityState[]
{
    return entities.filter((entity) => isRunbookRun(entity) && isLive(entity));
}

// The edition an instance started under, by id: the target of its `member-of`
// link. An instance whose definition was never recorded here answers
// undefined, and every reader treats that as "no edition to compare against"
// rather than refusing to render the instance.
export function instanceDefinition(instance: EntityState): string | undefined
{
    return instance.links.find((link) => link.type === "member-of")?.target;
}

// The key a person names the instance by — `E001` — which is the label beside
// `runbook-run`. An instance recorded without one answers by its id, so no
// render is ever left with nothing to print.
export function instanceKey(instance: EntityState): string
{
    return instance.labels.find((label) => label !== RUNBOOK_RUN_LABEL) ?? instance.id;
}

/* ── where an instance has got to ──────────────────────────────────── */

// The stage an instance is on: the first of its own stages no coverage claim
// answers. Undefined once every stage is passed, which is the state
// `self state done` closes.
export function currentStage(instance: EntityState): string | undefined
{
    return uncoveredCriteria(instance)[0];
}

// The stage after the current one, which is what a resuming session reads as
// "what happens next". Undefined on the last stage.
function nextStage(instance: EntityState): string | undefined
{
    return uncoveredCriteria(instance)[1];
}

// How far along the instance is, as the pair a render prints: the 1-based
// place of the current stage, and how many stages there are. A finished
// instance reports its own length as the place, so `11/11` reads as done
// rather than as an overflow.
function stagePlace(instance: EntityState): { at: number; of: number }
{
    const open = uncoveredCriteria(instance).length;
    const of = instance.criteria.length;
    return { at: of - open + (open === 0 ? 0 : 1), of };
}

/* ── one instance, read whole ──────────────────────────────────────── */

// Everything a render says about one instance, derived in one place so the
// piped context, the terminal context and `runbook show` cannot describe the
// same instance three ways.
interface RunbookReading
{
    instance: EntityState;
    key: string;
    // The procedure's name as the edition this instance follows states it, and
    // the id of that chain's root — the stable workflow id every render points
    // at, whatever edition is current.
    name: string;
    root: string;
    version: number;
    head: number;
    // True only when the edition moved **and** the stages actually differ. An
    // edition that renamed the procedure and left the procedure alone is not
    // something to warn a reader about.
    drifted: boolean;
    at: number;
    of: number;
    stage?: string;
    next?: string;
}

export function readInstance(entities: EntityState[], instance: EntityState): RunbookReading
{
    const followed = instanceDefinition(instance) ?? "";
    const chain = runbookChain(entities, followed);
    const head = chainHead(chain);
    const place = stagePlace(instance);
    return {
        instance,
        key: instanceKey(instance),
        name: chain.find((item) => item.id === followed)?.text ?? instance.text,
        root: chain[0]?.id ?? instance.id,
        version: chainVersion(chain, followed),
        head: head === undefined ? 0 : chainVersion(chain, head.id),
        drifted: drifted(chain, followed, head),
        at: place.at,
        of: place.of,
        stage: currentStage(instance),
        next: nextStage(instance)
    };
}

function drifted(chain: EntityState[], followed: string, head: EntityState | undefined): boolean
{
    const edition = chain.find((item) => item.id === followed);
    if (edition === undefined || head === undefined || head.id === followed)
    {
        return false;
    }
    return stageDigest(edition.criteria) !== stageDigest(head.criteria);
}

// The one line every render prints for an instance, minus the pointer each
// render attaches in its own form: the key, the procedure and the edition it
// follows, how far it has got, and what comes next.
export function runbookRow(reading: RunbookReading): string
{
    const edition = reading.drifted
        ? `v${reading.version} (the definition is on v${reading.head})`
        : `v${reading.version}`;
    const place = `${reading.at}/${reading.of} ${reading.stage ?? "every stage passed"}`;
    return `${reading.key} · ${reading.name} ${edition} · ${place} · ${nextNote(reading)}`;
}

// What the reader does next, which is a different sentence on each of the
// three states a run can be read in: another stage to come, the last stage in
// hand, or nothing left but the close.
function nextNote(reading: RunbookReading): string
{
    if (reading.next !== undefined)
    {
        return `next: ${reading.next}`;
    }
    return reading.stage === undefined
        ? `next: close it with \`self state done ${reading.instance.id} --report "<what verifiably happened>"\``
        : "next: the last stage";
}
