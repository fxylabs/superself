import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface MachineConfig
{
    workspace?: string;
}

export function machineConfigPath(): string
{
    const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
    return join(base, "superself", "machine.json");
}

function readMachineConfig(): MachineConfig
{
    const file = machineConfigPath();
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
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
