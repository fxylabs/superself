import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "./gitutil.js";
import { machineConfigPath } from "./machine.js";
import { dim, styled } from "./style.js";
import {
    checkoutMatches,
    checkoutProject,
    findUp,
    isStore,
    MARKER_FILE,
    readLinks,
    readRegistry,
    readStoreConfig,
    resolveProjectPath,
    STORE_DIR,
    workspaceDirFor
} from "./paths.js";

export function printSetup(cwd: string): void
{
    const marker = findUp(cwd, MARKER_FILE);
    const workspaceDir = workspaceDirFor(marker);
    console.log([...projectLines(marker, cwd, workspaceDir), ...workspaceLines(workspaceDir)].join("\n"));
}

function projectLines(marker: string | null, cwd: string, workspaceDir: string | null): string[]
{
    if (marker !== null)
    {
        return [
            row("project", JSON.parse(readFileSync(marker, "utf8")).project),
            row("", `${dirname(marker)} (via ${MARKER_FILE})`)
        ];
    }
    const storeDir = workspaceDir === null ? null : join(workspaceDir, STORE_DIR);
    if (storeDir === null || !isStore(storeDir))
    {
        return [row("project", "(none) — this directory is not registered; run `self project add`")];
    }
    const match = checkoutProject(storeDir, cwd);
    if (match !== null)
    {
        return [row("project", match.slug), row("", `${match.dir} (via this repository)`)];
    }
    const elsewhere = checkoutMatches(storeDir, cwd)[0];
    if (elsewhere !== undefined)
    {
        return [row("project", `(none here) — this repository's "${elsewhere.slug}" is at ${elsewhere.dir}`)];
    }
    return [row("project", "(none) — this directory is not registered; run `self project add`")];
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
    const active = resolveProjectPath(storeDir, slug) ?? "(not linked on this machine)";
    const others = (readLinks(storeDir)[slug] ?? []).filter((path) => path !== active).length;
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
