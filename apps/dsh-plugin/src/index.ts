// dsh-plugin-superself: the `self` CLI as DeepSeek Harness tools and a /self
// command. A thin adapter — every verb shells out to the installed `self`.

import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import type { CommandResult } from "@deepseek-ai/dsh-commands";
import { runSelf } from "./self.js";
import { superselfTools } from "./tools.js";
import type { Runner } from "./tools.js";

export const name = "superself";
export const inject = ["tools"];

export interface Config
{
    selfBinary: string;
    cwd: string;
    maxOutputChars: number;
}

export const Config: Schema<Config> = Schema.object({
    selfBinary: Schema.string().default("self")
        .description("The self binary: a name looked up on PATH, or a full path."),
    cwd: Schema.string().default("")
        .description("Directory to run self in; the project root is found by walking up to the nearest `.self`. Empty = the directory dsh was started in."),
    maxOutputChars: Schema.number().default(20000)
        .description("Longest tool output returned to the model; longer output keeps its head and ends with a truncation marker."),
});

function runner(config: Config): Runner
{
    return (argv, signal) => runSelf(argv, {
        binary: config.selfBinary,
        cwd: config.cwd === "" ? process.cwd() : config.cwd,
        maxOutputChars: config.maxOutputChars,
        signal,
    });
}

export function apply(ctx: Context, config: Config): void
{
    const run = runner(config);
    for (const tool of superselfTools(run))
    {
        ctx.tools.register(tool);
    }
    // The command registry is a UI-side service headless compositions omit;
    // the tools register either way and the command only where it exists.
    ctx.inject(["commands"], (scope) =>
    {
        scope.commands.register({
            name: "self",
            description: "print the project's current state from Superself (self context)",
            handler: async (invocation): Promise<CommandResult> =>
            {
                const outcome = await run(["context"], invocation.signal);
                return { kind: outcome.ok ? "success" : "error", text: outcome.text };
            },
        });
    });
}
