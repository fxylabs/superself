import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "./types.js";

export function git(cwd: string, ...args: string[]): { ok: boolean; out: string; err: string }
{
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
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

export function commitAll(storeDir: string, message: string): void
{
    git(storeDir, "add", "-A");
    if (git(storeDir, "status", "--porcelain").out === "")
    {
        return;
    }
    git(storeDir, "commit", "-qm", message);
}

export interface ClassifiedEvidence
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
export function classifyEvidence(projectDir: string, offered: string[]): ClassifiedEvidence
{
    const classified: ClassifiedEvidence = { commits: [], notes: [] };
    for (const value of offered)
    {
        const declared = DECLARED.exec(value);
        if (declared === null)
        {
            // A revision is recorded in the spelling git names objects with:
            // an uppercase spelling is user input for the same object, and one
            // spelling per object keeps one verdict per object — and keeps the
            // event guard's sha exemption reading it as the sha it is.
            if (resolvesInRepo(projectDir, value))
            {
                classified.commits.push(value.toLowerCase());
            }
            else
            {
                classified.notes.push(value);
            }
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
export type RevisionRefusal = (typed: string) => string;

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

// Reports written before evidence carried its type put whatever the caller
// passed into refs.commits, and those stores must fold from the log alone —
// status and context answer without the project checkout. So this is shape and
// nothing else, erring toward silence: a digit-only value is a date, a build
// number or a ticket at least as often as it is a hash, and reporting one as a
// vanished commit is the failure the split exists to stop.
const LEGACY_REVISION = /^(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{7,40}$/;

export function looksLikeLegacyRevision(value: string): boolean
{
    return LEGACY_REVISION.test(value);
}

// 12 hex chars: short hashes recorded as evidence must stay unambiguous as
// the project repo grows.
export function headCommit(dir: string): string | null
{
    const result = git(dir, "rev-parse", "--short=12", "HEAD");
    return result.ok ? result.out : null;
}

export function gitCommonDir(dir: string): string | null
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
// Two checkouts of one repository are the case `self project add` must not
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

// A detached HEAD reports the literal "HEAD"; record nothing rather than a
// name that points at no branch.
export function currentBranch(dir: string): string | null
{
    const result = git(dir, "rev-parse", "--abbrev-ref", "HEAD");
    return result.ok && result.out !== "" && result.out !== "HEAD" ? result.out : null;
}

export function excludeLocally(dir: string, pattern: string): void
{
    const common = gitCommonDir(dir);
    if (common === null)
    {
        return;
    }
    const excludeFile = join(common, "info", "exclude");
    const current = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
    if (current.split("\n").includes(pattern))
    {
        return;
    }
    const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
    appendFileSync(excludeFile, prefix + pattern + "\n");
}
