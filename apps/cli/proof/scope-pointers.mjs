// The source half of the scope guard: no render may name a project-scoped read
// verb in a pointer that never reaches `scoped()`, and no verb without a scope
// form may be named without `fromCheckout()`.
//
// This is structural rather than a line grep. The grep it replaces accepted a
// literal because some option, or the word `scope-exempt`, appeared anywhere on
// its line, so a bare pointer beside a scoped one passed and a future exemption
// could be minted by writing a comment (#165 review round 3). Here each literal
// is judged by the call expression it actually sits in, and the only exemptions
// are the two workspace helpers named below.
//
// Run: node proof/scope-pointers.mjs [srcDir]

import { readFileSync } from "node:fs";
import { join } from "node:path";

// A pointer inside one of these functions names the workspace, not a project:
// `self status` there IS the command being pointed at. Named one by one, so a
// third exemption cannot appear without being written here — and a name that
// stops holding an exempt pointer is reported too, rather than lingering as a
// hole nobody re-reads.
const EXEMPT = [
    { file: "views.ts", fn: "workspaceContextLine" },
    { file: "views.ts", fn: "workspaceOmission" }
];

const FILES = ["pretty.ts", "views.ts"];

// `self work accept`, `self decide confirm` and `self attempt show` are absent
// on purpose: a write and a machine-local read have no --project form, so they
// are not pointers this rule speaks about. The lookaheads are what keep them
// out: `self work` counts only when the literal ends there or a flag follows,
// so `self work accept ${id}` is a different string, not a bare pointer.
//
// The scan starts at the quote and reads forward, rather than carving the file
// into literals first. A literal nested in a template — `${"self work"}` — is
// invisible to the second approach, and a reverted scoped() call landed in
// exactly that shape while the guard reported OK.
const VERB = [
    "work show [^\"'`]*",
    "work(?=[\"'`]|\\s--)",
    "status(?=[\"'`]|\\s--)",
    "objective(?=[\"'`]|\\s--)",
    "milestone(?=[\"'`]|\\s--)",
    "context(?=[\"'`]|\\s--)",
    "log(?=[\"'`]|\\s--)",
    "search [^\"'`]*"
].join("|");
const POINTER = new RegExp(`["'\`](self (?:${VERB}))`, "g");
const CHECKOUT_POINTER = /["'`](self integration plan)/g;

function stripComments(source)
{
    return source
        .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
        .replace(/(^|[^:])\/\/[^\n]*/g, (match, lead) => lead + " ".repeat(match.length - lead.length));
}

// The call expression a literal sits inside: its callee name and its full text.
// Walking the parentheses is what makes this structural — `scoped("self work",
// project)` and `countedOmission(…, "self integration plan", fromCheckout(p))`
// are both answered correctly, and a literal that reaches neither helper has
// nowhere to hide.
function enclosingCall(source, index)
{
    let depth = 0;
    let open = index;
    while (open > 0)
    {
        const character = source[open];
        if (character === ")")
        {
            depth += 1;
        }
        else if (character === "(")
        {
            if (depth === 0)
            {
                break;
            }
            depth -= 1;
        }
        open -= 1;
    }
    let close = open;
    let inside = 0;
    for (; close < source.length; close += 1)
    {
        if (source[close] === "(")
        {
            inside += 1;
        }
        else if (source[close] === ")")
        {
            inside -= 1;
            if (inside === 0)
            {
                break;
            }
        }
    }
    const before = source.slice(0, open);
    return { callee: (before.match(/([A-Za-z0-9_$.]+)$/) ?? ["", ""])[1], text: source.slice(open, close + 1) };
}

function enclosingFunction(source, index)
{
    const before = source.slice(0, index);
    const names = [...before.matchAll(/function\s+([A-Za-z0-9_$]+)\s*\(/g)];
    return names.length === 0 ? "" : names[names.length - 1][1];
}

function lineOf(source, index)
{
    return source.slice(0, index).split("\n").length;
}

const srcDir = process.argv[2] ?? join(import.meta.dirname, "..", "src");
const offenders = [];
const exempted = new Set();

for (const file of FILES)
{
    const source = stripComments(readFileSync(join(srcDir, file), "utf8"));
    const seen = [];
    for (const match of source.matchAll(POINTER))
    {
        seen.push({ text: match[1], index: match.index + 1, checkout: false });
    }
    for (const match of source.matchAll(CHECKOUT_POINTER))
    {
        seen.push({ text: match[1], index: match.index + 1, checkout: true });
    }
    for (const pointer of seen)
    {
        const fn = enclosingFunction(source, pointer.index);
        const where = `${file}:${lineOf(source, pointer.index)} (${fn}) "${pointer.text}"`;
        if (EXEMPT.some((item) => item.file === file && item.fn === fn))
        {
            exempted.add(`${file}:${fn}`);
            continue;
        }
        const call = enclosingCall(source, pointer.index);
        // A scopable pointer must be handed to scoped(); a verb with no scope
        // form must be accompanied by fromCheckout() in the same call. A
        // pointer that already spells --project itself is naming the project
        // directly, which is what the rule asks for.
        const named = pointer.text.includes("--project ${") || pointer.text.includes("--project '");
        if (pointer.checkout)
        {
            if (!call.text.includes("fromCheckout("))
            {
                offenders.push(`${where} — names no checkout through fromCheckout()`);
            }
        }
        else if (call.callee !== "scoped" && !named)
        {
            offenders.push(`${where} — never reaches scoped()`);
        }
    }
}

// An allowlist nobody re-reads is the hole this check exists to close, so a
// name that no longer covers an exempt pointer is a failure of its own.
for (const item of EXEMPT)
{
    if (!exempted.has(`${item.file}:${item.fn}`))
    {
        offenders.push(`${item.file}:${item.fn} is allowlisted but holds no exempt pointer — drop it from EXEMPT`);
    }
}

if (offenders.length > 0)
{
    console.error("scope-pointers FAILED:\n  " + offenders.join("\n  "));
    process.exit(1);
}
console.log("scope-pointers OK");
