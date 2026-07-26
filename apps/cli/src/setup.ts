import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "./gitutil.js";
import { machineConfigPath } from "./machine.js";
import {
    findUp,
    isStore,
    MARKER_FILE,
    readLinks,
    readRegistry,
    readStoreConfig,
    resolveProjectPath,
    siblingSlug,
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
    const sibling = storeDir !== null && isStore(storeDir) ? siblingSlug(storeDir, cwd) : null;
    if (sibling === null)
    {
        return [row("project", "(none) — this directory is not registered; run `self project add`")];
    }
    return [row("project", `(unlinked) — another checkout of "${sibling}"; run \`self project link ${sibling}\``)];
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
    const others = (readLinks(storeDir)[slug] ?? []).length - 1;
    const active = resolveProjectPath(storeDir, slug) ?? "(not linked on this machine)";
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
    return `${label.padEnd(10)} ${value}`;
}
