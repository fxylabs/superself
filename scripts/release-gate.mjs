// What a `v*` tag has to be true of before anything is published (#430).
//
// The release publishes two packages from one tag: `@superself/fold` first,
// then `superself`, which depends on it. A run that gets halfway leaves the
// registry holding an unusable pair, and a version cannot be unpublished and
// republished — so every reason to refuse is collected here, before the first
// upload, and printed as sentences rather than as an exit code alone.
//
// The order the workflow publishes in is what makes a half-run survivable: an
// extra fold version nobody depends on is inert, while a CLI whose dependency
// is not on the registry cannot be installed by anyone. The gate refuses ahead
// of both; the order is the second line of defence.
//
// `releaseRefusals` is a pure function of facts so the rules can be tested
// without a registry, a tag, or a publish. The runner below is the only part
// that reads the disk, the network and git.
//
//   node scripts/release-gate.mjs --tag v0.13.0 [--branch origin/main]
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const FOLD_PACKAGE = "@superself/fold";

// The dependency fields npm uploads a spec from. `devDependencies` is not one
// of them: it is not installed from a published tarball, so a workspace spec
// there harms nobody.
const PUBLISHED_DEPENDENCIES = ["dependencies", "optionalDependencies", "peerDependencies"];

export function releaseRefusals(release)
{
    const { tag, cli, fold, publishedCli, publishedFold, tagOnMain } = release;
    return [
        ...tagRefusals(tag, cli.version, tagOnMain),
        // The tag names the CLI's version and never the fold's, so the tag's
        // own channel says nothing about which channel the fold lands on. Both
        // packages publish from this run, and both take npm's default dist-tag.
        ...channelRefusals("apps/fold/package.json", fold.version),
        ...workspaceSpecRefusals("apps/cli", cli),
        ...workspaceSpecRefusals("apps/fold", fold),
        ...pinRefusals(cli, fold.version),
        ...republishRefusals(cli.version, fold.version, publishedCli, publishedFold)
    ];
}

function tagRefusals(tag, cliVersion, tagOnMain)
{
    if (typeof tag !== "string" || tag === "")
    {
        return ["this run names no tag to publish — it is called with `--tag v0.13.0`, or from a `v*` tag push"];
    }
    const named = tag.startsWith("v") ? tag.slice(1) : tag;
    const refusals = [];
    if (named !== cliVersion)
    {
        refusals.push(`the tag \`${tag}\` names version ${named}, and apps/cli/package.json is at ${cliVersion} — `
            + "a release tag is the CLI's own version and nothing else");
    }
    if (tagOnMain !== true)
    {
        refusals.push(`the tag \`${tag}\` is on a commit that is not on \`main\` — a release is published from the `
            + "branch its pull requests were merged into, so nothing reaches the registry from a side branch");
    }
    refusals.push(...channelRefusals(`the tag \`${tag}\``, named));
    return refusals;
}

// Which dist-tag a prerelease belongs on is decided nowhere. Both `npm publish`
// calls in the workflow take the default, and neither manifest sets a
// `publishConfig.tag`, so a `v0.13.0-rc.1` tag would put an rc on `latest` and
// every `npm i -g superself` from then on would install it. A channel is not
// something a gate may invent, so until one is written down this refuses the
// grammar rather than guessing at it.
//
// `subject` is whatever spelled the version — the tag for the CLI's, the
// manifest for the fold's — because the two are refused for the same reason
// and the sentence has to name which one it read.
function channelRefusals(subject, named)
{
    const kind = named.includes("-") ? "a prerelease" : named.includes("+") ? "a build-metadata version" : "";
    if (kind === "")
    {
        return [];
    }
    return [`${subject} names ${named}, which is ${kind} — prerelease channels are not decided, and this `
        + "workflow publishes only finals: there is no dist-tag for it to land on but `latest`, which is what "
        + "an install naming no version reads from"];
}

// The guard that has stood in front of `npm publish` since the fold package
// existed, kept as the last line rather than replaced. `npm publish` uploads a
// `workspace:` spec verbatim, and a published package carrying one cannot be
// installed by anyone.
export function workspaceSpecRefusals(directory, manifest)
{
    const refusals = [];
    for (const field of PUBLISHED_DEPENDENCIES)
    {
        for (const [name, spec] of Object.entries(manifest[field] ?? {}))
        {
            if (String(spec).startsWith("workspace:"))
            {
                refusals.push(`${directory}/package.json depends on ${name} as \`${spec}\` — the workspace protocol is `
                    + "uploaded verbatim, so that tarball would be installable by nobody");
            }
        }
    }
    return refusals;
}

// The CLI's pin is the fold version being published in this same run, spelled
// exactly. A range would let one tag mean two different pairs depending on when
// it was installed, and the pair is what the suite proved.
function pinRefusals(cli, foldVersion)
{
    const spec = (cli.dependencies ?? {})[FOLD_PACKAGE];
    if (spec === undefined)
    {
        return [`apps/cli/package.json does not depend on ${FOLD_PACKAGE} — the CLI cannot be published without the `
            + "package it folds an event log with"];
    }
    if (String(spec).startsWith("workspace:") || spec === foldVersion)
    {
        return [];
    }
    return [`apps/cli/package.json pins ${FOLD_PACKAGE} at \`${spec}\`, and the version this run publishes is `
        + `${foldVersion} — the pin is the exact version released beside it, so the pair the suite proved is the `
        + "pair a person installs"];
}

// A version the registry already holds is a refusal, because a published
// version is never replaced. One shape of it is not a mistake, though, and
// "raise the version" is the wrong answer to it: the fold published, the CLI's
// job then failed, and the same tag is being run again. Nothing there needs a
// new number — only the job that failed needs re-running — so that state gets
// a sentence of its own rather than sending the operator to bump a version
// that is not on the registry at all.
function republishRefusals(cliVersion, foldVersion, publishedCli, publishedFold)
{
    const cliIsPublished = publishedCli.includes(cliVersion);
    const foldIsPublished = publishedFold.includes(foldVersion);
    if (foldIsPublished && !cliIsPublished)
    {
        return [halfRunRefusal(cliVersion, foldVersion)];
    }
    return [
        ...alreadyPublished("superself", cliVersion, cliIsPublished),
        ...alreadyPublished(FOLD_PACKAGE, foldVersion, foldIsPublished)
    ];
}

function alreadyPublished(name, version, published)
{
    if (!published)
    {
        return [];
    }
    return [`${name}@${version} is already on the registry — a published version is never replaced, so raise the `
        + "version and tag again rather than finding this out halfway through the run"];
}

function halfRunRefusal(cliVersion, foldVersion)
{
    return `${FOLD_PACKAGE}@${foldVersion} is already on the registry and superself@${cliVersion} is not. If this `
        + "tag's run published the fold and then stopped, finish it with \"Re-run failed jobs\" on that workflow "
        + "run: the CLI's version is not on the registry and needs no raise, and re-running the whole workflow "
        + "only arrives back at this sentence. Otherwise the fold's version has to be raised beside the CLI's, "
        + "because a published version is never replaced.";
}

/* ── the runner: the only part that reads disk, network and git ───── */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export function readManifest(directory)
{
    return JSON.parse(readFileSync(new URL(`../${directory}/package.json`, import.meta.url), "utf8"));
}

// What the registry already holds. A package nobody has published yet answers
// 404, which is the expected state for the fold's first release and not a
// failure — every other error is, and is left to throw so the gate stops
// rather than reading "no versions" out of an outage.
export function publishedVersions(name)
{
    const answer = npmView(name);
    if (answer === undefined)
    {
        return [];
    }
    return Array.isArray(answer) ? answer : [answer];
}

function npmView(name)
{
    const asked = spawnSync("npm", ["view", name, "versions", "--json"], { encoding: "utf8" });
    const said = `${asked.stdout ?? ""}${asked.stderr ?? ""}`.trim() || String(asked.error?.message ?? "");
    if (asked.status === 0)
    {
        return JSON.parse(asked.stdout);
    }
    if (said.includes("E404"))
    {
        return undefined;
    }
    throw new Error(`the registry could not be asked what versions of ${name} it holds — ${said}`);
}

// Whether the commit being published is on the release branch. A ref this
// checkout cannot resolve is a refusal and never a pass: "we could not tell"
// and "it is on main" are different answers, and only one of them may publish.
export function commitIsOn(branch, at = repoRoot)
{
    return spawnSync("git", ["merge-base", "--is-ancestor", "HEAD", branch], { cwd: at, stdio: "ignore" }).status === 0;
}

function argument(flag, fallback)
{
    const at = process.argv.indexOf(flag);
    return at === -1 ? fallback : process.argv[at + 1];
}

function main()
{
    const tag = argument("--tag", process.env.GITHUB_REF_NAME ?? "");
    const branch = argument("--branch", "origin/main");
    const refusals = releaseRefusals({
        tag,
        cli: readManifest("apps/cli"),
        fold: readManifest("apps/fold"),
        publishedCli: publishedVersions("superself"),
        publishedFold: publishedVersions(FOLD_PACKAGE),
        tagOnMain: commitIsOn(branch)
    });
    for (const refusal of refusals)
    {
        process.stderr.write(`${refusal}\n`);
    }
    process.stdout.write(refusals.length === 0 ? `${tag} may be published\n` : "");
    process.exit(refusals.length === 0 ? 0 : 1);
}

// The gate fails closed on a registry it cannot be asked, and says so in the
// same shape as every refusal above: one sentence on stderr, exit 1. A stack
// trace here would read as a bug in this script rather than as the outage it is.
function run()
{
    try
    {
        main();
    }
    catch (reason)
    {
        process.stderr.write(`${reason.message}\n`);
        process.exit(1);
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
{
    run();
}
