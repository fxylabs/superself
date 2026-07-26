import { randomBytes } from "node:crypto";
import { CliError } from "./types.js";

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

// An assignee names whoever executes the work — an agent, a model, a runtime.
// The CLI validates its shape and never its meaning: nothing here resolves the
// name, and carrying one grants no permission. One whitespace-free token keeps
// it greppable in a log line and leaves room for a richer scheme later
// (`agent:opus-5`, `runtime/browser`).
const ASSIGNEE = /^[a-z0-9][a-z0-9._:@/+-]{0,63}$/i;

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

export function workId(): string
{
    return "w-" + shortId();
}

export function artifactId(): string
{
    return "a-" + shortId();
}

export function assigneeId(raw: string): string
{
    const id = raw.trim();
    if (!ASSIGNEE.test(id))
    {
        throw new CliError(`"${raw}" is not an assignee identity — use up to 64 characters of letters, digits, and . _ : @ / + - with no spaces`);
    }
    return id;
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
