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
import { ArtifactMeta } from "./types.js";

export interface ArtifactRecord extends ArtifactMeta
{
    project: string;
    work?: string;
    ts: string;
    summary: string;
}

// What the log says this store holds. The store's own size is answered from it
// — which stored paths a live record names is the difference between artifact
// bytes and orphaned ones — and so is every artifact read.
export function listArtifacts(storeDir: string, slugs: string[]): ArtifactRecord[]
{
    const records: ArtifactRecord[] = [];
    for (const slug of slugs)
    {
        for (const event of readEvents(storeDir, slug))
        {
            for (const meta of declaredArtifacts(event))
            {
                records.push({
                    ...meta,
                    project: slug,
                    work: event.refs?.work,
                    ts: event.ts,
                    summary: summaryOf(event)
                });
            }
        }
    }
    return records;
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
