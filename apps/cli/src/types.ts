export interface Origin
{
    actor: "agent" | "human";
    session?: string;
    confirmed: boolean;
}

export interface EventRefs
{
    confirms?: string;
    supersedes?: string[];
    work?: string;
    commits?: string[];
    artifacts?: string[];
    // A later evidence event can move one logical assertion onto a rewritten
    // commit without repeating the report or decision itself.
    assertion?: string;
    // The branch the command ran on. History ("this happened here"), never a
    // live pointer: branches get renamed, deleted, and reused.
    branch?: string;
}

export interface SelfEvent
{
    id: string;
    ts: string;
    type: string;
    origin: Origin;
    project: string;
    payload: Record<string, unknown>;
    refs?: EventRefs;
}

export interface ArtifactMeta
{
    id: string;
    name: string;
    path: string;
}

export interface RegistryEntry
{
    slug: string;
    path?: string;
    description?: string;
    added: string;
}

export class CliError extends Error
{
}
