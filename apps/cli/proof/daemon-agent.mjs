// A stand-in provider for the supervisor proof. It speaks the same child
// contract as attempt-agent.mjs and reads the same plan environment, and adds
// the one thing these cases need that the runner's own proof never does: a
// payload that leaves a process in its own group, so containment has real work
// to do and the window between a launcher's confirmed exit and the settlement
// behind it is wide enough to crash inside on purpose rather than by luck.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const out = process.env.SUPERSELF_ATTEMPT_OUT;
const mode = process.env.AGENT_MODE ?? "ok";

// Long enough for the case that needs it, short enough that a proof which
// fails halfway leaves nothing running on the machine.
const LINGER_MS = 20_000;

function stage(name, body)
{
    writeFileSync(`${out}/${name}`, body);
    return { name, sha256: createHash("sha256").update(body).digest("hex"), bytes: Buffer.byteLength(body) };
}

function finish(envelope)
{
    writeFileSync(process.env.SUPERSELF_ATTEMPT_RESULT, JSON.stringify(envelope));
    process.exitCode = 0;
}

// Not detached: it stays in the group its launch created, which is what makes
// it a process the containment step has to find and end.
function linger(file)
{
    const child = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${LINGER_MS})`], { stdio: "ignore" });
    child.unref();
    writeFileSync(file, String(child.pid));
}

if (process.env.AGENT_ORPHANFILE !== undefined)
{
    linger(process.env.AGENT_ORPHANFILE);
}

if (mode === "capacity")
{
    process.stderr.write("Error: 429 rate limit reached for this organization\n");
    process.exitCode = 1;
}
else if (mode === "prose")
{
    // A completed envelope claiming an artifact that was never written. The
    // prose reads like success and is evidence of nothing.
    finish({ status: "completed", summary: "I wrote the design document.", artifacts: [{ name: "design.md", sha256: "0".repeat(64), bytes: 12 }] });
}
else if (mode === "evidence")
{
    // An envelope that types its own evidence, the way an implementer that
    // committed its work does: `kind: "commit"` is the declaration `commit:`
    // makes on the report verb, so what the gate does with the ref is the
    // question, never what shape the ref happens to have.
    finish({
        status: "completed",
        summary: "typed commit evidence",
        artifacts: [stage("design.md", "typed evidence body")],
        evidence: [{ kind: "commit", ref: process.env.AGENT_EVIDENCE }]
    });
}
else if (mode === "idle")
{
    // Still running when the case looks at it.
    setTimeout(() => {}, LINGER_MS);
}
else
{
    finish({ status: "completed", summary: "supervised design complete", artifacts: [stage("design.md", "supervised design body")] });
}
