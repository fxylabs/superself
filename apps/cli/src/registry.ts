// The derived artifact registry: what the log says this store holds. Not the
// project registry — that is `paths.ts` `readRegistry`, which answers which
// projects exist. This one answers which artifacts they carry.
//
// It sits in its own module because two sides of the tree need it and they
// must not meet. `artifact.ts` ingests bytes and owns the artifact verbs, and
// `self artifact add` records an event, so that module reaches `pipeline.ts`
// and through it `fold.ts`. The fold's own reachability check needs to look an
// artifact id up. Reading it out of `artifact.ts` would close the first import
// cycle this tree has ever had; reading it out of here closes none, because
// this module imports the log reader and the shared types and nothing else.
import { readEvents } from "./logfile.js";
import { ArtifactMeta, PrunedMark, SelfEvent } from "./types.js";

// Which event put a record in the registry. What may remove its bytes turns on
// it (#239): a report's evidence answers to the work unit it was reported on, a
// review's to the unit the review named, and bytes registered on their own
// answer to whichever records point at them.
type ArtifactSource = "report" | "review" | "registered";

export interface ArtifactRecord extends ArtifactMeta
{
    project: string;
    work?: string;
    ts: string;
    summary: string;
    source: ArtifactSource;
}

// What the log says this store holds. The store's own size is answered from it
// — which stored paths a live record names is the difference between artifact
// bytes and orphaned ones — and so is every artifact read.
//
// One pass over the log carries both halves: what was declared, and what was
// later pruned. A removal is an event like any other, so a record's own reading
// says it was pruned wherever the record is read.
export function listArtifacts(storeDir: string, slugs: string[]): ArtifactRecord[]
{
    const records: ArtifactRecord[] = [];
    for (const slug of slugs)
    {
        const events = readEvents(storeDir, slug);
        const pruned = prunedMarks(events);
        for (const event of events)
        {
            records.push(...declaredArtifacts(event)
                .map((meta) => declaredRecord(meta, slug, event, pruned.get(meta.id))));
        }
    }
    return records;
}

function declaredRecord(meta: ArtifactMeta, slug: string, event: SelfEvent, pruned: PrunedMark | undefined): ArtifactRecord
{
    const record: ArtifactRecord = {
        ...meta,
        project: slug,
        work: event.refs?.work,
        ts: event.ts,
        summary: summaryOf(event),
        source: sourceOf(event)
    };
    if (pruned !== undefined)
    {
        record.pruned = pruned;
    }
    return record;
}

// The first removal of an id is the one that happened: a second `artifact
// prune` on the same id is refused, so two marks reach here only from a log
// edited by hand or written by another version, and the earlier one is what
// every other reader already answered with.
function prunedMarks(events: SelfEvent[]): Map<string, PrunedMark>
{
    const marks = new Map<string, PrunedMark>();
    for (const event of events.filter((item) => item.type === "artifact.pruned"))
    {
        const id = String(event.payload.artifact ?? "");
        if (id !== "" && !marks.has(id))
        {
            marks.set(id, event.payload.why === undefined
                ? { ts: event.ts }
                : { ts: event.ts, why: String(event.payload.why) });
        }
    }
    return marks;
}

// The ids a record names, resolved against one project's own log. Nothing is
// read when nothing is asked for: an entity referencing no artifact must not
// make a fold read the log a second time, and that is the ordinary case.
//
// One slug, never the whole registry: an entity's reference is refused at
// write time unless the artifact belongs to the project recording it, so the
// owning project is always the one asking.
export function artifactMetas(storeDir: string, slug: string, ids: string[]): Map<string, ArtifactMeta>
{
    const wanted = new Set(ids);
    const found = new Map<string, ArtifactMeta>();
    if (wanted.size === 0)
    {
        return found;
    }
    for (const record of listArtifacts(storeDir, [slug]))
    {
        if (wanted.has(record.id) && !found.has(record.id))
        {
            found.set(record.id, record);
        }
    }
    return found;
}

// Bytes reach the store through a report, through a review receipt, or through
// a registration standing on its own (#238), and the registry is derived from
// whichever event named them: a record that only one surface could find would
// be a record nobody can audit.
function declaredArtifacts(event: { type: string; payload: Record<string, unknown> }): ArtifactMeta[]
{
    if ((event.type === "report.added" || event.type === "artifact.registered") && Array.isArray(event.payload.artifacts))
    {
        return event.payload.artifacts as ArtifactMeta[];
    }
    if (event.type === "review.received" && event.payload.artifact !== undefined)
    {
        return [event.payload.artifact as ArtifactMeta];
    }
    return [];
}

// The same three doors, named on the record so a reader downstream does not
// have to re-derive which one it came through. `artifact prune` is the reader:
// what leans on an artifact's bytes is a different thing for each (#239).
function sourceOf(event: { type: string }): ArtifactSource
{
    if (event.type === "review.received")
    {
        return "review";
    }
    return event.type === "artifact.registered" ? "registered" : "report";
}

function summaryOf(event: { type: string; payload: Record<string, unknown> }): string
{
    if (event.type === "review.received")
    {
        return `${event.payload.scope} review ${event.payload.verdict} for ${event.payload.changeSet}`;
    }
    // A registration has no report text to summarize; `--why` is what its
    // author said about it, and "registered" is the honest answer when they
    // said nothing.
    if (event.type === "artifact.registered")
    {
        return String(event.payload.why ?? "registered");
    }
    return String(event.payload.text ?? "");
}
