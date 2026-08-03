import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommand, subcommand } from "../dist/args.js";
import { CliError } from "../dist/types.js";

test("parseCommand returns declared options and positionals", () =>
{
    const parsed = parseCommand("work", ["w-abc", "--why", "because"], { why: { type: "string" } }, 1);
    assert.equal(parsed.positionals[0], "w-abc");
    assert.equal(parsed.values.why, "because");
});

test("parseCommand names an extra positional instead of dropping it", () =>
{
    assert.throws(
        () => parseCommand("work", ["w-abc", "stray"], {}, 1),
        (error) => error instanceof CliError && error.message.includes("unexpected argument 'stray'")
    );
});

test("parseCommand refuses an undeclared option", () =>
{
    assert.throws(() => parseCommand("work", ["--nope"], {}, 0));
});

test("subcommand hands back the first argument", () =>
{
    assert.equal(subcommand("work", ["add", "outcome"]), "add");
    assert.equal(subcommand("work", []), undefined);
});

test("subcommand refuses -- and option-looking arguments", () =>
{
    assert.throws(() => subcommand("work", ["--"]), CliError);
    assert.throws(
        () => subcommand("work", ["--bad"]),
        (error) => error instanceof CliError && error.message.includes("unknown option '--bad'")
    );
});
