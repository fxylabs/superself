// Writes one WorkSpec for the proof. Same idea as attempt-plan.mjs: each case
// in the proof script names only what it changes about the desired state.
import { writeFileSync } from "node:fs";

const [file, ...pairs] = process.argv.slice(2);
const o = Object.fromEntries(pairs.map((pair) =>
{
    const at = pair.indexOf("=");
    return [pair.slice(0, at), pair.slice(at + 1)];
}));

const spec = {
    workSpecId: o.id ?? "ws-proof",
    generation: Number(o.generation ?? 1),
    workId: o.work,
    role: o.role ?? "implementation",
    summary: o.summary ?? "prove the declarative work spec contract",
    provider: { name: o.providerName ?? "spec-provider", endpoint: o.provider ?? "http://localhost:1/" },
    requestedModel: o.model ?? "opus-5",
    // The invocation the generation materializes. A case that names its own
    // command is stating what this run will actually do — which the policy
    // reads as part of the declaration, exactly as it reads the tools.
    command: o.command === undefined ? [process.execPath, o.agent] : JSON.parse(o.command),
    boundary: {
        wrapper: [],
        cwd: o.cwd,
        passthrough: ["PATH", "HOME", "LANG", "TMPDIR", "XDG_CONFIG_HOME", "XDG_STATE_HOME"],
        env: {
            AGENT_MODE: o.mode ?? "ok",
            ...(o.marker === undefined ? {} : { AGENT_MARKER: o.marker }),
            ...(o.idfile === undefined ? {} : { AGENT_IDFILE: o.idfile }),
            ...(o.gate === undefined ? {} : { AGENT_GATE: o.gate }),
            ...(o.evidence === undefined ? {} : { AGENT_EVIDENCE: o.evidence })
        }
    },
    // What the spec declares it will reach and do. The overnight policy reads
    // exactly this: the risk class is derived from it, and the forbidden-action
    // list is matched against the tools.
    capabilities: {
        context: true,
        read: [],
        write: [],
        domains: o.domains === undefined ? [] : o.domains.split(","),
        tools: o.tools === undefined ? [] : o.tools.split(","),
        secrets: o.secrets === undefined ? [] : o.secrets.split(","),
        self: o.self === "on",
        ...(o.budgetUsd === undefined ? {} : { budgetUsd: Number(o.budgetUsd) })
    },
    artifacts: o.dest === undefined ? [] : [{ name: "design.md", dest: o.dest }],
    validation: { responseSchema: { status: "completed", artifacts: o.dest === undefined ? [] : ["design.md"] } },
    timeoutPolicy: { runMs: Number(o.runMs ?? 120_000), preflightMs: 15_000, heartbeatMs: 50 },
    retryPolicy: { maxRuns: Number(o.maxRuns ?? 1), baseMs: 4, maxMs: 32 }
};

// The cases that prove what a spec must carry: a field taken back out, or one
// given a value the contract does not admit.
for (const field of (o.drop === undefined ? [] : o.drop.split(",")))
{
    delete spec[field];
}
if (o.badStatus !== undefined)
{
    spec.validation.responseSchema.status = o.badStatus;
}

writeFileSync(file, JSON.stringify(spec, null, 2) + "\n");
