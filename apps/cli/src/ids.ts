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

export function workId(): string
{
    let id = "";
    for (const byte of randomBytes(5))
    {
        id += CROCKFORD[byte % 32];
    }
    return "w-" + id;
}
