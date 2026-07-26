import { parseArgs } from "node:util";
import { foldDelivery } from "./fold.js";
import {
    DEFAULT_REQUIRED_CHECKS,
    failingChecks,
    lastReview,
    missingEvidence,
    requireFreshSession,
    requirePr,
    requireVerb,
    TRANSITIONS
} from "./gates.js";
import { renderComment, renderStatus } from "./render.js";
import { sanitize, sanitizeReference } from "./sanitize.js";
import { appendEvent, readEvents, recordFile, requireRecord } from "./store.js";
import { Delivery, DeliveryError } from "./types.js";

const USAGE = `usage: delivery <command> --issue <number>

  open --session <id> [--max-review-rounds n] [--required-check name]...
  pr --pr <number> --head <sha> [--signed-off]
  check --name <check> --status green|red|pending [--head <sha>]
  review start --session <id>
  review finish --head <sha> --findings <n> [--note "<text>"]
  fix --head <sha> [--note "<text>"]
  merge --commit <sha>
  release --tag <vX.Y.Z> --package-version <X.Y.Z> --npm-version <X.Y.Z> --release-url <url>
  install --version <X.Y.Z>
  smoke --name <check> --status pass|fail [--detail "<text>"]
  log --reference <path>
  fail --reason "<text>" [--reference <path>]...
  resume
  done
  status [--json]
  comment
  states                                     print the lifecycle contract this tool enforces

The ledger lives outside the repository, under $SUPERSELF_DELIVERY_DIR.
Every recorded string is redacted and truncated before it is written.`;

const OPTIONS = {
    issue: { type: "string" },
    session: { type: "string" },
    pr: { type: "string" },
    head: { type: "string" },
    "signed-off": { type: "boolean" },
    name: { type: "string" },
    status: { type: "string" },
    findings: { type: "string" },
    note: { type: "string" },
    commit: { type: "string" },
    tag: { type: "string" },
    "package-version": { type: "string" },
    "npm-version": { type: "string" },
    "release-url": { type: "string" },
    version: { type: "string" },
    detail: { type: "string" },
    reason: { type: "string" },
    reference: { type: "string", multiple: true },
    "max-review-rounds": { type: "string" },
    "required-check": { type: "string", multiple: true },
    json: { type: "boolean" }
} as const;

function parse(argv: string[])
{
    return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
}

type Values = ReturnType<typeof parse>["values"];

type Command = (issue: number, flags: Values, positionals: string[]) => void;

const COMMANDS: Record<string, Command> = {
    open: cmdOpen,
    pr: cmdPr,
    check: cmdCheck,
    review: cmdReview,
    fix: cmdFix,
    merge: cmdMerge,
    release: cmdRelease,
    install: cmdInstall,
    smoke: cmdSmoke,
    log: cmdLog,
    fail: cmdFail,
    resume: cmdResume,
    done: cmdDone,
    status: cmdStatus,
    comment: (issue) => console.log(renderComment(load(issue)))
};

function main(argv: string[]): void
{
    const { values: flags, positionals } = parse(argv);
    const command = positionals[0];
    if (command === "states")
    {
        printStates();
        return;
    }
    // Usage before --issue: a runner that mistypes a verb should be told the
    // verbs, not that it forgot a flag the verb never had.
    const handler = command === undefined ? undefined : COMMANDS[command];
    if (handler === undefined)
    {
        console.log(USAGE);
        return;
    }
    handler(requireIssue(flags), flags, positionals);
}

function printStates(): void
{
    for (const transition of TRANSITIONS)
    {
        const target = transition.to.length === 0 ? "(records evidence)" : transition.to.join(" | ");
        console.log(`${transition.verb.padEnd(15)} ${transition.from.join(" | ")} -> ${target}`);
    }
}

function cmdOpen(issue: number, flags: Values): void
{
    if (readEvents(issue).length > 0)
    {
        throw new DeliveryError(`issue #${issue} already has a delivery record at ${recordFile(issue)}`);
    }
    const rounds = flags["max-review-rounds"] === undefined ? 5 : Number.parseInt(flags["max-review-rounds"], 10);
    if (Number.isNaN(rounds) || rounds < 1)
    {
        throw new DeliveryError("--max-review-rounds expects a positive number");
    }
    const checks = flags["required-check"] ?? DEFAULT_REQUIRED_CHECKS;
    appendEvent(issue, "opened", {
        session: sanitize(required(flags.session, "--session")),
        maxReviewRounds: rounds,
        requiredChecks: checks.map(sanitize)
    });
    report(issue, "implementation started");
}

function cmdPr(issue: number, flags: Values): void
{
    requireVerb(load(issue), "pr");
    const number = Number.parseInt(required(flags.pr, "--pr"), 10);
    if (Number.isNaN(number) || number < 1)
    {
        throw new DeliveryError("--pr expects a pull request number");
    }
    appendEvent(issue, "pr.opened", {
        pr: number,
        head: commitish(required(flags.head, "--head")),
        signedOff: flags["signed-off"] === true
    });
    report(issue, `pull request #${number} recorded`);
}

function cmdCheck(issue: number, flags: Values): void
{
    const delivery = load(issue);
    requireVerb(delivery, "check");
    const status = required(flags.status, "--status");
    if (!["green", "red", "pending"].includes(status))
    {
        throw new DeliveryError("--status expects green, red, or pending");
    }
    const head = flags.head === undefined ? requirePr(delivery).head : commitish(flags.head);
    const name = sanitize(required(flags.name, "--name"));
    appendEvent(issue, "check.recorded", { head, name, status });
    report(issue, `check ${name} is ${status} at ${head}`);
}

function cmdReview(issue: number, flags: Values, positionals: string[]): void
{
    const sub = positionals[1];
    if (sub === "start")
    {
        reviewStart(issue, flags);
        return;
    }
    if (sub === "finish")
    {
        reviewFinish(issue, flags);
        return;
    }
    throw new DeliveryError("usage: delivery review start|finish --issue <number>");
}

// The review session id is the only evidence that a second, fresh session read
// the issue and the diff. It is checked against every session already recorded.
function reviewStart(issue: number, flags: Values): void
{
    const delivery = load(issue);
    requireVerb(delivery, "review start");
    const session = sanitize(required(flags.session, "--session"));
    requireFreshSession(delivery, session);
    const head = requirePr(delivery).head;
    appendEvent(issue, "review.started", { session, head });
    report(issue, `review round ${delivery.reviews.length + 1} started at ${head}`);
}

// A round reports the head it actually read. If a fix landed while the review
// ran, the reviewed head is stale and the round cannot count as coverage of
// the complete pull request.
function reviewFinish(issue: number, flags: Values): void
{
    const delivery = load(issue);
    requireVerb(delivery, "review finish");
    const round = lastReview(delivery);
    const head = commitish(required(flags.head, "--head"));
    if (round === undefined || head !== round.head || head !== requirePr(delivery).head)
    {
        throw new DeliveryError(`review covered ${head}, which is not the current pull request head ${requirePr(delivery).head}`);
    }
    const findings = Number.parseInt(required(flags.findings, "--findings"), 10);
    if (Number.isNaN(findings) || findings < 0)
    {
        throw new DeliveryError("--findings expects a count of actionable findings");
    }
    appendEvent(issue, "review.finished", { findings, note: sanitize(flags.note ?? "") });
    escalateIfStuck(issue, delivery, round.round, findings);
    report(issue, `review round ${round.round} reported ${findings} actionable findings`);
}

// Non-convergence is a failure, never a reason to lower the bar. The record
// keeps the pull request and every round, so a human picks up an escalation
// with the whole history intact.
function escalateIfStuck(issue: number, delivery: Delivery, round: number, findings: number): void
{
    if (findings > 0 && round >= delivery.maxReviewRounds)
    {
        appendEvent(issue, "failed", {
            reason: `review did not converge after ${round} rounds`,
            from: "fixing"
        });
    }
}

function cmdFix(issue: number, flags: Values): void
{
    const delivery = load(issue);
    requireVerb(delivery, "fix");
    const head = commitish(required(flags.head, "--head"));
    if (head === requirePr(delivery).head)
    {
        throw new DeliveryError("a fix must push a new head commit — the pull request still points at the reviewed commit");
    }
    appendEvent(issue, "fix.pushed", { head, note: sanitize(flags.note ?? "") });
    report(issue, `fix pushed as ${head}; checks must run again before the next review`);
}

function cmdMerge(issue: number, flags: Values): void
{
    const delivery = load(issue);
    requireVerb(delivery, "merge");
    if (!requirePr(delivery).signedOff)
    {
        throw new DeliveryError("the pull request is not recorded as signed off — the dco check cannot pass");
    }
    const failing = failingChecks(delivery);
    if (failing.length > 0)
    {
        throw new DeliveryError(`required checks are not green at ${requirePr(delivery).head}: ${failing.join(", ")}`);
    }
    appendEvent(issue, "merged", { commit: commitish(required(flags.commit, "--commit")) });
    report(issue, "merged; the release may now be tagged");
}

// One tag, one package version, one published version. The publish workflow
// enforces tag/manifest equality in CI; this adds the version npm actually
// reports back, so a partial publish cannot be mistaken for a release.
function cmdRelease(issue: number, flags: Values): void
{
    requireVerb(load(issue), "release");
    const packageVersion = semver(required(flags["package-version"], "--package-version"));
    const npmVersion = semver(required(flags["npm-version"], "--npm-version"));
    const tag = sanitize(required(flags.tag, "--tag"));
    if (tag !== `v${packageVersion}` || npmVersion !== packageVersion)
    {
        throw new DeliveryError(`tag ${tag}, package version ${packageVersion}, and npm version ${npmVersion} must name one release`);
    }
    appendEvent(issue, "released", {
        tag,
        packageVersion,
        npmVersion,
        releaseUrl: httpsUrl(required(flags["release-url"], "--release-url"))
    });
    report(issue, `${tag} published as ${npmVersion}; this machine must now update`);
}

function cmdInstall(issue: number, flags: Values): void
{
    const delivery = load(issue);
    requireVerb(delivery, "install");
    const version = semver(required(flags.version, "--version"));
    const published = delivery.release === null ? "" : delivery.release.npmVersion;
    if (version !== published)
    {
        throw new DeliveryError(`this machine reports ${version}, but ${published} was published — install the exact version`);
    }
    appendEvent(issue, "installed", { version });
    report(issue, `global CLI is ${version}`);
}

function cmdSmoke(issue: number, flags: Values): void
{
    const delivery = load(issue);
    requireVerb(delivery, "smoke");
    if (delivery.localVersion === null)
    {
        throw new DeliveryError("record the installed version before smoking it — run `delivery install` first");
    }
    const status = required(flags.status, "--status");
    if (!["pass", "fail"].includes(status))
    {
        throw new DeliveryError("--status expects pass or fail");
    }
    const name = sanitize(required(flags.name, "--name"));
    appendEvent(issue, "smoke.recorded", { name, passed: status === "pass", detail: sanitize(flags.detail ?? "") });
    report(issue, `smoke ${name}: ${status}`);
}

function cmdLog(issue: number, flags: Values): void
{
    requireVerb(load(issue), "log");
    for (const reference of requireReferences(flags))
    {
        appendEvent(issue, "log.attached", { reference: sanitizeReference(reference) });
    }
    report(issue, "log reference attached");
}

function cmdFail(issue: number, flags: Values): void
{
    const delivery = load(issue);
    requireVerb(delivery, "fail");
    for (const reference of flags.reference ?? [])
    {
        appendEvent(issue, "log.attached", { reference: sanitizeReference(reference) });
    }
    appendEvent(issue, "failed", { reason: sanitize(required(flags.reason, "--reason")), from: delivery.state });
    report(issue, `failed from ${delivery.state} — escalate, do not publish`);
}

// Resume returns to the state the delivery fell from, so a failed publish
// retries the publish and never reruns the implementation.
function cmdResume(issue: number): void
{
    const delivery = load(issue);
    requireVerb(delivery, "resume");
    const failure = delivery.failure;
    if (failure === null)
    {
        throw new DeliveryError("nothing to resume: no failure is recorded");
    }
    appendEvent(issue, "resumed", { to: failure.from });
    report(issue, `resumed at ${failure.from}`);
}

function cmdDone(issue: number): void
{
    const delivery = load(issue);
    requireVerb(delivery, "done");
    const missing = missingEvidence(delivery);
    if (missing.length > 0)
    {
        throw new DeliveryError(`the evidence chain is incomplete:\n  - ${missing.join("\n  - ")}`);
    }
    appendEvent(issue, "done", {});
    report(issue, "released: every piece of evidence is recorded");
}

function cmdStatus(issue: number, flags: Values): void
{
    const delivery = load(issue);
    console.log(flags.json === true ? JSON.stringify(delivery, null, 2) : renderStatus(delivery));
}

function load(issue: number): Delivery
{
    return foldDelivery(issue, requireRecord(issue));
}

function report(issue: number, summary: string): void
{
    console.log(`${load(issue).state}  ${summary}`);
}

function requireIssue(flags: Values): number
{
    const issue = Number.parseInt(required(flags.issue, "--issue"), 10);
    if (Number.isNaN(issue) || issue < 1)
    {
        throw new DeliveryError("--issue expects an issue number");
    }
    return issue;
}

function requireReferences(flags: Values): string[]
{
    const references = flags.reference ?? [];
    if (references.length === 0)
    {
        throw new DeliveryError("--reference expects a path to a preserved log");
    }
    return references;
}

function required(value: string | undefined, flag: string): string
{
    if (value === undefined || value.trim() === "")
    {
        throw new DeliveryError(`${flag} is required`);
    }
    return value;
}

function commitish(value: string): string
{
    const commit = value.trim().toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(commit))
    {
        throw new DeliveryError(`"${sanitize(value)}" is not a commit sha`);
    }
    return commit;
}

function semver(value: string): string
{
    const version = value.trim();
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    {
        throw new DeliveryError(`"${sanitize(value)}" is not a semantic version`);
    }
    return version;
}

function httpsUrl(value: string): string
{
    const url = sanitize(value);
    if (!url.startsWith("https://"))
    {
        throw new DeliveryError("--release-url expects an https url");
    }
    return url;
}

try
{
    main(process.argv.slice(2));
}
catch (error)
{
    if (error instanceof DeliveryError)
    {
        console.error(`error: ${error.message}`);
        process.exitCode = 1;
    }
    else
    {
        throw error;
    }
}
