// Writes one attempt plan for the proof. Keeping plan construction here keeps
// the proof script readable: each case names only what it changes.
import { writeFileSync } from "node:fs";

const [file, ...pairs] = process.argv.slice(2);
const o = Object.fromEntries(pairs.map((pair) =>
{
    const at = pair.indexOf("=");
    return [pair.slice(0, at), pair.slice(at + 1)];
}));

const plan = {
    work: o.work,
    role: "implementation",
    summary: o.summary ?? "prove the runner attempt contract",
    boundary: {
        wrapper: o.wrapper === undefined ? [] : JSON.parse(o.wrapper),
        cwd: o.cwd,
        passthrough: ["PATH", "HOME", "LANG", "TMPDIR", "XDG_CONFIG_HOME", "XDG_STATE_HOME"],
        env: {
            AGENT_MODE: o.mode ?? "ok",
            ...(o.marker === undefined ? {} : { AGENT_MARKER: o.marker }),
            ...(o.idfile === undefined ? {} : { AGENT_IDFILE: o.idfile })
        }
    },
    command: [process.execPath, o.agent],
    capabilities: {
        context: o.context !== "off",
        read: o.read === undefined ? [] : o.read.split(","),
        write: o.write === undefined ? [] : o.write.split(","),
        domains: o.domains === undefined ? [] : o.domains.split(","),
        tools: o.tools === undefined ? [] : o.tools.split(","),
        secrets: o.secrets === undefined ? [] : o.secrets.split(","),
        self: o.self === "on"
    },
    artifacts: o.dest === undefined
        ? []
        : [{ name: "design.md", dest: o.dest, ...(o.validate === undefined ? {} : { validate: [process.execPath, o.validate] }) }],
    retry: { maxRuns: Number(o.maxRuns ?? 3), baseMs: Number(o.baseMs ?? 4), maxMs: Number(o.maxMs ?? 32) },
    heartbeatMs: 50,
    preflightTimeoutMs: 15_000,
    runTimeoutMs: 120_000,
    resume: o.resume === "on"
};

if (o.provider !== undefined)
{
    plan.capabilities.provider = { name: o.providerName ?? "proof-provider", endpoint: o.provider };
}
if (o.browser !== undefined)
{
    plan.capabilities.browser = { tab: "https://mail.example.invalid/inbox", probe: [process.execPath, o.browser] };
}

writeFileSync(file, JSON.stringify(plan, null, 2) + "\n");
