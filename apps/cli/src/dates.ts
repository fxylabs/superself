import { CliError } from "./types.js";

// What a command's typed date argument is judged by, and the only half of the
// calendar rules that refuses: the arithmetic the fold does with a day lives in
// `@superself/fold`, which has no CLI error to raise and no argument to reject.
export function validZone(name: string): string
{
    const zone = name.trim();
    try
    {
        new Intl.DateTimeFormat("en-US", { timeZone: zone });
    }
    catch
    {
        throw new CliError(`"${name}" is not an IANA time zone — use a name like UTC, Asia/Seoul, America/New_York`);
    }
    return zone;
}

export function validDate(text: string): string
{
    const date = text.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + "T00:00:00Z")))
    {
        throw new CliError(`"${text}" is not a date — use YYYY-MM-DD`);
    }
    return date;
}
