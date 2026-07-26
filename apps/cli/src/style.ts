// Human-facing terminal styling. Enabled only on an interactive stdout so that
// piped output — what agents and the proof suite consume — stays byte-identical.
const enabled = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

export const styled = enabled;

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

export function termWidth(): number
{
    const columns = process.stdout.columns;
    return columns === undefined || columns === 0 ? 100 : columns;
}

export function fit(text: string, width: number): string
{
    return text.length > width ? text.slice(0, Math.max(1, width - 1)) + "…" : text;
}
