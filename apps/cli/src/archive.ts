// Setting a project aside, and picking it back up (#283).
//
// Archiving is not retirement. Retirement is an ending — the outcome was given
// up or moved, and the record closes. A project nobody is working on this
// quarter has not ended: it is set aside with its open work exactly as it
// stands, and it comes back whole. So this is a round trip between two states,
// which is why the way back is a verb of its own rather than `undo`.
//
// `undo` is not a second way back, because it cannot be one: it resolves the
// project from the directory it runs in, and `archive` names a slug precisely
// so a workspace is tidied from anywhere — the checkout of a project being set
// aside is frequently on another machine, where no directory would answer. What
// `undo` would have carried, saying an archive should never have been written,
// is the optional reason on `restore`, which works everywhere `archive` does.
//
// Because it is not an ending, open work neither blocks the archive nor is
// retired by it. The command says how many units went with the project, and
// restoring brings every one of them back in the state it was left.
//
// The state itself is folded in `paths.ts`, beside the store's other per-
// project state, because the scope resolver and the model enumeration both
// have to exclude the same slugs. Commands layer: the two leaves `main.ts`
// splices into the project verb, and the listing `self project --archived`
// prints.

import { isCurrent } from "@superself/fold";
import { required, Requirement, requireText } from "./args.js";
import { CommandInput, CommandLeaf, leaf } from "./contract.js";
import { buildModel, ProjectModel } from "./model.js";
import { archivedProjects, CliContext, projectArchive, requireRegistered, requireWorkspace } from "./paths.js";
import { makeEvent, recordEvent } from "./pipeline.js";
import { CliError, CommandOutput, ListingBlock } from "./types.js";

const ARCHIVE_USAGE = 'project archive <slug> --why "<why it is being set aside>"';
const RESTORE_USAGE = 'project restore <slug> [--why "<reason>"]';

const ARCHIVE_OPTIONS = { why: { type: "string" } } as const;

// Optional, and the whole of what `undo` would have said: a restore that
// carries a reason is the archive being called a mistake, and one that carries
// none is the project simply being picked back up.
const RESTORE_OPTIONS = { why: { type: "string" } } as const;

// A project is set aside for a reason, and the reason is the whole record: a
// slug missing from every listing with nothing saying why is what archiving
// would otherwise leave behind. Refused by the one gate that names every
// missing option at once, exactly as every other `--why` is.
const ARCHIVE_WHY: Requirement = { flags: ["why"], hint: "why the project is being set aside" };

export const PROJECT_ARCHIVE_LEAF: CommandLeaf =
    leaf("archive", ARCHIVE_OPTIONS, 1, archiveProject, { requires: [ARCHIVE_WHY] });

export const PROJECT_RESTORE_LEAF: CommandLeaf = leaf("restore", RESTORE_OPTIONS, 1, restoreProject);

// A write, and it names the project rather than running in it: a workspace is
// tidied from wherever the person is standing, and the project being set aside
// is frequently one whose checkout is not on this machine at all. The event
// still lands in the named project's own log, which is where its state lives.
// Both verbs answer the same way: what was recorded, and then where the
// workspace's set-aside projects now stand. The listing is the one this module
// already writes for `self project --archived` — composing the two blocks is
// what the shapes are for, and is why neither verb keeps a listing of its own.
function archiveProject({ values, positionals }: CommandInput<typeof ARCHIVE_OPTIONS>): CommandOutput
{
    const ctx = requireWorkspace(process.cwd());
    const slug = requireRegistered(ctx.storeDir, requireText(positionals[0], ARCHIVE_USAGE));
    refuseArchivedAlready(ctx, slug);
    // One fold answers both questions the archive asks of the project: what
    // went with it, and whether the company's own direction would go quiet
    // with it (#287).
    const model = buildModel(ctx.storeDir, slug, new Date());
    refuseWorkspaceDirection(model, slug);
    const open = openUnits(model);
    recordEvent(scopedTo(ctx, slug),
        makeEvent(slug, "project.archived", { project: slug, why: required(values.why) }, undefined, true),
        `archived ${slug}`);
    return [
        {
            kind: "receipt",
            text: `project "${slug}" is archived — ${openLine(open)} went with it, unchanged; `
                + `run \`self project restore ${slug}\` to bring it back`
        },
        archivedListing(ctx.storeDir)
    ];
}

function restoreProject({ values, positionals }: CommandInput<typeof RESTORE_OPTIONS>): CommandOutput
{
    const ctx = requireWorkspace(process.cwd());
    const slug = requireRegistered(ctx.storeDir, requireText(positionals[0], RESTORE_USAGE));
    if (projectArchive(ctx.storeDir, slug) === undefined)
    {
        throw new CliError(`project "${slug}" is not archived, so there is nothing to restore — `
            + `run \`self project --archived\` to list the projects that are`);
    }
    recordEvent(scopedTo(ctx, slug), makeEvent(slug, "project.restored", restorePayload(slug, values.why),
        undefined, true), `restored ${slug}`);
    return [
        { kind: "receipt", text: `project "${slug}" is back — ${openLine(openUnits(buildModel(ctx.storeDir, slug, new Date())))} came back with it, as it was left` },
        archivedListing(ctx.storeDir)
    ];
}

// The reason is left off the payload when it was left off the call, rather than
// written as an empty string: a restoration that says nothing about the archive
// is not the same record as one that calls it a mistake, and a reader of the
// log has to be able to tell them apart. `--why ""` is the first of those, not
// a third — a blank reason states nothing, and recording it would put a record
// in the log that reads as a mistake claim with no claim in it.
function restorePayload(slug: string, why: string | undefined): Record<string, unknown>
{
    return why === undefined || why.trim() === "" ? { project: slug } : { project: slug, why };
}

// The one listing an archived project appears in, with the reason and the day
// it was set aside: a slug missing from everywhere else is only recoverable if
// something still says where it went.
export function archivedListing(storeDir: string): ListingBlock
{
    const rows = archivedProjects(storeDir);
    return {
        kind: "listing",
        rows: rows.length === 0
            ? ["no archived projects — `self project` lists the ones this workspace is working on"]
            // The one way back goes under the row that needs it, and is
            // runnable from where the listing was read — which is the whole
            // reason there is only one. A reason on it says the archive should
            // never have been written.
            : rows.flatMap((row) => [
                `${row.entry.slug} — archived ${row.archive.ts.slice(0, 10)}: ${row.archive.why}`,
                `    self project restore ${row.entry.slug} [--why "<why it should never have been archived>"]`
            ]),
        total: rows.length,
        noun: "archived project"
    };
}

// A second archive is refused rather than recorded twice: the project is
// already where the call wants it, and the only state change left is the way
// back.
function refuseArchivedAlready(ctx: CliContext, slug: string): void
{
    const archive = projectArchive(ctx.storeDir, slug);
    if (archive !== undefined)
    {
        throw new CliError(`project "${slug}" is already archived (${archive.ts.slice(0, 10)}: ${archive.why}) — `
            + `run \`self project restore ${slug}\` to bring it back`);
    }
}

// What went with the project, or came back with it. Open is every unit that has
// not ended: archiving retires nothing, so these are the units whose state the
// restore has to give back untouched. Takes the fold rather than reading one,
// so the archive path folds the project once for this count and the direction
// gate together.
function openUnits(model: ProjectModel): number
{
    return model.works.filter((work) => work.status !== "done" && work.status !== "retired").length;
}

// A workspace-scoped goal or objective is the whole company's direction, read
// from inside every project (#287). Archiving the project whose log holds it
// would take it out of all of them at once, with nothing saying where it went
// — so the archive is refused where the record still stands, and the refusal
// names both ways out. Both run with today's verbs.
//
// Only confirmed direction gates: a proposal is not a direction the company
// has taken, and it occupies no tier until someone confirms it (#240 R3).
function refuseWorkspaceDirection(model: ProjectModel, slug: string): void
{
    const held = model.entities.filter((entity) => (entity.source === "goal" || entity.source === "objective")
        && entity.scope === "workspace" && entity.status === "confirmed" && isCurrent(entity));
    if (held.length === 0)
    {
        return;
    }
    throw new CliError([
        `project "${slug}" holds ${held.length} workspace-scoped record${held.length === 1 ? "" : "s"} — `
            + "archiving it would take the whole workspace's direction out of every project's context:",
        ...held.map((entity) => `  ${entity.id}  [${entity.source}] ${entity.text}`),
        "fold the direction, with the verb its kind takes:",
        '  self goal retract <id> --why "<why it no longer holds>"',
        '  self objective close <id> --as dropped --why "<why it was given up>"',
        "or record it again from a project that stays, then fold the old record here and archive:",
        `  self goal add "<the same statement>" --workspace      (from the other project)`,
        `  self objective add "<the same outcome>" --workspace   (from the other project)`,
        "the restated record gets a new id — lineage does not cross projects, so --supersedes cannot carry it"
    ].join("\n"));
}

function openLine(count: number): string
{
    return `${count} open work unit${count === 1 ? "" : "s"}`;
}

// The event belongs to the named project's log, and the branch stamp belongs to
// the checkout the command was composed in — which is this directory only when
// it is that project's. Archiving one project from inside another's checkout
// would otherwise record that other project's branch on this record.
function scopedTo(ctx: CliContext, slug: string): CliContext
{
    return ctx.project === slug ? ctx : { workspaceDir: ctx.workspaceDir, storeDir: ctx.storeDir };
}
