import { parseArgs } from "node:util";
import { confirmHuman } from "./human.js";
import {
    IntegrationState,
    Promotion,
    Repository,
    canonicalBranch,
    isMainAlias,
    mergeTargetOf,
    promotionApproval,
    short,
    standingRelease
} from "./integration.js";
import { promotionId } from "./ids.js";
import { commitProofRefusal, commitShapeRefusal, fenceRefusalOf, Refusal, refuse, strip } from "./lane.js";
import { ProjectContext } from "./paths.js";
import { makeEvent, recordEvent, recordEvents } from "./pipeline.js";
import { featureDigest, treeOf } from "./repo.js";
import { dim, styled } from "./style.js";
import {
    bindDigest,
    loadIntegration,
    printMachine,
    repoDirOf,
    requirePromotion,
    requireRepository,
    requireText
} from "./trainutil.js";
import { CliError } from "./types.js";

const TARGET_USAGE = "usage: self integration target --repo r [--branch <integration-branch>]";
const PROMOTE_USAGE = "usage: self integration promote request --repo r --candidate <sha> [--main <sha>] " +
    "| approve <promotion> --candidate <sha> [--by name] | record <promotion> --fence N --main-before a --main-after b [--merge-commit m] | show <promotion>";

/* ── the configured merge target ───────────────────────────────────── */

// Where this repository's train merges. Setting an integration branch is what
// makes the lane autonomous: change sets merge there on receipts, fence, CI
// and order, and only promotion of that branch into main takes the human gate.
export function cmdTarget(ctx: ProjectContext, rest: string[]): void
{
    const { values } = parseArgs({
        args: rest,
        options: { repo: { type: "string" }, branch: { type: "string" }, json: { type: "boolean" } }
    });
    const state = loadIntegration(ctx);
    const repository = requireRepository(state, values.repo);
    if (values.branch === undefined)
    {
        showTarget(repository, values.json);
        return;
    }
    const branch = canonicalBranch(values.branch);
    if (branch === "")
    {
        throw new CliError(`--branch "${values.branch}" names no branch`);
    }
    if (isMainAlias(branch))
    {
        throw new CliError("the integration target is the branch before main — promotion into main is its own gated lane, " +
            "and a repository with no target merges straight into main under the human gate");
    }
    // The event carries the spelling as given; the fold canonicalizes exactly
    // once, so the command must not strip a prefix the fold would strip again.
    recordEvent(ctx, makeEvent(ctx.project, "repo.target_set", { repository: repository.name, branch: values.branch }),
        `${repository.name} merges into ${branch}`);
}

function showTarget(repository: Repository, json: boolean | undefined): void
{
    const target = mergeTargetOf(repository);
    if (printMachine(json, { repository: repository.name, branch: target.branch, head: target.head, promotion: target.promotion }))
    {
        return;
    }
    console.log(target.promotion
        ? `${repository.name} merges straight into main — every merge takes the human gate`
        : `${repository.name} merges into ${target.branch}${target.head === undefined ? "" : ` (at ${short(target.head)})`} autonomously; ` +
            "promotion into main takes the human gate");
}

/* ── promotion into main ───────────────────────────────────────────── */

export function cmdPromote(ctx: ProjectContext, rest: string[]): void
{
    if (rest[0] === "request")
    {
        requestPromotion(ctx, rest.slice(1));
        return;
    }
    if (rest[0] === "approve")
    {
        approvePromotion(ctx, rest.slice(1));
        return;
    }
    if (rest[0] === "record")
    {
        recordPromotion(ctx, rest.slice(1));
        return;
    }
    if (rest[0] === "show")
    {
        showPromotion(ctx, rest.slice(1));
        return;
    }
    throw new CliError(PROMOTE_USAGE);
}

// A promotion pins the exact release candidate: the candidate commit on the
// integration branch, the exact main it will land on, and the digest of the
// release-candidate bytes between them — sha256(git diff main...candidate).
// The release review and the human approval both bind to that pin.
function requestPromotion(ctx: ProjectContext, args: string[]): void
{
    const { values } = parseArgs({
        args,
        options: {
            repo: { type: "string" }, candidate: { type: "string" }, main: { type: "string" },
            "diff-digest": { type: "string" }, "repo-dir": { type: "string" }, offline: { type: "boolean" },
            json: { type: "boolean" }
        }
    });
    const state = loadIntegration(ctx);
    const repository = requireRepository(state, values.repo);
    if (mergeTargetOf(repository).promotion)
    {
        throw new CliError(`${repository.name} has no integration target, so every merge already promotes into main — ` +
            `set one first with \`self integration target --repo ${repository.name} --branch <name>\``);
    }
    const base = values.main ?? repository.mainHead;
    if (base === undefined)
    {
        throw new CliError("no main head is on record for this repository — state the exact release base with --main <sha> " +
            `or observe it with \`self integration observe main --repo ${repository.name} --head <sha>\``);
    }
    const repoDir = repoDirOf(ctx, values["repo-dir"], values.offline === true);
    const binding = bindDigest(repoDir, base,
        requireText(values.candidate, "integration promote request --repo r --candidate <sha>"),
        values["diff-digest"], []);
    const id = promotionId();
    const payload = {
        promotion: id, repository: repository.name, candidate: binding.head, base: binding.base,
        digest: binding.digest, digestSource: binding.digestSource
    };
    recordEvent(ctx, makeEvent(ctx.project, "promotion.requested", payload),
        `${repository.name} ${short(binding.head)} onto main ${short(binding.base)}`);
    if (printMachine(values.json, payload))
    {
        return;
    }
    console.log(id);
    console.log(styled
        ? dim(`release review binds to digest ${short(binding.digest)} — \`self review request ${id} --scope release\``)
        : `release review binds to digest ${short(binding.digest)}`);
}

// The human gate on promotion into main, bound to the exact candidate commit.
function approvePromotion(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseArgs({
        args,
        options: { candidate: { type: "string" }, by: { type: "string" }, json: { type: "boolean" } },
        allowPositionals: true
    });
    const state = loadIntegration(ctx);
    const promotion = requirePromotion(state, positionals[0]);
    const candidate = requireText(values.candidate, "integration promote approve <promotion> --candidate <sha>");
    if (candidate !== promotion.candidate)
    {
        throw new CliError(`approval names ${short(candidate)}, and ${promotion.id} promotes ${short(promotion.candidate)} — ` +
            "an approval is bound to the exact candidate it was given for");
    }
    if (promotion.recorded !== undefined)
    {
        return refuse(values.json, closedRefusal(promotion));
    }
    const confirmation = confirmHuman(`promotion of ${short(candidate)} into main (${promotion.repository})`, short(candidate));
    if ("code" in confirmation)
    {
        return refuse(values.json, confirmation);
    }
    const payload = { promotion: promotion.id, candidate, by: values.by ?? "maintainer", confirmation };
    recordEvent(ctx, makeEvent(ctx.project, "promotion.approved", payload, undefined, true),
        `${promotion.id} ${short(candidate)}`);
}

function recordPromotion(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseArgs({
        args,
        options: {
            fence: { type: "string" }, "main-before": { type: "string" }, "main-after": { type: "string" },
            "merge-commit": { type: "string" }, json: { type: "boolean" }
        },
        allowPositionals: true
    });
    const state = loadIntegration(ctx);
    const promotion = requirePromotion(state, positionals[0]);
    const repository = requireRepository(state, promotion.repository);
    const refusal = promotionRefusal(ctx, promotion, repository, values);
    if (refusal !== null)
    {
        return refuse(values.json, refusal);
    }
    const payload = strip({
        promotion: promotion.id, repository: repository.name, candidate: promotion.candidate,
        fence: Number(values.fence),
        mainBefore: values["main-before"], mainAfter: values["main-after"], mergeCommit: values["merge-commit"],
        approval: promotionApproval(promotion)?.id, receipt: standingRelease(promotion)?.id
    });
    const advance = makeEvent(ctx.project, "main.observed", {
        repository: repository.name, head: String(payload.mainAfter), observedAt: new Date().toISOString(),
        dedupe: `main:${repository.name}:${payload.mainAfter}:${promotion.id}`
    });
    recordEvents(ctx, [makeEvent(ctx.project, "promotion.recorded", payload, undefined, true), advance],
        `${promotion.id} main is now ${short(String(payload.mainAfter))}`);
    if (!printMachine(values.json, payload))
    {
        console.log(`${promotion.id} promoted — main moved from ${short(String(payload.mainBefore))} to ${short(String(payload.mainAfter))}`);
    }
}

// The promotion gate, stated in order: an open promotion, the lane fence, a
// standing release receipt on the exact release-candidate bytes, a verified
// human approval of the exact candidate, and commit ids that prove the
// promotion that really happened.
function promotionRefusal(ctx: ProjectContext, promotion: Promotion, repository: Repository,
    values: Record<string, unknown>): Refusal | null
{
    if (promotion.recorded !== undefined)
    {
        return closedRefusal(promotion);
    }
    const fenceRefusal = fenceRefusalOf(repository, values.fence as string | undefined);
    if (fenceRefusal !== null)
    {
        return fenceRefusal;
    }
    if (standingRelease(promotion) === undefined)
    {
        return {
            code: "release_receipt_missing",
            detail: `no standing release approval is bound to digest ${short(promotion.digest)} — ` +
                `the exact bytes main...${short(promotion.candidate)} would land`,
            next: `self review request ${promotion.id} --scope release, then \`self review ingest --file <envelope.json>\``
        };
    }
    if (promotionApproval(promotion) === undefined)
    {
        return {
            code: "approval_missing",
            detail: `no human approval names candidate ${short(promotion.candidate)} for promotion into main`,
            next: `a maintainer runs \`self integration promote approve ${promotion.id} --candidate ${promotion.candidate}\` in their own terminal`
        };
    }
    const mainBefore = requireText(values["main-before"] as string | undefined, "integration promote record <id> --main-before <sha>");
    const mainAfter = requireText(values["main-after"] as string | undefined, "integration promote record <id> --main-after <sha>");
    const mergeCommit = values["merge-commit"] as string | undefined;
    return commitShapeRefusal({ "--main-before": mainBefore, "--main-after": mainAfter, "--merge-commit": mergeCommit })
        ?? baseRefusal(promotion, mainBefore)
        ?? releaseDriftRefusal(ctx, promotion)
        ?? commitProofRefusal(ctx, promotion.candidate, mergeCommit, mainAfter, "main after the promotion")
        ?? treeRefusal(ctx, promotion, mainAfter);
}

// What lands on main is the reviewed candidate's bytes, exactly. A fast-forward
// carries them by construction; a merge commit is allowed only when its tree is
// byte-identical to the candidate's — a conflict resolution, or any other edit
// on the way in, is a tree nobody reviewed, and a reachable checkout refuses it.
function treeRefusal(ctx: ProjectContext, promotion: Promotion, mainAfter: string): Refusal | null
{
    const repoDir = repoDirOf(ctx, undefined, false);
    if (repoDir === null)
    {
        return null;
    }
    const candidateTree = treeOf(repoDir, promotion.candidate);
    const afterTree = treeOf(repoDir, mainAfter);
    if (candidateTree === null || afterTree === null || candidateTree === afterTree)
    {
        return null;
    }
    return {
        code: "promotion_tree_mismatch",
        detail: `main after the promotion holds tree ${short(afterTree)} and candidate ${short(promotion.candidate)} ` +
            `holds tree ${short(candidateTree)} — what landed is not the reviewed bytes`,
        next: "promote with a fast-forward or a merge commit whose tree is byte-identical to the candidate"
    };
}

// The release review read the delta base...candidate. A main that is no
// longer that base lands different bytes, so the pinned promotion is dead and
// a fresh one is requested against the main that is really there.
function baseRefusal(promotion: Promotion, mainBefore: string): Refusal | null
{
    if (mainBefore === promotion.base)
    {
        return null;
    }
    return {
        code: "release_base_moved",
        detail: `${promotion.id} pinned main at ${short(promotion.base)} and this promotion starts from ${short(mainBefore)} — ` +
            "the reviewed release delta is not what would land",
        next: `self integration promote request --repo ${promotion.repository} --candidate <sha> --main ${mainBefore}`
    };
}

// The last look at the release bytes, exactly as a change-set merge takes one:
// a declared digest that a now-reachable checkout contradicts stops the
// promotion.
function releaseDriftRefusal(ctx: ProjectContext, promotion: Promotion): Refusal | null
{
    const repoDir = repoDirOf(ctx, undefined, false);
    if (repoDir === null)
    {
        return null;
    }
    const digest = featureDigest(repoDir, promotion.base, promotion.candidate);
    if (digest === null || digest === promotion.digest)
    {
        return null;
    }
    return {
        code: "digest_drift",
        detail: `${promotion.id} is recorded at ${short(promotion.digest)} and ${short(promotion.base)}...` +
            `${short(promotion.candidate)} now hashes to ${short(digest)}`,
        next: `self integration promote request --repo ${promotion.repository} --candidate ${promotion.candidate} to pin the bytes that are really there`
    };
}

function closedRefusal(promotion: Promotion): Refusal
{
    return {
        code: "promotion_closed",
        detail: `${promotion.id} already promoted ${short(promotion.candidate)} into main`,
        next: "nothing — this promotion is recorded"
    };
}

function showPromotion(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseArgs({ args, options: { json: { type: "boolean" } }, allowPositionals: true });
    const state = loadIntegration(ctx);
    const promotion = requirePromotion(state, positionals[0]);
    const detail = {
        promotion: promotion.id, repository: promotion.repository, candidate: promotion.candidate,
        base: promotion.base, digest: promotion.digest, digestSource: promotion.digestSource,
        receipts: promotion.receipts.map((receipt) => ({
            receipt: receipt.id, scope: receipt.scope, verdict: receipt.verdict, digest: receipt.digest,
            standing: standingRelease(promotion)?.id === receipt.id
        })),
        approvals: promotion.approvals,
        recorded: promotion.recorded
    };
    if (printMachine(values.json, detail))
    {
        return;
    }
    printPromotion(promotion);
}

function printPromotion(promotion: Promotion): void
{
    const state = promotion.recorded !== undefined ? `promoted, main is now ${short(promotion.recorded.mainAfter)}`
        : promotionApproval(promotion) !== undefined ? "approved, awaiting record"
        : standingRelease(promotion) !== undefined ? "release-reviewed, awaiting human approval"
        : "awaiting release review";
    console.log(`${promotion.id} ${promotion.repository} — ${state}`);
    console.log(`  candidate ${short(promotion.candidate)} onto main ${short(promotion.base)} ` +
        `digest ${short(promotion.digest)} (${promotion.digestSource})`);
    for (const receipt of promotion.receipts)
    {
        console.log(`  receipt ${receipt.id} ${receipt.scope} ${receipt.verdict} ${short(receipt.digest)}`);
    }
    for (const approval of promotion.approvals)
    {
        console.log(`  approval ${approval.id} ${short(approval.head)} by ${approval.by}` +
            `${approval.humanConfirmed ? ` (human, ${approval.method})` : " (unverified — does not count)"}`);
    }
}

export function openPromotions(state: IntegrationState): Promotion[]
{
    return state.promotions.filter((item) => item.recorded === undefined);
}
