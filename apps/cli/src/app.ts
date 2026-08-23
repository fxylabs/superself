// `self app install|list|update|remove` — how a mini-app gets onto a machine.
//
// The plugin comes from our own rail, over TLS, from the host the agent already
// authenticates to, and is authenticated with **any valid credential and no
// scope**. "Private" should mean private, so an unauthenticated CDN URL is the
// wrong default; but gating the download behind a scope adds a failure mode
// with no security value, because the plugin is a thin client whose code is not
// the secret and a customer who cannot download it cannot use the product.
//
// One rule here is worth reading twice. `<key>@<version>` is sent to the server
// as a request parameter, and the returned `manifest.version` must equal the
// pin **before anything is written** — before the version directory, before
// `current`, before the high-water mark. A server that answers with a different
// version and a client that writes it anyway would silently defeat both the pin
// and `--allow-downgrade`, and on the downgrade path it would move the mark to
// a version nobody asked for.

import { Command, CommandInput, branch, leaf } from "./contract.js";
import { resolveProfileName } from "./credentials.js";
import { cliVersion } from "./help.js";
import { clientTag } from "./login.js";
import {
    InstalledPlugin, PluginManifest, ReleaseDocument, SUPPORTED_CONTRACTS, installedPlugins,
    installRelease, pluginKey, pluginVersion, removePlugin, satisfies
} from "./plugins.js";
import { RailSession, railMajor, railRequest } from "./rail.js";
import { TrustDocument, TrustState, loadTrustDocument, trustExpired } from "./trust.js";
import { CommandOutput, JsonValue, fail } from "./types.js";

/* ── who may claim a verb ──────────────────────────────────────────── */

// The dispatcher hands over the root command names once it has composed them,
// exactly as it does for the alias table: this module cannot import the
// dispatcher to ask, and a plugin claiming `work` or `report` would shadow a
// built-in if the check were left to resolution order alone.
let builtinVerbs: string[] = [];
// Whether a verb already has an alias row. Supplied by the dispatcher for the
// same reason, and best-effort: no workspace means no rows, not a refusal.
let aliasClaims: (verb: string) => boolean = () => false;

export function registerHostVerbs(names: string[], claimsAlias: (verb: string) => boolean): void
{
    builtinVerbs = names;
    aliasClaims = claimsAlias;
}

function checkVerbs(manifest: PluginManifest): void
{
    for (const verb of manifest.verbs)
    {
        if (builtinVerbs.includes(verb))
        {
            throw fail("verb_reserved", `"${verb}" is a built-in command, so a plugin cannot claim it`);
        }
        if (aliasClaims(verb))
        {
            throw fail("verb_conflicts_alias", `"${verb}" is already an alias row — drop it with \`self alias drop ${verb}\``);
        }
    }
}

/* ── fetching a release ────────────────────────────────────────────── */

function session(profile: string): RailSession
{
    return { profile, client: clientTag(), notice: (line: string) => console.error(line) };
}

interface Fetched
{
    document: ReleaseDocument;
    railApi: string | undefined;
}

async function fetchRelease(profile: string, key: string, pin: string | undefined): Promise<Fetched>
{
    const answer = await railRequest({
        session: session(profile),
        spec: {
            method: "GET",
            path: `/api/plugins/${pluginKey(key)}/release`,
            query: { cli: cliVersion(), ...(pin === undefined ? {} : { version: pin }) },
            // Any valid credential, no scope. See the header comment.
            scopes: []
        },
        commandPath: "app install"
    });
    return { document: readDocument(answer.body), railApi: railMajor(answer.headers) };
}

function readDocument(body: JsonValue): ReleaseDocument
{
    const record = body !== null && typeof body === "object" && !Array.isArray(body) ? body : {};
    const document = record as unknown as ReleaseDocument;
    if (document.manifest === undefined || document.signature === undefined || typeof document.entry !== "string")
    {
        throw fail("plugin_release_invalid", "the rail did not answer with a signed release document");
    }
    return document;
}

// The pin is the operator's whole intent on this path, so it is checked before
// any state write and the refusal names what was asked for rather than what
// arrived.
function checkPin(document: ReleaseDocument, pin: string | undefined): void
{
    if (pin !== undefined && document.manifest.version !== pin)
    {
        throw fail("plugin_version_mismatch",
            `asked for ${document.manifest.key}@${pin} and the rail answered with ${document.manifest.version}`);
    }
}

/* ── install ───────────────────────────────────────────────────────── */

export function splitPin(argument: string): { key: string; pin?: string }
{
    const at = argument.indexOf("@");
    if (at <= 0)
    {
        return { key: pluginKey(argument) };
    }
    return { key: pluginKey(argument.slice(0, at)), pin: pluginVersion(argument.slice(at + 1)) };
}

interface Installed
{
    key: string;
    version: string;
    verbs: string[];
    scopes: string[];
}

interface InstallRequest
{
    profile: string;
    key: string;
    pin?: string;
    allowDowngrade?: boolean;
    force?: boolean;
    // Fetched once per command, before any release request. Install is
    // fail-closed on it: new code entering the machine is judged against the
    // key list the rail is serving now, not against a cached one.
    trust: TrustDocument;
}

async function installOne(request: InstallRequest): Promise<Installed>
{
    const { profile, key, pin } = request;
    const already = installedPlugins().find((item) => item.key === key);
    if (request.force !== true && already !== undefined && (pin === undefined || already.version === pin))
    {
        const manifest = already.manifest;
        return { key, version: already.version, verbs: manifest.verbs, scopes: manifest.scopes };
    }
    const fetched = await fetchRelease(profile, key, pin);
    checkPin(fetched.document, pin);
    checkVerbs(fetched.document.manifest);
    installRelease(fetched.document, key, request.allowDowngrade === true, request.trust, fetched.railApi);
    const manifest = fetched.document.manifest;
    return { key: manifest.key, version: manifest.version, verbs: manifest.verbs, scopes: manifest.scopes };
}

const INSTALL_OPTIONS = {
    force: { type: "boolean" },
    "allow-downgrade": { type: "boolean" },
    profile: { type: "string" },
    json: { type: "boolean" }
} as const;

// `requires` is resolved one level deep and no further: each named key installs
// at its own latest compatible release. There is no version solving in August,
// and pretending otherwise would be a solver nobody asked for.
async function runInstall(input: CommandInput<typeof INSTALL_OPTIONS>): Promise<CommandOutput>
{
    const target = input.positionals[0];
    if (target === undefined)
    {
        throw fail("parse_error", "name the mini-app to install — `self app install email`");
    }
    const profile = resolveProfileName(input.values.profile === undefined ? undefined : String(input.values.profile));
    const { key, pin } = splitPin(target);
    // The document first, and nothing written if it does not arrive: an
    // install that cannot see a current key list must not happen at all, so
    // the release is never even requested (cell 158).
    const trust = (await loadTrustDocument({ mode: "install", session: session(profile) })).document;
    const installed = [await installOne({
        profile, key, trust, ...(pin === undefined ? {} : { pin }),
        allowDowngrade: input.values["allow-downgrade"] === true, force: input.values.force === true
    })];
    for (const dependency of dependenciesOf(key))
    {
        installed.push(await installOne({ profile, key: dependency, trust }));
    }
    return [{ kind: "payload", data: installed as unknown as JsonValue, plain: () => installedLines(installed) }];
}

function dependenciesOf(key: string): string[]
{
    const plugin = installedPlugins().find((item) => item.key === key);
    return (plugin?.manifest.requires ?? []).filter((name) => !installedPlugins().some((item) => item.key === name));
}

function installedLines(installed: Installed[]): string[]
{
    return installed.map((item) => `installed ${item.key}@${item.version} — verbs: ${item.verbs.join(", ")}`);
}

/* ── list, update, remove ──────────────────────────────────────────── */

const LIST_OPTIONS = { check: { type: "boolean" }, profile: { type: "string" }, json: { type: "boolean" } } as const;

async function runList(input: CommandInput<typeof LIST_OPTIONS>): Promise<CommandOutput>
{
    const plugins = installedPlugins();
    const rows = await Promise.all(plugins.map((plugin) => describeRow(input, plugin)));
    return [{
        kind: "payload",
        data: { plugins: rows } as unknown as JsonValue,
        plain: () => (rows.length === 0 ? ["no mini-apps installed"] : rows.map(listLine))
    }];
}

interface ListRow
{
    key: string;
    version: string;
    verbs: string[];
    compatible: boolean;
    latest?: string;
}

async function describeRow(input: CommandInput<typeof LIST_OPTIONS>, plugin: InstalledPlugin): Promise<ListRow>
{
    const row: ListRow = {
        key: plugin.key,
        version: plugin.version,
        verbs: plugin.manifest.verbs,
        // What the loader would decide, without loading: the CLI range and the
        // contract version are the two of the three compatibility checks that
        // can be answered from metadata alone. The rail major is the third and
        // needs a live answer, so it is not claimed here.
        compatible: satisfies(cliVersion(), plugin.manifest.cli) && SUPPORTED_CONTRACTS.includes(plugin.manifest.contract)
    };
    if (input.values.check !== true)
    {
        return row;
    }
    const profile = resolveProfileName(input.values.profile === undefined ? undefined : String(input.values.profile));
    const fetched = await fetchRelease(profile, plugin.key, undefined);
    return { ...row, latest: fetched.document.manifest.version };
}

function listLine(row: ListRow): string
{
    const latest = row.latest === undefined ? "" : ` · latest ${row.latest}`;
    return `${row.key}@${row.version} — ${row.verbs.join(", ")}${latest}`;
}

const UPDATE_OPTIONS = { all: { type: "boolean" }, profile: { type: "string" }, json: { type: "boolean" } } as const;

// No auto-update anywhere else: silently changing the code an agent runs,
// mid-session, without the operator asking, is the wrong default for a tool
// that spends money. The rail forces the issue when it must, by refusing an
// incompatible client.
async function runUpdate(input: CommandInput<typeof UPDATE_OPTIONS>): Promise<CommandOutput>
{
    const profile = resolveProfileName(input.values.profile === undefined ? undefined : String(input.values.profile));
    const named = input.positionals[0];
    if (named === undefined && input.values.all !== true)
    {
        throw fail("parse_error", "name a mini-app to update, or pass --all",
            { hint: "self app update email — or self app update --all" });
    }
    const keys = named === undefined ? installedPlugins().map((plugin) => plugin.key) : [pluginKey(named)];
    const before = new Map(installedPlugins().map((plugin) => [plugin.key, plugin.version]));
    const trust = (await loadTrustDocument({ mode: "install", session: session(profile) })).document;
    const updated: { key: string; from: string; to: string }[] = [];
    for (const key of keys)
    {
        // An update always fetches: the point of the verb is to find out
        // whether there is something newer, which a local short-circuit would
        // never discover.
        const result = await installOne({ profile, key, trust, force: true });
        updated.push({ key, from: before.get(key) ?? "", to: result.version });
    }
    return [{
        kind: "payload",
        data: { updated } as unknown as JsonValue,
        plain: () => updated.map((row) => `${row.key} ${row.from} → ${row.to}`)
    }];
}

const REMOVE_OPTIONS = { json: { type: "boolean" } } as const;

// The key's `plugin-state.json` entry, including `highest`, is deliberately
// left intact. Rollback history is a property of the key, not of the current
// installation, so `remove` then `install <key>@<older>` is still refused —
// clearing it here would make `remove` a one-command bypass of the guard.
function runRemove(input: CommandInput<typeof REMOVE_OPTIONS>): CommandOutput
{
    const named = input.positionals[0];
    if (named === undefined)
    {
        throw fail("parse_error", "name the mini-app to remove — `self app remove email`");
    }
    const key = pluginKey(named);
    removePlugin(key);
    return [{
        kind: "payload",
        data: { removed: key, highest_retained: true } as unknown as JsonValue,
        plain: () => [`removed ${key}; its rollback high-water mark is kept`]
    }];
}

/* ── trust ─────────────────────────────────────────────────────────── */

const TRUST_OPTIONS = { refresh: { type: "boolean" }, profile: { type: "string" }, json: { type: "boolean" } } as const;

// Read-only, and the command behind the README's claim about what this CLI will
// accept. Without it an operator cannot see which key list their CLI is acting
// on — which key signed the plugin they are running, whether it is revoked, and
// how stale the list is.
//
// It reads like a load rather than like an install: a valid cache answers even
// when the rail is down, and an expired list is shown with its expiry rather
// than refused, because an operator asking what the CLI holds is exactly the
// person who needs to see a stale answer.
async function runTrust(input: CommandInput<typeof TRUST_OPTIONS>): Promise<CommandOutput>
{
    const profile = resolveProfileName(input.values.profile === undefined ? undefined : String(input.values.profile));
    const state = await loadTrustDocument({
        mode: "load",
        session: session(profile),
        refresh: input.values.refresh === true
    });
    const data = trustPayload(state);
    return [{ kind: "payload", data: data as unknown as JsonValue, plain: () => trustLines(state) }];
}

function trustPayload(state: TrustState): Record<string, JsonValue>
{
    return {
        issued_at: state.document.issued_at,
        expires_at: state.document.expires_at,
        expired: trustExpired(state),
        fetched_at: state.fetched_at,
        signed_by: state.signature.kid,
        keys: state.document.keys.map((key) => ({
            kid: key.kid, status: key.status, not_before: key.not_before, not_after: key.not_after
        })),
        min_plugin_versions: (state.document.min_plugin_versions ?? {}) as JsonValue,
        ...(state.document.min_cli_version === undefined ? {} : { min_cli_version: state.document.min_cli_version })
    };
}

function trustLines(state: TrustState): string[]
{
    const floors = Object.entries(state.document.min_plugin_versions ?? {});
    return [
        `signed by root ${state.signature.kid}`,
        `issued ${state.document.issued_at} · expires ${state.document.expires_at}${trustExpired(state) ? " (EXPIRED)" : ""}`,
        `fetched ${state.fetched_at}`,
        ...state.document.keys.map((key) => `${key.kid} — ${key.status}, valid ${key.not_before} to ${key.not_after}`),
        floors.length === 0 ? "no minimum plugin versions" : `minimums: ${floors.map(([key, floor]) => `${key} ${floor}`).join(", ")}`
    ];
}

export const APP_COMMAND: Command = {
    name: "app",
    usage: [
        {
            syntax: "app install <key>[@version] [--force] [--allow-downgrade] [--profile name] [--json]",
            description: ["download, verify and install a mini-app from the rail"],
            verbs: ["install"]
        },
        {
            syntax: "app list [--check] [--profile name] [--json]",
            description: ["what is installed, and with --check what the rail would serve"],
            verbs: ["", "list"]
        },
        {
            syntax: "app update [key] [--all] [--profile name] [--json]",
            description: ["install the latest compatible release"],
            verbs: ["update"]
        },
        {
            syntax: "app remove <key> [--json]",
            description: ["delete an installed mini-app; its rollback mark is kept"],
            verbs: ["remove"]
        },
        {
            syntax: "app trust [--refresh] [--profile name] [--json]",
            description: ["the signed key list this CLI is acting on"],
            verbs: ["trust"]
        }
    ],
    detail: [
        "mini-apps are signed release documents served by the rail. this CLI pins",
        "root keys only; which release keys may sign a plugin — and which have",
        "been revoked — is a document the rail serves and a pinned root signs.",
        "`self app trust` prints the one this machine holds. there is no way to",
        "install an unsigned mini-app and no flag that skips the check.",
        "",
        "  --force               reinstall even when the version is already present",
        "  --allow-downgrade     lower the rollback high-water mark deliberately",
        "  --check               also ask the rail what the latest release is",
        "  --all                 every installed mini-app",
        "  --refresh             fetch the key list now instead of using the cache",
        "  --profile <name>      use a named credential profile",
        "  --json                machine-readable output"
    ],
    node: branch({
        name: "app",
        unnamed: "options",
        refusal: (verb) => `unknown app verb '${String(verb)}' — install, list, update, remove or trust`,
        children: [
            leaf("", LIST_OPTIONS, 0, runList),
            leaf("list", LIST_OPTIONS, 0, runList),
            leaf("install", INSTALL_OPTIONS, 1, runInstall),
            leaf("update", UPDATE_OPTIONS, 1, runUpdate),
            leaf("remove", REMOVE_OPTIONS, 1, runRemove),
            leaf("trust", TRUST_OPTIONS, 0, runTrust)
        ]
    })
};

