import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git, realPath } from "./gitutil.js";
import { machineConfigPath } from "./machine.js";
import { dim, styled } from "./style.js";
import {
    checkoutMatches,
    findUp,
    isStore,
    MARKER_FILE,
    projectAt,
    readLinks,
    readRegistry,
    readStoreConfig,
    resolveProjectPath,
    STORE_DIR,
    workspaceDirFor
} from "./paths.js";
import { CommandOutput } from "./types.js";

// One render, declared as one: the diagnostics say the same thing to a person
// and to a pipe, and a machine with no workspace at all still has to be able
// to read them — which is the whole point of the verb.
export function setupOutput(cwd: string): CommandOutput
{
    const marker = findUp(cwd, MARKER_FILE);
    const workspaceDir = workspaceDirFor(marker);
    return [{
        kind: "document",
        plain: () => [...projectLines(marker, cwd, workspaceDir), ...workspaceLines(workspaceDir)]
    }];
}

function projectLines(marker: string | null, cwd: string, workspaceDir: string | null): string[]
{
    const storeDir = workspaceDir === null ? null : join(workspaceDir, STORE_DIR);
    if (storeDir === null || !isStore(storeDir))
    {
        return marker === null
            ? [row("project", "(none) — this directory is not registered; run `self project init`")]
            : [row("project", JSON.parse(readFileSync(marker, "utf8")).project), row("", `${dirname(marker)} (via ${MARKER_FILE})`)];
    }
    // The same answer every other command works from (#235): a marker above a
    // worktree of the same repository does not govern it, and explaining the
    // resolution separately named a directory no command would have used.
    const at = projectAt(storeDir, cwd, marker);
    if (at !== null)
    {
        const how = existsSync(join(at.dir, MARKER_FILE)) ? MARKER_FILE : "this repository";
        return [row("project", at.slug), row("", `${at.dir} (via ${how})`)];
    }
    const elsewhere = checkoutMatches(storeDir, cwd)[0];
    if (elsewhere !== undefined)
    {
        return [row("project", `(none here) — this repository's "${elsewhere.slug}" is at ${elsewhere.dir}`)];
    }
    return [row("project", "(none) — this directory is not registered; run `self project init`")];
}

function workspaceLines(workspaceDir: string | null): string[]
{
    if (workspaceDir === null)
    {
        return [row("workspace", "(none) — run `self init` or `self workspace <path>`")];
    }
    const storeDir = join(workspaceDir, STORE_DIR);
    if (!isStore(storeDir))
    {
        return [row("workspace", `${workspaceDir} — no store there; the machine pointer is stale`)];
    }
    const registry = readRegistry(storeDir);
    return [
        row("workspace", workspaceDir),
        row("store", `${storeDir} (${storeState(storeDir)})`),
        row("pointer", machineConfigPath()),
        row("views", readStoreConfig(storeDir).lang ?? "en"),
        ...registry.map((entry, index) => row(index === 0 ? "projects" : "", projectLine(storeDir, entry.slug)))
    ];
}

// What counts as another checkout is decided on the resolved path, never on
// the spelling the ledger happens to hold: resolution can answer with a path
// git worked out while the ledger line was written with the one a caller
// typed, and comparing those two counted one physical checkout twice (#128).
function projectLine(storeDir: string, slug: string): string
{
    const active = resolveProjectPath(storeDir, slug) ?? "(not linked on this machine)";
    const here = realPath(active);
    const others = (readLinks(storeDir)[slug] ?? []).filter((item) => realPath(item.path) !== here).length;
    return `${slug} → ${active}${others > 0 ? ` (+${others} more checkout${others > 1 ? "s" : ""})` : ""}`;
}

function storeState(storeDir: string): string
{
    const commits = git(storeDir, "rev-list", "--count", "HEAD");
    const remote = git(storeDir, "remote", "get-url", "origin");
    return `${commits.ok ? commits.out : "0"} commits, ${remote.ok ? remote.out : "no remote"}`;
}

function row(label: string, value: string): string
{
    const padded = label.padEnd(10);
    return `${styled ? dim(padded) : padded} ${value}`;
}
