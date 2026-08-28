// The reusable project procedure (#171): register the stages once, run an
// instance of them per piece of work, and read the resume point out of
// `self context`.
//
// Commands layer — a module beside `derivation.ts` rather than a subsystem,
// because `self context` has to read this state and `views.ts` is core. Every
// verb here composes records out of the `entity.*` grammar that already
// exists: **no new event type, no new reducer, no new reserved metadata key.**
// A definition is an entity labelled `runbook` whose stages are its `criteria`;
// an instance is an entity labelled `runbook-run` that copied those stages and
// links `member-of` the edition it started under; passing a stage is one
// `entity.covered` through the same writer `self state cover` uses.
//
// Registering a runbook schedules nothing and dispatches nothing. No verb here
// calls another, no verb advances a stage on its own, and there is no timer.

import { existsSync, readFileSync, statSync } from "node:fs";
import { Requirement, required, requireText } from "./args.js";
import { branch, Command, CommandInput, leaf } from "./contract.js";
import { chainHead, chainVersion, EntityState, isCurrent, isLive, uncoveredCriteria } from "./entities.js";
import { writtenBy } from "./human.js";
import { wrongKindHint } from "./ids.js";
import { buildModel, ProjectModel, workspaceModels } from "./model.js";
import { notice } from "./output.js";
import { readScopes, requireProject, SCOPE_OPTIONS } from "./paths.js";
import { makeEvent, recordEvent } from "./pipeline.js";
import { recordRetirement, retirementIntent } from "./retirement.js";
import { bold } from "./style.js";
import {
    currentStage,
    instanceDefinition,
    instanceKey,
    readInstance,
    runbookChain,
    runbookDefinitions,
    runbookInstances,
    RUNBOOK_LABEL,
    RUNBOOK_RUN_LABEL,
    stageDigest
} from "./runbooks.js";
import { alreadyBlocked, composedEntityAdd, notBlocked, recordCoverage } from "./state.js";
import { CliError, CommandOutput } from "./types.js";

const RUNBOOK_USAGE = 'usage: self runbook | add "<name>" --stage s | show <id|name> | revise <id> --stage s --why w'
    + " | start <id> --instance <key> | advance <key> --why w";

const ADD_USAGE = 'runbook add "<name>" --stage "<first>" --stage "<second>"';
const START_USAGE = "runbook start <id|name> --instance <key>";
const ADVANCE_USAGE = 'runbook advance <key> --why "<what was done>"';

const ADD_OPTIONS = {
    stage: { type: "string", multiple: true },
    file: { type: "string" },
    why: { type: "string" },
    demote: { type: "string", multiple: true }
} as const;

const REVISE_OPTIONS = { ...ADD_OPTIONS } as const;

const START_OPTIONS = { instance: { type: "string" }, demote: { type: "string", multiple: true } } as const;

const ADVANCE_OPTIONS = { to: { type: "string" }, why: { type: "string" } } as const;

const WHY_OPTION = { why: { type: "string" } } as const;

// `--by` names whoever gave the approval, beside the kind of process that
// recorded it. It authorizes nothing on its own — nothing here checks a name.
const APPROVE_OPTIONS = { by: { type: "string" } } as const;

const LINK_OPTIONS = { work: { type: "string" } } as const;

// What each verb cannot run without, declared once for the gate that refuses
// them together and for the help page that states them.
const REVISE_WHY: Requirement = { flags: ["why"], hint: "why the procedure changed" };
const START_INSTANCE: Requirement = { flags: ["instance"], value: "<key>", hint: "the key this run is named by, such as E001" };
const ADVANCE_WHY: Requirement = { flags: ["why"], hint: "what was done to pass this stage" };
const HOLD_WHY: Requirement = { flags: ["why"], hint: "what a person is being asked to approve" };
const STOP_WHY: Requirement = { flags: ["why"], hint: "why the run was given up" };
const LINK_WORK: Requirement = { flags: ["work"], value: "<id>", hint: "the work unit this run's stage is being done in" };

// Where a runbook and a run render (R5): one index line each. Module-local,
// never a row in `BUILTIN_ROWS` — `BUILTIN_VERBS` is that table's key set, so
// a row there would mint `self runbook` and `self runbook-run` as root preset
// verbs that record a definition with no stages or a run with no procedure
// behind it. `derivation.ts` keeps `DERIVATION_ROW` local for the same reason.
//
// Both charge the index tier like any record; no cap has an exemption for them.
const RUNBOOK_ROW = { label: RUNBOOK_LABEL, exposure: "index" as const, priority: 60 };
const RUN_ROW = { label: RUNBOOK_RUN_LABEL, exposure: "index" as const, priority: 60 };

export const RUNBOOK_COMMAND: Command = {
    name: "runbook",
    usage: [
        {
            syntax: "runbook [--project <slug>]",
            description: ["list the procedures this project has registered, and how many runs follow each"],
            verbs: ["", "list"]
        },
        {
            syntax: 'runbook add "<name>" --stage "<first>" --stage "<second>" [--why w]',
            description: ["register a procedure; --file <path> reads the stages from a markdown list instead"],
            verbs: ["add"]
        },
        {
            syntax: "runbook show <id|name> [--project <slug>]",
            description: ["print a procedure, its editions, its stages, and the runs following it"],
            verbs: ["show"]
        },
        {
            syntax: 'runbook revise <id> --stage "<first>" --stage "<second>" --why "<what changed>"',
            description: ["propose a new edition of the procedure; a person lands it with `self state confirm`"],
            verbs: ["revise"]
        },
        {
            syntax: "runbook start <id|name> --instance <key>",
            description: ["start a run of the procedure under a key such as E001"],
            verbs: ["start"]
        },
        {
            syntax: 'runbook advance <key> --why "<what was done>" [--to "<stage>"]',
            description: ["pass the run's current stage; --to names it, and skipping one is refused"],
            verbs: ["advance"]
        },
        {
            syntax: 'runbook hold <key> --why "<what a person is being asked to approve>"',
            description: ["park the run on a person; it waits in context until they answer"],
            verbs: ["hold"]
        },
        {
            syntax: "runbook approve <key> [--by <person>]",
            description: ["release a held run; the event says who approved and what recorded it"],
            verbs: ["approve"]
        },
        {
            syntax: 'runbook stop <key> --why "<why it was given up>" | resume <key>',
            description: ["give the run up, or pick a parked one back up"],
            verbs: ["stop", "resume"]
        },
        {
            syntax: "runbook link <key> --work <id>",
            description: ["state which work unit is carrying this run; one or more"],
            verbs: ["link"]
        }
    ],
    detail: [
        "a runbook is a procedure this project repeats: the stages, in order, kept",
        "as one record instead of scattered across decisions and reports. Every run",
        "of it carries its own place in the procedure, so a session that has just",
        "started reads the resume point out of `self context` alone.",
        "",
        "registering a runbook schedules nothing, dispatches nothing, and advances",
        "nothing on its own. A person starts a run and a person — or the agent they",
        "asked — passes each stage explicitly.",
        "",
        "the record is the authority, not the file. --file reads a stage list out of",
        "a markdown document once, at the moment of the add; editing that file",
        "afterwards changes nothing. To change the procedure, run `runbook revise`,",
        "which proposes a new edition superseding the current one — the person who",
        "confirms it is what makes the change real.",
        "",
        "a run copies the stages of the edition it started under, so a later edition",
        "can never silently change what a run in flight means. Where the two differ,",
        "context says which edition the run is following; it keeps running, because",
        "a revision is something to see, not something that stops the work.",
        "",
        "a runbook is not a work unit's criteria, and the boundary is stated on",
        "both pages so the two cannot drift into two rules: a runbook is a procedure",
        "this project repeats — registered once, run per piece of work, with the same",
        "stages every run. A work unit's criteria are that one unit's completion",
        "conditions: declared on it, judged on it, never run again. If you would",
        "declare the same list on the next unit too, it is a runbook.",
        "",
        "list and show read: they answer for the project this directory belongs to,",
        "or for the one --project names. add, revise, start and advance write, so",
        "they take no read-scope flag and record into the project they run in.",
        "",
        "a run is retracted like any record (`self state retract <id> --why w`), and",
        "closed once every stage is passed with `self state done <id> --report r` —",
        "there is no completion verb here, because done already carries the evidence",
        "gate that a second one would have to implement twice.",
        "",
        "hold parks a run on a person: it waits in context, and advance refuses",
        "until it is released. approve is the release, and a session records it once",
        "the person has answered — the release is `entity.unblocked`, which `self undo`",
        "takes straight back, so the event states whether a person or a session wrote",
        "it rather than demanding a keyboard. --by records who approved and gates",
        "nothing; it authorizes no one on its own.",
        "",
        "  --stage <text>        one stage of the procedure, repeatable; declaration order",
        "                        is the order the run passes them in",
        "  --file <path>         read the stages from the first markdown list in this file",
        "                        instead; the path is read now and never recorded",
        "  --instance <key>      the key this run is named by, such as E001",
        "  --to <stage>          the stage `advance` is passing, stated rather than implied",
        "  --by <person>         who approved a held run, recorded beside the kind of process",
        "                        that wrote the record; it authorizes nothing on its own",
        "  --work <id>           the work unit carrying this run; repeat the verb to name more",
        "  --why <text>          why the procedure changed, what was done to pass a stage,",
        "                        what a hold asks a person to approve, or why a run was stopped",
        "  --demote <id>         past a retention cap: the confirmed entity that frees its place by",
        "                        moving one tier down (full → index, index → search); repeatable",
        "  --project <slug>      read this registered project instead of this directory's"
    ],
    node: branch({
        name: "runbook",
        unnamed: "options",
        refusal: RUNBOOK_USAGE,
        children: [
            leaf("", SCOPE_OPTIONS, 0, runbookList),
            leaf("list", SCOPE_OPTIONS, 0, runbookList),
            leaf("add", ADD_OPTIONS, 1, runbookAdd),
            leaf("show", SCOPE_OPTIONS, 1, runbookShow),
            leaf("revise", REVISE_OPTIONS, 1, runbookRevise, { requires: [REVISE_WHY] }),
            leaf("start", START_OPTIONS, 1, runbookStart, { requires: [START_INSTANCE] }),
            leaf("advance", ADVANCE_OPTIONS, 1, runbookAdvance, { requires: [ADVANCE_WHY] }),
            leaf("hold", WHY_OPTION, 1, runbookHold, { requires: [HOLD_WHY] }),
            leaf("approve", APPROVE_OPTIONS, 1, runbookApprove),
            leaf("stop", WHY_OPTION, 1, runbookStop, { requires: [STOP_WHY] }),
            leaf("resume", {}, 1, runbookResume),
            leaf("link", LINK_OPTIONS, 1, runbookLink, { requires: [LINK_WORK] })
        ]
    })
};

/* ── the stage list a verb was given ───────────────────────────────── */

// One statement of the procedure, from one source. Naming both sources at once
// is refused rather than merged: two answers to "what are the stages" is
// exactly the ambiguity the record is meant to end.
function requireStages(values: { stage?: string[]; file?: string }, usage: string): string[]
{
    if (values.file !== undefined && (values.stage ?? []).length > 0)
    {
        throw new CliError("--stage and --file both state the stage list, and a procedure has one"
            + " — pass the stages with --stage, or pass the file that holds them with --file, not both");
    }
    const stages = values.file !== undefined
        ? stagesFromFile(values.file)
        : (values.stage ?? []).map((stage) => stage.trim());
    return requireDistinct(requireSome(stages, usage));
}

function requireSome(stages: string[], usage: string): string[]
{
    if (stages.length === 0 || stages.some((stage) => stage === ""))
    {
        throw new CliError(`a runbook is its stages, and this one names none — usage: self ${usage}`);
    }
    return stages;
}

// A stage is passed by name, so two stages of one name would leave a coverage
// claim that answers for both and a run that could never say which it is on.
function requireDistinct(stages: string[]): string[]
{
    const repeated = stages.find((stage, at) => stages.indexOf(stage) !== at);
    if (repeated !== undefined)
    {
        throw new CliError(`"${repeated}" is named twice, and a run passes each stage once`
            + " — give the two stages different names");
    }
    return stages;
}

/* ── registering and revising a procedure ──────────────────────────── */

function runbookAdd({ values, positionals }: CommandInput<typeof ADD_OPTIONS>): CommandOutput
{
    const name = requireText(positionals[0], ADD_USAGE);
    const stages = requireStages(values, ADD_USAGE);
    return composedEntityAdd(RUNBOOK_ROW, { criteria: stages }, { why: values.why, demote: values.demote }, name);
}

// A new edition is a new record that supersedes the current one, not an edit
// of the one that stands: `entity.revised` carries text and a reason only, and
// the stages are read once at creation — so a revision event would leave the
// procedure exactly as it was.
//
// It is recorded as a proposal. A proposal displaces nothing, so an agent can
// state the change without destroying anything; the displacement happens when
// a person runs `self state confirm`, which is the decision this surface wants
// a person to make about a procedure the whole project follows.
function runbookRevise({ values, positionals }: CommandInput<typeof REVISE_OPTIONS>): CommandOutput
{
    const ctx = requireProject(process.cwd());
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const head = requireDefinition(model, positionals[0]);
    const stages = requireStages(values, `runbook revise ${head.id} --stage "<first>" --why "<what changed>"`);
    requireMoved(head, stages);
    const output = composedEntityAdd(RUNBOOK_ROW,
        { criteria: stages, links: [{ type: "supersedes", target: head.id }] },
        { why: required(values.why), demote: values.demote, proposed: true }, head.text);
    notice(`a new edition of "${head.text}" is proposed and nothing has moved yet`
        + ` — a person lands it with \`self state confirm ${receiptId(output)}\``);
    return output;
}

// A revision that restates the same stages records nothing: the edition
// numbers would move and the procedure would not, which is the one thing the
// version is supposed to mean.
function requireMoved(head: EntityState, stages: string[]): void
{
    if (stageDigest(head.criteria) === stageDigest(stages))
    {
        throw new CliError(`${head.id} already states exactly these stages, so there is nothing to revise`
            + " — change, add or remove a stage, or leave the edition as it is");
    }
}

function receiptId(output: CommandOutput): string
{
    const block = output[0];
    return block !== undefined && block.kind === "receipt" ? block.text : "";
}

/* ── starting and advancing a run ──────────────────────────────────── */

// The run is recorded confirmed rather than proposed. Coverage refuses a
// record that is still proposed, so a proposed run could not pass its own
// first stage; and starting a run is a statement that the project is following
// the procedure now, which is not a question to put to anyone.
function runbookStart({ values, positionals }: CommandInput<typeof START_OPTIONS>): CommandOutput
{
    const ctx = requireProject(process.cwd());
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const head = requireDefinition(model, positionals[0]);
    const key = requireFreeKey(model, required(values.instance));
    return composedEntityAdd(RUN_ROW,
        { criteria: [...head.criteria], links: [{ type: "member-of", target: head.id }], labels: [RUNBOOK_RUN_LABEL, key] },
        { demote: values.demote }, `${key} — ${head.text}`);
}

// A key names one run inside this project. Uniqueness is not claimed across
// the workspace: the key is a label a person reads, and two projects naming
// their runs E001 is not a collision anything here resolves through.
function requireFreeKey(model: ProjectModel, wanted: string): string
{
    const key = requireText(wanted.trim(), START_USAGE);
    if (/\s/.test(key))
    {
        throw new CliError(`"${key}" has a space in it, and a run key is one word a person types`
            + " — use a short key such as E001");
    }
    const taken = runbookInstances(model.entities).find((run) => instanceKey(run) === key);
    if (taken !== undefined)
    {
        throw new CliError(`${taken.id} is already the run "${key}" in this project — name this one differently`);
    }
    return key;
}

function runbookAdvance({ values, positionals }: CommandInput<typeof ADVANCE_OPTIONS>): CommandOutput
{
    const ctx = requireProject(process.cwd());
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const run = requireMovableRun(model, positionals[0]);
    const stage = requireStage(run, values.to);
    recordCoverage(ctx, model, run.id, stage, required(values.why), {}, "runbook advance");
    return [{ kind: "receipt", text: passedLine(run, stage) }];
}

// What the run's own record says to do next: the stage after this one, or the
// command that closes the run. `state done` is named rather than wrapped — it
// carries the evidence gate, and a wrapper would be a second implementation of
// the gate that could disagree with it.
function passedLine(run: EntityState, stage: string): string
{
    const remaining = uncoveredCriteria(run).filter((item) => item !== stage);
    const key = instanceKey(run);
    return remaining.length === 0
        ? `${key} passed "${stage}" — every stage is passed;`
            + ` close it with \`self state done ${run.id} --report "<what verifiably happened>"\``
        : `${key} passed "${stage}" — next: ${remaining[0]}`;
}

// Which stage this call passes. Named or not, it is always the first
// unpassed one: `--to` states it so a skip is refused by name instead of
// being recorded as progress the run never made.
function requireStage(run: EntityState, wanted: string | undefined): string
{
    const open = uncoveredCriteria(run);
    if (open.length === 0)
    {
        throw new CliError(`${instanceKey(run)} has passed every stage, so there is none left to advance`
            + ` — close it with \`self state done ${run.id} --report "<what verifiably happened>"\``);
    }
    if (wanted === undefined)
    {
        return open[0];
    }
    return requireNamedStage(run, open, wanted);
}

function requireNamedStage(run: EntityState, open: string[], wanted: string): string
{
    if (!run.criteria.includes(wanted))
    {
        throw new CliError(`"${wanted}" is not a stage of ${instanceKey(run)} — it runs: `
            + run.criteria.map((stage) => `"${stage}"`).join(" → "));
    }
    if (!open.includes(wanted))
    {
        throw new CliError(`${instanceKey(run)} already passed "${wanted}" — a stage is passed once`);
    }
    if (wanted !== open[0])
    {
        throw new CliError(`${instanceKey(run)} is on "${open[0]}", and passing "${wanted}" would skip `
            + open.slice(0, open.indexOf(wanted)).map((stage) => `"${stage}"`).join(", ")
            + " — pass the stages in order, or retract the run if the procedure no longer fits");
    }
    return wanted;
}

/* ── the approval checkpoint (§2.4) ────────────────────────────────── */

// Parking the run on a person. An agent calls this — asking for an approval
// destroys nothing and needs no gate of its own — and what it writes is the
// block the entity grammar already has, marked `on: "approval"` so the render
// that lists approval waits can find it.
function runbookHold({ values, positionals }: CommandInput<typeof WHY_OPTION>): CommandOutput
{
    const ctx = requireProject(process.cwd());
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const run = requireLiveRun(model, positionals[0], "hold");
    // The refusal is `state block`'s own, from the one place it is written.
    const standing = alreadyBlocked(run);
    if (standing !== undefined)
    {
        throw new CliError(standing);
    }
    const why = required(values.why);
    recordEvent(ctx, makeEvent(ctx.project, "entity.blocked", { entity: run.id, on: "approval", why }), run.text);
    return [{ kind: "receipt", text: `${instanceKey(run)} waits on a person: ${why}` }];
}

// Releasing it. The hold is a person's to lift, and until #400 that meant a
// person's keyboard: the verb refused a process with no terminal. The hold is
// lifted by an `entity.unblocked` that `self undo` takes straight back, so a
// session records the answer the person already gave it, and the event says
// who wrote it — `--by` names them inside the same field, because who approved
// and what kind of process recorded it are one statement about one event.
function runbookApprove({ values, positionals }: CommandInput<typeof APPROVE_OPTIONS>): CommandOutput
{
    const ctx = requireProject(process.cwd());
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const run = requireLiveRun(model, positionals[0], "approve");
    const clear = notBlocked(run);
    if (clear !== undefined)
    {
        throw new CliError(clear);
    }
    const key = instanceKey(run);
    const payload = { entity: run.id, by: writtenBy(values.by) };
    recordEvent(ctx, makeEvent(ctx.project, "entity.unblocked", payload, undefined, true), run.text);
    return [{ kind: "receipt", text: `${key} is approved and moving again` }];
}

/* ── giving a run up, and picking one back up ──────────────────────── */

// Stopping is `entity.retired` — the working state's own way of saying an
// outcome was given up — so it is terminal by the transition matrix, and E2
// holds that: a stopped run is not resumed, a new one is started.
function runbookStop({ values, positionals }: CommandInput<typeof WHY_OPTION>): CommandOutput
{
    const ctx = requireProject(process.cwd());
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const run = requireLiveRun(model, positionals[0], "stop");
    const why = required(values.why);
    recordRetirement(ctx, retirementIntent(model, "retire", [run.id], { why }), model,
        (by) => [makeEvent(ctx.project, "entity.retired", { entity: run.id, why, by })],
        run.text);
    return [{ kind: "receipt", text: `${instanceKey(run)} was stopped: ${why}` }];
}

// Resume is the working state's `started`, so it answers to the same matrix:
// a stopped or finished run refuses, a held one is released by `approve`
// rather than by picking it back up.
function runbookResume({ positionals }: CommandInput): CommandOutput
{
    const ctx = requireProject(process.cwd());
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const run = requireLiveRun(model, positionals[0], "resume");
    const standing = alreadyBlocked(run);
    if (standing !== undefined)
    {
        throw new CliError(`${standing} — release it with \`self runbook approve ${instanceKey(run)}\``);
    }
    recordEvent(ctx, makeEvent(ctx.project, "entity.started", { entity: run.id }), run.text);
    return [{ kind: "receipt", text: `${instanceKey(run)} is moving again` }];
}

/* ── the work carrying a run ───────────────────────────────────────── */

// One edge per call, `relates` rather than `member-of`: a run is not part of a
// work unit and a work unit is not part of a run — they are two records about
// the same effort, and a run may name more than one.
function runbookLink({ values, positionals }: CommandInput<typeof LINK_OPTIONS>): CommandOutput
{
    const ctx = requireProject(process.cwd());
    const model = buildModel(ctx.storeDir, ctx.project, new Date());
    const run = requireRun(model, positionals[0]);
    const work = requireLinkedWork(model, required(values.work));
    if (run.links.some((link) => link.type === "relates" && link.target === work))
    {
        throw new CliError(`${instanceKey(run)} already names ${work} — one edge is one link`);
    }
    recordEvent(ctx, makeEvent(ctx.project, "entity.linked",
        { entity: run.id, link: { type: "relates", target: work } }, undefined, true), run.text);
    return [{ kind: "receipt", text: `${instanceKey(run)} is carried by ${work}` }];
}

function requireLinkedWork(model: ProjectModel, wanted: string): string
{
    const work = model.works.find((item) => item.id === wanted || item.id.startsWith(wanted));
    if (work === undefined)
    {
        throw new CliError(wrongKindHint(wanted, "work") ?? `unknown work id "${wanted}" — run \`self work\` to list ids`);
    }
    return work.id;
}

/* ── resolving what a verb was pointed at ──────────────────────────── */

// A procedure is named by any id in its chain — the root's, which is the
// stable workflow id, or the current edition's — or by its exact name. All
// three answer with the edition that holds now, so a caller pointing at an
// edition that has already been replaced revises the replacement rather than
// something nothing follows.
function requireDefinition(model: ProjectModel, wanted: string | undefined): EntityState
{
    const id = requireText(wanted, "runbook show <id|name>");
    const found = matchDefinition(model, id);
    if (found === undefined)
    {
        throw new CliError(`no runbook here answers to "${id}" — run \`self runbook\` to list them`);
    }
    const head = chainHead(runbookChain(model.entities, found.id));
    if (head === undefined)
    {
        throw new CliError(`${found.id} is ${found.status} and no edition of it holds`
            + " — register the procedure again with `self runbook add`");
    }
    return head;
}

function matchDefinition(model: ProjectModel, id: string): EntityState | undefined
{
    const live = runbookDefinitions(model.entities);
    return live.find((item) => item.id === id)
        ?? live.find((item) => item.text === id)
        ?? live.find((item) => item.id.startsWith(id))
        ?? model.entities.find((item) => item.id === id && runbookChain(model.entities, item.id).length > 0);
}

// The run a verb acts on, by key or by id, and only while it is still moving:
// a retracted, superseded, finished, stopped or blocked run has nothing to
// advance, and each of those says which it is.
function requireMovableRun(model: ProjectModel, wanted: string | undefined): EntityState
{
    const run = requireLiveRun(model, wanted, "advance");
    const standing = alreadyBlocked(run);
    if (standing !== undefined)
    {
        throw new CliError(`${standing} — approve it with \`self runbook approve ${instanceKey(run)}\``
            + " before passing another stage");
    }
    return run;
}

// A run a working-state verb may still move: terminal states refuse, and each
// says which one it is in. `advance` adds the block check on top of this;
// `approve` and `resume` judge the block themselves.
function requireLiveRun(model: ProjectModel, wanted: string | undefined, verb: string): EntityState
{
    const run = requireRun(model, wanted);
    const status = run.execution?.status;
    if (status === "done" || status === "retired")
    {
        throw new CliError(`${instanceKey(run)} is ${status === "done" ? "closed" : "stopped"}`
            + ` — its working state is terminal, so there is nothing left to ${verb}`);
    }
    if (!isLive(run))
    {
        throw new CliError(`${instanceKey(run)} was ${run.status} — a withdrawn record has no working state to move`);
    }
    return run;
}

function requireRun(model: ProjectModel, wanted: string | undefined): EntityState
{
    const key = requireText(wanted, ADVANCE_USAGE);
    const runs = runbookInstances(model.entities);
    const found = runs.find((run) => instanceKey(run) === key) ?? runs.find((run) => run.id === key);
    if (found === undefined)
    {
        throw new CliError(`no run here answers to "${key}" — run \`self runbook\` to list the procedures and their runs`);
    }
    return found;
}

/* ── the read verbs ────────────────────────────────────────────────── */

function runbookList({ values }: CommandInput<typeof SCOPE_OPTIONS>): CommandOutput
{
    const scope = readScopes(process.cwd(), values)[0];
    const model = workspaceModels(scope.storeDir, scope.project)[0];
    const live = runbookDefinitions(model.entities);
    return [{
        kind: "listing",
        rows: live.length === 0
            ? ['no runbooks registered — register one with `self runbook add "<name>" --stage "<first>" --stage "<second>"`']
            : live.map((definition) => definitionLine(model, definition)),
        total: live.length,
        noun: "runbook"
    }];
}

function definitionLine(model: ProjectModel, definition: EntityState): string
{
    const chain = runbookChain(model.entities, definition.id);
    const running = runsOf(model, chain).filter(isCurrent).length;
    return `${chain[0].id} ${definition.text} v${chainVersion(chain, definition.id)}`
        + ` · ${definition.criteria.length} stages · ${running} running`;
}

// Every run following any edition of this procedure — a run started under v1
// belongs to the chain just as one started under v2 does, which is what lets
// one page say who is on the old edition.
function runsOf(model: ProjectModel, chain: EntityState[]): EntityState[]
{
    const editions = new Set(chain.map((item) => item.id));
    return runbookInstances(model.entities).filter((run) => editions.has(instanceDefinition(run) ?? ""));
}

function runbookShow({ values, positionals }: CommandInput<typeof SCOPE_OPTIONS>): CommandOutput
{
    const scope = readScopes(process.cwd(), values)[0];
    const model = workspaceModels(scope.storeDir, scope.project)[0];
    const head = requireDefinition(model, positionals[0]);
    const chain = runbookChain(model.entities, head.id);
    return [{ kind: "document", plain: () => showLines(model, chain, head) }];
}

function showLines(model: ProjectModel, chain: EntityState[], head: EntityState): string[]
{
    return [
        `# ${chain[0].id} — ${head.text}`,
        "",
        `- Edition: v${chainVersion(chain, head.id)} (${head.id})`,
        `- Stages fingerprint: ${stageDigest(head.criteria)}`,
        "- The record is the authority: to change the procedure run `self runbook revise`, not the file it came from.",
        "",
        "## Stages",
        "",
        ...head.criteria.map((stage, at) => `${at + 1}. ${stage}`),
        "",
        "## Editions",
        "",
        ...chain.map((edition, at) => editionLine(edition, at + 1)),
        "",
        "## Runs",
        "",
        ...runLines(model, chain)
    ];
}

function editionLine(edition: EntityState, version: number): string
{
    const state = edition.status === "confirmed" && isLive(edition) ? "holds now" : edition.status;
    return `- v${version} ${edition.id} — ${state}, ${edition.criteria.length} stages, fingerprint ${stageDigest(edition.criteria)}`;
}

function runLines(model: ProjectModel, chain: EntityState[]): string[]
{
    const runs = runsOf(model, chain);
    if (runs.length === 0)
    {
        return ["no runs yet — start one with `self runbook start " + chain[0].id + " --instance E001`"];
    }
    return runs.map((run) => runLine(model, run));
}

function runLine(model: ProjectModel, run: EntityState): string
{
    const reading = readInstance(model.entities, run);
    const state = run.execution?.status ?? (isCurrent(run) ? "in-progress" : run.status);
    const carried = run.links.filter((link) => link.type === "relates").map((link) => link.target);
    return `- ${reading.key} (${run.id}) — following v${reading.version}, ${reading.at}/${reading.of}`
        + ` ${currentStage(run) ?? "every stage passed"}, ${state}`
        + (carried.length === 0 ? "" : `, carried by ${carried.join(", ")}`);
}

/* ── reading a stage list out of a file (§2.3) ─────────────────────── */

// The file is an input format, never the authority. Its stages are read once,
// here, and the path is not recorded — so a file edited afterwards changes
// nothing, and no reader has to ask whether the record or the file is true.
//
// One shape only: the first block of `- ` or `* ` list items, one stage per
// line. A markdown list can also be numbered, nested, or a task list, and
// guessing which of those a document meant is how a procedure ends up
// silently wrong — anything else is refused, naming `--stage`.
function stagesFromFile(path: string): string[]
{
    if (!existsSync(path) || !statSync(path).isFile())
    {
        throw new CliError(`--file names "${path}", and there is no file there`
            + " — give a path relative to this directory, or state the stages with --stage");
    }
    const stages = firstListBlock(readFileSync(path, "utf8").split("\n"));
    if (stages.length === 0)
    {
        throw new CliError(`no stage list was found in "${path}" — a stage list is a run of "- " or "* " lines,`
            + " one stage each; state the stages with --stage instead");
    }
    return stages;
}

function firstListBlock(lines: string[]): string[]
{
    const stages: string[] = [];
    for (const line of lines)
    {
        const item = /^[-*] +(\S.*)$/.exec(line.trim());
        if (item !== null)
        {
            stages.push(item[1].trim());
        }
        else if (stages.length > 0 && line.trim() !== "")
        {
            return stages;
        }
    }
    return stages;
}
