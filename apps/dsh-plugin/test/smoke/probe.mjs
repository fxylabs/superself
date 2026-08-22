// Smoke probe — see README.md beside this file. A throwaway plugin layered
// onto a dsh profile with --patch: it reads the real tool registry the
// installed dsh-plugin-superself registered into, calls the tools through
// ctx.tools.execute, checks the /self command, prints, and exits. Node's
// `--test` runner does not pick it up (not *.test.mjs).
export const name = "superself-probe";
export const inject = ["tools"];

function show(label, result)
{
    const text = result.content.map((block) => block.type === "text" ? block.text : `[${block.type}]`).join("");
    console.log(`\n=== ${label} (isError=${result.isError})\n${text}`);
}

export async function apply(ctx)
{
    // Give the superself plugin's own apply a tick to register.
    await new Promise((done) => setTimeout(done, 500));
    const names = ctx.tools.schemas().map((schema) => schema.name).filter((n) => n.startsWith("superself_"));
    console.log("=== superself tools in the registry:", JSON.stringify(names));
    const signal = new AbortController().signal;
    const call = (id, toolName, args) => ctx.tools.execute({ callId: id, name: toolName, arguments: args, signal });
    show("superself_context", await call("probe-1", "superself_context", {}));
    show("superself_work list", await call("probe-2", "superself_work", { action: "list" }));
    show("superself_work show bad id", await call("probe-3", "superself_work", { action: "show", id: "w-../x" }));
    show("superself_report empty text", await call("probe-4", "superself_report", { id: "w-abc12", text: " " }));
    show("superself_decide", await call("probe-5", "superself_decide", { text: "smoke: dsh plugin called self decide", why: "smoke test" }));
    show("superself_context after decide", await call("probe-6", "superself_context", {}));
    let commandSeen = "commands service not composed in this profile";
    ctx.inject(["commands"], (scope) =>
    {
        const found = scope.commands.find({ id: "probe-agent" }, "self");
        commandSeen = found === undefined ? "/self NOT registered" : `/self registered: ${found.description}`;
    });
    await new Promise((done) => setTimeout(done, 300));
    console.log(`\n=== command: ${commandSeen}`);
    console.log("\n=== PROBE DONE");
    process.exit(0);
}
