// The counting the fold and its readers must not disagree about. Two copies of
// either of these drift — "1 branchs" on one surface and not the next, a store
// that passes a character cap on one machine and not another — so both live
// here, below every renderer, and the CLI's `style.ts` reads them from here.

// A counted noun, in the one place both list renders read it from.
export function plural(count: number, noun: string, many = `${noun}s`): string
{
    return `${count} ${count === 1 ? noun : many}`;
}

// The one rule for counting stored text in characters: Unicode code points, so
// a surrogate pair is one character on every machine. The context budget and
// the full-exposure retention cap both measure through here — a second counter
// would let a store pass the cap and still blow the budget, or the other way
// round.
export function countCharacters(text: string): number
{
    return Array.from(text).length;
}
