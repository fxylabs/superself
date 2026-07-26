import { failingChecks, missingEvidence } from "./gates.js";
import { Delivery } from "./types.js";

export function renderStatus(delivery: Delivery): string
{
    const lines = [
        `issue      #${delivery.issue}`,
        `state      ${delivery.state}`,
        `pr         ${delivery.pr === null ? "—" : `#${delivery.pr.number} head ${delivery.pr.head}`}`,
        `checks     ${renderChecks(delivery)}`,
        `reviews    ${renderReviews(delivery)}`,
        `merge      ${delivery.mergeCommit ?? "—"}`,
        `release    ${renderRelease(delivery)}`,
        `local      ${delivery.localVersion ?? "—"}`,
        `smoke      ${renderSmoke(delivery)}`,
        `logs       ${delivery.logs.length === 0 ? "—" : delivery.logs.join(", ")}`
    ];
    if (delivery.failure !== null)
    {
        lines.push(`failure    ${delivery.failure.reason} (from ${delivery.failure.from})`);
    }
    const missing = missingEvidence(delivery);
    if (delivery.state !== "released" && missing.length > 0)
    {
        lines.push("missing", ...missing.map((item) => `  - ${item}`));
    }
    return lines.join("\n");
}

// What the runner posts on the issue. It reads from the ledger only, which is
// already redacted, so no separate scrub is needed at publication time.
export function renderComment(delivery: Delivery): string
{
    const lines = [
        `### Delivery evidence for #${delivery.issue}`,
        "",
        `- state: \`${delivery.state}\``,
        `- pull request: ${delivery.pr === null ? "—" : `#${delivery.pr.number} at \`${delivery.pr.head}\``}`,
        `- review rounds: ${renderReviews(delivery)}`,
        `- required checks: ${renderChecks(delivery)}`,
        `- merge commit: ${delivery.mergeCommit === null ? "—" : `\`${delivery.mergeCommit}\``}`,
        `- release: ${renderRelease(delivery)}`,
        `- local \`self --version\`: ${delivery.localVersion ?? "—"}`,
        `- smoke: ${renderSmoke(delivery)}`,
        `- logs: ${delivery.logs.length === 0 ? "—" : delivery.logs.join(", ")}`
    ];
    if (delivery.failure !== null)
    {
        lines.push("", `Escalated: ${delivery.failure.reason} (failed from \`${delivery.failure.from}\`).`);
    }
    return lines.join("\n") + "\n";
}

function renderChecks(delivery: Delivery): string
{
    if (delivery.requiredChecks.length === 0)
    {
        return "—";
    }
    const failing = failingChecks(delivery);
    return delivery.requiredChecks
        .map((name) => `${name} ${failing.includes(name) ? "not green" : "green"}`)
        .join(", ");
}

function renderReviews(delivery: Delivery): string
{
    if (delivery.reviews.length === 0)
    {
        return "—";
    }
    return delivery.reviews
        .map((round) => `${round.round}:${round.session} ${round.findings === null ? "open" : `${round.findings} findings`}`)
        .join(", ");
}

function renderRelease(delivery: Delivery): string
{
    const release = delivery.release;
    return release === null
        ? "—"
        : `${release.tag} → npm ${release.npmVersion} (${release.releaseUrl})`;
}

function renderSmoke(delivery: Delivery): string
{
    return delivery.smoke.length === 0
        ? "—"
        : delivery.smoke.map((check) => `${check.name} ${check.passed ? "ok" : "FAILED"}`).join(", ");
}
