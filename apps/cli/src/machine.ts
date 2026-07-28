import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface MachineConfig
{
    workspace?: string;
}

export function machineConfigPath(): string
{
    const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
    return join(base, "superself", "machine.json");
}

export function readMachineConfig(): MachineConfig
{
    const file = machineConfigPath();
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

// Runner state is machine-local and never synced: it holds process identity,
// raw provider output, and the paths of this machine. The workspace store
// keeps only the sanitized semantic events derived from it.
export function runnerStateDir(): string
{
    const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
    return join(base, "superself", "runner");
}

export function machineWorkspace(): string | null
{
    return readMachineConfig().workspace ?? null;
}

export function setMachineWorkspace(workspaceDir: string): void
{
    const file = machineConfigPath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ ...readMachineConfig(), workspace: workspaceDir }, null, 2) + "\n");
}
