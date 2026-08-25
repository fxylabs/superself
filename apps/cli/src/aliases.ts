// The alias table (#207 A): preset defaults as data, not code. Every preset
// verb resolves its label and default placement through one merged table —
// built-in rows shipping spec §7's defaults, user rows in the workspace
// config.json overriding them or adding verbs of their own — and the
// dispatcher resolves an unknown first token against the same table, so a
// user-added verb records entities exactly as a shipped preset does.
//
// Commands layer: this module declares the `alias` command and the synthetic
// command a table-resolved verb runs as; the entity write itself is
// `state.ts`'s, reached through one shared add path.

import { branch, Command, CommandInput, leaf } from "./contract.js";
import { Exposure, EXPOSURES } from "./entities.js";
import { AliasRow, readStoreConfig, requireWorkspace, StoreConfig } from "./paths.js";
import { retiring } from "./retirement.js";
import { aliasEntityAdd, ALIAS_ADD_OPTIONS, validExposure, validPriority } from "./state.js";
import { commitAll } from "./gitutil.js";
import { CliError, CommandOutput } from "./types.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// The resolved shape a preset verb writes under: the label it records, and
// the placement it defaults to. `priority` absent means "no stated priority",
// which sorts after every stated one (#197 §3).
interface PresetRow
{
    label: string;
    priority?: number;
    exposure: Exposure;
}

// Spec §7's placement defaults, one row per preset verb. `decide` is the verb
// for the decision label; `idea` and `roadmap` have no dedicated command and
// dispatch through the table alone.
const BUILTIN_ROWS: Record<string, PresetRow> = {
    goal: { label: "goal", priority: 0, exposure: "full" },
    objective: { label: "objective", priority: 10, exposure: "full" },
    milestone: { label: "milestone", priority: 20, exposure: "index" },
    convention: { label: "convention", priority: 30, exposure: "full" },
    decide: { label: "decision", priority: 40, exposure: "index" },
    idea: { label: "idea", exposure: "search" },
    roadmap: { label: "roadmap", exposure: "index" },
    work: { label: "work", exposure: "search" }
};

const BUILTIN_VERBS = Object.keys(BUILTIN_ROWS);

// The root command names, handed over by the dispatcher once it has composed
// them: `alias add` refuses them as reserved, and this module cannot import
// the dispatcher to ask. The preset verbs among them are rows, not reserved.
let reservedVerbs: string[] = [];

export function registerReservedVerbs(names: string[]): void
{
    reservedVerbs = names.filter((name) => !BUILTIN_VERBS.includes(name));
}

// The other half of the plugin↔alias collision guard. `app install` refuses a
// plugin whose verb is already an alias row; this refuses an alias row whose
// verb a plugin already claims. Guarding both moments is what lets
// `registerReservedVerbs` keep its module-load snapshot: the collision cannot
// be *created* from either side, so resolution order never has to break a tie
// that should not exist.
//
// Supplied by the dispatcher, for the same reason the reserved list is: this
// module cannot import the loader without the alias table depending on the
// plugin tree.
let pluginClaims: (verb: string) => boolean = () => false;

export function registerPluginClaims(claims: (verb: string) => boolean): void
{
    pluginClaims = claims;
}

/* ── reading the table ─────────────────────────────────────────────── */

// A hand-edited row is validated field by field (#207 A7): a malformed value
// reads as absent — the built-in default, or nothing — never as a crash, and
// invoking after a hand edit behaves exactly as after `alias set`.
function userRow(row: AliasRow | undefined): Partial<PresetRow>
{
    if (row === null || typeof row !== "object")
    {
        return {};
    }
    const read: Partial<PresetRow> = {};
    if (typeof row.label === "string" && row.label.trim() !== "")
    {
        read.label = row.label.trim();
    }
    if (typeof row.priority === "number" && Number.isSafeInteger(row.priority) && row.priority >= 0)
    {
        read.priority = row.priority;
    }
    if ((EXPOSURES as readonly string[]).includes(String(row.exposure)))
    {
        read.exposure = row.exposure as Exposure;
    }
    return read;
}

// The merged table: every built-in row, overridden field-wise by the user's
// row of the same verb, plus every user-added verb.
function aliasTable(config: StoreConfig): Record<string, PresetRow>
{
    const table: Record<string, PresetRow> = { ...BUILTIN_ROWS };
    for (const [verb, row] of Object.entries(config.aliases ?? {}))
    {
        const read = userRow(row);
        const base = BUILTIN_ROWS[verb];
        table[verb] = {
            label: read.label ?? base?.label ?? verb,
            priority: read.priority ?? base?.priority,
            exposure: read.exposure ?? base?.exposure ?? "index"
        };
        // A user row that withdraws the built-in priority cannot say so with
        // a field, so an explicit null in the stored row reads as absent.
        if ((row as { priority?: unknown })?.priority === null)
        {
            delete table[verb].priority;
        }
    }
    return table;
}

// What a preset write verb records under (#207 A1/A3): its row from the
// merged table. Every preset command body reads through here, so `alias set`
// on a built-in changes what the next `goal add` or `decide` records.
export function presetRow(storeDir: string, verb: string): PresetRow
{
    return aliasTable(readStoreConfig(storeDir))[verb] ?? { label: verb, exposure: "index" };
}

/* ── the alias verbs ───────────────────────────────────────────────── */

const ALIAS_ROW_OPTIONS = {
    label: { type: "string" },
    priority: { type: "string" },
    exposure: { type: "string" }
} as const;

const ALIAS_USAGE = "usage: self alias [list] | add <verb> [--label l] [--priority n] [--exposure e] | set <verb> … | drop <verb>";

export const ALIAS_COMMAND: Command = {
    name: "alias",
    usage: [
        {
            syntax: "alias [list]",
            description: ["print the alias table: preset defaults, overrides, custom verbs"],
            verbs: ["", "list"]
        },
        {
            syntax: "alias add <verb> [--label l] [--priority n] [--exposure full|index|search]",
            description: ["add a custom verb: `self <verb> add \"<text>\"` records an entity with these defaults"],
            verbs: ["add"]
        },
        {
            syntax: "alias set <verb> [--label l] [--priority n] [--exposure e]",
            description: ["override a row's defaults — built-in preset rows included"],
            verbs: ["set"]
        },
        {
            syntax: "alias drop <verb>",
            description: ["remove a custom verb, or restore an overridden built-in's shipped default"],
            verbs: ["drop"]
        }
    ],
    detail: [
        "the user-editable table behind the preset verbs (#197 §7). Built-in rows",
        "— goal, objective, milestone, convention, decide, idea, roadmap, work —",
        "are defaults, not constraints: `alias set` overrides one, `alias add`",
        "adds a verb of your own, and every row states the label and default",
        "placement its verb records entities under.",
        "",
        "rows live in the workspace store's config.json; hand-editing the file",
        "and invoking behaves identically to `alias set`. add, set and drop write",
        "the workspace config, so they take no scope flag; list reads the same",
        "table from anywhere in the workspace.",
        "",
        "  --label <text>        the label the verb records (default: the verb itself)",
        "  --priority <n>        default render order: a whole number, 0 first",
        "  --exposure <form>     default render form: full, index, or search"
    ],
    node: branch({
        name: "alias",
        unnamed: "options",
        refusal: ALIAS_USAGE,
        children: [
            leaf("", {}, 0, aliasList),
            leaf("list", {}, 0, aliasList),
            leaf("add", ALIAS_ROW_OPTIONS, 1, (input) => aliasEdit(input, "add")),
            leaf("set", ALIAS_ROW_OPTIONS, 1, (input) => aliasEdit(input, "set")),
            leaf("drop", {}, 1, aliasDrop)
        ]
    })
};

function aliasList(): CommandOutput
{
    const config = readStoreConfig(requireWorkspace(process.cwd()).storeDir);
    const table = aliasTable(config);
    const verbs = Object.keys(table).sort((left, right) => left.localeCompare(right));
    return [{
        kind: "listing",
        rows: verbs.map((verb) => aliasRow(config, table, verb)),
        total: verbs.length,
        noun: "alias",
        nouns: "aliases"
    }];
}

function aliasRow(config: StoreConfig, table: Record<string, PresetRow>, verb: string): string
{
    const row = table[verb];
    const place = `${row.exposure}${row.priority === undefined ? "" : ` p${row.priority}`}`;
    const origin = config.aliases?.[verb] !== undefined
        ? (BUILTIN_ROWS[verb] === undefined ? "custom" : "built-in, overridden")
        : "built-in";
    return `${verb.padEnd(12)} ${row.label.padEnd(12)} ${place.padEnd(10)} (${origin})`;
}

function aliasEdit({ values, positionals }: CommandInput<typeof ALIAS_ROW_OPTIONS>, mode: "add" | "set"): CommandOutput
{
    const ctx = requireWorkspace(process.cwd());
    const verb = validVerb(positionals[0], mode);
    const config = readStoreConfig(ctx.storeDir);
    requireEditable(config, verb, mode);
    if (mode === "set" && values.label === undefined && values.priority === undefined && values.exposure === undefined)
    {
        throw new CliError("alias set changes a row — pass --label, --priority, or --exposure");
    }
    const current = aliasTable(config)[verb];
    const row: AliasRow = {
        label: values.label !== undefined ? requireLabel(values.label) : current?.label ?? verb,
        exposure: values.exposure !== undefined ? validExposure(values.exposure) : current?.exposure ?? "index"
    };
    const priority = values.priority !== undefined ? validPriority(values.priority) : current?.priority;
    if (priority !== undefined)
    {
        row.priority = priority;
    }
    writeAliases(ctx.storeDir, { ...config.aliases, [verb]: row }, `alias ${mode} ${verb}`);
    return [{
        kind: "receipt",
        text: `${verb} now records label "${row.label}" at ${row.exposure}${row.priority === undefined ? "" : ` p${row.priority}`}`
    }];
}

// What `alias add` and `alias set` each demand of the verb: add wants a free
// name, set wants an existing row. A reserved word is refused by name either
// way — a row shadowing `self sync` would make the dispatcher's answer depend
// on the table.
function requireEditable(config: StoreConfig, verb: string, mode: "add" | "set"): void
{
    if (reservedVerbs.includes(verb))
    {
        throw new CliError(`"${verb}" is a built-in command, not an alias — reserved words cannot carry alias rows`,
            "verb_reserved");
    }
    if (mode === "add" && pluginClaims(verb))
    {
        throw new CliError(`"${verb}" is claimed by an installed mini-app — remove it with \`self app remove\` first`,
            "verb_reserved");
    }
    const hasRow = BUILTIN_ROWS[verb] !== undefined || config.aliases?.[verb] !== undefined;
    if (mode === "add" && hasRow)
    {
        throw new CliError(`"${verb}" already has an alias row — override it with \`self alias set ${verb} …\``);
    }
    if (mode === "set" && !hasRow)
    {
        throw new CliError(`"${verb}" has no alias row — add it with \`self alias add ${verb} --label <l>\``);
    }
}

function aliasDrop({ positionals }: CommandInput): CommandOutput
{
    const ctx = requireWorkspace(process.cwd());
    const verb = validVerb(positionals[0], "drop");
    const config = readStoreConfig(ctx.storeDir);
    if (config.aliases?.[verb] === undefined)
    {
        throw new CliError(BUILTIN_ROWS[verb] !== undefined
            ? `"${verb}" carries its shipped default — nothing to drop; override it with \`self alias set ${verb} …\``
            : `"${verb}" has no alias row — run \`self alias\` for the table`);
    }
    const { [verb]: dropped, ...rest } = config.aliases;
    void dropped;
    writeAliases(ctx.storeDir, rest, `alias drop ${verb}`);
    return [{
        kind: "receipt",
        text: BUILTIN_ROWS[verb] !== undefined
            ? `${verb} restored to its shipped default`
            : `${verb} dropped — the verb refuses again`
    }];
}

// The same user-set-policy write the caps use: config.json, committed, never
// event-sourced, and no refold — an alias row changes what the next write
// records, not what any log already says.
function writeAliases(storeDir: string, aliases: Record<string, AliasRow>, message: string): void
{
    const config = { ...readStoreConfig(storeDir), aliases };
    writeFileSync(join(storeDir, "config.json"), JSON.stringify(config) + "\n");
    commitAll(storeDir, message);
}

function validVerb(value: string | undefined, mode: string): string
{
    if (value === undefined || value.trim() === "")
    {
        throw new CliError(`usage: self alias ${mode} <verb>`);
    }
    const verb = value.trim();
    if (!/^[a-z][a-z0-9-]*$/.test(verb))
    {
        throw new CliError(`"${verb}" cannot name a verb — use lowercase letters, digits and dashes, starting with a letter`);
    }
    return verb;
}

function requireLabel(value: string): string
{
    if (value.trim() === "")
    {
        throw new CliError("--label takes the label the verb records — it cannot be empty");
    }
    return value.trim();
}

/* ── the table-resolved verbs ──────────────────────────────────────── */

// The command a table verb with no dedicated body runs as — `self idea`,
// `self roadmap`, and every user-added verb. One synthetic declaration per
// verb, parsed through the same contract machinery as a composed command, so
// the argument gate and the help render hold for these too.
// The help page every alias verb shares. Content, not logic — it is read as
// prose on `self <verb> --help`.
function aliasDetail(verb: string, row: PresetRow): string[]
{
    return [
        `an alias verb over the entity grammar: \`${verb} add\` records one entity`,
        `labeled "${row.label}" with the alias row's default placement. Explicit`,
        "placement flags beat the row's defaults (#197 §7); everything else works",
        "as `self state add` does, retention caps included.",
        "",
        "a write verb: it records into the project it runs in and takes no",
        "--project flag. Read the records back with `self state list`.",
        "",
        "  --label <text>        an extra label beside the row's, repeatable",
        "  --priority <n>        render order, overriding the row's default",
        "  --exposure <form>     full, index, or search, overriding the row's default",
        "  --scope <where>       where it renders: omit for this project, another",
        "                        registered project's slug, or workspace",
        "  --target <date>       a YYYY-MM-DD deadline for the derived views to judge",
        "  --criteria <text>     an exit criterion that gates done claims, repeatable",
        "  --artifact <id|path>  a registered artifact this record points at: an `a-` id this",
        "                        project stores, or a path registered now — one per record",
        "  --link [type:]<id>    typed edge, repeatable, as `state add` takes it",
        "  --why <text>          rationale recorded with the entity",
        "  --proposed            record as a proposal; `state confirm` makes it hold",
        "  --demote <id>         past a retention cap: what frees the room, repeatable"
    ];
}

function aliasCommand(verb: string, row: PresetRow): Command
{
    const place = `${row.exposure}${row.priority === undefined ? "" : ` · priority ${row.priority}`}`;
    return {
        name: verb,
        usage: [
            {
                syntax: `${verb} add "<text>" [--priority n] [--exposure full|index|search] [--scope <slug>|workspace]`,
                description: [`record a ${row.label}-labeled entity (default placement: ${place})`],
                verbs: ["add"]
            }
        ],
        detail: aliasDetail(verb, row),
        node: branch({
            name: verb,
            unnamed: "refuse",
            refusal: `usage: self ${verb} add "<text>" [--priority n] [--exposure full|index|search] [--scope <slug>|workspace]`,
            children: [
                retiring(leaf("add", ALIAS_ADD_OPTIONS, 1, (input) => aliasEntityAdd(row, input)))
            ]
        })
    };
}

// The row a bare unknown token resolves through, or null when it is not an
// alias verb — no workspace, no table row, or a built-in with a dedicated
// command the dispatcher already answered for.
export function resolveAliasCommand(cwd: string, verb: string | undefined): Command | null
{
    if (verb === undefined || verb === "" || verb.startsWith("-") || reservedVerbs.includes(verb))
    {
        return null;
    }
    let storeDir: string;
    try
    {
        storeDir = requireWorkspace(cwd).storeDir;
    }
    catch
    {
        // No workspace resolves here: the unknown-command refusal answers, and
        // it owes no workspace to do so (#207 A6).
        return null;
    }
    const row = aliasTable(readStoreConfig(storeDir))[verb];
    return row === undefined ? null : aliasCommand(verb, row);
}
