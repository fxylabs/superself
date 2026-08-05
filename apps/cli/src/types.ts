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
    // The destructive event an `entity.restored` takes back. Naming the event
    // rather than asserting a new state is what lets a withdrawal stay
    // terminal against everything written in ignorance of it: an undo cannot
    // have been written without seeing what it reverses.
    annuls?: string;
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

export interface ArtifactMeta
{
    id: string;
    name: string;
    path: string;
    // sha256 of the bytes as they were ingested. Optional: artifacts attached
    // before digests were recorded verify by existence alone, and folding an
    // existing store must not invent a digest for them.
    digest?: string;
}

export interface RegistryEntry
{
    slug: string;
    path?: string;
    description?: string;
    added: string;
}

export class CliError extends Error
{
}
