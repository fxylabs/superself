// Human-facing terminal styling. Enabled only on an interactive stdout so that
// piped output — what agents and the proof suite consume — stays byte-identical.
// A dumb terminal reports itself as interactive but renders no escape
// sequence, so it is answered like a pipe rather than shown raw control bytes.
const dumb = process.env.TERM === "dumb";
const enabled = process.stdout.isTTY === true && process.env.NO_COLOR === undefined && !dumb;

export const styled = enabled;

// Whether the terminal can render anything beyond plain lines at all. Colour
// is a separate question — NO_COLOR turns colour off while box rules still
// align — so the two answers are kept apart.
export const dumbTerminal = dumb;

function paint(code: string): (text: string) => string
{
    return (text) => enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const bold = paint("1");
export const dim = paint("2");
export const red = paint("31");
export const green = paint("32");
export const yellow = paint("33");
export const blue = paint("34");

const errEnabled = process.stderr.isTTY === true && process.env.NO_COLOR === undefined;

function errPaint(code: string): (text: string) => string
{
    return (text) => errEnabled ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const errRed = errPaint("31");
export const errYellow = errPaint("33");

export function markdownHeadings(text: string): string
{
    return text.split("\n").map((line) => /^#{1,3} /.test(line) ? bold(line) : line).join("\n");
}

// The terminal's column count, or `fallback` where stdout has none to report.
// Every surface that lays text out reads its width from here, so a redirected
// stdout can never make one of them guess differently from the others.
export function termColumns(fallback: number): number
{
    const columns = process.stdout.columns;
    return columns === undefined || columns === 0 ? fallback : columns;
}

export function termWidth(): number
{
    return termColumns(100);
}

export function fit(text: string, width: number): string
{
    return text.length > width ? text.slice(0, Math.max(1, width - 1)) + "…" : text;
}

/* ── display width ─────────────────────────────────────────────────── */

// A ruled table aligns on terminal cells, not on code points: one Hangul
// syllable spends two cells and a combining mark spends none, so measuring a
// recorded outcome by `String.length` breaks every border below it. The tables
// below are the ranges that matter for the text this CLI stores — CJK, Hangul,
// the fullwidth forms, and the emoji planes. Anything outside them is charged
// one cell: a rare glyph mismeasured by one shifts a border, which is the
// failure to prefer over refusing to render the row at all.
const WIDE_RANGES: [number, number][] = [
    [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
    [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
    [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
    [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff],
    [0x20000, 0x2fffd], [0x30000, 0x3fffd]
];

// Combining marks, joiners, and variation selectors: they modify the character
// before them and occupy no cell of their own.
const ZERO_RANGES: [number, number][] = [
    [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a],
    [0x064b, 0x065f], [0x0e31, 0x0e31], [0x0e34, 0x0e3a], [0x1ab0, 0x1aff],
    [0x1dc0, 0x1dff], [0x200b, 0x200f], [0x2060, 0x2064], [0x20d0, 0x20ff],
    [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xfeff, 0xfeff]
];

function inRanges(code: number, ranges: [number, number][]): boolean
{
    return ranges.some(([low, high]) => code >= low && code <= high);
}

function charWidth(code: number): number
{
    if (code < 0x20 || (code >= 0x7f && code < 0xa0) || inRanges(code, ZERO_RANGES))
    {
        return 0;
    }
    return inRanges(code, WIDE_RANGES) ? 2 : 1;
}

export function displayWidth(text: string): number
{
    let width = 0;
    for (const character of text)
    {
        width += charWidth(character.codePointAt(0) ?? 0);
    }
    return width;
}

// Truncate to a cell budget, taking whole code points: a double-width glyph is
// dropped rather than halved, so the ellipsis can never land mid-character and
// push the border one cell right.
export function fitDisplay(text: string, width: number): string
{
    if (width <= 0)
    {
        return "";
    }
    if (displayWidth(text) <= width)
    {
        return text;
    }
    const budget = width - 1;
    let used = 0;
    let kept = "";
    for (const character of text)
    {
        const cell = charWidth(character.codePointAt(0) ?? 0);
        if (used + cell > budget)
        {
            break;
        }
        used += cell;
        kept += character;
    }
    return kept + "…";
}

export function padDisplay(text: string, width: number): string
{
    return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}
