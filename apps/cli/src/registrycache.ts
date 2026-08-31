// `registry.jsonl` in a server-backed store, and the one fact it holds that a
// git-backed store's copy never did: the server's own id for each project.
//
// That id is what tells "this machine made a project and has never told the
// server" from "the server had this project and does not any more". The two
// look identical from a push — both are a 404 on the slug — and answering the
// second the way the first is answered would raise a project somebody
// deliberately removed, on a machine that had a queue left over. So the id is
// cached the moment a project is created, and its presence is the whole of that
// decision (`pusher.ts`, P6).
//
// Every write here goes through the sync lock's rewrite: the file is replaced
// whole, and a registration the foreground appended while this was deciding is
// carried onto the end rather than dropped. Nothing here writes without a
// nonce, which is the caller saying it holds the lock.
import { join } from "node:path";
import { invalidateResolution, readRegistry } from "./paths.js";
import { publishRewrite } from "./synclock.js";
import { RegistryEntry } from "./types.js";

const REGISTRY_FILE = "registry.jsonl";

// One project as the workspace server describes it. `archived` is derived from
// the project's own events there, and is not cached: this store folds it out of
// the same events, and a cached copy would be a second answer to one question.
export interface ServerProject
{
    id: string;
    slug: string;
    description?: string;
}

export function projectIdOf(storeDir: string, slug: string): string | undefined
{
    return readRegistry(storeDir).find((entry) => entry.slug === slug)?.id;
}

export function cacheProjectId(storeDir: string, slug: string, id: string | undefined, nonce: string): void
{
    if (id === undefined)
    {
        return;
    }
    rewriteRegistry(storeDir, nonce, (rows) => rows.map((row) => row.slug === slug ? { ...row, id } : row));
}

// The workspace's own list, folded onto this machine's copy.
//
// A local row the server does not list is dropped, and there are two reasons it
// might be kept anyway.
//
// Without a cached id it is a project this machine made and has never managed
// to register; dropping it would throw away the registration its own queue is
// still waiting to complete. With records still queued for it, dropping it
// would strand them — nothing iterates a slug the registry does not list, so
// those records would sit in a file no command ever opens again, which is the
// silent loss this whole store design exists to make impossible. `keep` is that
// second list, and its members are told about instead: the push gets the
// server's 404 and writes a refusal a person can read.
export function reconcileRegistry(storeDir: string, projects: ServerProject[], keep: string[], nonce: string): void
{
    const byslug = new Map(projects.map((project) => [project.slug, project]));
    const held = new Set(keep);
    rewriteRegistry(storeDir, nonce, (rows) => [
        ...oncePerSlug(rows).filter((row) => byslug.has(row.slug) || row.id === undefined || held.has(row.slug))
            .map((row) => merged(row, byslug.get(row.slug))),
        ...projects.filter((project) => !rows.some((row) => row.slug === project.slug)).map(added)
    ]);
}

// One row per slug, the first winning — which is the row `projectIdOf` above
// reads, so this folds the list down to the answer every reader was already
// giving.
//
// Two rows for one slug is a state this file can arrive at without anybody
// being wrong. Registering a project is a foreground append, deliberately
// outside the sync lock; a reconciliation that adds the same project the
// workspace has just started listing is a rewrite that carries that append onto
// its end. Neither can see the other. Nothing is lost by the duplicate — every
// lookup is by slug or id — but every walk over the registry visits the project
// twice, which is a notice said twice and a fold run twice, and nothing else
// would ever remove it. So the next reconciliation removes it, here.
function oncePerSlug(rows: RegistryEntry[]): RegistryEntry[]
{
    const first = new Map<string, RegistryEntry>();
    rows.forEach((row) => first.set(row.slug, first.get(row.slug) ?? row));
    return [...first.values()];
}

function merged(row: RegistryEntry, project: ServerProject | undefined): RegistryEntry
{
    if (project === undefined)
    {
        return row;
    }
    // The description is the workspace's, and this row is a cache of it. The
    // checkout path beside it is this machine's own and is never the server's
    // to state, so it survives untouched.
    const { description, ...rest } = { ...row, id: project.id };
    return project.description === undefined ? rest : { ...rest, description: project.description };
}

function added(project: ServerProject): RegistryEntry
{
    const entry: RegistryEntry = { slug: project.slug, added: new Date().toISOString(), id: project.id };
    return project.description === undefined ? entry : { ...entry, description: project.description };
}

// Read, replace, and tell the resolver its cached answer is gone. The read is
// the file's own rather than `readRegistry`'s memoized copy, because the
// rewrite is what the sync lock protects and a value this process worked out
// earlier is not what is on disk.
function rewriteRegistry(storeDir: string, nonce: string, change: (rows: RegistryEntry[]) => RegistryEntry[]): void
{
    publishRewrite(storeDir, join(storeDir, REGISTRY_FILE), nonce, (text) =>
        change(parseRows(text)).map((row) => JSON.stringify(row) + "\n").join(""));
    invalidateResolution();
}

// A line that will not parse stops the rewrite, exactly as it stops every other
// read of this file. The throw leaves the original in place — nothing has been
// renamed yet — so a workspace whose project list is damaged keeps the damaged
// list rather than losing the rows around it to a reconciliation that guessed.
function parseRows(text: string): RegistryEntry[]
{
    return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as RegistryEntry);
}
