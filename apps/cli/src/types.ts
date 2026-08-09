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

/* ── what a command answers with ───────────────────────────────────── */

// A recovery pointer a render prints, rather than any string that happens to
// look like one. The brand is what a section builder asks for, so a bare
// `"self work"` handed to `listSection` is a type error at the call site
// instead of a defect a proof has to go looking for afterwards. Concatenation
// is refused for the same reason: a pointer with something appended is a
// `string`, so the form that reached a render unscoped cannot compile.
//
// The declaration lives here because the shapes below name it and this layer
// imports nothing. The mints stay in `pretty.ts`, which re-exports the type:
// what makes a pointer safe is the finite command list its constructors take,
// and moving the declaration does not move that.
declare const POINTER: unique symbol;

export type Pointer = string & { readonly [POINTER]: true };

// One scalar answer, printed as itself: `self lang` says `ko` and nothing
// around it, because a caller reads that line as a value.
interface ValueBlock
{
    kind: "value";
    text: string;
}

// What a write recorded, in the caller's terms, and — where the write leaves
// something obvious to do next — the command that does it. The pointer is a
// `Pointer` rather than a string so it cannot reach a reader unscoped.
interface ReceiptBlock
{
    kind: "receipt";
    text: string;
    next?: Pointer;
}

// Rows a reader scans, and how much there is of what they are scanning. The
// size is required because a listing that prints rows and never says how many
// things they are is the defect the type exists to make unwritable — `self
// project` printed 33 slugs and said 33 nowhere.
export interface ListingBlock
{
    kind: "listing";
    rows: string[];
    // How many things the listing is about, which is not how many lines it
    // takes: a row can carry a nested checkpoint under it, a way back under it,
    // or a bucket the listing does not show. Counted from the collection the
    // rows were built from, never from `rows.length`.
    total: number;
    // What is being counted, singular, and its plural where an `s` is the wrong
    // one. The gate writes the size line from these, so every listing in the
    // CLI states its size in the same words.
    noun: string;
    nouns?: string;
    // Set only where the rows are a window onto a longer list: how many of
    // `total` they show, and the command that prints the whole thing. The two
    // travel together because either alone is the defect — a count with no way
    // to reach the rest, or a way back that never says what is missing.
    window?: { shown: number; recover: Pointer };
}

// A page a render already composed — the markdown a `show` verb prints. The
// gate does not lay it out; it puts it on stdout.
interface DocumentBlock
{
    kind: "document";
    lines: string[];
}

export type OutputBlock = ValueBlock | ReceiptBlock | ListingBlock | DocumentBlock;

export type CommandOutput = OutputBlock[];
