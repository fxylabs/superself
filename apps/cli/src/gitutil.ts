import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "./types.js";

export interface Checkout
{
    common: string;
    top: string;
}

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
            (resolvesInRepo(projectDir, value) ? classified.commits : classified.notes).push(value);
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

function resolvesInRepo(projectDir: string, value: string): boolean
{
    return HEX.test(value) && git(projectDir, "cat-file", "-e", `${value}^{commit}`).ok;
}

function requireRevision(value: string): string
{
    if (!HEX.test(value))
    {
        throw new CliError(`evidence "commit:${value}" is not a Git object name — record free-form evidence as "note:${value}"`);
    }
    return value;
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

// Every linked worktree of one repository shares a common directory while
// keeping its own top level. That pair identifies a checkout, and two
// checkouts of one repository are the case `self project add` must not treat
// as a new project.
export function checkoutOf(dir: string): Checkout | null
{
    const common = gitCommonDir(dir);
    const top = git(dir, "rev-parse", "--show-toplevel");
    return common !== null && top.ok ? { common, top: realPath(top.out) } : null;
}

function realPath(path: string): string
{
    return existsSync(path) ? realpathSync(path) : path;
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
