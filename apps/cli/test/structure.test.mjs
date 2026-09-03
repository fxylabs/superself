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
    awaitedDriverExempt,
    awaitedDriverViolations,
    awaitedTestFiles,
    changedLines,
    deadExports,
    diskTree,
    functionLengthViolations,
    functionSpans,
    importDirectionViolations,
    interactionPrompt,
    invocationStateViolations,
    credentialIsolationViolations,
    credentialModules,
    maxFunctionLines,
    memoryTree,
    packageRoot,
    printingModules,
    sanctionedEdges,
    parseSource,
    printSiteViolations,
    rootKeyViolations,
    rootKeysModule,
    resolveBase,
    testConcurrencyViolations
} from "./structure.mjs";

// The gate reads no environment variable at all, so a case below fires — or
// does not — on the tree it is handed and on nothing else. `withDevKeyOptOut`
// is the proof of that: it sets the variable the gate used to honour, and every
// case asserts the same outcome with it set.
function withDevKeyOptOut(run)
{
    const had = process.env.SUPERSELF_DEV_KEYS;
    process.env.SUPERSELF_DEV_KEYS = "1";
    try
    {
        run();
    }
    finally
    {
        if (had === undefined)
        {
            delete process.env.SUPERSELF_DEV_KEYS;
            return;
        }
        process.env.SUPERSELF_DEV_KEYS = had;
    }
}

function keyPins(...kids)
{
    const records = kids.map((kid) => `    { kid: "${kid}", publicKey: "x", notBefore: "a", notAfter: "b" }`).join(",\n");
    return memoryTree({ [rootKeysModule]: `export const ROOT_KEYS = [\n${records}\n];\n` });
}

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

// ---------------------------------------------------------------- print sites

// Cells 12 and 13 of the render-gate case table (w-5emx6 stage 1).

test("cell 12: a print from a module off the allowlist is refused, naming the file, line and rule", () =>
{
    const tree = memoryTree({
        "src/pipeline.ts": "export function announce()\n{\n    console.log(\"recorded\");\n}\n"
    });
    const [violation] = printSiteViolations(tree);
    assert.equal(violation.file, "src/pipeline.ts");
    assert.equal(violation.line, 3);
    assert.equal(violation.rule, "print-site");
    assert.match(violation.detail, /console\.log outside the render gate/);
});

test("cell 12: writing to the descriptor is the same violation as logging", () =>
{
    const tree = memoryTree({ "src/fold.ts": "export function say()\n{\n    process.stdout.write(\"x\\n\");\n}\n" });
    const [violation] = printSiteViolations(tree);
    assert.equal(violation.line, 3);
    assert.match(violation.detail, /process\.stdout\.write outside the render gate/);
});

test("cell 12: the render gate itself prints, and so does the one declared interaction", () =>
{
    const tree = memoryTree({
        "src/output.ts": "export function notice(line: string)\n{\n    console.log(line);\n}\n",
        "src/human.ts": "export function ask()\n{\n    process.stdout.write(\"type it: \");\n}\n"
    });
    assert.deepEqual(printSiteViolations(tree), []);
});

// A refusal goes to stderr, and where that is written from is a separate
// question from where an answer is. The rule says nothing about it.
test("cell 12: console.error is not this rule's subject", () =>
{
    const tree = memoryTree({ "src/pipeline.ts": "export function warn()\n{\n    console.error(\"x\");\n}\n" });
    assert.deepEqual(printSiteViolations(tree), []);
});

test("cell 13: the repository's own source prints only from the gate and the one interaction", () =>
{
    assert.deepEqual(printSiteViolations(diskTree(packageRoot)), []);
});

// A declared exception that no longer prints is a rule that has quietly
// stopped holding for that module — the same defect a stale allowlist entry
// was, now that the allowlist the migration ratcheted down is empty.
test("cell 13: the declared interaction still writes its prompt", () =>
{
    const tree = diskTree(packageRoot);
    assert.match(tree.read(interactionPrompt), /process\.stdout\.write/);
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

// ---------------------------------------------------------------- invocation state

// A tree with a `main.ts` whose `resetInvocation` clears whatever the case
// hands it, and one other module holding the state under test.
function withReset(module, source, reset)
{
    return memoryTree({
        "src/main.ts": `import { wipe } from "./${module.replace(/\.ts$/, ".js")}";\n`
            + `function resetInvocation()\n{\n${reset}\n}\n`,
        [`src/${module}`]: source
    });
}

test("a cache the invocation reset never clears is a violation that names the reset", () =>
{
    const tree = withReset("probe.ts", "const seen = new Map();\nexport function ask() { return seen; }\n", "");
    const violations = invocationStateViolations(tree);
    assert.deepEqual(violations.map((one) => one.file), ["src/probe.ts"]);
    assert.equal(violations[0].rule, "invocation-state");
    assert.match(violations[0].detail, /resetInvocation\(\)/);
});

test("a cache the reset clears through the export it imported is not a violation", () =>
{
    const tree = withReset("probe.ts",
        "const seen = new Map();\nexport function wipe() { seen.clear(); }\n", "    wipe();");
    assert.deepEqual(invocationStateViolations(tree), []);
});

test("the reset is followed through a helper of its own, not only through its first call", () =>
{
    const tree = memoryTree({
        "src/main.ts": "import { wipe } from \"./probe.js\";\nfunction resetInvocation()\n{\n    every();\n}\nfunction every() { wipe(); }\n",
        "src/probe.ts": "const seen = new Map();\nexport function wipe() { seen.clear(); }\n"
    });
    assert.deepEqual(invocationStateViolations(tree), []);
});

test("a reassignable binding the reset assigns is not a violation", () =>
{
    const tree = withReset("mode.ts",
        "let on = false;\nexport function wipe() { on = false; }\nexport function reads() { return on; }\n", "    wipe();");
    assert.deepEqual(invocationStateViolations(tree), []);
});

// The predicate is "state a command can leave behind", not "anything that
// looks like a table". These are the shapes the review named as false-positive
// candidates, and none of them is this rule's subject.
test("constant tables, arrays and populated collections are not invocation state", () =>
{
    const tree = withReset("tables.ts",
        "const LABELS: Record<string, string> = { a: \"b\" };\n"
        + "const RULES = [/x/, /y/];\n"
        + "const RETRYABLE = new Set([429, 503]);\n"
        + "const SPLITTER = new Intl.Segmenter(\"en\");\n"
        + "export function reads() { return [LABELS, RULES, RETRYABLE, SPLITTER]; }\n", "");
    assert.deepEqual(invocationStateViolations(tree), []);
});

test("a `let` inside a template string is not invocation state", () =>
{
    const tree = withReset("page.ts",
        "const PAGE = `<script>let lastActivity = 0;</script>`;\nexport function reads() { return PAGE; }\n", "");
    assert.deepEqual(invocationStateViolations(tree), []);
});

// ---------------------------------------------------------------- awaiting the driver

// A test file and the harness it imports, which is all the rule reads.
function suite(source)
{
    return memoryTree({ "test/harness.mjs": "export function must() {}\n", "test/case.test.mjs": source });
}

const listed = ["test/case.test.mjs"];

test("a harness call whose result is awaited is not a violation", () =>
{
    const tree = suite("import { must } from \"./harness.mjs\";\nawait must(1);\n");
    assert.deepEqual(awaitedDriverViolations(tree, listed), []);
});

test("a harness call left unawaited is named at its own line", () =>
{
    const tree = suite("import { must } from \"./harness.mjs\";\nmust(1);\n");
    const violations = awaitedDriverViolations(tree, listed);
    assert.deepEqual(violations.map((one) => [one.rule, one.line]), [["awaited-driver", 2]]);
    assert.match(violations[0].detail, /put `await` in front of it/);
});

// Cell 35: the wrapper case. 32 files in the suite put a one-line local helper
// in front of the harness, and every call of the helper is a call of the
// harness.
test("cell 35: a call through a file's own wrapper is followed to the wrapper's call sites", () =>
{
    const tree = suite("import { must } from \"./harness.mjs\";\n"
        + "const run = (args) => must(args);\n"
        + "run([\"status\"]);\n");
    const violations = awaitedDriverViolations(tree, listed);
    assert.deepEqual(violations.map((one) => [one.rule, one.line]), [["awaited-driver", 3]]);
});

test("the wrapper chain is followed until it stops growing, not one link deep", () =>
{
    const tree = suite("import { must } from \"./harness.mjs\";\n"
        + "const run = (args) => must(args);\n"
        + "const twice = (args) => run(args);\n"
        + "twice([\"status\"]);\n");
    assert.deepEqual(awaitedDriverViolations(tree, listed).map((one) => one.line), [4]);
});

test("a wrapper written inside a case's own callback is followed the same way", () =>
{
    const tree = suite("import { must } from \"./harness.mjs\";\n"
        + "test(\"x\", async () => {\n"
        + "    const run = (args) => must(args);\n"
        + "    run([\"status\"]);\n"
        + "});\n");
    assert.deepEqual(awaitedDriverViolations(tree, listed).map((one) => one.line), [4]);
});

// Cell 36: refused rather than passed. What the rule cannot follow it says so
// about, because the failure it exists to prevent is silent.
test("cell 36: a driver handed over as a value is refused as untraceable", () =>
{
    const tree = suite("import { must } from \"./harness.mjs\";\nconst run = later ? must : other;\n");
    const violations = awaitedDriverViolations(tree, listed);
    assert.deepEqual(violations.map((one) => one.rule), ["untraceable-driver"]);
    assert.match(violations[0].detail, /used as a value/);
});

test("a wrapper in a binding that can be reassigned is refused as untraceable", () =>
{
    const tree = suite("import { must } from \"./harness.mjs\";\nlet run = (args) => must(args);\nawait run(1);\n");
    const violations = awaitedDriverViolations(tree, listed);
    assert.deepEqual(violations.map((one) => one.rule), ["untraceable-driver"]);
    assert.match(violations[0].detail, /declare it const/);
});

test("a file that is not on the list is not read at all", () =>
{
    const tree = suite("import { must } from \"./harness.mjs\";\nmust(1);\n");
    assert.deepEqual(awaitedDriverViolations(tree, []), []);
});

// The list is a predicate now, not a roster: a file is on it because it names a
// driver, so a test file written later cannot be missed by not being added.
test("the list is every test file that names a driver, however it imports one", () =>
{
    const tree = memoryTree({
        "test/harness.mjs": "export function must() {}\nexport function machine() {}\n",
        "test/plain.test.mjs": "import { must } from \"./harness.mjs\";\n",
        "test/lazy.test.mjs": "const { must } = await import(\"./harness.mjs\");\n",
        "test/scratch.test.mjs": "import { machine } from \"./harness.mjs\";\n",
        "test/alone.test.mjs": "import assert from \"node:assert\";\n"
    });
    assert.deepEqual(awaitedTestFiles(tree), ["test/lazy.test.mjs", "test/plain.test.mjs"]);
});

test("the file that owns the runtime defence is the one exemption, and it says so", () =>
{
    assert.deepEqual(awaitedDriverExempt, ["test/driver.test.mjs"]);
});

test("a result handed straight to the caller is awaited by the caller", () =>
{
    const tree = suite("import { must } from \"./harness.mjs\";\n"
        + "const run = (args) => must(args);\n"
        + "async function both() { return Promise.all([run(1), run(2)]); }\n"
        + "await both();\n");
    assert.deepEqual(awaitedDriverViolations(tree, listed), []);
});

test("a case declared with a concurrency option is a violation", () =>
{
    const tree = memoryTree({ "test/case.test.mjs": "test(\"x\", { concurrency: true }, () => {});\n" });
    const violations = testConcurrencyViolations(tree);
    assert.deepEqual(violations.map((one) => one.rule), ["test-concurrency"]);
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

/* ── cell 116: a state writer has no import path to a credential ───── */

// The structural half of "a token never reaches the event log". The other half
// — login writing no event — is a property of one command and a future command
// could undo it; this cannot, because there is no import path for a future
// command to reach through.

test("a state-writing module importing the credential layer is a named violation", () =>
{
    const tree = memoryTree({
        "src/pipeline.ts": "import { readProfile } from \"./credentials.js\";\nexport const p = readProfile;\n",
        "src/credentials.ts": "export function readProfile() {}\n"
    });
    const [violation] = credentialIsolationViolations(tree);
    assert.equal(violation.file, "src/pipeline.ts");
    assert.equal(violation.line, 1);
    assert.equal(violation.rule, "credential-isolation");
    assert.match(violation.detail, /no import path to a credential/);
});

test("the same rule fires for the rail layer, and for the ledger as well as the pipeline", () =>
{
    const tree = memoryTree({
        "src/ledger.ts": "import { railRequest } from \"./rail.js\";\nexport const r = railRequest;\n",
        "src/rail.ts": "export function railRequest() {}\n"
    });
    assert.equal(credentialIsolationViolations(tree).length, 1);
});

test("cell 116: the real tree has no such import, and both credential modules are covered", () =>
{
    assert.deepEqual(credentialIsolationViolations(diskTree(packageRoot)), []);
    assert.deepEqual([...credentialModules].sort(), ["src/credentials.ts", "src/rail.ts", "src/trust.ts"]);
});

// ---------------------------------------------------------------- publish trust anchor

// The gate stands in front of `npm publish`. It must fire whenever any `dev-`
// key is pinned — the point being that a real key mixed in does not launder the
// dev key's committed private half.
test("the publish gate fires when the only pinned root is the development root", () =>
{
    const violations = rootKeyViolations(keyPins("dev-root-2026a"));
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, "development-trust-anchor");
    assert.match(violations[0].detail, /dev-root-2026a/);
});

// The other half of the same gate, and the reason it is two rules rather than
// one: a build that pins nothing accepts no key list, so it can install and
// load no mini-app at all. It is broken rather than dangerous, and it is still
// not shippable.
test("the publish gate fires when no root is pinned at all", () =>
{
    const violations = rootKeyViolations(keyPins());
    assert.equal(violations.length, 1);
    assert.equal(violations[0].rule, "empty-trust-anchor");
    assert.match(violations[0].detail, /root ceremony/);
});

test("the publish gate still fires when a real root is mixed with a dev- root", () =>
{
    const violations = rootKeyViolations(keyPins("root-2026a", "dev-root-2026a"));
    // Exactly the development root is named; the real one is not a violation.
    assert.equal(violations.length, 1);
    assert.match(violations[0].detail, /dev-root-2026a/);
    assert.doesNotMatch(violations[0].detail, /"root-2026a"/);
});

test("the publish gate passes when a real root is pinned and no dev- root is", () =>
{
    assert.deepEqual(rootKeyViolations(keyPins("root-2026a", "root-2026b")), []);
});

// The gate used to honour `SUPERSELF_DEV_KEYS=1` as an opt-out, which put the
// one switch that disarms it in the same shell that runs `npm publish`. There
// is no opt-out now, and this is the case that says so: with the variable set,
// every refusal above is still a refusal.
test("the publish gate has no environment opt-out", () =>
{
    withDevKeyOptOut(() =>
    {
        assert.equal(rootKeyViolations(keyPins("dev-root-2026a"))[0]?.rule, "development-trust-anchor");
        assert.equal(rootKeyViolations(keyPins())[0]?.rule, "empty-trust-anchor");
        assert.equal(rootKeyViolations(keyPins("root-2026a", "dev-root-2026a")).length, 1);
        // And a clean pin still passes, so the variable changes nothing at all
        // rather than inverting the gate.
        assert.deepEqual(rootKeyViolations(keyPins("root-2026a", "root-2026b")), []);
    });
});

// ---------------------------------------------------------------- #440

// Cell G12 of docs/maintainers/case-tables/440-instructions.md. The gate's own
// repository-wide cases above already answer for the whole tree; this one is
// about the two modules #440 adds, and it quotes the thresholds from
// structure.mjs rather than restating them, so a raised ceiling moves this
// case with it.
test("G12: the instruction modules pass the gate at its declared thresholds", () =>
{
    const tree = diskTree(packageRoot);
    const added = ["src/instruction.ts", "src/instructions.ts"];
    for (const path of added)
    {
        assert.ok(tree.paths.includes(path), `${path} is not in the tree`);
        for (const span of functionSpans(parseSource(tree, path)))
        {
            assert.ok(span.lines <= maxFunctionLines,
                `${path}:${span.line} ${span.name} is ${span.lines} lines, over the ${maxFunctionLines}-line ceiling`);
        }
    }
    // The header states what an instruction is and who can write one. It is
    // the paragraph `skill.ts` carries for the same reason — this store is
    // synced, so a rule appended anywhere is read everywhere — and a reader
    // arriving at the module has to meet it before the code.
    const source = tree.read("src/instruction.ts");
    // Read as prose rather than as source: the paragraph is wrapped, so a
    // sentence of it spans two comment lines.
    const header = source.slice(0, source.indexOf("\nimport ")).replace(/^\s*\/\/ ?/gm, "").replace(/\s+/g, " ");
    assert.ok(header.includes("anyone who can append to this store can write one"), header);
    assert.ok(header.includes("It never runs a line an instruction names"), header);
    assert.ok(header.includes("it prints what the store holds"), header);
    assert.deepEqual(printingModules, [], "a module was added back to the print allowlist");
    assert.deepEqual(sanctionedEdges, [], "an import edge was sanctioned");
    const printing = new Set(printSiteViolations(tree).map((violation) => violation.file));
    assert.deepEqual(added.filter((path) => printing.has(path)), []);
    const crossing = importDirectionViolations(tree).map((violation) => violation.file);
    assert.deepEqual(added.filter((path) => crossing.includes(path)), []);
});

// Cell G15 of the same table. `instructions.ts` and `skill.ts` each held a
// byte-identical copy of the collector, under two names; one lives in
// `model.ts` now, which ARCHITECTURE.md names the owner of the store walks.
// The assertion is on the source text, the way this file asserts every other
// module fact: the point is that no second copy came back, which a behavioural
// test could not see.
test("G15: one `renderedIn` serves every surface, and no module keeps a copy", () =>
{
    const tree = diskTree(packageRoot);
    assert.match(tree.read("src/model.ts"), /^export function renderedIn\(models: ProjectModel\[\], viewer: string\)/m);
    for (const path of ["src/skill.ts", "src/instructions.ts"])
    {
        assert.doesNotMatch(tree.read(path), /function renderedIn\(/,
            `${path} declares a local renderedIn — the collector is model.ts's`);
    }
    assert.doesNotMatch(tree.read("src/instructions.ts"), /instructionsRenderedIn/);
    for (const path of ["src/skill.ts", "src/instruction.ts", "src/views.ts"])
    {
        const imported = tree.read(path).match(/import \{([^}]*)\} from "\.\/model\.js";/);
        assert.ok(imported !== null, `${path} imports nothing from model.js`);
        assert.ok(imported[1].split(",").map((name) => name.trim()).includes("renderedIn"),
            `${path} does not import the shared renderedIn`);
    }
});
