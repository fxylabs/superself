import { test } from "node:test";
import assert from "node:assert/strict";
import { dayIn, daysBetween, validDate, validZone } from "../dist/dates.js";
import { CliError } from "../dist/types.js";

test("validDate accepts YYYY-MM-DD and rejects everything else", () =>
{
    assert.equal(validDate(" 2026-08-03 "), "2026-08-03");
    assert.throws(() => validDate("2026-8-3"), CliError);
    assert.throws(() => validDate("2026-13-45"), CliError);
    assert.throws(() => validDate("tomorrow"), CliError);
});

test("validZone accepts an IANA name and rejects an invented one", () =>
{
    assert.equal(validZone("Asia/Seoul"), "Asia/Seoul");
    assert.throws(() => validZone("Mars/Olympus"), CliError);
});

test("dayIn judges the calendar day in the recorded zone, not the machine's", () =>
{
    const when = new Date("2026-01-01T20:00:00Z");
    assert.equal(dayIn(when, "UTC"), "2026-01-01");
    assert.equal(dayIn(when, "Asia/Seoul"), "2026-01-02");
});

test("daysBetween counts whole days and goes negative past the target", () =>
{
    assert.equal(daysBetween("2026-08-01", "2026-08-03"), 2);
    assert.equal(daysBetween("2026-08-03", "2026-08-01"), -2);
    assert.equal(daysBetween("2026-08-03", "2026-08-03"), 0);
});
