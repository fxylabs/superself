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
import { Canonical, digestOf } from "./canonical.js";
import { BUNDLE_FORMATS, Bundle, digestWithout, logDigest, logHead, resolveSources } from "./compile.js";
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
    const found: Divergence[] = [...verifySelfContained(bundle)];
    const manifest = embeddedManifest(bundle);
    found.push(...verifyPins(manifest, input));
    found.push(...verifySources(bundle, manifest, input));
    return found;
}

// The checks that need nothing but the file: whoever edited a fact, a source
// record or an exclusion changed the bytes the digest covers.
function verifySelfContained(bundle: Bundle): Divergence[]
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
    return found;
}

function verifyPins(manifest: Manifest, input: VerifyInput): Divergence[]
{
    const found: Divergence[] = [];
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

// Every source recompiled from the live store and the pinned repositories, then
// compared by hash. A record that no longer resolves at all is a divergence
// under its own ref rather than an error that hides the rest.
function verifySources(bundle: Bundle, manifest: Manifest, input: VerifyInput): Divergence[]
{
    const declared = declaredSources(bundle);
    let events: SelfEvent[] = [];
    let resolved;
    try
    {
        events = readEvents(input.storeDir, manifest.project);
        resolved = resolveSources({ storeDir: input.storeDir, manifest, from: input.from }, events);
    }
    catch (error)
    {
        return [{ at: "sources", detail: (error as Error).message }];
    }
    const live = new Map(resolved.map((source) => [source.ref, source.sha256]));
    const found: Divergence[] = [];
    for (const [ref, sha] of declared)
    {
        const now = live.get(ref);
        if (now !== sha)
        {
            found.push({ at: `sources[${ref}]`, detail: `the bundle records ${sha} and the source now hashes to ${now ?? "nothing — it no longer resolves"}` });
        }
    }
    return found;
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
