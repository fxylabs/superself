// The `pr7-*` suite numbers its cases in ONE sequence shared by every file in
// it — `cell 173` is the 173rd case of the suite, not the 173rd of its file.
//
// Nothing enforced that. #366's design first proposed cells 137–142 by counting
// within `pr7-login.test.mjs`, and four numbers in that range were already held
// by `pr7-credential` and `pr7-concurrency`; a human reading a grep caught it.
// A number naming two cases costs nothing at runtime — the runner is happy —
// and everything afterwards: a review or a regression report that says "cell
// 140 fails" no longer names a case. So the convention is a check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const suiteDir = fileURLToPath(new URL(".", import.meta.url));

// Every `cell N` declared by a test name in this suite, as N → the files that
// declare it. Several cases may share a number *inside* one file — one cell can
// need more than one case, as cell 34 and cell 164 do — but two files may not.
function cellOwners()
{
    const owners = new Map();
    for (const name of readdirSync(suiteDir).filter((file) => /^pr7-.*\.mjs$/.test(file)))
    {
        const source = readFileSync(join(suiteDir, name), "utf8");
        for (const found of source.matchAll(/test\(\s*"cell (\d+)/g))
        {
            owners.set(found[1], (owners.get(found[1]) ?? new Set()).add(name));
        }
    }
    return owners;
}

test("every pr7 cell number is held by exactly one file of the shared sequence", () =>
{
    const owners = cellOwners();
    // A scan that matches nothing would pass the assertion below while checking
    // nothing at all, so the scan itself is asserted first. The bound is a floor
    // well under the count in the tree, not the count: it fails when the reader
    // breaks, never when a cell is added.
    assert.ok(owners.size >= 100, `only ${owners.size} pr7 cell numbers were found — the scan no longer reads the suite`);
    const shared = [...owners].filter(([, files]) => files.size > 1)
        .map(([cell, files]) => `cell ${cell}: ${[...files].sort().join(", ")}`)
        .sort();
    assert.deepEqual(shared, [], "a cell number names cases in more than one file — continue the shared sequence instead of restarting per file");
});
