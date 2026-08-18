import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

export function ulid(): string
{
    let time = Date.now();
    let timePart = "";
    for (let i = 0; i < 10; i++)
    {
        timePart = CROCKFORD[time % 32] + timePart;
        time = Math.floor(time / 32);
    }
    let randPart = "";
    for (const byte of randomBytes(16))
    {
        randPart += CROCKFORD[byte % 32];
    }
    return timePart + randPart;
}

// The grammar of a minted event id, kept beside the minting so the two can
// never drift: 26 Crockford characters, the first ten of them a millisecond
// timestamp. The timestamp is what makes this a recognition rather than a
// character-class guess — a generated credential of the same length and
// alphabet lands inside the plausible window about one time in four hundred.
const ULID = new RegExp(`^[${CROCKFORD}]{26}$`);
const EARLIEST = Date.UTC(2015, 0, 1);
const LATEST = Date.UTC(2100, 0, 1);

export function isEventId(value: string): boolean
{
    if (!ULID.test(value))
    {
        return false;
    }
    const time = [...value.slice(0, 10)].reduce((total, char) => total * 32 + CROCKFORD.indexOf(char), 0);
    return time >= EARLIEST && time < LATEST;
}

export function workId(): string
{
    return "w-" + shortId();
}

export function artifactId(): string
{
    return "a-" + shortId();
}

export function objectiveId(): string
{
    return "o-" + shortId();
}

export function entityId(): string
{
    return "e-" + shortId();
}

export function milestoneId(): string
{
    return "m-" + shortId();
}

// A short id names its kind in its prefix, so a lookup that failed can tell a
// wrong-kind id apart from a missing one and answer with the command that
// resolves it, instead of a listing that could never contain it.
const KIND_BY_PREFIX: Record<string, { kind: string; show: string }> = {
    "w-": { kind: "work", show: "self work show" },
    "o-": { kind: "objective", show: "self objective show" },
    "m-": { kind: "milestone", show: "self milestone show" }
};

export function wrongKindHint(id: string, expected: "work" | "objective" | "milestone"): string | null
{
    const entry = KIND_BY_PREFIX[id.slice(0, 2)];
    if (entry === undefined || entry.kind === expected)
    {
        return null;
    }
    return `"${id}" is ${article(entry.kind)} ${entry.kind} id, not ${article(expected)} ${expected} id — run \`${entry.show} ${id}\``;
}

function article(kind: string): string
{
    return kind === "objective" ? "an" : "a";
}

function shortId(): string
{
    let id = "";
    for (const byte of randomBytes(5))
    {
        id += CROCKFORD[byte % 32];
    }
    return id;
}
