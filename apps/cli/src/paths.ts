import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { machineWorkspace, setMachineWorkspace } from "./machine.js";
import { CliError, RegistryEntry } from "./types.js";

export const STORE_DIR = ".superself";
export const MARKER_FILE = ".self";
export const LINKS_FILE = "links.jsonl";

export interface CliContext
{
    workspaceDir: string;
    storeDir: string;
    project?: string;
    projectDir?: string;
}

export function isStore(dir: string): boolean
{
    return existsSync(join(dir, "registry.jsonl"));
}

export function findUp(start: string, name: string): string | null
{
    let dir = resolve(start);
    while (true)
    {
        const candidate = join(dir, name);
        if (existsSync(candidate))
        {
            return candidate;
        }
        const parent = dirname(dir);
        if (parent === dir)
        {
            return null;
        }
        dir = parent;
    }
}

export function resolveContext(cwd: string): CliContext | null
{
    const marker = findUp(cwd, MARKER_FILE);
    const workspaceDir = workspaceDirFor(marker);
    if (workspaceDir === null)
    {
        return null;
    }
    const storeDir = join(workspaceDir, STORE_DIR);
    if (!isStore(storeDir))
    {
        throw new CliError(`${workspaceDir} holds no workspace store — run \`self workspace <path>\` to point this machine at one`);
    }
    if (marker === null)
    {
        return { workspaceDir, storeDir };
    }
    return {
        workspaceDir,
        storeDir,
        project: JSON.parse(readFileSync(marker, "utf8")).project,
        projectDir: dirname(marker)
    };
}

// The machine's workspace is the single source. Markers written before that
// carried the path themselves; the first command that meets one adopts it.
export function workspaceDirFor(marker: string | null): string | null
{
    const configured = machineWorkspace();
    if (configured !== null || marker === null)
    {
        return configured;
    }
    const legacy = JSON.parse(readFileSync(marker, "utf8")).workspace;
    if (typeof legacy !== "string" || !isStore(join(legacy, STORE_DIR)))
    {
        return null;
    }
    setMachineWorkspace(legacy);
    return legacy;
}

export function requireWorkspace(cwd: string): CliContext
{
    const ctx = resolveContext(cwd);
    if (ctx === null)
    {
        throw new CliError("this machine has no workspace — run `self init` in the directory that should hold it, or `self workspace <path>` to point at an existing one");
    }
    return ctx;
}

export function requireProject(cwd: string): CliContext & { project: string; projectDir: string }
{
    const ctx = requireWorkspace(cwd);
    if (ctx.project === undefined || ctx.projectDir === undefined)
    {
        throw new CliError("not inside a registered project — run `self project add` in the project directory first");
    }
    return ctx as CliContext & { project: string; projectDir: string };
}

export function projectStateDir(storeDir: string, slug: string): string
{
    return join(storeDir, "projects", slug);
}

export function ensureDir(path: string): string
{
    mkdirSync(path, { recursive: true });
    return path;
}

export function readRegistry(storeDir: string): RegistryEntry[]
{
    return readJsonl(join(storeDir, "registry.jsonl"));
}

export interface StoreConfig
{
    lang?: string;
}

export function readStoreConfig(storeDir: string): StoreConfig
{
    const file = join(storeDir, "config.json");
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

export function readLinks(storeDir: string): Record<string, string>
{
    const links: Record<string, string> = {};
    for (const entry of readJsonl(join(storeDir, LINKS_FILE)))
    {
        links[entry.slug] = entry.path;
    }
    return links;
}

export function resolveProjectPath(storeDir: string, slug: string): string | null
{
    const linked = readLinks(storeDir)[slug];
    if (linked !== undefined)
    {
        return linked;
    }
    const entry = readRegistry(storeDir).find((item) => item.slug === slug);
    return entry?.path ?? null;
}

function readJsonl(file: string): any[]
{
    if (!existsSync(file))
    {
        return [];
    }
    return readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line));
}
