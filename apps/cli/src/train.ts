import { parseArgs } from "node:util";
import { changeSetId } from "./ids.js";
import {
    ChangeSet,
    IntegrationState,
    Repository,
    coverage,
    openChangeSets,
    repositoryOf,
    runningAttempt,
    short
} from "./integration.js";
import { cmdApprove, cmdAttempt, cmdLease, cmdMerge, cmdObserve, cmdReconcile, strip } from "./lane.js";
import { cmdPromote, cmdTarget } from "./promote.js";
import { ProjectContext } from "./paths.js";
import { makeEvent, recordEvent, setMachineMode } from "./pipeline.js";
import { blue, bold, dim, green, red, styled, yellow } from "./style.js";
import {
    bindDigest,
    loadIntegration,
    printMachine,
    repoDirOf,
    requireChangeSet,
    requireRepository,
    requireText
} from "./trainutil.js";
import { CliError } from "./types.js";

const USAGE = `usage: self integration [status] | register --repo r --base b --head h | show <id> | list | plan
                        | declare <id> | head <id> --head h | close <id> --as superseded|abandoned
                        | target --repo r [--branch b] | lease … | attempt … | observe … | approve <id> --head h
                        | merge <id> | promote … | reconcile`;

export function cmdIntegration(ctx: ProjectContext, rest: string[]): void
{
    setMachineMode(rest.includes("--json"));
    const verb = rest[0] ?? "status";
    const args = rest.slice(1);
    const delegate = DELEGATES[verb];
    if (delegate !== undefined)
    {
        delegate(ctx, args);
        return;
    }
    const local = LOCAL[verb];
    if (local === undefined)
    {
        throw new CliError(USAGE);
    }
    local(ctx, args);
}

const DELEGATES: Record<string, (ctx: ProjectContext, args: string[]) => void> = {
    lease: cmdLease,
    attempt: cmdAttempt,
    observe: cmdObserve,
    approve: cmdApprove,
    merge: cmdMerge,
    target: cmdTarget,
    promote: cmdPromote,
    reconcile: cmdReconcile
};

const LOCAL: Record<string, (ctx: ProjectContext, args: string[]) => void> = {
    status: printStatus,
    register: registerChangeSet,
    show: showChangeSet,
    list: listChangeSets,
    plan: printPlan,
    declare: declareChangeSet,
    head: moveHead,
    close: closeChangeSet
};

/* ── registration ──────────────────────────────────────────────────── */

const REGISTER_OPTIONS = {
    repo: { type: "string" }, base: { type: "string" }, head: { type: "string" },
    pr: { type: "string" }, work: { type: "string" }, domain: { type: "string", multiple: true },
    path: { type: "string", multiple: true }, depends: { type: "string", multiple: true },
    supersedes: { type: "string", multiple: true }, consolidates: { type: "string", multiple: true },
    check: { type: "string", multiple: true }, risk: { type: "string" }, rank: { type: "string" },
    "diff-digest": { type: "string" }, "repo-dir": { type: "string" }, offline: { type: "boolean" },
    json: { type: "boolean" }
} as const;

function registerChangeSet(ctx: ProjectContext, args: string[]): void
{
    const { values } = parseArgs({ args, options: REGISTER_OPTIONS, allowPositionals: true });
    const repository = requireText(values.repo, "integration register --repo <name> --base <sha> --head <sha>");
    const repoDir = repoDirOf(ctx, values["repo-dir"], values.offline === true);
    const binding = bindDigest(repoDir, requireText(values.base, "integration register … --base <sha>"),
        requireText(values.head, "integration register … --head <sha>"), values["diff-digest"], values.path ?? []);
    const id = changeSetId();
    const payload = strip({
        changeSet: id, repository, base: binding.base, head: binding.head, digest: binding.digest,
        digestSource: binding.digestSource, paths: binding.paths, domains: parseDomains(values.domain),
        depends: values.depends ?? [], supersedes: values.supersedes ?? [], consolidates: values.consolidates ?? [],
        checks: values.check ?? [], risk: values.risk, rank: values.rank === undefined ? undefined : Number(values.rank),
        pr: values.pr
    });
    const refs = values.work === undefined ? undefined : { work: values.work };
    recordEvent(ctx, makeEvent(ctx.project, "changeset.registered", payload, refs), `${id} ${repository} ${short(binding.digest)}`);
    if (!printMachine(values.json, { changeSet: id, ...payload }))
    {
        console.log(id);
    }
}

// "supervisor.process-ownership@2": the name is the contract, the version says
// which statement of it this change set was written against.
function parseDomains(values: string[] | undefined): { name: string; version: number }[]
{
    return (values ?? []).map((entry) =>
    {
        const cut = entry.lastIndexOf("@");
        const version = cut === -1 ? 1 : Number(entry.slice(cut + 1));
        if (cut !== -1 && Number.isNaN(version))
        {
            throw new CliError(`--domain "${entry}" must be <name> or <name>@<version>`);
        }
        return { name: cut === -1 ? entry : entry.slice(0, cut), version: cut === -1 ? 1 : version };
    });
}

function declareChangeSet(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseArgs({
        args,
        options: {
            domain: { type: "string", multiple: true }, depends: { type: "string", multiple: true },
            supersedes: { type: "string", multiple: true }, consolidates: { type: "string", multiple: true },
            check: { type: "string", multiple: true }, risk: { type: "string" }, rank: { type: "string" },
            why: { type: "string" }
        },
        allowPositionals: true
    });
    const state = loadIntegration(ctx);
    const changeSet = requireChangeSet(state, positionals[0]);
    const payload = declaration(changeSet, values);
    if (Object.keys(payload).length === 1)
    {
        throw new CliError("integration declare needs at least one of --domain, --depends, --supersedes, --consolidates, --check, --risk, --rank");
    }
    requireWhyForOwnership(values);
    recordEvent(ctx, makeEvent(ctx.project, "changeset.redeclared", payload, undefined, values.consolidates !== undefined),
        `${changeSet.id} ${values.why ?? "redeclared"}`);
}

function declaration(changeSet: ChangeSet, values: Record<string, unknown>): Record<string, unknown>
{
    return strip({
        changeSet: changeSet.id,
        domains: values.domain === undefined ? undefined : parseDomains(values.domain as string[]),
        depends: values.depends, supersedes: values.supersedes, consolidates: values.consolidates,
        checks: values.check, risk: values.risk,
        rank: values.rank === undefined ? undefined : Number(values.rank),
        why: values.why
    });
}

// Consolidation says who owns a contract two change sets both claimed. That is
// a decision, not a note, so it does not go into the log without its reason.
function requireWhyForOwnership(values: Record<string, unknown>): void
{
    if (values.consolidates !== undefined && (values.why === undefined || String(values.why).trim() === ""))
    {
        throw new CliError('--consolidates needs --why "<who owns the contract and what the other side consumes>"');
    }
}

// An author moving the head is not an integration edit: it replaces the bytes
// a review was bound to, and the change review goes back to being owed.
function moveHead(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseArgs({
        args,
        options: {
            head: { type: "string" }, base: { type: "string" }, path: { type: "string", multiple: true },
            "diff-digest": { type: "string" }, "repo-dir": { type: "string" }, offline: { type: "boolean" },
            json: { type: "boolean" }
        },
        allowPositionals: true
    });
    const state = loadIntegration(ctx);
    const changeSet = requireChangeSet(state, positionals[0]);
    requireOpen(changeSet);
    const repoDir = repoDirOf(ctx, values["repo-dir"], values.offline === true);
    const binding = bindDigest(repoDir, values.base ?? changeSet.base,
        requireText(values.head, "integration head <change-set> --head <sha>"), values["diff-digest"], values.path ?? []);
    const payload = strip({
        changeSet: changeSet.id, base: binding.base, head: binding.head, digest: binding.digest,
        digestSource: binding.digestSource, paths: binding.paths, by: "author"
    });
    recordEvent(ctx, makeEvent(ctx.project, "changeset.head_moved", payload), `${changeSet.id} ${short(binding.head)}`);
    reportHeadMove(changeSet, binding.digest, values.json);
}

function reportHeadMove(changeSet: ChangeSet, digest: string, json: boolean | undefined): void
{
    const preserved = digest === changeSet.featureDigest;
    const result = { changeSet: changeSet.id, digest, receiptsPreserved: preserved };
    if (printMachine(json, result))
    {
        return;
    }
    console.log(preserved
        ? "the feature bytes are unchanged — every receipt stands"
        : `feature bytes changed to ${short(digest)} — the change review is owed again`);
}

function closeChangeSet(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseArgs({
        args, options: { as: { type: "string" }, why: { type: "string" } }, allowPositionals: true
    });
    const state = loadIntegration(ctx);
    const changeSet = requireChangeSet(state, positionals[0]);
    requireOpen(changeSet);
    if (values.as !== "superseded" && values.as !== "abandoned")
    {
        throw new CliError("integration close requires --as superseded|abandoned");
    }
    const payload = strip({ changeSet: changeSet.id, as: values.as, why: values.why });
    recordEvent(ctx, makeEvent(ctx.project, "changeset.closed", payload, undefined, true), `${changeSet.id} ${values.as}`);
}

function requireOpen(changeSet: ChangeSet): void
{
    if (changeSet.merge !== undefined || changeSet.closed !== undefined)
    {
        throw new CliError(`${changeSet.id} is ${changeSet.phase} — a closed change set does not move`);
    }
}

/* ── read surfaces ─────────────────────────────────────────────────── */

function listChangeSets(ctx: ProjectContext, args: string[]): void
{
    const { values } = parseArgs({ args, options: { repo: { type: "string" }, json: { type: "boolean" }, all: { type: "boolean" } } });
    const state = loadIntegration(ctx);
    const rows = selected(state, values.repo, values.all === true).map(summary);
    if (printMachine(values.json, rows))
    {
        return;
    }
    for (const row of rows)
    {
        console.log(`${row.changeSet}  ${row.repository}  ${row.phase.padEnd(20)}  ${row.pr ?? "-"}  ${row.reason}`);
    }
    if (rows.length === 0)
    {
        console.log("no change sets — register one with `self integration register --repo <name> --base <sha> --head <sha>`");
    }
}

function selected(state: IntegrationState, repo: string | undefined, all: boolean): ChangeSet[]
{
    const pool = all ? state.changeSets : openChangeSets(state);
    const scoped = repo === undefined ? pool : pool.filter((item) => item.repository === repo);
    return [...scoped].sort((a, b) => a.repository.localeCompare(b.repository) || a.order - b.order);
}

interface ChangeSetSummary
{
    changeSet: string;
    repository: string;
    pr?: string;
    work?: string;
    order: number;
    phase: string;
    reason: string;
    head: string;
    base: string;
    digest: string;
    digestSource: string;
    predecessors: string[];
    blockers: { code: string; detail: string; next: string }[];
    next: string;
}

function summary(changeSet: ChangeSet): ChangeSetSummary
{
    return {
        changeSet: changeSet.id,
        repository: changeSet.repository,
        pr: changeSet.pr,
        work: changeSet.work,
        order: changeSet.order,
        phase: changeSet.phase,
        reason: changeSet.reason,
        head: changeSet.head,
        base: changeSet.base,
        digest: changeSet.featureDigest,
        digestSource: changeSet.digestSource,
        predecessors: changeSet.predecessors,
        blockers: changeSet.blockers,
        next: changeSet.next
    };
}

function showChangeSet(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseArgs({ args, options: { json: { type: "boolean" } }, allowPositionals: true });
    const state = loadIntegration(ctx);
    const changeSet = requireChangeSet(state, positionals[0]);
    const detail = { ...summary(changeSet), ...detailOf(changeSet) };
    if (printMachine(values.json, detail))
    {
        return;
    }
    printDetail(changeSet, detail);
}

function detailOf(changeSet: ChangeSet): Record<string, unknown>
{
    const cover = coverage(changeSet);
    return {
        paths: changeSet.paths,
        domains: changeSet.domains.map((domain) => `${domain.name}@${domain.version}`),
        depends: changeSet.depends,
        supersedes: changeSet.supersedes,
        consolidates: changeSet.consolidates,
        checks: changeSet.checks,
        risk: changeSet.risk,
        pathOverlaps: changeSet.pathOverlaps,
        semanticOverlaps: changeSet.semanticOverlaps,
        receipts: changeSet.receipts.map((receipt) => ({
            receipt: receipt.id, scope: receipt.scope, verdict: receipt.verdict, digest: receipt.digest,
            head: receipt.head, model: receipt.model, artifact: receipt.artifact?.path,
            envelopeDigest: receipt.envelopeDigest, current: receipt.id === cover.anchor?.id
                || cover.chain.some((delta) => delta.digest === receipt.digest)
        })),
        deltas: changeSet.deltas.map((delta) => ({
            delta: delta.id, digest: delta.digest, from: delta.fromDigest, result: delta.resultDigest,
            paths: delta.paths, intersections: delta.intersections,
            reviewed: !changeSet.uncoveredDeltas.includes(delta.id)
        })),
        attempts: changeSet.attempts,
        approvals: changeSet.approvals,
        ci: changeSet.ci,
        merge: changeSet.merge
    };
}

function printDetail(changeSet: ChangeSet, detail: Record<string, unknown>): void
{
    console.log(`${bold(changeSet.id)} ${changeSet.repository}${changeSet.pr === undefined ? "" : ` #${changeSet.pr}`} — ${phaseStyle(changeSet.phase)}`);
    console.log(`  ${changeSet.reason}`);
    console.log(`  base ${short(changeSet.base)} head ${short(changeSet.head)} digest ${short(changeSet.featureDigest)} (${changeSet.digestSource})`);
    line("domains", (detail.domains as string[]).join(", "));
    line("paths", changeSet.paths.join(", "));
    line("depends", changeSet.depends.join(", "));
    line("predecessors", changeSet.predecessors.join(", "));
    line("path overlaps", changeSet.pathOverlaps.map((item) => `${item.changeSet} (${item.paths.length})`).join(", "));
    line("semantic overlaps", changeSet.semanticOverlaps.map((item) => `${item.changeSet}: ${item.domains.join(", ")}`).join(", "));
    for (const receipt of changeSet.receipts)
    {
        console.log(`  receipt ${receipt.id} ${receipt.scope} ${receipt.verdict} ${short(receipt.digest)} by ${receipt.model}`);
    }
    for (const delta of changeSet.deltas)
    {
        const state = changeSet.uncoveredDeltas.includes(delta.id) ? "awaiting bounded review" : "reviewed";
        console.log(`  delta ${delta.id} ${short(delta.digest)} — ${state}`);
    }
    for (const blocker of changeSet.blockers)
    {
        console.log(styled ? `  ${yellow(blocker.code)} ${blocker.detail}` : `  ${blocker.code} ${blocker.detail}`);
    }
    console.log(`  next: ${changeSet.next}`);
}

function line(label: string, value: string): void
{
    if (value !== "")
    {
        console.log(styled ? `  ${dim(label)}: ${value}` : `  ${label}: ${value}`);
    }
}

/* ── status ────────────────────────────────────────────────────────── */

function printStatus(ctx: ProjectContext, args: string[]): void
{
    const { values } = parseArgs({ args, options: { repo: { type: "string" }, json: { type: "boolean" } } });
    const state = loadIntegration(ctx);
    if (printMachine(values.json, state.repositories.map((repository) => repositoryView(state, repository))))
    {
        return;
    }
    if (state.changeSets.length === 0)
    {
        console.log("no integration train — register a change set with `self integration register`");
        return;
    }
    for (const repository of state.repositories.filter((item) => values.repo === undefined || item.name === values.repo))
    {
        printRepository(state, repository);
    }
}

function repositoryView(state: IntegrationState, repository: Repository): Record<string, unknown>
{
    return {
        repository: repository.name,
        lease: repository.lease,
        mainHead: repository.mainHead,
        train: repository.train
            .map((id) => state.changeSets.find((item) => item.id === id))
            .filter((item): item is ChangeSet => item !== undefined)
            .map(summary)
    };
}

function printRepository(state: IntegrationState, repository: Repository): void
{
    const lease = repository.lease;
    const holder = lease !== undefined && lease.live
        ? `lease ${lease.holder} fence ${lease.fence}`
        : "no live lease";
    console.log(`${bold(repository.name)}  ${dim(holder)}${repository.mainHead === undefined ? "" : dim(`  main ${short(repository.mainHead)}`)}`);
    const members = repository.train
        .map((id) => state.changeSets.find((item) => item.id === id))
        .filter((item): item is ChangeSet => item !== undefined);
    const train = members.filter((item) => item.closed === undefined && item.merge === undefined);
    for (const changeSet of train)
    {
        const pr = changeSet.pr === undefined ? "" : ` #${changeSet.pr}`;
        console.log(`  ${changeSet.order + 1}. ${changeSet.id}${pr}  ${phaseStyle(changeSet.phase)}  ${changeSet.reason}`);
    }
    const landed = members.filter((item) => item.merge !== undefined);
    if (train.length === 0)
    {
        console.log(dim("  nothing open"));
    }
    if (landed.length > 0)
    {
        console.log(dim(`  ${landed.length} merged: ${landed.map((item) => `${item.id} ${phaseStyle(item.phase)}`).join(", ")}`));
    }
}

function phaseStyle(phase: string): string
{
    if (!styled)
    {
        return phase;
    }
    if (phase === "blocked_policy")
    {
        return red(phase);
    }
    if (phase === "merge_ready" || phase === "merged")
    {
        return green(phase);
    }
    if (phase === "integration" || phase === "delta_review")
    {
        return blue(phase);
    }
    return yellow(phase);
}

/* ── plan ──────────────────────────────────────────────────────────── */

// The dry run. It mutates nothing, and it answers the two questions an agent
// asks before touching a repository: whose turn is it, and which receipts
// still stand.
function printPlan(ctx: ProjectContext, args: string[]): void
{
    const { values } = parseArgs({ args, options: { repo: { type: "string" }, json: { type: "boolean" } } });
    const state = loadIntegration(ctx);
    const repositories = values.repo === undefined ? state.repositories : [requireRepository(state, values.repo)];
    const plans = repositories.map((repository) => planFor(state, repository));
    if (printMachine(values.json, plans))
    {
        return;
    }
    for (const plan of plans)
    {
        printPlanLines(plan);
    }
}

interface PlanItem
{
    order: number;
    changeSet: string;
    pr?: string;
    phase: string;
    reason: string;
    predecessors: string[];
    eligible: boolean;
    integrating: boolean;
    preserved: string[];
    invalidated: string[];
    pendingDeltas: string[];
    next: string;
}

interface Plan
{
    repository: string;
    lease: string;
    mainHead?: string;
    items: PlanItem[];
    nextEligible?: string;
}

function planFor(state: IntegrationState, repository: Repository): Plan
{
    const items = repository.train
        .map((id) => state.changeSets.find((item) => item.id === id))
        .filter((item): item is ChangeSet => item !== undefined && item.closed === undefined && item.merge === undefined)
        .map(planItem);
    const lease = repository.lease;
    return {
        repository: repository.name,
        lease: lease === undefined ? "none" : `${lease.holder} fence ${lease.fence} ${lease.live ? "live" : "not live"}`,
        mainHead: repository.mainHead,
        items,
        nextEligible: items.find((item) => item.eligible)?.changeSet
    };
}

function planItem(changeSet: ChangeSet): PlanItem
{
    const cover = coverage(changeSet);
    const preserved = changeSet.receipts.filter((receipt) => receipt.id === cover.anchor?.id
        || cover.chain.some((delta) => delta.digest === receipt.digest));
    return {
        order: changeSet.order + 1,
        changeSet: changeSet.id,
        pr: changeSet.pr,
        phase: changeSet.phase,
        reason: changeSet.reason,
        predecessors: changeSet.predecessors,
        eligible: changeSet.predecessors.length === 0 && changeSet.phase !== "blocked_policy",
        integrating: runningAttempt(changeSet) !== undefined,
        preserved: preserved.map((receipt) => `${receipt.id} ${receipt.scope}`),
        invalidated: changeSet.receipts.filter((receipt) => !preserved.includes(receipt))
            .map((receipt) => `${receipt.id} ${receipt.scope} bound to ${short(receipt.digest)}`),
        pendingDeltas: changeSet.uncoveredDeltas,
        next: changeSet.next
    };
}

function printPlanLines(plan: Plan): void
{
    console.log(`${bold(plan.repository)}  ${dim(`lease ${plan.lease}`)}`);
    for (const item of plan.items)
    {
        console.log(`  ${item.order}. ${item.changeSet}  ${phaseStyle(item.phase)}${item.eligible ? "" : dim("  (waiting)")}`);
        console.log(`     ${item.reason}`);
        line("     receipts preserved", item.preserved.join(", "));
        line("     receipts invalidated", item.invalidated.join(", "));
        line("     deltas awaiting review", item.pendingDeltas.join(", "));
        console.log(`     next: ${item.next}`);
    }
    console.log(`  next eligible: ${plan.nextEligible ?? "nothing — every open item is waiting"}`);
    // Phase is not the test here: several items sit in `integration` merely
    // waiting for CI. What the lease allows only one of is a pass in flight.
    const running = plan.items.filter((item) => item.integrating);
    if (running.length > 1)
    {
        console.log(yellow(`  ${running.length} attempts are in flight — the lease allows only one`));
    }
}
