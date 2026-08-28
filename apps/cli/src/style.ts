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

// A counted noun, in the one place both list renders read it from: the plain
// render and the ruled render count the same things, and two copies of this
// drift into "1 branchs" on one surface and not the other.
export function plural(count: number, noun: string, many = `${noun}s`): string
{
    return `${count} ${count === 1 ? noun : many}`;
}

// The opening line of prose that may run to paragraphs. A report, a health
// sentence and a plan all read this way where the surface has one line to
// spend, so it is one function rather than a copy per renderer.
export function firstLine(text: string): string
{
    return text.split("\n", 1)[0];
}

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

/* ── character counting ────────────────────────────────────────────── */

// The one rule for counting stored text in characters: Unicode code points,
// so a surrogate pair is one character on every machine. The context budget
// and the full-exposure retention cap both measure through here — a second
// counter would let a store pass the cap and still blow the budget, or the
// other way round.
export function countCharacters(text: string): number
{
    return Array.from(text).length;
}

// What that character count costs in context tokens. Rounded up, so a cap is
// never passed by a fraction the render then spends. The scale is a store
// setting a measurement replaces (#213) — there is no second counter here,
// only a conversion of the one above.
export function tokensOf(characters: number, perCharacter: number): number
{
    return Math.ceil(characters * perCharacter);
}

// The characters a token budget buys, the same conversion read backwards.
// Rounded down for the same reason the other rounds up.
export function charactersFor(tokens: number, perCharacter: number): number
{
    return Math.floor(tokens / perCharacter);
}

// Truncation in the same unit the counting charges, so a cut can never split
// a surrogate pair and change the count it was made against.
export function takeCharacters(text: string, count: number): string
{
    return Array.from(text).slice(0, Math.max(0, count)).join("");
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
    [0xffe0, 0xffe6], [0x1f1e6, 0x1f1ff], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff],
    [0x1f7e0, 0x1f7eb], [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff],
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

// The emoji presentation selector and the combining enclosing keycap each turn
// a cluster that would otherwise be narrow into a two-cell emoji: `1` is one
// cell, `1️⃣` is two.
const EMOJI_PRESENTATION = [0xfe0f, 0x20e3];

// A terminal advances its cursor by grapheme cluster, so that is the unit that
// gets measured. A ZWJ family, a skin-tone modifier and a keycap are each one
// cluster occupying two cells however many code points they are written with —
// summing the code points charges the family six.
function clusterWidth(cluster: string): number
{
    for (const character of cluster)
    {
        const code = character.codePointAt(0) ?? 0;
        if (EMOJI_PRESENTATION.includes(code) || inRanges(code, WIDE_RANGES))
        {
            return 2;
        }
    }
    return charWidth(cluster.codePointAt(0) ?? 0);
}

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

// Printable ASCII is one cell per character and is what almost every value in
// a table holds, so it skips segmentation entirely; anything above it takes
// the cluster path.
const PLAIN_ASCII = /^[\x20-\x7e]*$/;

export function displayWidth(text: string): number
{
    if (PLAIN_ASCII.test(text))
    {
        return text.length;
    }
    let width = 0;
    for (const { segment } of graphemes.segment(text))
    {
        width += clusterWidth(segment);
    }
    return width;
}

const CONTROL_RUN = new RegExp("[\\x00-\\x1f\\x7f]+", "g");

// Text on its way into a bordered row, folded to one line. A stored newline or
// tab is charged no cells by the measurement above and yet moves the cursor on
// the terminal, which breaks every border below it; the run becomes one space
// so the row keeps its content and its geometry at once.
export function oneLine(text: string): string
{
    return text.replace(CONTROL_RUN, " ");
}

// Truncate to a cell budget, taking whole grapheme clusters — the same unit
// the width above counts. A double-width glyph is dropped rather than halved
// and a joined emoji never loses half its sequence, so the ellipsis can never
// land mid-character and push the border one cell right.
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
    for (const { segment } of graphemes.segment(text))
    {
        const cell = clusterWidth(segment);
        if (used + cell > budget)
        {
            break;
        }
        used += cell;
        kept += segment;
    }
    return kept + "…";
}

export function padDisplay(text: string, width: number): string
{
    return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}
