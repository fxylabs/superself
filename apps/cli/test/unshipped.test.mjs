// What "unshipped" is allowed to claim. The section states that work has not
// shipped, so its expensive mistake is a false yes — and squash and rebase
// merges produce exactly that, since both rewrite the hash and delete the
// branch, leaving evidence the fold can no longer locate. A verdict that cannot
// locate the commit says nothing about whether it shipped, so it carries no
// branch here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { unshippedBranches } from "../dist/model.js";

const work = (id, commits, branch = "feat/x") => ({
    id,
    outcome: "o",
    ts: "2025-01-01T00:00:00.000Z",
    lastEventTs: "2025-01-01T00:00:00.000Z",
    status: "next",
    reports: [{ id: "r", ts: "2025-01-01T00:00:00.000Z", text: "t", commits, notes: [], artifacts: [], branch }],
    evidence: commits,
    notes: [],
    artifacts: [],
    branches: [branch],
});

const branchesFor = (commits, verdicts) => unshippedBranches([work("w-1", commits)], verdicts);

test("a squash-merged branch stops carrying unshipped work", () =>
{
    // What a squash merge leaves: the reported hash resolves nowhere and the
    // branch is gone, so the fold judges it unknown. The merged commit is
    // settled on the same unit.
    const branches = branchesFor(["aaa1", "bbb2"], { aaa1: "unknown", bbb2: "settled" });
    assert.deepEqual(branches, [], "unknown evidence still claimed the branch had not shipped");
});

test("evidence whose object is gone stops carrying unshipped work", () =>
{
    const branches = branchesFor(["aaa1"], { aaa1: "unverifiable" });
    assert.deepEqual(branches, [], "unverifiable evidence still claimed the branch had not shipped");
});

test("provisional evidence still carries the branch", () =>
{
    // The case the section exists for: committed, not merged, and the fold can
    // say so positively.
    const branches = branchesFor(["aaa1", "bbb2"], { aaa1: "provisional", bbb2: "settled" });
    assert.equal(branches.length, 1);
    assert.equal(branches[0].branch, "feat/x");
    assert.deepEqual(branches[0].unshipped, [{ work: "w-1", status: "next", evidence: 2, unsettled: 1 }]);
});

test("abandoned evidence still carries the branch", () =>
{
    // A branch positively reset away has not shipped, and unlike unknown that
    // is something the fold observed rather than failed to observe.
    const branches = branchesFor(["aaa1"], { aaa1: "abandoned" });
    assert.equal(branches.length, 1);
    assert.equal(branches[0].unshipped[0].unsettled, 1);
});

test("evidence no fold has judged yet still carries the branch", () =>
{
    // Silence is not a verdict. A hash dropping out before the first judgement
    // would hide work that has genuinely not shipped.
    const branches = branchesFor(["aaa1"], {});
    assert.equal(branches.length, 1);
    assert.equal(branches[0].unshipped[0].unsettled, 1);
});

test("a unit mixing unknown and provisional counts only the provisional", () =>
{
    // The shape a unit reaches when an earlier branch squash-merged and a later
    // one is still open: the closed direction must not inflate the open one.
    const unit = {
        ...work("w-1", ["aaa1"], "feat/merged"),
        reports: [
            { id: "r1", ts: "2025-01-01T00:00:00.000Z", text: "t", commits: ["aaa1"], notes: [], artifacts: [], branch: "feat/merged" },
            { id: "r2", ts: "2025-01-02T00:00:00.000Z", text: "t", commits: ["ccc3", "ddd4"], notes: [], artifacts: [], branch: "feat/open" },
        ],
        evidence: ["aaa1", "ccc3", "ddd4"],
    };
    const branches = unshippedBranches([unit], { aaa1: "unknown", ccc3: "provisional", ddd4: "provisional" });
    assert.equal(branches.length, 1);
    assert.equal(branches[0].branch, "feat/open");
    assert.equal(branches[0].unshipped[0].unsettled, 2);
});
