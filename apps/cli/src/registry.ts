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
import { ArtifactKind, ARTIFACT_KINDS, ArtifactMeta, PrunedMark, SelfEvent } from "./types.js";

// Which event put a record in the registry. What may remove its bytes turns on
// it (#239): a report's evidence answers to the work unit it was reported on, a
// review's to the unit the review named, and bytes registered on their own
// answer to whichever records point at them. A link (#407) answers to nothing,
// because it put no bytes here at all.
type ArtifactSource = "report" | "review" | "registered" | "link";

export interface ArtifactRecord extends ArtifactMeta
{
    project: string;
    work?: string;
    ts: string;
    summary: string;
    source: ArtifactSource;
    // The event that declared it. What `self undo` takes back, so the refusal
    // that sends a person there can name the line to type (#407).
    event: string;
    // What the artifact is, where its author said (#407).
    kind?: ArtifactKind;
    // The milestone `--for` attached it to. A work unit is named by `work`
    // above, which is `refs.work` and was already the true link.
    milestone?: string;
}

// A record whose bytes this store holds, as against a link. Every reader that
// resolves a path, counts bytes or reuses them asks this first — and asks it
// of the type, so the compiler carries the distinction rather than a comment.
export type StoredArtifact = ArtifactRecord & { path: string };

export function holdsBytes(record: ArtifactRecord): record is StoredArtifact
{
    return record.path !== undefined;
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
        const withdrawn = withdrawnLinks(events);
        for (const event of events.filter((item) => !withdrawn.has(item.id)))
        {
            records.push(...declaredArtifacts(event)
                .map((meta) => declaredRecord(meta, slug, event, pruned.get(meta.id))));
        }
    }
    return records;
}

// The link events `self undo` took back (#407). A link is the one artifact an
// undo can erase outright: its record is the whole of it, so annulling the
// event leaves nothing behind and the registry answers as though it was never
// written.
//
// Links only, and never a registration or a report's evidence. Those put bytes
// under `artifacts/`, the bytes stay after an undo — nothing here deletes — and
// dropping their rows would make `self store size` report them as orphaned and
// `artifact open` unable to reach them.
function withdrawnLinks(events: SelfEvent[]): Set<string>
{
    const linked = new Set(events.filter((event) => event.type === "artifact.linked").map((event) => event.id));
    return new Set(events.map((event) => event.refs?.annuls)
        .filter((id): id is string => id !== undefined && linked.has(id)));
}

function declaredRecord(meta: ArtifactMeta, slug: string, event: SelfEvent, pruned: PrunedMark | undefined): ArtifactRecord
{
    const record: ArtifactRecord = {
        ...meta,
        project: slug,
        work: event.refs?.work,
        ts: event.ts,
        summary: summaryOf(event),
        source: sourceOf(event),
        event: event.id,
        kind: declaredKind(event),
        milestone: declaredMilestone(event)
    };
    if (pruned !== undefined)
    {
        record.pruned = pruned;
    }
    return record;
}

// Read back against the list this CLI writes, so a value another version — or
// a hand edit — put there does not reach a render as a kind this one honours.
function declaredKind(event: SelfEvent): ArtifactKind | undefined
{
    const kind = event.payload.kind;
    return ARTIFACT_KINDS.find((known) => known === kind);
}

// A milestone attachment, which rides on the payload because `EventRefs` has
// no field for an entity that is not a work unit. Prefixed rather than typed:
// the id shape is what says which record `--for` named.
function declaredMilestone(event: SelfEvent): string | undefined
{
    const entity = event.payload.entity;
    return typeof entity === "string" && entity.startsWith("m-") ? entity : undefined;
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
    // A link is one artifact and says so in the singular, the way a review
    // receipt does. A CLI that predates links names neither type here and
    // returns nothing for one, which is how an older reader stays correct
    // about a store this one wrote: it shows no row rather than a wrong one.
    if ((event.type === "review.received" || event.type === "artifact.linked") && event.payload.artifact !== undefined)
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
    const named: Record<string, ArtifactSource> = {
        "review.received": "review",
        "artifact.registered": "registered",
        "artifact.linked": "link"
    };
    return named[event.type] ?? "report";
}

function summaryOf(event: { type: string; payload: Record<string, unknown> }): string
{
    if (event.type === "review.received")
    {
        return `${event.payload.scope} review ${event.payload.verdict} for ${event.payload.changeSet}`;
    }
    // A registration has no report text to summarize; `--why` is what its
    // author said about it, and "registered" is the honest answer when they
    // said nothing. A link is the same statement about an address.
    if (event.type === "artifact.registered")
    {
        return String(event.payload.why ?? "registered");
    }
    if (event.type === "artifact.linked")
    {
        return String(event.payload.why ?? "linked");
    }
    return String(event.payload.text ?? "");
}
