// Leaves one work spec's current generation sealed twice.
//
// It is the one shape a generation directory may never hold, and nothing in
// the product can produce it — `seal` refuses a second write of a generation,
// and the apply lock makes two sealers of one generation impossible. It is
// written here directly because it is the only way to make "this generation
// was read" observable from outside: a read of it refuses outright, so a tick
// that opens a head it had no business opening says so instead of costing a
// hash nobody can see.
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { readHead, sealedGeneration, specDir } from "../dist/spec/store.js";

const [storeDir, project, workSpecId] = process.argv.slice(2);
const dir = specDir(storeDir, project, workSpecId);
const head = readHead(dir);
if (head === null)
{
    throw new Error(`${workSpecId} has no HEAD to double-seal`);
}
const sealed = sealedGeneration(dir, head.generation);
if (sealed === null)
{
    throw new Error(`${workSpecId} generation ${head.generation} is not sealed`);
}
// A second blob for the same generation, under a name that parses as one: the
// digest is a different sixty-four hex characters, which is what "sealed twice
// with different content" means to the store that reads it.
copyFileSync(sealed.file, join(dir, `${String(head.generation).padStart(6, "0")}-${"a".repeat(64)}.json`));
