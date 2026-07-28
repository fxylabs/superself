import { readFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { attemptId, mergeId } from "./ids.js";
import { readEvents } from "./logfile.js";
import { confirmHuman } from "./human.js";
import {
    ChangeSet,
    IntegrationState,
    Repository,
    currentApproval,
    mergeTargetOf,
    openChangeSets,
    repositoryOf,
    runningAttempt,
    short,
    transitionDigest
} from "./integration.js";
import { ProjectContext } from "./paths.js";
import { makeEvent, recordEvent, recordEvents } from "./pipeline.js";
import { commitExists, featureDigest, isAncestor } from "./repo.js";
import { dim, green, styled, yellow } from "./style.js";
import {
    bindDigest,
    loadIntegration,
    printMachine,
    repoDirOf,
    requireChangeSet,
    requireRepository,
    requireText
} from "./trainutil.js";
import { CliError, SelfEvent } from "./types.js";

const DEFAULT_TTL_MINUTES = 30;

const LEASE_USAGE = "usage: self integration lease acquire --repo r --holder h [--ttl <minutes>] | release --repo r --fence N | show --repo r";
const ATTEMPT_USAGE = "usage: self integration attempt start <change-set> --fence N --action rebase|resolve|merge | finish <attempt> --outcome completed|conflict|failed | cancel <attempt> --why w";
const OBSERVE_USAGE = "usage: self integration observe ci --repo r --head h --check c --conclusion success|failure|pending [--at iso] | main|target --repo r --head h [--at iso] | --file <batch.json>";

/* ── lease ─────────────────────────────────────────────────────────── */

export function cmdLease(ctx: ProjectContext, rest: string[]): void
{
    const { values } = parseArgs({
        args: rest.slice(1),
        options: {
            repo: { type: "string" }, holder: { type: "string" }, ttl: { type: "string" },
            expires: { type: "string" }, fence: { type: "string" }, json: { type: "boolean" }
        },
        allowPositionals: true
    });
    const state = loadIntegration(ctx);
    const repository = requireRepository(state, values.repo);
    if (rest[0] === "acquire")
    {
        acquireLease(ctx, repository, values);
        return;
    }
    if (rest[0] === "release")
    {
        releaseLease(ctx, state, repository, values.fence);
        return;
    }
    if (rest[0] === "show")
    {
        showLease(repository, values.json);
        return;
    }
    throw new CliError(LEASE_USAGE);
}

// One lease per repository, and a new holder always gets a higher fence. The
// same holder taking the lease again renews it at the fence it already has —
// a supervisor that restarted must not fence out its own running attempt.
function acquireLease(ctx: ProjectContext, repository: Repository, values: Record<string, unknown>): void
{
    const holder = requireText(values.holder as string | undefined, "integration lease acquire --repo r --holder <id>");
    const live = repository.lease !== undefined && repository.lease.live;
    if (live && repository.lease?.holder !== holder)
    {
        throw new CliError(`${repository.name} is leased by ${repository.lease?.holder} at fence ${repository.lease?.fence} ` +
            `until ${repository.lease?.expiresAt} — wait, or run \`self integration reconcile --repo ${repository.name}\` once it expires`);
    }
    const fence = live ? repository.lease?.fence as number : repository.fence + 1;
    const expiresAt = expiry(values.ttl as string | undefined, values.expires as string | undefined);
    const payload = { repository: repository.name, holder, fence, expiresAt };
    recordEvent(ctx, makeEvent(ctx.project, "lease.acquired", payload), `${repository.name} fence ${fence} to ${holder}`);
    confirmHeld(ctx, repository.name, holder, fence);
    console.log(String(fence));
}

// Two supervisors that read "no live lease" in the same instant both append an
// acquisition at the same fence, and the fold's last word decides which of them
// holds it. Reading the lane back settles that here, so the one that lost walks
// away knowing it lost instead of starting an attempt under a fence it shares.
//
// Holder and fence are the pair that answers this. Whether the lease is live is
// a separate question — one taken with an instant already past was never live,
// and that is not a lost race.
function confirmHeld(ctx: ProjectContext, repository: string, holder: string, fence: number): void
{
    const lease = repositoryOf(loadIntegration(ctx), repository).lease;
    if (lease !== undefined && lease.holder === holder && lease.fence === fence)
    {
        return;
    }
    throw new CliError(`${repository} fence ${fence} went to ${lease?.holder ?? "nobody"} — ` +
        `re-read the lane with \`self integration lease show --repo ${repository}\``);
}

// A lease ends at a stated instant, not after a duration nobody wrote down.
// --ttl is the convenient way to say it; --expires is the exact way, and an
// instant already past is a lease that was never live.
function expiry(ttl: string | undefined, expires: string | undefined): string
{
    if (expires !== undefined)
    {
        const stated = new Date(expires);
        if (Number.isNaN(stated.getTime()))
        {
            throw new CliError(`--expires "${expires}" is not an ISO 8601 instant`);
        }
        return stated.toISOString();
    }
    const minutes = ttl === undefined ? DEFAULT_TTL_MINUTES : Number(ttl);
    if (Number.isNaN(minutes) || minutes <= 0)
    {
        throw new CliError("--ttl expects a positive number of minutes");
    }
    return new Date(Date.now() + minutes * 60_000).toISOString();
}

function releaseLease(ctx: ProjectContext, state: IntegrationState, repository: Repository, fence: string | undefined): void
{
    const lease = repository.lease;
    if (lease === undefined || !lease.live)
    {
        throw new CliError(`${repository.name} holds no live integration lease`);
    }
    if (Number(requireText(fence, "integration lease release --repo r --fence <N>")) !== lease.fence)
    {
        throw new CliError(`fence ${fence} is not the current ${repository.name} fence (${lease.fence})`);
    }
    const running = runningAttemptsIn(repository, state.changeSets);
    if (running.length > 0)
    {
        throw new CliError(`attempt ${running[0]} is still running under fence ${lease.fence} — finish or cancel it first`);
    }
    recordEvent(ctx, makeEvent(ctx.project, "lease.released", { repository: repository.name, fence: lease.fence }),
        `${repository.name} fence ${lease.fence}`);
}

function showLease(repository: Repository, json: boolean | undefined): void
{
    if (printMachine(json, repository.lease ?? { repository: repository.name, lease: null, fence: repository.fence }))
    {
        return;
    }
    const lease = repository.lease;
    if (lease === undefined)
    {
        console.log(`${repository.name}: no lease has ever been taken`);
        return;
    }
    const state = lease.live ? "live" : lease.released ? "released" : "expired";
    console.log(`${repository.name}: fence ${lease.fence} ${state}, holder ${lease.holder}, expires ${lease.expiresAt}`);
}

function runningAttemptsIn(repository: Repository, changeSets: ChangeSet[]): string[]
{
    return changeSets
        .filter((item) => item.repository === repository.name)
        .map((item) => runningAttempt(item))
        .filter((attempt) => attempt !== undefined)
        .map((attempt) => (attempt as { id: string }).id);
}

/* ── attempts ──────────────────────────────────────────────────────── */

export function cmdAttempt(ctx: ProjectContext, rest: string[]): void
{
    if (rest[0] === "start")
    {
        startAttempt(ctx, rest.slice(1));
        return;
    }
    if (rest[0] === "finish")
    {
        finishAttempt(ctx, rest.slice(1));
        return;
    }
    if (rest[0] === "cancel")
    {
        cancelAttempt(ctx, rest.slice(1));
        return;
    }
    throw new CliError(ATTEMPT_USAGE);
}

// Every precondition is checked here, before the agent is told to touch git.
// A refusal at this point costs nothing; a rebase started against an open
// predecessor costs another integration pass for everyone behind it.
function startAttempt(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseArgs({
        args,
        options: { fence: { type: "string" }, action: { type: "string" }, json: { type: "boolean" } },
        allowPositionals: true
    });
    const state = loadIntegration(ctx);
    const changeSet = requireChangeSet(state, positionals[0]);
    const repository = repositoryOf(state, changeSet.repository);
    const action = attemptAction(values.action);
    const refusal = attemptRefusal(state, changeSet, repository, values.fence);
    if (refusal !== null)
    {
        return refuse(values.json, refusal);
    }
    const id = attemptId();
    const payload = {
        attempt: id, changeSet: changeSet.id, repository: repository.name, fence: Number(values.fence),
        action, predecessor: changeSet.predecessors[0], oldHead: changeSet.head, mainAt: mergeTargetOf(repository).head
    };
    recordEvent(ctx, makeEvent(ctx.project, "attempt.started", strip(payload)), `${changeSet.id} ${action}`);
    if (!printMachine(values.json, { attempt: id, changeSet: changeSet.id, action, fence: Number(values.fence) }))
    {
        console.log(id);
    }
}

function attemptAction(value: string | undefined): "rebase" | "resolve" | "merge"
{
    if (value !== "rebase" && value !== "resolve" && value !== "merge")
    {
        throw new CliError("integration attempt start requires --action rebase|resolve|merge");
    }
    return value;
}

function attemptRefusal(state: IntegrationState, changeSet: ChangeSet, repository: Repository,
    fence: string | undefined): Refusal | null
{
    if (changeSet.merge !== undefined || changeSet.closed !== undefined)
    {
        return { code: "changeset_closed", detail: `${changeSet.id} is ${changeSet.phase}`, next: "nothing to integrate" };
    }
    const fenceRefusal = fenceRefusalOf(repository, fence);
    if (fenceRefusal !== null)
    {
        return fenceRefusal;
    }
    const running = runningAttemptsIn(repository, state.changeSets);
    if (running.length > 0)
    {
        return { code: "lane_busy", detail: `attempt ${running[0]} is already running on ${repository.name}`,
            next: `finish or cancel ${running[0]} first` };
    }
    return changeSet.blockers.find((blocker) => START_BLOCKING.includes(blocker.code)) ?? null;
}

// What may not be started at all, as opposed to what merely may not be merged:
// order, an unowned architecture collision, and a fence that is not current.
const START_BLOCKING = ["predecessor_open", "dependency_cycle", "dependency_unknown", "unconsolidated_semantic_overlap"];

export function fenceRefusalOf(repository: Repository, fence: string | undefined): Refusal | null
{
    const lease = repository.lease;
    if (lease === undefined || !lease.live)
    {
        return { code: "lease_not_current", detail: `no live integration lease on ${repository.name}`,
            next: `self integration lease acquire --repo ${repository.name} --holder <id>` };
    }
    if (fence === undefined || Number(fence) !== lease.fence)
    {
        return { code: "stale_fence", detail: `fence ${fence ?? "unstated"} is not the current ${repository.name} fence (${lease.fence})`,
            next: `re-read the fence with \`self integration lease show --repo ${repository.name}\`` };
    }
    return null;
}

function finishAttempt(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseArgs({
        args,
        options: {
            outcome: { type: "string" }, head: { type: "string" }, base: { type: "string" },
            "conflict-path": { type: "string", multiple: true }, intersection: { type: "string", multiple: true },
            command: { type: "string", multiple: true }, why: { type: "string" },
            "repo-dir": { type: "string" }, offline: { type: "boolean" },
            "diff-digest": { type: "string" }, json: { type: "boolean" }
        },
        allowPositionals: true
    });
    const state = loadIntegration(ctx);
    const attempt = requireRunningAttempt(state, positionals[0]);
    const changeSet = requireChangeSet(state, attempt.changeSet);
    const repository = repositoryOf(state, changeSet.repository);
    const fenceRefusal = fenceRefusalOf(repository, String(attempt.fence));
    if (fenceRefusal !== null)
    {
        return refuse(values.json, fenceRefusal);
    }
    recordFinish(ctx, changeSet, attempt.id, values);
}

function requireRunningAttempt(state: IntegrationState, id: string | undefined): { id: string; changeSet: string; fence: number }
{
    const attempt = state.changeSets.flatMap((item) => item.attempts).find((item) => item.id === id);
    if (attempt === undefined)
    {
        throw new CliError(`unknown attempt "${id ?? ""}"`);
    }
    if (attempt.status !== "running")
    {
        throw new CliError(`attempt ${attempt.id} already ended as ${attempt.status}`);
    }
    return attempt;
}

function recordFinish(ctx: ProjectContext, changeSet: ChangeSet, attempt: string, values: Record<string, unknown>): void
{
    const outcome = finishOutcome(values.outcome as string | undefined);
    const payload: Record<string, unknown> = {
        attempt, changeSet: changeSet.id, outcome,
        conflictPaths: values["conflict-path"] ?? [], intersections: values.intersection ?? [],
        commands: parseCommands(values.command as string[] | undefined), why: values.why
    };
    const head = values.head as string | undefined;
    if (head !== undefined)
    {
        Object.assign(payload, movedBytes(ctx, changeSet, values, head));
    }
    recordEvent(ctx, makeEvent(ctx.project, "attempt.finished", strip(payload)), `${changeSet.id} ${outcome}`);
    reportMove(payload, changeSet);
}

function movedBytes(ctx: ProjectContext, changeSet: ChangeSet, values: Record<string, unknown>, head: string): Record<string, unknown>
{
    const repoDir = repoDirOf(ctx, values["repo-dir"] as string | undefined, values.offline === true);
    const binding = bindDigest(repoDir, (values.base as string | undefined) ?? changeSet.base, head,
        values["diff-digest"] as string | undefined, []);
    const moved = binding.digest !== changeSet.featureDigest;
    return {
        base: binding.base, head: binding.head, digest: binding.digest,
        digestSource: binding.digestSource, paths: binding.paths.length > 0 ? binding.paths : undefined,
        deltaDigest: moved ? transitionDigest(changeSet.featureDigest, binding.digest) : undefined
    };
}

function reportMove(payload: Record<string, unknown>, changeSet: ChangeSet): void
{
    if (payload.deltaDigest === undefined)
    {
        const preserved = payload.digest === undefined ? "no bytes moved" : "the feature bytes are unchanged";
        console.log(styled ? dim(`${preserved} — every receipt on ${changeSet.id} stands`) : `${preserved}; receipts preserved`);
        return;
    }
    const line = `integration delta ${short(String(payload.deltaDigest))} needs a bounded review before ${changeSet.id} can merge`;
    console.log(styled ? yellow(line) : line);
}

function finishOutcome(value: string | undefined): string
{
    if (value !== "completed" && value !== "conflict" && value !== "failed")
    {
        throw new CliError("integration attempt finish requires --outcome completed|conflict|failed");
    }
    return value;
}

// "git rebase --onto main:0" — the exit status after the last colon, so a
// command carrying colons of its own still records the status it ended with.
function parseCommands(values: string[] | undefined): { command: string; exit: number }[]
{
    return (values ?? []).map((entry) =>
    {
        const cut = entry.lastIndexOf(":");
        const exit = cut === -1 ? Number.NaN : Number(entry.slice(cut + 1));
        if (cut === -1 || Number.isNaN(exit))
        {
            throw new CliError(`--command "${entry}" must end with ":<exit status>"`);
        }
        return { command: entry.slice(0, cut), exit };
    });
}

function cancelAttempt(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseArgs({ args, options: { why: { type: "string" } }, allowPositionals: true });
    const state = loadIntegration(ctx);
    const attempt = requireRunningAttempt(state, positionals[0]);
    const why = requireText(values.why, 'integration attempt cancel <attempt> --why "<what invalidated it>"');
    recordEvent(ctx, makeEvent(ctx.project, "attempt.cancelled", { attempt: attempt.id, reason: "manual", why }),
        `${attempt.changeSet} ${why}`);
}

/* ── projections ───────────────────────────────────────────────────── */

export function cmdObserve(ctx: ProjectContext, rest: string[]): void
{
    const { values } = parseArgs({
        args: rest,
        options: {
            file: { type: "string" }, repo: { type: "string" }, head: { type: "string" },
            check: { type: "string" }, conclusion: { type: "string" }, at: { type: "string" },
            url: { type: "string" }, dedupe: { type: "string" }, json: { type: "boolean" }
        },
        allowPositionals: true
    });
    const observations = values.file === undefined
        ? [observationFrom(rest[0], values)]
        : batchFrom(values.file);
    ingestObservations(ctx, observations, values.json);
}

interface Observation
{
    kind: "ci" | "main" | "target";
    repository: string;
    head: string;
    check?: string;
    conclusion?: string;
    observedAt: string;
    url?: string;
    dedupe: string;
}

function observationFrom(kind: string | undefined, values: Record<string, unknown>): Observation
{
    if (kind !== "ci" && kind !== "main" && kind !== "target")
    {
        throw new CliError(OBSERVE_USAGE);
    }
    return normalize({
        kind,
        repository: requireText(values.repo as string | undefined, "integration observe … --repo <name>"),
        head: requireText(values.head as string | undefined, "integration observe … --head <sha>"),
        check: values.check as string | undefined,
        conclusion: values.conclusion as string | undefined,
        observedAt: values.at as string | undefined,
        url: values.url as string | undefined,
        dedupe: values.dedupe as string | undefined
    });
}

// A projection is keyed by what it says, not by when it arrived: the same
// webhook delivered twice, or replayed after a restart, lands on the same key
// and changes nothing.
//
// A wall-clock default never enters the key. A caller that states an instant
// with --at gets an identity that includes it; a caller that states nothing
// gets a pure content key, so an undedupe-keyed redelivery converges instead
// of minting a fresh identity from whenever this process happened to run.
// Webhook adapters must pass the delivery id as --dedupe.
function normalize(raw: Record<string, unknown>): Observation
{
    const kind = raw.kind === "main" || raw.kind === "target" ? raw.kind : "ci";
    const statedAt = raw.observedAt === undefined ? undefined : String(raw.observedAt);
    const observation: Observation = {
        kind,
        repository: String(raw.repository),
        head: String(raw.head),
        check: kind === "ci" ? String(raw.check ?? requireCheck()) : undefined,
        conclusion: kind === "ci" ? conclusionOf(raw.conclusion) : undefined,
        observedAt: statedAt ?? new Date().toISOString(),
        url: raw.url === undefined ? undefined : String(raw.url),
        dedupe: ""
    };
    observation.dedupe = raw.dedupe === undefined
        ? [kind, observation.repository, observation.head, observation.check ?? "-", observation.conclusion ?? "-",
            ...(statedAt === undefined ? [] : [statedAt])].join(":")
        : String(raw.dedupe);
    return observation;
}

function requireCheck(): string
{
    throw new CliError("integration observe ci requires --check <name>");
}

function conclusionOf(value: unknown): string
{
    const allowed = ["success", "failure", "pending", "cancelled", "timed_out"];
    if (!allowed.includes(String(value)))
    {
        throw new CliError(`--conclusion must be one of ${allowed.join(", ")}`);
    }
    return String(value);
}

function batchFrom(file: string): Observation[]
{
    if (!existsSync(file))
    {
        throw new CliError(`observation batch "${file}" does not exist`);
    }
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (raw.schema !== "superself.integration-observation/1" || !Array.isArray(raw.observations))
    {
        throw new CliError('an observation batch must be {"schema":"superself.integration-observation/1","observations":[…]}');
    }
    return raw.observations.map(normalize);
}

function ingestObservations(ctx: ProjectContext, observations: Observation[], json: boolean | undefined): void
{
    const state = loadIntegration(ctx);
    const fresh = observations.filter((item) => !state.seen.includes(item.dedupe));
    const events = fresh.map((item) => makeEvent(ctx.project, `${item.kind}.observed`,
        strip({ repository: item.repository, head: item.head, check: item.check, conclusion: item.conclusion,
            observedAt: item.observedAt, url: item.url, dedupe: item.dedupe })));
    const result = { observed: fresh.length, duplicates: observations.length - fresh.length };
    if (events.length > 0)
    {
        recordEvents(ctx, events, `${fresh.length} observation(s)`);
    }
    if (!printMachine(json, result) && events.length === 0)
    {
        console.log(`nothing new — ${observations.length} observation(s) were already recorded`);
    }
}

/* ── approval and merge ────────────────────────────────────────────── */

// The human gate on a merge that lands on main. The confirmation is read from
// an interactive terminal and recorded in the event, and the fold refuses an
// approval that does not carry it — so no agent-runnable invocation, and no
// hand-built event, can self-assert a human.
export function cmdApprove(ctx: ProjectContext, rest: string[]): void
{
    const { values, positionals } = parseArgs({
        args: rest,
        options: { head: { type: "string" }, by: { type: "string" }, json: { type: "boolean" } },
        allowPositionals: true
    });
    const state = loadIntegration(ctx);
    const changeSet = requireChangeSet(state, positionals[0]);
    const head = requireText(values.head, "integration approve <change-set> --head <sha>");
    if (head !== changeSet.head)
    {
        throw new CliError(`approval names ${short(head)}, and ${changeSet.id} is at ${short(changeSet.head)} — ` +
            "an approval is bound to the exact head it was given for");
    }
    const confirmation = confirmHuman(`merge approval for ${changeSet.id} at head ${short(head)}`, short(head));
    if ("code" in confirmation)
    {
        return refuse(values.json, confirmation);
    }
    const payload = { changeSet: changeSet.id, head, by: values.by ?? "maintainer", confirmation };
    recordEvent(ctx, makeEvent(ctx.project, "merge.approved", payload, undefined, true), `${changeSet.id} ${short(head)}`);
}

export function cmdMerge(ctx: ProjectContext, rest: string[]): void
{
    const { values, positionals } = parseArgs({
        args: rest,
        options: {
            fence: { type: "string" }, "merge-commit": { type: "string" },
            "main-before": { type: "string" }, "main-after": { type: "string" }, json: { type: "boolean" }
        },
        allowPositionals: true
    });
    const state = loadIntegration(ctx);
    const changeSet = requireChangeSet(state, positionals[0]);
    const repository = repositoryOf(state, changeSet.repository);
    const refusal = mergeRefusal(changeSet, repository, values.fence)
        ?? driftRefusal(ctx, changeSet)
        ?? receiptRefusal(ctx, repository, changeSet.head, values);
    if (refusal !== null)
    {
        return refuse(values.json, refusal);
    }
    recordMerge(ctx, changeSet, repository, values);
}

function mergeRefusal(changeSet: ChangeSet, repository: Repository, fence: string | undefined): Refusal | null
{
    if (changeSet.merge !== undefined)
    {
        return { code: "already_merged", detail: `${changeSet.id} merged as ${short(changeSet.merge.mergeCommit)}`,
            next: "nothing — this change set is closed" };
    }
    const fenceRefusal = fenceRefusalOf(repository, fence);
    if (fenceRefusal !== null)
    {
        return fenceRefusal;
    }
    const running = runningAttempt(changeSet);
    if (running !== undefined)
    {
        return { code: "attempt_running", detail: `attempt ${running.id} is still running`,
            next: `self integration attempt finish ${running.id} --outcome completed|conflict|failed` };
    }
    return changeSet.blockers[0] ?? null;
}

// The last chance to catch a digest that was declared rather than computed.
// If a checkout is reachable at merge time, the bytes are asked again: a
// receipt that turns out to describe other bytes stops the merge, and a
// repository nobody can reach here changes nothing about the earlier record.
function driftRefusal(ctx: ProjectContext, changeSet: ChangeSet): Refusal | null
{
    const repoDir = repoDirOf(ctx, undefined, false);
    if (repoDir === null || !commitExists(repoDir, changeSet.base) || !commitExists(repoDir, changeSet.head))
    {
        return null;
    }
    const digest = featureDigest(repoDir, changeSet.base, changeSet.head);
    if (digest === null || digest === changeSet.featureDigest)
    {
        return null;
    }
    return {
        code: "digest_drift",
        detail: `${changeSet.id} is recorded at ${short(changeSet.featureDigest)} and ${short(changeSet.base)}...` +
            `${short(changeSet.head)} now hashes to ${short(digest)}`,
        next: `self integration head ${changeSet.id} --head ${changeSet.head} to record the bytes that are really there`
    };
}

const FULL_COMMIT = /^[0-9a-f]{40}$/;

// The receipt is the durable record of what landed, so what it names is
// validated like any other claim: full commit ids always, and — when a
// checkout is reachable — commits that exist and really contain the reviewed
// head. A receipt naming commits nobody can relate to the reviewed bytes is
// refused, not recorded.
export function commitShapeRefusal(commits: Record<string, string | undefined>): Refusal | null
{
    for (const [flag, sha] of Object.entries(commits))
    {
        if (sha !== undefined && !FULL_COMMIT.test(sha))
        {
            return {
                code: "commit_malformed",
                detail: `${flag} "${sha}" is not a full 40-character commit id`,
                next: "record the receipt with the exact commit ids git reports"
            };
        }
    }
    return null;
}

// Proof of the commit relationship: reviewedHead is contained in the merge
// commit, and the merge commit is contained in the branch head after. With no
// reachable checkout the declared receipt stands on its own, exactly as a
// declared digest does — and is caught the moment a checkout can look.
export function commitProofRefusal(ctx: ProjectContext, reviewedHead: string, mergeCommit: string | undefined,
    after: string, afterLabel: string): Refusal | null
{
    const repoDir = repoDirOf(ctx, undefined, false);
    if (repoDir === null)
    {
        return null;
    }
    const named: [string, string | undefined][] =
        [["reviewed head", reviewedHead], ["merge commit", mergeCommit], [afterLabel, after]];
    for (const [label, sha] of named)
    {
        if (sha !== undefined && !commitExists(repoDir, sha))
        {
            return {
                code: "commit_unknown",
                detail: `the ${label} ${short(sha)} is not a commit in the reachable checkout`,
                next: "record the receipt with the exact commit ids git reports"
            };
        }
    }
    const chain = mergeCommit === undefined ? [reviewedHead, after] : [reviewedHead, mergeCommit, after];
    for (let step = 0; step + 1 < chain.length; step++)
    {
        if (!isAncestor(repoDir, chain[step], chain[step + 1]))
        {
            return {
                code: "merge_unrelated",
                detail: `${short(chain[step + 1])} does not contain ${short(chain[step])}, ` +
                    "so this receipt does not describe a merge of the reviewed bytes",
                next: "record the merge that really happened, with the commits git reports"
            };
        }
    }
    return null;
}

function receiptRefusal(ctx: ProjectContext, repository: Repository, head: string,
    values: Record<string, unknown>): Refusal | null
{
    const mergeCommit = requireText(values["merge-commit"] as string | undefined, "integration merge <id> --merge-commit <sha>");
    const mainBefore = requireText(values["main-before"] as string | undefined, "integration merge <id> --main-before <sha>");
    const mainAfter = requireText(values["main-after"] as string | undefined, "integration merge <id> --main-after <sha>");
    return commitShapeRefusal({ "--merge-commit": mergeCommit, "--main-before": mainBefore, "--main-after": mainAfter })
        ?? commitProofRefusal(ctx, head, mergeCommit, mainAfter, `${mergeTargetOf(repository).branch} after the merge`);
}

function recordMerge(ctx: ProjectContext, changeSet: ChangeSet, repository: Repository, values: Record<string, unknown>): void
{
    const id = mergeId();
    const target = mergeTargetOf(repository);
    const approval = currentApproval(changeSet);
    const payload = strip({
        merge: id, changeSet: changeSet.id, head: changeSet.head, fence: Number(values.fence),
        mergeCommit: requireText(values["merge-commit"] as string | undefined, "integration merge <id> --merge-commit <sha>"),
        mainBefore: requireText(values["main-before"] as string | undefined, "integration merge <id> --main-before <sha>"),
        mainAfter: requireText(values["main-after"] as string | undefined, "integration merge <id> --main-after <sha>"),
        target: target.branch, approval: approval?.id,
        ci: changeSet.ci.filter((item) => changeSet.checks.includes(item.check))
    });
    const advance = makeEvent(ctx.project, target.promotion ? "main.observed" : "target.observed", {
        repository: repository.name, head: payload.mainAfter, observedAt: new Date().toISOString(),
        dedupe: `${target.promotion ? "main" : "target"}:${repository.name}:${payload.mainAfter}:${id}`
    });
    recordEvents(ctx, [makeEvent(ctx.project, "merge.recorded", payload, { work: changeSet.work }, true), advance],
        `${changeSet.id} merged as ${short(String(payload.mergeCommit))}`);
    if (!printMachine(values.json as boolean | undefined, payload))
    {
        console.log(id);
    }
}

/* ── reconciliation ────────────────────────────────────────────────── */

// The convergence step: it looks at what the log already says and writes only
// the events that state a fact the log is missing. Running it twice in a row
// must produce nothing the second time, whatever restarted in between.
export function cmdReconcile(ctx: ProjectContext, rest: string[]): void
{
    const { values } = parseArgs({ args: rest, options: { repo: { type: "string" }, json: { type: "boolean" } } });
    const state = loadIntegration(ctx);
    const repositories = values.repo === undefined
        ? state.repositories
        : [requireRepository(state, values.repo)];
    const events: SelfEvent[] = [];
    const actions: { action: string; subject: string; reason: string }[] = [];
    for (const repository of repositories)
    {
        collectExpiry(ctx, repository, events, actions);
        collectCancellations(ctx, state, repository, events, actions);
    }
    if (events.length > 0)
    {
        recordEvents(ctx, events, `reconcile: ${actions.map((item) => item.action).join(", ")}`);
    }
    reportReconcile(values.json, actions, state);
}

// The derived lease reads expired the moment its ttl passes; the event is what
// makes that durable. Writing it a second time would state a new fact on every
// run, so the log is asked first.
function collectExpiry(ctx: ProjectContext, repository: Repository, events: SelfEvent[],
    actions: { action: string; subject: string; reason: string }[]): void
{
    const lease = repository.lease;
    if (lease === undefined || lease.released || lease.live || expiryRecorded(ctx, repository.name, lease.fence))
    {
        return;
    }
    events.push(makeEvent(ctx.project, "lease.expired", { repository: repository.name, fence: lease.fence }));
    actions.push({ action: "lease_expired", subject: `${repository.name} fence ${lease.fence}`, reason: `ttl passed at ${lease.expiresAt}` });
}

function expiryRecorded(ctx: ProjectContext, repository: string, fence: number): boolean
{
    return readEvents(ctx.storeDir, ctx.project).some((event) => event.type === "lease.expired"
        && event.payload.repository === repository && Number(event.payload.fence) === fence);
}

// An attempt is only valid while the fence it started under is the fence that
// is current, the merge target it planned against is the one that is there,
// and the head it planned against has not moved. When one of those stops
// being true the attempt is cancelled with the reason, never silently retried.
//
// An attempt admitted before any target head was observed planned against no
// target at all, and that is settled the same way: the moment the target has a
// head, an attempt that cannot be shown to have planned against it is gone.
function collectCancellations(ctx: ProjectContext, state: IntegrationState, repository: Repository,
    events: SelfEvent[], actions: { action: string; subject: string; reason: string }[]): void
{
    for (const changeSet of state.changeSets.filter((item) => item.repository === repository.name))
    {
        const attempt = runningAttempt(changeSet);
        const reason = attempt === undefined ? null : invalidReason(attempt, changeSet, repository);
        if (attempt === undefined || reason === null)
        {
            continue;
        }
        events.push(makeEvent(ctx.project, "attempt.cancelled", { attempt: attempt.id, reason: reason.code, why: reason.detail }));
        actions.push({ action: "attempt_cancelled", subject: attempt.id, reason: reason.detail });
    }
}

function invalidReason(attempt: { fence: number; oldHead: string; mainAt?: string }, changeSet: ChangeSet,
    repository: Repository): { code: string; detail: string } | null
{
    const lease = repository.lease;
    if (lease === undefined || !lease.live || lease.fence !== attempt.fence)
    {
        return { code: "stale_fence", detail: `fence ${attempt.fence} is no longer current on ${repository.name}` };
    }
    const target = mergeTargetOf(repository);
    if (target.head !== undefined && attempt.mainAt !== target.head)
    {
        return attempt.mainAt === undefined
            ? { code: "target_unobserved", detail: `this attempt was admitted before any ${target.branch} head was observed, ` +
                `and ${target.branch} is now at ${short(target.head)}` }
            : { code: "target_moved", detail: `${target.branch} moved from ${short(attempt.mainAt)} to ${short(target.head)}` };
    }
    if (attempt.oldHead !== changeSet.head)
    {
        return { code: "head_moved", detail: `${changeSet.id} moved from ${short(attempt.oldHead)} to ${short(changeSet.head)}` };
    }
    return null;
}

function reportReconcile(json: boolean | undefined, actions: { action: string; subject: string; reason: string }[],
    state: IntegrationState): void
{
    const summary = { converged: actions.length === 0, actions, open: openChangeSets(state).length };
    if (printMachine(json, summary))
    {
        return;
    }
    if (actions.length === 0)
    {
        console.log(styled ? `${green("✓")} ${dim("already converged — nothing to cancel or expire")}` : "converged");
        return;
    }
    for (const action of actions)
    {
        console.log(`${action.action}  ${action.subject}  ${action.reason}`);
    }
}

/* ── shared ────────────────────────────────────────────────────────── */

export interface Refusal
{
    code: string;
    detail: string;
    next: string;
}

// A refusal is an answer, not a crash: machine callers get the code, the exact
// missing prerequisite and the next eligible action, and a non-zero status.
export function refuse(json: boolean | undefined, refusal: Refusal): void
{
    if (printMachine(json, { ok: false, ...refusal }))
    {
        process.exitCode = 1;
        return;
    }
    throw new CliError(`${refusal.detail} [${refusal.code}] — next: ${refusal.next}`);
}

export function strip(payload: Record<string, unknown>): Record<string, unknown>
{
    return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}
