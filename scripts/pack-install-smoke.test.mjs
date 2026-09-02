// The one decision in the pack/install smoke that is a fact rather than a pack
// and an install: whether the path the installed CLI resolved `@superself/fold`
// to is inside the install prefix and outside this repository.
//
// It is asserted here rather than by row S5 itself because the way it breaks
// only shows when the temporary directory is reached through a symlink, and
// `pnpm smoke` gets whatever `os.tmpdir()` happens to be on the machine running
// it. On macOS that is always a symlink (`/var` -> `/private/var`), which is
// why S5 passed on every Linux runner while failing on the platform
// `pnpm-workspace.yaml` names as a supported one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvedInsideInstall } from "./pack-install-smoke.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("S14: an install prefix reached through a symlink still reads as the install prefix", () =>
{
    const box = mkdtempSync(join(tmpdir(), "smoke-symlink-"));
    const real = join(box, "realtmp");
    const through = join(box, "symtmp");
    mkdirSync(join(real, "install", "node_modules", "@superself", "fold", "dist"), { recursive: true });
    symlinkSync(real, through);
    // The two sides as the smoke gets them: `require.resolve` answers a real
    // path, while the prefix is the string `os.tmpdir()` handed over. This is
    // macOS's `/var` -> `/private/var` with the symlink written by hand.
    const resolved = join(real, "install", "node_modules", "@superself", "fold", "dist", "index.js");
    assert.equal(resolvedInsideInstall(resolved, join(through, "install"), repoRoot), true);
});

test("S14: a fold resolved out of this repository is still refused, however the repository is spelled", () =>
{
    // The half of S5 that is the actual claim — the installed CLI must not be
    // reading the workspace source. Resolving the real paths does not weaken
    // it: here the prefix contains the repository and the row still fails.
    const inRepository = join(repoRoot, "apps", "fold", "dist", "index.js");
    assert.equal(resolvedInsideInstall(inRepository, repoRoot, repoRoot), false);
    // And the case where realpathing is what decides it: a checkout reached
    // through a symlink. The resolved path is under the checkout's real name
    // and shares no prefix with the symlinked one, so comparing the strings as
    // written would read this as a fold from outside the repository and pass
    // the row. It is the workspace source, and it is refused.
    const box = mkdtempSync(join(tmpdir(), "smoke-symlink-"));
    mkdirSync(join(box, "realrepo", "apps", "fold", "dist"), { recursive: true });
    symlinkSync(join(box, "realrepo"), join(box, "linkrepo"));
    const throughLink = join(box, "realrepo", "apps", "fold", "dist", "index.js");
    assert.equal(resolvedInsideInstall(throughLink, box, join(box, "linkrepo")), false);
});
