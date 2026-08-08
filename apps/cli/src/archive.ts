// Setting a project aside, and picking it back up (#283).
//
// Archiving is not retirement. Retirement is an ending — the outcome was given
// up or moved, and the record closes. A project nobody is working on this
// quarter has not ended: it is set aside with its open work exactly as it
// stands, and it comes back whole. So this is a round trip between two states,
// which is why the way back is a verb of its own rather than `undo`. `undo`
// stays what it is — the correction for a record that should never have been
// written — and both apply here, meaning different things.
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

import { required, Requirement, requireText } from "./args.js";
import { CommandInput, CommandLeaf, leaf } from "./contract.js";
import { buildModel } from "./model.js";
import { archivedProjects, CliContext, projectArchive, requireRegistered, requireWorkspace } from "./paths.js";
import { makeEvent, recordEvent } from "./pipeline.js";
import { CliError, SelfEvent } from "./types.js";

const ARCHIVE_USAGE = 'project archive <slug> --why "<why it is being set aside>"';
const RESTORE_USAGE = "project restore <slug>";

const ARCHIVE_OPTIONS = { why: { type: "string" } } as const;

// A project is set aside for a reason, and the reason is the whole record: a
// slug missing from every listing with nothing saying why is what archiving
// would otherwise leave behind. Refused by the one gate that names every
// missing option at once, exactly as every other `--why` is.
const ARCHIVE_WHY: Requirement = { flags: ["why"], hint: "why the project is being set aside" };

export const PROJECT_ARCHIVE_LEAF: CommandLeaf =
    leaf("archive", ARCHIVE_OPTIONS, 1, archiveProject, { requires: [ARCHIVE_WHY] });

export const PROJECT_RESTORE_LEAF: CommandLeaf = leaf("restore", {}, 1, restoreProject);

// A write, and it names the project rather than running in it: a workspace is
// tidied from wherever the person is standing, and the project being set aside
// is frequently one whose checkout is not on this machine at all. The event
// still lands in the named project's own log, which is where its state lives.
function archiveProject({ values, positionals }: CommandInput<typeof ARCHIVE_OPTIONS>): void
{
    const ctx = requireWorkspace(process.cwd());
    const slug = requireRegistered(ctx.storeDir, requireText(positionals[0], ARCHIVE_USAGE));
    refuseArchivedAlready(ctx, slug);
    const open = openUnits(ctx, slug);
    recordEvent(scopedTo(ctx, slug),
        makeEvent(slug, "project.archived", { project: slug, why: required(values.why) }, undefined, true),
        `archived ${slug}`);
    console.log(`project "${slug}" is archived — ${openLine(open)} went with it, unchanged; `
        + `run \`self project restore ${slug}\` to bring it back`);
}

function restoreProject({ positionals }: CommandInput<Record<string, never>>): void
{
    const ctx = requireWorkspace(process.cwd());
    const slug = requireRegistered(ctx.storeDir, requireText(positionals[0], RESTORE_USAGE));
    if (projectArchive(ctx.storeDir, slug) === undefined)
    {
        throw new CliError(`project "${slug}" is not archived, so there is nothing to restore — `
            + `run \`self project --archived\` to list the projects that are`);
    }
    recordEvent(scopedTo(ctx, slug), makeEvent(slug, "project.restored", { project: slug }, undefined, true),
        `restored ${slug}`);
    console.log(`project "${slug}" is back — ${openLine(openUnits(ctx, slug))} came back with it, as it was left`);
}

// Undo is not restore (#283). Restore ends an archive that was right; this
// takes back one that should never have been written, and the archive record
// stops standing at all. Both leave the project active, which is exactly why
// the log has to say which of the two happened.
export function undoArchive(ctx: CliContext, event: SelfEvent, why: string): void
{
    recordEvent(ctx, makeEvent(event.project, "project.restored", { project: event.project, why },
        { annuls: event.id }, true), `withdrew the archive of ${event.project}`);
    console.log(`project "${event.project}" is standing again — its archive record was taken back`);
}

// The one listing an archived project appears in, with the reason and the day
// it was set aside: a slug missing from everywhere else is only recoverable if
// something still says where it went.
export function printArchivedProjects(storeDir: string): void
{
    const rows = archivedProjects(storeDir);
    if (rows.length === 0)
    {
        console.log("no archived projects — `self project` lists the ones this workspace is working on");
        return;
    }
    for (const row of rows)
    {
        console.log(`${row.entry.slug} — archived ${row.archive.ts.slice(0, 10)}: ${row.archive.why}`);
        // Both ways back, under the row that needs them: the archive is ended by
        // `restore`, and taken back by `undo` — which needs the event id this
        // listing is the only place to read it from.
        console.log(`    self project restore ${row.entry.slug}`
            + `, or self undo ${row.archive.event} --why w if it should never have been archived`);
    }
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
// restore has to give back untouched.
function openUnits(ctx: CliContext, slug: string): number
{
    return buildModel(ctx.storeDir, slug, new Date())
        .works.filter((work) => work.status !== "done" && work.status !== "retired").length;
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
