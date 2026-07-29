// Holds the supervisor's tick mutex for a fixed span, through the very
// primitive a tick takes it with. What this exists to make observable is the
// one thing a second tick must not be able to do: run while another one is
// deciding. A proof cannot start two ticks and prove which of them was inside
// the section, but it can hold the section itself and time what a tick does
// about it.
import { writeFileSync } from "node:fs";
import { withLock } from "../dist/attempt/atomic.js";

const [file, marker, ms] = process.argv.slice(2);

withLock(file, () =>
{
    // Written from inside the section, so the proof waits for the lock to be
    // held rather than for this process to have been started.
    writeFileSync(marker, "held\n");
    // The same synchronous wait the lock's own poll uses: a timer would hand
    // the turn back to the event loop, and the hold has to be the whole of
    // this call.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(ms));
});
