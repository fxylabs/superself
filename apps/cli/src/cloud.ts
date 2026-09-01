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
import { excludeLocally, unexcludeLocally } from "./gitutil.js";
import { askLine, atKeyboard } from "./human.js";
import { WORKSPACE_SCOPES, deviceLogin } from "./login.js";
import { machineWorkspace, setMachineWorkspace } from "./machine.js";
import { WORKSPACE_FILE, syncMode } from "./mode.js";
import { STORE_DIR, ensureDir, invalidateResolution } from "./paths.js";
import { firstCatchUp } from "./puller.js";
import { WorkspaceSession, createProject, listProjects, listWorkspaces, openSession } from "./transport.js";
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
    const profile = resolveProfileName();
    const granted = grantedScopes(profile);
    const missing = WORKSPACE_SCOPES.filter((scope) => !granted.some((given) => covers(given, scope)));
    if (missing.length > 0)
    {
        throw fail("workspace_scopes_missing",
            `the credential this machine reads — profile "${profile}" — was granted before this workspace's scopes `
            + `and cannot reach one: it is missing ${missing.join(", ")}`,
            { hint: loginFor(profile) });
    }
}

// The login that writes the profile this machine will actually read.
//
// `self login` with no flag writes the profile literally called `default`,
// while every other command reads the one the credential file's own `default`
// field names — and `writeProfile` never moves that field once it is set. So a
// machine whose first login named a profile is one where the bare remedy
// writes a profile nothing reads: the shortage would survive the login that
// was supposed to clear it, and the sentence would say to run it again.
function loginFor(profile: string): string
{
    return profile === "default" ? "self login" : `self login --profile ${profile}`;
}

// Whether one granted entry answers for one required scope.
//
// Exact, and the family abbreviation beside it. C1 §3 writes the granted list
// as `self.*` and calls that a shorthand for the three `self` scopes, so a
// server that ever put the shorthand on the wire would otherwise be read as a
// shortage of scopes the account holds — and the answer would send somebody to
// a login that grants exactly the same list again.
function covers(granted: string, scope: string): boolean
{
    return granted === scope || (granted.endsWith(".*") && scope.startsWith(granted.slice(0, -1)));
}

// What the credential file says was granted, and the empty list for every way
// it says nothing this CLI can read: no file, a file that will not parse, a
// profile that is not there, a `scopes` field of the wrong shape.
//
// One answer for all of them on purpose. What each fails to state is the scope
// list, and one `self login` writes a good one either way — so a second
// sentence about which kind of damage it is would be a distinction with no
// second remedy behind it.
function grantedScopes(profile: string): string[]
{
    try
    {
        const scopes = readProfile(profile).scopes as unknown;
        return Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === "string") : [];
    }
    catch
    {
        return [];
    }
}

// Whether this machine holds the credential it is going to read, which is a
// different question from whether the file exists. `SUPERSELF_PROFILE` and the
// file's own `default` field each name a profile, and a file holding every
// profile but that one is a machine that has not signed in as this account —
// answered as a scope shortage of all seven, which states the wrong cause.
//
// The login it starts writes the profile this machine reads rather than the
// literal `default`, for the reason `loginFor` gives: a remedy that writes one
// profile while the check reads another is a remedy that cannot clear what it
// is the remedy for.
async function ensureCredential(): Promise<void>
{
    const profile = resolveProfileName();
    if (absentProfile(profile))
    {
        await deviceLogin({ profile });
    }
    assertWorkspaceScopes();
}

// A machine with no credential file, and a machine whose file holds no such
// profile. Both have not signed in as this account and both are logged in for.
//
// A file that will not parse is neither, deliberately: starting a device flow
// on top of a file this CLI cannot read would end in a write it cannot make
// either, so that one falls through to the scope check and comes back as a
// sentence naming the login that repairs it.
function absentProfile(profile: string): boolean
{
    if (!existsSync(credentialsPath()))
    {
        return true;
    }
    try
    {
        readProfile(profile);
        return false;
    }
    catch (error)
    {
        return (error as { code?: string }).code === "profile_not_found";
    }
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
    lang: () => string): Promise<CommandOutput>
{
    await ensureCredential();
    const wsId = await chooseWorkspace(named);
    const base = readProfile(resolveProfileName()).api_base;
    const undo: Undo = { cwd, made: false, excluded: false, pointerWas: machineWorkspace(), pointed: false };
    await orRemove(storeDir, undo, async () =>
    {
        const views = lang();
        refuseAppeared(storeDir);
        undo.made = true;
        writeStore(storeDir, base, wsId, views);
        await firstCatchUp(storeDir);
        undo.excluded = excludeLocally(cwd, STORE_DIR + "/");
        setMachineWorkspace(cwd);
        undo.pointed = true;
    });
    return [{ kind: "receipt", text: `workspace store at ${storeDir} attached to ${wsId} on ${base}` }];
}

// What this run changed outside the store, so that a failure can put it back.
//
// The store is one directory and is removed whole. These two are not: the local
// exclude is a line in a file that was there before, and the machine pointer is
// a field that named another workspace — or nothing — a moment ago. A rollback
// that forgot them leaves a machine pointing at a directory the same rollback
// has just deleted, and every later command failing somewhere further from the
// cause. `made` is what keeps the removal to this run's own work.
interface Undo
{
    cwd: string;
    made: boolean;
    excluded: boolean;
    pointerWas: string | null;
    pointed: boolean;
}

// The caller's `existsSync` ran before a device approval and two questions,
// which is minutes rather than instants. A second `self init` in the same
// directory during them makes a store these writes would truncate — and the
// rollback would then take somebody else's store off the disk — so it is asked
// again here, where the answer is still true when the write happens.
function refuseAppeared(storeDir: string): void
{
    if (existsSync(storeDir))
    {
        throw new CliError(`${storeDir} appeared while this machine was being signed in, so nothing was written — `
            + "another `self init` is running in this directory");
    }
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
async function orRemove(storeDir: string, undo: Undo, work: () => Promise<void>): Promise<void>
{
    try
    {
        await work();
    }
    catch (error)
    {
        if (undo.made)
        {
            rmSync(storeDir, { recursive: true, force: true });
        }
        rollBack(undo);
        // The resolver may have cached a registry this store no longer has.
        invalidateResolution();
        throw error;
    }
}

// The two machine-level changes, each undone only where this run made it. An
// exclude line that was already there was somebody else's decision, and a
// pointer this run never moved is one it has no business moving now.
function rollBack(undo: Undo): void
{
    if (undo.excluded)
    {
        unexcludeLocally(undo.cwd, STORE_DIR + "/");
    }
    if (undo.pointed)
    {
        setMachineWorkspace(undo.pointerWas);
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

/* ── which workspace on the server ─────────────────────────────────── */

// A list, and not an id typed from memory (design v0.3.7, C1 v0.9.6).
//
// An account can be a member of several workspaces, so an id alone is
// something a person has to have written down somewhere — and a mistyped one
// used to reach the first catch-up and come back as the contract's single
// concealing 404, which names three causes and cannot say which. `GET
// /api/workspaces` is the one route outside the workspace segment and it
// answers the question directly: these are yours, choose.
//
// A `--workspace` given on the command line is checked against the same list,
// which is what makes it a flag rather than a guess.
async function chooseWorkspace(named: string | undefined): Promise<string>
{
    const given = (named ?? "").trim();
    if (given === "" && !atKeyboard())
    {
        // Refused before the list is asked for. Nobody could be shown it, so
        // fetching it would spend a request on something with no reader.
        throw new CliError("`self init --cloud` attaches this machine to a workspace on the server, and nobody is "
            + "at this terminal to be asked which — pass `--workspace <id>`");
    }
    const listed = await memberships();
    return given === "" ? pickedFrom(listed) : namedIn(listed, given);
}

// One row of that list. `status` is read defensively rather than required: a
// row this CLI cannot classify is one it shows and lets be chosen, which is the
// behaviour a workspace with no status field had before the field existed.
interface Membership
{
    id: string;
    name: string;
    status?: string;
}

async function memberships(): Promise<Membership[]>
{
    const answer = await listWorkspaces();
    if (!answer.reached)
    {
        throw new CliError("this machine could not reach the workspace server to ask which workspaces this account "
            + "is a member of, so nothing was created");
    }
    if (answer.status !== 200 || !Array.isArray(answer.body))
    {
        throw unlistable(answer.status);
    }
    const listed = (answer.body as unknown[]).filter(isMembership);
    if (listed.length === 0)
    {
        // Its own sentence, and not an empty prompt. A person with no
        // workspace has nothing to type and nothing to fix on this machine.
        throw new CliError("this account is not a member of any workspace yet, so there is none to attach this "
            + "machine to — make one in the workspace app and run `self init --cloud` again");
    }
    return listed;
}

// The 404 is the contract's concealing answer, and on this route it has one
// more cause than usual: a Runtime credential belongs to one workspace rather
// than to an account, so it may not ask an account route at all.
function unlistable(status: number): CliError
{
    if (status === 404)
    {
        return fail("workspaces_unlistable",
            "this machine's credential cannot ask which workspaces its account is a member of — sign in again "
            + "with `self login`", { hint: "self login" });
    }
    return new CliError(`the workspace server answered ${status} when asked which workspaces this account is a `
        + "member of, so nothing was created");
}

function isMembership(row: unknown): row is Membership
{
    const found = row as Partial<Membership>;
    return typeof found?.id === "string" && found.id !== "" && typeof found.name === "string";
}

// The question, asked as the list it is. One write rather than a printed list
// and a prompt after it: stdout belongs to the render gate, and the interaction
// prompt is the one other place a sentence may reach it — so the choices travel
// inside the question.
function pickedFrom(listed: Membership[]): string
{
    const typed = askLine(`which workspace on the server holds this store?\n${offered(listed)}`
        + "choose a number, or paste an id: ").trim();
    if (typed === "")
    {
        throw new CliError("no workspace was named, so nothing was created — "
            + "run `self init --cloud --workspace <id>` with the id of the workspace this machine should attach to");
    }
    return openFor(chosenBy(listed, typed));
}

function offered(listed: Membership[]): string
{
    return listed.map((workspace, index) =>
        `  ${index + 1}) ${labelled(workspace)}${closed(workspace) ? " — closed" : ""}\n`).join("");
}

function chosenBy(listed: Membership[], typed: string): Membership
{
    const numbered = Number(typed);
    const chosen = Number.isInteger(numbered) && numbered >= 1 && numbered <= listed.length
        ? listed[numbered - 1]
        : listed.find((workspace) => workspace.id === typed);
    if (chosen === undefined)
    {
        throw new CliError(`"${typed}" is neither a number on that list nor an id on it, so nothing was created — `
            + "run `self init --cloud` again and answer with one of them");
    }
    return chosen;
}

// The refusal names what this account *can* reach. An id that is not on the
// list is a typo or the wrong account signed in, and both are answered by
// seeing the list rather than by being told the id is wrong.
function namedIn(listed: Membership[], given: string): string
{
    const found = listed.find((workspace) => workspace.id === given);
    if (found === undefined)
    {
        throw new CliError(`this account is not an active member of a workspace with the id "${given}" — it is a `
            + `member of ${listed.map(labelled).join(", ")}; check the id, and check that this machine is signed `
            + "in as the right account with `self login`");
    }
    return openFor(found);
}

// A closed workspace is shown and never chosen. It is on the list because
// leaving it off would answer "there is no such workspace" for one that exists
// and was closed — sending somebody to check an id that is right.
function openFor(chosen: Membership): string
{
    if (closed(chosen))
    {
        throw new CliError(`the workspace ${labelled(chosen)} is closed, so no machine attaches to it and nothing `
            + "was created — reopen it in the workspace app, or choose another");
    }
    return chosen.id;
}

function closed(workspace: Membership): boolean
{
    return workspace.status === "closed";
}

function labelled(workspace: Membership): string
{
    return `${workspace.name} (${workspace.id})`;
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
    refuseWithoutSync(slug);
    const session = openSession(storeDir);
    const made = await createProject(session, slug, description);
    if (!made.reached)
    {
        throw new CliError(`this machine could not reach the workspace server, so "${slug}" was not created — `
            + "nothing was registered here either, and running this again once the workspace answers registers both");
    }
    if (made.status === 201)
    {
        return idOf(made.body);
    }
    if (made.status === 409)
    {
        return adopted(session, slug);
    }
    throw refusedCreation(slug, made.status);
}

// `off` stands the whole sync layer down — `puller.ts` says it in as many
// words: it does not talk to the workspace. Registering a project *is* talking
// to the workspace, and doing it anyway would be the one command that ignored
// the setting. Worse, it is the command where ignoring it costs most: a 201
// this machine then fails to record is the half state below.
function refuseWithoutSync(slug: string): void
{
    if (syncMode() === "off")
    {
        throw fail("sync_off",
            `this machine is set not to talk to its workspace (\`SUPERSELF_SYNC=off\`), and "${slug}" is registered `
            + "by the workspace before it is registered here — so nothing was registered; unset that variable and "
            + "run this again");
    }
}

// The 409 that is this machine's own unfinished work.
//
// A creation that answered 201 and died before the registry row was written
// leaves a project this account owns and a machine that does not know it. The
// retry's 409 is, on the wire, the same 409 a slug another member took gets —
// C1 invariant 3a allows a member to be told a name is occupied and nothing
// more — so the answer cannot be read off the status.
//
// The list is what tells them apart. `GET /projects` shows a member the
// projects they can reach, so a slug on it is one this machine may register
// and a slug that is not is the refusal that was always right.
//
// Nothing here can resurrect a deleted project (P6): the id adopted is the one
// the workspace holds *now*, so a slug that was deleted is not on the list at
// all, and a slug deleted and made again is on it carrying the new project's
// id — which is exactly the id the cache is supposed to hold.
async function adopted(session: WorkspaceSession, slug: string): Promise<string>
{
    const listed = await listProjects(session);
    const rows = listed.reached && listed.status === 200 && Array.isArray(listed.body) ? listed.body : [];
    const found = (rows as { slug?: unknown; id?: unknown }[]).find((project) => project.slug === slug);
    if (typeof found?.id !== "string" || found.id === "")
    {
        throw refusedCreation(slug, 409);
    }
    return found.id;
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
