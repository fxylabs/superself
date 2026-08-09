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
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { git, machine, selfIn, workIdIn } from "./harness.mjs";

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
// other.
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
    run(ws, "workspace", ["init"]);
    git(box, demo, ["init", "-q", "-b", "main"]);
    run(demo, "project", ["project", "init", "--name", "demo", "--desc", "the render gate scenario", "--no-connect"]);
    const work = workIdIn(run(demo, "project", ["work", "add", "stage 1 lands the render gate and its pilot"]).out);
    for (const [cwd, where, args] of steps(box, ws, demo, work))
    {
        run(cwd, where, args);
    }
    return { text: sections.join("\n"), root: box.root };
}

// The rest of the sweep, in the order a session would type it. Every verb here
// is one stage 1 did not migrate except `lang`, which is the pilot: the point
// of the fixture is that the unmigrated ones did not move either.
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
        [demo, "project", ["convention"]],
        [demo, "project", ["log"]],
        [ws, "workspace", ["status"]],
        [box.root, "outside", ["status"]],
        [box.root, "outside", ["lang"]],
        [demo, "project", ["lang", "--plain"]],
        [demo, "project", ["nope"]],
        [demo, "project", ["lang", "--help"]],
        [demo, "project", ["lang", "ko"]],
        [demo, "project", ["lang"]]
    ];
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
