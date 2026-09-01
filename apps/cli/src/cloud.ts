// What the foreground says to a workspace server on its own account, rather
// than through the queue.
//
// Two conversations live here, and they are the two the sync layer cannot have.
// The first is attaching a machine to a workspace at all — the flow behind
// `self init --cloud`, which has to log in, be told which workspace, write the
// marker and fill the store before there is anything for the sync layer to
// carry. The second is creating a project, which is a refusal a person has to
// see at the moment they ask for it rather than a row in a queue nobody is
// watching.
//
// Both are foreground by construction, and that is the whole distinction from
// `pusher.ts`: a background push has no output channel and writes its refusals
// down, while everything here is said to somebody who is waiting for it.
//
// This module reads a credential, so nothing that writes, folds or syncs a
// record may import it — the same rule `transport.ts` lives under. It is
// imported by `main.ts`, the entry point, which is the layer credentials are
// allowed at.
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { credentialsPath, readProfile, resolveProfileName } from "./credentials.js";
import { excludeLocally } from "./gitutil.js";
import { askLine, atKeyboard } from "./human.js";
import { WORKSPACE_SCOPES, deviceLogin } from "./login.js";
import { setMachineWorkspace } from "./machine.js";
import { WORKSPACE_FILE } from "./mode.js";
import { STORE_DIR, ensureDir, invalidateResolution } from "./paths.js";
import { firstCatchUp } from "./puller.js";
import { createProject, openSession } from "./transport.js";
import { CliError, CommandOutput, JsonValue, fail } from "./types.js";

/* ── the scopes a workspace store cannot work without ──────────────── */

// Found locally, and this is the reason rather than a convenience.
//
// A credential granted before the workspace scopes existed is refused by the
// server as a 404 — the same 404 a non-member gets, and the same one an absent
// project gets (C1 invariant 3), because telling them apart would tell an
// outsider what exists. So there is nothing on the wire to read "your
// credential is old" off, and a CLI that guessed it from a 404 would send most
// people to a login that fixes nothing.
function assertWorkspaceScopes(): void
{
    const missing = WORKSPACE_SCOPES.filter((scope) => !grantedScopes().includes(scope));
    if (missing.length > 0)
    {
        throw fail("workspace_scopes_missing",
            "the credential on this machine was granted before this workspace's scopes and cannot reach one — "
            + `it is missing ${missing.join(", ")}`,
            { hint: "self login" });
    }
}

// What the credential file says was granted, and the empty list for every way
// it says nothing this CLI can read: no file, a file that will not parse, a
// profile that is not there, a `scopes` field of the wrong shape.
//
// One answer for all of them on purpose. What each fails to state is the scope
// list, and one `self login` writes a good one either way — so a second
// sentence about which kind of damage it is would be a distinction with no
// second remedy behind it.
function grantedScopes(): string[]
{
    try
    {
        const scopes = readProfile(resolveProfileName()).scopes as unknown;
        return Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === "string") : [];
    }
    catch
    {
        return [];
    }
}

// Whether this machine has ever been logged in, which is a different question
// from whether what it holds is usable. A machine with no credential file is
// one the flow logs in for; a machine with a damaged one is one the check above
// sends to `self login` with a sentence, because starting a device flow on top
// of a file this CLI cannot read would end in a write it cannot make either.
async function ensureCredential(): Promise<void>
{
    if (!existsSync(credentialsPath()))
    {
        await deviceLogin();
    }
    assertWorkspaceScopes();
}

/* ── attaching a machine to a workspace ────────────────────────────── */

// The whole of `self init --cloud`, and deliberately not a verb of its own: a
// person attaching this machine to a workspace is initializing a workspace
// store, and the fact that the records will live on a server rather than in a
// git repository is the answer to one question inside that, not a second thing
// to know the name of.
//
// It never reaches the git-store-creation path. That path makes a repository,
// and making one is outside every seam a mode could turn into no work — which
// is why the branch is here rather than a `commitAll` that does nothing.
export async function connectCloud(cwd: string, storeDir: string, named: string | undefined,
    lang: () => Promise<string>): Promise<CommandOutput>
{
    await ensureCredential();
    const wsId = chooseWorkspace(named);
    const base = readProfile(resolveProfileName()).api_base;
    await orRemove(storeDir, async () =>
    {
        writeStore(storeDir, base, wsId, await lang());
        await firstCatchUp(storeDir);
    });
    // Outside the store and therefore outside what the removal above can undo,
    // so both wait until nothing is left that can fail.
    excludeLocally(cwd, STORE_DIR + "/");
    setMachineWorkspace(cwd);
    return [{ kind: "receipt", text: `workspace store at ${storeDir} attached to ${wsId} on ${base}` }];
}

// Every way the flow can end short of finishing, answered the same way: the
// directory goes back to not being there.
//
// The check that it was not there is the caller's and has already run, so this
// removes what this run made and nothing else. A half-written marker, a
// registry with rows in it, a project directory a pull had started filling —
// all of it is this run's, and a store that names a workspace nobody confirmed
// this machine belongs to is worse than no store at all, because every command
// after it would fail somewhere further from the mistake.
//
// A credential the inline login wrote is not removed and is not this function's
// subject. A person approved a device on a page; that happened, and making them
// do it again because a later step failed would spend their attention on
// nothing. Credentials are machine state, like the workspace pointer, and the
// store is what this undoes.
async function orRemove(storeDir: string, work: () => Promise<void>): Promise<void>
{
    try
    {
        await work();
    }
    catch (error)
    {
        rmSync(storeDir, { recursive: true, force: true });
        // The resolver may have cached a registry this store no longer has.
        invalidateResolution();
        throw error;
    }
}

// The three files that are a store, written in one place so that what a failure
// has to undo is one directory.
function writeStore(storeDir: string, base: string, wsId: string, lang: string): void
{
    ensureDir(storeDir);
    writeFileSync(join(storeDir, "registry.jsonl"), "");
    writeFileSync(join(storeDir, "config.json"), JSON.stringify({ lang }) + "\n");
    writeFileSync(join(storeDir, WORKSPACE_FILE), JSON.stringify({ base, wsId, mode: "api" }) + "\n");
}

// Which workspace on the server this store belongs to.
//
// Named rather than picked from a list, because there is no list: C1 v0.9.4
// puts every route under `/api/workspaces/{wsId}` and has none that enumerates
// the workspaces an account is a member of. What confirms the name is the first
// catch-up — `GET /projects` answers 200 for a member and the contract's single
// concealing 404 for everything else — so a mistyped id is a refusal rather
// than a store pointing nowhere.
function chooseWorkspace(named: string | undefined): string
{
    const given = (named ?? "").trim();
    if (given !== "")
    {
        return given;
    }
    if (!atKeyboard())
    {
        throw new CliError("`self init --cloud` attaches this machine to a workspace on the server, and nobody is "
            + "at this terminal to be asked which — pass `--workspace <id>`");
    }
    const typed = askLine("which workspace on the server holds this store? [id]: ").trim();
    if (typed === "")
    {
        throw new CliError("no workspace was named, so nothing was created — "
            + "run `self init --cloud --workspace <id>` with the id of the workspace this machine should attach to");
    }
    return typed;
}

/* ── registering a project with the workspace ──────────────────────── */

// `self project init` where the store keeps its records on a server: the
// workspace makes the project, and this machine registers it only once the
// workspace has. The order is the whole point — a local registration the
// workspace refused is a project whose every record would queue up behind a
// 404 nobody sees until the next command says so.
//
// The id that comes back is cached on the registry row, and that cache is what
// `pusher.ts` reads at P6: a slug with no id is one this machine made and never
// registered, and a slug with one that the workspace has since forgotten is a
// project somebody deleted. Writing it here is what keeps those two apart for
// every project this machine creates.
export async function createWorkspaceProject(storeDir: string, slug: string,
    description: string | undefined): Promise<string | undefined>
{
    assertWorkspaceScopes();
    const made = await createProject(openSession(storeDir), slug, description);
    if (!made.reached)
    {
        throw new CliError(`this machine could not reach the workspace server, so "${slug}" was not created — `
            + "nothing was registered here either, and running this again once the workspace answers registers both");
    }
    if (made.status === 201)
    {
        return idOf(made.body);
    }
    throw refusedCreation(slug, made.status);
}

// The two the contract names, and everything else.
//
// 409 is the one answer that tells a member something about a project they
// cannot see, and C1 invariant 3a allows exactly that much: a slug being
// occupied is not a secret from a member of the workspace, while what is inside
// the project still is. So the sentence says the name is taken and sends them
// to the people who can let them in, rather than to a login that would change
// nothing.
function refusedCreation(slug: string, status: number): CliError
{
    if (status === 409)
    {
        return fail("project_taken",
            `the workspace already holds a project named "${slug}" and this machine cannot reach it — `
            + "ask an owner of that project for access, or register this directory under another name with "
            + "`self project init --name <slug>`");
    }
    if (status === 404)
    {
        return fail("project_denied",
            `this machine may not create "${slug}" in this workspace — check the connection and the account `
            + "with `self login`", { hint: "self login" });
    }
    return fail("project_create_failed",
        `the workspace server answered ${status} when asked to create "${slug}", so nothing was registered here`);
}

function idOf(body: JsonValue): string | undefined
{
    const id = (body as { id?: unknown } | null)?.id;
    return typeof id === "string" && id !== "" ? id : undefined;
}
