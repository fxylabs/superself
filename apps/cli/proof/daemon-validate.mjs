// The declared validation of a published artifact, held open until the case
// releases it. What it buys is a settlement that is demonstrably still in
// flight after the artifact reached its destination: the crash the launcher
// then stages lands in a known place rather than wherever the timing put it.
import { existsSync } from "node:fs";

const gate = process.env.AGENT_GATE;
const deadline = Date.now() + 30_000;

while (gate !== undefined && !existsSync(gate) && Date.now() < deadline)
{
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}

process.exit(0);
