// The one relation between projects (#75): this project came from that one.
//
// It is recorded as an entity in the child's log — the label `derivation`, the
// parent's slug in the reserved metadata key `from`, and the reason in `--why`
// — so the relation carries why it was drawn and when it was, and is corrected
// the way every other record is. No `project.*` namespace is minted for it:
// the thing being recorded is a record, and `entity.*` owns records. The slug
// is metadata rather than an `EntityLink` because a link's target is a record
// id, and a parent project is a slug.
//
// Forward resolution — which project this one came from — is a local read of
// this project's own fold. Reverse resolution — which projects came from this
// one — scans the registered projects' folds, which is what `self project`
// already does for a dangling scope.
//
// Commands layer: the `project from` leaf `main.ts` splices into the project
// verb, and the lines `self project` prints under a project's row.

import { Requirement, requireText } from "./args.js";
import { CommandInput, CommandLeaf, leaf } from "./contract.js";
import { DERIVATION_LABEL, derivationOf, EntityState } from "./entities.js";
import { ProjectModel, workspaceModels } from "./model.js";
import { ProjectContext, requireProject, requireRegistered } from "./paths.js";
import { composedEntityAdd } from "./state.js";
import { CliError } from "./types.js";

const FROM_USAGE = 'project from <parent-slug> --why "<why the relation was drawn>"';

const FROM_OPTIONS = {
    why: { type: "string" },
    supersedes: { type: "string" },
    demote: { type: "string", multiple: true }
} as const;

// The relation exists to carry why it was drawn, so the reason is what the
// verb cannot run without — refused by the one gate that names every missing
// option at once, exactly as every other `--why` is.
const FROM_WHY: Requirement = { flags: ["why"], hint: "why this project came from that one" };

// Where the relation renders (R5): one index line, at a low priority — one
// line saying where a project came from is worth a context line, and it is
// read after the direction the project is working toward. It charges the index
// tier like any record; no cap has an exemption for it.
const DERIVATION_ROW = { label: DERIVATION_LABEL, exposure: "index" as const, priority: 50 };

export const PROJECT_FROM_LEAF: CommandLeaf = leaf("from", FROM_OPTIONS, 1, projectFrom, { requires: [FROM_WHY] });

// A write verb: it takes no read-scope flag and records into the project it
// runs in, because "this project came from that one" is the child's own fact.
function projectFrom({ values, positionals }: CommandInput<typeof FROM_OPTIONS>): void
{
    const ctx = requireProject(process.cwd());
    const parent = requireParent(ctx, requireText(positionals[0], FROM_USAGE));
    const models = workspaceModels(ctx.storeDir, ctx.project);
    const supersedes = requireCorrection(derivationOf(models[0].entities), values.supersedes, parent);
    requireNoCycle(models, ctx.project, parent);
    composedEntityAdd(DERIVATION_ROW, { from: parent },
        { why: values.why, supersedes, demote: values.demote }, `came from ${parent}`);
}

/* ── what a relation may name ──────────────────────────────────────── */

// A registered project that is not this one. `workspace` is refused by name —
// it is the scope value that means every registered project (#181 T1.10), so
// it names no single project a relation could point at — and an unregistered
// slug is refused by the one resolver every slug refusal goes through, which
// is what names `self project` as the way to list them.
function requireParent(ctx: ProjectContext, slug: string): string
{
    if (slug === "workspace")
    {
        throw new CliError('"workspace" means every registered project rather than one of them, so no project came from it'
            + " — name the project this one came from, or run `self project` to list the registered slugs");
    }
    if (slug === ctx.project)
    {
        throw new CliError(`"${slug}" is this project, and a project did not come from itself — name the project it came from`);
    }
    return requireRegistered(ctx.storeDir, slug);
}

/* ── the repeat and the correction (R4, R7) ────────────────────────── */

// One relation per project: a second `from` is refused naming the one that
// stands, and `--supersedes` restates it — the same correction path every
// other record kind uses, rather than an idempotency key of its own.
function requireCorrection(existing: EntityState | undefined, wanted: string | undefined, parent: string): string[]
{
    if (wanted === undefined)
    {
        refuseRepeat(existing, parent);
        return [];
    }
    if (existing === undefined || !(existing.id === wanted || existing.id.startsWith(wanted)))
    {
        throw new CliError(`--supersedes here corrects the derivation this project recorded, and "${wanted}" is not it — `
            + (existing === undefined
                ? "this project has recorded none, so record this one without --supersedes"
                : `restate ${existing.id}, which records that this project came from "${existing.from}"`));
    }
    return [existing.id];
}

function refuseRepeat(existing: EntityState | undefined, parent: string): void
{
    if (existing === undefined)
    {
        return;
    }
    const correction = `\`self project from ${parent} --why "<reason>" --supersedes ${existing.id}\``;
    throw new CliError(existing.from === parent
        ? `${existing.id} already records that this project came from "${parent}" — correct it with ${correction}`
        : `${existing.id} records that this project came from "${existing.from}", and a project comes from one place`
            + ` — restate it with ${correction}`);
}

/* ── cycles (R6) ───────────────────────────────────────────────────── */

// Derivation is a claim about origin, and two projects cannot each have come
// from the other, so the chain above the named parent may not lead back here.
// Walked across the registered projects' folds rather than checked as a pair,
// and over live relations only — a superseded one is not an edge. Refusing is
// what lets everything downstream read the chain without defending against a
// loop.
function requireNoCycle(models: ProjectModel[], here: string, parent: string): void
{
    const chain = [parent];
    let at = parentOf(models, parent);
    while (at !== undefined && !chain.includes(at))
    {
        chain.push(at);
        if (at === here)
        {
            throw new CliError(`derivation runs one way, and ${chain.join(" came from ")}`
                + ` — recording that this project came from "${parent}" would close the loop`);
        }
        at = parentOf(models, at);
    }
}

function parentOf(models: ProjectModel[], slug: string): string | undefined
{
    const model = models.find((item) => item.slug === slug);
    return model === undefined ? undefined : derivationOf(model.entities)?.from;
}

/* ── both directions, on the listing ───────────────────────────────── */

// What a project's row in `self project` carries: where it came from, and what
// came from it. The recorded slug is named whether or not a project answers to
// it — a workspace that lost the parent keeps the claim visible instead of
// dropping it silently, and a project registered under that slug later answers
// it again, because the slug is the identity.
export function derivationLines(models: ProjectModel[], model: ProjectModel, registered: Set<string>): string[]
{
    const lines: string[] = [];
    const parent = derivationOf(model.entities)?.from;
    if (parent !== undefined)
    {
        lines.push(registered.has(parent)
            ? `    came from ${parent}`
            : `    came from "${parent}", which is not registered in this workspace`);
    }
    const children = models.filter((item) => derivationOf(item.entities)?.from === model.slug);
    if (children.length > 0)
    {
        lines.push(`    came from it: ${children.map((item) => item.slug).join(", ")}`);
    }
    return lines;
}
