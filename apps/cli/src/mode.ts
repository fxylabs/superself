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
import { existsSync } from "node:fs";
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
