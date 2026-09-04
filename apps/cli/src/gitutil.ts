import { spawnSync, SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns, StdioOptions } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serverBacked } from "./mode.js";
import { jsonMode, notice } from "./output.js";
import { CliError, fail } from "./types.js";

// ── the one place git is spawned ─────────────────────────────────────────
//
// Every git this CLI runs comes through `runGit`, and every one of them is
// bounded. Unbounded, a single git could stop the CLI forever: anything git
// starts — a hook, a credential helper, an ssh control master — inherits
// git's stdout and stderr, and a synchronous spawn reads those pipes until
// they close, not until git is reaped. So a hook that backgrounds a process
// and returns leaves the CLI waiting on a git that exited minutes ago (#367).
// A network verb has a second way to wait forever, a credential prompt
// written straight to the terminal, which the environment below closes off.

// A local git command that has not answered in half a minute is not stuck
// behind work, it is stuck. Two kinds of call are the exception and get the
// patient bound instead: one bounded by someone's network rather than by this
// machine — a first clone over a weak link legitimately runs for minutes — and
// a repack of the whole history, which is a maintenance verb a person runs
// deliberately and waits on.
const LOCAL_DEADLINE_MS = 30_000;
const PATIENT_DEADLINE_MS = 300_000;

interface GitOptions
{
    input?: string;
    maxBuffer?: number;
    patient?: boolean;
}

interface GitResult
{
    ok: boolean;
    out: string;
    err: string;
}

// One knob, and it only tightens: the suite has to prove the bound holds
// without spending half a minute per case, and nothing should be able to talk
// the CLI into waiting longer than the deadlines above.
function deadline(base: number): number
{
    const asked = Number(process.env.SUPERSELF_GIT_TIMEOUT_MS);
    return Number.isFinite(asked) && asked > 0 ? Math.min(asked, base) : base;
}

// Nobody is at a keyboard, so nothing git starts may go looking for one. A
// credential helper or ssh asking for a passphrase writes to /dev/tty, which
// no redirection of this process's own stdin can close — the only thing that
// stops it is telling git and ssh not to ask.
function gitEnv(): NodeJS.ProcessEnv
{
    if (process.stdin.isTTY === true)
    {
        return process.env;
    }
    return {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        SSH_ASKPASS: "",
        GIT_SSH_COMMAND: `${process.env.GIT_SSH_COMMAND ?? "ssh"} -o BatchMode=yes`
    };
}

// stdin is closed rather than piped wherever nothing is being fed in: no git
// this CLI runs reads a person's typing, and an open pipe is one more handle a
// child can hold. Where a batch probe does feed git, stdin has to stay a pipe
// — an "ignore" in slot zero silently discards `input` — and node closes it as
// soon as the bytes are written, so it is held no longer either way. stdout
// and stderr stay pipes because the sentences the CLI shows on a failure are
// git's own.
function spawnOptions(cwd: string, limit: number, options: GitOptions): SpawnSyncOptionsWithStringEncoding
{
    const stdio: StdioOptions = [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"];
    return {
        cwd,
        encoding: "utf8",
        timeout: limit,
        killSignal: "SIGKILL",
        stdio,
        env: gitEnv(),
        ...(options.input === undefined ? {} : { input: options.input }),
        ...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer })
    };
}

// The deadline passing means two different things, and only one of them is a
// failure. Where git had already exited on its own — the hook case, where what
// the CLI was still waiting on was a pipe a grandchild holds open — git's exit
// status is there and everything git wrote has been read, so that answer is
// the true one and the run continues on it. Where git had to be killed,
// nothing is known about what it did, and guessing is how a half-finished
// write gets reported as a finished one. Either way the waiting has stopped,
// which is the whole of what #367 asked for.
export function runGit(cwd: string, args: string[], options: GitOptions = {}): SpawnSyncReturns<string>
{
    const limit = deadline(options.patient === true ? PATIENT_DEADLINE_MS : LOCAL_DEADLINE_MS);
    const started = Date.now();
    const result = spawnSync("git", args, spawnOptions(cwd, limit, options));
    if (neverFinished(result) && result.status === null)
    {
        throw cutShort(cwd, args, limit, Date.now() - started, result);
    }
    return result;
}

// Two ways git can fail to reach an exit of its own: this CLI's deadline, which
// arrives as ETIMEDOUT, and a signal from somewhere else — an out-of-memory
// kill, an operator. A spawn that never ran at all, no git on the machine, is
// neither and stays the ordinary failure it has always been. So is a run that
// overran its output buffer: node kills that one too, but with its own errno,
// and the batch probes have always degraded to "unanswerable" there rather
// than refusing the command.
function neverFinished(result: SpawnSyncReturns<string>): boolean
{
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    return code === "ETIMEDOUT" || (code === undefined && result.signal !== null);
}

// The one sentence a git that never finished produces. It names the command,
// where it ran and how long it lasted, because the fix is never inside this
// CLI: it is a hook, a credential helper, a remote that never answered, or
// whatever else on the machine ended the process.
function cutShort(cwd: string, args: string[], limit: number, elapsed: number, result: SpawnSyncReturns<string>): CliError
{
    const where = `git ${args.join(" ")} in ${cwd}`;
    if (result.error === undefined)
    {
        return fail("git_killed", `${where} was killed by ${result.signal} after ${seconds(elapsed)}s`);
    }
    return fail("git_timeout", `${where} was killed after ${seconds(elapsed)}s — it passed the ${seconds(limit)}s limit; ` +
        "a git hook, a credential helper or an unreachable remote is holding it");
}

function seconds(ms: number): string
{
    return (ms / 1000).toFixed(1);
}

export function git(cwd: string, ...args: string[]): GitResult
{
    return answered(runGit(cwd, args));
}

// A verb that legitimately runs for minutes — one that talks to a remote, or
// repacks the whole store — and so gets the patient deadline rather than the
// tight local one. Every other call in the CLI takes `git` above.
export function gitPatient(cwd: string, ...args: string[]): GitResult
{
    return answered(runGit(cwd, args, { patient: true }));
}

function answered(result: SpawnSyncReturns<string>): GitResult
{
    return {
        ok: result.status === 0,
        out: (result.stdout ?? "").trim(),
        err: (result.stderr ?? "").trim()
    };
}

export function configureStoreIdentity(storeDir: string): void
{
    git(storeDir, "config", "user.name", "superself");
    git(storeDir, "config", "user.email", "self@superself.local");
}

export function ensureWorkspaceRepo(storeDir: string): void
{
    if (existsSync(join(storeDir, ".git")))
    {
        return;
    }
    git(storeDir, "init", "-q");
    configureStoreIdentity(storeDir);
}

// Each step of the store commit answers for itself. All three used to be
// dropped on the floor, so a store that could not record what the command had
// just written still reported the write as done — a stale ident, a rejecting
// pre-commit hook or a lock left by a killed git all read as success (#367).
function mustGit(cwd: string, doing: string, ...args: string[]): string
{
    const result = git(cwd, ...args);
    if (!result.ok)
    {
        throw gitFailed(cwd, doing, result);
    }
    return result.out;
}

// The refusal a failed step raises, in one place because the lock-losing path
// below raises the very same one for every failure that is not the lock: two
// spellings of "committing the workspace store failed" would be two contracts.
function gitFailed(cwd: string, doing: string, result: GitResult): CliError
{
    return new CliError(`${doing} in ${cwd} failed: ${result.err === "" ? "git could not be run" : result.err}`);
}

// A second session writing into the same store is the one failure of `add` or
// `commit` that is nobody's mistake, and git's own advice for it — remove the
// file manually — would destroy that session's write (#444). It is recognised
// by the lock's path, not by the exit status, which git shares with every
// other fatal, and not by the sentence around it, which git translates.
function lockedOut(result: GitResult): boolean
{
    return result.err.includes("index.lock");
}

// Long enough that the neighbour's commit — which holds the index for the
// length of one `git commit` — is usually done, short enough that a person
// waits out no perceptible pause when it is not. One retry and no more: a loop
// would be the write coordination decision 01kz57aqsxym2g2g8wasp6vv7j ruled
// out, arrived at from underneath.
const LOCK_RETRY_MS = 300;

// The synchronous sleep, as in `human.ts`: nothing can wake this array, so the
// timeout is the whole story. `spawnSync` runs git, so there is no loop turn to
// await on and nothing else in this process to yield to.
const LOCK_PAUSE = new Int32Array(new SharedArrayBuffer(4));

// One step of the store commit that needs git's index, tried twice. False means
// the lock was held both times and this commit is not happening; every other
// failure is raised exactly as it always was.
function tookTheIndex(storeDir: string, doing: string, args: string[]): boolean
{
    for (const attempt of [0, 1])
    {
        const result = git(storeDir, ...args);
        if (result.ok)
        {
            return true;
        }
        if (!lockedOut(result))
        {
            throw gitFailed(storeDir, doing, result);
        }
        if (attempt === 0)
        {
            Atomics.wait(LOCK_PAUSE, 0, 0, LOCK_RETRY_MS);
        }
    }
    return false;
}

// What the reader is told instead of git's advice. The events are already in
// `log.jsonl` and the next session to commit sweeps them in — several events
// per commit is what decision 01kz57aqsxym2g2g8wasp6vv7j accepts — so this is
// a statement about when the record is committed, not a failure.
//
// Silent on a machine surface, for the reason `pipeline.ts` is: a line of
// prose on stdout ahead of the envelope is an agent's parse error rather than
// a notice, and the agent already has its receipt.
function lockHeldElsewhere(): void
{
    if (jsonMode())
    {
        return;
    }
    notice("the store is being written by another session; this event is recorded "
        + "and will be committed with the next write");
}

// Nothing to do where the store keeps no git history. The nine callers are
// unchanged and say what they always said — "the store has changed, record
// that" — and a server-backed store records it by queueing the append rather
// than by committing, which has already happened by the time this is reached.
// Deciding here rather than at each call is what stops a caller added later
// from being the one that forgot — and the same is true of the lock: the
// notice is said here, so no caller can be the one that lets git's advice
// through.
export function commitAll(storeDir: string, message: string): void
{
    if (serverBacked(storeDir))
    {
        return;
    }
    if (!tookTheIndex(storeDir, "staging the workspace store", ["add", "-A"]))
    {
        lockHeldElsewhere();
        return;
    }
    if (mustGit(storeDir, "reading the workspace store status", "status", "--porcelain") === "")
    {
        return;
    }
    if (!tookTheIndex(storeDir, "committing the workspace store", ["commit", "-qm", message]))
    {
        lockHeldElsewhere();
    }
}

interface ClassifiedEvidence
{
    commits: string[];
    notes: string[];
}

// Only hex can be a Git object name, so only hex is ever offered to git —
// prose evidence never reaches it. Length stays wide on purpose: git resolves
// an abbreviation of four characters, and a repository using the sha256 object
// format names objects with sixty-four.
const HEX = /^[0-9a-fA-F]{4,64}$/;

// `commit:` and `note:` settle the type outright, for the cases the repository
// cannot: a revision recorded from a machine without the project checkout, and
// a value that happens to resolve but was never meant as a hash.
const DECLARED = /^(commit|note):([\s\S]*)$/;

// Shape alone cannot tell a build number from an abbreviated hash — "20260727"
// is as plausible a date as it is a Git object name, and a file digest is hex
// from end to end. So shape only decides what is worth asking about, and the
// repository decides the rest: a candidate it resolves is a revision, and one
// it does not is descriptive evidence, kept and shown but never resolved again.
// That is what stops a ticket id from being reported later as a rewritten
// history, and what keeps an uppercase or four-character revision — both of
// which git resolves — from being quietly demoted to a note.
// Undeclared evidence is whatever the repository says it is. A revision is
// recorded in the spelling git names objects with: an uppercase spelling is
// user input for the same object, and one spelling per object keeps one verdict
// per object — and keeps the event guard's sha exemption reading it as the sha
// it is.
function classifyUndeclared(projectDir: string, value: string, into: ClassifiedEvidence): void
{
    if (resolvesInRepo(projectDir, value))
    {
        into.commits.push(value.toLowerCase());
        return;
    }
    into.notes.push(value);
}

export function classifyEvidence(projectDir: string, offered: string[]): ClassifiedEvidence
{
    const classified: ClassifiedEvidence = { commits: [], notes: [] };
    for (const value of offered)
    {
        const declared = DECLARED.exec(value);
        if (declared === null)
        {
            classifyUndeclared(projectDir, value, classified);
        }
        else if (declared[1] === "commit")
        {
            classified.commits.push(requireRevision(declared[2]));
        }
        else
        {
            classified.notes.push(declared[2]);
        }
    }
    return classified;
}

// The same probe reachability's classifier asks: existence as a commit, in
// the checkout the report was recorded from.
function resolvesInRepo(projectDir: string, value: string): boolean
{
    return HEX.test(value) && git(projectDir, "cat-file", "-e", `${value}^{commit}`).ok;
}

// How a surface words the refusal when the value it took is not an object
// name. The guard decides; the surface says what to do instead, because the
// remedy differs: the report verb and the attempt envelope declare a type, so
// `note:` is a form they read, while `work met` and `milestone met` take a
// bare object name and have no typed form at all. A shared refusal sent those
// two to a spelling they reject, which only produced a worse error (#132).
type RevisionRefusal = (typed: string) => string;

const typedEvidence: RevisionRefusal = (typed) =>
    `evidence "commit:${typed}" is not a Git object name — record free-form evidence as "note:${typed}"`;

// The refusal for a surface whose `--evidence` is a bare object name, naming
// the verb the user actually ran and the one surface that does take prose.
export function bareRevisionRefusal(verb: string): RevisionRefusal
{
    return (typed) => `--evidence "${typed}" is not a Git object name — \`self ${verb}\` names a commit; ` +
        `free-form evidence is recorded on a report, as \`--evidence "note:${typed}"\``;
}

// The one revision guard: a declared commit ref is hex of a length git can
// resolve — the same width `HEX` states above — or it is not a Git object
// name, and it is recorded lowercased so one object has one spelling. Every
// entry point that takes a typed or declared commit ref goes through this —
// the report verb through `classifyEvidence` above, the attempt gate with the
// refs an envelope declared, `work met --evidence`, `milestone met
// --evidence` (#132), and the evidence-bundle manifest's commit pins through
// `requireCommit` (#145). A second, laxer reading of the same question is what let
// prose reach `refs.commits` and be reported later as a rewritten history.
export function requireRevision(value: string, refusal: RevisionRefusal = typedEvidence): string
{
    if (!HEX.test(value))
    {
        throw new CliError(refusal(value));
    }
    return value.toLowerCase();
}

// 12 hex chars: short hashes recorded as evidence must stay unambiguous as
// the project repo grows.
export function headCommit(dir: string): string | null
{
    const result = git(dir, "rev-parse", "--short=12", "HEAD");
    return result.ok ? result.out : null;
}

const commons = new Map<string, string | null>();

// The git directory every working tree of one repository shares, or `null`
// where the path is not inside a repository at all. Two linked paths with one
// answer here are one repository, and this is the cheap way to know it — a
// `rev-parse`, not the history walk an identity costs — so it is what the
// repositories a project's evidence is judged across are deduplicated by
// (#331). Memoized: resolution asks about the same paths on every command.
export function commonDir(dir: string): string | null
{
    if (!commons.has(dir))
    {
        commons.set(dir, gitCommonDir(dir));
    }
    return commons.get(dir) ?? null;
}

function gitCommonDir(dir: string): string | null
{
    const result = git(dir, "rev-parse", "--path-format=absolute", "--git-common-dir");
    return result.ok ? realPath(result.out) : null;
}

// Scope resolution asks about the same directories repeatedly, and a one-shot
// CLI process never sees a worktree appear underneath it. Probe each once.
const tops = new Map<string, string | null>();

// The working tree a directory sits in — its identity as a checkout, since
// every linked worktree of one repository keeps its own top level.
export function topOf(dir: string): string | null
{
    if (!tops.has(dir))
    {
        const result = git(dir, "rev-parse", "--show-toplevel");
        tops.set(dir, result.ok ? realPath(result.out) : null);
    }
    return tops.get(dir) ?? null;
}

const real = new Map<string, string>();

// Paths reach the store through `resolve`, which keeps symlinks, while git
// answers with the resolved path: comparing the two needs both in the same
// form. Memoized with the probes below — resolution normalizes the same
// handful of paths once per registered project.
export function realPath(path: string): string
{
    if (!real.has(path))
    {
        real.set(path, existsSync(path) ? realpathSync(path) : path);
    }
    return real.get(path) ?? path;
}

const identities = new Map<string, string | null>();

// What a repository is, told apart from where it sits. A path outlives the
// checkout that was linked at it — a checkout is deleted and a new repository
// is created at the same path — and every other question this module answers
// about a linked path is about the path (#115).
//
// The commit HEAD's first-parent chain starts from is the identity: every
// working tree of one repository answers the same, a later merge of an
// unrelated history cannot rename it, and two unrelated repositories never
// collide. A repository with no commits yet has no identity to record, and
// says so rather than offering one that would change under it.
export function repositoryIdentity(dir: string): string | null
{
    if (!identities.has(dir))
    {
        const result = git(dir, "rev-list", "--max-parents=0", "--first-parent", "HEAD");
        identities.set(dir, result.ok && result.out !== "" ? result.out.split("\n").pop() ?? null : null);
    }
    return identities.get(dir) ?? null;
}

const worktrees = new Map<string, string[]>();

// The top level of every working tree of this repository, in a single probe.
// Two checkouts of one repository are the case `self project init` must not
// treat as a new project, and the case scope resolution answers from: this
// list says which of the paths the store knows are checkouts of the
// repository the command is standing in.
export function checkoutTops(dir: string): string[]
{
    if (!worktrees.has(dir))
    {
        const listed = git(dir, "worktree", "list", "--porcelain");
        worktrees.set(dir, !listed.ok ? [] : listed.out
            .split("\n")
            .filter((line) => line.startsWith("worktree "))
            .map((line) => realPath(line.slice("worktree ".length))));
    }
    return worktrees.get(dir) ?? [];
}

// Every probe above answers "what is on disk at this path", and each memoizes
// because one command asks the same handful of paths over and over. The bound
// on that memory is one invocation, not one process: a caller that runs `self`
// twice can create a repository between the two calls, and the second call must
// not answer from what the first found. `runCli` calls this on entry, which is
// the only place that knows one invocation has ended and another begun.
export function resetProbes(): void
{
    commons.clear();
    tops.clear();
    real.clear();
    identities.clear();
    worktrees.clear();
}

// A detached HEAD reports the literal "HEAD"; record nothing rather than a
// name that points at no branch.
export function currentBranch(dir: string): string | null
{
    const result = git(dir, "rev-parse", "--abbrev-ref", "HEAD");
    return result.ok && result.out !== "" && result.out !== "HEAD" ? result.out : null;
}

// ── batch probes ─────────────────────────────────────────────────────────
// Everything below asks one question about a whole set of commits in a single
// git process. Before them, verifying evidence spawned four or five gits per
// hash per project, sequentially: a workspace holding 350 recorded commits
// spent minutes of wall time at 1% CPU waiting on them (#128).
//
// Each batch is a synchronous call, so the child is started, drained and
// reaped before the function returns. That is deliberate rather than a
// streaming `--batch-check` kept open across the fold: this CLI is
// synchronous, and a long-lived child would have to be torn down on every
// path a fold can throw from. One process per repository is the bound the
// design asks for; owning its whole lifetime inside one call is how it is
// kept without a zombie on an exception.
//
// Every batch answers `null` when git could not be asked — a broken
// repository, or output that does not line up with the input. The caller
// leaves the stored verdicts untouched there, because a batch that could not
// answer must never be read as "nothing resolves".

// The output of one probe is bounded by the repository's history, not by the
// caller, so the pipe is given room a default 1 MB buffer would not have. A
// repository large enough to overrun even this reports as unanswerable.
const BATCH_BUFFER = 64 * 1024 * 1024;

function batch(cwd: string, args: string[], input: string): string | null
{
    const result = runGit(cwd, args, { input, maxBuffer: BATCH_BUFFER });
    if (result.error !== undefined || result.status !== 0)
    {
        return null;
    }
    return result.stdout ?? "";
}

function lines(out: string): string[]
{
    return out.split("\n").filter((line) => line !== "");
}

// Which of `values` name a commit in this repository, and the object each one
// resolves to. Only hex is offered to git, exactly as `classifyEvidence`
// decides above: prose never reaches a probe. `cat-file --batch-check` writes
// one line per input line — an object name, or the input echoed back with
// `missing`/`ambiguous` — so the answers are matched to the questions by
// position, which is the only thing the protocol guarantees.
export function resolveCommits(dir: string, values: string[]): Map<string, string> | null
{
    const askable = values.filter((value) => HEX.test(value));
    if (askable.length === 0)
    {
        return new Map();
    }
    const out = batch(dir, ["cat-file", "--batch-check"], askable.map((value) => `${value}^{commit}\n`).join(""));
    if (out === null)
    {
        return null;
    }
    const answers = lines(out);
    if (answers.length !== askable.length)
    {
        return null;
    }
    const resolved = new Map<string, string>();
    answers.forEach((answer, index) =>
    {
        const parts = answer.split(" ");
        if (parts[1] === "commit")
        {
            resolved.set(askable[index], parts[0]);
        }
    });
    return resolved;
}

// The commits `git rev-list` still reaches from `oids` once `exclude` is
// subtracted. Membership of an oid in the answer is the batched form of
// `merge-base --is-ancestor <oid> <exclude>` returning false: reachable from
// what was excluded means not printed. Ancestors of the given commits come
// back too; the caller asks only about the oids it handed in.
export function revListExcept(dir: string, oids: string[], exclude: string[]): Set<string> | null
{
    if (oids.length === 0)
    {
        return new Set();
    }
    const out = batch(dir, ["rev-list", "--stdin", ...exclude], oids.map((oid) => `${oid}\n`).join(""));
    return out === null ? null : new Set(lines(out));
}

// Every ref this repository holds, plus the HEAD of the working tree the
// command is standing in — the whole of what a reachability verdict reads out
// of the refs, in one probe. A branch deletion moves no HEAD and still flips
// an abandonment verdict, so the branch names have to be in here beside it.
// Object existence is not in here and cannot be: pruning an unreachable commit
// leaves this listing byte-identical.
export function refListing(dir: string): string
{
    const listed = git(dir, "show-ref", "--head");
    return listed.ok ? listed.out : "";
}

// The bytes this call appended, or `null` where it appended none — which is the
// only thing a caller undoing its own work may take back: a pattern that was
// already excluded was excluded by somebody else, and removing it would undo a
// decision this run never made.
//
// The bytes rather than a yes, because a yes is not enough to put the file back
// exactly. Where the file did not end with a newline this has to add one to
// start its line on, and the file that results is byte-identical to the one an
// append to a newline-terminated file produces — so the undo cannot work out
// from the file alone whether that newline was the file's or this call's.
export function excludeLocally(dir: string, pattern: string): string | null
{
    const common = gitCommonDir(dir);
    if (common === null)
    {
        return null;
    }
    const excludeFile = join(common, "info", "exclude");
    const current = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
    if (current.split("\n").includes(pattern))
    {
        return null;
    }
    const added = (current === "" || current.endsWith("\n") ? "" : "\n") + pattern + "\n";
    appendFileSync(excludeFile, added);
    return added;
}

// The line taken back out, for a flow that added it and then could not finish.
//
// Only ever called with what `excludeLocally` reported it appended, so where
// those bytes are still the end of the file the file goes back to exactly the
// bytes it held — the newline the append had to add included, so a file that
// ended mid-line ends mid-line again.
//
// A file something else has appended to since is answered by dropping the
// pattern's line instead. The exact restore is no longer available there, and
// leaving the pattern in a file this run put it in would be the worse of the
// two: it excludes a directory that is about to stop existing.
export function unexcludeLocally(dir: string, pattern: string, appended: string): void
{
    const common = gitCommonDir(dir);
    if (common === null)
    {
        return;
    }
    const excludeFile = join(common, "info", "exclude");
    if (!existsSync(excludeFile))
    {
        return;
    }
    const current = readFileSync(excludeFile, "utf8");
    writeFileSync(excludeFile, current.endsWith(appended)
        ? current.slice(0, -appended.length)
        : withoutLine(current, pattern));
}

function withoutLine(text: string, pattern: string): string
{
    const lines = text.split("\n");
    const at = lines.indexOf(pattern);
    if (at < 0)
    {
        return text;
    }
    lines.splice(at, 1);
    return lines.join("\n");
}
