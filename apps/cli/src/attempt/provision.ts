import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Boundary, RunOutcome, runBounded, runBoundedSync } from "./boundary.js";
import { AttemptPlan, MAX_BOUND, ProvisionPlan } from "./plan.js";
import { redact, redactSecrets, RedactionScope, scopeFor } from "./redact.js";
import { PREPARATION_LOG, PROVISION_FILE, Spool, WORKDIR_SUBDIR } from "./spool.js";
import { CliError } from "../types.js";

// The preparation template, versioned in the repository the attempt builds and
// read out of the provisioned worktree at its pinned head — never off the
// runner's own checkout. That is the whole point of reading it there: a
// lockfile-era template rides the commit that needs it, so preparation always
// matches the head being prepared, and a template change is reviewed like any
// other code change.
//
// Named beside the `.self` project marker (`paths.ts` MARKER_FILE) rather than
// under a directory of its own: one file, one concern, and no collision with
// the workspace store's `.superself/`, which is state this repository's own
// rules forbid hand-editing.
export const PREPARATION_FILE = ".self-preparation.json";

// The template format this runner reads. A head whose template declares another
// one is refused rather than half-understood.
const TEMPLATE_VERSION = 1;

// How long one step may take when the template does not say. Long enough for a
// dependency install, short enough that a wedged step is not a wedged night.
const DEFAULT_STEP_TIMEOUT_MS = 600_000;

// How much of a step's output the spool keeps, and how much of it a refusal
// says. Both are tails: what a failing step says about itself is at the end.
const STEP_TAIL = 2_000;
const DETAIL_TAIL = 400;

// How many residue paths the release record names before it stops naming them.
// The count is the finding; the sample is what makes it actionable.
const RESIDUE_SAMPLE = 10;

// One deterministic step of a project's preparation.
export interface PreparationStep
{
    name: string;
    command: string[];
    timeoutMs: number;
}

// What one step did, kept in the spool as part of the attempt's durable record.
export interface StepRecord
{
    step: number;
    name: string;
    command: string[];
    exit: number | null;
    signal: string | null;
    timedOut: boolean;
    durationMs: number;
    // A bounded, redacted tail. Preparation output is unbounded by nature — a
    // dependency install prints a line per package — and the spool keeps the
    // end of it rather than all of it.
    output: string;
}

// What this attempt was bound to. The digest covers the three fields that
// decide which bytes the agent was handed, so a later reader can tell that the
// worktree the preparation ran in is the worktree the provider was given.
export interface WorktreeBinding
{
    attempt: string;
    repo: string;
    remote: string | null;
    head: string;
    workdir: string;
    digest: string;
    // The template that was read at that head, and its bytes' digest. Null when
    // the head carries none, which means worktree provisioning alone.
    template: string | null;
    templateSha256: string | null;
    steps: number;
    prepared: boolean;
    released: boolean;
    created: string;
}

export function bindingOf(spool: Spool): WorktreeBinding | null
{
    return spool.readJson<WorktreeBinding>(PROVISION_FILE);
}

// Everything the runner does to an attempt's execution environment before the
// attempt clock starts: the worktree at the pinned head, the binding on record,
// and the project's own preparation steps in the order the template names them.
//
// A plan that carries no provisioning request leaves here having done nothing,
// which is what every plan written before this existed asks for.
export async function provisionWorkdir(plan: AttemptPlan, spool: Spool, attemptId: string): Promise<WorktreeBinding | null>
{
    const request = plan.provision;
    if (request === undefined)
    {
        return null;
    }
    const workdir = spool.path(WORKDIR_SUBDIR);
    const head = await resolveHead(plan, request);
    await cutWorktree(plan, request, head, workdir);
    // On record before a single step runs. A crash mid-preparation leaves a
    // worktree nobody is holding, and this is the only thing that tells
    // recovery where it is and which repository owns it.
    let binding = bind(attemptId, request, head, workdir);
    spool.writeJson(PROVISION_FILE, binding);
    const template = readTemplate(plan, workdir);
    binding = { ...binding, template: template.file, templateSha256: template.sha256, steps: template.steps.length };
    spool.writeJson(PROVISION_FILE, binding);
    await runSteps(plan, spool, template.steps, workdir);
    binding = { ...binding, prepared: true };
    spool.writeJson(PROVISION_FILE, binding);
    return binding;
}

function bind(attemptId: string, request: ProvisionPlan, head: string, workdir: string): WorktreeBinding
{
    const remote = request.remote ?? null;
    return {
        attempt: attemptId,
        repo: request.repo,
        remote,
        head,
        workdir,
        digest: createHash("sha256").update(JSON.stringify({ repo: request.repo, remote, head })).digest("hex"),
        template: null,
        templateSha256: null,
        steps: 0,
        prepared: false,
        released: false,
        created: new Date().toISOString()
    };
}

// The pinned head, as an object this machine actually holds. A head the
// repository does not have is fetched when the plan named a remote to fetch it
// from, and refused in the operator's terms when it did not.
async function resolveHead(plan: AttemptPlan, request: ProvisionPlan): Promise<string>
{
    if (!existsSync(request.repo))
    {
        throw new CliError(`the attempt cannot be provisioned: "${request.repo}" does not exist on this machine, so there is no repository to cut a worktree from`);
    }
    const local = await git(plan, request, request.repo, ["rev-parse", "--verify", "--quiet", `${request.head}^{commit}`]);
    if (local.code === 0 && local.stdout.trim() !== "")
    {
        return local.stdout.trim();
    }
    if (request.remote === undefined)
    {
        throw new CliError(`the pinned head ${request.head} is not in ${request.repo} and the plan names no remote to fetch it from — add "remote" to the plan's provision block, or fetch that commit into the repository first`);
    }
    return await fetchHead(plan, request);
}

async function fetchHead(plan: AttemptPlan, request: ProvisionPlan): Promise<string>
{
    const remote = request.remote as string;
    const fetched = await git(plan, request, request.repo, ["fetch", "--quiet", "--no-tags", remote, request.head]);
    if (fetched.code !== 0)
    {
        throw new CliError(`the pinned head ${request.head} could not be fetched from ${remote} into ${request.repo}: ${reason(plan, fetched)}`);
    }
    const after = await git(plan, request, request.repo, ["rev-parse", "--verify", "--quiet", `${request.head}^{commit}`]);
    if (after.code !== 0 || after.stdout.trim() === "")
    {
        throw new CliError(`${remote} answered the fetch of ${request.head} but ${request.repo} still does not hold that commit — the head this attempt pins is not a commit on that remote`);
    }
    return after.stdout.trim();
}

async function cutWorktree(plan: AttemptPlan, request: ProvisionPlan, head: string, workdir: string): Promise<void>
{
    // A path derived from the attempt id, so this can only be residue of a
    // provisioning that died before it recorded anything. It is named rather
    // than reused: a directory whose contents nobody can vouch for is not an
    // execution environment.
    if (existsSync(workdir))
    {
        throw new CliError(`the attempt workdir ${workdir} already exists — remove it, then run this attempt again`);
    }
    const added = await git(plan, request, request.repo, ["worktree", "add", "--detach", workdir, head]);
    if (added.code !== 0)
    {
        // Nothing half-provisioned survives a refusal: git leaves a directory
        // behind on some of its own failures, and the binding is not written
        // yet, so this is the only pass that can reach it.
        rmSync(workdir, { recursive: true, force: true });
        throw new CliError(`the attempt workdir could not be cut from ${request.repo} at ${head.slice(0, 12)}: ${reason(plan, added)}`);
    }
}

interface Template
{
    file: string | null;
    sha256: string | null;
    steps: PreparationStep[];
}

// The project's preparation, read at the head it belongs to. No template means
// no steps: worktree provisioning alone, which is a complete answer for a
// project that needs nothing installed.
function readTemplate(plan: AttemptPlan, workdir: string): Template
{
    const file = join(workdir, PREPARATION_FILE);
    if (!existsSync(file))
    {
        return { file: null, sha256: null, steps: [] };
    }
    const bytes = readFileSync(file);
    let raw: any;
    try
    {
        raw = JSON.parse(bytes.toString("utf8"));
    }
    catch (error)
    {
        throw new CliError(`the preparation template ${PREPARATION_FILE} at this head is not valid JSON: ${(error as Error).message}`);
    }
    return {
        file: PREPARATION_FILE,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        steps: templateSteps(plan, raw)
    };
}

function templateSteps(plan: AttemptPlan, raw: any): PreparationStep[]
{
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    {
        throw new CliError(`the preparation template ${PREPARATION_FILE} at this head must be an object with a "steps" array`);
    }
    if (raw.version !== undefined && raw.version !== TEMPLATE_VERSION)
    {
        throw new CliError(`the preparation template ${PREPARATION_FILE} at this head declares version ${JSON.stringify(raw.version)} and this runner reads version ${TEMPLATE_VERSION}`);
    }
    if (!Array.isArray(raw.steps))
    {
        throw new CliError(`the preparation template field "${PREPARATION_FILE} steps" must be an array of preparation steps`);
    }
    return raw.steps.map((entry: any, index: number) => normalizeStep(plan, entry, index));
}

function normalizeStep(plan: AttemptPlan, entry: any, index: number): PreparationStep
{
    const command = entry?.command;
    if (!Array.isArray(command) || command.length === 0 || command.some((token: unknown) => typeof token !== "string" || token === ""))
    {
        throw new CliError(`the preparation template field "${PREPARATION_FILE} steps[${index}].command" must be a non-empty array of strings — the argv of one deterministic step`);
    }
    const timeoutMs = entry.timeoutMs === undefined ? DEFAULT_STEP_TIMEOUT_MS : Number(entry.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_BOUND)
    {
        throw new CliError(`the preparation template field "${PREPARATION_FILE} steps[${index}].timeoutMs" must be a positive number of milliseconds no larger than ${MAX_BOUND}`);
    }
    requireAllowed(plan, command[0]);
    const name = typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name.trim() : command[0];
    return { name, command, timeoutMs };
}

// A step runs under the attempt's own capability boundary or it does not run.
// The tools list is what the plan declared it would reach for, and it is the
// list the forbidden-category gate already judged at admission — so a template
// that arrives at a head with a step nobody granted is refused here, before the
// step, rather than discovered by what it did.
function requireAllowed(plan: AttemptPlan, command: string): void
{
    if (!plan.capabilities.tools.includes(command))
    {
        throw new CliError(`the preparation template at this head runs "${command}", which this attempt's tools allowlist does not carry — a preparation step runs only a command the plan declared`);
    }
}

async function runSteps(plan: AttemptPlan, spool: Spool, steps: PreparationStep[], workdir: string): Promise<void>
{
    const scope = scopeFor(plan.capabilities.secrets);
    for (const [index, step] of steps.entries())
    {
        const started = Date.now();
        // cwd is the provisioned worktree and the environment is the plan's
        // own passthrough: a preparation step sees exactly what the attempt
        // sees, and nothing the runner added for the agent.
        const outcome = await runBounded(inside(plan.boundary, workdir), step.command, step.timeoutMs);
        spool.append(PREPARATION_LOG, record(step, index, outcome, Date.now() - started, scope) as unknown as Record<string, unknown>);
        if (outcome.code !== 0)
        {
            throw new CliError(`preparation step ${index + 1} ("${step.name}") ${failedHow(outcome, step, scope)} — the attempt was not started`);
        }
    }
}

function record(step: PreparationStep, index: number, outcome: RunOutcome, durationMs: number, scope: RedactionScope): StepRecord
{
    return {
        step: index + 1,
        name: step.name,
        command: step.command,
        exit: outcome.code,
        signal: outcome.signal,
        timedOut: outcome.timedOut,
        durationMs,
        output: tail(outcome, scope, STEP_TAIL)
    };
}

function failedHow(outcome: RunOutcome, step: PreparationStep, scope: RedactionScope): string
{
    if (outcome.timedOut)
    {
        return `did not finish within the ${step.timeoutMs}ms the template allows`;
    }
    if (outcome.spawnError !== undefined)
    {
        return `could not be started: ${outcome.spawnError.code ?? outcome.spawnError.message}`;
    }
    return `exited ${outcome.code}: ${tail(outcome, scope, DETAIL_TAIL)}`;
}

// Redacted whole and then cut, never the other way round: cutting first leaves
// the half of a credential that no longer matches any pattern readable in the
// spool for good. The declared scope travels with it, because a step that
// echoes back a value the plan declared is the case no pattern catches.
//
// `redactSecrets` rather than `redact`: this is a machine-local record and the
// paths in it are the ones an operator has to be able to follow. Whatever of it
// crosses into a synced event goes through the home rewrite there.
function tail(outcome: RunOutcome, scope: RedactionScope, limit: number): string
{
    return redactSecrets(`${outcome.stdout}${outcome.stderr}`.trim(), scope).slice(-limit);
}

function reason(plan: AttemptPlan, outcome: RunOutcome): string
{
    if (outcome.timedOut)
    {
        return "git did not answer within the bound the plan allows for provisioning";
    }
    if (outcome.spawnError !== undefined)
    {
        return `git could not be started inside this attempt's boundary (${outcome.spawnError.code ?? outcome.spawnError.message})`;
    }
    const line = outcome.stderr.trim().split("\n").pop() ?? `git exited ${outcome.code}`;
    return redactSecrets(line, scopeFor(plan.capabilities.secrets)).slice(0, DETAIL_TAIL);
}

// The attempt's own boundary, pointed at a directory of the runner's choosing.
// Provisioning and preparation run inside the same wrapper the provider will,
// so a sandbox that denies one denies the other rather than letting preparation
// succeed outside the bound the attempt is held to.
function inside(boundary: Boundary, cwd: string): Boundary
{
    return { ...boundary, cwd };
}

async function git(plan: AttemptPlan, request: ProvisionPlan, cwd: string, argv: string[]): Promise<RunOutcome>
{
    return await runBounded(inside(plan.boundary, cwd), ["git", ...argv], request.timeoutMs);
}

// The residue check and the removal, in the one place that does either. Called
// from every terminal write an attempt can reach — the completion gate, a typed
// failure, a capability block, an open breaker, and recovery — so a provisioned
// worktree outlives its attempt only while that attempt is still live.
//
// Idempotent by the binding it marks: a second caller finds it released and
// does nothing. It never throws, because it is reached from paths whose whole
// job is to record a verdict that has already been decided.
export function releaseWorkdir(plan: AttemptPlan, spool: Spool): void
{
    const binding = bindingOf(spool);
    if (binding === null || binding.released)
    {
        return;
    }
    try
    {
        const residue = residueOf(plan, binding);
        const removed = removeWorktree(plan, binding);
        spool.append("events.jsonl", { event: "workdir.released", residue: residue.length, sample: residue.slice(0, RESIDUE_SAMPLE), removed });
        spool.writeJson(PROVISION_FILE, { ...binding, released: removed });
    }
    catch (error)
    {
        spool.append("events.jsonl", { event: "workdir.unreleased", detail: redact((error as Error).message) });
    }
}

// What the attempt left uncommitted in the worktree it was given. Preparation
// output that the repository ignores does not appear here, which is the point:
// what is left is what the head does not account for, and an attempt that
// stopped before finalizing its outputs says so in this line rather than in
// nobody noticing.
function residueOf(plan: AttemptPlan, binding: WorktreeBinding): string[]
{
    if (!existsSync(binding.workdir))
    {
        return [];
    }
    const status = runBoundedSync(inside(plan.boundary, binding.workdir), ["git", "status", "--porcelain"], plan.provision?.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS);
    return status.code !== 0 ? [] : status.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

// `--force`, because preparation output is expected untracked residue: a
// dependency tree the template installed is exactly what git refuses to remove
// a worktree over, and refusing here would leave every prepared attempt's
// checkout on the disk for ever. The prune afterwards drops the administrative
// entry the removal leaves in the repository when the directory was already
// gone.
function removeWorktree(plan: AttemptPlan, binding: WorktreeBinding): boolean
{
    // The repository the worktree belongs to is gone, so there is no
    // administrative entry left to drop and no git that could reach the
    // checkout. The directory is still this attempt's to take back.
    if (!existsSync(binding.repo))
    {
        rmSync(binding.workdir, { recursive: true, force: true });
        return true;
    }
    const bound = plan.provision?.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    const removed = runBoundedSync(inside(plan.boundary, binding.repo), ["git", "worktree", "remove", "--force", binding.workdir], bound);
    runBoundedSync(inside(plan.boundary, binding.repo), ["git", "worktree", "prune"], bound);
    if (removed.code === 0 || !existsSync(binding.workdir))
    {
        rmSync(binding.workdir, { recursive: true, force: true });
        return true;
    }
    return false;
}
