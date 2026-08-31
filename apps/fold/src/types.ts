// The event vocabulary, and the entity shapes an event names. Every consumer
// of the fold — this CLI, and the Workspace API server that folds the same log
// — reads a record's shape from here, so neither can drift into folding a
// field the other never wrote.
//
// This module imports nothing. That is what lets a wire type be read without
// dragging a machine's filesystem in behind it.

interface Origin
{
    actor: "agent" | "human";
    session?: string;
    confirmed: boolean;
}

export interface EventRefs
{
    confirms?: string;
    supersedes?: string[];
    // The event an annulment takes back. Naming the event rather than
    // asserting a new state is what lets a withdrawal stay terminal against
    // everything written in ignorance of it: an undo cannot have been written
    // without seeing what it reverses.
    //
    // This ref, not the event type, is what the fold keys on (#390): an older
    // log's `entity.restored` and this CLI's `entity.annulled` carry the same
    // meaning here, so both fold identically and no log is migrated.
    annuls?: string;
    // The append this event was written in, stamped only where the append held
    // more than one event (#390). Log adjacency cannot serve instead — a union
    // merge of two clones interleaves lines, so contiguity is not a fact about
    // an append — and an undo needs the boundary to take back everything one
    // state change wrote. Absent means an event of its own.
    batch?: string;
    work?: string;
    // Git revisions in the project repo, and nothing else. Free-form evidence
    // is recorded as `payload.notes`, because everything listed here is handed
    // to git and judged by whether it still resolves.
    commits?: string[];
    artifacts?: string[];
    // The runner attempt this event came out of. What makes a report
    // idempotent: an attempt that ran twice finds its own report already here.
    attempt?: string;
    // The branch the command ran on. History ("this happened here"), never a
    // live pointer: branches get renamed, deleted, and reused.
    branch?: string;
    // The repository the commits were reported from, by identity — the commit
    // its history starts from, as `repositoryIdentity` derives it. A project
    // that spans more than one repository judges a hash in the one that knows
    // it, and this says which one the report meant when two do (#331).
    repository?: string;
    // The work units a proposed decision gates. Stated by `decide --blocks`,
    // never inferred, and inverted by the fold so a unit names what stands in
    // front of it without having to be started first.
    blocks?: string[];
    // The event this decision is sequenced behind: it cannot be decided until
    // that one settles. Sequencing only — it neither confirms nor supersedes.
    after?: string;
    // The confirmed decision a `decide retract` withdraws, and the proposal a
    // `decide decline` turns down. Withdrawal without a successor: neither ref
    // names a replacement, which is exactly what tells them from `supersedes`.
    retracts?: string;
    declines?: string;
    // The decisions a design report says it implements (#316). A ref rather
    // than payload text because these are record ids that have to resolve: the
    // gate reads them back and refuses a design whose decision stopped holding.
    implements?: string[];
    // The `report.added` events whose friction a swept proposal was built from
    // (#381). A ref for the same reason `implements` is one: these are record
    // ids a reader follows back to the reports that made the case, not payload
    // text. It is also the dedupe key that survives the text drifting — a
    // cluster whose evidence an open proposal already cites has been asked
    // about, whatever sentence that proposal ended up carrying.
    friction?: string[];
    // On a paired demotion (#202): the record the demotion makes room for.
    // The confirm surface reads it back, so a cap-driven pair is one
    // confirmable unit rather than two halves that can deadlock.
    admits?: string;
}

export interface SelfEvent
{
    id: string;
    ts: string;
    type: string;
    origin: Origin;
    project: string;
    payload: Record<string, unknown>;
    refs?: EventRefs;
}

// One regular file copied out of a bundle's tree, named by its path relative
// to that tree's root. `generated` marks the index this CLI wrote when the
// directory carried no front door of its own: it is a member like any other —
// stored, digested, counted — and this is what says no reporter wrote it.
export interface ArtifactMember
{
    path: string;
    digest: string;
    generated?: true;
}

// What an artifact may be labelled as (#407): the four things a work unit's
// plan points at. Declared here because the verb that writes one and the
// registry that reads one back must not disagree about the list.
export const ARTIFACT_KINDS = ["brief", "pr", "resource", "doc"] as const;

export type ArtifactKind = typeof ARTIFACT_KINDS[number];

export interface ArtifactMeta
{
    id: string;
    // For a link, its URL: a name is the display string every surface already
    // prints, and the address is what a reader identifies a link by.
    name: string;
    // Where the bytes are, relative to the store. Present exactly when this
    // store holds bytes for the artifact, which is what makes it the
    // discriminator every byte-counting reader already asks for: a link (#407)
    // carries `url` instead and the two are never both set.
    path?: string;
    // The address a link points at, http or https, recorded as it was typed
    // and never fetched. Present exactly when `path` is not.
    url?: string;
    // sha256 of the bytes as they were ingested. Optional: artifacts attached
    // before digests were recorded verify by existence alone, and folding an
    // existing store must not invent a digest for them. A bundle carries none
    // at all — its hash is derived from the manifest where something needs it,
    // because a stored field could contradict the manifest and a derived one
    // cannot.
    digest?: string;
    // Present exactly when this artifact's bytes are a directory tree, which
    // is what makes the manifest its own discriminator: no event written
    // before bundles needs a field it does not carry, and no migration is
    // written. Sorted by the members' UTF-8 bytes.
    members?: ArtifactMember[];
    // The one member a person is meant to open.
    entry?: string;
    // Derived, never recorded (#239). An `artifact.pruned` event marks the
    // record it names wherever that record is read, and every reader answers
    // from the mark rather than from whether the file is still on the disk:
    // two records can share one stored path, so bytes outliving the record
    // that was pruned is an ordinary state and not a reason to open it.
    pruned?: PrunedMark;
}

// Why an artifact's bytes were removed, and when. The record itself is never
// removed — a `done` claim that rests on it stays auditable — so this is what
// a reader is told in place of the file.
export interface PrunedMark
{
    ts: string;
    why?: string;
}

/* ── what a machine decided about the evidence ────────────────── */

// What became of a work unit's recorded commits, as the machine holding the
// project repository judged them:
// settled: reachable from the default branch — the work landed.
// provisional: reachable, but not from the default branch — it is on a branch.
// abandoned: the branch is gone and the commits never landed.
// unknown: unreachable, and nothing says why.
// unverifiable: the hash resolves to nothing.
//
// The verdicts are decided against git on one machine and never travel with the
// log, so the fold takes them as an argument rather than reading them: the
// overlay is where they enter, and the log-determined layer never sees them.
export type Verdict = "settled" | "provisional" | "abandoned" | "unknown" | "unverifiable";
