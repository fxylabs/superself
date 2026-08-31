// The package reads events. Nothing else.
//
// The split exists so a server can fold the same log this CLI folds, and that
// only holds while the calculation depends on the log and on its arguments.
// The dependency this rule is really about is the one that arrives without
// anybody deciding to add it: `style.ts` in the CLI reads `process.stdout.isTTY`
// at module load, so merely importing it decides how a machine renders — and a
// fold that imported it would have carried a terminal's opinion into a server.
//
// So: no filesystem, no process, no clock of the module's own, and nothing at
// all that runs when the module is loaded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import ts from "typescript";

const sourceDir = fileURLToPath(new URL("../src", import.meta.url));
const sources = readdirSync(sourceDir).filter((name) => name.endsWith(".ts")).sort();

const read = (name) => readFileSync(join(sourceDir, name), "utf8");

test("the package has sources to check", () =>
{
    assert.ok(sources.length > 5, `only ${sources.length} sources found — the walk is looking in the wrong place`);
});

// What a machine is, spelled as the ways one is reached. `Date.now()` and
// `new Date()` are on it for the same reason the filesystem is: the fold takes
// the instant it is read at as an argument, and a module that asks the clock
// itself answers two callers differently for one log.
const FORBIDDEN = [
    [/from "node:/, "imports a node builtin"],
    [/\bprocess\s*\./, "reads `process`"],
    [/\bDate\.now\s*\(/, "reads the clock instead of taking `now` as an argument"],
    [/\bnew Date\s*\(\s*\)/, "reads the clock instead of taking `now` as an argument"],
    [/\bMath\.random\s*\(/, "is not a function of its arguments"]
];

test("no source reaches a machine", () =>
{
    const found = sources.flatMap((name) => read(name).split("\n").flatMap((line, at) =>
        FORBIDDEN.filter(([pattern]) => pattern.test(stripComment(line)))
            .map(([, why]) => `src/${name}:${at + 1} ${why} — ${line.trim()}`)));
    assert.deepEqual(found, []);
});

// A trailing comment is code with prose after it, so only a whole-line comment
// is dropped: this rule is about what a module does, and a sentence naming
// `process.env` is not doing it.
function stripComment(line)
{
    return line.trimStart().startsWith("//") ? "" : line;
}

// The imports the package makes, and the whole list: its own siblings. A
// relative path that climbs out of `src/` would reach the CLI, and a bare
// specifier would be a dependency this package does not declare.
test("no source imports anything outside the package", () =>
{
    const specifiers = sources.flatMap((name) =>
        [...read(name).matchAll(/(?:^|\n)(?:import|export)[^;\n]*?from\s+"([^"]+)"/g)]
            .map((found) => `src/${name} → ${found[1]}`));
    assert.deepEqual(specifiers.filter((entry) => !/→ \.\/[a-z]+\.js$/.test(entry)), []);
});

// Module load must do nothing but declare. The whole of what a source may say
// at the top level is a declaration — an import, an export, a type, a function,
// a class, or a binding whose value is a literal — because anything else is
// code that runs on import, which is the failure this file is named after.
//
// Read from the syntax tree rather than by line, because that is the difference
// between "no call at the top level" and "no line that looks like one".
const declarations = new Set([
    ts.SyntaxKind.ImportDeclaration,
    ts.SyntaxKind.ExportDeclaration,
    ts.SyntaxKind.InterfaceDeclaration,
    ts.SyntaxKind.TypeAliasDeclaration,
    ts.SyntaxKind.FunctionDeclaration,
    ts.SyntaxKind.ClassDeclaration,
    ts.SyntaxKind.EnumDeclaration
]);

test("nothing runs when a module is loaded", () =>
{
    const found = sources.flatMap((name) =>
    {
        const source = ts.createSourceFile(name, read(name), ts.ScriptTarget.ES2022, true);
        return source.statements.flatMap((statement) => loadTimeWork(source, name, statement));
    });
    assert.deepEqual(found, []);
});

// A binding is a declaration while its value is one. `new Set([...])` is a
// constant table and stays; a call is work, wherever in the initializer it sits
// — `new Set(Object.keys(x))` is the shape that would slip past a check on the
// outermost node alone, and it is also the shape that reads a machine.
function loadTimeWork(source, name, statement)
{
    const at = `src/${name}:${source.getLineAndCharacterOfPosition(statement.getStart()).line + 1}`;
    if (declarations.has(statement.kind))
    {
        return [];
    }
    if (!ts.isVariableStatement(statement))
    {
        return [`${at} runs at module load — ${ts.SyntaxKind[statement.kind]}`];
    }
    return calls(statement).map((call) => `${at} calls ${call} at module load`);
}

// A call inside a function the binding holds is deferred, not load-time work:
// `STATEMENT_TYPES` is a table of readers and every one of them is called by
// whoever reads the table. So the walk stops at a function body.
const deferred = new Set([
    ts.SyntaxKind.ArrowFunction,
    ts.SyntaxKind.FunctionExpression,
    ts.SyntaxKind.MethodDeclaration,
    ts.SyntaxKind.GetAccessor,
    ts.SyntaxKind.SetAccessor
]);

function calls(node)
{
    const found = [];
    const visit = (child) =>
    {
        if (deferred.has(child.kind))
        {
            return;
        }
        if (ts.isCallExpression(child))
        {
            found.push(child.expression.getText());
        }
        ts.forEachChild(child, visit);
    };
    ts.forEachChild(node, visit);
    return found;
}
