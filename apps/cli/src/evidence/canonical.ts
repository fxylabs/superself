// The one serializer the evidence subsystem hashes through. A bundle's whole
// claim is that the same pinned inputs give the same bytes on any machine, so
// every choice a JSON writer normally leaves to its runtime — key order, string
// spelling, line endings, number formatting — is fixed here and nowhere else.
// A second serializer beside this one would be a second answer to what the
// digest covers.

import { sha256 } from "../repo.js";
import { CliError } from "../types.js";

export type Canonical = string | number | boolean | null | Canonical[] | { [key: string]: Canonical };

const CRLF = /\r\n?/g;

// Every string that reaches the bundle passes here. macOS hands back decomposed
// spellings where Linux hands back composed ones, and a CR left by a Windows
// editor moves the bytes without changing a word anyone reads: both would break
// the digest for content two people would call identical.
export function canonicalText(text: string): string
{
    return text.normalize("NFC").replace(CRLF, "\n");
}

// Codepoint order, which is not what `Array.prototype.sort` gives: the default
// comparator orders by UTF-16 code unit, so an astral key sorts before U+FFFF
// there and after it here. Stating the order is the point — a bundle sorted one
// way on one runtime is not reproducible.
export function compareCodepoints(left: string, right: string): number
{
    const a = [...left];
    const b = [...right];
    for (let index = 0; index < Math.min(a.length, b.length); index += 1)
    {
        const diff = (a[index].codePointAt(0) ?? 0) - (b[index].codePointAt(0) ?? 0);
        if (diff !== 0)
        {
            return diff;
        }
    }
    return a.length - b.length;
}

export function canonicalJson(value: Canonical): string
{
    if (value === null || typeof value === "boolean")
    {
        return JSON.stringify(value);
    }
    if (typeof value === "number")
    {
        return canonicalNumber(value);
    }
    if (typeof value === "string")
    {
        return JSON.stringify(canonicalText(value));
    }
    if (Array.isArray(value))
    {
        return "[" + value.map(canonicalJson).join(",") + "]";
    }
    if (typeof value !== "object")
    {
        throw new CliError(`evidence content holds a ${typeof value} value, which has no canonical spelling — a bundle carries text, whole numbers, booleans, lists and maps`);
    }
    return canonicalObject(value);
}

// Keys are normalized before they are ordered, so the sort really is over the
// bytes that get written. Two spellings that normalize to one key are refused
// rather than silently merged: one of them would disappear from the record.
function canonicalObject(value: { [key: string]: Canonical }): string
{
    const fields = new Map<string, Canonical>();
    for (const [key, child] of Object.entries(value))
    {
        const name = canonicalText(key);
        if (fields.has(name))
        {
            throw new CliError(`evidence content holds two spellings of the key "${name}" — one record cannot carry both`);
        }
        fields.set(name, child);
    }
    const keys = [...fields.keys()].sort(compareCodepoints);
    return "{" + keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(fields.get(key) as Canonical)}`).join(",") + "}";
}

// Whole numbers only in v1. A float has more than one shortest decimal spelling
// across runtimes, and negative zero prints as a value that reads back as zero,
// so either would make the digest depend on who wrote it rather than on what
// was recorded.
function canonicalNumber(value: number): string
{
    if (!Number.isSafeInteger(value))
    {
        throw new CliError(`evidence content holds the number ${value} — a bundle carries whole numbers within the safe integer range only`);
    }
    return String(value === 0 ? 0 : value);
}

// Exactly one trailing newline, so a bundle is a well-formed text file and
// appending nothing is the only way to leave its digest intact.
export function canonicalBytes(value: Canonical): string
{
    return canonicalJson(value) + "\n";
}

export function digestOf(value: Canonical): string
{
    return sha256(canonicalBytes(value));
}
