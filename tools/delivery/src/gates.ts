import { Delivery, DeliveryError, DeliveryState, PullRequest, ReviewRound } from "./types.js";

export const DEFAULT_REQUIRED_CHECKS = ["verify", "contribution-policy", "dco"];

// The smoke names that must pass on the machine before the issue is done. The
// three fixed ones prove the freshly installed CLI runs at all; the `feature:`
// prefix forces one check that only this change would satisfy.
export const REQUIRED_SMOKE = ["self --version", "self context", "self status"];
export const FEATURE_SMOKE_PREFIX = "feature:";

export const TERMINAL_STATES: DeliveryState[] = ["released", "failed"];

export interface Transition
{
    verb: string;
    from: DeliveryState[];
    to: DeliveryState[];
}

const LIVE_STATES: DeliveryState[] = [
    "implementing",
    "pr_ready",
    "reviewing",
    "fixing",
    "merging",
    "releasing",
    "local_updating"
];

// The whole lifecycle contract in one table: the gating below reads it, and
// `delivery states` prints it, so the documented graph and the enforced graph
// cannot drift apart. An empty `to` means the verb records evidence without
// moving the delivery.
export const TRANSITIONS: Transition[] = [
    { verb: "pr", from: ["implementing"], to: ["pr_ready"] },
    { verb: "review start", from: ["pr_ready"], to: ["reviewing"] },
    { verb: "review finish", from: ["reviewing"], to: ["merging", "fixing"] },
    { verb: "fix", from: ["fixing"], to: ["pr_ready"] },
    { verb: "merge", from: ["merging"], to: ["releasing"] },
    { verb: "release", from: ["releasing"], to: ["local_updating"] },
    { verb: "install", from: ["local_updating"], to: [] },
    { verb: "smoke", from: ["local_updating"], to: [] },
    { verb: "done", from: ["local_updating"], to: ["released"] },
    { verb: "check", from: LIVE_STATES, to: [] },
    { verb: "log", from: LIVE_STATES, to: [] },
    { verb: "fail", from: LIVE_STATES, to: ["failed"] },
    { verb: "resume", from: ["failed"], to: LIVE_STATES }
];

export function requireVerb(delivery: Delivery, verb: string): void
{
    const transition = TRANSITIONS.find((candidate) => candidate.verb === verb);
    if (transition === undefined)
    {
        throw new DeliveryError(`unknown lifecycle verb "${verb}"`);
    }
    if (!transition.from.includes(delivery.state))
    {
        throw new DeliveryError(
            `\`${verb}\` is not legal from state "${delivery.state}" — it runs from ${transition.from.join(", ")}`
        );
    }
}

// A review that reuses the implementation session, or an earlier review
// session, is the implementation agent grading its own homework. The ledger is
// the only place that can see the difference, so it refuses here.
export function requireFreshSession(delivery: Delivery, session: string): void
{
    if (session === delivery.implementationSession)
    {
        throw new DeliveryError("review session must differ from the implementation session — start a new session");
    }
    if (delivery.reviews.some((round) => round.session === session))
    {
        throw new DeliveryError(`review session "${session}" already reviewed this pull request — each round needs a new session`);
    }
}

export function requirePr(delivery: Delivery): PullRequest
{
    if (delivery.pr === null)
    {
        throw new DeliveryError("no pull request recorded yet");
    }
    return delivery.pr;
}

// Nothing may be called green from an old commit: a fix invalidates every check
// that ran before it, so the head is part of the check's identity.
export function failingChecks(delivery: Delivery): string[]
{
    const head = delivery.pr === null ? "" : delivery.pr.head;
    return delivery.requiredChecks.filter((name) =>
    {
        const latest = delivery.checks.filter((check) => check.head === head && check.name === name).at(-1);
        return latest === undefined || latest.status !== "green";
    });
}

export function lastReview(delivery: Delivery): ReviewRound | undefined
{
    return delivery.reviews.at(-1);
}

// The complete answer to "may this issue close?". `done` prints whatever is
// still listed here instead of closing on a partial evidence chain.
export function missingEvidence(delivery: Delivery): string[]
{
    return [
        ...prEvidence(delivery),
        ...reviewEvidence(delivery),
        ...releaseEvidence(delivery),
        ...localEvidence(delivery)
    ];
}

function prEvidence(delivery: Delivery): string[]
{
    if (delivery.pr === null)
    {
        return ["pull request number and head commit"];
    }
    const missing = delivery.pr.signedOff ? [] : ["a signed-off pull request"];
    return missing.concat(failingChecks(delivery).map((name) => `required check "${name}" green at ${delivery.pr?.head}`));
}

function reviewEvidence(delivery: Delivery): string[]
{
    const last = lastReview(delivery);
    if (last === undefined)
    {
        return ["at least one fresh-session review"];
    }
    const missing: string[] = [];
    if (last.findings !== 0)
    {
        missing.push("a review round that reported zero actionable findings");
    }
    if (delivery.pr !== null && last.head !== delivery.pr.head)
    {
        missing.push(`a review of the current head ${delivery.pr.head} (last review covered ${last.head})`);
    }
    return missing;
}

function releaseEvidence(delivery: Delivery): string[]
{
    const missing = delivery.mergeCommit === null ? ["a merge commit"] : [];
    if (delivery.release === null)
    {
        return missing.concat("a tag, package version, npm version, and GitHub Release url");
    }
    return missing;
}

function localEvidence(delivery: Delivery): string[]
{
    const missing: string[] = [];
    if (delivery.localVersion === null)
    {
        missing.push("the version of the global CLI installed on this machine");
    }
    else if (delivery.release !== null && delivery.localVersion !== delivery.release.npmVersion)
    {
        missing.push(`a local install of ${delivery.release.npmVersion} (this machine runs ${delivery.localVersion})`);
    }
    return missing.concat(missingSmoke(delivery));
}

function missingSmoke(delivery: Delivery): string[]
{
    const passed = delivery.smoke.filter((check) => check.passed).map((check) => check.name);
    const missing = REQUIRED_SMOKE.filter((name) => !passed.includes(name)).map((name) => `a passing \`${name}\` smoke check`);
    return passed.some((name) => name.startsWith(FEATURE_SMOKE_PREFIX))
        ? missing
        : missing.concat(`a passing feature-specific smoke check named \`${FEATURE_SMOKE_PREFIX}<name>\``);
}
