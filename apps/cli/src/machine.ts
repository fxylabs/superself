import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CliError } from "./types.js";

interface MachineConfig
{
    workspace?: string;
}

export function machineConfigPath(): string
{
    const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
    return join(base, "superself", "machine.json");
}

// A file this CLI wrote itself, and still read defensively: it is edited by
// hand often enough — that is how a machine is pointed at a second workspace —
// and it is read on the way into every command that needs a store. A raw parse
// failure here reaches the caller as a stack, which is the one answer this CLI
// does not give for a file it can name.
function readMachineConfig(): MachineConfig
{
    const file = machineConfigPath();
    if (!existsSync(file))
    {
        return {};
    }
    try
    {
        return JSON.parse(readFileSync(file, "utf8")) as MachineConfig;
    }
    catch
    {
        throw new CliError(`${file} is not readable as JSON — it holds nothing but which workspace this machine `
            + "points at, so it is safe to delete and set again with `self workspace <path>`");
    }
}

export function machineWorkspace(): string | null
{
    return readMachineConfig().workspace ?? null;
}

// Where this machine's workspace is, or — with `null` — that it has none.
//
// The second half is what a flow that has to undo its own pointer needs: a
// machine that pointed nowhere before an aborted `self init --cloud` has to
// point nowhere after it, and a pointer left naming a directory the flow then
// removed fails every later command somewhere further from the mistake.
export function setMachineWorkspace(workspaceDir: string | null): void
{
    const file = machineConfigPath();
    const { workspace, ...rest } = readMachineConfig();
    mkdirSync(dirname(file), { recursive: true });
    const next = workspaceDir === null ? rest : { ...rest, workspace: workspaceDir };
    writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
}

// The session a run belongs to, as an opaque token stamped on every event.
// It distinguishes this session from another one and says nothing else —
// never a hostname, a user name or a machine label. Decision
// `01kz8c83me299m37gk8rjjydw0` rules those out: the log is append-only, so an
// identifier that names the person holding the clone is permanent, which is
// what `sanitize.ts` already refuses absolute home paths for.
//
// `SUPERSELF_SESSION` is the explicit form and is used as given. Otherwise the
// agent harness running the session is asked, because a claim that only fires
// when somebody remembered to export a variable is the failure #230 is about.
// A harness not listed here records no session, and every surface reads that
// as "nobody has claimed this".
//
// This is not the list `human.ts` reads to decide whether a person is behind a
// call, and merging them would be wrong in both directions: a harness variable
// is set for the person typing into that harness's shell as much as for the
// agent, so it says which session this is and never whether anyone is home.
const HARNESS_SESSION_VARS = ["CLAUDE_CODE_SESSION_ID"];

export function sessionToken(): string | undefined
{
    const explicit = process.env.SUPERSELF_SESSION?.trim();
    if (explicit !== undefined && explicit !== "")
    {
        return explicit;
    }
    const derived = HARNESS_SESSION_VARS.map((name) => process.env[name]?.trim()).find((value) => value !== undefined && value !== "");
    // Shortened because none of the rest is read: eight hex characters separate
    // the sessions one workspace sees, and a shorter token is less of a value
    // for the credential-shaped rules in `sanitize.ts` to have an opinion on.
    return derived === undefined ? undefined : derived.replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
}

// The long-lived process behind the session, for liveness on this machine
// alone. The CLI's own pid answers nothing — it exits with the command — so
// this is the agent process that outlives it. It never reaches an event;
// `ledger.ts` keeps it beside the log on the one machine that can judge it.
const HARNESS_PID_VARS = ["SUPERSELF_SESSION_PID", "CLAUDE_PID"];

export function sessionPid(): number | undefined
{
    for (const name of HARNESS_PID_VARS)
    {
        const parsed = Number(process.env[name]);
        if (Number.isInteger(parsed) && parsed > 0)
        {
            return parsed;
        }
    }
    return undefined;
}
