// `store size` walks a directory git is editing while it walks (#396). A CI
// run failed once because a file under `.git` was deleted between the listing
// and the stat on it, and the whole command died of the ENOENT.
//
// The race itself cannot be staged deterministically — that is what a race is
// — so the cells below hold the wrapper the walk now reads through to the two
// halves of its contract: an entry that is gone contributes the fallback, and
// every other errno still reaches the caller.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ignoringGone } from "../dist/store.js";

// A tree with one file in it and one path that was in it a moment ago, which
// is the state a walk of a repacking `.git` observes.
function scratch()
{
    const root = mkdtempSync(join(tmpdir(), "self-store-race-"));
    const objects = join(root, "objects");
    mkdirSync(objects, { recursive: true });
    writeFileSync(join(objects, "kept"), "0123456789");
    const gone = join(objects, "packed-away");
    writeFileSync(gone, "gone by the time it is read");
    rmSync(gone);
    return { root, objects, gone };
}

test("a file deleted between the listing and the stat contributes nothing", () =>
{
    const tree = scratch();
    assert.equal(ignoringGone(() => statSync(tree.gone).size, 0), 0);
    assert.equal(ignoringGone(() => statSync(join(tree.objects, "kept")).size, 0), 10);
    rmSync(tree.root, { recursive: true, force: true });
});

test("a subdirectory that vanished lists as empty rather than throwing", () =>
{
    const tree = scratch();
    const pack = join(tree.objects, "pack");
    mkdirSync(pack);
    writeFileSync(join(pack, "one.pack"), "packed");
    assert.equal(ignoringGone(() => readdirSync(pack, { withFileTypes: true }), []).length, 1);
    rmSync(pack, { recursive: true, force: true });
    assert.deepEqual(ignoringGone(() => readdirSync(pack, { withFileTypes: true }), []), []);
    rmSync(tree.root, { recursive: true, force: true });
});

test("an error that is not ENOENT still reaches the caller", () =>
{
    const tree = scratch();
    const file = join(tree.objects, "kept");
    assert.throws(() => ignoringGone(() => readdirSync(file, { withFileTypes: true }), []), (error) =>
    {
        assert.equal(error.code, "ENOTDIR");
        return true;
    });
    rmSync(tree.root, { recursive: true, force: true });
});

test("a thrown value carrying no errno is not mistaken for a vanished entry", () =>
{
    assert.throws(() => ignoringGone(() =>
    {
        throw new Error("the disk said no");
    }, 0), /the disk said no/);
    // A throw that is not an object at all reaches the caller as itself,
    // rather than as a TypeError from the errno check.
    assert.throws(() => ignoringGone(() =>
    {
        throw null;
    }, 0), (thrown) => thrown === null);
});
