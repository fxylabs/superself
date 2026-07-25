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
