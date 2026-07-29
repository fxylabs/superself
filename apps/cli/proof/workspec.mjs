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
    role: "implementation",
    summary: o.summary ?? "prove the declarative work spec contract",
    provider: { name: o.providerName ?? "spec-provider", endpoint: o.provider ?? "http://localhost:1/" },
    requestedModel: o.model ?? "opus-5",
    command: [process.execPath, o.agent],
    boundary: {
        wrapper: [],
        cwd: o.cwd,
        passthrough: ["PATH", "HOME", "LANG", "TMPDIR", "XDG_CONFIG_HOME", "XDG_STATE_HOME"],
        env: {
            AGENT_MODE: o.mode ?? "ok",
            ...(o.marker === undefined ? {} : { AGENT_MARKER: o.marker }),
            ...(o.idfile === undefined ? {} : { AGENT_IDFILE: o.idfile }),
            ...(o.gate === undefined ? {} : { AGENT_GATE: o.gate })
        }
    },
    capabilities: {
        context: true,
        read: [],
        write: [],
        domains: [],
        tools: [],
        secrets: [],
        self: false
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
