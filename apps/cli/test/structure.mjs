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

// The three modules that hold a live credential or the trust anchor's cache,
// and the modules that write, fold or sync a record. No import may cross from
// the second set to the first.
//
// This is the structural half of "a token never reaches the event log". The
// other half — login writing no event at all — is a property of one command and
// could be undone by a future one; this cannot, because there is no import path
// from a state writer to a credential for a future command to reach through.
// `sanitize.ts` catching a token is a backstop, not the guarantee.
export const credentialModules = ["src/credentials.ts", "src/rail.ts", "src/trust.ts"];

// The pinned trust anchors, and the two things that must never be true of a
// published build: that it pins **no** root at all, and that a root it pins is
// one whose private half is committed in this repository.
//
// Both are the same defect seen from either side. With no pinned root a
// published CLI can accept no key list and therefore no plugin — it is broken
// rather than dangerous, but it is not shippable. With a `dev-` root pinned it
// accepts a key list anyone holding the fixture can sign, and a key list can
// name any release key it likes, so that CLI will run a plugin anyone on earth
// signed.
//
// A comment saying "replace this" is not a gate; this is, and it has **no**
// opt-out. An environment variable that skipped it would live on the publish
// path itself, where one `export` in the shell that runs `npm publish` is the
// entire distance between the gate and a released CLI that trusts a key
// everybody has — and a gate one variable disarms is a comment with an exit
// code. Nothing else needs one: `npm run build`, `npm test` and
// `npm run structure` never call this, so a development build has nothing to
// opt out of.
export const rootKeysModule = "src/rootkeys.ts";

// Deliberately NOT part of `runStructure`. This branch legitimately pins only
// the development root while the ceremony of design §1.4c has not been
// performed, so folding it into the everyday gate would mean a red build for a
// state that is correct today. It gates the one act that would actually ship it
// — `npm publish`, through `prepublishOnly` — which is where the mistake it
// prevents is made.
export function rootKeyViolations(tree)
{
    if (!tree.paths.includes(rootKeysModule))
    {
        return [violation("missing-trust-anchor", "there is no pinned root key module to publish against")];
    }
    const kids = [...tree.read(rootKeysModule).matchAll(/kid:\s*"([^"]+)"/g)].map((found) => found[1]);
    if (kids.length === 0)
    {
        return [violation("empty-trust-anchor",
            "no root key is pinned, so this build can accept no plugin key list — "
            + "run the root ceremony and pin root-2026a and root-2026b")];
    }
    // Every pinned `dev-` root is a violation, not only a set made of nothing
    // but them. A real root mixed with a development one still ships a CLI that
    // accepts a key list anyone holding the fixture can sign — the presence of
    // the real root does not withdraw the development root's trust.
    return kids.filter((kid) => kid.startsWith("dev-")).map((kid) => violation("development-trust-anchor",
        `"${kid}" is a development root whose private half is a test fixture — `
        + "run the root ceremony and replace it before publishing"));
}

function violation(rule, detail)
{
    return { file: rootKeysModule, line: 1, rule, detail };
}

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

function testsOf(tree)
{
    return tree.paths.filter((path) => path.startsWith("test/") && path.endsWith(".mjs"));
}

// ------------------------------------------------- one invocation's state

// The entry point that forgets everything one command remembered, and the
// module it lives in. Every module-level cache in src/ has to be reachable from
// it — a cache that is not is one a second `runCli` in the same process would
// answer from, which is how a suite driving the CLI in-process (#371) turns a
// stale probe into a test that fails for no reason a reader can see.
export const invocationEntry = { file: "src/main.ts", name: "resetInvocation" };

// State that is deliberately not reset, and why. Three kinds and no others:
// something a test injects and puts back itself, something the dispatcher
// registers once at module load and never changes, and something every use of
// it sets before reading.
export const invocationStateExemptions = [
    { file: "src/credentials.ts", name: "clock", why: "injected by useClock, and the injector restores it" },
    { file: "src/human.ts", name: "typed", why: "injected by useTypedAnswer, and the injector restores it" },
    { file: "src/rail.ts", name: "backoff", why: "injected by useBackoff, and the injector restores it" },
    { file: "src/aliases.ts", name: "reservedVerbs", why: "registered once at module load by main.ts, identical for every invocation" },
    { file: "src/aliases.ts", name: "pluginClaims", why: "registered once at module load by main.ts, identical for every invocation" },
    { file: "src/app.ts", name: "builtinVerbs", why: "registered once at module load by main.ts, identical for every invocation" },
    { file: "src/app.ts", name: "aliasClaims", why: "registered once at module load by main.ts, identical for every invocation" },
    { file: "src/retirement.ts", name: "retiringLeaves", why: "marks command declarations at module load; there is nothing per-invocation in it" },
    { file: "src/view.ts", name: "LANG", why: "writeViews sets all three from the store config before any render reads them" },
    { file: "src/view.ts", name: "THEME", why: "writeViews sets all three from the store config before any render reads them" },
    { file: "src/view.ts", name: "USER_THEME", why: "writeViews sets all three from the store config before any render reads them" }
];

const collectionKinds = new Set(["Map", "Set", "WeakMap", "WeakSet"]);

// What counts as state a command can leave behind: a top-level binding that can
// be reassigned, and a top-level collection created empty. A `new Set([...])`
// with contents is a constant table — `RETRYABLE_STATUS`, `LOCAL_HOSTS` — and a
// `Record` constant or an array literal is not a collection at all, so none of
// them is this rule's subject and none needs an exemption.
export function moduleState(source)
{
    return source.statements.filter(ts.isVariableStatement).flatMap((statement) =>
    {
        const mutable = (statement.declarationList.flags & ts.NodeFlags.Const) === 0;
        return statement.declarationList.declarations
            .filter((declaration) => ts.isIdentifier(declaration.name) && (mutable || emptyCollection(declaration.initializer)))
            .map((declaration) => ({ name: declaration.name.getText(), line: lineOf(source, declaration.getStart()) }));
    });
}

function emptyCollection(initializer)
{
    return Boolean(initializer) && ts.isNewExpression(initializer)
        && collectionKinds.has(initializer.expression.getText())
        && (initializer.arguments ?? []).length === 0;
}

export function invocationStateViolations(tree)
{
    const reset = resetReach(tree);
    const exempt = new Set(invocationStateExemptions.map((entry) => `${entry.file}#${entry.name}`));
    return sourcesOf(tree).flatMap((path) => moduleState(parseSource(tree, path))
        .filter((state) => !reset.has(`${path}#${state.name}`) && !exempt.has(`${path}#${state.name}`))
        .map((state) => ({
            file: path,
            line: state.line,
            rule: "invocation-state",
            detail: `${state.name} outlives one invocation — clear it from ${invocationEntry.name}(), or name it in invocationStateExemptions with the reason it needs no reset`
        })));
}

// Every module-level name written by anything `resetInvocation` reaches, found
// by following calls from it until nothing new turns up. Written means assigned
// or `.clear()`ed, which is the whole vocabulary the resets use.
function resetReach(tree)
{
    const cleared = new Set();
    const seen = new Set();
    const queue = [[invocationEntry.file, invocationEntry.name]];
    while (queue.length > 0)
    {
        const [path, name] = queue.pop();
        if (seen.has(`${path}#${name}`) || !tree.paths.includes(path))
        {
            continue;
        }
        seen.add(`${path}#${name}`);
        const source = parseSource(tree, path);
        const body = topLevelFunctions(source).get(name);
        if (body !== undefined)
        {
            writesIn(body).forEach((written) => cleared.add(`${path}#${written}`));
            callsIn(body).forEach((called) => queue.push(...targetsOf(tree, path, source, called)));
        }
    }
    return cleared;
}

function targetsOf(tree, path, source, called)
{
    if (topLevelFunctions(source).has(called))
    {
        return [[path, called]];
    }
    const imported = importBindings(tree, path, source).get(called);
    return imported === undefined ? [] : [[imported.target, imported.exported]];
}

export function topLevelFunctions(source)
{
    const found = new Map();
    for (const statement of source.statements)
    {
        if (ts.isFunctionDeclaration(statement) && statement.name)
        {
            found.set(statement.name.getText(), statement);
        }
        if (ts.isVariableStatement(statement))
        {
            statement.declarationList.declarations
                .filter((declaration) => ts.isIdentifier(declaration.name) && isFunctionLike(declaration.initializer))
                .forEach((declaration) => found.set(declaration.name.getText(), declaration.initializer));
        }
    }
    return found;
}

function isFunctionLike(node)
{
    return Boolean(node) && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

// Local name to the module and exported name behind it, so a call can be
// followed across a file boundary the way a reader follows the import line.
export function importBindings(tree, path, source)
{
    const bound = new Map();
    for (const statement of source.statements)
    {
        const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined;
        const target = bindings && ts.isNamedImports(bindings) ? resolveSpecifier(tree, path, statement.moduleSpecifier.text) : undefined;
        if (target)
        {
            bindings.elements.forEach((element) => bound.set(element.name.getText(),
                { target, exported: (element.propertyName ?? element.name).getText() }));
        }
    }
    return bound;
}

function writesIn(node)
{
    const written = [];
    const visit = (child) =>
    {
        if (ts.isBinaryExpression(child) && child.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(child.left))
        {
            written.push(child.left.getText());
        }
        if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression)
            && child.expression.name.getText() === "clear" && ts.isIdentifier(child.expression.expression))
        {
            written.push(child.expression.expression.getText());
        }
        ts.forEachChild(child, visit);
    };
    ts.forEachChild(node, visit);
    return written;
}

function callsIn(node)
{
    const called = [];
    const visit = (child) =>
    {
        if (ts.isCallExpression(child) && ts.isIdentifier(child.expression))
        {
            called.push(child.expression.getText());
        }
        ts.forEachChild(child, visit);
    };
    ts.forEachChild(node, visit);
    return called;
}

// ------------------------------------------------- awaiting the driver

// The one file the check leaves alone, and why. `driver.test.mjs` owns the
// case that proves the runtime half of this defence, and that case starts a
// command deliberately without awaiting it. A check that refused it would be
// refusing its own evidence.
export const awaitedDriverExempt = ["test/driver.test.mjs"];

// Every test file that reaches the CLI through the harness. It was an explicit
// list while the migration ran, one file per commit; it is a predicate now, so
// a test file written next month is on it the day it is written rather than
// the day somebody remembers to add it.
export function awaitedTestFiles(tree)
{
    return testsOf(tree)
        .filter((path) => !awaitedDriverExempt.includes(path))
        .filter((path) => harnessNames(parseSource(tree, path)).length > 0);
}

// The harness exports that run a command. `spawnIn` and `mustSpawn` are
// deliberately absent: they start a child and are synchronous, which is the
// whole reason a cell that needs a real process says so by calling them.
export const driverExports = ["selfIn", "must", "demoWorkspace", "approvedIn", "drive"];

const HARNESS = "./harness.mjs";

export function awaitedDriverViolations(tree, files = awaitedTestFiles(tree))
{
    return files.filter((path) => tree.paths.includes(path))
        .flatMap((path) => driverCallViolations(tree, path, parseSource(tree, path)));
}

// A missing `await` is silent: the assertion runs before the command it is
// about. So the rule refuses anything it cannot follow rather than passing it —
// a wrapper has to be a plain binding whose body reaches a driver call, and a
// driver name used as a value has no call site this check could look at.
function driverCallViolations(tree, path, source)
{
    const seeds = seedSet(tree, path, source);
    if (seeds.size === 0)
    {
        return [];
    }
    const violations = reboundWrappers(path, source, seeds);
    const visit = (node) =>
    {
        if (ts.isIdentifier(node) && seeds.has(node.getText()))
        {
            violations.push(...siteViolation(path, source, node));
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
    return violations;
}

// A wrapper held in a binding that can be reassigned is one this check has no
// fixed body for: what it calls at one call site is not what it calls at the
// next.
function reboundWrappers(path, source, seeds)
{
    const found = [];
    const visit = (node) =>
    {
        if (ts.isVariableStatement(node) && (node.declarationList.flags & ts.NodeFlags.Const) === 0)
        {
            node.declarationList.declarations
                .filter((declaration) => ts.isIdentifier(declaration.name) && seeds.has(declaration.name.getText()))
                .forEach((declaration) => found.push(violation371(path, source, declaration.name, "untraceable-driver",
                    `${declaration.name.getText()} wraps a command runner in a binding that can be reassigned — declare it const, or inline the call`)));
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
    return found;
}

function siteViolation(path, source, name)
{
    const parent = name.parent;
    // `ground.self(…)`: the wrapper lives on an object, and the name at the
    // call site is the property's. It is checked exactly as a bare call is.
    if (ts.isPropertyAccessExpression(parent) && parent.name === name)
    {
        return ts.isCallExpression(parent.parent) && parent.parent.expression === parent
            ? awaitedOrNot(path, source, name, parent.parent)
            : [];
    }
    if (ts.isImportSpecifier(parent) || parent.name === name || ts.isShorthandPropertyAssignment(parent))
    {
        return [];
    }
    if (!(ts.isCallExpression(parent) && parent.expression === name))
    {
        return [violation371(path, source, name, "untraceable-driver",
            `${name.getText()} is used as a value, so this check cannot see where the command runs — call it directly`)];
    }
    return awaitedOrNot(path, source, name, parent);
}

function awaitedOrNot(path, source, name, call)
{
    if (!handedOver(call))
    {
        return [violation371(path, source, name, "awaited-driver",
            `${name.getText()} runs a command and its result is not awaited — put \`await\` in front of it`)];
    }
    return passedAlong(call) ? [violation371(path, source, name, "untraceable-driver",
        `${name.getText()} runs a command inside a callback handed to something else, which may never await it — `
        + "name the callback, or inline the call")] : [];
}

// A one-line arrow that runs a command and is handed to another function as an
// argument. Whether that function awaits it is not readable here, and a
// callback nobody awaits is the silent shape this whole check exists for. A
// case's own callback is the exception: the runner awaits it.
function passedAlong(call)
{
    const arrow = call.parent;
    if (!ts.isArrowFunction(arrow) || !ts.isCallExpression(arrow.parent))
    {
        return false;
    }
    const outer = arrow.parent.expression.getText();
    return !/^(test|it|describe)(\.|$)/.test(outer) && outer !== "Promise.all";
}

// Waited for here, or handed to a caller that will wait: `return`, an arrow's
// own expression body, or a `Promise.all` the caller awaits.
function handedOver(call)
{
    const parent = call.parent;
    if (ts.isAwaitExpression(parent) || ts.isReturnStatement(parent) || ts.isArrowFunction(parent))
    {
        return true;
    }
    const outer = ts.isArrayLiteralExpression(parent) ? parent.parent : parent;
    return ts.isCallExpression(outer) && outer.expression.getText() === "Promise.all";
}

function violation371(path, source, node, rule, detail)
{
    return { file: path, line: lineOf(source, node.getStart()), rule, detail };
}

// The driver names this file imported, plus every local binding that reaches
// one, until no more turn up. 32 files wrap the harness in a one-line local
// helper, and the wrapper's call sites are where the `await` is actually
// missing.
function seedSet(tree, path, source)
{
    const seeds = new Set(harnessNames(source));
    if (seeds.size === 0)
    {
        return seeds;
    }
    const named = namedFunctions(source);
    let grown = true;
    while (grown)
    {
        grown = false;
        named.forEach((body, name) =>
        {
            if (!seeds.has(name) && callsIn(body).some((called) => seeds.has(called)))
            {
                seeds.add(name);
                grown = true;
            }
        });
    }
    return seeds;
}

// Every named function in the file, at any depth. A wrapper written inside a
// case's own callback wraps the driver exactly as a file-level one does, and
// leaving it out is how the check would pass a file whose calls are all behind
// one. Names are taken as written, so a name reused in two scopes is followed
// as one — which over-reports rather than under-reports.
export function namedFunctions(source)
{
    const found = new Map();
    const visit = (node) =>
    {
        if (ts.isFunctionDeclaration(node) && node.name)
        {
            found.set(node.name.getText(), node);
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isFunctionLike(node.initializer))
        {
            found.set(node.name.getText(), node.initializer);
        }
        // A wrapper kept on an object — `{ self: (args) => selfIn(…) }` — is
        // reached as `ground.self(…)`, and the name on the property is the name
        // at the call site.
        if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && isFunctionLike(node.initializer))
        {
            found.set(node.name.getText(), node.initializer);
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
    return found;
}

function harnessNames(source)
{
    const named = source.statements.flatMap((statement) =>
    {
        const bindings = ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === HARNESS
            ? statement.importClause?.namedBindings
            : undefined;
        return bindings && ts.isNamedImports(bindings) ? [...bindings.elements] : [];
    });
    return [...named, ...lazyHarnessNames(source)]
        .filter((element) => driverExports.includes((element.propertyName ?? element.name).getText()))
        .map((element) => element.name.getText());
}

// The three files that set `isTTY` above their imports load the harness with
// `await import(…)` instead, so the names arrive in a destructuring pattern. A
// file that reaches the driver is read by this rule however it spells the
// import — otherwise the only files it skips are the ones that took the
// unusual route.
function lazyHarnessNames(source)
{
    const found = [];
    const visit = (node) =>
    {
        if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)
            && node.initializer && node.initializer.getText().includes(HARNESS))
        {
            found.push(...node.name.elements);
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
    return found;
}

// A test file's cases run one after another, and the in-process driver relies
// on it: it swaps `process.env`, the working directory and the console for the
// length of a call. `{ concurrency: true }` would overlap two of them.
export function testConcurrencyViolations(tree)
{
    return testsOf(tree).flatMap((path) =>
    {
        const source = parseSource(tree, path);
        return concurrencyOptions(source).map((line) => ({
            file: path,
            line,
            rule: "test-concurrency",
            detail: "a concurrency option overlaps two cases, and the in-process CLI driver owns process-wide state for the length of a call"
        }));
    });
}

function concurrencyOptions(source)
{
    const found = [];
    const visit = (node) =>
    {
        if (ts.isPropertyAssignment(node) && node.name.getText() === "concurrency")
        {
            found.push(lineOf(source, node.getStart()));
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
    return found;
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
            ...printSiteViolations(head),
            ...invocationStateViolations(head),
            ...awaitedDriverViolations(head),
            ...testConcurrencyViolations(head)
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
