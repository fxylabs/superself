// What a piped run of the CLI prints, byte for byte, over one scenario
// workspace. The render gate (#w-5emx6) moves where printing happens, and the
// one thing a move may not do is change what a reader sees — so the bytes are
// committed as a fixture generated before the move, and the same fixture has to
// pass after it.
//
// This file is not a test — `node --test test/*.test.mjs` does not pick it up.
// It is the library `golden.test.mjs` asserts against, and a command:
//
//   node test/golden.mjs --write
//
// Rewriting the fixture is only ever correct when a change to what the CLI
// prints was the intended outcome, and the diff is then the evidence for it.
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, idIn, machine, selfIn, workIdIn } from "./harness.mjs";

export const fixturePath = fileURLToPath(new URL("fixtures/golden/piped.txt", import.meta.url));

// A run's own volatile facts, replaced by a name that says what they were. An
// id, a timestamp and a scratch path differ between two correct runs; anything
// left over is content, and a diff in it is a change in what the CLI says.
function normalizers(root)
{
    const roots = [...new Set([root, realpathSync(root)])].sort((a, b) => b.length - a.length);
    return [
        ...roots.map((path) => [new RegExp(escaped(path), "g"), "<root>"]),
        [/\b[0-9abcdefghjkmnpqrstvwxyz]{26}\b/g, "<event-id>"],
        [/\b([weoma])-[0-9abcdefghjkmnpqrstvwxyz]{5}\b/g, "<$1-id>"],
        [/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<ts>"],
        [/\d{4}-\d{2}-\d{2}/g, "<date>"],
        [/\b[0-9a-f]{7,40}\b/g, "<sha>"]
    ];
}

function escaped(text)
{
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalize(text, root)
{
    return normalizers(root).reduce((carried, [pattern, name]) => carried.replace(pattern, name), text);
}

// One command's whole answer: what was typed, where it ran, what it exited
// with, and what it printed. A refusal is as much a fixture as an answer.
function section(where, args, result, root)
{
    const body = result.out.endsWith("\n") || result.out === "" ? result.out : `${result.out}\n`;
    // The command line is normalized with its answer: an id a step was given
    // is as volatile in the echo as it is in the output.
    return normalize(`$ self ${args.join(" ")}   (in ${where}, exit ${result.code})\n${body}`, root);
}

// The scenario: one workspace, one project in it, a few records, and then every
// read surface asked the same question a person would ask. Writes are in the
// sweep too — the confirmation line an event verb prints is output like any
// other — and since stage 2 moves every write verb whose answer is a receipt
// behind the gate, each of those verbs is asked here before it is moved.
export function sweep()
{
    const box = machine();
    const ws = join(box.root, "ws");
    const demo = join(ws, "demo");
    mkdirSync(demo, { recursive: true });
    const sections = [];
    const run = (cwd, where, args) =>
    {
        const result = selfIn(box, cwd, args);
        sections.push(section(where, args, result, box.root));
        return result;
    };
    // Asked before anything exists, because the answer is the wording rather
    // than the path: a machine with no workspace pointer is told where to make
    // one, and that sentence is as much a read's value as a path is.
    run(box.root, "outside", ["workspace"]);
    run(ws, "workspace", ["init"]);
    run(ws, "workspace", ["init"]);
    git(box, demo, ["init", "-q", "-b", "main"]);
    run(demo, "project", ["project", "init", "--name", "demo", "--desc", "the render gate scenario", "--no-connect"]);
    const work = workIdIn(run(demo, "project", ["work", "add", "stage 1 lands the render gate and its pilot"]).out);
    for (const [cwd, where, args] of steps(box, ws, demo, work))
    {
        run(cwd, where, args);
    }
    const goals = receiptSweep(box, run, ws, demo, work);
    listingSweep(run, ws, demo);
    documentSweep(box, run, ws, demo, work, goals);
    return { text: sections.join("\n"), root: box.root };
}

// The read half, in the order a session would type it. Every verb here is one
// stage 1 did not migrate except `lang`, which is the pilot: the point of the
// fixture is that the unmigrated ones did not move either.
function steps(box, ws, demo, work)
{
    return [
        [demo, "project", ["decide", "the render gate is the one path to stdout", "--why", "one print path"]],
        [demo, "project", ["state", "add", "a note the search surface can find", "--exposure", "search"]],
        [demo, "project", ["work", "start", work]],
        [demo, "project", ["report", work, "the fixture was generated"]],
        [demo, "project", ["lang"]],
        [demo, "project", ["context"]],
        [demo, "project", ["status"]],
        [demo, "project", ["work"]],
        [demo, "project", ["work", "show", work]],
        [demo, "project", ["state"]],
        [demo, "project", ["search", "render gate"]],
        [demo, "project", ["project"]],
        [demo, "project", ["artifact"]],
        [demo, "project", ["objective"]],
        [demo, "project", ["milestone"]],
        [demo, "project", ["convention"]],
        [demo, "project", ["log"]],
        [ws, "workspace", ["status"]],
        [box.root, "outside", ["status"]],
        [box.root, "outside", ["lang"]],
        [demo, "project", ["lang", "--plain"]],
        [demo, "project", ["nope"]],
        [demo, "project", ["lang", "--help"]],
        // The two answers the binary gives before any command resolves: the
        // verb list a bare call asks for, and one command's own page. Neither
        // carries an id, a path or a version, so both are the same bytes on
        // every machine and belong in the sweep rather than in a test.
        [demo, "project", []],
        [demo, "project", ["work", "--help"]],
        [demo, "project", ["lang", "ko"]],
        [demo, "project", ["lang"]]
    ];
}

// Every write verb whose answer is a receipt, asked once. The reads above ran
// first so their answers describe the same small state they always did; what
// follows is the half stage 2 moves, and each phase is grouped by the module
// that owns the verbs in it.
function receiptSweep(box, run, ws, demo, work)
{
    machineConfig(run, ws, demo);
    projectReceipts(box, run, ws, demo);
    const goals = goalReceipts(run, demo, work);
    aliasReceipts(run, demo);
    fileReceipts(run, demo, work);
    outsideRefusals(box, run);
    syncReceipts(box, run, ws, demo);
    return goals;
}

// The same write verbs, asked from a directory that resolves to no project.
// A refusal is composed before a handler has anything to answer with, so it
// never reaches the gate — which is exactly why it is in the fixture.
function outsideRefusals(box, run)
{
    run(box.root, "outside", ["work", "add", "a unit recorded from nowhere"]);
    run(box.root, "outside", ["objective", "add", "an outcome recorded from nowhere"]);
    run(box.root, "outside", ["connect"]);
    run(box.root, "outside", ["fold"]);
}

// The workspace pointer and the four store settings, each read, written, and
// read back: the read is the value beside the receipt, so a byte that moved
// from one into the other would show here.
function machineConfig(run, ws, demo)
{
    run(ws, "workspace", ["workspace"]);
    run(ws, "workspace", ["workspace", ws]);
    run(demo, "project", ["timezone"]);
    run(demo, "project", ["timezone", "Asia/Seoul"]);
    run(demo, "project", ["timezone"]);
    run(demo, "project", ["theme"]);
    run(demo, "project", ["theme", "cyan"]);
    run(demo, "project", ["tokens"]);
    run(demo, "project", ["tokens", "100", "400"]);
    run(demo, "project", ["tokens"]);
}

// `project link --here` over a path whose recorded repository is gone is the
// disclosure-then-write case: the replacement line is printed before the write
// and the recorded line after it, and the two may not swap. A second project
// is registered for it because the disclosure needs a link that named a
// repository identity, and the identity has to have changed since.
function projectReceipts(box, run, ws, demo)
{
    const second = join(ws, "second");
    reinitRepository(box, second, "the repository that was linked");
    run(second, "second", ["project", "init", "--name", "second", "--desc", "the relinked checkout", "--no-connect"]);
    reinitRepository(box, second, "the repository standing there now");
    run(second, "second", ["project", "link", "second", "--here"]);
    // The read form (#332): where the project is linked, and that this is it.
    run(demo, "project", ["project", "link"]);
    run(demo, "project", ["connect"]);
    run(demo, "project", ["connect", "--global"]);
    run(demo, "project", ["fold"]);
}

// A repository whose root commit — the identity a link records — is not the one
// it had a moment ago. Re-creating it is what the stale-link warning is about:
// the path is the same and the repository standing at it is not. The message
// differs between the two, because two empty commits made in the same second
// by the same author under the same message are the same commit.
function reinitRepository(box, dir, message)
{
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    git(box, dir, ["init", "-q", "-b", "main"]);
    git(box, dir, ["commit", "-q", "--allow-empty", "-m", message]);
}

// The goal graph's own receipts, and the one event `undo` can take back
// without a person at a terminal: a link displaces nothing, so recording it
// and reversing it both run piped.
function goalReceipts(run, demo, work)
{
    const objective = idOf(run(demo, "project", ["objective", "add", "the CLI answers through one gate"]).out, "o");
    const milestone = idOf(run(demo, "project", ["milestone", "add", "the write verbs answer with receipts",
        "--objective", objective, "--exit", "no write verb prints for itself"]).out, "m");
    const proposal = idOf(run(demo, "project", ["work", "propose", "the listings move behind the gate",
        "--milestone", milestone, "--value", "one answer to what a piped run prints",
        "--success", "every listing returns rows", "--stop", "the gate grows a second print path",
        "--risk", "a line moves against the announce lines", "--capacity", "one stage",
        "--evidence-plan", "the golden fixture", "--confidence", "medium", "--expires", "2030-01-01"]).out, "w");
    run(demo, "project", ["work", "accept", proposal]);
    const linked = idIn(run(demo, "project", ["work", "link", work, "--milestone", milestone]).out);
    run(demo, "project", ["undo", linked, "--why", "the checkpoint was the wrong one"]);
    return { objective, milestone };
}

function aliasReceipts(run, demo)
{
    run(demo, "project", ["alias", "add", "note", "--label", "note", "--exposure", "search"]);
    run(demo, "project", ["alias", "set", "note", "--priority", "2"]);
    run(demo, "project", ["alias"]);
    run(demo, "project", ["alias", "drop", "note"]);
}

// The two verbs that would put a window on somebody's desktop, and the write
// that gives one of them something to open. Nobody is at a terminal in a piped
// run, so both answer with the path they did not launch.
function fileReceipts(run, demo, work)
{
    writeFileSync(join(demo, "evidence.md"), "the sweep carries an artifact\n");
    run(demo, "project", ["report", work, "the fixture carries an artifact", "--artifact", "evidence.md"]);
    const artifact = idOf(run(demo, "project", ["artifact", "list"]).out, "a");
    run(demo, "project", ["artifact", "open", artifact]);
    run(demo, "project", ["view"]);
    run(demo, "project", ["view", "demo"]);
    run(demo, "project", ["work", "done", work, "--report", "the sweep covers every receipt this stage moves"]);
}

// The sync receipts, against a bare repository on the same disk. `clone` points
// this machine at what it cloned, so the pointer is put back afterwards —
// which is the `workspace <path>` receipt asked one more time, from the
// directory a person would be standing in.
function syncReceipts(box, run, ws, demo)
{
    git(box, box.root, ["init", "-q", "--bare", "remote.git"]);
    const remote = join(box.root, "remote.git");
    run(demo, "project", ["remote", "add", remote]);
    run(demo, "project", ["sync"]);
    run(box.root, "outside", ["clone", remote, join(box.root, "clone")]);
    run(ws, "workspace", ["workspace", ws]);
}

// Every standalone listing, asked once the scenario has something in it. The
// reads in `steps` above ran against a project with no objectives, no
// checkpoints and no archived siblings, which is the empty answer; a listing
// only states a size where there is one to state, so each surface is asked
// again here with rows in it. `self log` is asked with an `-n` below its event
// count, because a window onto a longer log is the only listing that says how
// much it is not showing. Its `--workspace` form is not here and belongs in a
// test instead: a merged log orders two events of one millisecond by their
// random id, so its row order is not a fixture anything could pin.

function listingSweep(run, ws, demo)
{
    run(demo, "project", ["objective"]);
    run(demo, "project", ["milestone"]);
    run(demo, "project", ["work"]);
    run(demo, "project", ["artifact", "list"]);
    run(demo, "project", ["artifact", "search", "evidence"]);
    run(demo, "project", ["search", "gate"]);
    run(demo, "project", ["alias"]);
    run(demo, "project", ["log", "-n", "5"]);
    run(ws, "workspace", ["project"]);
    archiveSweep(run, ws, demo);
}

// The archived listing on both sides of the round trip, and the two verbs that
// move a project across it. `second` is the project registered for the link
// receipt, so archiving it leaves the scenario's own project untouched.
function archiveSweep(run, ws, demo)
{
    run(ws, "workspace", ["project", "--archived"]);
    run(demo, "project", ["project", "archive", "second", "--why", "nobody is working on the second checkout"]);
    run(ws, "workspace", ["project", "--archived"]);
    run(ws, "workspace", ["project", "restore", "second"]);
    run(ws, "workspace", ["project", "--archived"]);
}

// The pages a `show` verb composes, and the diagnostics `self setup` prints.
// These are the surfaces stage 4 moves behind the gate, and a document has no
// size line to gain — so the whole of what they say is evidence that the move
// changed nothing. Asked last, after every write the scenario makes, so the
// state each page describes has stopped moving.
//
// `setup` is asked from all three places a directory can resolve from, because
// what it answers is exactly which of them the caller is standing in.
function documentSweep(box, run, ws, demo, work, goals)
{
    const note = idOf(run(demo, "project", ["state", "add", "a record the document sweep reads back",
        "--exposure", "index"]).out, "e");
    run(demo, "project", ["state", "show", note]);
    run(demo, "project", ["state", "show", note, "--history"]);
    run(demo, "project", ["work", "show", work, "--history"]);
    run(demo, "project", ["objective", "show", goals.objective]);
    run(demo, "project", ["milestone", "show", goals.milestone]);
    run(demo, "project", ["setup"]);
    run(ws, "workspace", ["setup"]);
    run(box.root, "outside", ["setup"]);
}

// A minted id of one kind, read off the answer that printed it. The prefixes
// are the ones `ids.ts` mints, and the normalizer replaces the same shapes.
function idOf(text, prefix)
{
    const match = text.match(new RegExp(`\\b${prefix}-[0-9abcdefghjkmnpqrstvwxyz]{5}\\b`));
    if (match === null)
    {
        throw new Error(`no ${prefix}- id in: ${text}`);
    }
    return match[0];
}

export function committedFixture()
{
    return readFileSync(fixturePath, "utf8");
}

if (process.argv[1] === fileURLToPath(import.meta.url))
{
    const { text } = sweep();
    if (!process.argv.includes("--write"))
    {
        process.stdout.write(text);
        process.exit(0);
    }
    mkdirSync(dirname(fixturePath), { recursive: true });
    writeFileSync(fixturePath, text);
    process.stdout.write(`golden: wrote ${text.split("\n").length} lines to ${fixturePath}\n`);
}
