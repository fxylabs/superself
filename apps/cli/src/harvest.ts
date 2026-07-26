import { git, gitInput } from "./gitutil.js";
import { readEvents } from "./logfile.js";
import { buildModel } from "./model.js";
import { CliContext } from "./paths.js";
import { makeEvent, recordEvent } from "./pipeline.js";
import { CliError, EventRefs, SelfEvent } from "./types.js";

type ProjectContext = CliContext & { project: string; projectDir: string };

interface Trailer
{
    token: "Report" | "Decide";
    value: string;
}

interface Assertion
{
    trailer: Trailer;
    type: "report.added" | "decision.proposed";
    payload: Record<string, unknown>;
    refs: EventRefs;
    summary: string;
    completedWork: boolean;
}

export interface HarvestResult
{
    recorded: number;
    skipped: number;
}

export function harvestHead(ctx: ProjectContext): HarvestResult
{
    return harvestCommit(ctx, "HEAD");
}

export function harvestAll(ctx: ProjectContext): HarvestResult
{
    const revisions = git(ctx.projectDir, "rev-list", "--reverse", "HEAD");
    if (!revisions.ok)
    {
        return { recorded: 0, skipped: 0 };
    }
    return harvestMany(ctx, revisions.out.split("\n").filter(Boolean));
}

export function harvestRewrites(ctx: ProjectContext, mappings: string): HarvestResult
{
    const revisions = mappings.split("\n").flatMap((line): string[] =>
    {
        const parts = line.trim().split(/\s+/);
        return parts.length >= 2 && !/^0+$/.test(parts[1]) ? [parts[1]] : [];
    });
    return harvestMany(ctx, [...new Set(revisions)]);
}

function harvestMany(ctx: ProjectContext, revisions: string[]): HarvestResult
{
    const total: HarvestResult = { recorded: 0, skipped: 0 };
    const failures: string[] = [];
    for (const revision of revisions)
    {
        try
        {
            const result = harvestCommit(ctx, revision);
            total.recorded += result.recorded;
            total.skipped += result.skipped;
        }
        catch (error)
        {
            if (!(error instanceof CliError))
            {
                throw error;
            }
            failures.push(`${revision.slice(0, 12)}: ${error.message}`);
        }
    }
    if (failures.length > 0)
    {
        throw new CliError(`harvest processed ${revisions.length} commits (${total.recorded} recorded, ${total.skipped} already current) with ${failures.length} failure(s):\n- ${failures.join("\n- ")}`);
    }
    return total;
}

function harvestCommit(ctx: ProjectContext, revision: string): HarvestResult
{
    const resolved = git(ctx.projectDir, "rev-parse", "--short=12", `${revision}^{commit}`);
    if (!resolved.ok)
    {
        return { recorded: 0, skipped: 0 };
    }
    const commit = resolved.out;
    const message = git(ctx.projectDir, "show", "-s", "--format=%B", revision);
    if (!message.ok)
    {
        throw new CliError(`could not read ${revision} for trailer harvesting: ${message.err}`);
    }
    const trailers = parseTrailers(message.out);
    if (trailers.length === 0)
    {
        return { recorded: 0, skipped: 0 };
    }
    const assertions = validate(ctx, trailers, commit, revisionOf(ctx.projectDir, revision));
    const events = readEvents(ctx.storeDir, ctx.project);
    const prepared = assertions.map((assertion) => ({
        assertion,
        original: events.find((event) => duplicateOf(event, assertion, commit))
    }));
    const completed = prepared.find((item) => item.assertion.completedWork && item.original === undefined);
    if (completed !== undefined)
    {
        throw new CliError(`Report: trailer names completed work ${completed.assertion.refs.work}`);
    }
    let recorded = 0;
    let skipped = 0;
    for (const { assertion, original } of prepared)
    {
        if (original !== undefined)
        {
            const current = currentCommits(events, original);
            const replaces = current.filter((hash) => hash !== commit && !reachableFromRef(ctx.projectDir, hash));
            if (!current.includes(commit) || replaces.length > 0)
            {
                const refs: EventRefs = { assertion: original.id, commits: [commit] };
                if (original.refs?.work !== undefined)
                {
                    refs.work = original.refs.work;
                }
                const event = makeEvent(ctx.project, "evidence.attached", { text: assertion.summary, replaces }, refs);
                recordEvent(ctx, event, `${assertion.summary} evidence now includes ${commit}`);
                events.push(event);
                recorded += 1;
                continue;
            }
            skipped += 1;
            continue;
        }
        const event = makeEvent(ctx.project, assertion.type, assertion.payload, assertion.refs);
        recordEvent(ctx, event, assertion.summary);
        events.push(event);
        recorded += 1;
    }
    return { recorded, skipped };
}

function currentCommits(events: SelfEvent[], original: SelfEvent): string[]
{
    let current = [...(original.refs?.commits ?? [])];
    for (const event of events)
    {
        if (event.type === "evidence.attached" && event.refs?.assertion === original.id)
        {
            const replaced = Array.isArray(event.payload.replaces)
                ? event.payload.replaces.map(String)
                : [];
            current = current.filter((hash) => !replaced.includes(hash));
            for (const hash of event.refs.commits ?? [])
            {
                if (!current.includes(hash))
                {
                    current.push(hash);
                }
            }
        }
    }
    return current;
}

// A cherry-picked incarnation can remain live beside the new commit. Remove
// old evidence only after Git's refs positively show that no branch, tag, or
// other real ref still contains it; reflogs alone do not keep it current.
function reachableFromRef(projectDir: string, commit: string): boolean
{
    if (!git(projectDir, "cat-file", "-e", `${commit}^{commit}`).ok)
    {
        return false;
    }
    return git(projectDir, "for-each-ref", "--contains", commit, "--format=%(refname)").out !== "";
}

// Only the final, blank-line-delimited paragraph is a trailer block. This
// keeps a subject such as "Decide: ..." from becoming state by accident.
function parseTrailers(message: string): Trailer[]
{
    const lines = message.replace(/\r\n/g, "\n").split("\n");
    while (lines.length > 0 && lines[lines.length - 1].trim() === "")
    {
        lines.pop();
    }
    let start = lines.length - 1;
    while (start >= 0 && lines[start].trim() !== "")
    {
        start -= 1;
    }
    if (start < 0 || start === lines.length - 1)
    {
        return [];
    }
    const parsed: Array<{ token: string; value: string }> = [];
    for (const line of lines.slice(start + 1))
    {
        const match = line.match(/^([A-Za-z0-9][A-Za-z0-9-]*):[ \t]*(.*)$/);
        if (match !== null)
        {
            parsed.push({ token: match[1], value: match[2] });
            continue;
        }
        if (/^[ \t]+\S/.test(line) && parsed.length > 0)
        {
            parsed[parsed.length - 1].value += ` ${line.trim()}`;
            continue;
        }
        return [];
    }
    return parsed.flatMap((item): Trailer[] =>
    {
        const token = item.token.toLowerCase();
        if (token !== "report" && token !== "decide")
        {
            return [];
        }
        return [{
            token: token === "report" ? "Report" : "Decide",
            value: normalize(item.value)
        }];
    });
}

function validate(ctx: ProjectContext, trailers: Trailer[], commit: string, revision: string): Assertion[]
{
    const works = buildModel(ctx.storeDir, ctx.project, new Date()).works;
    return trailers.map((trailer): Assertion =>
    {
        const source = { kind: "commit-trailer", token: trailer.token, value: trailer.value, revision };
        if (trailer.token === "Decide")
        {
            if (trailer.value === "")
            {
                throw new CliError("Decide: trailer requires decision text");
            }
            return {
                trailer,
                type: "decision.proposed",
                payload: { text: trailer.value, source },
                refs: { commits: [commit] },
                summary: trailer.value,
                completedWork: false
            };
        }
        const report = trailer.value.match(/^(w-[a-z0-9]+)\s+(.+)$/);
        if (report === null)
        {
            throw new CliError("Report: trailer requires <work-id> <summary>");
        }
        const work = works.find((item) => item.id === report[1]);
        if (work === undefined)
        {
            throw new CliError(`Report: trailer names unknown work id "${report[1]}"`);
        }
        return {
            trailer,
            type: "report.added",
            payload: { text: report[2], source },
            refs: { work: work.id, commits: [commit] },
            summary: `${work.id} ${report[2]}`,
            completedWork: work.status === "done"
        };
    });
}

function duplicateOf(event: SelfEvent, assertion: Assertion, commit: string): boolean
{
    if (event.type !== assertion.type)
    {
        return false;
    }
    const source = event.payload.source;
    if (isSource(source)
        && source.token === assertion.trailer.token
        && normalize(source.value) === assertion.trailer.value
        && source.revision === sourceOf(assertion).revision)
    {
        // Patch identity survives no-change amend, rebase, and cherry-pick,
        // without suppressing the same prose on a genuinely different change.
        return true;
    }
    if (!(event.refs?.commits ?? []).includes(commit))
    {
        return false;
    }
    if (assertion.type === "report.added")
    {
        return event.refs?.work === assertion.refs.work
            && event.payload.text === assertion.payload.text;
    }
    return event.payload.text === assertion.payload.text;
}

function sourceOf(assertion: Assertion): { revision: string }
{
    return assertion.payload.source as { revision: string };
}

function isSource(value: unknown): value is { kind: string; token: string; value: string; revision: string }
{
    return typeof value === "object" && value !== null
        && "kind" in value && value.kind === "commit-trailer"
        && "token" in value && typeof value.token === "string"
        && "value" in value && typeof value.value === "string"
        && "revision" in value && typeof value.revision === "string";
}

function revisionOf(projectDir: string, revision: string): string
{
    const diff = git(projectDir, "show", "--pretty=format:", "--no-ext-diff", "--binary", revision);
    if (diff.ok && diff.out !== "")
    {
        const patch = gitInput(projectDir, diff.out + "\n", "patch-id", "--stable");
        const id = patch.ok ? patch.out.split(/\s+/)[0] : "";
        if (id !== "")
        {
            return `patch:${id}`;
        }
    }
    // Empty and merge commits may have no patch-id. A tree id still makes a
    // no-change amend stable while avoiding dependence on the rewritten hash.
    const tree = git(projectDir, "rev-parse", `${revision}^{tree}`);
    return tree.ok ? `tree:${tree.out}` : "tree:unknown";
}

function normalize(value: string): string
{
    return value.trim().replace(/\s+/g, " ");
}
