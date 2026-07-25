import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "./gitutil.js";
import { machineConfigPath } from "./machine.js";
import { dim, styled } from "./style.js";
import {
    findUp,
    isStore,
    MARKER_FILE,
    readRegistry,
    readStoreConfig,
    resolveProjectPath,
    STORE_DIR,
    workspaceDirFor
} from "./paths.js";

export function printSetup(cwd: string): void
{
    const marker = findUp(cwd, MARKER_FILE);
    console.log([...projectLines(marker), ...workspaceLines(workspaceDirFor(marker))].join("\n"));
}

function projectLines(marker: string | null): string[]
{
    if (marker === null)
    {
        return [row("project", "(none) — this directory is not registered; run `self project add`")];
    }
    return [
        row("project", JSON.parse(readFileSync(marker, "utf8")).project),
        row("", `${dirname(marker)} (via ${MARKER_FILE})`)
    ];
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

function projectLine(storeDir: string, slug: string): string
{
    return `${slug} → ${resolveProjectPath(storeDir, slug) ?? "(not linked on this machine)"}`;
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
