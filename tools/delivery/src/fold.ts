import {
    CheckStatus,
    Delivery,
    DeliveryEvent,
    DeliveryState,
    SmokeCheck
} from "./types.js";

type Handler = (delivery: Delivery, payload: Record<string, unknown>) => void;

// Every state below is derived from the event log, never asserted. A resumed
// release replays the same events and lands on the same state, which is what
// makes a failed publish retryable without touching the implementation.
const HANDLERS: Record<string, Handler> = {
    "opened": (delivery, payload) =>
    {
        delivery.implementationSession = text(payload.session);
        delivery.maxReviewRounds = count(payload.maxReviewRounds);
        delivery.requiredChecks = strings(payload.requiredChecks);
        delivery.state = "implementing";
    },
    "pr.opened": (delivery, payload) =>
    {
        delivery.pr = { number: count(payload.pr), head: text(payload.head), signedOff: payload.signedOff === true };
        delivery.state = "pr_ready";
    },
    "check.recorded": (delivery, payload) =>
    {
        delivery.checks.push({
            head: text(payload.head),
            name: text(payload.name),
            status: text(payload.status) as CheckStatus
        });
    },
    "review.started": (delivery, payload) =>
    {
        delivery.reviews.push({
            round: delivery.reviews.length + 1,
            session: text(payload.session),
            head: text(payload.head),
            findings: null
        });
        delivery.state = "reviewing";
    },
    "review.finished": (delivery, payload) => finishReview(delivery, count(payload.findings)),
    "fix.pushed": (delivery, payload) =>
    {
        if (delivery.pr !== null)
        {
            delivery.pr = { ...delivery.pr, head: text(payload.head) };
        }
        delivery.state = "pr_ready";
    },
    "merged": (delivery, payload) =>
    {
        delivery.mergeCommit = text(payload.commit);
        delivery.state = "releasing";
    },
    "released": (delivery, payload) =>
    {
        delivery.release = {
            tag: text(payload.tag),
            packageVersion: text(payload.packageVersion),
            npmVersion: text(payload.npmVersion),
            releaseUrl: text(payload.releaseUrl)
        };
        delivery.state = "local_updating";
    },
    "installed": (delivery, payload) => { delivery.localVersion = text(payload.version); },
    "smoke.recorded": (delivery, payload) => recordSmoke(delivery, payload),
    "log.attached": (delivery, payload) => { delivery.logs.push(text(payload.reference)); },
    "failed": (delivery, payload) =>
    {
        delivery.failure = { reason: text(payload.reason), from: text(payload.from) as DeliveryState };
        delivery.state = "failed";
    },
    "resumed": (delivery, payload) =>
    {
        delivery.state = text(payload.to) as DeliveryState;
        delivery.failure = null;
    },
    "done": (delivery) => { delivery.state = "released"; }
};

export function foldDelivery(issue: number, events: DeliveryEvent[]): Delivery
{
    const delivery = emptyDelivery(issue);
    for (const event of events)
    {
        HANDLERS[event.type]?.(delivery, event.payload);
    }
    return delivery;
}

function emptyDelivery(issue: number): Delivery
{
    return {
        issue,
        state: "implementing",
        maxReviewRounds: 0,
        requiredChecks: [],
        implementationSession: "",
        pr: null,
        checks: [],
        reviews: [],
        mergeCommit: null,
        release: null,
        localVersion: null,
        smoke: [],
        logs: [],
        failure: null
    };
}

// A clean review only means "nothing left to fix". Whether the pull request may
// actually merge is decided by the required checks at merge time, so a clean
// review lands in `merging`, not in the merge itself.
function finishReview(delivery: Delivery, findings: number): void
{
    const round = delivery.reviews.at(-1);
    if (round === undefined)
    {
        return;
    }
    round.findings = findings;
    delivery.state = findings === 0 ? "merging" : "fixing";
}

// The last verdict for a name wins, so a re-run after a fixed environment
// replaces the failure instead of leaving both readings in the evidence.
function recordSmoke(delivery: Delivery, payload: Record<string, unknown>): void
{
    const check: SmokeCheck = {
        name: text(payload.name),
        passed: payload.passed === true,
        detail: text(payload.detail)
    };
    delivery.smoke = delivery.smoke.filter((existing) => existing.name !== check.name).concat(check);
}

function text(value: unknown): string
{
    return typeof value === "string" ? value : "";
}

function count(value: unknown): number
{
    return typeof value === "number" ? value : 0;
}

function strings(value: unknown): string[]
{
    return Array.isArray(value) ? value.map(text) : [];
}
