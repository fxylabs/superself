// The pair, packed and installed the way a person installs it (#430).
//
// The CLI and `@superself/fold` are published from one tag, and the thing that
// can be wrong about them is a thing neither package's own suite can see: a pin
// that does not resolve, a `files` field that dropped `dist/`, a bin the tarball
// stripped the executable bit from, a dist file still importing a source path
// that only exists in this repository. Every one of those passes `pnpm test`
// and fails on the first install.
//
// It runs against a **local registry** rather than an `overrides` or `file:`
// rewrite, because the pin is the thing under test. An override answers the
// CLI's dependency with a tarball whatever the pin says, so a CLI pinned at
// 9.9.9 would install green; a registry makes npm resolve the spec the tarball
// actually carries, and the wrong pin is an install failure. Row S12 proves the
// resolution is real by taking the fold off that registry and watching the same
// install fail.
//
//   pnpm build && node scripts/pack-install-smoke.mjs
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const failures = [];

function check(row, held, said)
{
    if (!held)
    {
        failures.push(`${row} — ${said}`);
    }
    process.stdout.write(`${held ? "ok  " : "FAIL"} ${row} ${said}\n`);
}

/* ── packing ───────────────────────────────────────────────────────── */

// `npm pack` and nothing else: the tarball a publish would upload, built by the
// same code path. The fold's `prepare` hook rebuilds its `dist/` on the way;
// the CLI has no such hook, so its build is the caller's and is checked first.
function pack(directory, into)
{
    const name = execFileSync("npm", ["pack", "--pack-destination", into, "--silent"],
        { cwd: join(repoRoot, directory), encoding: "utf8" }).trim().split("\n").pop();
    const file = join(into, name);
    return { file, manifest: JSON.parse(fileInTarball(file, "package/package.json")), names: tarballNames(file) };
}

function fileInTarball(tarball, path)
{
    return execFileSync("tar", ["-xzOf", tarball, path], { encoding: "utf8" });
}

function tarballNames(tarball)
{
    return execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).trim().split("\n");
}

/* ── a registry with exactly these packages on it ──────────────────── */

// Enough of the registry protocol for `npm install` to resolve a name to a
// version and a version to a tarball — which is the whole of what this proves.
function packument(entry, origin)
{
    const { version } = entry.manifest;
    return {
        name: entry.manifest.name,
        "dist-tags": { latest: version },
        versions: {
            [version]: {
                ...entry.manifest,
                dist: {
                    tarball: `${origin}/${encodeURIComponent(entry.manifest.name)}/-/tarball-${version}.tgz`,
                    integrity: `sha512-${createHash("sha512").update(readFileSync(entry.file)).digest("base64")}`
                }
            }
        }
    };
}

// The install is spawned rather than run synchronously, and that is not a
// style choice: `execFileSync` blocks this process's event loop, so the server
// npm is waiting on could never answer it. The two would deadlock.
async function withRegistry(entries, run)
{
    const byName = new Map(entries.map((entry) => [entry.manifest.name, entry]));
    const server = createServer((request, answer) => serve(byName, request, answer));
    await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
    const result = await run(`http://127.0.0.1:${server.address().port}`);
    server.closeAllConnections();
    await new Promise((closed) => server.close(closed));
    return result;
}

function serve(byName, request, answer)
{
    const path = decodeURIComponent(new URL(request.url, "http://registry").pathname).replace(/^\//, "");
    const [name, tarball] = path.split("/-/");
    const entry = byName.get(name);
    if (entry === undefined)
    {
        answer.writeHead(404, { "content-type": "application/json" });
        return answer.end(`{"error":"not found"}`);
    }
    if (tarball === undefined)
    {
        answer.writeHead(200, { "content-type": "application/json" });
        return answer.end(JSON.stringify(packument(entry, `http://${request.headers.host}`)));
    }
    answer.writeHead(200, { "content-type": "application/octet-stream" });
    answer.end(readFileSync(entry.file));
}

/* ── installing ────────────────────────────────────────────────────── */

async function installFrom(origin, box, spec)
{
    const home = join(box, "install");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "package.json"), `{"name":"smoke-install","private":true,"version":"0.0.0"}\n`);
    writeFileSync(join(box, "npmrc"), "");
    writeFileSync(join(box, "npmrc-global"), "");
    // A cache of its own, because two runs of this smoke ship different bytes
    // under the same name and version and a shared cache would serve the first.
    //
    // Both config files are emptied, not only the user's. `@superself:registry`
    // is a different key from `registry`, and a scoped one in the *global*
    // npmrc outranks the `--registry` below for exactly the scope this smoke
    // resolves the fold through — so a box that has one would install the fold
    // from somewhere else and the row would still read `ok`.
    const flags = ["--registry", origin, "--no-audit", "--no-fund", "--cache", join(box, "cache"),
        "--userconfig", join(box, "npmrc"), "--globalconfig", join(box, "npmrc-global")];
    const said = await spawnText("npm", ["install", spec, ...flags], home);
    return { home, installed: said.code === 0, said: said.out };
}

function spawnText(command, args, cwd)
{
    return new Promise((done) =>
    {
        const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (chunk) => { out += chunk; });
        child.stderr.on("data", (chunk) => { out += chunk; });
        child.on("close", (code) => done({ code, out }));
    });
}

function cliEnvironment(home)
{
    return {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_STATE_HOME: join(home, ".state"),
        GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
        GIT_AUTHOR_NAME: "smoke",
        GIT_AUTHOR_EMAIL: "smoke@test",
        GIT_COMMITTER_NAME: "smoke",
        GIT_COMMITTER_EMAIL: "smoke@test",
        SUPERSELF_SYNC: "off"
    };
}

// The installed binary, run as a binary — no `node` in front of it, so the
// shebang and the executable bit in the tarball are part of what passes. With
// no keyboard on stdin, so nothing here is ever asked a question.
function runSelf(binary, args, cwd, environment)
{
    const ran = spawnSync(binary, args, { cwd, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: ran.status ?? 1, out: `${ran.stdout ?? ""}${ran.stderr ?? ""}` };
}

/* ── the rows ──────────────────────────────────────────────────────── */

function checkTarballs(cli, fold)
{
    check("S1", cli.names.includes("package/bin/self.mjs") && cli.names.includes("package/dist/main.js"),
        "the CLI tarball carries its bin and its built dist");
    check("S2", fold.names.includes("package/dist/index.js") && fold.names.includes("package/dist/index.d.ts"),
        "the fold tarball carries the dist its exports point at");
    check("S3", cli.manifest.dependencies["@superself/fold"] === fold.manifest.version,
        `the packed CLI pins the fold at ${fold.manifest.version} (it says ${cli.manifest.dependencies["@superself/fold"]})`);
    check("S13", cli.names.includes("package/LICENSE") && fold.names.includes("package/LICENSE"),
        "both tarballs carry the Apache-2.0 licence their manifests declare");
}

function checkResolution(home, foldVersion)
{
    const cliRoot = join(home, "node_modules", "superself");
    const resolved = execFileSync(process.execPath, ["-e",
        `const { createRequire } = require("node:module");`
        + `process.stdout.write(createRequire(${JSON.stringify(join(cliRoot, "dist", "main.js"))}).resolve("@superself/fold"));`],
    { encoding: "utf8" });
    check("S5", resolvedInsideInstall(resolved, home, repoRoot),
        `the installed CLI resolves @superself/fold inside its own tree (${resolved})`);
    check("S6", JSON.parse(readFileSync(join(home, "node_modules", "@superself", "fold", "package.json"), "utf8")).version
        === foldVersion, `the fold beside it is ${foldVersion}`);
    check("S7", existsSync(join(home, "node_modules", "@superself", "fold", "dist", "index.js")),
        "the installed fold has the dist file its exports name");
    check("S8", escapingImports(join(cliRoot, "dist")).length === 0,
        `no built CLI module imports a path outside the installed package (${escapingImports(join(cliRoot, "dist")).join(", ")})`);
}

// The two sides of this comparison are reached differently: `home` descends from
// `os.tmpdir()`, which keeps whatever symlinks the path was written with, while
// `require.resolve` answers a real path. On macOS `/var` is a symlink to
// `/private/var` and `os.tmpdir()` is under it, so as written strings the two
// share no prefix at all and the row fails for a reason that has nothing to do
// with the tarball. Both sides are resolved to their real paths first — which
// also hardens the second half, since a checkout reached through a symlink
// would otherwise not be recognised as this repository.
export function resolvedInsideInstall(resolved, home, repository)
{
    const real = (path) => existsSync(path) ? realpathSync(path) : resolve(path);
    return resolved.startsWith(real(home)) && !resolved.startsWith(real(repository));
}

// A dist file is flat under `dist/`, so a specifier climbing out of it names
// something the tarball does not contain — the source tree it was built from.
function escapingImports(distributed)
{
    const escaping = [];
    for (const name of readdirSync(distributed).filter((file) => file.endsWith(".js")))
    {
        const source = readFileSync(join(distributed, name), "utf8");
        for (const found of source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g))
        {
            if (found[1].startsWith("../") || found[1].includes("apps/fold") || found[1].startsWith(repoRoot))
            {
                escaping.push(`${name}: ${found[1]}`);
            }
        }
    }
    return escaping;
}

function checkCommands(home, cliVersion)
{
    const binary = join(home, "node_modules", ".bin", "self");
    const workspace = join(home, "workspace");
    mkdirSync(workspace, { recursive: true });
    const environment = cliEnvironment(home);
    const version = runSelf(binary, ["--version"], workspace, environment);
    check("S9", version.code === 0 && version.out.includes(cliVersion),
        `the installed binary answers --version with ${cliVersion} (${version.out.trim()})`);
    const git = runSelf(binary, ["init", "--git"], workspace, environment);
    const status = runSelf(binary, ["status"], workspace, environment);
    check("S10", git.code === 0 && status.code === 0,
        `a git-mode store is made and read from the installed tree (${git.out.trim().split("\n").pop()})`);
    writeFileSync(join(workspace, ".superself", "workspace.json"),
        JSON.stringify({ base: "https://app.superselfs.com", wsId: "ws_01J8SMOKE", mode: "api" }) + "\n");
    const refused = runSelf(binary, ["store", "size"], workspace, environment);
    check("S11", refused.code !== 0 && /server-backed/.test(refused.out),
        `a git-only verb refuses in a server-backed store (${refused.out.trim().split("\n").pop()})`);
}

/* ── the run ───────────────────────────────────────────────────────── */

async function main()
{
    if (!existsSync(join(repoRoot, "apps/cli/dist/main.js")))
    {
        process.stderr.write("apps/cli/dist is not built — run `pnpm build` before the smoke\n");
        process.exit(1);
    }
    const box = mkdtempSync(join(tmpdir(), "self-pack-"));
    const packed = join(box, "packed");
    mkdirSync(packed);
    const fold = pack("apps/fold", packed);
    const cli = pack("apps/cli", packed);
    checkTarballs(cli, fold);
    const spec = `superself@${cli.manifest.version}`;
    const paired = await withRegistry([cli, fold], (origin) => installFrom(origin, box, spec));
    check("S4", paired.installed, `the CLI installs from a registry holding both packages${paired.installed ? "" : `: ${paired.said}`}`);
    if (paired.installed)
    {
        checkResolution(paired.home, fold.manifest.version);
        checkCommands(paired.home, cli.manifest.version);
    }
    const alone = mkdtempSync(join(tmpdir(), "self-pack-alone-"));
    const unpaired = await withRegistry([cli], (origin) => installFrom(origin, alone, spec));
    check("S12", !unpaired.installed,
        "the same install fails when the fold is not on the registry — the pin is resolved, not vendored");
    process.stderr.write(failures.length === 0 ? "" : `${failures.join("\n")}\n`);
    process.exit(failures.length === 0 ? 0 : 1);
}

// Imported by `scripts/pack-install-smoke.test.mjs`, which holds the pure part
// above; packing and installing is what `pnpm smoke` does, not what an import
// should.
if (process.argv[1] === fileURLToPath(import.meta.url))
{
    await main();
}
