// The five model-facing tools. Each maps its arguments onto one `self` argv
// and returns whatever the runner answers — a refusal is a message the model
// reads, never a throw.

import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { WORK_ID } from "./self.js";
import type { RunOutcome } from "./self.js";

export type Runner = (argv: string[], signal?: AbortSignal) => Promise<RunOutcome>;

const TEXT_OUTPUT = {
    schema: { type: "string" },
    render: (_args: unknown, value: string) => [{ type: "text" as const, text: value }],
} as const;

function badId(id: string | undefined, verb: string): string
{
    const given = id === undefined || id === "" ? "no id" : `"${id}"`;
    return `superself_work ${verb} needs a work id like \`w-abc12\` (got ${given}). Run superself_work with action "list" to see the open ids.`;
}

function emptyText(tool: string, field: string): string
{
    return `${tool} needs a non-empty \`${field}\`; nothing was recorded.`;
}

function contextTool(run: Runner): ToolDefinition
{
    return defineTool({
        name: "superself_context",
        description: "Print the project's current state from Superself: goal, active decisions, conventions, open work, deadlines, and what is waiting on a human. Read this before planning work. Runs `self context`.",
        parameters: {},
        output: TEXT_OUTPUT,
        isConcurrencySafe: () => true,
        execute: (_args, exec) => run(["context"], exec.signal).then((outcome) => outcome.text),
    });
}

// The operating manual a session follows, whole (#440). It is a separate tool
// from `superself_context` because it is a separate command: an instruction is
// outside the context render budget, so the two are read together and neither
// is spliced into the other.
function instructionsTool(run: Runner): ToolDefinition
{
    return defineTool({
        name: "superself_instructions",
        description: "Print the instructions this Superself workspace holds: the execution rules, tool notes and procedures every session here follows, grouped by kind. Read it at session start beside superself_context and follow it. Runs `self instruction render`.",
        parameters: {},
        output: TEXT_OUTPUT,
        isConcurrencySafe: () => true,
        execute: (_args, exec) => run(["instruction", "render"], exec.signal).then((outcome) => outcome.text),
    });
}

function workArgv(action: "list" | "show" | "start", id: string | undefined): string[] | string
{
    if (action === "list")
    {
        return ["work"];
    }
    if (id === undefined || !WORK_ID.test(id))
    {
        return badId(id, action);
    }
    return ["work", action, id];
}

function workTool(run: Runner): ToolDefinition
{
    return defineTool({
        name: "superself_work",
        description: "Superself work units. `list` prints the open work (`self work`); `show <id>` prints a unit's brief, reports and evidence; `start <id>` claims a unit for this session and prints its brief. Ids look like `w-abc12`.",
        parameters: {
            action: { type: "string", enum: ["list", "show", "start"], required: true, description: "list | show | start" },
            id: { type: "string", description: "The work id (required for show and start)." },
        },
        output: TEXT_OUTPUT,
        isConcurrencySafe: (args) => args.action !== "start",
        execute: async (args, exec) =>
        {
            const argv = workArgv(args.action, args.id);
            return typeof argv === "string" ? argv : (await run(argv, exec.signal)).text;
        },
    });
}

function reportArgv(id: string, text: string, evidence: string | undefined): string[] | string
{
    if (!WORK_ID.test(id))
    {
        return badId(id, "report").replace("superself_work report", "superself_report");
    }
    if (text.trim() === "")
    {
        return emptyText("superself_report", "text");
    }
    const flags = evidence === undefined || evidence.trim() === "" ? [] : ["--evidence", evidence.trim()];
    // `--` ends option parsing, so a summary that starts with a dash stays text.
    return ["report", id, ...flags, "--", text.trim()];
}

function reportTool(run: Runner): ToolDefinition
{
    return defineTool({
        name: "superself_report",
        description: "Record progress on a Superself work unit: what verifiably happened, optionally with a commit hash as evidence. Runs `self report <id> \"<text>\" [--evidence <commit>]`. Use it at each checkpoint and when the unit's outcome is reached.",
        parameters: {
            id: { type: "string", required: true, description: "The work id, like `w-abc12`." },
            text: { type: "string", required: true, description: "What verifiably happened, in one or two sentences." },
            evidence: { type: "string", description: "A commit hash or other verifiable evidence." },
        },
        output: TEXT_OUTPUT,
        execute: async (args, exec) =>
        {
            const argv = reportArgv(args.id, args.text, args.evidence);
            return typeof argv === "string" ? argv : (await run(argv, exec.signal)).text;
        },
    });
}

function decideArgv(text: string, why: string | undefined): string[] | string
{
    if (text.trim() === "")
    {
        return emptyText("superself_decide", "text");
    }
    const flags = why === undefined || why.trim() === "" ? [] : ["--why", why.trim()];
    return ["decide", ...flags, "--", text.trim()];
}

function decideTool(run: Runner): ToolDefinition
{
    return defineTool({
        name: "superself_decide",
        description: "Record a project decision in Superself so later sessions, models and tools read it. Runs `self decide \"<text>\" [--why <reason>]`. Record only decisions the user made or confirmed.",
        parameters: {
            text: { type: "string", required: true, description: "The decision, stated as a fact." },
            why: { type: "string", description: "Why it was decided." },
        },
        output: TEXT_OUTPUT,
        execute: async (args, exec) =>
        {
            const argv = decideArgv(args.text, args.why);
            return typeof argv === "string" ? argv : (await run(argv, exec.signal)).text;
        },
    });
}

export function superselfTools(run: Runner): ToolDefinition[]
{
    return [contextTool(run), workTool(run), reportTool(run), decideTool(run), instructionsTool(run)];
}
