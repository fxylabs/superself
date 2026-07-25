import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CliError, RegistryEntry } from "./types.js";

export const STORE_DIR = ".superself";
export const MARKER_FILE = ".self";

export interface CliContext
{
    workspaceDir: string;
    storeDir: string;
    project?: string;
    projectDir?: string;
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
    if (marker !== null)
    {
        const parsed = JSON.parse(readFileSync(marker, "utf8"));
        return {
            workspaceDir: parsed.workspace,
            storeDir: join(parsed.workspace, STORE_DIR),
            project: parsed.project,
            projectDir: dirname(marker)
        };
    }
    const store = findUp(cwd, STORE_DIR);
    if (store !== null)
    {
        return { workspaceDir: dirname(store), storeDir: store };
    }
    return null;
}

export function requireWorkspace(cwd: string): CliContext
{
    const ctx = resolveContext(cwd);
    if (ctx === null)
    {
        throw new CliError("no workspace found — run `self init` in your workspace directory first");
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
    const file = join(storeDir, "registry.jsonl");
    if (!existsSync(file))
    {
        return [];
    }
    return readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line));
}
