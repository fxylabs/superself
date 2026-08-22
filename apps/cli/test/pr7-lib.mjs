// Shared fixtures for the PR7 suites: a rail that answers on loopback, a
// signer that produces the release documents the loader accepts, a plugin tree
// writer, and a credential writer.
//
// Two deliberate choices. The rail is a real HTTP server rather than a stubbed
// `fetch`, so the spawned binary exercises the transport it actually ships —
// timeouts, headers, status codes and all. And the signing key is the DEV
// keypair whose public half is pinned in `src/releasekeys.ts`: it is public by
// construction, which is exactly why a release signed with it must never be
// treated as a production artifact.
import { createServer } from "node:http";
import { createPrivateKey, createHash, sign } from "node:crypto";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { jcs } from "../dist/rail.js";

const bin = fileURLToPath(new URL("../bin/self.mjs", import.meta.url));

/* ── signing ───────────────────────────────────────────────────────── */

// ⚠ DEVELOPMENT KEY. Its public half is `dev-2026a` in src/releasekeys.ts and
// its private half is in this repository, so anything it signs is signed by a
// key everyone has. It exists so the loader can be driven end to end.
export const DEV_KID = "dev-2026a";

function devKey()
{
    return createPrivateKey(readFileSync(new URL("./fixtures/dev-signing-key.pem", import.meta.url)));
}

export function signManifest(manifest, kid = DEV_KID)
{
    return { kid, alg: "ed25519", sig: sign(null, Buffer.from(jcs(manifest)), devKey()).toString("base64") };
}

// The minimal plugin that satisfies the contract: one root verb with one
// unnamed leaf that answers with a payload block.
export function pluginSource(verb, extra = "")
{
    return `export default function register(host)
{
    ${extra}
    return [{
        name: ${JSON.stringify(verb)},
        usage: [{ syntax: ${JSON.stringify(verb)} + " [--json]", description: ["fixture"], verbs: [""] }],
        detail: ["fixture plugin", "", "  --json                machine-readable output"],
        node: host.contract.leaf("", { json: { type: "boolean" } }, 0, () =>
            [host.output.payload({ ok: true, verb: ${JSON.stringify(verb)} }, () => ["ok"])])
    }];
}
`;
}

export function manifestFor(options)
{
    const entry = options.entry ?? pluginSource(options.verbs?.[0] ?? options.key);
    const bytes = Buffer.from(entry, "utf8");
    return {
        manifest: {
            manifest_version: 1,
            key: options.key,
            name: `Fixture ${options.key}`,
            version: options.version ?? "0.1.0",
            verbs: options.verbs ?? [options.key],
            ...(options.requires === undefined ? {} : { requires: options.requires }),
            contract: options.contract ?? 0,
            rail_api: options.railApi ?? "^1",
            cli: options.cli ?? ">=0.6.0 <2.0.0",
            scopes: options.scopes ?? [],
            entry_sha256: createHash("sha256").update(bytes).digest("hex"),
            entry_bytes: bytes.byteLength,
            released_at: options.releasedAt ?? "2026-08-01T00:00:00Z"
        },
        bytes
    };
}

// The signed JSON document of design §1.1, exactly as the rail serves it.
export function releaseDocument(options)
{
    const { manifest, bytes } = manifestFor(options);
    const signature = options.signature ?? signManifest(manifest, options.kid);
    return { manifest, signature, entry: bytes.toString("base64") };
}

/* ── the plugin tree on disk ───────────────────────────────────────── */

export function pluginsRoot(box)
{
    return join(box.root, "home", ".local", "share", "superself", "plugins");
}

export function configRoot(box)
{
    return join(box.root, "config", "superself");
}

export function statePath(box)
{
    return join(configRoot(box), "plugin-state.json");
}

// Writes what a completed install leaves: the version directory, `current`,
// and the state entry that lives outside the tree. `overrides` lets a test
// produce the states an attacker produces — a manifest under the wrong
// directory name, a `current` pointing below the high-water mark.
export function installFixture(box, options)
{
    const document = releaseDocument(options);
    const key = options.dirKey ?? options.key;
    const version = options.dirVersion ?? document.manifest.version;
    const dir = join(pluginsRoot(box), key, version);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(document.manifest));
    writeFileSync(join(dir, "signature.json"), JSON.stringify(document.signature));
    writeFileSync(join(dir, "index.js"), Buffer.from(document.entry, "base64"));
    writeFileSync(join(pluginsRoot(box), key, "current"), JSON.stringify({ version: options.current ?? version }));
    if (options.state !== null)
    {
        writeState(box, key, { highest: options.highest ?? version, rail_api_seen: options.railApiSeen ?? "1", installed_at: "2026-08-01T00:00:00Z" });
    }
    return { document, dir };
}

export function writeState(box, key, entry)
{
    mkdirSync(configRoot(box), { recursive: true, mode: 0o700 });
    const path = statePath(box);
    const state = existsJson(path) ?? { version: 1, plugins: {} };
    state.plugins[key] = entry;
    writeFileSync(path, JSON.stringify(state, null, 2), { mode: 0o600 });
    chmodSync(path, 0o600);
}

export function readState(box)
{
    return existsJson(statePath(box)) ?? { version: 1, plugins: {} };
}

function existsJson(path)
{
    try
    {
        return JSON.parse(readFileSync(path, "utf8"));
    }
    catch
    {
        return null;
    }
}

/* ── the credential on disk ────────────────────────────────────────── */

export function credentialsFile(box)
{
    return join(configRoot(box), "credentials.json");
}

export function writeCredential(box, options = {})
{
    const name = options.profile ?? "default";
    mkdirSync(configRoot(box), { recursive: true, mode: 0o700 });
    const path = credentialsFile(box);
    const file = existsJson(path) ?? { version: 1, default: name, profiles: {} };
    file.profiles[name] = {
        api_base: options.apiBase ?? "https://app.superselfs.com",
        account_id: options.account ?? "acct_01J8TEST",
        grant_id: options.grant ?? "grant_01J8TEST",
        scopes: options.scopes ?? ["email.send", "email.read", "email.domain.manage", "landing.deploy", "landing.read", "wallet.read"],
        console_base: options.consoleBase ?? "https://app.superselfs.com",
        access_token: options.access ?? "sa_access_fixture",
        access_expires_at: options.expiresAt ?? new Date(Date.now() + 3600_000).toISOString(),
        refresh_token: options.refresh ?? "sr_refresh_fixture",
        grant_started_at: "2026-08-01T00:00:00Z",
        device_label: "fixture@test",
        obtained_at: "2026-08-01T00:00:00Z"
    };
    writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
}

export function markerPath(box, profile = "default")
{
    return join(configRoot(box), `credentials.${profile}.pending`);
}

export function lockFile(box, profile = "default")
{
    return join(configRoot(box), `credentials.${profile}.lock`);
}

export function writeMarkerFixture(box, options = {})
{
    const profile = options.profile ?? "default";
    const marker = {
        version: 1,
        profile,
        grant_id: options.grant ?? "grant_01J8TEST",
        prior_refresh_sha256: createHash("sha256").update(options.priorRefresh ?? "sr_refresh_fixture").digest("hex"),
        prior_access_sha256: createHash("sha256").update(options.priorAccess ?? "sa_access_fixture").digest("hex"),
        at: options.at ?? new Date().toISOString()
    };
    mkdirSync(configRoot(box), { recursive: true, mode: 0o700 });
    writeFileSync(markerPath(box, profile), JSON.stringify(marker), { mode: 0o600 });
    chmodSync(markerPath(box, profile), 0o600);
    return marker;
}

/* ── a rail that answers on loopback ───────────────────────────────── */

// `handler(request)` returns `{status, body, headers}`. Every request is
// recorded, because most of these cells assert on what was *not* sent — a
// refresh that must not have happened, a plugin call that must not have been
// issued while the rail major was unknown.
export async function railServer(handler)
{
    const calls = [];
    const server = createServer((request, response) =>
    {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () =>
        {
            const url = new URL(request.url, "http://127.0.0.1");
            const raw = Buffer.concat(chunks).toString("utf8");
            const call = {
                method: request.method,
                path: url.pathname,
                query: Object.fromEntries(url.searchParams),
                headers: request.headers,
                body: parse(raw),
                raw
            };
            calls.push(call);
            Promise.resolve(handler(call, calls.length)).then((given) => reply(response, given));
        });
    });
    // A handler may answer asynchronously — a refresh held open while the test
    // does something else is how the login-versus-refresh race is staged.
    function reply(response, given)
    {
        {
            const answer = given ?? { status: 404, body: { message: "no fixture" } };
            if (answer.destroy === true)
            {
                // A real transport failure: the connection dies with no
                // response at all, which is what the client must treat as
                // "completion unknown" rather than as an answer.
                response.socket.destroy();
                return;
            }
            const headers = { "content-type": "application/json", "x-superself-api": "1", ...(answer.headers ?? {}) };
            response.writeHead(answer.status, headers);
            response.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body ?? null));
        }
    }
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    // `closeAllConnections` first: a cell that deliberately leaves a request
    // unanswered holds a socket open, and `close` alone waits for it forever.
    return {
        url,
        calls,
        close: () => new Promise((resolve) =>
        {
            server.closeAllConnections();
            server.close(resolve);
        })
    };
}

function parse(raw)
{
    try
    {
        return raw === "" ? null : JSON.parse(raw);
    }
    catch
    {
        return raw;
    }
}

/* ── running the binary ────────────────────────────────────────────── */

// The shipped harness merges stdout and stderr, which most assertions want.
// These cells need them apart: "the error object is on **stdout**, not stderr"
// is the single most easily-missed contract point in the PR, and a merged
// stream cannot tell it from the opposite.
export function selfSplit(box, cwd, args, extra = {})
{
    // `spawnSync` rather than `execFileSync`: the latter throws away stderr on
    // a successful exit, and several of these cells are about what a *successful*
    // run said on stderr — a development banner, a low-balance notice.
    const result = spawnSync(process.execPath, [bin, ...args],
        { cwd, env: { ...box.env, ...extra }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: result.status ?? 1, out: result.stdout ?? "", err: result.stderr ?? "", all: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

// A box wired to a fixture rail: dev mode on (so an http base is allowed at
// all), the journal off unless a cell is about the journal, and the rail's own
// address as the base.
export function railEnv(rail, extra = {})
{
    return { SUPERSELF_DEV: "1", SUPERSELF_API_BASE: rail.url, SUPERSELF_NO_JOURNAL: "1", ...extra };
}

// The fixture rail lives in this process, so a **blocking** spawn would stop
// the event loop that has to answer it: `execFileSync` and a loopback server
// cannot both run here. Every cell that drives the rail uses this instead.
export function selfAsync(box, cwd, args, extra = {})
{
    const env = { ...box.env, ...extra };
    return new Promise((resolve) =>
    {
        execFile(process.execPath, [bin, ...args], { cwd, env, encoding: "utf8" }, (error, out, err) =>
            // `all` is the merged stream the shipped harness reports, for the
            // assertions that only care what was said; `out` and `err` stay
            // apart for the cells whose subject is *which* stream said it.
            resolve({ code: error?.code ?? 0, out: out ?? "", err: err ?? "", all: `${out ?? ""}${err ?? ""}` }));
    });
}

export function jsonOf(text)
{
    return JSON.parse(text.trim().split("\n").filter((line) => line !== "").pop());
}

export function jsonLines(text)
{
    return text.trim().split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
}
