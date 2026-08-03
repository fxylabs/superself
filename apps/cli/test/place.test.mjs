// `state place` and the retention caps (#202, #197 §3–§5): placement moves by
// event, --why is demanded exactly on demotion, demotion out of full waits on
// a person when proposed, and adding or placing past a cap is refused until
// the caller names what demotes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { demoWorkspace, idIn, machine, must, selfIn } from "./harness.mjs";

const box = machine();
const { demo } = demoWorkspace(box);
const self = (args) => selfIn(box, demo, args);

function entityIn(text)
{
    const match = text.match(/\be-[0-9a-z]{5}\b/);
    if (match === null)
    {
        throw new Error(`no entity id in: ${text}`);
    }
    return match[0];
}

// The caps are user-set values in the store's config.json; the tests set them
// the way a user does, by writing the config the CLI reads.
function setCaps(activeBox, caps)
{
    const file = join(activeBox.root, "ws", ".superself", "config.json");
    const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    writeFileSync(file, JSON.stringify({ ...config, ...caps }) + "\n");
}

test("place moves priority and exposure, and a priority change needs no why", () =>
{
    const id = entityIn(must(box, demo, ["state", "add", "standing note", "--exposure", "index", "--priority", "10"]).out);
    must(box, demo, ["state", "place", id, "--priority", "5"]);
    assert.ok(must(box, demo, ["state", "show", id]).out.includes("placement: project · index · priority 5"));
    const demoted = self(["state", "place", id, "--exposure", "search"]);
    assert.notEqual(demoted.code, 0, "a demotion without --why was accepted");
    assert.match(demoted.out, /needs --why/);
    must(box, demo, ["state", "place", id, "--exposure", "search", "--why", "rarely read"]);
    assert.ok(must(box, demo, ["state", "show", id]).out.includes("placement: project · search · priority 5"));
});

test("place answers for the preset record kinds too", () =>
{
    const decision = idIn(must(box, demo, ["decide", "keep sqlite"]).out);
    must(box, demo, ["state", "place", decision, "--priority", "7"]);
    assert.ok(must(box, demo, ["state", "show", decision]).out.includes("placement: project · index · priority 7"));
});

test("place refuses a missing change, a no-op, and the records that cannot move", () =>
{
    const id = entityIn(must(box, demo, ["state", "add", "movable", "--exposure", "index"]).out);
    const bare = self(["state", "place", id]);
    assert.notEqual(bare.code, 0);
    assert.match(bare.out, /pass --priority <n>, --exposure full\|index\|search, or both/);
    const noop = self(["state", "place", id, "--exposure", "index"]);
    assert.notEqual(noop.code, 0);
    assert.match(noop.out, /already sits at that placement/);
    const unknown = self(["state", "place", "e-zzzzz", "--priority", "1"]);
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.out, /unknown entity "e-zzzzz"/);
    const proposed = entityIn(must(box, demo, ["state", "add", "not yet held", "--proposed"]).out);
    const early = self(["state", "place", proposed, "--priority", "1"]);
    assert.notEqual(early.code, 0);
    assert.match(early.out, /still proposed — placement moves confirmed records/);
    const retracted = entityIn(must(box, demo, ["state", "add", "short lived"]).out);
    must(box, demo, ["state", "retract", retracted, "--why", "done with it"]);
    const gone = self(["state", "place", retracted, "--priority", "1"]);
    assert.notEqual(gone.code, 0);
    assert.match(gone.out, /was retracted/);
    const old = entityIn(must(box, demo, ["state", "add", "old rule"]).out);
    const successor = entityIn(must(box, demo, ["state", "add", "new rule", "--link", `supersedes:${old}`]).out);
    const replaced = self(["state", "place", old, "--priority", "1"]);
    assert.notEqual(replaced.code, 0);
    assert.match(replaced.out, new RegExp(`superseded by ${successor} — place the successor`));
});

test("an agent demoting out of full proposes; the person confirms from the entity id", () =>
{
    const id = entityIn(must(box, demo, ["state", "add", "big standing rule", "--exposure", "full"]).out);
    must(box, demo, ["state", "place", id, "--exposure", "index", "--why", "too broad for full", "--proposed"]);
    const shown = must(box, demo, ["state", "show", id]).out;
    assert.ok(shown.includes("placement: project · full"), "a proposed demotion moved the record before confirmation");
    assert.ok(shown.includes("pending placement: exposure index (too broad for full)"));
    assert.ok(shown.includes(`confirm with \`self state confirm ${id}\``));
    const context = must(box, demo, ["context"]).out;
    assert.ok(context.includes(`proposed placement of ${id}: exposure index (too broad for full)`));
    must(box, demo, ["state", "confirm", id]);
    assert.ok(must(box, demo, ["state", "show", id]).out.includes("placement: project · index"));
    const again = self(["state", "confirm", id]);
    assert.notEqual(again.code, 0);
    assert.match(again.out, /already confirmed/);
});

// A second machine for the cap arithmetic, so the tier contents stay under
// the test's own control and the store above keeps the defaults.
const capBox = machine();
const capDemo = demoWorkspace(capBox).demo;
const capSelf = (args) => selfIn(capBox, capDemo, args);

test("adding past the index cap is refused with the cap, the usage, and the demote shape", () =>
{
    setCaps(capBox, { indexCap: 1 });
    const first = entityIn(must(capBox, capDemo, ["state", "add", "first index note"]).out);
    const refused = capSelf(["state", "add", "second index note"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /the project index tier holds 1 of 1 entities/);
    assert.match(refused.out, /--demote <id>/);
    assert.match(refused.out, /self state place <id> --exposure search --why/);
    const second = entityIn(must(capBox, capDemo, ["state", "add", "second index note", "--demote", first]).out);
    assert.ok(must(capBox, capDemo, ["state", "show", first]).out.includes("placement: project · search"));
    assert.ok(must(capBox, capDemo, ["state", "show", second]).out.includes("placement: project · index"));
});

test("the full cap counts characters, and naming too little to free is refused with the shortfall", () =>
{
    setCaps(capBox, { indexCap: 50, fullCap: 30 });
    const small = entityIn(must(capBox, capDemo, ["state", "add", "tiny map", "--exposure", "full"]).out);
    const over = capSelf(["state", "add", "a rule of twenty-five ch.", "--exposure", "full"]);
    assert.notEqual(over.code, 0);
    assert.match(over.out, /the project full tier holds 8 of 30 characters and this text adds 25 more/);
    const still = capSelf(["state", "add", "this text is far too long for the cap", "--exposure", "full", "--demote", small]);
    assert.notEqual(still.code, 0);
    assert.match(still.out, /still \d+ characters over the 30-character full cap/);
    must(capBox, capDemo, ["state", "add", "a rule of twenty-five ch.", "--exposure", "full", "--demote", small]);
    assert.ok(must(capBox, capDemo, ["state", "show", small]).out.includes("placement: project · index"));
});

test("a demotion into a capped tier is gated, and the chain always terminates at search", () =>
{
    setCaps(capBox, { indexCap: 1, fullCap: 30 });
    const fullOne = must(capBox, capDemo, ["state", "list"]).out.match(/\be-[0-9a-z]{5}\b(?=.*full)/)[0];
    const needless = capSelf(["state", "add", "searched only", "--exposure", "search", "--demote", fullOne]);
    assert.notEqual(needless.code, 0);
    assert.match(needless.out, /this command enters none/);
    // The index tier stands at 2 of 1: a full → index demotion enters index,
    // so it is gated exactly like an add (review F1) — with the destination
    // cap, the usage, and the chained-demotion shape in one refusal.
    const over = capSelf(["state", "place", fullOne, "--exposure", "index", "--why", "full is crowded"]);
    assert.notEqual(over.code, 0);
    assert.match(over.out, /the project index tier holds 2 of 1 entities/);
    assert.match(over.out, /self state place <id> --exposure search --why/);
    const short = capSelf(["state", "place", fullOne, "--exposure", "index", "--why", "full is crowded",
        "--demote", must(capBox, capDemo, ["state", "list"]).out.match(/\be-[0-9a-z]{5}\b(?=.*index)/)[0]]);
    assert.notEqual(short.code, 0);
    assert.match(short.out, /still 1 over the 1-entity index cap/);
    // Never wedged: index → search enters no capped tier, so an over-cap
    // store always drains toward search, then the full → index move fits.
    const indexIds = [...must(capBox, capDemo, ["state", "list"]).out.matchAll(/\be-[0-9a-z]{5}\b(?=.*index)/g)].map((m) => m[0]);
    must(capBox, capDemo, ["state", "place", indexIds[0], "--exposure", "search", "--why", "drained"]);
    must(capBox, capDemo, ["state", "place", fullOne, "--exposure", "index", "--why", "full is crowded", "--demote", indexIds[1]]);
    assert.ok(must(capBox, capDemo, ["state", "show", fullOne]).out.includes("placement: project · index"));
    assert.ok(must(capBox, capDemo, ["state", "show", indexIds[1]]).out.includes("placement: project · search"));
    // The place column, not the free text, says which tier a row holds.
    const seats = must(capBox, capDemo, ["state", "list"]).out.split("\n")
        .filter((line) => line.split("  ")[2]?.startsWith("index")).length;
    assert.equal(seats, 1, "the index tier ended past its cap of 1");
});

// A third machine for the paired proposal, so exactly one record holds the
// one index seat when the agent asks for it.
const pairBox = machine();
const pairDemo = demoWorkspace(pairBox).demo;
const pairSelf = (args) => selfIn(pairBox, pairDemo, args);

test("an agent adding past a cap lands a proposed add paired with a proposed demotion", () =>
{
    setCaps(pairBox, { indexCap: 1 });
    const holder = entityIn(must(pairBox, pairDemo, ["state", "add", "holds the one index seat"]).out);
    const added = entityIn(must(pairBox, pairDemo, ["state", "add", "wants the seat", "--proposed", "--demote", holder]).out);
    const holderShown = must(pairBox, pairDemo, ["state", "show", holder]).out;
    assert.ok(holderShown.includes("placement: project · index"), "a proposed demotion moved the record before confirmation");
    assert.ok(holderShown.includes(`pending placement: exposure search (demoted to admit ${added} under the index cap)`));
    const context = must(pairBox, pairDemo, ["context"]).out;
    assert.ok(context.includes(`proposed entity ${added}: wants the seat (confirm with \`self state confirm ${added}\`)`));
    assert.ok(context.includes(`proposed placement of ${holder}: exposure search (demoted to admit ${added} under the index cap)`));
    // Confirming the admitted half first would overfill the seat (review F2):
    // capacity is rechecked at confirm time, and the refusal names the
    // companion demotion to confirm first.
    const early = pairSelf(["state", "confirm", added]);
    assert.notEqual(early.code, 0);
    assert.match(early.out, /would put the project index tier over its cap \(1 of 1 entities held\)/);
    assert.match(early.out, new RegExp(`confirm the paired demotion first: \`self state confirm ${holder}\``));
    must(pairBox, pairDemo, ["state", "confirm", holder]);
    must(pairBox, pairDemo, ["state", "confirm", added]);
    assert.ok(must(pairBox, pairDemo, ["state", "show", added]).out.includes("confirmed"));
    assert.ok(must(pairBox, pairDemo, ["state", "show", holder]).out.includes("placement: project · search"));
});

test("--demote validates its target in user terms", () =>
{
    const seated = must(pairBox, pairDemo, ["state", "list"]).out.match(/\be-[0-9a-z]{5}\b(?=.*index)/)[0];
    const searched = must(pairBox, pairDemo, ["state", "list"]).out.match(/\be-[0-9a-z]{5}\b(?=.*search)/)[0];
    const wrongTier = pairSelf(["state", "add", "next seat", "--demote", searched]);
    assert.notEqual(wrongTier.code, 0);
    assert.match(wrongTier.out, /sits at search exposure — name a record at index exposure/);
    const repeated = pairSelf(["state", "add", "next seat", "--demote", seated, "--demote", seated]);
    assert.notEqual(repeated.code, 0);
    assert.match(repeated.out, /is repeated/);
    const proposed = entityIn(must(pairBox, pairDemo, ["state", "add", "floating proposal", "--proposed", "--demote", seated]).out);
    const unheld = pairSelf(["state", "add", "next seat", "--demote", proposed]);
    assert.notEqual(unheld.code, 0);
    assert.match(unheld.out, /still proposed — it holds no place in the index tier/);
    const itself = pairSelf(["state", "place", searched, "--exposure", "index", "--demote", searched]);
    assert.notEqual(itself.code, 0);
    assert.match(itself.out, /names the record being placed/);
});

// A clean machine for the reviewer's two reproductions, landed verbatim.
const reviewBox = machine();
const reviewDemo = demoWorkspace(reviewBox).demo;
const reviewSelf = (args) => selfIn(reviewBox, reviewDemo, args);

test("review F1: a demotion cannot overfill the index tier", () =>
{
    setCaps(reviewBox, { indexCap: 1 });
    const seat = entityIn(must(reviewBox, reviewDemo, ["state", "add", "seat holder"]).out);
    const dweller = entityIn(must(reviewBox, reviewDemo, ["state", "add", "full dweller", "--exposure", "full"]).out);
    const over = reviewSelf(["state", "place", dweller, "--exposure", "index", "--why", "leave full"]);
    assert.notEqual(over.code, 0, "a demotion past the index cap was accepted");
    assert.match(over.out, /the project index tier holds 1 of 1 entities/);
    assert.match(over.out, /--demote <id>/);
    must(reviewBox, reviewDemo, ["state", "place", dweller, "--exposure", "index", "--why", "leave full", "--demote", seat]);
    assert.ok(must(reviewBox, reviewDemo, ["state", "show", seat]).out.includes("placement: project · search"));
    assert.ok(must(reviewBox, reviewDemo, ["state", "show", dweller]).out.includes("placement: project · index"));
    // Chain termination: index → search enters no capped tier, at any usage.
    must(reviewBox, reviewDemo, ["state", "place", dweller, "--exposure", "search", "--why", "drained"]);
});

test("review F2: confirming a promotion past the full cap is refused until its demotion lands", () =>
{
    setCaps(reviewBox, { fullCap: 10, indexCap: 50 });
    const eight = entityIn(must(reviewBox, reviewDemo, ["state", "add", "8 chars!", "--exposure", "full"]).out);
    const five = entityIn(must(reviewBox, reviewDemo, ["state", "add", "5char"]).out);
    must(reviewBox, reviewDemo, ["state", "place", five, "--exposure", "full", "--proposed", "--demote", eight]);
    const early = reviewSelf(["state", "confirm", five]);
    assert.notEqual(early.code, 0, "the promotion half landed past the full cap");
    assert.match(early.out, /would put the project full tier over its cap \(8 of 10 characters held\)/);
    assert.match(early.out, new RegExp(`confirm the paired demotion first: \`self state confirm ${eight}\``));
    must(reviewBox, reviewDemo, ["state", "confirm", eight]);
    must(reviewBox, reviewDemo, ["state", "confirm", five]);
    assert.ok(must(reviewBox, reviewDemo, ["state", "show", five]).out.includes("placement: project · full"));
    assert.ok(must(reviewBox, reviewDemo, ["state", "show", eight]).out.includes("placement: project · index"));
});

// A machine for the fix's own blast radius: retracted pair halves, a lone
// pending placement the store outgrew, and a paired demotion whose own
// destination lacks room.
const edgeBox = machine();
const edgeDemo = demoWorkspace(edgeBox).demo;
const edgeSelf = (args) => selfIn(edgeBox, edgeDemo, args);

test("a lone pending placement the store outgrew gets the same capacity refusal", () =>
{
    setCaps(edgeBox, { fullCap: 30 });
    must(edgeBox, edgeDemo, ["state", "add", "tiny map", "--exposure", "full"]);
    const twenty = entityIn(must(edgeBox, edgeDemo, ["state", "add", "12345678901234567890"]).out);
    must(edgeBox, edgeDemo, ["state", "place", twenty, "--exposure", "full", "--proposed"]);
    const thirteen = entityIn(must(edgeBox, edgeDemo, ["state", "add", "13 characters", "--exposure", "full"]).out);
    const outgrown = edgeSelf(["state", "confirm", twenty]);
    assert.notEqual(outgrown.code, 0, "a pending promotion landed past a cap the store grew into");
    assert.match(outgrown.out, /would put the project full tier over its cap \(21 of 30 characters held\)/);
    assert.match(outgrown.out, /free room first with `self state place <id> --exposure index --why/);
    must(edgeBox, edgeDemo, ["state", "place", thirteen, "--exposure", "index", "--why", "make room"]);
    must(edgeBox, edgeDemo, ["state", "confirm", twenty]);
    assert.ok(must(edgeBox, edgeDemo, ["state", "show", twenty]).out.includes("placement: project · full"));
});

test("retracting either half of a pair leaves the other confirmable and the caps honest", () =>
{
    setCaps(edgeBox, { fullCap: 4000, indexCap: 2 });
    const rowA = entityIn(must(edgeBox, edgeDemo, ["state", "add", "row a"]).out);
    const rowB = entityIn(must(edgeBox, edgeDemo, ["state", "add", "row b", "--proposed", "--demote", rowA]).out);
    // The demotion half's record is retracted: its seat frees, so the add
    // half confirms without the demotion.
    must(edgeBox, edgeDemo, ["state", "retract", rowA, "--why", "obsolete"]);
    must(edgeBox, edgeDemo, ["state", "confirm", rowB]);
    assert.ok(must(edgeBox, edgeDemo, ["state", "show", rowB]).out.includes("placement: project · index"));
    // The add half is retracted: the pending demotion stays confirmable —
    // a move toward search always fits — just no longer forced.
    const rowC = entityIn(must(edgeBox, edgeDemo, ["state", "add", "row c", "--proposed", "--demote", rowB]).out);
    must(edgeBox, edgeDemo, ["state", "retract", rowC, "--why", "withdrawn"]);
    must(edgeBox, edgeDemo, ["state", "confirm", rowB]);
    assert.ok(must(edgeBox, edgeDemo, ["state", "show", rowB]).out.includes("placement: project · search"));
});

test("a paired full demotion is refused while its own index destination lacks room", () =>
{
    setCaps(edgeBox, { fullCap: 25, indexCap: 1 });
    // From the tests above: full holds "tiny map" (8) and the twenty-character
    // row; index holds exactly one record ("row b" left toward search).
    const list = must(edgeBox, edgeDemo, ["state", "list"]).out;
    const thirteen = list.match(/\be-[0-9a-z]{5}\b(?=.*index)/)[0];
    // The 20-character full row is the one whose departure frees enough.
    const twenty = list.split("\n").find((line) => line.includes("12345678901234567890")).match(/\be-[0-9a-z]{5}\b/)[0];
    const blocked = edgeSelf(["state", "add", "ten chars!", "--exposure", "full", "--demote", twenty]);
    assert.notEqual(blocked.code, 0, "a paired demotion overfilled the index tier");
    assert.match(blocked.out, /would put the project index tier at 2 of 1 entities/);
    assert.match(blocked.out, /free index room first with `self state place <id> --exposure search --why/);
    must(edgeBox, edgeDemo, ["state", "place", thirteen, "--exposure", "search", "--why", "drained"]);
    must(edgeBox, edgeDemo, ["state", "add", "ten chars!", "--exposure", "full", "--demote", twenty]);
    assert.ok(must(edgeBox, edgeDemo, ["state", "show", twenty]).out.includes("placement: project · index"));
});
