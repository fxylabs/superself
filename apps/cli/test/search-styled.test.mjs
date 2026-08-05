// Cell T4.4 of the #212 case table, styled half: the matched substring is
// highlighted when the output is styled.
//
// `style.ts` answers "is this styled" once, when it is first imported, from
// stdout — so a test that wants the styled answer has to say so before the
// built modules load, and run the command in this process rather than in a
// child whose stdout is a pipe. The plain half of the same cell is asserted in
// search-live.test.mjs, where every run is a piped child.
process.stdout.isTTY = true;
process.env.TERM = "xterm";
delete process.env.NO_COLOR;

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const { approvedIn, git, machine, must } = await import("./harness.mjs");
const { styled } = await import("../dist/style.js");

const box = machine();
const ws = join(box.root, "ws");
const project = join(ws, "styled");
mkdirSync(project, { recursive: true });
must(box, ws, ["init"]);
git(box, project, ["init", "-q", "-b", "main"]);
must(box, project, ["project", "add", "--name", "styled", "--no-connect"]);
must(box, project, ["state", "add", "T4-4 the highlighted phrase", "--exposure", "search"]);

test("T4.4: the matched substring is highlighted when the answer is styled", async () =>
{
    assert.equal(styled, true, "this file has to load with a styled stdout for the cell to mean anything");
    const answer = await approvedIn(box, project, ["search", "highlighted phrase"], "");
    assert.equal(answer.code, 0, answer.out);
    assert.ok(answer.printed.includes("\x1b[1mhighlighted phrase\x1b[0m"),
        `the matched substring was not highlighted:\n${JSON.stringify(answer.printed)}`);
});
