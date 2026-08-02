// The one-line rendering behind `self log` and `self search`, driven directly
// so the fields it folds are named rather than inferred from whichever events
// a suite happens to record.
//
// The summary is deliberately wide: `payload.attempt` and `payload.detail` are
// folded into every event type, integration events included, so a refusal is
// readable in the log instead of being an id and a type with the reason left
// in the store (decision 01kyy0gdep, issue #60 N6). That width is the thing
// under test here — a later field added to the fold must not quietly drop the
// refusal detail an integration event carries.
import { eventSummary } from "../dist/logfile.js";

const failures = [];

function event(type, payload)
{
    return { id: "01JTEST", ts: "2026-08-01T00:00:00.000Z", type, origin: { actor: "agent" }, project: "demo", payload };
}

function shows(what, type, payload, expected)
{
    const summary = eventSummary(event(type, payload));
    for (const part of expected)
    {
        if (!summary.includes(part))
        {
            failures.push(`${what}: the one-line rendering dropped "${part}" — ${summary}`);
        }
    }
}

// An integration attempt that was cancelled by the lane: the attempt id says
// which run it was, and the detail says why it stopped. A reader of `self log`
// gets both on the line or has to open the store to learn either.
shows("a cancelled integration attempt", "attempt.cancelled",
    { attempt: "ia-4k2mq", reason: "stale_fence", detail: "fence 3 is no longer current on superself" },
    ["ia-4k2mq", "fence 3 is no longer current on superself"]);

// A merge refusal carries no attempt of its own, and `changeSet` is not one of
// the folded fields — the detail is the only thing that can reach the line, and
// folding it is the whole point: a merge that did not happen says why in
// `self log` rather than only in the store.
shows("a refused merge", "merge.refused",
    { changeSet: "cs-6b33s", detail: "an approval carries only to the change set's own head" },
    ["an approval carries only to the change set's own head"]);

// A runner attempt is the other namespace with the same two fields, and it
// reads the same way — the fold is per field, never per namespace.
shows("a runner attempt failure", "run.completed",
    { attempt: "at-7fj2n", detail: "the result envelope claimed an artifact that does not exist" },
    ["at-7fj2n", "the result envelope claimed an artifact that does not exist"]);

// What the widening must not have cost: the fields the summary folded before
// it still come first and still read the same.
shows("a work report", "report.added", { work: "w-mr7cq", text: "eight small fixes landed" },
    ["w-mr7cq", "eight small fixes landed"]);
shows("a confirmed decision", "decision.confirmed", { text: "draw ruled tables on a terminal" },
    ["draw ruled tables on a terminal"]);

// `text` is the field a decision or a report states itself in, so it wins the
// one slot the summary keeps for prose; `detail` stands in only when there is
// no such statement. Pinned because an event carrying both must not start
// rendering the machine's wording over the author's.
const both = eventSummary(event("attempt.finished", { attempt: "ia-1", text: "authored", detail: "derived" }));
if (!both.includes("authored") || both.includes("derived"))
{
    failures.push(`an event carrying both a statement and a detail did not prefer the statement — ${both}`);
}

if (failures.length > 0)
{
    console.error(failures.join("\n"));
    process.exit(1);
}
console.log("event summary OK");
