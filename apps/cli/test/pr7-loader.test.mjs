// Design §7.1 — plugin / loader state × invocation. Cells 1–21, 131–135,
// 147–152, one test per cell, with the cell's own stated outcome as the
// assertion.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { demoWorkspace, machine, must, selfIn } from "./harness.mjs";
import {
    installFixture, jsonOf, pluginSource, pluginsRoot, railEnv, railServer,
    readState, releaseDocument, selfAsync, selfSplit, signManifest, statePath, writeCredential, writeState
} from "./pr7-lib.mjs";

// Most cells here are about the plugin tree, which needs no workspace: a
// scratch machine is a third of the cost of one. The three cells whose subject
// is a workspace verb — a built-in resolving, and both halves of the alias
// collision — ask for one explicitly.
function box()
{
    const created = machine();
    return { ...created, demo: created.root };
}

function workspaceBox()
{
    const created = machine();
    return { ...created, ...demoWorkspace(created) };
}

/* ── cells 1–2: what a verb costs before anything is loaded ────────── */

test("cell 1: a built-in verb reads nothing in the plugin tree", () =>
{
    const it = workspaceBox();
    // A manifest no reader can parse. Building the verb index would throw on
    // it, so a `work add` that succeeds is a `work add` that never looked.
    installFixture(it, { key: "email" });
    writeFileSync(join(pluginsRoot(it), "email", "0.1.0", "manifest.json"), "{ not json");
    assert.equal(selfIn(it, it.demo, ["work", "add", "a built-in still resolves"]).code, 0);
});

test("cell 2: an unknown verb builds the index from metadata alone — no import, no signature check, no hash", () =>
{
    const it = box();
    const witness = join(it.root, "imported");
    installFixture(it, { key: "wallet", entry: pluginSource("wallet", `require0(); function require0(){ }`) });
    // The wallet entry, if imported, writes this file. `self email …` claims no
    // installed verb, so the index is built and nothing is imported.
    writeFileSync(join(pluginsRoot(it), "wallet", "0.1.0", "index.js"),
        `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(witness)},"x");export default () => [];`);
    const result = selfIn(it, it.demo, ["email", "send"]);
    assert.equal(result.code, 1);
    assert.match(result.out, /unknown command 'email'/);
    assert.match(result.out, /self app install email/);
    assert.equal(existsSync(witness), false, "an unrelated plugin's entry was imported");
});

/* ── cells 3–4: the happy path ─────────────────────────────────────── */

test("cell 3: an installed, valid plugin dispatches and passes checkContract", () =>
{
    const it = box();
    installFixture(it, { key: "email" });
    const result = selfIn(it, it.demo, ["email"]);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /^ok$/m);
});

test("cell 4: root usage lists an installed plugin verb, marked as a mini-app", () =>
{
    const it = box();
    installFixture(it, { key: "email" });
    const result = selfIn(it, it.demo, ["--help"]);
    assert.equal(result.code, 0);
    assert.match(result.out, /email/);
    assert.match(result.out, /installed mini-app email@0\.1\.0/);
});

/* ── cells 5–11: what the loader refuses, and with which name ──────── */

test("cell 5: one mutated byte in the entry is plugin_integrity_failed, with no auto-reinstall", async () =>
{
    const it = box();
    const rail = await railServer(() => ({ status: 500, body: {} }));
    try
    {
        installFixture(it, { key: "email" });
        const entry = join(pluginsRoot(it), "email", "0.1.0", "index.js");
        writeFileSync(entry, `${readFileSync(entry, "utf8")} `);
        const result = await selfAsync(it, it.demo, ["email"], railEnv(rail));
        assert.equal(result.code, 1);
        assert.match(result.all, /plugin_integrity_failed|does not match its signed digest/);
        assert.equal(rail.calls.length, 0, "an integrity failure fetched something");
    }
    finally
    {
        await rail.close();
    }
});

test("cell 6: an edited manifest is plugin_signature_invalid", () =>
{
    const it = box();
    installFixture(it, { key: "email" });
    const path = join(pluginsRoot(it), "email", "0.1.0", "manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...manifest, version: "0.9.9" }));
    assert.match(selfIn(it, it.demo, ["email"]).out, /not signed by a pinned key/);
});

test("cell 7: a valid signature from an unknown key is plugin_signature_invalid", () =>
{
    const it = box();
    const { document } = installFixture(it, { key: "email" });
    writeFileSync(join(pluginsRoot(it), "email", "0.1.0", "signature.json"),
        JSON.stringify({ ...signManifest(document.manifest), kid: "rel-not-pinned" }));
    assert.match(selfIn(it, it.demo, ["email"]).out, /no pinned release key/);
});

test("cell 8: a plugin needing a newer CLI is plugin_requires_newer_cli", () =>
{
    const it = box();
    installFixture(it, { key: "email", cli: ">=9.0.0" });
    assert.match(selfIn(it, it.demo, ["email"]).out, /needs a CLI matching >=9\.0\.0/);
});

test("cell 9: an unsupported mini-app contract is plugin_contract_unsupported", () =>
{
    const it = box();
    installFixture(it, { key: "email", contract: 99 });
    assert.match(selfIn(it, it.demo, ["email"]).out, /mini-app contract 99/);
});

test("cell 10: registered verbs unequal to the manifest's are plugin_verb_mismatch", () =>
{
    const it = box();
    installFixture(it, { key: "email", verbs: ["email"], entry: pluginSource("mail") });
    assert.match(selfIn(it, it.demo, ["email"]).out, /registered mail, and its manifest declares email/);
});

test("cell 11: a command failing checkContract is plugin_contract_invalid, findings listed", () =>
{
    const it = box();
    const broken = `export default function register(host)
{
    return [{
        name: "email",
        usage: [{ syntax: "email --nowhere", description: ["broken"], verbs: [""] }],
        detail: [],
        node: host.contract.leaf("", {}, 0, () => [])
    }];
}
`;
    installFixture(it, { key: "email", entry: broken });
    const result = selfIn(it, it.demo, ["email"]);
    assert.equal(result.code, 1);
    assert.match(result.out, /invalid command contract/);
    assert.match(result.out, /--nowhere/);
});

/* ── cells 12–14: a verb has exactly one owner ─────────────────────── */

async function installThrough(it, document, args = [])
{
    const rail = await railServer(() => ({ status: 200, body: document }));
    try
    {
        writeCredential(it, { apiBase: rail.url });
        return { ...await selfAsync(it, it.demo, ["app", "install", ...args], railEnv(rail)), calls: rail.calls };
    }
    finally
    {
        await rail.close();
    }
}

test("cell 12: installing a plugin that claims a built-in verb is refused verb_reserved", async () =>
{
    const it = box();
    const result = await installThrough(it, releaseDocument({ key: "work", verbs: ["work"] }), ["work"]);
    assert.equal(result.code, 1);
    assert.match(result.all, /"work" is a built-in command/);
});

test("cell 13: installing a plugin that claims an alias row is refused verb_conflicts_alias", async () =>
{
    const it = workspaceBox();
    must(it, it.demo, ["alias", "add", "brief", "--label", "brief"]);
    const result = await installThrough(it, releaseDocument({ key: "brief", verbs: ["brief"] }), ["brief"]);
    assert.equal(result.code, 1);
    assert.match(result.all, /already an alias row/);
});

test("cell 14: `alias add` is refused for a verb an installed plugin claims", () =>
{
    const it = workspaceBox();
    installFixture(it, { key: "email" });
    const result = selfIn(it, it.demo, ["alias", "add", "email", "--label", "email"]);
    assert.equal(result.code, 1);
    assert.match(result.out, /claimed by an installed mini-app/);
});

/* ── cells 15–18: broken trees and the development path ────────────── */

test("cell 15: `current` naming a missing version directory is plugin_not_installed", () =>
{
    const it = box();
    installFixture(it, { key: "email" });
    writeFileSync(join(pluginsRoot(it), "email", "current"), JSON.stringify({ version: "9.9.9" }));
    const result = selfIn(it, it.demo, ["email"]);
    assert.equal(result.code, 1);
    assert.match(result.out, /unknown command 'email'/);
});

test("cell 16: a partial version directory from a killed install is ignored", () =>
{
    const it = box();
    installFixture(it, { key: "email" });
    mkdirSync(join(pluginsRoot(it), "email", "0.2.0"), { recursive: true });
    writeFileSync(join(pluginsRoot(it), "email", "0.2.0", "manifest.json"), "{}");
    const result = selfIn(it, it.demo, ["email"]);
    assert.equal(result.code, 0, result.out);
    assert.equal(JSON.parse(readFileSync(join(pluginsRoot(it), "email", "current"), "utf8")).version, "0.1.0");
});

test("cell 17: a development plugin without development mode is refused on any invocation", () =>
{
    const it = box();
    const result = selfIn(it, it.demo, ["work", "list"], { SUPERSELF_PLUGIN_DEV: "/tmp/nowhere" });
    assert.equal(result.code, 1);
    assert.match(result.out, /SUPERSELF_PLUGIN_DEV needs SUPERSELF_DEV=1/);
});

test("cell 18: a development plugin loads, banners on stderr, and marks every machine answer", () =>
{
    const it = box();
    const dir = join(it.root, "devplugin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.js"), pluginSource("email"));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({
        manifest_version: 1, key: "email", name: "dev", version: "0.0.0", verbs: ["email"],
        contract: 0, rail_api: "^1", cli: ">=0.6.0 <2.0.0", scopes: [],
        entry_sha256: "", entry_bytes: 0, released_at: "2026-08-01T00:00:00Z"
    }));
    const result = selfSplit(it, it.demo, ["email", "--json"], { SUPERSELF_DEV: "1", SUPERSELF_PLUGIN_DEV: dir });
    assert.equal(result.code, 0, result.out + result.err);
    assert.match(result.err, /UNSIGNED development plugin/);
    assert.equal(jsonOf(result.out).plugin_source, "dev");
});

/* ── cells 19–21: installing ───────────────────────────────────────── */

test("cell 19: installing a plugin installs what it requires", async () =>
{
    const it = box();
    const email = releaseDocument({ key: "email", requires: ["wallet"] });
    const wallet = releaseDocument({ key: "wallet" });
    const rail = await railServer((call) => ({ status: 200, body: call.path.includes("wallet") ? wallet : email }));
    try
    {
        writeCredential(it, { apiBase: rail.url });
        const result = await selfAsync(it, it.demo, ["app", "install", "email"], railEnv(rail));
        assert.equal(result.code, 0, result.out);
        assert.ok(existsSync(join(pluginsRoot(it), "email", "0.1.0", "index.js")));
        assert.ok(existsSync(join(pluginsRoot(it), "wallet", "0.1.0", "index.js")), "the required plugin was not installed");
    }
    finally
    {
        await rail.close();
    }
});

test("cell 20: installing below the high-water mark is refused, and --allow-downgrade lowers the mark first", async () =>
{
    const it = box();
    installFixture(it, { key: "email", version: "0.1.0" });
    const older = releaseDocument({ key: "email", version: "0.0.9" });
    const rail = await railServer(() => ({ status: 200, body: older }));
    try
    {
        writeCredential(it, { apiBase: rail.url });
        const refused = await selfAsync(it, it.demo, ["app", "install", "email@0.0.9"], railEnv(rail));
        assert.equal(refused.code, 1);
        assert.match(refused.all, /downgrade_blocked|below 0\.1\.0/);
        assert.equal(readState(it).plugins.email.highest, "0.1.0", "a refused install moved the mark");

        const allowed = await selfAsync(it, it.demo, ["app", "install", "email@0.0.9", "--allow-downgrade"], railEnv(rail));
        assert.equal(allowed.code, 0, allowed.out);
        assert.equal(readState(it).plugins.email.highest, "0.0.9");
    }
    finally
    {
        await rail.close();
    }
});

test("cell 21: an entry over the 4 MB cap is refused plugin_too_large", async () =>
{
    const it = box();
    const huge = releaseDocument({ key: "email", entry: `${pluginSource("email")}\n// ${"x".repeat(4 * 1024 * 1024 + 16)}` });
    const rail = await railServer(() => ({ status: 200, body: huge }));
    try
    {
        writeCredential(it, { apiBase: rail.url });
        const result = await selfAsync(it, it.demo, ["app", "install", "email"], railEnv(rail));
        assert.equal(result.code, 1);
        assert.match(result.all, /plugin_too_large|bytes/);
        assert.equal(existsSync(join(pluginsRoot(it), "email", "0.1.0")), false);
    }
    finally
    {
        await rail.close();
    }
});

/* ── cells 131–133: replay, which a signature alone does not close ─── */

test("cell 131: a genuinely signed release of another key is plugin_identity_mismatch", () =>
{
    const it = box();
    // Signed correctly — as `wallet` — and dropped into `plugins/email/`.
    installFixture(it, { key: "wallet", verbs: ["email"], dirKey: "email" });
    const result = selfIn(it, it.demo, ["email"]);
    assert.equal(result.code, 1);
    assert.match(result.out, /manifest names wallet@0\.1\.0, installed as email@0\.1\.0/);
});

test("cell 132: a genuinely signed older manifest under a newer directory name is plugin_identity_mismatch", () =>
{
    const it = box();
    installFixture(it, { key: "email", version: "0.0.9", dirVersion: "0.2.0", highest: "0.2.0" });
    const result = selfIn(it, it.demo, ["email"]);
    assert.equal(result.code, 1);
    assert.match(result.out, /manifest names email@0\.0\.9, installed as email@0\.2\.0/);
});

test("cell 133: selecting below the mark is refused, and deleting the state file removes rather than unlocks", () =>
{
    const it = box();
    installFixture(it, { key: "email", version: "0.0.9", highest: "0.2.0" });
    const blocked = selfIn(it, it.demo, ["email"]);
    assert.equal(blocked.code, 1);
    assert.match(blocked.out, /below the highest version ever installed \(0\.2\.0\)/);

    rmSync(statePath(it));
    const missing = selfIn(it, it.demo, ["email"]);
    assert.equal(missing.code, 1);
    assert.match(missing.out, /has no install record/);
    assert.match(missing.out, /--force/);
});

/* ── cells 134–135: compatibility and algorithm confusion ──────────── */

test("cell 134: an incompatible rail major refuses before the dynamic import", () =>
{
    const it = box();
    const witness = join(it.root, "imported-134");
    installFixture(it, { key: "email", railApi: "^2", railApiSeen: "1" });
    writeFileSync(join(pluginsRoot(it), "email", "0.1.0", "index.js"),
        `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(witness)},"x");export default () => [];`);
    const result = selfIn(it, it.demo, ["email"]);
    assert.equal(result.code, 1);
    assert.match(result.out, /needs rail API \^2, and this rail is 1/);
    assert.equal(existsSync(witness), false, "the module was imported before the compatibility check");
});

for (const alg of ["none", "hs256", "ED25519", undefined])
{
    test(`cell 135: signature.alg ${String(alg)} is refused before the entry is decoded`, async () =>
    {
        const it = box();
        const document = releaseDocument({ key: "email" });
        const signature = { ...document.signature };
        if (alg === undefined)
        {
            delete signature.alg;
        }
        else
        {
            signature.alg = alg;
        }
        const rail = await railServer(() => ({ status: 200, body: { ...document, signature } }));
        try
        {
            writeCredential(it, { apiBase: rail.url });
            const result = await selfAsync(it, it.demo, ["app", "install", "email"], railEnv(rail));
            assert.equal(result.code, 1);
            assert.match(result.all, /signature algorithm .* is not accepted/);
            // Nothing was written, which is the observable form of "the entry
            // was never decoded and the verifier never ran".
            assert.equal(existsSync(join(pluginsRoot(it), "email")), false);
        }
        finally
        {
            await rail.close();
        }
    });
}

/* ── cell 147: the rail major is resolved before anything loads ────── */

test("cell 147: an absent rail major is resolved by exactly one host probe, and no plugin call precedes it", async () =>
{
    const it = box();
    installFixture(it, { key: "email", railApiSeen: null });
    writeState(it, "email", { highest: "0.1.0", installed_at: "2026-08-01T00:00:00Z" });
    const rail = await railServer(() => ({ status: 200, body: { account: "acct_01J8TEST", scopes: [] } }));
    try
    {
        writeCredential(it, { apiBase: rail.url });
        const result = await selfAsync(it, it.demo, ["email"], railEnv(rail));
        assert.equal(result.code, 0, result.out);
        const probes = rail.calls.filter((call) => call.path === "/api/agent/session");
        assert.equal(probes.length, 1, "the host probed more than once");
        assert.equal(rail.calls.length, 1, "a plugin call was issued while the rail major was unknown");
        assert.equal(readState(it).plugins.email.rail_api_seen, "1");
    }
    finally
    {
        await rail.close();
    }
});

test("cell 147: a probe that cannot answer refuses the load rail_api_unknown, and the module is never imported", async () =>
{
    for (const answer of [{ status: 200, body: {}, headers: { "x-superself-api": "" } }, { status: 503, body: {} }])
    {
        const it = box();
        const witness = join(it.root, "imported-147");
        installFixture(it, { key: "email" });
        writeState(it, "email", { highest: "0.1.0", installed_at: "2026-08-01T00:00:00Z" });
        writeFileSync(join(pluginsRoot(it), "email", "0.1.0", "index.js"),
            `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(witness)},"x");export default () => [];`);
        // A blank header is a header that answered nothing; the 503 is a probe
        // that failed outright. Both leave the major unknown.
        const rail = await railServer(() => answer);
        try
        {
            writeCredential(it, { apiBase: rail.url });
            const result = await selfAsync(it, it.demo, ["email"], railEnv(rail));
            assert.equal(result.code, 1);
            assert.match(result.all, /rail's API major is unknown/);
            assert.equal(existsSync(witness), false, "the module was imported with an unknown rail major");
        }
        finally
        {
            await rail.close();
        }
    }
});

/* ── cells 148–150: crash points, and what `remove` keeps ──────────── */

test("cell 148: an upgrade killed between `current` and `highest` still loads", () =>
{
    const it = box();
    installFixture(it, { key: "email", version: "0.2.0" });
    // The residue of the upgrade order: current moved, the mark had not risen.
    writeState(it, "email", { highest: "0.1.0", rail_api_seen: "1", installed_at: "2026-08-01T00:00:00Z" });
    const result = selfIn(it, it.demo, ["email"]);
    assert.equal(result.code, 0, result.out);
    assert.doesNotMatch(result.out, /plugin_rollback_blocked/);
});

test("cell 149: a downgrade killed between `highest` and `current` still loads", () =>
{
    const it = box();
    installFixture(it, { key: "email", version: "0.1.0" });
    // The residue of the downgrade order: the mark was lowered first, current
    // still names the newer version. The upgrade order here would have left
    // selected < highest and bricked the key.
    writeState(it, "email", { highest: "0.0.9", rail_api_seen: "1", installed_at: "2026-08-01T00:00:00Z" });
    const result = selfIn(it, it.demo, ["email"]);
    assert.equal(result.code, 0, result.out);
});

test("cell 150: `remove` keeps the high-water mark, so installing older is still refused", async () =>
{
    const it = box();
    installFixture(it, { key: "email", version: "0.1.0" });
    const removed = selfIn(it, it.demo, ["app", "remove", "email"]);
    assert.equal(removed.code, 0, removed.out);
    assert.equal(readState(it).plugins.email.highest, "0.1.0", "remove cleared the rollback mark");
    assert.equal(existsSync(join(pluginsRoot(it), "email")), false);

    const older = releaseDocument({ key: "email", version: "0.0.9" });
    const rail = await railServer(() => ({ status: 200, body: older }));
    try
    {
        writeCredential(it, { apiBase: rail.url });
        const refused = await selfAsync(it, it.demo, ["app", "install", "email@0.0.9"], railEnv(rail));
        assert.equal(refused.code, 1);
        assert.match(refused.all, /downgrade_blocked|below 0\.1\.0/);
    }
    finally
    {
        await rail.close();
    }
});

/* ── cell 151: the bytes hashed are the bytes imported ─────────────── */

test("cell 151: the module that executes is the verified copy, not the file at the plugin path", () =>
{
    const it = box();
    const report = join(it.root, "where");
    installFixture(it, {
        key: "email",
        entry: `import {writeFileSync} from "node:fs";
export default function register(host)
{
    writeFileSync(${JSON.stringify(report)}, import.meta.url);
    return [{
        name: "email",
        usage: [{ syntax: "email", description: ["fixture"], verbs: [""] }],
        detail: [],
        node: host.contract.leaf("", {}, 0, () => [])
    }];
}
`
    });
    assert.equal(selfIn(it, it.demo, ["email"]).code, 0);
    const url = readFileSync(report, "utf8");
    assert.match(url, /superself\/loaded\/[0-9a-f]{128}\/index\.mjs$/,
        "the plugin path itself was imported, which is the swap window this closes");
    assert.doesNotMatch(url, /plugins\/email/);
});

test("cell 151: a watcher swapping the entry after the digest passes never gets its code executed", () =>
{
    const it = box();
    const witness = join(it.root, "swapped");
    installFixture(it, { key: "email" });
    const entry = join(pluginsRoot(it), "email", "0.1.0", "index.js");
    const good = readFileSync(entry);
    const evil = Buffer.from(`import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(witness)},"x");export default () => [];`);
    // A real race rather than a simulated one: the file is rewritten in a tight
    // loop while the CLI runs. Either the digest fails (the swap landed before
    // the read) or the verified copy runs — never the swapped bytes.
    for (let round = 0; round < 12; round += 1)
    {
        writeFileSync(entry, good);
        const timer = setInterval(() => { try { writeFileSync(entry, evil); } catch { /* racing the reader */ } }, 1);
        try
        {
            selfIn(it, it.demo, ["email"]);
        }
        finally
        {
            clearInterval(timer);
        }
        assert.equal(existsSync(witness), false, "swapped bytes executed");
    }
});

/* ── cell 152: the pin is checked before anything is written ───────── */

test("cell 152: a release answering with a version other than the pin writes nothing", async () =>
{
    const it = box();
    const other = releaseDocument({ key: "email", version: "0.2.0" });
    const rail = await railServer(() => ({ status: 200, body: other }));
    try
    {
        writeCredential(it, { apiBase: rail.url });
        const result = await selfAsync(it, it.demo, ["app", "install", "email@0.1.0"], railEnv(rail));
        assert.equal(result.code, 1);
        assert.match(result.all, /asked for email@0\.1\.0 and the rail answered with 0\.2\.0/);
        assert.equal(rail.calls[0].query.version, "0.1.0", "the pin was not sent as a request parameter");
        assert.equal(existsSync(join(pluginsRoot(it), "email")), false, "a version directory was written");
        assert.equal(existsSync(statePath(it)) && readState(it).plugins.email !== undefined, false,
            "the high-water mark was written");
    }
    finally
    {
        await rail.close();
    }
});

test("`app update` names what it is updating, or is told to say --all", async () =>
{
    const it = box();
    installFixture(it, { key: "email", version: "0.1.0" });
    const newer = releaseDocument({ key: "email", version: "0.2.0" });
    const rail = await railServer(() => ({ status: 200, body: newer }));
    try
    {
        writeCredential(it, { apiBase: rail.url });
        const vague = await selfAsync(it, it.demo, ["app", "update"], railEnv(rail));
        assert.equal(vague.code, 1);
        assert.match(vague.all, /name a mini-app to update, or pass --all/);
        assert.equal(rail.calls.length, 0, "a vague update still asked the rail for something");

        const named = await selfAsync(it, it.demo, ["app", "update", "email"], railEnv(rail));
        assert.equal(named.code, 0, named.all);
        assert.equal(readState(it).plugins.email.highest, "0.2.0");
    }
    finally
    {
        await rail.close();
    }
});

test("every `app` verb that declares --json answers with one JSON object", async () =>
{
    const it = box();
    installFixture(it, { key: "email", version: "0.1.0" });
    writeCredential(it, {});
    for (const argv of [["app", "list", "--json"], ["app", "remove", "email", "--json"]])
    {
        const result = await selfAsync(it, it.demo, argv, { SUPERSELF_DEV: "1" });
        assert.equal(result.code, 0, `${argv.join(" ")}: ${result.all}`);
        // One object, and it parses. A verb that declares `--json` and then
        // prints a sentence is the failure this catches.
        assert.equal(result.out.trim().split("\n").length, 1, `${argv.join(" ")} printed more than one line`);
        assert.doesNotThrow(() => JSON.parse(result.out), `${argv.join(" ")} did not print JSON`);
    }
});

test("`app list` reports compatibility as the loader would judge it, from metadata alone", async () =>
{
    const it = box();
    installFixture(it, { key: "email", cli: ">=0.6.0 <2.0.0" });
    installFixture(it, { key: "wallet", cli: ">=9.0.0" });
    writeCredential(it, {});
    const result = await selfAsync(it, it.demo, ["app", "list", "--json"], { SUPERSELF_DEV: "1" });
    assert.equal(result.code, 0, result.all);
    const rows = jsonOf(result.out).plugins;
    assert.equal(rows.find((row) => row.key === "email").compatible, true);
    assert.equal(rows.find((row) => row.key === "wallet").compatible, false,
        "a plugin needing a CLI this is not was reported as compatible");
});

test("a plugin verb's help page is the plugin's own, in both spellings of the question", async () =>
{
    const it = box();
    installFixture(it, { key: "email" });
    // Answering these with the root list told a reader the verb did not exist
    // while `self --help` listed it two lines above.
    for (const argv of [["email", "--help"], ["help", "email"]])
    {
        const result = await selfAsync(it, it.demo, argv);
        assert.equal(result.code, 0, `${argv.join(" ")}: ${result.all}`);
        assert.match(result.out, /^usage: self email/, `${argv.join(" ")} answered with the root list`);
    }
    // A name nothing owns still gets the root list, as it always did.
    const unknown = await selfAsync(it, it.demo, ["nosuch", "--help"]);
    assert.equal(unknown.code, 0);
    assert.match(unknown.out, /^usage: self <command>/);
});

/* ── the version and key are path segments before they are anything ── */

test("a version carrying a path escape is refused before it reaches the filesystem", async () =>
{
    const it = box();
    // The exact exploit shape the review found: `(?:[-+].*)?` accepted `/` and
    // `..` inside the prerelease, and a version is a DIRECTORY NAME here — so a
    // signed release document carrying this reached `mkdirSync` and
    // `writeFileSync` outside the plugin tree. A signature gates execution; it
    // does not gate where a verified document is written.
    const escaping = releaseDocument({ key: "email", version: "1.0.0-../../../../tmp/evil" });
    const rail = await railServer(() => ({ status: 200, body: escaping }));
    try
    {
        writeCredential(it, { apiBase: rail.url });
        const result = await selfAsync(it, it.demo, ["app", "install", "email"], railEnv(rail));
        assert.equal(result.code, 1);
        assert.match(result.all, /is not a semantic version/);
        assert.equal(existsSync(join(pluginsRoot(it), "email")), false, "a directory was created for it");
        assert.equal(existsSync("/tmp/evil"), false, "the install escaped the plugin tree");
    }
    finally
    {
        await rail.close();
    }
});

test("a `current` file naming an escaping version cannot reach a plugin outside the tree", () =>
{
    const it = box();
    const { document } = installFixture(it, { key: "email" });
    // A decoy the traversal would genuinely land on. Asserting that an escape
    // merely "fails to resolve" proves nothing — a path that does not exist
    // behaves exactly like a version that is not installed, so the test passes
    // against the vulnerable code. This one is reachable, so only the fix stops
    // it.
    const decoy = join(it.root, "decoy");
    mkdirSync(decoy, { recursive: true });
    writeFileSync(join(decoy, "manifest.json"), JSON.stringify(document.manifest));
    writeFileSync(join(decoy, "signature.json"), JSON.stringify(document.signature));
    writeFileSync(join(decoy, "index.js"), readFileSync(join(pluginsRoot(it), "email", "0.1.0", "index.js")));

    // Built from the real paths rather than a counted string. `1.0.0-..` is a
    // single directory NAME, not a step up, so a version needs a separator of
    // its own before its `..` counts — which is exactly the kind of off-by-one
    // that makes a security test quietly prove nothing.
    const escape = `1.0.0-x/${relative(join(pluginsRoot(it), "email", "1.0.0-x"), decoy)}`;
    assert.equal(existsSync(join(pluginsRoot(it), "email", escape, "manifest.json")), true,
        "the decoy is not actually reachable, so this test would prove nothing");

    writeFileSync(join(pluginsRoot(it), "email", "current"), JSON.stringify({ version: escape }));
    const result = selfIn(it, it.demo, ["email"]);
    assert.equal(result.code, 1);
    assert.match(result.out, /is not a semantic version/,
        "a version that climbs out of the plugin tree was accepted as one");
});

test("valid SemVer with a prerelease or build part still installs", async () =>
{
    const it = box();
    const rc = releaseDocument({ key: "email", version: "1.0.0-rc.1" });
    const rail = await railServer(() => ({ status: 200, body: rc }));
    try
    {
        writeCredential(it, { apiBase: rail.url });
        const result = await selfAsync(it, it.demo, ["app", "install", "email@1.0.0-rc.1"], railEnv(rail));
        assert.equal(result.code, 0, result.all);
        assert.ok(existsSync(join(pluginsRoot(it), "email", "1.0.0-rc.1", "index.js")),
            "the traversal fix broke a legitimate prerelease version");
    }
    finally
    {
        await rail.close();
    }
});

test("a release answering for a different key than the one asked for is refused before any write", async () =>
{
    const it = box();
    // Correctly signed, and for the wrong key. Deriving the install target from
    // the answer instead of the request would install `wallet` under the
    // operator's `email` command, over another key's high-water mark.
    const wrong = releaseDocument({ key: "wallet", verbs: ["wallet"] });
    const rail = await railServer(() => ({ status: 200, body: wrong }));
    try
    {
        writeCredential(it, { apiBase: rail.url });
        const result = await selfAsync(it, it.demo, ["app", "install", "email"], railEnv(rail));
        assert.equal(result.code, 1);
        assert.match(result.all, /asked for "email" and the rail answered with a release for "wallet"/);
        assert.equal(existsSync(join(pluginsRoot(it), "wallet")), false, "the wrong key was installed");
        assert.equal(existsSync(join(pluginsRoot(it), "email")), false);
        assert.equal(existsSync(statePath(it)) && readState(it).plugins.wallet !== undefined, false,
            "a high-water mark was written for a key nobody asked for");
    }
    finally
    {
        await rail.close();
    }
});
