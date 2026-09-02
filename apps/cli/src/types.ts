// What the CLI adds to the record vocabulary: the refusal it raises, the
// machine-readable half of one, and the shapes a command answers in. The
// records themselves — the event, its refs, the artifact it names — are
// declared in `@superself/fold`, because the fold and this CLI must read one
// declaration, and are re-exported here so every module still asks one place
// what a record looks like.
import { ArtifactMeta } from "@superself/fold";

export { ARTIFACT_KINDS, ArtifactKind, ArtifactMember, ArtifactMeta, EventRefs, PrunedMark, SelfEvent } from "@superself/fold";

// One row per artifact, everywhere (#362). A bundle states what it holds where
// a single file states its name, and every surface that prints an artifact
// reads this rather than deciding for itself what a directory looks like.
export function artifactName(meta: ArtifactMeta): string
{
    return countedName(meta.name, meta.members?.length);
}

// The same row from the manifest's size alone, for the one reader that has the
// size without the manifest: the HTML summary a workspace page is drawn from
// carries how many members a bundle holds rather than which, because a page
// showing four artifacts must not write four thousand member digests into a
// file every fold rewrites. One row, one spelling, whichever half asks for it.
export function countedName(name: string, files: number | undefined): string
{
    return files === undefined ? name : `${name}/ (${files} file${files === 1 ? "" : "s"})`;
}

// Encoded a segment at a time, so the separators survive and everything else
// does not: `encodeURI` leaves `#` and `?` alone, and a member named `a#b.txt`
// linked through it sends the reader to the directory with a fragment rather
// than to the file (#362 review round 2).
export function encodedPath(path: string): string
{
    return path.split("/").map(encodeURIComponent).join("/");
}

// What a query is matched against. A member path joins the haystack because
// the manifest is the machine-readable answer to what a bundle holds; a hit on
// one still shows the bundle's row, since a member has no id of its own.
export function artifactSearchText(meta: ArtifactMeta): string
{
    return [meta.name, ...(meta.members ?? []).map((member) => member.path)].join(" ");
}

export interface RegistryEntry
{
    slug: string;
    path?: string;
    description?: string;
    added: string;
    // The workspace server's own id for this project, where the store keeps its
    // records on one. Cached the moment the project is created there, and read
    // for one question: whether a slug the server does not know is one this
    // machine has never registered, or one that was deleted from another
    // machine (`registrycache.ts`). Absent in a git-backed store, which has no
    // server to have an id on.
    id?: string;
}

/* ── the machine-readable half of a refusal ────────────────────────── */

// What a `--json` run may carry. Declared here because both the payload block
// and the error envelope are made of it, and this layer imports nothing.
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// The one authoritative `--json` error envelope, field for field (design
// §2.6). Every optional field is **omitted** rather than sent as null, and a
// field may be added only by adding a line here — a plugin cannot introduce
// one of its own, which is what lets one schema validate every command's
// errors.
export interface ErrorFields
{
    // Server free text, the only in-band guidance an error carries.
    hint?: string;
    // Synthesized by the CLI from the profile's console base; omitted, never
    // guessed, when there is no base to build it from.
    console_url?: string;
    // On an exit 3 that has a pace the server declared.
    retry_after_s?: number;
    // On an exit 3 from a command that carries a call key, so the retry is the
    // same call rather than a second charge.
    idempotency_key?: string;
    request_id?: string;
    rule_hits?: JsonValue;
    refusals?: JsonValue;
    review_id?: string;
    min_version?: string;
    // The CLI-attached sub-cause on `login_required`. The server sends no such
    // field; it is how one exit-1 code stays branchable.
    reason?: string;
    // What an answer that is not a workspace API response was instead, and
    // where the request went to get it (#434). The body is deliberately not
    // among them: a refusal describes a 404 page, it never pastes one. `host`
    // travels alone on an unreachable server, which has a place but no answer.
    status?: number;
    content_type?: string;
    bytes?: number;
    host?: string;
    path?: string;
}

// The exit vocabulary of design §11, and the whole of it:
//   0 ok · 1 error · 2 refused by policy · 3 pending and retryable
//
// Every command that predates this declaration constructs neither 2 nor 3, so
// its exit behaviour is unchanged — `runCli` assigns `error.exit`, which
// defaults to 1.
type ExitCode = 1 | 2 | 3;

// A refusal, with the machine half beside the sentence. Everything written
// before this change constructs it with a message alone and behaves exactly as
// it did: no code, no fields, exit 1.
export class CliError extends Error
{
    readonly exit: ExitCode;
    readonly code?: string;
    readonly fields: ErrorFields;

    constructor(message: string, code?: string, fields: ErrorFields = {}, exit: ExitCode = 1)
    {
        super(message);
        this.exit = exit;
        this.code = code;
        this.fields = fields;
    }
}

// Exit 1 — something is wrong that retrying will not fix by itself.
export function fail(code: string, message: string, fields: ErrorFields = {}): CliError
{
    return new CliError(message, code, fields, 1);
}

// Exit 2 — refused by policy. The answer will not change, so an agent must
// never retry it.
export function refuse(code: string, message: string, fields: ErrorFields = {}): CliError
{
    return new CliError(message, code, fields, 2);
}

// Exit 3 — not finished, and not the caller's fault. The identical call,
// retried after `retry_after_s`, is the right next move.
export function pending(code: string, message: string, fields: ErrorFields = {}): CliError
{
    return new CliError(message, code, fields, 3);
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

// One render of a page, deferred until the gate knows whether this run is for
// a person or for a pipe. A thunk rather than the lines themselves because the
// two renders are not two formattings of one text: the piped context runs a
// token budget over its rows and the terminal one draws ruled tables, so
// composing both would do the whole of the work that is about to be thrown
// away — and the terminal render measures the terminal, which is the one
// question a piped run must never ask.
type Render = () => string[];

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
    // The same pair as a document's, for the one listing that draws a table
    // when a person is looking at it. Omitted means the rows are the answer in
    // both renders, which is what every other listing wants.
    pretty?: Render;
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

// A page a render composes — the markdown a `show` verb prints, the context an
// agent reads. The gate does not lay it out; it picks the render this run gets
// and puts those lines on stdout.
//
// `pretty` is optional, and omitting it is a statement rather than an
// oversight: a page with one render — a `show` page, the setup diagnostics —
// reads the same to a person as to a pipe, and saying so here is what keeps
// the handler from asking which run it is in.
interface DocumentBlock
{
    kind: "document";
    plain: Render;
    pretty?: Render;
}

// The machine shape a leaf promises, with the human renders beside it. A leaf
// that carries one of these is a leaf that has a `--json` contract, and that
// equivalence is load-bearing in two directions: an explicit `--json` on a leaf
// without one is refused by name rather than answered with a shape the command
// never promised, and `SUPERSELF_JSON=1` — an ambient preference an agent
// exports once for a whole session — is simply ignored there, so one export
// cannot break a command that predates the flag.
//
// Under `--json` the gate prints `data` and nothing else. Otherwise it calls
// exactly one of the thunks, like every other block.
export interface PayloadBlock
{
    kind: "payload";
    data: JsonValue;
    plain: Render;
    pretty?: Render;
}

export type OutputBlock = ValueBlock | ReceiptBlock | ListingBlock | DocumentBlock | PayloadBlock;

export type CommandOutput = OutputBlock[];
