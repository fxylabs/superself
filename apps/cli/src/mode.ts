// Which kind of store a workspace holds, and the refusal a verb raises when it
// is the other kind.
//
// A store keeps its records in one of two places: in a git repository this
// machine commits and pushes, or on a workspace server this machine is logged
// in to. One store is one or the other for its whole life, and
// `.superself/workspace.json` is what says which — present means server-backed.
//
// Existence is the whole test, on purpose. A git-backed store has never
// written that file — `self init` writes `registry.jsonl` and `config.json` and
// nothing else — so no store that predates this can be read as server-backed by
// accident, which is the misreading that would send a git-backed store's
// appends into a queue no commit covers.
//
// This module imports nothing but node and the refusal type, so every layer
// that has to branch on the mode can ask it: the git wrapper, the append path,
// the log reader and the path resolver alike. A module that asked the path
// resolver instead would be a cycle, since the path resolver asks the git
// wrapper.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "./types.js";

// What the connect flow writes to mark a store as server-backed. Named here
// rather than where it is written, because the readers outnumber the writer.
export const WORKSPACE_FILE = "workspace.json";

export function serverBacked(storeDir: string): boolean
{
    return existsSync(join(storeDir, WORKSPACE_FILE));
}

// A verb that only means something against a git-backed store, refused where
// the store is server-backed. The sentence names what the verb is for rather
// than what it is not: a caller who ran it was after the thing it does, and
// "that is not a thing here" without saying what the verb was for leaves them
// nowhere.
export function refuseGitOnly(storeDir: string, verb: string, does: string): void
{
    if (serverBacked(storeDir))
    {
        throw new CliError(`\`self ${verb}\` ${does}; this workspace store is server-backed and has none`);
    }
}

// What that file says beyond its own presence: which server holds the records,
// and which workspace on it they belong to. Read here because the readers of
// the mode and the readers of the address are the same layer's callers, and a
// second module for three fields would only mean two places to look.
//
// A marker this CLI cannot read is a refusal rather than a fallback. Every
// address it could fall back to would be a guess about whose workspace this
// machine's records belong to, and sending one account's log to another
// workspace is not a mistake a default can be allowed to make.
interface WorkspaceMarker
{
    base: string;
    wsId: string;
    mode: string;
}

export function readWorkspaceMarker(storeDir: string): WorkspaceMarker
{
    const file = join(storeDir, WORKSPACE_FILE);
    const marker = parseMarker(file);
    if (typeof marker.base !== "string" || marker.base === "" || typeof marker.wsId !== "string" || marker.wsId === "")
    {
        throw new CliError(`${file} names no server and workspace for this store — it holds \`base\` and \`wsId\`, `
            + "and without both there is nowhere for this machine's records to go");
    }
    return { base: marker.base, wsId: marker.wsId, mode: String(marker.mode ?? "api") };
}

function parseMarker(file: string): Partial<WorkspaceMarker>
{
    try
    {
        return JSON.parse(readFileSync(file, "utf8")) as Partial<WorkspaceMarker>;
    }
    catch
    {
        throw new CliError(`${file} is not readable as JSON — it says which server holds this store's records, `
            + "so repair that one file rather than deleting it: a store with no marker reads as git-backed, "
            + "and its queued records would then be committed into a repository that does not exist");
    }
}

// Whether this machine talks to its workspace at all, and how it sends when it
// does. One name for both directions, because they are one decision:
//
//   unset, "on"   catch up before the command, send after it in a process of
//                 its own — the shipped behaviour
//   "inline"      catch up before the command, send after it before the command
//                 returns. What a case asserting a row of the table above needs
//                 in order to have anything to assert
//   "off"         neither. A machine deliberately working from what it holds
//
// Read on each call rather than at load, so a test that sets it for one
// invocation gets it for that invocation.
export function syncMode(): string
{
    return process.env.SUPERSELF_SYNC ?? "on";
}
