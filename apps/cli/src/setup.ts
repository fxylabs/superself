import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "./gitutil.js";
import {
    findAllUp,
    findUp,
    isStore,
    MARKER_FILE,
    readRegistry,
    readStoreConfig,
    resolveProjectPath,
    STORE_DIR
} from "./paths.js";

export function printSetup(cwd: string): void
{
    const marker = findUp(cwd, MARKER_FILE);
    const workspaceDir = marker === null
        ? dirnameOrNull(findUp(cwd, STORE_DIR, isStore))
        : JSON.parse(readFileSync(marker, "utf8")).workspace;
    const lines = [...attachmentLines(cwd, marker), ...storeLines(workspaceDir), ...skippedLines(cwd, workspaceDir)];
    console.log(lines.join("\n"));
}

function attachmentLines(cwd: string, marker: string | null): string[]
{
    if (marker === null)
    {
        const store = findUp(cwd, STORE_DIR, isStore);
        return store === null
            ? [row("project", "(none) — this directory belongs to no workspace")]
            : [row("project", "(none) — inside the workspace, but not registered; run `self project add`")];
    }
    const parsed = JSON.parse(readFileSync(marker, "utf8"));
    return [
        row("project", parsed.project),
        row("", `${dirname(marker)} (via ${MARKER_FILE})`)
    ];
}

function storeLines(workspaceDir: string | null): string[]
{
    if (workspaceDir === null)
    {
        return [];
    }
    const storeDir = join(workspaceDir, STORE_DIR);
    if (!isStore(storeDir))
    {
        return [row("workspace", `${workspaceDir} — no store here; the marker is stale`)];
    }
    const registry = readRegistry(storeDir);
    return [
        row("workspace", workspaceDir),
        row("store", `${storeDir} (${storeState(storeDir)})`),
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

function skippedLines(cwd: string, workspaceDir: string | null): string[]
{
    return findAllUp(cwd, STORE_DIR)
        .filter((candidate) => !isStore(candidate) && dirname(candidate) !== workspaceDir)
        .map((candidate) => row("skipped", `${candidate} — no registry.jsonl, so not a workspace store`));
}

function dirnameOrNull(path: string | null): string | null
{
    return path === null ? null : dirname(path);
}

function row(label: string, value: string): string
{
    return `${label.padEnd(10)} ${value}`;
}
