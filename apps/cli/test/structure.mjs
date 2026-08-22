// The structure rules ARCHITECTURE.md and CONTRIBUTING.md state in prose, run
// as a check (#90). Four sections: import direction across the whole tree,
// function length on the diff, print sites against the render gate, and
// dead-export count against the base commit.
//
// This file is not a test — `node --test test/*.test.mjs` does not pick it up.
// It is the library `structure.test.mjs` asserts against, and a command:
//
//   node test/structure.mjs [--base <ref>] [--max-lines N] [--json]
//
// Every analysis reads a tree rather than the filesystem, so the same code
// answers for the working copy, for a commit, and for a literal fixture. Paths
// are package-relative and posix throughout.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const packageRoot = fileURLToPath(new URL("..", import.meta.url));

// CONTRIBUTING.md states 20-30 lines and this is the enforced end of it. It
// began at 60 because the tree carried 49 functions above 30 and 5 above 60;
// issue #227 split all of them, so the check now holds the documented number.
export const maxFunctionLines = 30;

// A subsystem may import from another only along an edge listed here. It is
// empty on purpose: every edge ARCHITECTURE.md once sanctioned named code that
// decision 01kz2nczhtde554qx5tqpqzrt3 deleted on 2026-08-03.
export const sanctionedEdges = [];

// The render gate: the one module that may put a command's answer on stdout.
export const renderGate = "src/output.ts";

// The two modules that hold a live credential, and the modules that write,
// fold or sync a record. No import may cross from the second set to the first.
//
// This is the structural half of "a token never reaches the event log". The
// other half — login writing no event at all — is a property of one command and
// could be undone by a future one; this cannot, because there is no import path
// from a state writer to a credential for a future command to reach through.
// `sanitize.ts` catching a token is a backstop, not the guarantee.
export const credentialModules = ["src/credentials.ts", "src/rail.ts"];

export const stateWritingModules = [
    "src/ledger.ts", "src/pipeline.ts", "src/sanitize.ts", "src/logfile.ts",
    "src/fold.ts", "src/model.ts", "src/connect.ts", "src/sync.ts", "src/artifact.ts"
];

// The modules that still print for themselves. It was a ratchet through the
// five stages of the render-gate migration — a stage took a module off it, and
// taking one off was a single deleted line — and stage 5 emptied it. Nothing
// is ever added back: a module that has something to say returns it and the
// gate prints it. `console.error` is not this rule's subject, since a refusal
// goes to stderr and where it is written from is a separate question from
// where an answer is.
export const printingModules = [];

// dist/ still carries directories from that deleted code and would read as
// three subsystems. It is build output, not a source of truth.
const skippedDirectories = new Set(["node_modules", "dist", "fixtures"]);

const sourceDirectory = "src";
const readerDirectories = ["src", "test"];

// ---------------------------------------------------------------- trees

export function memoryTree(files)
{
    return { paths: Object.keys(files).sort(), read: (path) => files[path] };
}

export function diskTree(root)
{
    const walk = (directory) => readdirSync(join(root, directory)).flatMap((entry) =>
    {
        const path = directory ? posix.join(directory, entry) : entry;
        if (statSync(join(root, path)).isDirectory())
        {
            return skippedDirectories.has(entry) ? [] : walk(path);
        }
        return isSource(path) ? [path] : [];
    });
    return { paths: readerDirectories.flatMap(walk).sort(), read: (path) => readFileSync(join(root, path), "utf8") };
}

// `ls-tree` names paths from the repository root while the rest of the check
// speaks package-relative, so the package's own prefix is stripped here and
// `show` is asked with a `./` path, which git reads as relative to this root.
export function gitTree(ref, root)
{
    const prefix = git(["rev-parse", "--show-prefix"], root).trim();
    const listed = git(["ls-tree", "-r", "--name-only", ref, "--", ...readerDirectories], root);
    const paths = listed.split("\n")
        .filter((path) => path && isSource(path) && !skipped(path))
        .map((path) => (prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path));
    return { paths: paths.sort(), read: (path) => git(["show", `${ref}:./${path}`], root) };
}

// The suite is `.mjs` and reaches the CLI through its build output, so both
// have to be readable or every export only a test uses reads as dead.
function isSource(path)
{
    return (path.endsWith(".ts") && !path.endsWith(".d.ts")) || path.endsWith(".mjs");
}

function skipped(path)
{
    return path.split("/").some((segment) => skippedDirectories.has(segment));
}

function git(args, root)
{
    return execFileSync("git", ["-C", root ?? packageRoot, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// ---------------------------------------------------------------- parsing

export function parseSource(tree, path)
{
    return ts.createSourceFile(path, tree.read(path), ts.ScriptTarget.ES2022, true);
}

function lineOf(source, position)
{
    return source.getLineAndCharacterOfPosition(position).line + 1;
}

const functionKinds = new Set([
    ts.SyntaxKind.FunctionDeclaration,
    ts.SyntaxKind.FunctionExpression,
    ts.SyntaxKind.ArrowFunction,
    ts.SyntaxKind.MethodDeclaration,
    ts.SyntaxKind.Constructor,
    ts.SyntaxKind.GetAccessor,
    ts.SyntaxKind.SetAccessor
]);

function declaredName(node)
{
    if (node.name)
    {
        return node.name.getText();
    }
    const parent = node.parent;
    if (parent && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) && parent.name)
    {
        return parent.name.getText();
    }
    return "(anonymous)";
}

// A function's span starts at the statement that declares it, so an arrow
// assigned to a const is measured from the `const` — the line a reader sees.
function spanStart(node)
{
    let outer = node;
    while (outer.parent && (ts.isVariableDeclaration(outer.parent) || ts.isVariableDeclarationList(outer.parent) || ts.isVariableStatement(outer.parent)))
    {
        outer = outer.parent;
    }
    return outer.getStart();
}

// Only the outermost function-like node is measured. A closure inside one is
// already counted in its parent's lines; counting it again reports the same
// code twice.
export function functionSpans(source)
{
    const spans = [];
    let depth = 0;
    const visit = (node) =>
    {
        if (!functionKinds.has(node.kind))
        {
            ts.forEachChild(node, visit);
            return;
        }
        if (depth === 0)
        {
            const line = lineOf(source, spanStart(node));
            const endLine = lineOf(source, node.getEnd());
            spans.push({ name: declaredName(node), line, endLine, lines: endLine - line + 1 });
        }
        depth += 1;
        ts.forEachChild(node, visit);
        depth -= 1;
    };
    ts.forEachChild(source, visit);
    return spans;
}

function isExported(node)
{
    return (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0;
}

function boundNames(name)
{
    return ts.isIdentifier(name) ? [name.getText()] : name.elements.flatMap((element) => (element.name ? boundNames(element.name) : []));
}

export function exportedNames(source)
{
    return source.statements.flatMap((statement) =>
    {
        if (ts.isVariableStatement(statement))
        {
            return isExported(statement.declarationList.declarations[0])
                ? statement.declarationList.declarations.flatMap((declaration) => boundNames(declaration.name))
                : [];
        }
        // A re-export is an export of the re-exporting module too, and is dead
        // there when nothing imports it from there. `export *` names nothing
        // enumerable, so it contributes none — it only keeps its target alive.
        if (ts.isExportDeclaration(statement))
        {
            const clause = statement.exportClause;
            return clause && ts.isNamedExports(clause) ? clause.elements.map((element) => element.name.getText()) : [];
        }
        return statement.name && isExported(statement) ? [statement.name.getText()] : [];
    });
}

// Every way one module names another: static import, re-export, and `import()`.
// A dynamic or namespace reference names no members, so it keeps the whole
// module alive rather than guessing which export it reached for.
export function moduleReferences(source)
{
    const references = [];
    const record = (specifier, names, whole) =>
    {
        if (specifier && ts.isStringLiteral(specifier))
        {
            references.push({ specifier: specifier.text, names, whole, line: lineOf(source, specifier.getStart()) });
        }
    };
    const visit = (node) =>
    {
        if (ts.isImportDeclaration(node))
        {
            record(node.moduleSpecifier, namedImports(node.importClause), namespaceImport(node.importClause));
        }
        else if (ts.isExportDeclaration(node) && node.moduleSpecifier)
        {
            record(node.moduleSpecifier, reExportedNames(node.exportClause), !node.exportClause);
        }
        else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
        {
            record(node.arguments[0], [], true);
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
    return references;
}

function namedImports(clause)
{
    const bindings = clause?.namedBindings;
    return bindings && ts.isNamedImports(bindings) ? bindings.elements.map((element) => (element.propertyName ?? element.name).getText()) : [];
}

function namespaceImport(clause)
{
    return Boolean(clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings));
}

function reExportedNames(clause)
{
    return clause && ts.isNamedExports(clause) ? clause.elements.map((element) => (element.propertyName ?? element.name).getText()) : [];
}

// NodeNext source spells a sibling `./fold.js`; the file in the tree is
// `fold.ts`. The suite spells the same module `../dist/fold.js`, which is the
// build output of that one source file — resolving it there is what makes a
// test count as an importer. Resolution answers from the tree, never from
// disk, so a commit and a fixture resolve the same way.
export function resolveSpecifier(tree, fromPath, specifier)
{
    if (!specifier.startsWith("."))
    {
        return undefined;
    }
    const known = new Set(tree.paths);
    const base = posix.normalize(posix.join(posix.dirname(fromPath), specifier));
    const source = base.replace(/^dist\//, `${sourceDirectory}/`).replace(/\.js$/, ".ts");
    return [base.replace(/\.js$/, ".ts"), `${base}.ts`, posix.join(base, "index.ts"), source].find((candidate) => known.has(candidate));
}

// ---------------------------------------------------------------- rules

// A subsystem is a directory under src/. A file directly in src/ is core.
export function subsystemOf(path)
{
    const parts = path.split("/");
    return parts[0] === sourceDirectory && parts.length > 2 ? parts[1] : undefined;
}

function importDetail(fromPath, toPath)
{
    const from = subsystemOf(fromPath);
    const to = subsystemOf(toPath);
    if (!to || from === to)
    {
        return undefined;
    }
    if (from)
    {
        return sanctionedEdges.some((edge) => edge.from === from && edge.to === to)
            ? undefined
            : `subsystem ${from}/ imports from subsystem ${to}/ — no sanctioned edge`;
    }
    if (fromPath === `${sourceDirectory}/main.ts` && toPath === `${sourceDirectory}/${to}/commands.ts`)
    {
        return undefined;
    }
    return `core module imports from subsystem ${to}/ — only main.ts may import ${to}/commands.ts`;
}

export function importDirectionViolations(tree)
{
    return sourcesOf(tree).flatMap((path) => moduleReferences(parseSource(tree, path)).flatMap((reference) =>
    {
        const target = resolveSpecifier(tree, path, reference.specifier);
        const detail = target ? importDetail(path, target) : undefined;
        return detail ? [{ file: path, line: reference.line, rule: "import-direction", detail }] : [];
    }));
}

export function credentialIsolationViolations(tree)
{
    return stateWritingModules.filter((path) => tree.paths.includes(path)).flatMap((path) =>
        moduleReferences(parseSource(tree, path)).flatMap((reference) =>
        {
            const target = resolveSpecifier(tree, path, reference.specifier);
            return credentialModules.includes(target) ? [{
                file: path,
                line: reference.line,
                rule: "credential-isolation",
                detail: `${path} imports ${target} — a state writer must have no import path to a credential`
            }] : [];
        }));
}

export function functionLengthViolations(tree, changed, limit)
{
    return sourcesOf(tree).flatMap((path) =>
    {
        const touched = changed.get(path);
        if (!touched)
        {
            return [];
        }
        return functionSpans(parseSource(tree, path))
            .filter((span) => span.lines > limit && touches(touched, span))
            .map((span) => ({ file: path, line: span.line, rule: "function-length", detail: `${span.name} is ${span.lines} lines, over the ${limit}-line ceiling` }));
    });
}

function touches(touched, span)
{
    return touched.some((line) => line >= span.line && line <= span.endLine);
}

// Where a command's answer reaches stdout. A handler returns what it has to
// say and `output.ts` prints it, so a call to `console.log` or
// `process.stdout.write` anywhere else is a second print path — which is what
// made "what does a piped run print" a question with as many answers as there
// were call sites.
const printCalls = new Set(["console.log", "process.stdout.write"]);

// The one write outside the gate, declared in the rule rather than listed
// beside the migration's leftovers: `human.ts` puts the confirmation question
// on stdout without a newline and reads the typed reply on the same line. That
// is an interaction with a person, not a command's answer — there is no block
// to return, nothing for a handler to hand over, and no run in which the gate
// could render it, because the reply has to arrive before the command knows
// what it will answer at all.
export const interactionPrompt = "src/human.ts";

export function printSiteViolations(tree)
{
    const allowed = new Set([renderGate, interactionPrompt, ...printingModules]);
    return sourcesOf(tree).filter((path) => !allowed.has(path)).flatMap((path) =>
        printSites(parseSource(tree, path)).map((site) => ({
            file: path,
            line: site.line,
            rule: "print-site",
            detail: `${site.call} outside the render gate — return the output and let ${renderGate} print it`
        })));
}

function printSites(source)
{
    const sites = [];
    const visit = (node) =>
    {
        if (ts.isCallExpression(node) && printCalls.has(node.expression.getText()))
        {
            sites.push({ call: node.expression.getText(), line: lineOf(source, node.getStart()) });
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
    return sites;
}

// An export is alive when another file imports it by name, when a file
// namespace-imports or dynamically imports its module, or when it is
// re-exported. A test is an importer, so test/ reads count.
export function deadExports(tree)
{
    const named = new Map();
    const whole = new Set();
    for (const reader of tree.paths)
    {
        for (const reference of moduleReferences(parseSource(tree, reader)))
        {
            const target = resolveSpecifier(tree, reader, reference.specifier);
            if (!target || target === reader)
            {
                continue;
            }
            if (reference.whole)
            {
                whole.add(target);
            }
            named.set(target, (named.get(target) ?? new Set()));
            reference.names.forEach((name) => named.get(target).add(name));
        }
    }
    return sourcesOf(tree).flatMap((path) => (whole.has(path)
        ? []
        : exportedNames(parseSource(tree, path))
            .filter((name) => !named.get(path)?.has(name))
            .map((name) => ({ file: path, name }))));
}

function sourcesOf(tree)
{
    return tree.paths.filter((path) => path.startsWith(`${sourceDirectory}/`));
}

// ---------------------------------------------------------------- the diff

// A check with no base silently passes everything, which reads as a clean
// repository. Every way of not having one refuses instead, and names the fix.
export function resolveBase(explicit, root)
{
    if (git(["rev-parse", "--is-shallow-repository"], root).trim() === "true")
    {
        throw new Error("the repository is a shallow clone, so there is no base to diff against — set fetch-depth: 0 on the checkout step");
    }
    const named = explicit ?? process.env.STRUCTURE_BASE;
    if (named)
    {
        return mergeBase(named, root) ?? fail(`no merge base between ${named} and HEAD`);
    }
    return mergeBase("origin/main", root) ?? mergeBase("main", root) ?? fail("no origin/main or main to diff against — pass --base <ref> or set STRUCTURE_BASE");
}

function mergeBase(ref, root)
{
    try
    {
        return git(["merge-base", ref, "HEAD"], root).trim() || undefined;
    }
    catch
    {
        return undefined;
    }
}

function fail(message)
{
    throw new Error(message);
}

// Added and modified lines, numbered in the head revision. A pure rename
// produces no hunks, so moving a file does not report every function in it.
export function changedLines(base, root)
{
    const diff = git(["diff", "-U0", "--relative", "-M", base, "--", ...readerDirectories], root);
    const changed = new Map();
    let path;
    for (const line of diff.split("\n"))
    {
        const header = /^\+\+\+ b\/(.+)$/.exec(line);
        if (header)
        {
            path = header[1];
            continue;
        }
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (hunk && path)
        {
            const start = Number(hunk[1]);
            const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
            const lines = changed.get(path) ?? [];
            for (let n = start; n < start + count; n += 1)
            {
                lines.push(n);
            }
            changed.set(path, lines);
        }
    }
    return changed;
}

// ---------------------------------------------------------------- report

export function runStructure(options = {})
{
    const root = options.root ?? packageRoot;
    const limit = options.limit ?? maxFunctionLines;
    const head = options.tree ?? diskTree(root);
    const base = options.base ?? resolveBase(options.baseRef, root);
    const changed = options.changed ?? changedLines(base, root);
    const dead = deadExports(head);
    const deadBefore = deadExports(gitTree(base, root)).length;
    return {
        base,
        limit,
        violations: [
            ...importDirectionViolations(head),
            ...credentialIsolationViolations(head),
            ...functionLengthViolations(head, changed, limit),
            ...printSiteViolations(head)
        ],
        dead,
        deadBefore,
        deadGrowth: dead.length - deadBefore
    };
}

export function formatReport(result)
{
    const lines = [`structure: base ${result.base.slice(0, 12)}, function ceiling ${result.limit} lines`];
    for (const violation of result.violations)
    {
        lines.push(`${violation.file}:${violation.line} ${violation.rule} — ${violation.detail}`);
    }
    lines.push(`dead exports: ${result.dead.length} (base ${result.deadBefore}, ${signed(result.deadGrowth)})`);
    if (result.deadGrowth > 0)
    {
        result.dead.forEach((entry) => lines.push(`${entry.file} dead-export — ${entry.name} has no importer`));
    }
    return lines.join("\n");
}

function signed(count)
{
    return count > 0 ? `+${count}` : `${count}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
{
    const argv = process.argv.slice(2);
    const option = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
    try
    {
        const result = runStructure({ baseRef: option("--base"), limit: option("--max-lines") ? Number(option("--max-lines")) : undefined });
        process.stdout.write(argv.includes("--json") ? `${JSON.stringify(result, null, 2)}\n` : `${formatReport(result)}\n`);
        process.exit(result.violations.length === 0 && result.deadGrowth <= 0 ? 0 : 1);
    }
    catch (error)
    {
        process.stderr.write(`structure: ${error.message}\n`);
        process.exit(2);
    }
}
