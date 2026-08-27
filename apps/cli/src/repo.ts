import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { runGit } from "./gitutil.js";

// Digests must not depend on who runs the command. Every option that a user's
// git config can move — rename detection, prefixes, line endings, external
// diff drivers, colour — is pinned here, so the same two commits hash the same
// on every machine and in CI.
const STABLE = [
    "-c", "core.autocrlf=false",
    "-c", "core.abbrev=40",
    "-c", "diff.renames=false",
    "-c", "diff.noprefix=false",
    "-c", "diff.external=",
    "-c", "diff.mnemonicPrefix=false"
];

function run(repoDir: string, args: string[]): { ok: boolean; out: string } | null
{
    if (!existsSync(repoDir))
    {
        return null;
    }
    const result = runGit(repoDir, [...STABLE, ...args], { maxBuffer: 256 * 1024 * 1024 });
    if (result.error !== undefined)
    {
        return null;
    }
    return { ok: result.status === 0, out: result.stdout ?? "" };
}

// The artifact-store digest, beside sha256File rather than through it: an
// artifact is an arbitrary file, so the bytes are hashed in chunks instead of
// loaded whole, and a file that will not open throws with its errno — the
// caller decides whether that degrades to a health signal or refuses a write.
// sha256File keeps its own contract (null for a missing file or a directory)
// for the receipt paths that already read it.
export function digestFile(file: string): string
{
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    const fd = openSync(file, "r");
    try
    {
        let read = readSync(fd, buffer, 0, buffer.length, null);
        while (read > 0)
        {
            hash.update(buffer.subarray(0, read));
            read = readSync(fd, buffer, 0, buffer.length, null);
        }
    }
    finally
    {
        closeSync(fd);
    }
    return hash.digest("hex");
}
