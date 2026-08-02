// Manifest in, bundle out. Everything that can move between two compiles is
// pinned before a source is read, every selector resolves to exactly one record
// or refuses, and every string that would reach the bundle is screened for what
// must not be published. Nothing here appends an event or writes state: this
// subsystem reads the store and produces a file.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { git } from "../gitutil.js";
import { eventSummary, readEvents } from "../logfile.js";
import { projectStateDir, readRegistry, resolveProjectPath } from "../paths.js";
import { resolveSha, sha256File } from "../repo.js";
import { CliError, SelfEvent } from "../types.js";
import { Canonical, compareCodepoints, digestOf } from "./canonical.js";
import { Exclusion, GitPin, Manifest, MANIFEST_FORMAT, SelfPin, requireSelfPin } from "./manifest.js";

export const BUNDLE_FORMAT = "self.evidence.bundle@1";
export const BUNDLE_FORMATS = [BUNDLE_FORMAT];

// The compiler contract, not the CLI release. Two builds that implement
// bundle@1 must produce the same bytes for the same inputs, so a version string
// that moved every release would make that claim untestable.
export const COMPILER = { name: "self", version: "1" };

export interface Source
{
    ref: string;
    kind: string;
    sha256: string;
    record: Canonical;
}

export interface Fact
{
    [key: string]: string;
    ref: string;
    statement: string;
    ts: string;
    type: string;
}

export interface Bundle
{
    [key: string]: Canonical;
}

export interface CompileInput
{
    storeDir: string;
    manifest: Manifest;
    from: string;
}

export function compileBundle(input: CompileInput): Bundle
{
    const pin = requireSelfPin(input.manifest);
    const events = pinnedEvents(input.storeDir, input.manifest.project, pin);
    // The reasons for withholding are published beside the evidence, so they
    // pass the same screen the evidence does — an exclusion that named a path
    // or a secret would leak exactly what excluding it was meant to prevent.
    screen(exclusionRecords(input.manifest.exclude), "exclusions", input.manifest.profile);
    return assemble(input.manifest, pin, events.length, resolveSources(input, events));
}

// Selection and screening, without the pin gate in front of them. `verify`
// enters here on purpose: a bundle whose source events were rewritten fails its
// log pin too, and stopping at the pin would name the store instead of naming
// the source that changed.
export function resolveSources(input: CompileInput, events: SelfEvent[]): Source[]
{
    const sources = selectSources(input, events);
    for (const source of sources)
    {
        screen(source.record, `sources[${source.ref}]`, input.manifest.profile);
    }
    return sources;
}

/* ── pins ──────────────────────────────────────────────────────────── */

// Both halves of the self pin, because either alone can be satisfied by a log
// that is not the pinned one: a rewritten history keeps its head id while its
// bytes change, and two stores can hold the same bytes under different heads.
function pinnedEvents(storeDir: string, slug: string, pin: SelfPin): SelfEvent[]
{
    requireRegistered(storeDir, slug);
    const events = readEvents(storeDir, slug);
    const head = events[events.length - 1]?.id;
    if (head !== pin.head)
    {
        throw new CliError(`the log head of "${slug}" is ${head ?? "nothing — the log is empty"}, and the manifest pins ${pin.head} — the store moved since the manifest was pinned`);
    }
    const found = logDigest(storeDir, slug);
    if (found !== pin.logSha256)
    {
        throw new CliError(`the log of "${slug}" hashes to ${found ?? "nothing — the log is missing"}, and the manifest pins ${pin.logSha256} — the same head id over different bytes means history was rewritten`);
    }
    return events;
}

export function logDigest(storeDir: string, slug: string): string | null
{
    return sha256File(join(projectStateDir(storeDir, slug), "log.jsonl"));
}

export function logHead(storeDir: string, slug: string): string | undefined
{
    const events = readEvents(storeDir, slug);
    return events[events.length - 1]?.id;
}

function requireRegistered(storeDir: string, slug: string): void
{
    if (!readRegistry(storeDir).some((entry) => entry.slug === slug))
    {
        const known = readRegistry(storeDir).map((entry) => entry.slug).join(", ");
        throw new CliError(`the manifest names project "${slug}", which this workspace does not hold — registered: ${known === "" ? "none" : known}`);
    }
}

// A pinned repository is a registered project's checkout on this machine, and
// the commit is resolved there: a pin that names bytes this machine cannot
// produce is refused rather than carried into the bundle unverified.
export function requireRepoDir(storeDir: string, repo: string, from: string): string
{
    const dir = resolveProjectPath(storeDir, repo, from);
    if (dir === null || !existsSync(dir))
    {
        throw new CliError(`repository "${repo}" has no checkout on this machine — register or link it before pinning a commit from it`);
    }
    return dir;
}

export function requireCommitAt(dir: string, pin: GitPin): string
{
    const resolved = resolveSha(dir, pin.commit);
    if (resolved === null)
    {
        throw new CliError(`commit ${pin.commit} does not resolve in repository "${pin.repo}" — the pinned history is not in this checkout`);
    }
    return resolved;
}

/* ── selection ─────────────────────────────────────────────────────── */

// Two selector shapes and no third: an event selector names one recorded event,
// a subject selector names a work unit or a milestone and takes its whole event
// stream. Both refuse zero matches and ambiguity by different messages, because
// "nothing matched" and "several matched" are different mistakes.
function selectSources(input: CompileInput, events: SelfEvent[]): Source[]
{
    const excluded = new Set(input.manifest.exclude.map((item) => item.ref));
    const select = input.manifest.select;
    const sources = [
        ...select.decisions.map((id) => eventSource(events, "decision", id, input.manifest.project)),
        ...select.reports.map((id) => eventSource(events, "report", id, input.manifest.project)),
        ...select.work.map((id) => subjectSource(events, "work", "work", id, input.manifest.project)),
        ...select.milestones.map((id) => subjectSource(events, "milestone", "milestone", id, input.manifest.project)),
        ...select.commits.map((pin) => commitSource(input, pin))
    ];
    requireOneRowPerRef(sources);
    requireExclusionsUsed(input.manifest.exclude, sources);
    return sources
        .filter((source) => !excluded.has(source.ref))
        .sort((left, right) => order(left.kind, right.kind) || order(left.ref, right.ref));
}

// Two selectors that resolve to one record are two claims about one thing. The
// contract is that every source is named outright, so the second naming is a
// mistake to state rather than a row to duplicate — and a bundle with two rows
// for one ref cannot be reconciled against its own selection.
function requireOneRowPerRef(sources: Source[]): void
{
    const seen = new Set<string>();
    for (const source of sources)
    {
        if (seen.has(source.ref))
        {
            throw new CliError(`the manifest selects ${source.ref} more than once — name each source exactly once, so the bundle carries one row for it`);
        }
        seen.add(source.ref);
    }
}

// An exclusion nobody applied is a stale line in a reviewed document: the
// operator believes something is being held back that was never selected.
function requireExclusionsUsed(exclusions: Exclusion[], sources: Source[]): void
{
    const refs = new Set(sources.map((source) => source.ref));
    const stale = exclusions.find((item) => !refs.has(item.ref));
    if (stale !== undefined)
    {
        throw new CliError(`the manifest excludes "${stale.ref}", which this selection never included — remove the exclusion or select what it withholds`);
    }
}

function eventSource(events: SelfEvent[], kind: string, selector: string, slug: string): Source
{
    const matches = events.filter((event) => event.type.startsWith(`${kind}.`) && event.id.startsWith(selector));
    const event = only(matches.map((match) => match.id), kind, selector, slug);
    const record = normalize(events.find((item) => item.id === event) as SelfEvent, kind);
    return { ref: event, kind, sha256: digestOf(record), record };
}

// A work unit is not one event: what it set out to do and every transition it
// made are separate lines, and a bundle that cited only the first would be
// citing the intent rather than what happened. Its reports stay a selector of
// their own — a report is evidence in its own right, cited or not cited on
// purpose rather than swept in with the unit.
function subjectSource(events: SelfEvent[], kind: string, field: string, selector: string, slug: string): Source
{
    const owned = events.filter((event) => event.type.startsWith(`${kind}.`));
    const ids = [...new Set(owned.map((event) => event.payload[field]).filter((id): id is string => typeof id === "string"))];
    const id = only(ids.filter((known) => known.startsWith(selector)), kind, selector, slug);
    const stream = owned.filter((event) => event.payload[field] === id).map((event) => normalize(event, kind));
    const record: Canonical = { events: stream, id, kind };
    return { ref: id, kind, sha256: digestOf(record), record };
}

function only(matches: string[], kind: string, selector: string, slug: string): string
{
    if (matches.length === 0)
    {
        throw new CliError(`no ${kind} in project "${slug}" matches the selector "${selector}" — every source is named outright, so a selector that finds nothing refuses`);
    }
    if (matches.length > 1)
    {
        throw new CliError(`the ${kind} selector "${selector}" matches ${matches.length} records (${matches.join(", ")}) — name the one this bundle cites`);
    }
    return matches[0];
}

/* ── commits ───────────────────────────────────────────────────────── */

// The fields a commit contributes, read with the reader's git config held out
// of the way: a signature block or a locale would otherwise change the bytes
// without changing the commit.
function commitSource(input: CompileInput, pin: GitPin): Source
{
    const dir = requireRepoDir(input.storeDir, pin.repo, input.from);
    const commit = requireCommitAt(dir, pin);
    const shown = git(dir, "-c", "log.showSignature=false", "show", "-s", "--format=%H%n%T%n%P%n%aI%n%s", commit);
    if (!shown.ok)
    {
        throw new CliError(`commit ${pin.commit} could not be read in repository "${pin.repo}" — ${shown.err}`);
    }
    const lines = shown.out.split("\n");
    const record: Canonical = {
        commit: lines[0],
        parents: (lines[2] ?? "").split(" ").filter((parent) => parent !== ""),
        repo: pin.repo,
        subject: lines.slice(4).join(" "),
        tree: lines[1],
        ts: lines[3]
    };
    return { ref: `${pin.repo}@${commit}`, kind: "commit", sha256: digestOf(record), record };
}

/* ── the research profile ──────────────────────────────────────────── */

// What a record may carry, per kind. The shape of a record is declared here
// rather than copied from the event, and the operator-authored maps — payload
// and refs — are checked key by key: a key nobody put on this list is content
// no reviewer of this profile has ever seen, and it refuses rather than being
// dropped, so the disclosure decision stays with a person.
//
// A key is on exactly one of two lists. `published` reaches the bundle;
// `excluded` is a field this profile deliberately drops, named here so the
// decision is visible rather than implied by absence. A key on neither list is
// content no reviewer of this profile has seen, and that is what refuses.
//
// The work list is the whole `work.*` payload surface the CLI emits today —
// created, started, blocked, unblocked, done, retired, required,
// requirement-revised, requirement-retired, covered, rechecked,
// approval-required, approved, policy-declared, linked, unlinked, accepted —
// because one unlisted key refuses the unit's entire event stream.
interface ProfileFields
{
    published: string[];
    excluded: string[];
}

const RESEARCH_PAYLOAD: Record<string, ProfileFields> = {
    decision: { published: ["text", "why"], excluded: [] },
    report: { published: ["text", "next", "notes", "evidenceTyped"], excluded: [] },
    work: {
        published: ["work", "outcome", "on", "why", "successor", "successorProject", "requirement", "text",
            "requirementRevision", "report", "by", "freshReview", "model", "objective", "milestone", "proposal"],
        // The typed challenge and the terminal it was typed at prove the
        // mechanism of an approval, not what was approved. The approval itself
        // stays — `by` and the event that carries it are the claim.
        excluded: ["confirmation"]
    },
    milestone: {
        published: ["milestone", "objective", "outcome", "exit", "target", "after", "supersedes", "criterion", "why"],
        excluded: []
    }
};

// `refs` is a closed type declared in types.ts, so an unlisted key here is not
// unreviewed content — it is a field this profile does not cite, and the two
// left out say where a command ran rather than what was decided. Adding a ref
// is a code change that comes past this list, which is why refs is projected
// where payload, whose keys a caller composes, is refused.
const CITED_REFS = ["work", "commits", "confirms", "supersedes", "after", "blocks"];

function normalize(event: SelfEvent, kind: string): Canonical
{
    const record: Record<string, Canonical> = {
        confirmed: event.origin.confirmed,
        id: event.id,
        payload: allowed(event.payload, RESEARCH_PAYLOAD[kind], `${event.id}.payload`, kind),
        ts: event.ts,
        type: event.type
    };
    const refs = cited(event.refs as Record<string, unknown> | undefined);
    if (Object.keys(refs).length > 0)
    {
        record.refs = refs;
    }
    return record;
}

function cited(refs: Record<string, unknown> | undefined): Record<string, Canonical>
{
    const kept: Record<string, Canonical> = {};
    for (const field of CITED_REFS)
    {
        if (refs !== undefined && refs[field] !== undefined)
        {
            kept[field] = refs[field] as Canonical;
        }
    }
    return kept;
}

function allowed(map: Record<string, unknown>, fields: ProfileFields | undefined, at: string, kind: string): Canonical
{
    const published = fields?.published ?? [];
    const excluded = fields?.excluded ?? [];
    const kept: Record<string, Canonical> = {};
    for (const [key, value] of Object.entries(map))
    {
        if (!published.includes(key) && !excluded.includes(key))
        {
            throw new CliError(`the research profile does not carry ${at}.${key} — a ${kind} record may hold ${published.join(", ")}, and a field the profile never declared is refused rather than dropped`);
        }
        if (published.includes(key))
        {
            kept[key] = value as Canonical;
        }
    }
    return kept;
}

/* ── disclosure screen ─────────────────────────────────────────────── */

// The event guard already refused what must never reach the log. This is the
// second, publication-facing screen over what leaves the store: a value that is
// safe to sync between a person's own machines is not automatically safe to
// hand an editor. It refuses and never rewrites — a redacted bundle would read
// as complete evidence while holding a hole nobody declared.

// The store's own id grammar, taken out before anything judges entropy. A
// decision cited by two joined event ids is the shape the log itself mints, and
// reading it as key material is the false positive #133 records.
const STORE_ULID = "[0-9abcdefghjkmnpqrstvwxyz]{26}";
const STORE_SHORT = "[a-z]{1,4}-[0-9abcdefghjkmnpqrstvwxyz]{5}";
const STORE_IDS = new RegExp(`(?:[A-Za-z][A-Za-z0-9]*-)?(?:${STORE_ULID}|${STORE_SHORT})(?:-(?:${STORE_ULID}|${STORE_SHORT}))*`, "g");
const OBJECT_NAMES = /\b(?:[0-9a-f]{40}|[0-9a-f]{64})\b/g;

const VENDOR_SECRET = /sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const ASSIGNED_SECRET = /\b(?:api[_-]?key|secret|token|password|passwd|access[_-]?key|client[_-]?secret)\b\s*[:=]\s*\S{6,}/i;
const HIGH_ENTROPY = /[A-Za-z0-9+/_=-]{32,}/g;
// What makes a path worth refusing is its root, not the fact that it has
// slashes in it. The sources of this profile are decisions and reports about
// code work, so `apps/cli/src/evidence/compile.ts` and `2026/08/01` are the
// ordinary content it exists to carry, and a rule that refused any two-slash
// run would refuse the normal case.
//
// So the rule is anchored on the roots a filesystem actually has. It matches
// wherever it sits in the value — `output:/Users/x` and `at/Users/x` name the
// same machine a bare path does — and `file://` is included, because that
// scheme is a local location by definition. Web URLs are taken out first: they
// carry a path that resolves for every reader, which is the opposite of what
// this is about.
// The root list stays short and stays spelled the way a filesystem spells it.
// Every name added to it is also a directory somebody could have in a
// repository — `src/dev/`, `packages/media/`, `app/system/` — and because the
// rule deliberately matches after a word character, it cannot tell those from
// `at/dev/null`. So the list holds the roots that name a machine or a person
// and nothing more speculative.
const ROOTS = "Users|home|private|var|tmp|etc|opt|Volumes";
const WEB_URL = /\bhttps?:\/\/\S*/g;
// `~name/` as well as `~/`: the first spelling is a path that names someone who
// is not even the person holding the clone.
const ABSOLUTE_PATH = new RegExp(`file://|~[A-Za-z0-9._-]*/[A-Za-z0-9._+-]|/(?:${ROOTS})/[A-Za-z0-9._+-]|[A-Za-z]:\\\\|\\\\\\\\[A-Za-z0-9._-]+\\\\`);

// A slash written as anything but U+002F still reads as a path to a person and
// still names the machine, so the lookalikes are folded before the rule runs
// rather than left as a way around it.
const SLASH_LOOKALIKES = /[⁄∕／⧸]/g;

export function screen(value: Canonical, at: string, profile: string): void
{
    if (typeof value === "string")
    {
        screenText(value, at, profile);
        return;
    }
    if (Array.isArray(value))
    {
        value.forEach((item, index) => screen(item, `${at}[${index}]`, profile));
        return;
    }
    if (value === null || typeof value !== "object")
    {
        return;
    }
    for (const [key, child] of Object.entries(value))
    {
        screen(child, `${at}.${key}`, profile);
    }
}

// The field path, never the value: a refusal is printed, logged by whatever
// wrapped the command, and read over a shoulder.
function screenText(text: string, at: string, profile: string): void
{
    if (ABSOLUTE_PATH.test(text.replace(SLASH_LOOKALIKES, "/").replace(WEB_URL, " ")))
    {
        throw new CliError(`${at} holds an absolute filesystem path — it names the machine that produced it and resolves to nothing for a reader, so the ${profile} profile refuses it`);
    }
    const rule = credentialRule(withoutStoreIds(text));
    if (rule !== null)
    {
        throw new CliError(`${at} holds a value shaped like a credential (rule ${rule}) — the ${profile} profile refuses it rather than publishing it redacted`);
    }
}

function withoutStoreIds(text: string): string
{
    return text.replace(STORE_IDS, " ").replace(OBJECT_NAMES, " ");
}

function credentialRule(text: string): string | null
{
    if (VENDOR_SECRET.test(text))
    {
        return "vendor-prefix";
    }
    if (ASSIGNED_SECRET.test(text))
    {
        return "named-assignment";
    }
    return mixedCaseRun(text) ? "high-entropy" : null;
}

// A long unbroken run is only key material when it mixes the classes a word
// never mixes. A sentence, a slug, and a hyphenated identifier all fail this,
// which is what keeps the screen from refusing the prose a bundle exists for.
function mixedCaseRun(text: string): boolean
{
    return (text.match(HIGH_ENTROPY) ?? []).some((run) =>
        /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run));
}

/* ── assembly ──────────────────────────────────────────────────────── */

function assemble(manifest: Manifest, pin: SelfPin, eventCount: number, sources: Source[]): Bundle
{
    const pinned = manifestRecord(manifest, pin);
    const bundle: Bundle = {
        digest: "",
        exclusions: exclusionRecords(manifest.exclude),
        facts: factsOf(sources),
        format: BUNDLE_FORMAT,
        manifest: { manifestSha256: digestOf(pinned), pinned },
        pins: { eventCount, git: gitPins(manifest), self: { head: pin.head, logSha256: pin.logSha256 } },
        profile: manifest.profile,
        provenance: {
            compiledFrom: { gitCommits: gitPins(manifest), selfHead: pin.head },
            compiler: { name: COMPILER.name, version: COMPILER.version }
        },
        sources: sources.map((source) => ({ kind: source.kind, record: source.record, ref: source.ref, sha256: source.sha256 }))
    };
    // The digest covers the bundle with its own field emptied, which is what
    // lets one file carry both the content and the check over it.
    bundle.digest = digestOf(bundle);
    return bundle;
}

export function digestWithout(bundle: Bundle): string
{
    return digestOf({ ...bundle, digest: "" });
}

function manifestRecord(manifest: Manifest, pin: SelfPin): Canonical
{
    return {
        exclude: exclusionRecords(manifest.exclude),
        format: MANIFEST_FORMAT,
        pins: { git: commitPins(manifest.pins.git), self: { head: pin.head, logSha256: pin.logSha256 } },
        profile: manifest.profile,
        project: manifest.project,
        select: {
            commits: commitPins(manifest.select.commits),
            decisions: [...manifest.select.decisions].sort(order),
            milestones: [...manifest.select.milestones].sort(order),
            reports: [...manifest.select.reports].sort(order),
            work: [...manifest.select.work].sort(order)
        }
    };
}

// Every list in a bundle carries a stated order, so two manifests that name the
// same sources in a different sequence still compile to the same bytes.
function exclusionRecords(exclusions: Exclusion[]): Canonical
{
    return [...exclusions]
        .map((item) => ({ ref: item.ref, why: item.why }))
        .sort((left, right) => order(left.ref, right.ref) || order(left.why, right.why));
}

function commitPins(pins: GitPin[]): Canonical
{
    return [...pins]
        .map((item) => ({ commit: item.commit, repo: item.repo }))
        .sort((left, right) => order(left.repo, right.repo) || order(left.commit, right.commit));
}

function gitPins(manifest: Manifest): Canonical
{
    return commitPins(manifest.pins.git);
}

// One fact per recorded event, in the order a reader follows time. A commit
// contributes its own line, so a timeline built from a bundle needs nothing but
// the bundle.
export function factsOf(sources: Source[]): Fact[]
{
    const facts: Fact[] = [];
    for (const source of sources)
    {
        const record = source.record as Record<string, Canonical>;
        if (source.kind === "commit")
        {
            facts.push({ ref: source.ref, statement: String(record.subject), ts: String(record.ts), type: "commit" });
            continue;
        }
        const events = (Array.isArray(record.events) ? record.events : [record]) as Record<string, Canonical>[];
        facts.push(...events.map((event) => factOf(event)));
    }
    return facts.sort((left, right) => order(left.ts, right.ts) || order(left.ref, right.ref) || order(left.type, right.type));
}

// The refs a carried record is entitled to put in the timeline: a commit speaks
// under its own ref, an event under its id, and a work unit or milestone under
// the ids of the events it carries. A fact naming anything else is a claim the
// bundle no longer holds the source for.
export function factRefsOf(record: Record<string, Canonical>, kind: string, ref: string): string[]
{
    if (kind === "commit")
    {
        return [ref];
    }
    const events = Array.isArray(record.events) ? record.events : [record];
    return events.map((event) => String((event as Record<string, Canonical>).id));
}

function factOf(event: Record<string, Canonical>): Fact
{
    const payload = event.payload as Record<string, unknown>;
    const statement = eventSummary({ payload } as SelfEvent);
    return { ref: String(event.id), statement, ts: String(event.ts), type: String(event.type) };
}

// Codepoint order is the bundle's stated order, and it is the serializer's own
// comparison rather than a second one beside it: `<` compares UTF-16 code
// units, which orders an astral id differently from the way the keys above it
// are sorted.
function order(left: string, right: string): number
{
    return compareCodepoints(left, right);
}

/* ── --pin ─────────────────────────────────────────────────────────── */

// The convenience that keeps determinism honest: pinning is a separate step
// that writes a manifest, so a compile can never quietly pin itself to whatever
// the store happened to hold at the moment it ran.
export function pinnedManifest(input: CompileInput): Canonical
{
    const head = logHead(input.storeDir, input.manifest.project);
    const digest = logDigest(input.storeDir, input.manifest.project);
    if (head === undefined || digest === null)
    {
        throw new CliError(`project "${input.manifest.project}" has no recorded log to pin — record state before compiling evidence from it`);
    }
    const manifest = input.manifest;
    const pins = manifest.pins.git.map((pin) => ({
        commit: requireCommitAt(requireRepoDir(input.storeDir, pin.repo, input.from), pin),
        repo: pin.repo
    }));
    return manifestRecord({ ...manifest, pins: { self: { head, logSha256: digest }, git: pins } }, { head, logSha256: digest });
}
