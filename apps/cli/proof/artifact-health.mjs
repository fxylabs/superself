// Artifact health under a store that will not hand its bytes over, driven
// straight at the module. The CLI proof covers the case a person can create by
// hand; this one covers the cases that must never take a command down and
// cannot be produced portably from a shell: a file replaced by a directory, a
// file that exists and still cannot be opened, and a path the event log points
// at from outside the store.
//
// Every failure here is built so that it fails the same way for every user,
// root included — a proof that only holds for an unprivileged account proves
// nothing on a CI image that runs as root.
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stageArtifacts } from "../dist/artifact.js";
import { artifactSignals } from "../dist/reachability.js";

const store = process.argv[2];
if (store === undefined)
{
    fail("usage: artifact-health.mjs <store-dir>");
}

mkdirSync(store, { recursive: true });
const source = join(store, "capture.txt");
writeFileSync(source, "bytes worth verifying\n");

// a file replaced by a directory: EISDIR for every user, on every unix
const asDirectory = attach("dir");
rmSync(asDirectory.file);
mkdirSync(asDirectory.file);
degradesSafely(asDirectory, "a directory standing where an artifact belongs");

// a file that exists, is no directory, and still cannot be opened. A unix
// socket fails the read the way a lost permission does, without depending on
// which user the proof runs as. Its own path is limited to roughly a hundred
// characters — less than a store under a temporary directory takes — so it
// lives somewhere short and the artifact points at it.
const asSocket = attach("sock");
const socketPath = join(tmpdir(), `self-proof-${process.pid}.sock`);
rmSync(socketPath, { force: true });
const server = await socketAt(socketPath);
rmSync(asSocket.file);
symlinkSync(socketPath, asSocket.file);
check(existsSync(asSocket.file), "the proof could not leave a socket where an artifact belongs");
degradesSafely(asSocket, "an artifact that exists but cannot be opened");

// the permission case itself, where the host allows it to be one. Running as
// root, chmod 000 changes nothing about what root may read, so the assertion
// is the one that holds either way: a signal or a healthy artifact, never a
// crash and never a stack.
const asUnreadable = attach("mode");
chmodSync(asUnreadable.file, 0o000);
const denied = signalsFor(asUnreadable);
check(denied.length <= 1, "an unreadable artifact raised more than its own signal");
if (denied.length === 1)
{
    bounded(denied[0], "an artifact the user may not read");
}
chmodSync(asUnreadable.file, 0o600);
check(signalsFor(asUnreadable).length === 0, "an artifact readable again kept warning");

// the unguarded read this replaced, on the same two files. It escapes as an
// exception every time — the crash that reached the user through fold, status
// and context — and on the socket the exception carries the store's absolute
// path with it. That is what the guarded path above turned into one line.
for (const artifact of [asDirectory, asSocket])
{
    const raw = capture(() => rawDigestRead(artifact.file));
    check(raw !== null, `an unguarded read of ${artifact.meta.name} did not fail, so this proof no longer proves anything`);
}
check(capture(() => rawDigestRead(asSocket.file)).message.includes(store),
    "the unguarded read stopped carrying the store path, so the leak this guards against is no longer demonstrated");

// a path the event log points at from outside the store is refused before it
// is read, so health never answers whether some unrelated file exists
for (const path of ["../../../../etc/hosts", "artifacts/../../escaped.txt", "/etc/hosts"])
{
    const outside = { id: "w-x", meta: { id: "a-out", name: "escaped", path, digest: "0".repeat(64) } };
    const signals = signalsFor(outside);
    check(signals.length === 1, `a path outside the store raised ${signals.length} signals: ${path}`);
    check(signals[0].includes("outside this store's artifacts"), `a path outside the store was not refused: ${path}`);
    bounded(signals[0], `a path outside the store: ${path}`);
}

server.close();
rmSync(socketPath, { force: true });
console.log("artifact health OK");

// stages one artifact through the real ingest path, so its digest is the one
// the CLI would have recorded
function attach(name)
{
    const staged = stageArtifacts(store, `probe-${name}`, [source]);
    const meta = staged.artifacts[0];
    const file = join(store, meta.path);
    check(existsSync(file), "staging did not copy the artifact into the store");
    check(typeof meta.digest === "string" && meta.digest.length === 64, "ingest recorded no digest for the artifact");
    return { id: `w-${name}`, meta, file };
}

function signalsFor(artifact)
{
    return artifactSignals(store, [{ id: artifact.id, status: "active", artifacts: [artifact.meta] }]);
}

function degradesSafely(artifact, description)
{
    const signals = signalsFor(artifact);
    check(signals.length === 1, `${description} raised ${signals.length} signals instead of one`);
    check(signals[0].includes("cannot be read in this store"), `${description} raised the wrong signal: ${signals[0]}`);
    bounded(signals[0], description);
}

// what a health signal may say: the work, the artifact and what to do about
// it. Never the store's absolute path, never an exception's own text.
function bounded(signal, description)
{
    check(!signal.includes(store), `${description} leaked the store path into health`);
    check(!signal.includes("\n") && signal.length < 200, `${description} raised an unbounded signal`);
    check(!/Error:|at .*\(/.test(signal), `${description} leaked an exception into health`);
}

function socketAt(path)
{
    return new Promise((done, failed) =>
    {
        const server = createServer();
        server.on("error", failed);
        server.listen(path, () =>
        {
            server.unref();
            done(server);
        });
    });
}

// what the digest read did before it was guarded, byte for byte
function rawDigestRead(file)
{
    const fd = openSync(file, "r");
    try
    {
        readSync(fd, Buffer.alloc(1024), 0, 1024, null);
    }
    finally
    {
        closeSync(fd);
    }
}

function capture(action)
{
    try
    {
        action();
        return null;
    }
    catch (error)
    {
        return error;
    }
}

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
