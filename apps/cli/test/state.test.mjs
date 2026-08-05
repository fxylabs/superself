// The `self state` verbs (#200): the raw entity surface. What each verb
// records, what each refusal names, and the boundary against the preset
// record kinds — which keep their own lifecycle verbs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { approvedIn, demoWorkspace, idIn, machine, must, selfIn } from "./harness.mjs";

const box = machine();
const { ws, demo } = demoWorkspace(box);
const self = (args) => selfIn(box, demo, args);

// Destroying a record needs a person at a terminal (#173): the command line
// runs in full and only the typed answer is stood in for.
const approved = (args, answer) => approvedIn(box, demo, args, answer);

function entityIn(text)
{
    const match = text.match(/\be-[0-9a-z]{5}\b/);
    if (match === null)
    {
        throw new Error(`no entity id in: ${text}`);
    }
    return match[0];
}

test("state add records an entity with placement, metadata and rationale", () =>
{
    const id = entityIn(must(box, demo, ["state", "add", "weekly retro every friday",
        "--label", "ritual", "--label", "ops", "--priority", "15", "--exposure", "full",
        "--target", "2030-03-01", "--criteria", "retro notes exist", "--why", "keeps cadence"]).out);
    const shown = must(box, demo, ["state", "show", id]).out;
    assert.ok(shown.includes("labels: ritual, ops"));
    assert.ok(shown.includes("placement: project · full · priority 15"));
    assert.ok(shown.includes("target: 2030-03-01"));
    assert.ok(shown.includes("criterion: retro notes exist"));
    assert.ok(shown.includes("why: keeps cadence"));
    assert.ok(must(box, demo, ["state", "list"]).out.includes("weekly retro"));
});

test("a proposed entity waits for confirm, and confirming twice is named", () =>
{
    const id = entityIn(must(box, demo, ["state", "add", "adopt trunk based flow", "--proposed"]).out);
    assert.ok(must(box, demo, ["state", "list"]).out.includes("(proposed)"));
    must(box, demo, ["state", "confirm", id]);
    assert.ok(must(box, demo, ["state", "show", id]).out.includes("confirmed"));
    const again = self(["state", "confirm", id]);
    assert.notEqual(again.code, 0);
    assert.match(again.out, /already confirmed/);
});

test("retract withdraws with a reason, is terminal, and stays reachable by naming it", async () =>
{
    const id = entityIn(must(box, demo, ["state", "add", "temporary rule"]).out);
    const bare = self(["state", "retract", id]);
    assert.notEqual(bare.code, 0);
    assert.match(bare.out, /--why/);
    await approved(["state", "retract", id, "--why", "no longer needed"], id);
    assert.ok(!must(box, demo, ["state", "list"]).out.includes("temporary rule"));
    const shown = must(box, demo, ["state", "show", id]).out;
    assert.ok(shown.includes("retracted"));
    assert.ok(shown.includes("closed: no longer needed"));
    const again = self(["state", "retract", id, "--why", "twice"]);
    assert.notEqual(again.code, 0);
    assert.match(again.out, /already retracted/);
    // Search answers over live records (#212), so a withdrawn record left that
    // answer; its text, its reason and its own events are reached by naming it.
    assert.equal(must(box, demo, ["search", "temporary rule"]).out.trim(), "no matches");
    assert.match(must(box, demo, ["state", "show", id, "--history"]).out, /retracted/);
});

test("a confirmed successor supersedes; a proposal displaces nothing until confirmed", () =>
{
    const first = entityIn(must(box, demo, ["state", "add", "release on mondays"]).out);
    const second = entityIn(must(box, demo, ["state", "add", "release on demand",
        "--link", `supersedes:${first}`, "--proposed"]).out);
    assert.ok(must(box, demo, ["state", "show", first]).out.includes("confirmed"),
        "a proposal displaced a confirmed entity");
    must(box, demo, ["state", "confirm", second]);
    assert.ok(must(box, demo, ["state", "show", first]).out.includes(`superseded by: ${second}`));
    const third = self(["state", "add", "release hourly", "--link", `supersedes:${first}`]);
    assert.notEqual(third.code, 0);
    assert.match(third.out, /already superseded/);
});

test("links resolve, type-check, and refuse duplicates and unknown targets", () =>
{
    const anchor = entityIn(must(box, demo, ["state", "add", "platform theme"]).out);
    const grouped = entityIn(must(box, demo, ["state", "add", "billing rework",
        "--link", `member-of:${anchor}`, "--link", anchor]).out);
    const shown = must(box, demo, ["state", "show", grouped]).out;
    assert.ok(shown.includes(`link: member-of ${anchor}`));
    assert.ok(shown.includes(`link: relates ${anchor}`));
    const badType = self(["state", "add", "x", "--link", `blocks:${anchor}`]);
    assert.notEqual(badType.code, 0);
    assert.match(badType.out, /member-of:<id>, supersedes:<id>, or relates:<id>/);
    const unknown = self(["state", "add", "x", "--link", "e-zzzzz"]);
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.out, /unknown entity "e-zzzzz"/);
    const doubled = self(["state", "add", "x", "--link", anchor, "--link", anchor]);
    assert.notEqual(doubled.code, 0);
    assert.match(doubled.out, /repeated/);
});

test("placement and metadata shapes are refused in user terms", () =>
{
    const refusals = [
        [["state", "add", "x", "--priority", "high"], /whole number/],
        [["state", "add", "x", "--priority", "2.5"], /whole number/],
        [["state", "add", "x", "--priority", "99999999999999999999"], /whole number/],
        [["state", "add", "x", "--exposure", "loud"], /full \(whole text in context\), index \(one line\), or search/],
        [["state", "add", "x", "--target", "soon"], /use YYYY-MM-DD/],
        [["state", "add", "x", "--target", "2030-13-99"], /use YYYY-MM-DD/],
        [["state", "add", "x", "--label", ""], /cannot be empty/],
        [["state", "add", "x", "--criteria", " "], /cannot be empty/],
        [["state", "add", ""], /usage: self state add/]
    ];
    for (const [args, message] of refusals)
    {
        const result = self(args);
        assert.notEqual(result.code, 0, `\`${args.join(" ")}\` was accepted`);
        assert.match(result.out, message, `\`${args.join(" ")}\``);
    }
});

test("the preset record kinds keep their own lifecycle verbs", () =>
{
    const goal = idIn(must(box, demo, ["goal", "add", "own the niche"]).out);
    const retractGoal = self(["state", "retract", goal, "--why", "x"]);
    assert.notEqual(retractGoal.code, 0);
    assert.match(retractGoal.out, /goal record — run `self goal retract <id> --why w`/);
    const decision = idIn(must(box, demo, ["decide", "keep sqlite", "--proposed"]).out);
    const confirmLegacy = self(["state", "confirm", decision]);
    assert.notEqual(confirmLegacy.code, 0);
    assert.match(confirmLegacy.out, /decide confirm/);
    const supersedeLegacy = self(["state", "add", "keep postgres", "--link", `supersedes:${decision}`]);
    assert.notEqual(supersedeLegacy.code, 0);
    assert.match(supersedeLegacy.out, /decision record — replace it with/);
    const convention = idIn(must(box, demo, ["convention", "add", "events only"]).out);
    const retractLegacy = self(["state", "retract", convention, "--why", "x"]);
    assert.notEqual(retractLegacy.code, 0);
    assert.match(retractLegacy.out, /convention drop/);
});

test("state writes declare no scope flag, and reads answer for a named project", () =>
{
    const scoped = self(["state", "add", "x", "--project", "demo"]);
    assert.notEqual(scoped.code, 0);
    assert.match(scoped.out, /unknown option '--project'/);
    assert.ok(must(box, ws, ["state", "list", "--project", "demo"]).out.includes("weekly retro"),
        "a named-project read did not answer from outside the checkout");
    const extra = self(["state", "list", "extra"]);
    assert.notEqual(extra.code, 0);
    assert.match(extra.out, /unexpected argument 'extra'/);
    const unknown = self(["state", "show", "e-zzzzz"]);
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.out, /unknown entity/);
});
