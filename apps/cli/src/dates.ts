import { CliError } from "./types.js";

export const DEFAULT_ZONE = "UTC";

// A target date is a calendar day, never an instant. Evaluating it against the
// rendering machine's locale would make the same log read on-track on one
// machine and missed on another, so every comparison goes through the zone the
// workspace recorded.
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

// Parts, not a formatted string: a locale with a non-Gregorian calendar or
// non-Latin digits would otherwise change the shape of the answer.
export function dayIn(when: Date, zone: string): string
{
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        calendar: "gregory",
        numberingSystem: "latn",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(when);
    const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
    return `${value("year").padStart(4, "0")}-${value("month")}-${value("day")}`;
}

// Whole calendar days from one day to another; negative once `to` is past.
export function daysBetween(from: string, to: string): number
{
    return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000);
}
