// V6: the log-determined layer is a function of the events and of nothing
// else. Two readers of one log — this repository's `self` CLI and the
// Workspace API server that folds the same stream — agree on state only while
// that holds, and it stops holding the moment a clock, a session or a
// machine's verdict about a commit reaches the fold without passing through an
// argument.
//
// So the property is asserted the way it would break: the same events are
// folded twice under machine conditions chosen to differ as much as they can,
// and the two results are compared whole.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyLocalOverlay, foldEvents } from "../dist/index.js";

const PROJECT = { slug: "demo", description: "the demo project" };

let seq = 0;

// Event ids sort with `ts` in the fold's ordering, so they are minted in
// append order rather than at random: a log whose ids shuffle between runs
// would make this test pass or fail for a reason that is not the fold's.
function event(type, payload, extra = {})
{
    seq += 1;
    return {
        id: `01k${String(seq).padStart(23, "0")}`,
        ts: `2026-02-0${1 + Math.floor(seq / 10)}T0${seq % 10}:00:00.000Z`,
        type,
        origin: { actor: "agent", session: `session-${seq}`, confirmed: false },
        project: "demo",
        payload,
        ...extra
    };
}

// One log with something in it for every reducer that folds to state: the goal
// chain, the four preset record kinds, a work unit's criteria and reports, the
// process transitions, an annulment and a pruned artifact. A determinism check
// over an empty log proves nothing, so the assertions below check the fold
// found records before they check it found the same ones twice.
const CRITERIA = ["it ships", "a person signs off"];

const workProposed = event("entity.proposed", {
    entity: "w-aaaaa",
    text: "carry the fold into a package",
    labels: ["work"],
    criteria: CRITERIA,
    owner: { c2: "person" },
    scope: "project"
});

const decisionProposed = event("entity.proposed", {
    entity: "d-aaaaa",
    text: "the package owns the calculation",
    labels: ["decision"],
    blocks: ["w-aaaaa"]
}, { refs: { blocks: ["w-aaaaa"] } });

const mistake = event("entity.proposed", {
    entity: "d-bbbbb",
    text: "a record written by mistake",
    labels: ["decision"]
});

const EVENTS = [
    event("goal.set", { text: "one calculation, two readers" }),
    event("objective.created", { objective: "o-aaaaa", outcome: "the split lands", target: "2099-01-01" }),
    workProposed,
    event("entity.confirmed", { entity: "w-aaaaa" }, { refs: { confirms: workProposed.id } }),
    decisionProposed,
    event("entity.confirmed", { entity: "d-aaaaa" }, { refs: { confirms: decisionProposed.id } }),
    event("entity.proposed", { entity: "c-aaaaa", text: "Allman braces", labels: ["convention"] }),
    event("work.run-started", { work: "w-aaaaa", attempt: "a-1" }),
    event("work.run-exited", { work: "w-aaaaa", attempt: "a-1", code: 0 }),
    event("report.added", {
        work: "w-aaaaa",
        text: "the package builds",
        friction: ["the import graph had more edges than the review found"]
    }, { refs: { work: "w-aaaaa", commits: ["abc1234"], branch: "w-9fyeg/s1-fold-package" } }),
    event("entity.covered", { entity: "w-aaaaa", criterion: "c1", why: "the suite is green" }),
    mistake,
    event("entity.annulled", {}, { refs: { annuls: mistake.id } }),
    event("artifact.pruned", { artifact: "art-aaaaa", why: "the bytes were superseded" })
];

// Two machines that agree about nothing a machine can differ about.
const MONDAY = {
    now: new Date("2026-02-01T00:00:00.000Z"),
    session: "session-1",
    verdicts: { abc1234: "settled" },
    zone: "UTC"
};

const YEARS_LATER = {
    now: new Date("2031-11-30T23:59:59.000Z"),
    session: "somebody-else",
    verdicts: { abc1234: "abandoned" },
    zone: "Asia/Seoul"
};

const foldOf = () => foldEvents(EVENTS, PROJECT);

test("the log-determined fold finds the records the log states", () =>
{
    const model = foldOf();
    assert.equal(model.slug, "demo");
    assert.equal(model.description, "the demo project");
    assert.equal(model.goal, "one calculation, two readers");
    assert.ok(model.works.length > 0, "the work unit did not fold");
    assert.ok(model.decisions.length > 0, "the decision did not fold");
    assert.ok(model.conventions.length > 0, "the convention did not fold");
    assert.ok(model.goals.objectives.length > 0, "the objective did not fold");
    assert.ok(model.entities.length > 0, "the entity view is empty");
    // The mistake left the live set, which is what makes the annulment part of
    // what is being compared rather than a line that folded to nothing.
    assert.equal(model.entities.find((item) => item.id === "d-bbbbb")?.status, "undone");
});

test("the same events fold to the same state, twice over", () =>
{
    assert.deepEqual(foldOf(), foldOf());
});

test("the log-determined fold does not move with the clock, the session or the verdicts", () =>
{
    // Each overlay is applied to its own fold, because the overlay fills a
    // model in rather than copying it — comparing the two folds afterwards
    // would compare two overlaid models and prove nothing about the layer
    // underneath.
    const monday = foldOf();
    const later = foldOf();
    assert.deepEqual(monday, later, "two folds of one log differed before any overlay ran");

    applyLocalOverlay(monday, EVENTS, MONDAY);
    applyLocalOverlay(later, EVENTS, YEARS_LATER);
    assert.notDeepEqual(monday, later,
        "two machines that disagree about the clock, the session and the evidence read identically — "
        + "the overlay is not reaching the model, so this test can no longer tell the layers apart");

    // And the layer underneath is still what it was: folding again after both
    // overlays ran answers exactly what it answered before either did.
    assert.deepEqual(foldOf(), foldOf());
});

test("one overlay applied to two folds of one log answers identically", () =>
{
    const left = applyLocalOverlay(foldOf(), EVENTS, MONDAY);
    const right = applyLocalOverlay(foldOf(), EVENTS, MONDAY);
    assert.deepEqual(left, right);
});

test("the overlay carries every machine-local input the fold reads", () =>
{
    // What each input moves, one at a time. A field that stopped being read
    // would leave the fold reading it from somewhere this argument cannot
    // reach, which is the defect the split exists to prevent.
    const base = () => applyLocalOverlay(foldOf(), EVENTS, MONDAY);
    const withVerdict = applyLocalOverlay(foldOf(), EVENTS, { ...MONDAY, verdicts: {} });
    assert.notDeepEqual(base().unshipped, withVerdict.unshipped, "the verdicts did not reach the fold");

    const zoned = applyLocalOverlay(foldOf(), EVENTS, { ...MONDAY, zone: "Asia/Seoul" });
    assert.equal(zoned.zone, "Asia/Seoul");
    assert.equal(base().zone, "UTC");

    // The unreviewed line is the one thing the session decides: the newest
    // append reads as unreviewed to everyone except the session that wrote it.
    const newest = EVENTS.at(-1);
    const mine = applyLocalOverlay(foldOf(), EVENTS, { ...MONDAY, session: newest.origin.session });
    const theirs = applyLocalOverlay(foldOf(), EVENTS, { ...MONDAY, session: "somebody-else" });
    assert.ok(theirs.health.some((line) => line.startsWith("the last record is unreviewed")),
        "another session's newest append was not reported as unreviewed");
    assert.ok(!mine.health.some((line) => line.startsWith("the last record is unreviewed")),
        "the session that wrote the newest append was told its own record was unreviewed");
});
