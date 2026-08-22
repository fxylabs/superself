import assert from "node:assert/strict";
import { test } from "node:test";
import { superselfTools } from "../lib/tools.js";

// A runner that records the argv it was handed; the tools never see a real self.
function fixture()
{
    const calls = [];
    const run = async (argv) =>
    {
        calls.push(argv);
        return { ok: true, text: `ran: ${argv.join(" ")}` };
    };
    const tools = Object.fromEntries(superselfTools(run).map((tool) => [tool.name, tool]));
    return { calls, tools };
}

const exec = { signal: undefined };

test("the four tools register under stable names with string output", () =>
{
    const { tools } = fixture();
    assert.deepEqual(Object.keys(tools).sort(),
        ["superself_context", "superself_decide", "superself_report", "superself_work"]);
    for (const tool of Object.values(tools))
    {
        assert.equal(tool.output.schema.type, "string");
        assert.deepEqual(tool.output.render({}, "hello"), [{ type: "text", text: "hello" }]);
    }
});

test("argv mapping: context", async () =>
{
    const { calls, tools } = fixture();
    assert.equal(await tools.superself_context.execute({}, exec), "ran: context");
    assert.deepEqual(calls, [["context"]]);
});

test("argv mapping: work list / show / start", async () =>
{
    const { calls, tools } = fixture();
    await tools.superself_work.execute({ action: "list" }, exec);
    await tools.superself_work.execute({ action: "show", id: "w-abc12" }, exec);
    await tools.superself_work.execute({ action: "start", id: "w-rwmxx" }, exec);
    assert.deepEqual(calls, [["work"], ["work", "show", "w-abc12"], ["work", "start", "w-rwmxx"]]);
});

test("argv mapping: report with and without evidence, text after `--`", async () =>
{
    const { calls, tools } = fixture();
    await tools.superself_report.execute({ id: "w-abc12", text: "  shipped it  " }, exec);
    await tools.superself_report.execute({ id: "w-abc12", text: "-starts with a dash", evidence: "0b8806c" }, exec);
    assert.deepEqual(calls, [
        ["report", "w-abc12", "--", "shipped it"],
        ["report", "w-abc12", "--evidence", "0b8806c", "--", "-starts with a dash"],
    ]);
});

test("argv mapping: decide with and without --why", async () =>
{
    const { calls, tools } = fixture();
    await tools.superself_decide.execute({ text: "sessions are JWT" }, exec);
    await tools.superself_decide.execute({ text: "--no cookies", why: "mobile shares the API" }, exec);
    assert.deepEqual(calls, [
        ["decide", "--", "sessions are JWT"],
        ["decide", "--why", "mobile shares the API", "--", "--no cookies"],
    ]);
});

test("defect 6: an id that is not `w-[a-z0-9]+` is refused before anything runs", async () =>
{
    const { calls, tools } = fixture();
    for (const id of [undefined, "", "w-", "w-ABC12", "w-../x", "o-gn3t3", "w-abc12 --force", "w-abc12\n"])
    {
        const shown = await tools.superself_work.execute({ action: "show", ...(id === undefined ? {} : { id }) }, exec);
        assert.match(shown, /needs a work id like `w-abc12`/, `show ${JSON.stringify(id)}`);
        const started = await tools.superself_work.execute({ action: "start", ...(id === undefined ? {} : { id }) }, exec);
        assert.match(started, /needs a work id like `w-abc12`/, `start ${JSON.stringify(id)}`);
    }
    const reported = await tools.superself_report.execute({ id: "w-ABC", text: "x" }, exec);
    assert.match(reported, /^superself_report needs a work id like `w-abc12`/);
    assert.deepEqual(calls, []);
});

test("defect 7: report and decide refuse empty text without running self", async () =>
{
    const { calls, tools } = fixture();
    assert.match(await tools.superself_report.execute({ id: "w-abc12", text: "   " }, exec), /non-empty `text`; nothing was recorded/);
    assert.match(await tools.superself_decide.execute({ text: "" }, exec), /non-empty `text`; nothing was recorded/);
    assert.deepEqual(calls, []);
});

test("the registry's own validation still refuses arguments outside the schema", async () =>
{
    const { calls, tools } = fixture();
    await assert.rejects(() => tools.superself_work.execute({ action: "delete" }, exec));
    await assert.rejects(() => tools.superself_report.execute({ id: "w-abc12" }, exec));
    assert.deepEqual(calls, []);
});

test("reads may run in parallel; writes stay exclusive", () =>
{
    const { tools } = fixture();
    assert.equal(tools.superself_context.isConcurrencySafe({}), true);
    assert.equal(tools.superself_work.isConcurrencySafe({ action: "list" }), true);
    assert.equal(tools.superself_work.isConcurrencySafe({ action: "start", id: "w-abc12" }), false);
    assert.equal(tools.superself_report.isConcurrencySafe, undefined);
    assert.equal(tools.superself_decide.isConcurrencySafe, undefined);
});
