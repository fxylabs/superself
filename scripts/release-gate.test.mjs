// The release gate's rules, one test per row of
// docs/maintainers/case-tables/430-release-plumbing.md.
//
// Every rule is a fact about a tag, two manifests and what the registry already
// holds, so the rows below state those facts and read the sentences back. The
// two rules that cannot be pure — what the registry answers, and whether the
// commit is on `main` — are exercised against a real temporary git repository
// and against a fake `npm` on PATH, so nothing here needs a network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { commitIsOn, publishedVersions, readManifest, releaseRefusals } from "./release-gate.mjs";

const gateScript = fileURLToPath(new URL("./release-gate.mjs", import.meta.url));

const CLI = { version: "0.13.0", dependencies: { "@superself/fold": "0.2.0" } };
const FOLD = { version: "0.2.0" };

function refusals(overrides = {})
{
    return releaseRefusals({
        tag: "v0.13.0",
        cli: CLI,
        fold: FOLD,
        publishedCli: [],
        publishedFold: [],
        tagOnMain: true,
        ...overrides
    });
}

function one(overrides)
{
    const said = refusals(overrides);
    assert.equal(said.length, 1, `expected one refusal, got ${said.length}:\n${said.join("\n")}`);
    return said[0];
}

test("R1: a tag naming the CLI's version, pinned to the fold being published, refuses nothing", () =>
{
    assert.deepEqual(refusals(), []);
});

test("R2: a tag that names a version the CLI is not at is refused, naming both", () =>
{
    const said = one({ tag: "v0.14.0" });
    assert.match(said, /`v0\.14\.0` names version 0\.14\.0/);
    assert.match(said, /apps\/cli\/package\.json is at 0\.13\.0/);
});

test("R3: the leading v is the tag's and not the version's", () =>
{
    assert.deepEqual(refusals({ tag: "0.13.0" }), []);
});

test("R4: a tag on a commit that is not on main is refused", () =>
{
    assert.match(one({ tagOnMain: false }), /is on a commit that is not on `main`/);
});

test("R5: a tag whose ancestry could not be read is refused rather than passed", () =>
{
    assert.match(one({ tagOnMain: undefined }), /not on `main`/);
});

test("R6: a pin that is a range rather than the version is refused", () =>
{
    const said = one({ cli: { ...CLI, dependencies: { "@superself/fold": "^0.2.0" } } });
    assert.match(said, /pins @superself\/fold at `\^0\.2\.0`/);
    assert.match(said, /the version this run publishes is 0\.2\.0/);
});

test("R7: a pin naming a fold version other than the one being published is refused", () =>
{
    assert.match(one({ fold: { version: "0.3.0" } }), /pins @superself\/fold at `0\.2\.0`.*publishes is 0\.3\.0/s);
});

test("R8: a CLI that depends on no fold at all is refused", () =>
{
    assert.match(one({ cli: { version: "0.13.0", dependencies: {} } }), /does not depend on @superself\/fold/);
});

test("R9: the workspace protocol is still refused, and says so once rather than as a bad pin too", () =>
{
    const said = one({ cli: { ...CLI, dependencies: { "@superself/fold": "workspace:*" } } });
    assert.match(said, /depends on @superself\/fold as `workspace:\*`/);
    assert.match(said, /installable by nobody/);
});

test("R9: a workspace spec in optionalDependencies or peerDependencies is refused the same way", () =>
{
    assert.match(one({ fold: { ...FOLD, peerDependencies: { "@superself/fold": "workspace:^" } } }),
        /apps\/fold\/package\.json depends on @superself\/fold as `workspace:\^`/);
    assert.match(one({ cli: { ...CLI, optionalDependencies: { chalk: "workspace:*" } } }),
        /apps\/cli\/package\.json depends on chalk as `workspace:\*`/);
});

test("R10: a workspace spec in devDependencies is nobody's problem — it is not published", () =>
{
    assert.deepEqual(refusals({ cli: { ...CLI, devDependencies: { typescript: "workspace:*" } } }), []);
});

test("R11: a fold version the registry already holds is refused before anything publishes", () =>
{
    assert.match(one({ publishedFold: ["0.1.0", "0.2.0"] }), /@superself\/fold@0\.2\.0 is already on the registry/);
});

test("R12: a CLI version the registry already holds is refused before anything publishes", () =>
{
    assert.match(one({ publishedCli: ["0.12.0", "0.13.0"] }), /superself@0\.13\.0 is already on the registry/);
});

test("R13: the fold's first release, with nothing of it on the registry, refuses nothing", () =>
{
    assert.deepEqual(refusals({ publishedFold: [] }), []);
});

test("R14: every rule broken at once says every sentence — none swallows another", () =>
{
    const said = refusals({
        tag: "v9.9.9-rc.1",
        tagOnMain: false,
        cli: { ...CLI, dependencies: { "@superself/fold": "workspace:*" } },
        fold: { version: "0.2.0-rc.1" },
        publishedCli: ["0.13.0"],
        publishedFold: ["0.2.0-rc.1"]
    });
    assert.equal(said.length, 7, said.join("\n"));
    // The channel rule reads two versions, and a prerelease in both of them is
    // two sentences naming two different subjects — not one standing for both.
    const channel = said.filter((one) => /prerelease channels are not decided/.test(one));
    assert.equal(channel.length, 2, said.join("\n"));
    assert.match(channel[0], /^the tag `v9\.9\.9-rc\.1`/);
    assert.match(channel[1], /^apps\/fold\/package\.json/);
});

test("R15: the repository as it stands would publish — the pin is the fold's version, neither manifest carries a workspace spec, and both versions are finals", () =>
{
    const cli = readManifest("apps/cli");
    const fold = readManifest("apps/fold");
    assert.deepEqual(releaseRefusals({
        tag: `v${cli.version}`,
        cli,
        fold,
        publishedCli: [],
        publishedFold: [],
        tagOnMain: true
    }), []);
    // The tag is synthesised from the CLI's version, so the fold's channel is
    // the one thing this row would not have read had the rule looked only at
    // the tag. Broken here against the real manifest rather than assumed.
    assert.equal(releaseRefusals({
        tag: `v${cli.version}`,
        cli,
        fold: { ...fold, version: `${fold.version}-rc.1` },
        publishedCli: [],
        publishedFold: [],
        tagOnMain: true
    }).filter((one) => /prerelease channels are not decided/.test(one)).length, 1);
});

// The bootstrap `docs/maintainers/releases.md` writes down: npm cannot name a
// trusted publisher for a package that does not exist, so the operator publishes
// a low placeholder by hand, configures the publisher against it, and only then
// tags. What that leaves behind is a fold version on the registry that is not
// the one the tag publishes — and every rule that looks at the registry has to
// still pass, or the ceremony would trade one dead first release for another.
test("R21: the placeholder left by the bootstrap refuses nothing when the first real tag runs", () =>
{
    assert.deepEqual(refusals({ publishedFold: ["0.0.1"], publishedCli: ["0.12.0"] }), []);
});

test("R22: a prerelease tag is refused, naming the channel policy that does not exist", () =>
{
    const said = one({ tag: "v0.13.0-rc.1", cli: { ...CLI, version: "0.13.0-rc.1" } });
    assert.match(said, /`v0\.13\.0-rc\.1` names 0\.13\.0-rc\.1, which is a prerelease/);
    assert.match(said, /prerelease channels are not decided/);
    assert.match(said, /`latest`/);
});

test("R23: a tag carrying build metadata is refused the same way", () =>
{
    const said = one({ tag: "v0.13.0+build.5", cli: { ...CLI, version: "0.13.0+build.5" } });
    assert.match(said, /which is a build-metadata version/);
});

test("R24: the same release as a final tag publishes — the refusal is the channel, not the version", () =>
{
    assert.deepEqual(refusals({ tag: "v0.13.0" }), []);
});

// The half-run this workflow's order exists to make survivable, seen from the
// gate on the next attempt. "Raise the version and tag again" is the wrong
// answer to it: the CLI's version is not on the registry and needs no raise.
test("R25: a fold on the registry whose CLI is not names re-running the failed job, not a version bump", () =>
{
    const said = one({ publishedFold: ["0.2.0"] });
    assert.match(said, /@superself\/fold@0\.2\.0 is already on the registry and superself@0\.13\.0 is not/);
    assert.match(said, /Re-run failed jobs/);
    assert.doesNotMatch(said, /raise the version and tag again/);
});

test("R26: both versions on the registry keeps the plain already-published sentence, once per package", () =>
{
    const said = refusals({ publishedCli: ["0.13.0"], publishedFold: ["0.2.0"] });
    assert.equal(said.length, 2, said.join("\n"));
    assert.match(said[0], /superself@0\.13\.0 is already on the registry — a published version is never replaced/);
    assert.match(said[1], /@superself\/fold@0\.2\.0 is already on the registry — a published version is never replaced/);
    assert.ok(said.every((one) => !/Re-run failed jobs/.test(one)), said.join("\n"));
});

// The tag names the CLI's version and never the fold's, so a final tag can
// carry a prerelease fold — and both packages publish from the one run, each
// taking npm's default dist-tag. The rule R22 states about the tag is the same
// rule about the version the tag does not spell.
test("R27: a final tag whose fold manifest is a prerelease is refused, naming the manifest it read", () =>
{
    const said = one({ fold: { version: "0.2.0-rc.1" }, cli: { ...CLI, dependencies: { "@superself/fold": "0.2.0-rc.1" } } });
    assert.match(said, /^apps\/fold\/package\.json names 0\.2\.0-rc\.1, which is a prerelease/);
    assert.match(said, /prerelease channels are not decided/);
    assert.match(said, /`latest`/);
});

test("R28: a fold manifest carrying build metadata is refused the same way", () =>
{
    const said = one({ fold: { version: "0.2.0+build.5" }, cli: { ...CLI, dependencies: { "@superself/fold": "0.2.0+build.5" } } });
    assert.match(said, /^apps\/fold\/package\.json names 0\.2\.0\+build\.5, which is a build-metadata version/);
});

/* ── the two rules that read the world ─────────────────────────────── */

function temporaryRepository()
{
    const at = mkdtempSync(join(tmpdir(), "release-gate-"));
    const git = (...args) => execFileSync("git", args, { cwd: at, stdio: "ignore",
        env: { ...process.env, GIT_AUTHOR_NAME: "gate", GIT_AUTHOR_EMAIL: "gate@test",
            GIT_COMMITTER_NAME: "gate", GIT_COMMITTER_EMAIL: "gate@test" } });
    git("init", "-q", "-b", "main");
    writeFileSync(join(at, "a"), "one\n");
    git("add", "a");
    git("commit", "-qm", "one");
    return { at, git };
}

test("R20: a run naming no tag at all is one sentence, not a stack", () =>
{
    assert.match(one({ tag: "" }), /names no tag to publish/);
    assert.match(one({ tag: undefined }), /names no tag to publish/);
});

test("R16: a commit on the release branch passes the ancestry rule, and one on a side branch does not", () =>
{
    const { at, git } = temporaryRepository();
    assert.equal(commitIsOn("main", at), true);
    git("checkout", "-qb", "side");
    writeFileSync(join(at, "b"), "two\n");
    git("add", "b");
    git("commit", "-qm", "two");
    assert.equal(commitIsOn("main", at), false);
});

test("R17: a branch this checkout cannot resolve is refused, never read as a pass", () =>
{
    const { at } = temporaryRepository();
    assert.equal(commitIsOn("origin/main", at), false);
});

// A fake `npm` on PATH, so what the registry says is a fact this file states
// rather than one the network decides.
function withNpmSaying(script, run)
{
    const box = mkdtempSync(join(tmpdir(), "release-gate-npm-"));
    mkdirSync(join(box, "bin"));
    writeFileSync(join(box, "bin", "npm"), `#!/bin/sh\n${script}\n`);
    chmodSync(join(box, "bin", "npm"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${join(box, "bin")}:${path}`;
    try
    {
        return run();
    }
    finally
    {
        process.env.PATH = path;
    }
}

test("R18: a package nobody has published yet reads as no versions, not as a failure", () =>
{
    const said = withNpmSaying(`echo '{"error":{"code":"E404"}}'; exit 1`, () => publishedVersions("@superself/fold"));
    assert.deepEqual(said, []);
});

test("R18: one published version and many both read as a list", () =>
{
    assert.deepEqual(withNpmSaying(`echo '"0.1.0"'`, () => publishedVersions("@superself/fold")), ["0.1.0"]);
    assert.deepEqual(withNpmSaying(`echo '["0.1.0","0.2.0"]'`, () => publishedVersions("@superself/fold")), ["0.1.0", "0.2.0"]);
});

test("R19: a registry that cannot be reached stops the gate — it never reads as an unpublished package", () =>
{
    assert.throws(() => withNpmSaying(`echo 'network unreachable' >&2; exit 1`, () => publishedVersions("superself")),
        /the registry could not be asked what versions of superself it holds/);
});

// Failing closed is the rule; how it reads is the row. Every other refusal
// here is a sentence, and an outage that printed a stack trace instead would
// read to an operator as a bug in the gate rather than as a registry to retry.
test("R19: the gate ends a registry outage in one sentence and exit 1, not in a stack", () =>
{
    const said = withNpmSaying(`echo 'network unreachable' >&2; exit 1`, () =>
        spawnSync(process.execPath, [gateScript, "--tag", "v0.12.0"], { encoding: "utf8" }));
    assert.equal(said.status, 1);
    assert.match(said.stderr, /the registry could not be asked what versions of/);
    assert.doesNotMatch(said.stderr, /^\s*at /m, said.stderr);
    assert.doesNotMatch(said.stderr, /Unhandled|ERR_UNHANDLED/, said.stderr);
});
