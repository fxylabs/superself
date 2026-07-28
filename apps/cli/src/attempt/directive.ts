import { ulid } from "../ids.js";
import { Spool } from "./spool.js";

export type DirectiveKind = "followup" | "cancel";

export interface Directive
{
    id: string;
    ts: string;
    kind: DirectiveKind;
    text: string;
}

const QUEUE = "directives.jsonl";
const INBOX = "inbox.jsonl";
const CURSOR = "inbox.cursor.json";

// Terminal stdin is not a control plane: it closes when the launching shell
// goes away, it is lost on a restart, and nothing can be said to an attempt
// that was started an hour ago. A directive is a durable line in the spool
// instead, addressed by work and attempt.
export function queueDirective(spool: Spool, kind: DirectiveKind, text: string): Directive
{
    const directive: Directive = { id: ulid(), ts: new Date().toISOString(), kind, text };
    spool.append(QUEUE, directive as unknown as Record<string, unknown>);
    return directive;
}

export function queuedDirectives(spool: Spool): Directive[]
{
    return spool.readLines<Directive>(QUEUE);
}

// The queue is append-only, so a count is a durable cursor: a runner that dies
// mid-delivery re-delivers at most the directive it was writing, and one the
// agent has already seen is never lost.
export function deliverDirectives(spool: Spool): Directive[]
{
    const queued = queuedDirectives(spool);
    const cursor = spool.readJson<{ delivered: number }>(CURSOR)?.delivered ?? 0;
    const pending = queued.slice(cursor);
    for (const directive of pending)
    {
        spool.append(INBOX, directive as unknown as Record<string, unknown>);
    }
    if (pending.length > 0)
    {
        spool.writeJson(CURSOR, { delivered: queued.length });
    }
    return pending;
}

export function inboxPath(spool: Spool): string
{
    return spool.path(INBOX);
}
