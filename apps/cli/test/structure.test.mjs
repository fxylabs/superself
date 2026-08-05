// What the structure check (#90) answers, and what it refuses to answer.
//
// The rule sections are asserted against literal trees, so these cases hold on
// any checkout and do not depend on what the repository happens to contain
// today. The base-resolution cases build a throwaway repository, because
// refusing without a base is the behaviour under test.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import {
    changedLines,
    deadExports,
    diskTree,
    functionLengthViolations,
    functionSpans,
    importDirectionViolations,
    memoryTree,
    packageRoot,
    parseSource,
    resolveBase
} from "./structure.mjs";

const everyLine = (path, count) => new Map([[path, Array.from({ length: count }, (_, index) => index + 1)]]);
const noLines = new Map();

function longFunction(name, lines)
{
    return `export function ${name}()\n{\n${"    void 0;\n".repeat(lines)}}\n`;
}

// ---------------------------------------------------------------- import direction

test("a core module importing a subsystem is refused, naming the file and the rule", () =>
{
    const tree = memoryTree({
        "src/fold.ts": "import { run } from \"./daemon/commands.js\";\nexport const folded = run;\n",
        "src/daemon/commands.ts": "export function run() {}\n"
    });
    const [violation] = importDirectionViolations(tree);
    assert.equal(violation.file, "src/fold.ts");
    assert.equal(violation.line, 1);
    assert.equal(violation.rule, "import-direction");
    assert.match(violation.detail, /core module imports from subsystem daemon\//);
});

test("main.ts importing a subsystem's commands entry is the sanctioned way in", () =>
{
    const tree = memoryTree({
        "src/main.ts": "import { run } from \"./daemon/commands.js\";\nexport const cli = run;\n",
        "src/daemon/commands.ts": "export function run() {}\n"
    });
    assert.deepEqual(importDirectionViolations(tree), []);
});

test("main.ts reaching past a subsystem's commands entry is still refused", () =>
{
    const tree = memoryTree({
        "src/main.ts": "import { inner } from \"./daemon/inner.js\";\nexport const cli = inner;\n",
        "src/daemon/inner.ts": "export function inner() {}\n"
    });
    assert.equal(importDirectionViolations(tree).length, 1);
});

test("one subsystem importing another is refused while no edge is sanctioned", () =>
{
    const tree = memoryTree({
        "src/daemon/commands.ts": "import { plan } from \"../spec/commands.js\";\nexport const run = plan;\n",
        "src/spec/commands.ts": "export function plan() {}\n"
    });
    const [violation] = importDirectionViolations(tree);
    assert.match(violation.detail, /subsystem daemon\/ imports from subsystem spec\//);
});

test("core modules importing each other is what the flat tree does, and passes", () =>
{
    const tree = memoryTree({
        "src/fold.ts": "import { parse } from \"./args.js\";\nexport const folded = parse;\n",
        "src/args.ts": "export function parse() {}\n"
    });
    assert.deepEqual(importDirectionViolations(tree), []);
});

test("the repository's own source conforms to the import rule", () =>
{
    assert.deepEqual(importDirectionViolations(diskTree(packageRoot)), []);
});

// ---------------------------------------------------------------- function length

test("a new function over the ceiling is refused", () =>
{
    const source = longFunction("wide", 80);
    const tree = memoryTree({ "src/wide.ts": source });
    const [violation] = functionLengthViolations(tree, everyLine("src/wide.ts", source.split("\n").length), 60);
    assert.equal(violation.rule, "function-length");
    assert.match(violation.detail, /wide is 83 lines, over the 60-line ceiling/);
});

test("a function over the ceiling the diff did not touch is left alone", () =>
{
    const tree = memoryTree({ "src/wide.ts": longFunction("wide", 80) });
    assert.deepEqual(functionLengthViolations(tree, noLines, 60), []);
});

test("editing one line inside a long function makes it the diff's problem", () =>
{
    const tree = memoryTree({ "src/wide.ts": longFunction("wide", 80) });
    const violations = functionLengthViolations(tree, new Map([["src/wide.ts", [40]]]), 60);
    assert.equal(violations.length, 1);
});

test("a change elsewhere in the file does not summon an untouched long function", () =>
{
    const tree = memoryTree({ "src/wide.ts": `export const flag = true;\n${longFunction("wide", 80)}` });
    assert.deepEqual(functionLengthViolations(tree, new Map([["src/wide.ts", [1]]]), 60), []);
});

test("a function is measured once, not again for every closure inside it", () =>
{
    const tree = memoryTree({ "src/nest.ts": "export function outer()\n{\n    const inner = () =>\n    {\n        return 1;\n    };\n    return inner();\n}\n" });
    const spans = functionSpans(parseSource(tree, "src/nest.ts"));
    assert.deepEqual(spans.map((span) => span.name), ["outer"]);
    assert.equal(spans[0].lines, 8);
});

test("an arrow assigned to a const is measured from the const a reader sees", () =>
{
    const tree = memoryTree({ "src/arrow.ts": "export const handler = () =>\n{\n    return 1;\n};\n" });
    const [span] = functionSpans(parseSource(tree, "src/arrow.ts"));
    assert.equal(span.name, "handler");
    assert.equal(span.line, 1);
    assert.equal(span.lines, 4);
});

test("a class method is a function the ceiling applies to", () =>
{
    const tree = memoryTree({ "src/klass.ts": "export class Store\n{\n    write()\n    {\n        return 1;\n    }\n}\n" });
    assert.deepEqual(functionSpans(parseSource(tree, "src/klass.ts")).map((span) => span.name), ["write"]);
});

test("every length violation the check reports is genuinely over the ceiling", () =>
{
    const tree = diskTree(packageRoot);
    const changed = new Map(tree.paths.map((path) => [path, everyLine(path, 100000).get(path)]));
    const spans = new Map(tree.paths.filter((path) => path.startsWith("src/")).map((path) => [path, functionSpans(parseSource(tree, path))]));
    for (const violation of functionLengthViolations(tree, changed, 60))
    {
        const span = spans.get(violation.file).find((candidate) => candidate.line === violation.line);
        assert.ok(span.lines > 60, `${violation.file}:${violation.line} reported at ${span.lines} lines`);
    }
});

// ---------------------------------------------------------------- dead exports

test("an export no file imports is reported", () =>
{
    const tree = memoryTree({ "src/lonely.ts": "export function unused() {}\n" });
    assert.deepEqual(deadExports(tree), [{ file: "src/lonely.ts", name: "unused" }]);
});

test("an export another module imports by name is alive", () =>
{
    const tree = memoryTree({
        "src/lonely.ts": "export function used() {}\n",
        "src/main.ts": "import { used } from \"./lonely.js\";\nexport const cli = used;\n"
    });
    assert.deepEqual(deadExports(tree).map((entry) => entry.name), ["cli"]);
});

test("a test is an importer, so an export only the suite reads is alive", () =>
{
    const tree = memoryTree({
        "src/lonely.ts": "export function proven() {}\n",
        "test/lonely.test.ts": "import { proven } from \"../src/lonely.js\";\nproven();\n"
    });
    assert.deepEqual(deadExports(tree), []);
});

// The shape the suite actually has: `.mjs` files reaching the CLI through its
// build output. Miss either half and every export only a test uses reads dead.
test("a .mjs test importing through dist/ keeps the source export alive", () =>
{
    const tree = memoryTree({
        "src/sanitize.ts": "export function assertSanitized() {}\n",
        "test/sanitize.test.mjs": "import { assertSanitized } from \"../dist/sanitize.js\";\nassertSanitized();\n"
    });
    assert.deepEqual(deadExports(tree), []);
});

test("a namespace import keeps the whole module alive, since it names no member", () =>
{
    const tree = memoryTree({
        "src/bag.ts": "export function one() {}\nexport function two() {}\n",
        "src/main.ts": "import * as bag from \"./bag.js\";\nexport const cli = bag;\n"
    });
    assert.deepEqual(deadExports(tree).map((entry) => entry.name), ["cli"]);
});

test("a dynamic import keeps the whole module alive, since the AST cannot see the member", () =>
{
    const tree = memoryTree({
        "src/late.ts": "export function deferred() {}\n",
        "src/main.ts": "export const load = () => import(\"./late.js\");\n"
    });
    assert.deepEqual(deadExports(tree).map((entry) => entry.name), ["load"]);
});

test("a re-exported name is alive at the module that declares it", () =>
{
    const tree = memoryTree({
        "src/inner.ts": "export function carried() {}\n",
        "src/facade.ts": "export { carried } from \"./inner.js\";\n"
    });
    assert.deepEqual(deadExports(tree).map((entry) => entry.file), ["src/facade.ts"]);
});

test("a module importing its own export does not thereby keep it alive", () =>
{
    const tree = memoryTree({ "src/self.ts": "import { loop } from \"./self.js\";\nexport function loop() { return loop; }\n" });
    assert.deepEqual(deadExports(tree).map((entry) => entry.name), ["loop"]);
});

// ---------------------------------------------------------------- the base

function repository()
{
    const root = mkdtempSync(join(tmpdir(), "structure-base-"));
    const run = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
    run("init", "--quiet", "--initial-branch", "work");
    run("config", "user.email", "test@superself.local");
    run("config", "user.name", "test machine");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/one.ts"), "export const one = 1;\n");
    run("add", ".");
    run("commit", "--quiet", "-m", "first");
    return { root, run };
}

test("with no main and no origin/main, the check refuses instead of passing", () =>
{
    const { root } = repository();
    assert.throws(() => resolveBase(undefined, root), /pass --base <ref> or set STRUCTURE_BASE/);
});

test("a shallow clone is refused by name, with the fix", () =>
{
    const { root } = repository();
    const clone = mkdtempSync(join(tmpdir(), "structure-shallow-"));
    execFileSync("git", ["clone", "--quiet", "--depth", "1", `file://${root}`, join(clone, "copy")], { encoding: "utf8" });
    assert.throws(() => resolveBase(undefined, join(clone, "copy")), /shallow clone.*fetch-depth: 0/s);
});

test("a named base resolves to the merge base, not to the ref itself", () =>
{
    const { root, run } = repository();
    const first = run("rev-parse", "HEAD").trim();
    run("checkout", "--quiet", "-b", "later");
    writeFileSync(join(root, "src/two.ts"), "export const two = 2;\n");
    run("add", ".");
    run("commit", "--quiet", "-m", "second");
    assert.equal(resolveBase("work", root), first);
});

test("a renamed file with no edits contributes no changed lines", () =>
{
    const { root, run } = repository();
    writeFileSync(join(root, "src/one.ts"), `${longFunction("wide", 80)}`);
    run("add", ".");
    run("commit", "--quiet", "-m", "long function");
    const base = run("rev-parse", "HEAD").trim();
    run("mv", "src/one.ts", "src/renamed.ts");
    run("commit", "--quiet", "-m", "rename");
    assert.deepEqual([...changedLines(base, root).keys()], []);
});

test("an added line is reported at its number in the head revision", () =>
{
    const { root, run } = repository();
    const base = run("rev-parse", "HEAD").trim();
    writeFileSync(join(root, "src/one.ts"), "export const zero = 0;\nexport const one = 1;\n");
    assert.deepEqual(changedLines(base, root).get("src/one.ts"), [1]);
});
