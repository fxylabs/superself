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
import { machineNotice } from "./output.js";
import { STORE_DIR, ensureDir, invalidateResolution } from "./paths.js";
import { Cancellation, firstCatchUp } from "./puller.js";
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
    // Read before the guard below is armed, because it is the one step here
    // that may block on a keyboard: a signal handler installed over a blocking
    // read of fd 0 answers a ctrl-c with a rejection nobody is waiting on yet.
    // Nothing exists to undo until the write two lines down, so there is
    // nothing for a signal to catch here either.
    const views = lang();
    const undo: Undo = { cwd, made: false, excluded: null, pointerWas: machineWorkspace(), pointed: false };
    await orRemove(storeDir, undo, async (cancel) =>
    {
        refuseAppeared(storeDir);
        undo.made = true;
        writeStore(storeDir, base, wsId, views);
        await firstCatchUp(storeDir, { cancel });
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
    excluded: string | null;
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
async function orRemove(storeDir: string, undo: Undo, work: (cancel: Cancellation) => Promise<void>): Promise<void>
{
    const signal = armed();
    try
    {
        await signal.raced(work);
    }
    catch (error)
    {
        undone(storeDir, undo);
        throw error;
    }
    finally
    {
        // After the removal and not before it: the whole point of the handler
        // is that a second ctrl-c lands on it rather than on the default
        // disposition, and the window a person presses it in is exactly this
        // one — between the first press and the directory being gone.
        signal.disarm();
    }
}

// Best effort, each step on its own, and none of them may replace the error on
// its way out: a rollback that raised would answer a person with a consequence
// instead of the cause, and would skip the steps after it — leaving more behind
// than the failure it was undoing.
function undone(storeDir: string, undo: Undo): void
{
    if (undo.made)
    {
        bestEffort(() => rmSync(storeDir, { recursive: true, force: true }));
    }
    rollBack(undo);
    // The resolver may have cached a registry this store no longer has.
    invalidateResolution();
}

// The two machine-level changes, each undone only where this run made it. An
// exclude line that was already there was somebody else's decision, and a
// pointer this run never moved is one it has no business moving now.
function rollBack(undo: Undo): void
{
    const added = undo.excluded;
    if (added !== null)
    {
        bestEffort(() => unexcludeLocally(undo.cwd, STORE_DIR + "/", added));
    }
    if (undo.pointed)
    {
        bestEffort(() => setMachineWorkspace(undo.pointerWas));
    }
}

function bestEffort(step: () => void): void
{
    try
    {
        step();
    }
    catch
    {
        // Said nowhere on purpose. The error already travelling out of
        // `orRemove` names what went wrong, and a second sentence about the
        // tidying would bury it.
    }
}

/* ── ctrl-c, from the first byte written to the last one removed ───── */

// The signal, caught for as long as there is a half-made store for it to leave
// behind — which is longer than the catch-up it interrupts.
//
// Without a handler at all, the default disposition kills the process on the
// signal number, in the middle of the window between the store's marker being
// written and the machine being pointed at it, leaving the directory the flow
// promised to take back off the disk. With a handler that disarms as it fires
// — `process.once`, which is what this was — the same thing happens one
// keypress later: the removal runs after the pull it interrupted has settled,
// and a person watching a command that has printed nothing for several seconds
// presses ctrl-c again into a process that is once more killable.
//
// So the handler stays on until the removal has run, and every signal after the
// first is answered with a line rather than with an exit. There is nothing
// faster to offer honestly: the losing pull is still writing into the store,
// and removing the directory out from under it is what puts files back after
// the removal.
interface Guard
{
    raced: (work: (cancel: Cancellation) => Promise<void>) => Promise<void>;
    disarm: () => void;
}

function armed(): Guard
{
    const cancel: Cancellation = { requested: false };
    let interrupt = (): void => undefined;
    const interrupted = new Promise<never>((_, reject) =>
    {
        interrupt = () => reject(new CliError("the first catch-up was interrupted, so nothing was created"));
    });
    const onInterrupt = (): void => pressed(cancel, interrupt);
    process.on("SIGINT", onInterrupt);
    return {
        raced: (work) => raceInterrupt(work(cancel), interrupted),
        disarm: () => process.removeListener("SIGINT", onInterrupt)
    };
}

function pressed(cancel: Cancellation, interrupt: () => void): void
{
    if (cancel.requested)
    {
        machineNotice("notice: still putting this directory back the way it was — one moment");
        return;
    }
    cancel.requested = true;
    interrupt();
}

// The loser is waited for rather than abandoned, and that is the whole reason
// the flag exists beside the rejection: `Promise.race` settles the caller and
// stops nothing, and the caller's next act is to remove the store. A pull still
// applying a delta into it would put files back after the removal. Each request
// carries its own timeout, so the wait is bounded by one of those.
async function raceInterrupt(running: Promise<void>, interrupted: Promise<never>): Promise<void>
{
    try
    {
        await Promise.race([running, interrupted]);
    }
    finally
    {
        await running.catch(() => undefined);
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

// The id first, then the place on the list. openapi 0.9.4 puts no pattern on
// `Workspace.id`, so a server is free to write one that reads as a number —
// and a machine attached to the wrong workspace because its id happened to be
// "2" is the mistake this order rules out.
function chosenBy(listed: Membership[], typed: string): Membership
{
    const chosen = listed.find((workspace) => workspace.id === typed) ?? ordinal(listed, typed);
    if (chosen === undefined)
    {
        throw new CliError(`"${typed}" is neither a number on that list nor an id on it, so nothing was created — `
            + "run `self init --cloud` again and answer with one of them");
    }
    return chosen;
}

// Digits and nothing else. `Number` reads `0x2`, `1e0` and ` 2 ` as integers,
// and none of them is a thing that was written on the list — so a person who
// typed one of them typed something this question does not offer, and being
// told so is better than being attached to whatever it rounded to.
function ordinal(listed: Membership[], typed: string): Membership | undefined
{
    if (!/^\d+$/.test(typed))
    {
        return undefined;
    }
    const at = Number(typed);
    return at >= 1 && at <= listed.length ? listed[at - 1] : undefined;
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
        throw await taken(session, slug);
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

// The 409, which is a name already in use and — deliberately — nothing else.
//
// Two different things reach it and the wire cannot tell them apart. A creation
// that answered 201 and died before the registry row was written leaves a
// project this account owns and a machine that does not know it; a teammate
// having taken the name first leaves a project this account must not touch.
// C1 invariant 3a allows a member to be told a name is occupied and no more, so
// the status says which of them it is exactly as much as it says anything else:
// not at all.
//
// `GET /projects` does not separate them either, and reading it as though it
// did is the mistake this replaces. C1 v0.9.6 defines that route as the
// projects a *member can see* — not the projects this account created — so a
// slug on it is this machine's own unfinished registration or a colleague's
// project, and taking the id would bind this directory to somebody else's
// records. `project init` would have quietly done what `project link` is for,
// against a project the person never named, and their `--desc` would have gone
// nowhere.
//
// So nothing is guessed and both remedies are said. The list is still asked
// for, because which of the two sentences is *true* depends on whether this
// account can reach the project at all — and where the list cannot be had, that
// is its own sentence rather than the more confident of the two.
async function taken(session: WorkspaceSession, slug: string): Promise<CliError>
{
    const listed = await listProjects(session);
    if (!listed.reached || listed.status !== 200 || !Array.isArray(listed.body))
    {
        return fail("project_taken_unknown",
            `the workspace already holds a project named "${slug}", and this machine could not ask whether it is `
            + "one this account can reach, so nothing was registered here — check the connection and run this "
            + "again");
    }
    const rows = listed.body as { slug?: unknown }[];
    return rows.some((project) => project.slug === slug) ? reachable(slug) : refusedCreation(slug, 409);
}

// The name is taken by a project this account *can* see, which is both the
// crashed registration and the colleague's project — so the sentence names the
// command for each and lets the person say which it is. `project link --here`
// is the completion path for a registration that died after the 201, and it is
// equally the right command for a project somebody meant to join.
function reachable(slug: string): CliError
{
    return fail("project_taken",
        `the workspace already holds a project named "${slug}" — if that is this directory's project, whether `
        + `because an earlier \`self project init\` did not finish or because it is the one you meant, run \`self `
        + `project link ${slug} --here\`; if it is somebody else's, register this directory under another name `
        + "with `self project init --name <slug>`");
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
