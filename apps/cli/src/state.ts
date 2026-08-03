// The raw verb of the state engine (#197 §7): record, confirm, retract and
// read entities without a preset. The preset record kinds — goal, decision,
// convention, objective, milestone — keep their own verbs and vocabulary;
// this surface is the extensibility promise: user-defined labels over the
// same record kind, folded by `entities.ts` into one view.

import { requireText } from "./args.js";
import { branch, Command, CommandInput, leaf } from "./contract.js";
import { validDate } from "./dates.js";
import {
    EntityLink,
    EntitySource,
    EntityState,
    EXPOSURES,
    isLive,
    LINK_TYPES,
    LinkType
} from "./entities.js";
import { entityId } from "./ids.js";
import { buildModel, ProjectModel } from "./model.js";
import { readScopes, requireProject, SCOPE_OPTIONS } from "./paths.js";
import { makeEvent, recordEvent } from "./pipeline.js";
import { CliError } from "./types.js";

const STATE_USAGE = 'usage: self state add "<text>" | show <id> | list | confirm <id> | retract <id> --why w';
const ADD_USAGE = 'state add "<text>" [--label l] [--priority n] [--exposure full|index|search] '
    + "[--target YYYY-MM-DD] [--criteria c] [--link [type:]<id>] [--why w] [--proposed]";
const RETRACT_USAGE = 'state retract <id> --why "<why it no longer holds>"';

const ADD_OPTIONS = {
    label: { type: "string", multiple: true },
    priority: { type: "string" },
    exposure: { type: "string" },
    target: { type: "string" },
    criteria: { type: "string", multiple: true },
    link: { type: "string", multiple: true },
    why: { type: "string" },
    proposed: { type: "boolean" }
} as const;

const WHY_OPTION = { why: { type: "string" } } as const;

// A bare `--` is not a listing flag: the contract's unnamed "options" form
// keeps it a subcommand mistake that `subcommand()` explains.
export const STATE_COMMAND: Command = {
    name: "state",
    usage: [
        {
            syntax: "state [--project <slug>]",
            description: [
                "list live entities — the record every stated assertion folds to",
                "(goals, decisions, conventions, objectives, milestones read as entities too)"
            ],
            verbs: ["", "list"]
        },
        {
            syntax: 'state add "<text>" [--label l] [--priority n] [--exposure full|index|search]',
            description: ["record one raw entity; --link supersedes:<id> replaces an earlier one"],
            verbs: ["add"]
        },
        { syntax: "state show <id> [--project <slug>]", description: ["print an entity's current values"], verbs: ["show"] },
        { syntax: "state confirm <id>", description: ["confirm a proposed entity"], verbs: ["confirm"] },
        { syntax: 'state retract <id> --why "<reason>"', description: ["withdraw an entity with nothing replacing it"], verbs: ["retract"] }
    ],
    detail: [
        "the raw record of the state engine: one entity, with free labels, typed",
        "links, reserved metadata, and placement. The preset record kinds — goal,",
        "decision, convention, objective, milestone — fold into the same view, so",
        "`state list` and `state show` answer for them too; their own verbs keep",
        "owning their lifecycle.",
        "",
        "add, confirm and retract write: they take no scope flag and record into",
        "the project they run in. list and show read for the project this directory",
        "resolves to; there is no --workspace form yet — workspace-scoped entities",
        "arrive with a later phase.",
        "",
        "  --label <text>        free label, repeatable; presets use goal, objective, convention, …",
        "  --priority <n>        render order: a whole number, 0 first; leave gaps (0, 10, 20)",
        "  --exposure <form>     how context renders it: full, index, or search",
        "  --target <date>       a YYYY-MM-DD deadline for the derived views to judge",
        "  --criteria <text>     an exit criterion that gates done claims, repeatable",
        "  --link [type:]<id>    typed edge, repeatable: --link supersedes:<id> replaces an",
        "                        earlier entity, member-of:<id> groups, relates:<id> (a bare id) refers",
        "  --why <text>          rationale recorded with the entity, or with its retraction",
        "  --proposed            record as a proposal; `state confirm` makes it hold",
        "  --project <slug>      read this registered project instead of this directory's"
    ],
    node: branch({
        name: "state",
        unnamed: "options",
        refusal: STATE_USAGE,
        children: [
            leaf("", SCOPE_OPTIONS, 0, stateList),
            leaf("list", SCOPE_OPTIONS, 0, stateList),
            leaf("add", ADD_OPTIONS, 1, stateAdd),
            leaf("show", SCOPE_OPTIONS, 1, stateShow),
            leaf("confirm", {}, 1, stateConfirm),
            leaf("retract", WHY_OPTION, 1, stateRetract)
        ]
    })
};

/* ── the write verbs ───────────────────────────────────────────────── */

function stateAdd({ values, positionals }: CommandInput<typeof ADD_OPTIONS>): void
{
    const ctx = requireProject(process.cwd());
    const text = requireText(positionals[0], ADD_USAGE);
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const id = entityId();
    const payload: Record<string, unknown> = {
        entity: id,
        text,
        labels: (values.label ?? []).map((label) => validText(label, "--label", "the label's text")),
        links: parseLinks(model, values.link ?? []),
        criteria: (values.criteria ?? []).map((criterion) => validText(criterion, "--criteria", "one criterion's text")),
        exposure: validExposure(values.exposure ?? "index"),
        scope: "project"
    };
    if (values.priority !== undefined)
    {
        payload.priority = validPriority(values.priority);
    }
    if (values.target !== undefined)
    {
        payload.target = validDate(values.target);
    }
    if (values.why !== undefined)
    {
        payload.why = values.why;
    }
    const proposed = values.proposed === true;
    recordEvent(ctx, makeEvent(ctx.project, proposed ? "entity.proposed" : "entity.confirmed", payload, undefined, !proposed), `${id} ${text}`);
    console.log(id);
}

function stateConfirm({ positionals }: CommandInput): void
{
    const ctx = requireProject(process.cwd());
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const entity = requireEntity(model, positionals[0], "state confirm <id>");
    if (entity.status !== "proposed")
    {
        throw new CliError(`${entity.id} is already ${entity.status}`);
    }
    // Only a decision or an objective can stand proposed among the legacy
    // readings, so the remedy below always has a confirm verb to name.
    if (entity.source !== undefined)
    {
        throw new CliError(`${entity.id} is a ${entity.source} record — run \`self ${entity.source === "decision" ? "decide" : entity.source} confirm ${entity.id}\``);
    }
    recordEvent(ctx, makeEvent(ctx.project, "entity.confirmed", { entity: entity.id }, { confirms: entity.id }, true), entity.text);
}

function stateRetract({ values, positionals }: CommandInput<typeof WHY_OPTION>): void
{
    const ctx = requireProject(process.cwd());
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const entity = requireEntity(model, positionals[0], RETRACT_USAGE);
    if (entity.source !== undefined)
    {
        throw new CliError(`${entity.id} is a ${entity.source} record — ${OWNING_WITHDRAW[entity.source]}`);
    }
    if (!isLive(entity))
    {
        throw new CliError(entity.status === "retracted"
            ? `${entity.id} was already retracted`
            : `${entity.id} was already superseded by ${entity.supersededBy ?? "a later entity"} — nothing is left to retract`);
    }
    const why = requireText(values.why, RETRACT_USAGE);
    recordEvent(ctx, makeEvent(ctx.project, "entity.retracted", { entity: entity.id, why }, { retracts: entity.id }, true), entity.text);
}

// Where each preset record kind's own withdrawal lives, for the refusal that
// points a caller back at the verb owning the record.
const OWNING_WITHDRAW: Record<EntitySource, string> = {
    goal: 'a goal leaves by replacement — `self goal set "<text>"`',
    decision: "run `self decide retract <id> --why w` (or `decide decline` for a proposal)",
    convention: "run `self convention drop <id> --why w`",
    objective: "run `self objective close <id> --as dropped --why w` (or `objective decline` for a proposal)",
    milestone: "run `self milestone drop <id> --why w`"
};

/* ── the read verbs ────────────────────────────────────────────────── */

function stateList({ values }: CommandInput<typeof SCOPE_OPTIONS>): void
{
    const scope = readScopes(process.cwd(), values)[0];
    const live = buildModel(scope.storeDir, scope.project, new Date()).entities.filter(isLive);
    if (live.length === 0)
    {
        console.log("no live entities");
        return;
    }
    for (const entity of ordered(live))
    {
        console.log(stateLine(entity));
    }
}

function stateShow({ values, positionals }: CommandInput<typeof SCOPE_OPTIONS>): void
{
    const scope = readScopes(process.cwd(), values)[0];
    const model = buildModel(scope.storeDir, scope.project, new Date());
    console.log(renderEntity(requireEntity(model, positionals[0], "state show <id> [--project <slug>]")));
}

// Priority order, ties by recency (#197 §6). An absent priority sorts after
// every stated one, and the id breaks the remaining tie so two clones of one
// store render one order.
function ordered(entities: EntityState[]): EntityState[]
{
    return [...entities].sort((left, right) =>
        (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER)
        || right.ts.localeCompare(left.ts)
        || left.id.localeCompare(right.id));
}

function stateLine(entity: EntityState): string
{
    const labels = entity.labels.length === 0 ? "-" : entity.labels.join(",");
    const place = entity.priority === undefined ? entity.exposure : `${entity.exposure} p${entity.priority}`;
    const mark = entity.status === "proposed" ? "  (proposed)" : "";
    return `${entity.id}  ${labels}  ${place}  ${truncate(entity.text, 70)}${mark}`;
}

function renderEntity(entity: EntityState): string
{
    const lines = [
        `${entity.id}  ${entity.status}${entity.source === undefined ? "" : `  (from ${entity.source})`}`,
        `text: ${entity.text}`,
        `labels: ${entity.labels.join(", ") || "-"}`,
        `placement: ${entity.scope} · ${entity.exposure}${entity.priority === undefined ? "" : ` · priority ${entity.priority}`}`
    ];
    optional(lines, "why", entity.why);
    optional(lines, "target", entity.target);
    entity.criteria.forEach((criterion) => lines.push(`criterion: ${criterion}`));
    entity.links.forEach((link) => lines.push(`link: ${link.type} ${link.target}`));
    optional(lines, "superseded by", entity.supersededBy);
    optional(lines, "closed", entity.closedWhy);
    lines.push(`recorded: ${entity.ts.slice(0, 10)}`);
    return lines.join("\n");
}

function optional(lines: string[], name: string, value: string | undefined): void
{
    if (value !== undefined)
    {
        lines.push(`${name}: ${value}`);
    }
}

function truncate(text: string, max: number): string
{
    return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

/* ── argument validation ───────────────────────────────────────────── */

// Exact id first, then a unique prefix — a goal or decision entity carries a
// 26-character event id nobody should have to type whole.
function requireEntity(model: ProjectModel, value: string | undefined, usage: string): EntityState
{
    const wanted = requireText(value, usage);
    const exact = model.entities.find((item) => item.id === wanted);
    if (exact !== undefined)
    {
        return exact;
    }
    const matches = model.entities.filter((item) => item.id.startsWith(wanted));
    if (matches.length > 1)
    {
        throw new CliError(`id "${wanted}" is ambiguous (${matches.length} entities match) — spell more of it`);
    }
    if (matches.length === 0)
    {
        throw new CliError(`unknown entity "${wanted}" — run \`self state list\` for ids`);
    }
    return matches[0];
}

function parseLinks(model: ProjectModel, raw: string[]): EntityLink[]
{
    const links = raw.map((item) => parseLink(model, item));
    for (const [index, link] of links.entries())
    {
        if (links.findIndex((item) => item.type === link.type && item.target === link.target) !== index)
        {
            throw new CliError(`--link ${link.type}:${link.target} is repeated — one edge is one link`);
        }
    }
    return links;
}

// `--link [type:]<id>` — a bare id relates. A supersedes link is the
// replacement transition, so its target must be a live record this verb owns:
// the preset kinds are replaced through their own verbs.
function parseLink(model: ProjectModel, raw: string): EntityLink
{
    const colon = raw.indexOf(":");
    const type = colon < 0 ? "relates" : raw.slice(0, colon);
    const target = colon < 0 ? raw : raw.slice(colon + 1);
    if (!(LINK_TYPES as readonly string[]).includes(type))
    {
        throw new CliError(`"${type}" is not a link type — use member-of:<id>, supersedes:<id>, or relates:<id>`);
    }
    if (target === "")
    {
        throw new CliError(`--link ${raw} names no entity — a link points at another entity's id`);
    }
    const entity = model.entities.find((item) => item.id === target);
    if (entity === undefined)
    {
        throw new CliError(`unknown entity "${target}" — run \`self state list\` for ids`);
    }
    if (type === "supersedes")
    {
        requireSupersedable(entity);
    }
    return { type: type as LinkType, target };
}

function requireSupersedable(entity: EntityState): void
{
    if (entity.source !== undefined)
    {
        throw new CliError(`${entity.id} is a ${entity.source} record — replace it with ${OWNING_REPLACE[entity.source]}`);
    }
    if (!isLive(entity))
    {
        throw new CliError(`${entity.id} was already ${entity.status} — nothing is left to supersede`);
    }
}

// Where each preset record kind's own replacement lives.
const OWNING_REPLACE: Record<EntitySource, string> = {
    goal: '`self goal set "<text>"` (the latest goal supersedes the previous one)',
    decision: '`self decide "<text>" --supersedes <id>`',
    convention: '`self convention add "<text>" --supersedes <id>`',
    objective: '`self objective add "<outcome>" --supersedes <id>`',
    milestone: "`self milestone add … --supersedes <id>`"
};

// Sparse whole numbers (#197 §3): 0 is the top of context and gaps leave room
// to insert later. Anything else is refused rather than rounded.
function validPriority(value: string): number
{
    if (!/^\d+$/.test(value.trim()))
    {
        throw new CliError(`--priority takes a whole number, 0 or higher — "${value}" is not one`);
    }
    return Number(value.trim());
}

function validExposure(value: string): string
{
    if (!(EXPOSURES as readonly string[]).includes(value))
    {
        throw new CliError(`"${value}" is not an exposure — use full (whole text in context), index (one line), or search (found only by search)`);
    }
    return value;
}

function validText(value: string, flag: string, what: string): string
{
    if (value.trim() === "")
    {
        throw new CliError(`${flag} takes ${what} — it cannot be empty`);
    }
    return value.trim();
}
