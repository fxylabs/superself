import { headCommit, git, gitInput } from "./gitutil.js";
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
}

export interface HarvestResult
{
    recorded: number;
    skipped: number;
}

export function harvestHead(ctx: ProjectContext): HarvestResult
{
    const commit = headCommit(ctx.projectDir);
    if (commit === null)
    {
        return { recorded: 0, skipped: 0 };
    }
    const message = git(ctx.projectDir, "show", "-s", "--format=%B", "HEAD");
    if (!message.ok)
    {
        throw new CliError(`could not read HEAD for trailer harvesting: ${message.err}`);
    }
    const trailers = parseTrailers(message.out);
    if (trailers.length === 0)
    {
        return { recorded: 0, skipped: 0 };
    }
    const assertions = validate(ctx, trailers, commit, revisionOf(ctx.projectDir));
    const events = readEvents(ctx.storeDir, ctx.project);
    let recorded = 0;
    let skipped = 0;
    for (const assertion of assertions)
    {
        if (events.some((event) => duplicateOf(event, assertion, commit)))
        {
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
                summary: trailer.value
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
        if (work.status === "done")
        {
            throw new CliError(`Report: trailer names completed work ${report[1]}`);
        }
        return {
            trailer,
            type: "report.added",
            payload: { text: report[2], source },
            refs: { work: work.id, commits: [commit] },
            summary: `${work.id} ${report[2]}`
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

function revisionOf(projectDir: string): string
{
    const diff = git(projectDir, "show", "--pretty=format:", "--no-ext-diff", "--binary", "HEAD");
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
    const tree = git(projectDir, "rev-parse", "HEAD^{tree}");
    return tree.ok ? `tree:${tree.out}` : "tree:unknown";
}

function normalize(value: string): string
{
    return value.trim().replace(/\s+/g, " ");
}
