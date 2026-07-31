// The geometry of the terminal render, checked two ways.
//
// A rule line is box characters only, every one of them a single cell, so its
// code-point count is the width the terminal will really draw. Every other
// line of that table must measure the same — that is what catches a padding or
// a truncation bug. The width table itself cannot be checked against its own
// output, so the expectations below pin it to stated values instead.

import { readFileSync } from "node:fs";
import { displayWidth } from "../dist/style.js";

// Built from code points rather than written as literals: a zero-width
// character is invisible in a source file, and an editor that normalizes a
// combining sequence would silently retune the expectation it is here to pin.
const text = (...codes) => String.fromCodePoint(...codes);

const EXPECTED = [
    ["empty", "", 0],
    ["ascii", "abc", 3],
    ["hangul syllables", text(0xac00, 0xb098), 4],
    ["han", text(0x65e5, 0x672c, 0x8a9e), 6],
    ["emoji", text(0x1f600), 2],
    ["precomposed e-acute", text(0xe9), 1],
    ["combining e-acute", text(0x65, 0x301), 1],
    ["zero-width space", text(0x200b), 0],
    ["unassigned code point", text(0x378), 1],
    ["mixed script", text(0xac00, 0xb098, 0x41, 0x42, 0x43), 7]
];

function fail(message)
{
    console.error(`proof FAILED: ${message}`);
    process.exit(1);
}

for (const [name, value, expected] of EXPECTED)
{
    const measured = displayWidth(value);
    if (measured !== expected)
    {
        fail(`display width of the ${name} case is ${measured}, expected ${expected}`);
    }
}

const lines = readFileSync(0, "utf8").split("\n").filter((line) => /[┌┬┐├┼┤└┴┘│]/.test(line));
if (lines.length === 0)
{
    fail("the rendered output carried no ruled table at all");
}

const rules = lines.filter((line) => /^[┌├└][─┬┼┴]*[┐┤┘]$/.test(line));
if (rules.length < 3)
{
    fail(`a ruled table needs a top, a header and a bottom rule; found ${rules.length}`);
}

const width = [...rules[0]].length;
for (const rule of rules)
{
    if ([...rule].length !== width)
    {
        fail(`rule lines disagree on the table width: ${width} against ${[...rule].length}`);
    }
}
for (const line of lines)
{
    const measured = displayWidth(line);
    if (measured !== width)
    {
        fail(`a table line measured ${measured} cells against a ${width}-cell rule: ${JSON.stringify(line)}`);
    }
}

console.log(`pretty width OK (${lines.length} lines at ${width} cells)`);
