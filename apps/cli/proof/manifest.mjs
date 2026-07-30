// proof/manifest.mjs — the suite-to-source map and its enforcement.
//
// suites.json declares, for every suite, the proof files it executes. The
// declaration is judged against what the suite's own text actually references,
// so the map cannot rot in either direction: a file a suite starts using must
// be added, and a file it stops using must be removed. A proof file no suite
// maps is refused too — an unmapped suite would silently fall out of the
// sweep and out of the dev loop's partial runs.
//
// `node manifest.mjs` checks and exits non-zero with every violation named.
// `node manifest.mjs --print` emits the derived map, for authoring.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const proofDir = import.meta.dirname;

// The sweep's own machinery: not executed by any suite, so never a dependency.
const INFRA = new Set(["proof.sh", "run.mjs", "manifest.mjs", "suites.json"]);

export function loadManifest()
{
    return JSON.parse(readFileSync(join(proofDir, "suites.json"), "utf8"));
}

function proofFiles()
{
    const found = [];
    const walk = (dir) =>
    {
        for (const name of readdirSync(dir))
        {
            const path = join(dir, name);
            if (statSync(path).isDirectory())
            {
                walk(path);
            }
            else if (/\.(sh|mjs)$/.test(name))
            {
                found.push(relative(proofDir, path));
            }
        }
    };
    walk(proofDir);
    return found;
}

// Comment lines carry prose like "proven in overnight-digest.sh", which is a
// citation, not an execution — only stripped text counts as a reference.
function strippedText(path)
{
    const comment = path.endsWith(".sh") ? /(^|\s)#.*$/ : /(^|\s)\/\/.*$/;
    return readFileSync(join(proofDir, path), "utf8")
        .split("\n")
        .map((line) => line.replace(comment, "$1"))
        .join("\n");
}

// What a suite executes, read from its text: every proof file whose name
// appears outside a comment, in the entry or in anything already reachable.
function derivedDeps(entry, files)
{
    const basenames = new Map(files.map((file) => [file.split("/").pop(), file]));
    const reachable = new Set([entry]);
    const queue = [entry];
    while (queue.length > 0)
    {
        const text = strippedText(queue.shift());
        for (const [base, file] of basenames)
        {
            if (reachable.has(file) || INFRA.has(base))
            {
                continue;
            }
            if (new RegExp(`(?<![A-Za-z0-9-])${base.replaceAll(".", "\\.")}(?![A-Za-z0-9-])`).test(text))
            {
                reachable.add(file);
                queue.push(file);
            }
        }
    }
    reachable.delete(entry);
    return [...reachable].sort();
}

export function checkManifest(manifest)
{
    const files = proofFiles();
    const violations = [];
    const mapped = new Set();
    for (const [name, suite] of Object.entries(manifest.suites))
    {
        mapped.add(suite.entry);
        for (const dep of suite.deps)
        {
            mapped.add(dep);
        }
        const derived = derivedDeps(suite.entry, files);
        const declared = [...suite.deps].sort();
        for (const dep of derived.filter((d) => !declared.includes(d)))
        {
            violations.push(`suite ${name} executes ${dep} but the map does not carry it`);
        }
        for (const dep of declared.filter((d) => !derived.includes(d)))
        {
            violations.push(`the map claims ${dep} for suite ${name} but nothing in the suite executes it`);
        }
    }
    for (const file of files)
    {
        if (!mapped.has(file) && !INFRA.has(file.split("/").pop()))
        {
            violations.push(`${file} is in proof/ but in no suite's map — an unmapped proof runs nowhere`);
        }
    }
    return violations;
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (invokedDirectly)
{
    if (process.argv.includes("--print"))
    {
        const files = proofFiles();
        const manifest = loadManifest();
        const derived = {};
        for (const [name, suite] of Object.entries(manifest.suites))
        {
            derived[name] = { entry: suite.entry, deps: derivedDeps(suite.entry, files) };
        }
        process.stdout.write(JSON.stringify({ suites: derived }, null, 4) + "\n");
    }
    else
    {
        const violations = checkManifest(loadManifest());
        if (violations.length > 0)
        {
            console.error(violations.join("\n"));
            process.exit(1);
        }
    }
}
