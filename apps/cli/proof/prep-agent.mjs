// The stand-in provider for the preparation proof. It never prepares anything:
// it reports what the runner handed it, which is the whole claim under test.
//
// Everything it writes into the artifact is read out of
// $SUPERSELF_ATTEMPT_WORKDIR — the head the worktree was cut at, and the order
// the template's steps ran in — so an artifact that says the right thing can
// only have come from a worktree that was provisioned and prepared before this
// process started.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const out = process.env.SUPERSELF_ATTEMPT_OUT;
const workdir = process.env.SUPERSELF_ATTEMPT_WORKDIR ?? "none";
const mode = process.env.AGENT_MODE ?? "ok";

if (process.env.AGENT_MARKER)
{
    appendFileSync(process.env.AGENT_MARKER, `ran ${process.env.SUPERSELF_ATTEMPT_RUN}\n`);
}

function read(name)
{
    const file = join(workdir, name);
    return existsSync(file) ? readFileSync(file, "utf8").trim() : "missing";
}

// Work the attempt did not account for, left in the worktree. The settle gate's
// residue check is what has to see this.
if (mode === "residue" && workdir !== "none")
{
    writeFileSync(join(workdir, "left-behind.txt"), "an output nobody committed\n");
}

const body = [
    `workdir=${workdir}`,
    `head=${read("head.txt")}`,
    `order=${read("prep-order.txt").split("\n").join(",")}`
].join("\n") + "\n";

// A run that ends without a result at all, and a run the completion gate has to
// refuse. Both are terminal verdicts of their own, and a worktree the runner
// provisioned has to come back from either of them.
if (mode === "crashout")
{
    process.stderr.write("the provider died before it wrote anything\n");
    process.exitCode = 1;
}
else
{
    writeFileSync(join(out, "design.md"), body);
    writeFileSync(process.env.SUPERSELF_ATTEMPT_RESULT, JSON.stringify({
        status: "completed",
        summary: "worked in the worktree the runner provisioned",
        artifacts: [{
            name: "design.md",
            sha256: mode === "mismatch" ? "1".repeat(64) : createHash("sha256").update(body).digest("hex"),
            bytes: Buffer.byteLength(body)
        }]
    }));
}
