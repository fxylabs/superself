import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ChangeSet, IntegrationState, Promotion, Repository, findChangeSet, findPromotion, repositoryOf } from "./integration.js";
import { buildModel } from "./model.js";
import { ProjectContext } from "./paths.js";
import { changedPaths, featureDigest, isRepo, resolveSha } from "./repo.js";
import { CliError } from "./types.js";

const FULL_SHA = /^[0-9a-f]{40}$/;

export function loadIntegration(ctx: ProjectContext): IntegrationState
{
    return buildModel(ctx.storeDir, ctx.project, new Date()).integration;
}

export function requireChangeSet(state: IntegrationState, id: string | undefined): ChangeSet
{
    const changeSet = findChangeSet(state, id);
    if (changeSet === undefined)
    {
        throw new CliError(`unknown change set "${id ?? ""}" — run \`self integration list\` to see ids`);
    }
    return changeSet;
}

export function requirePromotion(state: IntegrationState, id: string | undefined): Promotion
{
    const promotion = findPromotion(state, id);
    if (promotion === undefined)
    {
        throw new CliError(`unknown promotion "${id ?? ""}" — request one with ` +
            "`self integration promote request --repo <name> --candidate <sha>`");
    }
    return promotion;
}

export function requireRepository(state: IntegrationState, name: string | undefined): Repository
{
    if (name === undefined || name.trim() === "")
    {
        throw new CliError("--repo <name> names the repository whose integration lane this acts on");
    }
    const known = state.repositories.some((item) => item.name === name);
    if (!known)
    {
        throw new CliError(`no change set is registered for repository "${name}" — register one first`);
    }
    return repositoryOf(state, name);
}

export function printMachine(json: boolean | undefined, value: unknown): boolean
{
    if (json !== true)
    {
        return false;
    }
    console.log(JSON.stringify(value, null, 2));
    return true;
}

export interface Binding
{
    base: string;
    head: string;
    digest: string;
    digestSource: "computed" | "declared";
    paths: string[];
}

// Where an agent's claim meets the repository. When a checkout is reachable
// the digest is computed from the bytes, and a declared digest that disagrees
// is refused rather than recorded; with no checkout the declaration stands on
// its own and is marked as such, so every reader can see which it is.
export function bindDigest(repoDir: string | null, base: string, head: string,
    declared: string | undefined, declaredPaths: string[]): Binding
{
    if (repoDir === null)
    {
        return { base: requireSha(base, "--base"), head: requireSha(head, "--head"),
            digest: requireDeclared(declared), digestSource: "declared", paths: [...declaredPaths].sort() };
    }
    const resolvedBase = requireResolvable(repoDir, base, "--base");
    const resolvedHead = requireResolvable(repoDir, head, "--head");
    const digest = featureDigest(repoDir, resolvedBase, resolvedHead);
    if (digest === null)
    {
        throw new CliError(`git could not diff ${base}...${head} in ${repoDir}`);
    }
    if (declared !== undefined && declared !== digest)
    {
        throw new CliError(`declared digest ${declared} is not the digest of ${base}...${head} (${digest}) ` +
            "— the bytes decide, so the declaration is refused");
    }
    const paths = changedPaths(repoDir, resolvedBase, resolvedHead) ?? [];
    return { base: resolvedBase, head: resolvedHead, digest, digestSource: "computed",
        paths: declaredPaths.length > 0 ? [...new Set([...paths, ...declaredPaths])].sort() : paths };
}

// A checkout is used only when it is really a git repository: pointing this at
// a directory that is not one must not silently downgrade every digest in the
// store to a declaration.
export function repoDirOf(ctx: ProjectContext, flag: string | undefined, offline: boolean): string | null
{
    if (offline)
    {
        return null;
    }
    if (flag !== undefined)
    {
        const dir = resolve(flag);
        if (!existsSync(dir) || !isRepo(dir))
        {
            throw new CliError(`--repo-dir "${flag}" is not a git checkout`);
        }
        return dir;
    }
    return isRepo(ctx.projectDir) ? ctx.projectDir : null;
}

export function requireSha(value: string | undefined, flag: string): string
{
    if (value === undefined || !FULL_SHA.test(value))
    {
        throw new CliError(`${flag} needs a full 40-character commit id with no reachable checkout to resolve it`);
    }
    return value;
}

function requireDeclared(declared: string | undefined): string
{
    if (declared === undefined || !/^[0-9a-f]{64}$/.test(declared))
    {
        throw new CliError("no checkout was reachable, so --diff-digest <sha256> must declare the reviewed bytes");
    }
    return declared;
}

function requireResolvable(repoDir: string, rev: string, flag: string): string
{
    const sha = resolveSha(repoDir, rev);
    if (sha === null)
    {
        throw new CliError(`${flag} "${rev}" is not a commit in ${repoDir}`);
    }
    return sha;
}

export function requireText(value: string | undefined, usage: string): string
{
    if (value === undefined || value.trim() === "")
    {
        throw new CliError(`usage: self ${usage}`);
    }
    return value;
}
