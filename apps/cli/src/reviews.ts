import { parseArgs } from "node:util";
import { commitStaged, stageArtifacts } from "./artifact.js";
import { ENVELOPE_SCHEMA, ReviewEnvelope, ValidatedEnvelope, readEnvelope, reviewContract } from "./envelope.js";
import { receiptId } from "./ids.js";
import { ChangeSet, IntegrationState, Promotion, ReviewScope, REVIEW_SCOPES, coverage, short } from "./integration.js";
import { refuse, Refusal, strip } from "./lane.js";
import { ProjectContext } from "./paths.js";
import { makeEvent, recordEvent, setMachineMode } from "./pipeline.js";
import { dim, styled } from "./style.js";
import { loadIntegration, printMachine, requireChangeSet, requirePromotion, requireText } from "./trainutil.js";
import { CliError } from "./types.js";

const REVIEW_USAGE = "usage: self review request <change-set> --scope change|integration_delta|release | ingest --file <envelope.json> | list [<change-set>] | contract";

export function cmdReview(ctx: ProjectContext, rest: string[]): void
{
    setMachineMode(rest.includes("--json"));
    if (rest[0] === "request")
    {
        requestReview(ctx, rest.slice(1));
        return;
    }
    if (rest[0] === "ingest")
    {
        ingestReview(ctx, rest.slice(1));
        return;
    }
    if (rest[0] === "list")
    {
        listReceipts(ctx, rest.slice(1));
        return;
    }
    if (rest[0] === "contract")
    {
        console.log(JSON.stringify(reviewContract(), null, 2));
        return;
    }
    throw new CliError(REVIEW_USAGE);
}

/* ── request ───────────────────────────────────────────────────────── */

// A request states the bounds a review must not exceed, and the digest its
// verdict will be bound to. It creates nothing: only an ingested envelope does.
// A change or delta review is requested on a change set; a release review is
// requested on a promotion, because that is the thing whose bytes it audits.
function requestReview(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseArgs({
        args,
        options: { scope: { type: "string" }, json: { type: "boolean" } },
        allowPositionals: true
    });
    const state = loadIntegration(ctx);
    const scope = requireScope(values.scope);
    const order = scope === "release"
        ? releaseOrder(requirePromotion(state, positionals[0]))
        : reviewOrder(requireChangeSet(state, positionals[0]), scope);
    const subject = scope === "release" ? { promotion: order.changeSet } : { changeSet: order.changeSet };
    recordEvent(ctx, makeEvent(ctx.project, "review.requested", { ...subject, scope, digest: order.digest }),
        `${order.changeSet} ${scope} ${short(order.digest)}`);
    if (!printMachine(values.json, order))
    {
        printOrder(order);
    }
}

interface ReviewOrder
{
    schema: string;
    changeSet: string;
    scope: ReviewScope;
    repository: string;
    base: string;
    head: string;
    digest: string;
    bounds: string[];
    ingest: string;
}

function reviewOrder(changeSet: ChangeSet, scope: ReviewScope): ReviewOrder
{
    return {
        schema: ENVELOPE_SCHEMA,
        changeSet: changeSet.id,
        scope,
        repository: changeSet.repository,
        base: changeSet.base,
        head: changeSet.head,
        digest: scope === "integration_delta" ? pendingDelta(changeSet) : changeSet.featureDigest,
        bounds: boundsOf(changeSet, scope),
        ingest: "self review ingest --file <envelope.json>"
    };
}

function pendingDelta(changeSet: ChangeSet): string
{
    const cover = coverage(changeSet);
    const delta = cover.uncovered[0];
    if (delta === undefined)
    {
        throw new CliError(`${changeSet.id} carries no integration delta awaiting review`);
    }
    return delta.digest;
}

// The bounds are what makes a review bounded: a delta review reads the
// resolution and the domains it crossed, not the whole feature again.
function boundsOf(changeSet: ChangeSet, scope: ReviewScope): string[]
{
    if (scope === "integration_delta")
    {
        const delta = coverage(changeSet).uncovered[0];
        return [
            `the integration delta only: ${delta?.paths.join(", ") || "the resolved paths"}`,
            `semantic intersections: ${delta?.intersections.join(", ") || "none declared"}`,
            "the change review already covers the feature bytes this delta started from"
        ];
    }
    return [
        `the feature diff ${short(changeSet.base)}...${short(changeSet.head)}`,
        `declared domains: ${changeSet.domains.map((domain) => `${domain.name}@${domain.version}`).join(", ") || "none"}`,
        "base movement that resolves without conflict does not require a re-review"
    ];
}

// A release audit reads exactly what promotion will land on main: the delta
// from the pinned release base to the exact candidate commit, no more and no
// less. Its verdict is bound to that digest, not to any one feature.
function releaseOrder(promotion: Promotion): ReviewOrder
{
    return {
        schema: ENVELOPE_SCHEMA,
        changeSet: promotion.id,
        scope: "release",
        repository: promotion.repository,
        base: promotion.base,
        head: promotion.candidate,
        digest: promotion.digest,
        bounds: [
            `the release delta ${short(promotion.base)}...${short(promotion.candidate)} — exactly what promotion lands on main`,
            "every change set inside the delta already carries its own change and delta receipts",
            "no change outside this delta is in scope"
        ],
        ingest: "self review ingest --file <envelope.json>"
    };
}

function printOrder(order: ReviewOrder): void
{
    console.log(`review ${order.changeSet} scope ${order.scope} bound to ${short(order.digest)}`);
    for (const bound of order.bounds)
    {
        console.log(styled ? dim(`  ${bound}`) : `  ${bound}`);
    }
    console.log(`  result: a ${order.schema} envelope, ingested with \`${order.ingest}\``);
}

function requireScope(value: string | undefined): ReviewScope
{
    if (!REVIEW_SCOPES.includes(value as ReviewScope))
    {
        throw new CliError(`--scope must be one of ${REVIEW_SCOPES.join(", ")}`);
    }
    return value as ReviewScope;
}

/* ── ingest ────────────────────────────────────────────────────────── */

// The supervisor's side of the runner contract. The envelope is validated, its
// artifact bytes are checked against the declared digest and copied into the
// store, and only then is a receipt recorded. Nothing here reads an exit code,
// a transcript or a claim.
function ingestReview(ctx: ProjectContext, args: string[]): void
{
    const { values } = parseArgs({ args, options: { file: { type: "string" }, json: { type: "boolean" } } });
    const file = requireText(values.file, "review ingest --file <envelope.json>");
    const validated = readEnvelope(file);
    const state = loadIntegration(ctx);
    if (validated.envelope.scope === "release")
    {
        return ingestRelease(ctx, state, validated, values.json);
    }
    const refusal = bindingRefusal(state, validated.envelope);
    if (refusal !== null)
    {
        return refuse(values.json, refusal);
    }
    const changeSet = requireChangeSet(state, validated.envelope.changeSet);
    const already = changeSet.receipts.find((receipt) => receipt.envelopeDigest === validated.envelopeDigest);
    if (already !== undefined)
    {
        return reportDuplicate(already, values.json);
    }
    recordReceipt(ctx, { changeSet: changeSet.id }, changeSet.work, validated, values.json);
}

// A release envelope binds to a promotion: the exact candidate commit as its
// head and the exact release-delta digest the promotion pinned. A verdict
// about any other bytes is a receipt about nothing.
function ingestRelease(ctx: ProjectContext, state: IntegrationState, validated: ValidatedEnvelope,
    json: boolean | undefined): void
{
    const envelope = validated.envelope;
    const promotion = state.promotions.find((item) => item.id === envelope.changeSet);
    if (promotion === undefined)
    {
        return refuse(json, {
            code: "promotion_unknown",
            detail: `no promotion "${envelope.changeSet}" is requested — a release review binds to a promotion, not a change set`,
            next: "self integration promote request --repo <name> --candidate <sha>"
        });
    }
    if (envelope.head !== promotion.candidate)
    {
        return refuse(json, {
            code: "head_mismatch",
            detail: `the envelope reviewed ${short(envelope.head)} and ${promotion.id} promotes ${short(promotion.candidate)}`,
            next: `self review request ${promotion.id} --scope release`
        });
    }
    if (envelope.digest !== promotion.digest)
    {
        return refuse(json, {
            code: "digest_unbound",
            detail: `digest ${short(envelope.digest)} is not the release-delta digest ${short(promotion.digest)} of ${promotion.id}`,
            next: `self review request ${promotion.id} --scope release`
        });
    }
    const already = promotion.receipts.find((receipt) => receipt.envelopeDigest === validated.envelopeDigest);
    if (already !== undefined)
    {
        return reportDuplicate(already, json);
    }
    recordReceipt(ctx, { promotion: promotion.id }, undefined, validated, json);
}

// The same envelope ingested twice is one receipt. A supervisor that crashed
// between recording and reporting retries safely, and a retry that quietly
// created a second verdict would be a second review that never happened.
function reportDuplicate(receipt: { id: string; envelopeDigest: string }, json: boolean | undefined): void
{
    if (printMachine(json, { ok: true, duplicate: true, receipt: receipt.id }))
    {
        return;
    }
    console.log(receipt.id);
    console.log(styled ? dim("this envelope was already ingested — no second receipt") : "already ingested");
}

function bindingRefusal(state: IntegrationState, envelope: ReviewEnvelope): Refusal | null
{
    const changeSet = state.changeSets.find((item) => item.id === envelope.changeSet);
    if (changeSet === undefined)
    {
        return { code: "changeset_unknown", detail: `no change set "${envelope.changeSet}" is registered`,
            next: "self integration list" };
    }
    if (envelope.head !== changeSet.head)
    {
        return { code: "head_mismatch", detail: `the envelope reviewed ${short(envelope.head)} and ${changeSet.id} is at ` +
            `${short(changeSet.head)}`, next: `self review request ${changeSet.id} --scope ${envelope.scope}` };
    }
    return digestRefusal(changeSet, envelope);
}

// A verdict must name bytes this controller already knows: the current feature
// digest, or one of the integration deltas awaiting a bounded review. Anything
// else is a receipt about nothing.
function digestRefusal(changeSet: ChangeSet, envelope: ReviewEnvelope): Refusal | null
{
    const known = envelope.scope === "integration_delta"
        ? changeSet.deltas.map((delta) => delta.digest)
        : [changeSet.featureDigest];
    if (!known.includes(envelope.digest))
    {
        return {
            code: "digest_unbound",
            detail: `digest ${short(envelope.digest)} is not ${envelope.scope === "integration_delta"
                ? `an integration delta of ${changeSet.id}` : `the current feature digest of ${changeSet.id}`}`,
            next: `self review request ${changeSet.id} --scope ${envelope.scope}`
        };
    }
    return null;
}

function recordReceipt(ctx: ProjectContext, subject: Record<string, string>, work: string | undefined,
    validated: ValidatedEnvelope, json: boolean | undefined): void
{
    const envelope = validated.envelope;
    const id = receiptId();
    const staged = stageArtifacts(ctx.storeDir, ctx.project, [validated.artifactPath]);
    const stored = staged.artifacts[0];
    const payload = strip({
        receipt: id, ...subject, scope: envelope.scope, base: envelope.base, head: envelope.head,
        digest: envelope.digest, verdict: envelope.verdict, findings: envelope.findings, tests: envelope.tests,
        artifact: { ...stored, sha256: envelope.artifact.sha256 }, envelopeDigest: validated.envelopeDigest,
        reviewer: envelope.reviewer.name, model: envelope.reviewer.model, session: envelope.reviewer.session,
        completedAt: envelope.completedAt
    });
    const refs = { work, artifacts: [stored.id] };
    commitStaged(staged, (recorded) => recordEvent(ctx, makeEvent(ctx.project, "review.received", payload, strip(refs)),
        `${Object.values(subject)[0]} ${envelope.scope} ${envelope.verdict}`, recorded));
    if (!printMachine(json, { ok: true, receipt: id, ...payload }))
    {
        console.log(id);
    }
}

/* ── list ──────────────────────────────────────────────────────────── */

function listReceipts(ctx: ProjectContext, args: string[]): void
{
    const { values, positionals } = parseArgs({ args, options: { json: { type: "boolean" } }, allowPositionals: true });
    const state = loadIntegration(ctx);
    const changeSets = positionals[0] === undefined ? state.changeSets : [requireChangeSet(state, positionals[0])];
    const rows = changeSets.flatMap((changeSet) => changeSet.receipts.map((receipt) => ({
        receipt: receipt.id,
        changeSet: changeSet.id,
        scope: receipt.scope,
        verdict: receipt.verdict,
        digest: receipt.digest,
        current: currentFor(changeSet, receipt.scope, receipt.digest),
        head: receipt.head,
        model: receipt.model,
        artifact: receipt.artifact?.path,
        ts: receipt.ts
    })));
    if (printMachine(values.json, rows))
    {
        return;
    }
    for (const row of rows)
    {
        console.log(`${row.receipt}  ${row.changeSet}  ${row.scope}  ${row.verdict}  ` +
            `${row.current ? "current" : "superseded"}  ${short(row.digest)}  ${row.model}`);
    }
    if (rows.length === 0)
    {
        console.log("no review receipts — a receipt exists only after `self review ingest`");
    }
}

// A receipt stays on record for ever; whether it still says anything about the
// bytes in front of us is a separate question, and this is where it is asked.
function currentFor(changeSet: ChangeSet, scope: ReviewScope, digest: string): boolean
{
    if (scope === "integration_delta")
    {
        return coverage(changeSet).chain.some((delta) => delta.digest === digest);
    }
    return digest === changeSet.featureDigest;
}
