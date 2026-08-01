// The three evidence verbs and nothing else: this file routes and reports, and
// the deciding happens in manifest.ts, compile.ts and verify.ts. Nothing here
// appends an event — compiling evidence is a read of project state, so a bundle
// that was never wanted leaves the store exactly as it was.

import { existsSync, writeFileSync } from "node:fs";
import { parseCommand, subcommand } from "../args.js";
import { requireWorkspace } from "../paths.js";
import { RENDER_OPTIONS, resolveRender } from "../pretty.js";
import { sha256 } from "../repo.js";
import { bold, dim, fitDisplay, oneLine, padDisplay, termWidth } from "../style.js";
import { CliError } from "../types.js";
import { Canonical, canonicalBytes } from "./canonical.js";
import { Bundle, compileBundle, pinnedManifest } from "./compile.js";
import { readManifestFile } from "./manifest.js";
import { divergenceRefusal, readBundleFile, verifyBundle } from "./verify.js";

const USAGE = "usage: self evidence compile <manifest> [--out <name>] [--pin] | verify <bundle> | show <bundle>";

export function runEvidenceCommand(rest: string[]): void
{
    switch (subcommand("evidence", rest))
    {
        case "compile": cmdCompile(rest); return;
        case "verify": cmdVerify(rest); return;
        case "show": cmdShow(rest); return;
        default: throw new CliError(USAGE);
    }
}

function cmdCompile(rest: string[]): void
{
    const { values, positionals } = parseCommand("evidence", rest, { out: { type: "string" }, pin: { type: "boolean" } }, 2);
    const file = required(positionals[1], "evidence compile <manifest> [--out <name>] [--pin]");
    const ctx = requireWorkspace(process.cwd());
    const manifest = readManifestFile(file);
    const input = { storeDir: ctx.storeDir, manifest, from: process.cwd() };
    if (values.pin === true)
    {
        const pinned = pinnedManifest(input);
        write(values.out ?? `${manifest.project}-pinned.manifest.json`, pinned);
        return;
    }
    const bundle = compileBundle(input);
    write(values.out ?? `${manifest.project}-evidence-${String(bundle.digest).slice(0, 12)}.json`, bundle);
}

function cmdVerify(rest: string[]): void
{
    const [, file] = parseCommand("evidence", rest, {}, 2).positionals;
    const wanted = required(file, "evidence verify <bundle>");
    const ctx = requireWorkspace(process.cwd());
    const bundle = readBundleFile(wanted);
    const found = verifyBundle(bundle, { storeDir: ctx.storeDir, from: process.cwd() });
    if (found.length > 0)
    {
        throw new CliError(divergenceRefusal(wanted, found));
    }
    const sources = Array.isArray(bundle.sources) ? bundle.sources.length : 0;
    console.log(`${wanted} verifies — digest ${String(bundle.digest).slice(0, 12)}, ${sources} source(s) still hash as recorded`);
}

function cmdShow(rest: string[]): void
{
    const { values, positionals } = parseCommand("evidence", rest, { ...RENDER_OPTIONS }, 2);
    const file = required(positionals[1], "evidence show <bundle>");
    const bundle = readBundleFile(file);
    const pretty = resolveRender(values) === "pretty";
    for (const line of renderBundle(bundle, pretty))
    {
        console.log(line);
    }
}

/* ── output ────────────────────────────────────────────────────────── */

// `--out` takes a name, never a path: a bundle is declared by the name it is
// known as, the same way every artifact in this repository is, and a name that
// could reach out of the working directory would make that declaration a lie.
function write(name: string, value: Canonical): void
{
    requireName(name);
    if (existsSync(name))
    {
        throw new CliError(`"${name}" already exists — evidence output never overwrites, so move it aside or pass a different --out name`);
    }
    const bytes = canonicalBytes(value);
    writeFileSync(name, bytes, "utf8");
    console.log(JSON.stringify({ name, sha256: sha256(bytes), bytes: Buffer.byteLength(bytes, "utf8") }));
}

function requireName(name: string): void
{
    if (name.includes("/") || name.includes("\\") || name === "." || name === "..")
    {
        throw new CliError(`--out "${name}" is a path — pass the file name the bundle is known as, and run the command where it should land`);
    }
}

function required(value: string | undefined, usage: string): string
{
    if (value === undefined || value.trim() === "")
    {
        throw new CliError(`usage: self ${usage}`);
    }
    return value;
}

/* ── show ──────────────────────────────────────────────────────────── */

// Both renders carry the same rows; the pretty one only paints and pads them.
// Widths are measured in terminal cells, never in string length, so a Korean
// outcome does not push the column off the edge.
function renderBundle(bundle: Bundle, pretty: boolean): string[]
{
    const paint = (text: string): string => pretty ? bold(text) : text;
    const quiet = (text: string): string => pretty ? dim(text) : text;
    return [
        `${paint("bundle")} ${String(bundle.format)}  profile ${String(bundle.profile)}  digest ${quiet(String(bundle.digest).slice(0, 12))}`,
        ...renderPins(bundle, paint, quiet),
        ...renderSources(bundle, paint, quiet, pretty),
        ...renderFacts(bundle, paint, quiet, pretty),
        ...renderExclusions(bundle, paint)
    ];
}

type Paint = (text: string) => string;

function renderPins(bundle: Bundle, paint: Paint, quiet: Paint): string[]
{
    const pins = record(bundle.pins);
    const self = record(pins.self);
    const lines = [`${paint("pins")}  self ${quiet(String(self.head))}  log ${quiet(String(self.logSha256).slice(0, 12))}  events ${String(pins.eventCount)}`];
    for (const item of list(pins.git))
    {
        const pin = record(item);
        lines.push(`  ${String(pin.repo)} ${quiet(String(pin.commit).slice(0, 12))}`);
    }
    return lines;
}

function renderSources(bundle: Bundle, paint: Paint, quiet: Paint, pretty: boolean): string[]
{
    const sources = list(bundle.sources).map(record);
    const width = column(sources.map((source) => String(source.kind)));
    const lines = [`${paint("sources")} ${sources.length}`];
    for (const source of sources)
    {
        lines.push(`  ${pad(String(source.kind), width, pretty)}  ${String(source.ref)}  ${quiet(String(source.sha256).slice(0, 12))}`);
    }
    return lines;
}

function renderFacts(bundle: Bundle, paint: Paint, quiet: Paint, pretty: boolean): string[]
{
    const facts = list(bundle.facts).map(record);
    const width = column(facts.map((fact) => String(fact.type)));
    const lines = [`${paint("facts")} ${facts.length}`];
    for (const fact of facts)
    {
        const statement = pretty ? fitDisplay(oneLine(String(fact.statement)), Math.max(20, termWidth() - width - 40)) : String(fact.statement);
        lines.push(`  ${String(fact.ts)}  ${pad(String(fact.type), width, pretty)}  ${quiet(String(fact.ref))}  ${statement}`);
    }
    return lines;
}

function renderExclusions(bundle: Bundle, paint: Paint): string[]
{
    const exclusions = list(bundle.exclusions).map(record);
    return [
        `${paint("exclusions")} ${exclusions.length}`,
        ...exclusions.map((item) => `  ${String(item.ref)}  ${String(item.why)}`)
    ];
}

// Padding is a terminal affordance. Piped output keeps the single space it has
// always had, so a reader that splits on whitespace reads the same bytes.
function pad(text: string, width: number, pretty: boolean): string
{
    return pretty ? padDisplay(text, width) : text;
}

function column(values: string[]): number
{
    return values.reduce((widest, value) => Math.max(widest, value.length), 0);
}

function record(value: Canonical | undefined): Record<string, Canonical>
{
    return value === null || typeof value !== "object" || Array.isArray(value) ? {} : value as Record<string, Canonical>;
}

function list(value: Canonical | undefined): Canonical[]
{
    return Array.isArray(value) ? value : [];
}
