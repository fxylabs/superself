// What a bundle claims, rechecked. Two questions are asked, and they fail in
// different ways: whether the file is still the file it says it is — answerable
// from the bytes alone, on a machine that has never seen the store — and
// whether the store and the repositories still hold what it cites.
//
// Every divergence is collected before any is reported. A verifier that stopped
// at the first one would make a reader think the rest still held.

import { existsSync, readFileSync } from "node:fs";
import { readEvents } from "../logfile.js";
import { CliError, SelfEvent } from "../types.js";
import { Canonical, asList, asRecord, digestOf } from "./canonical.js";
import { BUNDLE_FORMATS, Bundle, COMPILER, Source, digestWithout, factRefsOf, factsOf, logDigest, logHead, resolveSources } from "./compile.js";
import { Manifest, parseManifest } from "./manifest.js";

export interface Divergence
{
    at: string;
    detail: string;
}

export interface VerifyInput
{
    storeDir: string;
    from: string;
}

export function readBundleFile(file: string): Bundle
{
    if (!existsSync(file))
    {
        throw new CliError(`bundle "${file}" does not exist — pass the path of a ${BUNDLE_FORMATS[0]} file`);
    }
    return parseBundle(readFileSync(file, "utf8"), file);
}

export function parseBundle(text: string, file: string): Bundle
{
    let parsed: unknown;
    try
    {
        parsed = JSON.parse(text);
    }
    catch (error)
    {
        throw new CliError(`bundle "${file}" is not JSON — ${(error as Error).message}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    {
        throw new CliError(`bundle "${file}" is not a JSON object — a bundle is one ${BUNDLE_FORMATS[0]} record`);
    }
    const bundle = parsed as Bundle;
    const format = bundle.format;
    if (typeof format !== "string" || !BUNDLE_FORMATS.includes(format))
    {
        throw new CliError(`bundle "${file}" declares format ${typeof format === "string" ? `"${format}"` : "nothing"} — this build verifies ${BUNDLE_FORMATS.join(", ")}`);
    }
    return bundle;
}

export function verifyBundle(bundle: Bundle, input: VerifyInput): Divergence[]
{
    const found: Divergence[] = [...verifyStructure(bundle)];
    const manifest = embeddedManifest(bundle);
    found.push(...verifyPins(bundle, manifest, input));
    found.push(...verifySources(bundle, manifest, input));
    return found;
}

// The checks that need nothing but the file, and the ones `show` runs before it
// renders. A recomputed digest is not integrity on its own: whoever dropped a
// source row can hash what is left. So the file is also checked against itself
// — the exclusions and pins it carries against the manifest it embeds, its
// facts against the sources it still holds, one row per ref — and a bundle that
// fails any of these describes a state it no longer contains.
export function verifyStructure(bundle: Bundle): Divergence[]
{
    const found: Divergence[] = [];
    const digest = digestWithout(bundle);
    if (digest !== bundle.digest)
    {
        found.push({ at: "digest", detail: `the bundle records ${String(bundle.digest)} and its bytes hash to ${digest}` });
    }
    const embedded = manifestSection(bundle);
    const recomputed = digestOf(embedded.pinned);
    if (recomputed !== embedded.manifestSha256)
    {
        found.push({ at: "manifest", detail: `the bundle records ${String(embedded.manifestSha256)} and its embedded manifest hashes to ${recomputed}` });
    }
    found.push(...verifyRecordHashes(bundle));
    found.push(...verifyAgainstEmbedded(bundle, embedded.pinned));
    found.push(...verifyFactRefs(bundle));
    return found;
}

// `sources[].sha256` is the hash of that row's own record, so the row is
// checkable against itself. This is the direct form of tampering — a record
// rewritten in place while its declared hash and the bundle digest are
// recomputed around it — and it is caught here, offline, before the live store
// is consulted at all. What the store answers afterwards is a different
// question: whether the source has since moved.
function verifyRecordHashes(bundle: Bundle): Divergence[]
{
    return asList(bundle.sources)
        .map(asRecord)
        .map((source) => ({ source, recomputed: digestOf(source.record) }))
        .filter(({ source, recomputed }) => recomputed !== source.sha256)
        .map(({ source, recomputed }) => ({
            at: `sources[${String(source.ref)}].record`,
            detail: `the row declares ${String(source.sha256)} and the record it carries hashes to ${recomputed}`
        }));
}

// The bundle's own copies of what the manifest already said. They are carried
// so a reader never has to unwrap the manifest to see what was withheld or what
// was pinned, and that copy is exactly what an editor can drop a line from.
function verifyAgainstEmbedded(bundle: Bundle, pinned: Canonical): Divergence[]
{
    const manifest = asRecord(pinned);
    const pins = asRecord(bundle.pins);
    const from = asRecord(asRecord(bundle.provenance).compiledFrom);
    const checks: [string, Canonical, Canonical][] = [
        ["exclusions", bundle.exclusions ?? [], manifest.exclude ?? []],
        ["pins.self", pins.self ?? {}, asRecord(manifest.pins).self ?? {}],
        ["pins.git", pins.git ?? [], asRecord(manifest.pins).git ?? []],
        ["profile", bundle.profile ?? "", manifest.profile ?? ""],
        // Provenance restates pins that are already reconciled, and duplicated
        // state nobody checks is state that can be rewritten. `compiler` is
        // checked against the contract this build implements rather than
        // against the manifest, which never states it.
        ["provenance.compiledFrom.selfHead", from.selfHead ?? "", asRecord(asRecord(manifest.pins).self).head ?? ""],
        ["provenance.compiledFrom.gitCommits", from.gitCommits ?? [], asRecord(manifest.pins).git ?? []],
        ["provenance.compiler", asRecord(bundle.provenance).compiler ?? {}, { name: COMPILER.name, version: COMPILER.version }]
    ];
    return checks
        .filter(([, carried, stated]) => digestOf(carried) !== digestOf(stated))
        .map(([at]) => ({ at, detail: at === "provenance.compiler"
            ? `what the bundle carries here is not the compiler contract ${BUNDLE_FORMATS[0]} is produced by`
            : "what the bundle carries here differs from what its embedded manifest states" }));
}

// A fact is a line about a source. One naming a ref the bundle no longer holds
// is a claim with its evidence removed, and duplicate rows for one ref make the
// reconciliation below meaningless.
function verifyFactRefs(bundle: Bundle): Divergence[]
{
    const carried = new Set<string>();
    const found: Divergence[] = [];
    for (const item of asList(bundle.sources))
    {
        const source = asRecord(item);
        const ref = String(source.ref);
        if (carried.has(ref))
        {
            found.push({ at: `sources[${ref}]`, detail: "the bundle carries more than one row for this ref" });
        }
        factRefsOf(asRecord(source.record), String(source.kind), ref).forEach((id) => carried.add(id));
    }
    const orphan = asList(bundle.facts).map(asRecord).find((fact) => !carried.has(String(fact.ref)));
    if (orphan !== undefined)
    {
        found.push({ at: `facts[${String(orphan.ref)}]`, detail: "this fact names a source the bundle does not carry" });
    }
    return found;
}

function verifyPins(bundle: Bundle, manifest: Manifest, input: VerifyInput): Divergence[]
{
    const found: Divergence[] = [...verifyEventCount(bundle, input, manifest.project)];
    const pinned = manifest.pins.self ?? {};
    const head = logHead(input.storeDir, manifest.project);
    if (head !== pinned.head)
    {
        found.push({ at: "pins.self.head", detail: `the bundle pins ${String(pinned.head)} and the store's log head is ${head ?? "nothing"}` });
    }
    const digest = logDigest(input.storeDir, manifest.project);
    if (digest !== pinned.logSha256)
    {
        found.push({ at: "pins.self.logSha256", detail: `the bundle pins ${String(pinned.logSha256)} and the store's log hashes to ${digest ?? "nothing"}` });
    }
    return found;
}

// The one number in `pins` the embedded manifest never states, so the check
// above cannot reach it. It is what the pinned log held, and while the pin
// holds, the live log is that log.
function verifyEventCount(bundle: Bundle, input: VerifyInput, slug: string): Divergence[]
{
    const carried = asRecord(bundle.pins).eventCount;
    const live = readEvents(input.storeDir, slug).length;
    if (carried === live)
    {
        return [];
    }
    return [{ at: "pins.eventCount", detail: `the bundle records ${String(carried)} and the store's log holds ${live}` }];
}

// Every source recompiled from the live store and the pinned repositories, then
// compared by hash. A record that no longer resolves at all is a divergence
// under its own ref rather than an error that hides the rest.
function verifySources(bundle: Bundle, manifest: Manifest, input: VerifyInput): Divergence[]
{
    const resolved = liveSources(manifest, input);
    if (!Array.isArray(resolved))
    {
        return [resolved];
    }
    const declared = declaredSources(bundle);
    const live = new Map(resolved.map((source) => [source.ref, source.sha256]));
    const found = declared
        .filter(([ref, sha]) => live.get(ref) !== sha)
        .map(([ref, sha]) => ({ at: `sources[${ref}]`, detail: staleDetail(sha, live.get(ref)) }));
    found.push(...verifyNothingDropped(declared, resolved));
    found.push(...verifyFacts(bundle, resolved));
    return found;
}

// A selection that no longer resolves at all is one divergence about the
// selection, not a thrown error that hides every other check.
function liveSources(manifest: Manifest, input: VerifyInput): Source[] | Divergence
{
    try
    {
        const events: SelfEvent[] = readEvents(input.storeDir, manifest.project);
        return resolveSources({ storeDir: input.storeDir, manifest, from: input.from }, events);
    }
    catch (error)
    {
        return { at: "sources", detail: (error as Error).message };
    }
}

function staleDetail(recorded: string, now: string | undefined): string
{
    return now === undefined
        ? "the embedded manifest selects no source with this ref, so the bundle carries a row nothing it states asked for"
        : `the bundle records ${recorded} and the source now hashes to ${now}`;
}

// The other direction. Comparing only what the bundle declares answers whether
// each row it kept is still true, never whether it kept every row its own
// selection produces — so a row deleted along with its facts, over a recomputed
// digest, would pass. This is what closes that: the selection the embedded
// manifest states must resolve to exactly the rows the bundle carries.
function verifyNothingDropped(declared: [string, string][], resolved: Source[]): Divergence[]
{
    const carried = new Set(declared.map(([ref]) => ref));
    return resolved
        .filter((source) => !carried.has(source.ref))
        .map((source) => ({
            at: `sources[${source.ref}]`,
            detail: "the embedded manifest selects this source and the bundle carries no row for it"
        }));
}

// The timeline recomputed from the same sources, compared whole. Dropping one
// fact for a source the bundle still carries leaves every other check intact,
// and it is exactly how a record is made to say less than it said.
function verifyFacts(bundle: Bundle, resolved: Source[]): Divergence[]
{
    const expected = digestOf(factsOf(resolved));
    const carried = digestOf(asList(bundle.facts));
    if (expected === carried)
    {
        return [];
    }
    return [{ at: "facts", detail: `the bundle carries ${asList(bundle.facts).length} fact(s) and its sources produce ${factsOf(resolved).length}` }];
}

function declaredSources(bundle: Bundle): [string, string][]
{
    const sources = Array.isArray(bundle.sources) ? bundle.sources : [];
    return sources.map((item) =>
    {
        const source = item as Record<string, Canonical>;
        return [String(source.ref), String(source.sha256)] as [string, string];
    });
}

function manifestSection(bundle: Bundle): { manifestSha256: unknown; pinned: Canonical }
{
    const section = bundle.manifest;
    if (section === null || typeof section !== "object" || Array.isArray(section))
    {
        throw new CliError("the bundle carries no embedded manifest — a bundle states the selection it was compiled from");
    }
    const record = section as Record<string, Canonical>;
    return { manifestSha256: record.manifestSha256, pinned: record.pinned };
}

// Read back through the manifest reader, so a bundle whose embedded manifest
// was edited into a shape the compiler would refuse is refused here too.
function embeddedManifest(bundle: Bundle): Manifest
{
    return parseManifest(JSON.stringify(manifestSection(bundle).pinned), "the bundle's embedded manifest");
}

// One line, first divergence first, the rest counted and named after it: the
// reader needs to know what broke and how much else did.
export function divergenceRefusal(file: string, found: Divergence[]): string
{
    const first = found[0];
    const rest = found.slice(1).map((item) => item.at).join(", ");
    const tail = rest === "" ? "" : `; ${found.length - 1} more diverged: ${rest}`;
    return `bundle "${file}" no longer verifies — ${first.at}: ${first.detail}${tail}`;
}
