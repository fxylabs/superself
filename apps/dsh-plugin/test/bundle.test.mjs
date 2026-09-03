import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Config, apply, inject, name } from "../lib/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("the bundle manifest points at a patch that inserts this package by name", () =>
{
    assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
    assert.ok(pkg.files.includes("cordis.patch.yml"));
    const patch = readFileSync(join(root, "cordis.patch.yml"), "utf8");
    assert.match(patch, new RegExp(`name: ${pkg.name}\\s*$`, "m"));
    assert.ok(pkg.keywords.includes("dsh-plugin"));
    assert.ok(existsSync(join(root, pkg.main)));
});

test("defect 5: the tested dsh rc line is pinned as the peer range and named in the README", () =>
{
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const tested = readme.match(/Tested against `@deepseek-ai\/dsh@([^`]+)`/);
    assert.ok(tested, "README states the dsh version the plugin was tested against");
    assert.equal(pkg.peerDependencies["@deepseek-ai/dsh-tools"], `^${tested[1]}`);
    assert.equal(pkg.peerDependencies["@deepseek-ai/dsh-commands"], `^${tested[1]}`);
    assert.equal(pkg.peerDependenciesMeta["@deepseek-ai/dsh-commands"].optional, true);
});

test("the plugin entry exports what the loader reads, and the config has the documented defaults", () =>
{
    assert.equal(name, "superself");
    assert.deepEqual(inject, ["tools"]);
    assert.equal(typeof apply, "function");
    assert.deepEqual(Config({}), { selfBinary: "self", cwd: "", maxOutputChars: 20000 });
    assert.throws(() => Config({ maxOutputChars: "lots" }));
});

test("apply registers five tools, and the /self command only where a command registry exists", () =>
{
    const registered = [];
    const injected = [];
    const ctx = {
        tools: { register: (tool) => registered.push(tool.name) },
        inject: (services, callback) => injected.push({ services, callback }),
    };
    apply(ctx, Config({}));
    assert.deepEqual(registered, ["superself_context", "superself_work", "superself_report", "superself_decide", "superself_instructions"]);
    assert.equal(injected.length, 1);
    assert.deepEqual(injected[0].services, ["commands"]);
    const commands = [];
    injected[0].callback({ commands: { register: (command) => commands.push(command.name) } });
    assert.deepEqual(commands, ["self"]);
});
