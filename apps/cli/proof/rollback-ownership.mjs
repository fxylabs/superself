// Rollback ownership, driven straight at the staging module. Only a second
// report writing into the same directory at the same moment can produce this
// state, and no sequence of CLI calls in one process reaches it — so the proof
// stages the bytes here, drops a concurrent report's file beside them, and
// rolls back. What must hold: a rollback removes the files it copied and
// nothing else, never a directory another report has filled, and never the
// artifacts root that every project in the workspace shares.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stageArtifacts } from "../dist/artifact.js";

const store = process.argv[2];
if (store === undefined)
{
    fail("usage: rollback-ownership.mjs <store-dir>");
}

const source = join(store, "source.txt");
mkdirSync(store, { recursive: true });
writeFileSync(source, "bytes\n");

const staged = stageArtifacts(store, "demo", [source]);
const copied = join(store, staged.artifacts[0].path);
check(existsSync(copied), "staging did not copy the artifact into the store");

const concurrent = join(store, "artifacts", "demo", "a-other-report.bin");
writeFileSync(concurrent, "another report's bytes\n");
staged.discard();

check(!existsSync(copied), "rollback kept the file it had copied");
check(existsSync(concurrent), "rollback deleted a concurrent report's bytes");
check(existsSync(join(store, "artifacts", "demo")), "rollback removed a directory another report was still using");
check(existsSync(join(store, "artifacts")), "rollback removed the artifacts root every project shares");

// and with nothing else in it, the directory this staging made does go
const solo = stageArtifacts(store, "solo", [source]);
solo.discard();
check(!existsSync(join(store, "artifacts", "solo")), "rollback left behind the empty directory it created");
check(existsSync(join(store, "artifacts")), "rollback took the shared artifacts root down with an empty directory");

function check(ok, message)
{
    if (!ok)
    {
        fail(message);
    }
}

function fail(message)
{
    console.error(`proof FAILED: ${message}`);
    process.exit(1);
}
