import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Boundary, boundaryDigest, boundaryEnv, BoundaryIdentity, runBounded } from "./boundary.js";
import { AttemptPlan, policyDigest } from "./plan.js";
import { ProbeReport } from "./probe.js";

export interface PreflightCheck
{
    capability: string;
    target: string;
    ok: boolean;
    detail: string;
}

// The durable record that binds one capability probe to one attempt: which
// boundary it ran in, on which machine and boot, under which policy. A later
// reader can tell that the boundary the probe cleared is the boundary the
// provider ran in — and the runner refuses to launch when it cannot.
export interface PreflightReceipt
{
    attempt: string;
    work: string;
    role: string;
    fence: number;
    nodeId: string;
    bootId: string;
    adapter: string;
    boundaryDigest: string;
    innerDigest: string | null;
    policyDigest: string;
    ts: string;
    ok: boolean;
    checks: PreflightCheck[];
}

export function adapterOf(boundary: Boundary): string
{
    return boundary.wrapper.length === 0 ? "host" : boundary.wrapper[0];
}

function probeProgram(): string
{
    return join(dirname(fileURLToPath(import.meta.url)), "probe.js");
}

// Runner-side checks first: whether the work exists and whether a budget was
// granted are questions about this workspace, not about the boundary. The
// boundary answers everything a process inside it can observe, and it answers
// through the same launcher the provider will use.
export async function runPreflight(
    plan: AttemptPlan,
    attemptId: string,
    fence: number,
    identity: BoundaryIdentity,
    local: PreflightCheck[]
): Promise<PreflightReceipt>
{
    const manifest = {
        envNames: Object.keys({ ...Object.fromEntries(plan.boundary.passthrough.map((name) => [name, ""])), ...plan.boundary.env }),
        read: plan.capabilities.read,
        write: plan.capabilities.write,
        provider: plan.capabilities.provider,
        domains: plan.capabilities.domains,
        tools: plan.capabilities.tools,
        secrets: plan.capabilities.secrets,
        self: plan.capabilities.self,
        timeoutMs: Math.max(1_000, Math.floor(plan.preflightTimeoutMs / 2))
    };
    const outcome = await runBounded(plan.boundary, [process.execPath, probeProgram(), JSON.stringify(manifest)], plan.preflightTimeoutMs);
    const report = parseReport(outcome.stdout);
    const checks = [...local, ...boundaryChecks(outcome, report), identityCheck(plan.boundary, report), ...await browserChecks(plan)]
        .filter((check): check is PreflightCheck => check !== null);
    return {
        attempt: attemptId,
        work: plan.work,
        role: plan.role,
        fence,
        nodeId: identity.nodeId,
        bootId: identity.bootId,
        adapter: adapterOf(plan.boundary),
        boundaryDigest: identity.digest,
        innerDigest: report?.innerDigest ?? null,
        policyDigest: policyDigest(plan),
        ts: new Date().toISOString(),
        ok: checks.every((check) => check.ok),
        checks
    };
}

// The probe reports the boundary it actually found itself in. If a wrapper
// rewrote the working directory or dropped a variable on the way, that answer
// differs from the one the runner configured — and the provider would have
// been launched into the rewritten boundary, not the cleared one. The mismatch
// is the failure, and it costs nothing to find here.
function identityCheck(boundary: Boundary, report: ProbeReport | null): PreflightCheck | null
{
    if (report === null)
    {
        return null;
    }
    const expected = expectedInnerDigest(boundary);
    const ok = expected === report.innerDigest;
    return {
        capability: "boundary",
        target: "probe and launch identity",
        ok,
        detail: ok
            ? `probe ran in the configured boundary (${expected.slice(0, 12)})`
            : `the launcher put the probe in a different boundary than the runner configured (configured ${expected.slice(0, 12)}, probe saw ${report.innerDigest.slice(0, 12)} at ${report.cwd})`
    };
}

// Built exactly as the probe builds its own, so a difference can only mean the
// boundary differs. The working directory is resolved because a launcher that
// follows symlinks is not drift.
export function expectedInnerDigest(boundary: Boundary): string
{
    const resolved = boundaryEnv(boundary);
    const env: [string, string][] = [];
    for (const name of Object.keys(resolved).sort())
    {
        env.push([name, resolved[name]]);
    }
    return createHash("sha256").update(JSON.stringify({ cwd: realCwd(boundary.cwd), env })).digest("hex");
}

function realCwd(cwd: string): string
{
    try
    {
        return realpathSync(cwd);
    }
    catch
    {
        return cwd;
    }
}

// A signed-in browser tab is a capability like any other, and the only honest
// way to ask about it is to ask the session itself. The plan supplies the
// probe because only it knows how this machine talks to its browser; the
// runner supplies the boundary and the bound on how long the answer may take.
async function browserChecks(plan: AttemptPlan): Promise<PreflightCheck[]>
{
    const browser = plan.capabilities.browser;
    if (browser === undefined || browser.probe.length === 0)
    {
        return [];
    }
    const outcome = await runBounded(plan.boundary, browser.probe, plan.preflightTimeoutMs);
    if (outcome.code === 0)
    {
        return [{ capability: "browser", target: browser.tab, ok: true, detail: "reachable" }];
    }
    const detail = outcome.timedOut
        ? "the browser probe did not answer within the preflight timeout"
        : outcome.spawnError?.code ?? outcome.stderr.trim().split("\n").pop() ?? `probe exited ${outcome.code}`;
    return [{ capability: "browser", target: browser.tab, ok: false, detail }];
}

function boundaryChecks(outcome: { code: number | null; stderr: string; timedOut: boolean; spawnError?: NodeJS.ErrnoException }, report: ProbeReport | null): PreflightCheck[]
{
    if (report !== null)
    {
        return report.checks;
    }
    const detail = outcome.timedOut
        ? `the capability probe did not finish within the preflight timeout`
        : outcome.spawnError?.code ?? outcome.stderr.trim().split("\n").pop() ?? `probe exited ${outcome.code}`;
    return [{ capability: "boundary", target: "capability probe", ok: false, detail }];
}

function parseReport(stdout: string): ProbeReport | null
{
    try
    {
        const report = JSON.parse(stdout.trim()) as ProbeReport;
        return Array.isArray(report.checks) ? report : null;
    }
    catch
    {
        return null;
    }
}

// The one thing a receipt cannot promise on its own: that nothing moved
// between the probe and the launch. Re-derived immediately before the provider
// starts, so a boundary that changed underneath costs a typed capability
// failure instead of a spent attempt.
export function boundaryDrift(plan: AttemptPlan, receipt: PreflightReceipt): string | null
{
    const now = boundaryDigest(plan.boundary);
    if (now !== receipt.boundaryDigest)
    {
        return `the execution boundary changed after the capability probe cleared it (probe ${receipt.boundaryDigest.slice(0, 12)}, launch ${now.slice(0, 12)})`;
    }
    if (policyDigest(plan) !== receipt.policyDigest)
    {
        return "the attempt policy changed after the capability probe cleared it";
    }
    return null;
}

// One request, listing everything that is missing and the exact grant each
// needs. Several separate failures would each cost a round trip, and the
// person granting them would still have to work out what the set was.
export function approvalRequest(receipt: PreflightReceipt): string
{
    const failed = receipt.checks.filter((check) => !check.ok);
    const lines = [
        `attempt ${receipt.attempt} for ${receipt.work} needs ${failed.length} capability grant${failed.length === 1 ? "" : "s"} before it can run.`,
        `boundary: ${receipt.adapter} (${receipt.boundaryDigest.slice(0, 12)}) on node ${receipt.nodeId}`,
        ""
    ];
    for (const check of failed)
    {
        lines.push(`  ${check.capability.padEnd(9)} ${check.target}`);
        lines.push(`  ${" ".repeat(9)} ${remedy(check)}`);
    }
    lines.push("", "No provider was invoked and no attempt was spent. Grant the above, then run the attempt again.");
    return lines.join("\n");
}

function remedy(check: PreflightCheck): string
{
    const remedies: Record<string, string> = {
        context: "register the project and the work unit this attempt names",
        read: `grant read access to this path inside the boundary (${check.detail})`,
        write: `grant write access to this exact directory inside the boundary (${check.detail})`,
        provider: `allow the provider endpoint to resolve inside the boundary (${check.detail})`,
        network: `allow this task domain to resolve inside the boundary (${check.detail})`,
        browser: `open and sign in to the required tab, then make it reachable from the boundary (${check.detail})`,
        self: "put the self CLI on PATH inside the boundary so the agent can attach its own report",
        tool: `install this tool or put it on PATH inside the boundary (${check.detail})`,
        secret: "set this secret in the boundary environment — the runner reads only whether it is set",
        budget: `grant a positive budget for this attempt (${check.detail})`,
        boundary: `make the boundary itself usable (${check.detail})`
    };
    return remedies[check.capability] ?? check.detail;
}
