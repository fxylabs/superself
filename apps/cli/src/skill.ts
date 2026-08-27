// A named command or recipe, registered once and reused (#391): the light
// middle between a convention, which is a prose rule, and a runbook, which is a
// staged procedure with instances of its own. A skill is the deploy line, the
// flag soup that runs one test file against the right environment, the short
// recipe for the task that comes up every few weeks.
//
// Commands layer — a module beside `runbook.ts` for the same reason: `self
// context` has to read this state and `main.ts` is the dispatcher. Every verb
// here composes records out of the `entity.*` grammar that already exists:
// **no new event type, no new reducer, no new reserved metadata key, no new
// row in `BUILTIN_ROWS`.** A skill is an entity labelled `skill` whose name is
// its text, whose purpose is its `why`, whose one line is the reserved
// `criteria`, and whose longer recipe is the reserved `artifact`.
//
// **Nothing here runs anything.** `self skill run` exists as a refusal and as
// nothing else: this store is synced between machines and clones, so a line it
// holds can be appended anywhere and would execute everywhere. The project
// already paid for a code-execution trust boundary — signed plugin releases,
// pinned roots — and this is not it.

import { existsSync, readFileSync, statSync } from "node:fs";
import { Requirement, required, requireText } from "./args.js";
import { storedDocument } from "./artifact.js";
import { branch, Command, CommandInput, leaf } from "./contract.js";
import { chainHead, EntityState, isCurrent, isLive, rendersIn, scopeTarget } from "./entities.js";
import { ProjectModel, workspaceModels } from "./model.js";
import { notice } from "./output.js";
import { readScopes, requireProject, SCOPE_OPTIONS } from "./paths.js";
import { makeEvent } from "./pipeline.js";
import { recordRetirement, retirementIntent, retiring } from "./retirement.js";
import { firstControlByte } from "./sanitize.js";
import {
    liveSkills,
    malformedPlaceholder,
    placeholdersIn,
    readSkills,
    SKILL_LABEL,
    skillChain,
    SkillReading,
    skillVersion
} from "./skills.js";
import { composedEntityAdd } from "./state.js";
import { oneLine } from "./style.js";
import { CliError, CommandOutput } from "./types.js";

const SKILL_USAGE = 'usage: self skill | add "<name>" --command "<line>" --purpose "<what it is for>"'
    + " | show <id|name> | drop <id|name> --why w";

const ADD_USAGE = 'skill add "<name>" --command "<line>" --purpose "<what it is for>"';
const SHOW_USAGE = "skill show <id|name>";
const DROP_USAGE = 'skill drop <id|name> --why "<why it no longer helps>"';

const EMPTY_LISTING = 'no skills registered — register one with `self skill add "<name>" --command "<line>"'
    + ' --purpose "<what it is for>"`';

const ADD_OPTIONS = {
    // Repeatable so a second one is refused by name (#238's rule): a skill has
    // one line, and a single option would let the parser keep the last value
    // and drop the first without a word.
    command: { type: "string", multiple: true },
    file: { type: "string" },
    purpose: { type: "string" },
    workspace: { type: "boolean" },
    // Declared only so `add` can refuse it by name, the way `convention add`
    // does: --purpose states what a skill is for, --why records why one was
    // dropped, and a flag silently ignored is worse than either.
    why: { type: "string" },
    demote: { type: "string", multiple: true }
} as const;

// The same table, so a flag that states something about a *new* skill is
// refused by name on a withdrawal rather than dropped without a word.
const DROP_OPTIONS = { ...ADD_OPTIONS } as const;

const ADD_PURPOSE: Requirement = {
    flags: ["purpose"], value: "<one line>",
    hint: "what this skill is for, in the one line context carries"
};

const DROP_WHY: Requirement = { flags: ["why"], hint: "why this skill no longer helps" };

// Where a skill renders (§2.1): one index line, priority 50 — the free slot
// between `decide` (40) and `runbook` (60). Module-local, never a row in
// `BUILTIN_ROWS`: `BUILTIN_VERBS` is that table's key set, so a row there
// would mint `self skill` as a preset add verb recording a skill with no body,
// colliding with the real command. `RUNBOOK_ROW` is local for the same reason.
const SKILL_ROW = { label: SKILL_LABEL, exposure: "index" as const, priority: 50 };

export const SKILL_COMMAND: Command = {
    name: "skill",
    usage: [
        {
            syntax: "skill [--project <slug>]",
            description: ["list the skills registered here, and which of them the workspace shares"],
            verbs: ["", "list"]
        },
        {
            syntax: 'skill add "<name>" --command "<line>" --purpose "<what it is for>" [--workspace]',
            description: ["register a reusable line; --file <path> registers a longer markdown recipe instead"],
            verbs: ["add"]
        },
        {
            syntax: "skill show <id|name> [--project <slug>]",
            description: ["print the line or the recipe, ready to use, with the placeholders it declares"],
            verbs: ["show"]
        },
        {
            syntax: 'skill drop <id|name> --why "<why it no longer helps>"',
            description: ["withdraw a skill — a person at a terminal, exactly as any record is withdrawn"],
            verbs: ["drop"]
        }
    ],
    detail: [
        "a skill is operational know-how this project reuses: the exact command that",
        "deploys, the flags that run one test file against the right environment, the",
        "recipe for a task that comes up every few weeks. Registered once, it is in",
        "`self context` as a name and a one-line purpose, so a session that has just",
        "started discovers what exists without being told.",
        "",
        "a skill is printed, never run. This store is synced between machines and",
        "clones, so a line it holds can be appended anywhere and would execute",
        "everywhere; `skill show` hands the line over and the caller runs it.",
        "",
        "the record is the authority, not the file. --file reads a recipe once, at the",
        "moment of the add, and registers its bytes as an artifact; the path is never",
        "recorded, so editing that file afterwards changes nothing. Register the skill",
        "again under the same name to correct it: that proposes a new version",
        "superseding the one that holds, and `self state confirm` is what lands it.",
        "",
        "a placeholder — {{tag}} — is recognised and listed, never filled. There is no",
        "flag that substitutes one: the caller fills it where they paste the line.",
        "",
        "a project skill shadows a workspace skill of the same name, and the shadow is",
        "always disclosed — at the add, in the listing, on the page and in context.",
        "",
        "  --command <line>      the one line this skill is",
        "  --file <path>         a markdown recipe to register instead; read now, never re-read",
        "  --purpose <text>      what the skill is for, in the one line context carries",
        "  --workspace           register at workspace scope: the skill answers in every",
        "                        project; its record stays in this project's store",
        "  --why <text>          why a dropped skill no longer helps; every withdrawal carries one",
        "  --demote <id>         past a retention cap: the confirmed entity that frees its place by",
        "                        moving one tier down (full → index, index → search); repeatable",
        "  --project <slug>      read this registered project instead of this directory's",
        "",
        "list and show read: they answer for the project this directory belongs to, or",
        "for the one --project names. add and drop write, so they take no read-scope",
        "flag and record into the project they run in."
    ],
    // `run` is answered before a verb is chosen, so the refusal reaches the
    // obvious guess without `run` becoming a documented leaf. It is deliberately
    // absent from `usage` above: the refusal is reachable, the promise is not
    // made — the same reasoning `refuseArchiveUndo` is written under.
    guard: (args) => refuseRun(args),
    node: branch({
        name: "skill",
        unnamed: "options",
        refusal: SKILL_USAGE,
        children: [
            leaf("", SCOPE_OPTIONS, 0, skillList),
            leaf("list", SCOPE_OPTIONS, 0, skillList),
            leaf("add", ADD_OPTIONS, 1, skillAdd, { requires: [ADD_PURPOSE] }),
            leaf("show", SCOPE_OPTIONS, 1, skillShow),
            retiring(leaf("drop", DROP_OPTIONS, 1, skillDrop, { requires: [DROP_WHY] }))
        ]
    })
};

function refuseRun(args: string[]): void
{
    if (args[0] !== "run")
    {
        return;
    }
    const named = args[1] === undefined || args[1].startsWith("-") ? "<name>" : args[1];
    throw new CliError("a skill is printed, never run. This store is synced between machines and clones, so a line"
        + " it holds can be appended anywhere and would execute everywhere"
        + ` — run \`self skill show ${named}\` and run the line yourself`);
}

/* ── what an add was given ─────────────────────────────────────────── */

// The record an add is about to compose, once every refusal has been answered.
// Built whole before the project is even resolved, so a malformed call is
// refused the same way on a machine that has no workspace at all.
interface AskedSkill
{
    name: string;
    // The one line, or nothing where the body is a recipe file.
    command?: string;
    // The path a recipe was read from, handed to the raw add so the bytes are
    // registered by the one site that already registers artifact references.
    file?: string;
    purpose: string;
    // The raw verb's own spelling of where the record renders: `workspace`, or
    // nothing for the project the command runs in.
    scope?: string;
}

function requireAdd(values: CommandInput<typeof ADD_OPTIONS>["values"], positionals: string[]): AskedSkill
{
    if (values.why !== undefined)
    {
        throw new CliError("skill add takes no --why — --purpose states what the skill is for;"
            + " --why records why a skill was dropped");
    }
    const name = requireName(positionals[0]);
    return {
        name,
        purpose: required(values.purpose),
        ...(values.workspace === true ? { scope: "workspace" } : {}),
        ...requireBody(values)
    };
}

// A minted record id, and a skill is named by what a person types. Refused
// rather than accepted, because a name shaped like an id would make every
// later `skill show` ambiguous between the record it names and the record it
// looks like.
const RECORD_ID = /^[a-z]-[0-9abcdefghjkmnpqrstvwxyz]{5}$/;

function requireName(named: string | undefined): string
{
    const name = requireText(named, ADD_USAGE).trim();
    if (RECORD_ID.test(name))
    {
        throw new CliError(`"${name}" is shaped like a record id, and a skill is named by what a person types`
            + " — give it a name a reader recognises");
    }
    return name;
}

// One statement of what the skill is, from one source. Naming both at once is
// refused rather than merged: two answers to "what is this skill" is exactly
// the ambiguity the record exists to end.
function requireBody(values: CommandInput<typeof ADD_OPTIONS>["values"]): { command?: string; file?: string }
{
    const lines = values.command ?? [];
    if (values.file !== undefined && lines.length > 0)
    {
        throw new CliError("--command and --file both state what the skill is, and a skill has one body"
            + " — pass the one line with --command, or the recipe that holds it with --file, not both");
    }
    if (lines.length > 1)
    {
        throw new CliError("--command states the one line this skill is, and was passed twice"
            + " — pass a single line, or put the longer recipe in a file and pass it with --file");
    }
    return values.file === undefined ? { command: requireLine(lines[0]) } : { file: requireRecipe(values.file) };
}

function requireLine(named: string | undefined): string
{
    const line = (named ?? "").trim();
    if (line === "")
    {
        throw new CliError("a skill is the line or the recipe it holds, and this one states neither"
            + ` — usage: self ${ADD_USAGE}`);
    }
    if (/[\n\r]/.test(line))
    {
        throw new CliError("--command states the one line this skill is, and was passed several lines"
            + " — pass a single line, or put the longer recipe in a file and pass it with --file");
    }
    requirePlaceholders([line]);
    return line;
}

// The recipe is read here, once, and judged before a single byte is
// registered: every refusal below has to leave the store exactly as it found
// it, and `resolveArtifactRef` writes the artifact the moment it is reached.
function requireRecipe(path: string): string
{
    // A directory is named rather than lumped in with "there is no file there":
    // it is the mistake a caller actually makes, and the answer to it is which
    // file inside they meant. Anything else that is not a regular file — a
    // socket, a device — reads as no recipe at all.
    if (existsSync(path) && statSync(path).isDirectory())
    {
        throw new CliError(`"${path}" is a directory, and a skill's recipe is one file`
            + " — name the file that holds it, or state the one line with --command");
    }
    if (!existsSync(path) || !statSync(path).isFile())
    {
        throw new CliError(`--file names "${path}", and there is no file there`
            + " — give a path relative to this directory, or state the one line with --command");
    }
    const text = readFileSync(path, "utf8");
    requireRecipeText(path, text);
    return path;
}

function requireRecipeText(path: string, text: string): void
{
    if (text.trim() === "")
    {
        throw new CliError(`"${path}" is empty, and an empty recipe tells the next session nothing`
            + " — write the recipe, or state the one line with --command");
    }
    // The same rule `sanitize.ts` holds a recorded value to, applied to bytes
    // that reach the store as an artifact rather than as a payload and so are
    // never handed to that gate: an ESC here would move the cursor of whatever
    // prints the recipe while the width table charges it nothing.
    const control = firstControlByte(text);
    if (control !== undefined)
    {
        throw new CliError(`"${path}" holds the terminal control character U+`
            + `${control.point.toString(16).toUpperCase().padStart(4, "0")} at offset ${control.offset},`
            + " which every surface that prints this recipe would obey instead of showing"
            + " — remove it and register the skill again");
    }
    requirePlaceholders(text.split("\n"));
}

// A record may never promise a hole nobody can find. Judged at the add, where
// the author is still in a position to fix it.
function requirePlaceholders(lines: string[]): void
{
    const malformed = malformedPlaceholder(lines);
    if (malformed !== undefined)
    {
        throw new CliError(`"${malformed}" is not a placeholder a caller can fill`
            + " — write it as {{tag}}: letters, digits, - and _, and no spaces");
    }
}

/* ── registering a skill ───────────────────────────────────────────── */

function skillAdd({ values, positionals }: CommandInput<typeof ADD_OPTIONS>): CommandOutput
{
    const asked = requireAdd(values, positionals);
    const ctx = requireProject(process.cwd());
    const models = workspaceModels(ctx.storeDir, ctx.project);
    const standing = standingVersion(models[0], asked, ctx.project);
    requireMoved(standing, asked);
    const output = composedEntityAdd(SKILL_ROW, reservedOf(asked, standing), {
        why: asked.purpose,
        demote: values.demote,
        scope: asked.scope,
        artifact: asked.file === undefined ? undefined : [asked.file],
        // A replacement is proposed, never asserted: `recordAdd` routes a
        // confirmed supersession through the retirement gate, which an agent
        // cannot satisfy — so an outright displacement would refuse in exactly
        // the case this feature exists for (§2.4). A proposal displaces
        // nothing and reaches no gate; `self state confirm` lands it.
        proposed: standing !== undefined
    }, asked.name);
    disclose(models, ctx.project, asked, standing, output);
    return output;
}

// The version of this name that holds at the scope the add writes to. A skill
// of the same name at the *other* scope is not this: that is a shadow, which
// lands as a record of its own and displaces nothing (§1.6).
function standingVersion(model: ProjectModel, asked: AskedSkill, home: string): EntityState | undefined
{
    const target = asked.scope ?? home;
    return liveSkills(model.entities)
        .find((skill) => skill.text === asked.name && scopeTarget(skill, home) === target);
}

// What the record states beyond its text and its placement. A recipe skill
// carries no criteria — its body is the artifact the raw add registers and
// points the record at, so the retention cap charges the pointer and not the
// document.
function reservedOf(asked: AskedSkill, standing: EntityState | undefined): Record<string, unknown>
{
    const criteria = asked.command === undefined ? [] : [asked.command];
    return standing === undefined
        ? { criteria }
        : { criteria, links: [{ type: "supersedes", target: standing.id }] };
}

// A restatement that changes nothing records nothing: the version numbers
// would move and the skill would not, which is the one thing a version is
// supposed to mean.
//
// Judged for a `--command` skill only. A recipe's bytes are read fresh on
// every add, and comparing them would make this refusal depend on bytes a
// prune is allowed to have removed.
function requireMoved(standing: EntityState | undefined, asked: AskedSkill): void
{
    if (standing === undefined || asked.command === undefined)
    {
        return;
    }
    if (standing.criteria.join("\n") === asked.command && (standing.why ?? "") === asked.purpose)
    {
        throw new CliError(`${standing.id} already states exactly this line and this purpose, so there is nothing`
            + " to replace — change what the skill holds, or leave it as it is");
    }
}

function disclose(models: ProjectModel[], home: string, asked: AskedSkill,
    standing: EntityState | undefined, output: CommandOutput): void
{
    if (standing !== undefined)
    {
        notice(`a new version of "${asked.name}" is proposed and nothing has moved yet`
            + ` — a person lands it with \`self state confirm ${receiptId(output)}\``);
    }
    discloseShadow(models, home, asked);
}

// Two records of one name, both current, is the state this surface allows and
// therefore has to say out loud. Which way round it reads depends on which
// scope the add wrote to: a project skill takes over here, and a workspace
// skill is the one that does not.
function discloseShadow(models: ProjectModel[], home: string, asked: AskedSkill): void
{
    const other = otherScopeSkill(models, home, asked);
    if (other === undefined)
    {
        return;
    }
    notice(asked.scope === "workspace"
        ? `"${asked.name}" is registered at workspace scope, and this project's own "${asked.name}"`
            + ` (${other.id}) still answers here — drop it with \`self skill drop ${asked.name} --why w\``
            + " to let the workspace one through"
        : `this project's "${asked.name}" shadows the workspace skill ${other.id} of the same name`
            + ` — \`self skill show ${asked.name}\` answers with this one here, and the workspace skill`
            + " still answers in every other project");
}

function otherScopeSkill(models: ProjectModel[], home: string, asked: AskedSkill): EntityState | undefined
{
    if (asked.scope === "workspace")
    {
        return liveSkills(models[0].entities)
            .find((skill) => skill.text === asked.name && scopeTarget(skill, home) === home);
    }
    return liveSkills(renderedIn(models, home))
        .find((skill) => skill.text === asked.name && skill.scope === "workspace");
}

function receiptId(output: CommandOutput): string
{
    const block = output[0];
    return block !== undefined && block.kind === "receipt" ? block.text : "";
}

/* ── withdrawing one ───────────────────────────────────────────────── */

function skillDrop({ values, positionals }: CommandInput<typeof DROP_OPTIONS>): CommandOutput
{
    refuseStatingFlags(values);
    const ctx = requireProject(process.cwd());
    const models = workspaceModels(ctx.storeDir, ctx.project);
    const model = models[0];
    refuseForeign(models, positionals[0]);
    const target = requireDroppable(model, positionals[0]);
    const payload = { entity: target.id, why: required(values.why) };
    // Every withdrawal carries its reason, and the gate is the one
    // `convention drop` passes: a person at a terminal, typing the id back.
    recordRetirement(ctx, retirementIntent(model, "retract", [target.id], { why: payload.why }), model,
        (confirmation) => [makeEvent(ctx.project, "entity.retracted",
            confirmation === undefined ? payload : { ...payload, confirmation }, { retracts: target.id }, true)],
        target.text);
    return [{ kind: "receipt", text: `${target.id} "${target.text}" was dropped: ${payload.why}` }];
}

// The option table is declared once for the whole verb, so the subcommand that
// does not take one of these says so by name rather than dropping the flag and
// ignoring what the person meant by it. Each states something about a *new*
// skill, and a withdrawal states none of them.
function refuseStatingFlags(values: CommandInput<typeof DROP_OPTIONS>["values"]): void
{
    if (values.workspace === true)
    {
        throw new CliError("skill drop takes no --workspace — a skill is dropped wherever it renders;"
            + " --workspace states a new skill's scope");
    }
    if (values.command !== undefined || values.file !== undefined)
    {
        throw new CliError("skill drop takes no --command — to change what a skill holds,"
            + " register it again under the same name");
    }
    if (values.purpose !== undefined)
    {
        throw new CliError("skill drop takes no --purpose — a purpose is stated when a skill is registered;"
            + " --why records why it was dropped");
    }
    if (values.demote !== undefined)
    {
        throw new CliError("skill drop takes no --demote — a withdrawal frees a tier rather than filling one");
    }
}

// A workspace skill answers here and its record lives somewhere else, and a
// project cannot append to another project's log. Saying "no skill here answers
// to that" would be false — the name does answer — so the refusal says where
// the record is instead, which is the checkout the drop has to run in.
function refuseForeign(models: ProjectModel[], wanted: string | undefined): void
{
    const asked = requireText(wanted, DROP_USAGE);
    const own = liveSkills(models[0].entities);
    if (own.some((item) => item.id === asked || item.text === asked || item.id.startsWith(asked)))
    {
        return;
    }
    const elsewhere = models.slice(1).find((model) => liveSkills(model.entities)
        .some((item) => (item.id === asked || item.text === asked) && item.scope === "workspace"));
    if (elsewhere !== undefined)
    {
        throw new CliError(`"${asked}" is a workspace skill recorded in project "${elsewhere.slug}", and a project`
            + ` drops only its own records — run \`self skill drop ${asked} --why "<why>"\` in ${elsewhere.slug}'s`
            + " checkout, or register this project's own skill of that name to shadow it here");
    }
}

// The skill a withdrawal acts on: this project's own record, live. A skill
// already withdrawn says which it is rather than reading as one that never
// existed — the first withdrawal is what happened, and a second event pointing
// at it would claim to change a record it cannot.
function requireDroppable(model: ProjectModel, wanted: string | undefined): EntityState
{
    const asked = requireText(wanted, DROP_USAGE);
    const live = liveSkills(model.entities);
    const found = live.find((item) => item.id === asked) ?? live.find((item) => item.text === asked)
        ?? live.find((item) => item.id.startsWith(asked));
    if (found !== undefined)
    {
        return found;
    }
    const gone = model.entities.find((item) => skillChain(model.entities, item.id).length > 0
        && (item.id === asked || item.text === asked) && !isLive(item));
    throw new CliError(gone === undefined
        ? `no skill here answers to "${asked}" — run \`self skill\` to list them`
        : `${gone.id} was already ${gone.status} — it is not a skill that still holds`);
}

/* ── the read verbs ────────────────────────────────────────────────── */

// Every skill that answers in one project: its own records plus every other
// project's workspace-scoped ones. `rendersIn` is the rule the context
// projection already collects by, so a name reaches here exactly where a row
// renders.
function renderedIn(models: ProjectModel[], viewer: string): EntityState[]
{
    return models.flatMap((model) => model.entities.filter((item) => item.status === "confirmed"
        && isCurrent(item) && rendersIn(item, model.slug, viewer)));
}

function skillList({ values }: CommandInput<typeof SCOPE_OPTIONS>): CommandOutput
{
    const scope = readScopes(process.cwd(), values)[0];
    const models = workspaceModels(scope.storeDir, scope.project);
    const readings = readSkills(renderedIn(models, scope.project));
    return [{
        kind: "listing",
        rows: readings.length === 0 ? [EMPTY_LISTING] : listRows(readings),
        total: readings.length,
        noun: "skill"
    }];
}

function listRows(readings: SkillReading[]): string[]
{
    const width = Math.max(...readings.map((reading) => oneLine(reading.name).length));
    return readings.map((reading) => `${reading.skill.id}  ${oneLine(reading.name).padEnd(width)}`
        + `  ${reading.workspace ? "workspace" : "project  "}  ${oneLine(reading.purpose)}`
        + (reading.shadowed ? " (shadowed here)" : ""));
}

// One skill, and the fold that owns it. A workspace skill answers in a project
// whose log does not hold it, so the owner travels with the record: its chain
// is walked in its own fold, and its recipe is read out of its own project's
// artifacts.
interface FoundSkill
{
    skill: EntityState;
    owner: ProjectModel;
    chain: EntityState[];
}

function skillShow({ values, positionals }: CommandInput<typeof SCOPE_OPTIONS>): CommandOutput
{
    const scope = readScopes(process.cwd(), values)[0];
    const models = workspaceModels(scope.storeDir, scope.project);
    const found = requireSkill(models, scope.project, positionals[0]);
    const reading = readSkills(renderedIn(models, scope.project))
        .find((item) => item.skill.id === found.skill.id);
    return [{ kind: "document", plain: () => showLines(scope.storeDir, found, reading) }];
}

// A skill answers to its exact id, to its exact name, or to a prefix of its
// id. A name resolves to this project's own before a workspace one, which is
// the shadowing rule stated as a lookup; every form answers with the version
// that holds, so a caller pointing at a replaced version reads the replacement
// rather than something nothing reaches.
function requireSkill(models: ProjectModel[], viewer: string, wanted: string | undefined): FoundSkill
{
    const asked = requireText(wanted, SHOW_USAGE);
    const owner = matchOwner(models, viewer, asked);
    if (owner === undefined)
    {
        throw new CliError(`no skill here answers to "${asked}" — run \`self skill\` to list them`);
    }
    const chain = skillChain(owner.model.entities, owner.skill.id);
    const head = chainHead(chain);
    if (head === undefined)
    {
        throw new CliError(`${owner.skill.id} is ${owner.skill.status} and no version of it holds`
            + " — register the skill again with `self skill add`");
    }
    return { skill: head, owner: owner.model, chain };
}

function matchOwner(models: ProjectModel[], viewer: string,
    asked: string): { skill: EntityState; model: ProjectModel } | undefined
{
    const rendered = readSkills(renderedIn(models, viewer)).map((reading) => reading.skill);
    const named = rendered.find((item) => item.id === asked)
        ?? rendered.filter((item) => item.text === asked).sort(projectFirst)[0]
        ?? requireOnePrefix(rendered, asked);
    const found = named ?? models.flatMap((model) => model.entities)
        .find((item) => item.id === asked && item.labels.includes(SKILL_LABEL));
    return found === undefined ? undefined : { skill: found, model: ownerOf(models, found) };
}

// A project skill answers before a workspace one of the same name — the
// shadowing rule (§1.6) read as a lookup rather than restated as one.
function projectFirst(left: EntityState, right: EntityState): number
{
    return Number(left.scope === "workspace") - Number(right.scope === "workspace");
}

// A prefix that reaches two skills is refused rather than resolved to
// whichever the fold happened to order first: a command that acts on a
// different record on a different machine is worse than one that asks again.
function requireOnePrefix(rendered: EntityState[], asked: string): EntityState | undefined
{
    const matches = rendered.filter((item) => item.id.startsWith(asked));
    if (matches.length > 1)
    {
        throw new CliError(`skill id "${asked}" is ambiguous (${matches.length} matches) — spell more of it,`
            + " or name the skill");
    }
    return matches[0];
}

function ownerOf(models: ProjectModel[], skill: EntityState): ProjectModel
{
    return models.find((model) => model.entities.some((item) => item.id === skill.id)) ?? models[0];
}

/* ── the page a skill prints ───────────────────────────────────────── */

// The body a page prints, read once so the placeholder list and the block
// below it can never disagree about what the skill holds.
interface SkillBody
{
    heading: string;
    // The pointer line a recipe carries above its block, so a person can open
    // the document itself.
    pointer: string[];
    lines: string[];
    placeholders: string[];
}

function bodyOf(storeDir: string, found: FoundSkill): SkillBody
{
    if (found.skill.artifact === undefined)
    {
        return { heading: "## Command", pointer: [], lines: found.skill.criteria,
            placeholders: placeholdersIn(found.skill.criteria) };
    }
    const id = found.skill.artifact;
    const held = storedDocument(storeDir, found.owner.slug, id);
    const lines = held.text === undefined
        ? [`${found.skill.id} "${found.skill.text}" points at ${held.absent} — the record still names it,`
            + " and `self artifact list` says when and why"]
        : held.text.replace(/\n+$/, "").split("\n");
    return { heading: "## Recipe", pointer: [`- Recipe: ${id} — see \`self artifact open ${id}\``],
        lines, placeholders: held.text === undefined ? [] : placeholdersIn(lines) };
}

function showLines(storeDir: string, found: FoundSkill, reading: SkillReading | undefined): string[]
{
    const body = bodyOf(storeDir, found);
    return [
        `# ${found.skill.id} — ${found.skill.text}`,
        "",
        ...factLines(found, body, reading),
        "",
        body.heading,
        "",
        ...body.lines,
        "",
        "## Versions",
        "",
        ...found.chain.map((version, at) => versionLine(version, at + 1))
    ];
}

function factLines(found: FoundSkill, body: SkillBody, reading: SkillReading | undefined): string[]
{
    const skill = found.skill;
    return [
        `- Purpose: ${skill.why ?? "no purpose recorded"}`,
        `- Scope: ${skill.scope === "workspace" ? "workspace" : `project (${found.owner.slug})`}`,
        `- Version: v${skillVersion(found.chain, skill.id)} of ${found.chain.length}`,
        ...(body.placeholders.length === 0
            ? []
            : [`- Placeholders: ${body.placeholders.map((name) => `{{${name}}}`).join(", ")}`]),
        ...body.pointer,
        ...shadowLines(reading)
    ];
}

// The disclosure the page owes: which record this one answers in place of, or
// that this one is answered for here. Absent where the skill stands alone.
function shadowLines(reading: SkillReading | undefined): string[]
{
    if (reading?.shadows !== undefined)
    {
        return [`- Shadows: ${reading.shadows.id} (workspace) — read it with`
            + ` \`self skill show ${reading.shadows.id}\``];
    }
    return reading?.shadowed === true
        ? ["- Shadowed here: this project's own skill of the same name is what `self skill show` answers with"]
        : [];
}

function versionLine(version: EntityState, at: number): string
{
    const state = version.status === "confirmed" && isLive(version) ? "holds now" : version.status;
    return `- v${at} ${version.id} — ${state}`;
}
