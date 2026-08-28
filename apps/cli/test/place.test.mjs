// `state place` and the retention caps (#202, #197 §3–§5): placement moves by
// event, --why is demanded exactly on demotion, demotion out of full waits on
// a person when proposed, and adding or placing past a cap is refused until
// the caller names what demotes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { approvedIn, demoWorkspace, idIn, machine, must, receiptIn, selfIn } from "./harness.mjs";

const box = machine();
const { demo } = await demoWorkspace(box);
const self = (args) => selfIn(box, demo, args);
// Destroying a record needs a person at a terminal (#173).
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

// The caps are user-set values in the store's config.json; the tests set them
// the way a user does, by writing the config the CLI reads.
// Caps are stated in tokens (#213), so these tests pin the scale at one token
// per character: every number below is then the character count of the text it
// gates, which is what makes the arithmetic in each case readable.
function setCaps(activeBox, caps)
{
    const file = join(activeBox.root, "ws", ".superself", "config.json");
    const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    writeFileSync(file, JSON.stringify({ ...config, tokensPerCharacter: 1, tokensMeasured: true, ...caps }) + "\n");
}

// A second machine for the cap arithmetic, so the tier contents stay under
// the test's own control and the store above keeps the defaults.
const capBox = machine();

const capDemo = (await demoWorkspace(capBox)).demo;

const capSelf = (args) => selfIn(capBox, capDemo, args);

// A third machine for the paired proposal, so exactly one record holds the
// one index seat when the agent asks for it.
const pairBox = machine();

const pairDemo = (await demoWorkspace(pairBox)).demo;

const pairSelf = (args) => selfIn(pairBox, pairDemo, args);

let seated;

let floating;

// A clean machine for the reviewer's two reproductions, landed verbatim.
const reviewBox = machine();

const reviewDemo = (await demoWorkspace(reviewBox)).demo;

const reviewSelf = (args) => selfIn(reviewBox, reviewDemo, args);

// A machine for the fix's own blast radius: retracted pair halves, a lone
// pending placement the store outgrew, and a paired demotion whose own
// destination lacks room.
const edgeBox = machine();

const edgeDemo = (await demoWorkspace(edgeBox)).demo;

const edgeSelf = (args) => selfIn(edgeBox, edgeDemo, args);

const edgeApproved = (args, answer) => approvedIn(edgeBox, edgeDemo, args, answer);

// A clean machine for the reviewer's third reproduction: the exact swap
// whose two tiers are both full, so neither half may land alone.
const f3Box = machine();

const f3Demo = (await demoWorkspace(f3Box)).demo;

const f3Self = (args) => selfIn(f3Box, f3Demo, args);

test("place moves priority and exposure, and a priority change needs no why", async () =>
{
    const id = entityIn((await must(box, demo, ["state", "add", "standing note", "--exposure", "index", "--priority", "10"])).out);
    await must(box, demo, ["state", "place", id, "--priority", "5"]);
    assert.ok((await must(box, demo, ["state", "show", id])).out.includes("placement: project · index · priority 5"));
    const demoted = await self(["state", "place", id, "--exposure", "search"]);
    assert.notEqual(demoted.code, 0, "a demotion without --why was accepted");
    assert.match(demoted.out, /needs --why/);
    await must(box, demo, ["state", "place", id, "--exposure", "search", "--why", "rarely read"]);
    assert.ok((await must(box, demo, ["state", "show", id])).out.includes("placement: project · search · priority 5"));
});

test("place answers for the preset record kinds too", async () =>
{
    const decision = idIn((await must(box, demo, ["decide", "keep sqlite"])).out);
    await must(box, demo, ["state", "place", decision, "--priority", "7"]);
    assert.ok((await must(box, demo, ["state", "show", decision])).out.includes("placement: project · index · priority 7"));
});

test("place refuses a missing change, a no-op, and the records that cannot move", async () =>
{
    const id = entityIn((await must(box, demo, ["state", "add", "movable", "--exposure", "index"])).out);
    const bare = await self(["state", "place", id]);
    assert.notEqual(bare.code, 0);
    assert.match(bare.out, /pass --priority <n>, --exposure full\|index\|search, --scope <slug>\|workspace, or several/);
    const noop = await self(["state", "place", id, "--exposure", "index"]);
    assert.notEqual(noop.code, 0);
    assert.match(noop.out, /already sits at that placement/);
    const unknown = await self(["state", "place", "e-zzzzz", "--priority", "1"]);
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.out, /unknown entity "e-zzzzz"/);
    // A proposal moves since #400: it renders nowhere, so raising its priority
    // or widening its scope hides nothing and settles where it lands at the
    // confirm. The one move it cannot make is a demotion of its own exposure,
    // which is what the second half asserts.
    const proposed = entityIn((await must(box, demo, ["state", "add", "not yet held", "--proposed"])).out);
    const early = await self(["state", "place", proposed, "--priority", "1"]);
    assert.equal(early.code, 0, early.out);
    const demoted = await self(["state", "place", proposed, "--exposure", "search", "--why", "quieter"]);
    assert.notEqual(demoted.code, 0);
    assert.match(demoted.out, /renders nowhere to be demoted from/);
    assert.match(demoted.out, new RegExp(`self state confirm ${proposed}`));
    const retracted = entityIn((await must(box, demo, ["state", "add", "short lived"])).out);
    await approved(["state", "retract", retracted, "--why", "done with it"], retracted);
    const gone = await self(["state", "place", retracted, "--priority", "1"]);
    assert.notEqual(gone.code, 0);
    assert.match(gone.out, /was retracted/);
    const old = entityIn((await must(box, demo, ["state", "add", "old rule"])).out);
    const successor = entityIn(receiptIn((await approved(["state", "add", "new rule", "--link", `supersedes:${old}`], old)).printed));
    const replaced = await self(["state", "place", old, "--priority", "1"]);
    assert.notEqual(replaced.code, 0);
    assert.match(replaced.out, new RegExp(`superseded by ${successor} — place the successor`));
});

test("an agent demoting out of full proposes; the person confirms from the entity id", async () =>
{
    const id = entityIn((await must(box, demo, ["state", "add", "big standing rule", "--exposure", "full"])).out);
    await must(box, demo, ["state", "place", id, "--exposure", "index", "--why", "too broad for full", "--proposed"]);
    const shown = (await must(box, demo, ["state", "show", id])).out;
    assert.ok(shown.includes("placement: project · full"), "a proposed demotion moved the record before confirmation");
    assert.ok(shown.includes("pending placement: exposure index (too broad for full)"));
    assert.ok(shown.includes(`confirm with \`self state confirm ${id}\``));
    const context = (await must(box, demo, ["context"])).out;
    assert.ok(context.includes(`proposed placement of ${id}: exposure index (too broad for full)`));
    await must(box, demo, ["state", "confirm", id]);
    assert.ok((await must(box, demo, ["state", "show", id])).out.includes("placement: project · index"));
    const again = await self(["state", "confirm", id]);
    assert.notEqual(again.code, 0);
    assert.match(again.out, /already confirmed/);
});

test("adding past the index cap is refused with the cap, the usage, and the demote shape", async () =>
{
    setCaps(capBox, { indexTokens: 17 });
    const first = entityIn((await must(capBox, capDemo, ["state", "add", "first index note"])).out);
    const refused = await capSelf(["state", "add", "second index note"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /the project index tier holds 16 of 17 tokens and this text adds 17 more/);
    assert.match(refused.out, /--demote <id>/);
    assert.match(refused.out, /self state place <id> --exposure search --why/);
    const second = entityIn((await must(capBox, capDemo, ["state", "add", "second index note", "--demote", first])).out);
    assert.ok((await must(capBox, capDemo, ["state", "show", first])).out.includes("placement: project · search"));
    assert.ok((await must(capBox, capDemo, ["state", "show", second])).out.includes("placement: project · index"));
});

test("the full cap counts tokens, and naming too little to free is refused with the shortfall", async () =>
{
    setCaps(capBox, { indexTokens: 50, fullTokens: 30 });
    const small = entityIn((await must(capBox, capDemo, ["state", "add", "tiny map", "--exposure", "full"])).out);
    const over = await capSelf(["state", "add", "a rule of twenty-five ch.", "--exposure", "full"]);
    assert.notEqual(over.code, 0);
    assert.match(over.out, /the project full tier holds 8 of 30 tokens and this text adds 25 more/);
    const still = await capSelf(["state", "add", "this text is far too long for the cap", "--exposure", "full", "--demote", small]);
    assert.notEqual(still.code, 0);
    assert.match(still.out, /still \d+ tokens over the 30-token full cap/);
    await must(capBox, capDemo, ["state", "add", "a rule of twenty-five ch.", "--exposure", "full", "--demote", small]);
    assert.ok((await must(capBox, capDemo, ["state", "show", small])).out.includes("placement: project · index"));
});

test("a demotion into a capped tier is gated, and the chain always terminates at search", async () =>
{
    setCaps(capBox, { indexTokens: 25, fullTokens: 30 });
    const fullOne = (await must(capBox, capDemo, ["state", "list"])).out.match(/\be-[0-9a-z]{5}\b(?=.*full)/)[0];
    const needless = await capSelf(["state", "add", "searched only", "--exposure", "search", "--demote", fullOne]);
    assert.notEqual(needless.code, 0);
    assert.match(needless.out, /this command enters none/);
    // The index tier stands exactly at its cap: a full → index demotion enters index,
    // so it is gated exactly like an add (review F1) — with the destination
    // cap, the usage, and the chained-demotion shape in one refusal.
    const over = await capSelf(["state", "place", fullOne, "--exposure", "index", "--why", "full is crowded"]);
    assert.notEqual(over.code, 0);
    assert.match(over.out, /the project index tier holds 25 of 25 tokens/);
    assert.match(over.out, /self state place <id> --exposure search --why/);
    const short = await capSelf(["state", "place", fullOne, "--exposure", "index", "--why", "full is crowded",
        "--demote", (await must(capBox, capDemo, ["state", "list"])).out.match(/\be-[0-9a-z]{5}\b(?=.*index)/)[0]]);
    assert.notEqual(short.code, 0);
    assert.match(short.out, /still \d+ tokens over the 25-token index cap/);
    // Never wedged: index → search enters no capped tier, so an over-cap
    // store always drains toward search, then the full → index move fits.
    const indexIds = [...(await must(capBox, capDemo, ["state", "list"])).out.matchAll(/\be-[0-9a-z]{5}\b(?=.*index)/g)].map((m) => m[0]);
    await must(capBox, capDemo, ["state", "place", indexIds[0], "--exposure", "search", "--why", "drained"]);
    await must(capBox, capDemo, ["state", "place", fullOne, "--exposure", "index", "--why", "full is crowded", "--demote", indexIds[1]]);
    assert.ok((await must(capBox, capDemo, ["state", "show", fullOne])).out.includes("placement: project · index"));
    assert.ok((await must(capBox, capDemo, ["state", "show", indexIds[1]])).out.includes("placement: project · search"));
    // The place column, not the free text, says which tier a row holds.
    const seats = (await must(capBox, capDemo, ["state", "list"])).out.split("\n")
        .filter((line) => line.split("  ")[2]?.startsWith("index")).length;
    assert.equal(seats, 1, "the index tier ended holding more than the one record that fits");
});

test("an agent adding past a cap lands a proposed add paired with a proposed demotion", async () =>
{
    setCaps(pairBox, { indexTokens: 24 });
    const holder = entityIn((await must(pairBox, pairDemo, ["state", "add", "holds the one index seat"])).out);
    const added = entityIn((await must(pairBox, pairDemo, ["state", "add", "wants the seat", "--proposed", "--demote", holder])).out);
    const holderShown = (await must(pairBox, pairDemo, ["state", "show", holder])).out;
    assert.ok(holderShown.includes("placement: project · index"), "a proposed demotion moved the record before confirmation");
    assert.ok(holderShown.includes(`pending placement: exposure search (demoted to admit ${added} under the index cap)`));
    const context = (await must(pairBox, pairDemo, ["context"])).out;
    assert.ok(context.includes(`proposed entity ${added}: wants the seat (confirm with \`self state confirm ${added}\`)`));
    assert.ok(context.includes(`proposed placement of ${holder}: exposure search (demoted to admit ${added} under the index cap)`));
    // A cap-driven pair is one confirmable unit (review F3): either half's id
    // lands both in one append, so the seat never stands double-booked and
    // no confirm ordering exists to get wrong.
    const swap = await must(pairBox, pairDemo, ["state", "confirm", added]);
    assert.equal([...swap.out.matchAll(/entity\.confirmed/g)].length, 2, `the pair did not land as one unit:\n${swap.out}`);
    assert.ok((await must(pairBox, pairDemo, ["state", "show", added])).out.includes("placement: project · index"));
    assert.ok((await must(pairBox, pairDemo, ["state", "show", holder])).out.includes("placement: project · search"));
    const again = await pairSelf(["state", "confirm", holder]);
    assert.notEqual(again.code, 0);
    assert.match(again.out, /already confirmed/);
});

test("--demote validates its target in user terms", async () =>
{
    seated = (await must(pairBox, pairDemo, ["state", "list"])).out.match(/\be-[0-9a-z]{5}\b(?=.*index)/)[0];
    const searched = (await must(pairBox, pairDemo, ["state", "list"])).out.match(/\be-[0-9a-z]{5}\b(?=.*search)/)[0];
    const wrongTier = await pairSelf(["state", "add", "next seat", "--demote", searched]);
    assert.notEqual(wrongTier.code, 0);
    assert.match(wrongTier.out, /sits at search exposure — name a record at index exposure/);
    const repeated = await pairSelf(["state", "add", "next seat", "--demote", seated, "--demote", seated]);
    assert.notEqual(repeated.code, 0);
    assert.match(repeated.out, /is repeated/);
    floating = entityIn((await must(pairBox, pairDemo, ["state", "add", "floating proposal", "--proposed", "--demote", seated])).out);
    const unheld = await pairSelf(["state", "add", "next seat", "--demote", floating]);
    assert.notEqual(unheld.code, 0);
    assert.match(unheld.out, /still proposed — it holds no place in the index tier/);
    const itself = await pairSelf(["state", "place", searched, "--exposure", "index", "--demote", searched]);
    assert.notEqual(itself.code, 0);
    assert.match(itself.out, /names the record being placed/);
});

test("confirming the demotion half lands the whole pair too", async () =>
{
    const swap = await must(pairBox, pairDemo, ["state", "confirm", seated]);
    assert.equal([...swap.out.matchAll(/entity\.confirmed/g)].length, 2, `the pair did not land as one unit:\n${swap.out}`);
    assert.ok((await must(pairBox, pairDemo, ["state", "show", floating])).out.includes("confirmed"));
    assert.ok((await must(pairBox, pairDemo, ["state", "show", floating])).out.includes("placement: project · index"));
    assert.ok((await must(pairBox, pairDemo, ["state", "show", seated])).out.includes("placement: project · search"));
});

test("review F1: a demotion cannot overfill the index tier", async () =>
{
    setCaps(reviewBox, { indexTokens: 12 });
    const seat = entityIn((await must(reviewBox, reviewDemo, ["state", "add", "seat holder"])).out);
    const dweller = entityIn((await must(reviewBox, reviewDemo, ["state", "add", "full dweller", "--exposure", "full"])).out);
    const over = await reviewSelf(["state", "place", dweller, "--exposure", "index", "--why", "leave full"]);
    assert.notEqual(over.code, 0, "a demotion past the index cap was accepted");
    assert.match(over.out, /the project index tier holds 11 of 12 tokens/);
    assert.match(over.out, /--demote <id>/);
    await must(reviewBox, reviewDemo, ["state", "place", dweller, "--exposure", "index", "--why", "leave full", "--demote", seat]);
    assert.ok((await must(reviewBox, reviewDemo, ["state", "show", seat])).out.includes("placement: project · search"));
    assert.ok((await must(reviewBox, reviewDemo, ["state", "show", dweller])).out.includes("placement: project · index"));
    // Chain termination: index → search enters no capped tier, at any usage.
    await must(reviewBox, reviewDemo, ["state", "place", dweller, "--exposure", "search", "--why", "drained"]);
});

test("review F2: confirming the promotion half cannot leave the full tier over its cap", async () =>
{
    setCaps(reviewBox, { fullTokens: 10, indexTokens: 50 });
    const eight = entityIn((await must(reviewBox, reviewDemo, ["state", "add", "8 chars!", "--exposure", "full"])).out);
    const five = entityIn((await must(reviewBox, reviewDemo, ["state", "add", "5char"])).out);
    await must(reviewBox, reviewDemo, ["state", "place", five, "--exposure", "full", "--proposed", "--demote", eight]);
    // The F2 property: no single verb leaves full past 10 tokens. The
    // pair is one unit, so the promotion's confirm lands the demotion with
    // it — full ends at 5 of 10, never at 13.
    const swap = await must(reviewBox, reviewDemo, ["state", "confirm", five]);
    assert.equal([...swap.out.matchAll(/entity\.confirmed/g)].length, 2, `the pair did not land as one unit:\n${swap.out}`);
    assert.ok((await must(reviewBox, reviewDemo, ["state", "show", five])).out.includes("placement: project · full"));
    assert.ok((await must(reviewBox, reviewDemo, ["state", "show", eight])).out.includes("placement: project · index"));
    const again = await reviewSelf(["state", "confirm", eight]);
    assert.notEqual(again.code, 0);
    assert.match(again.out, /already confirmed/);
});

test("a lone pending placement the store outgrew gets the same capacity refusal", async () =>
{
    setCaps(edgeBox, { fullTokens: 30 });
    await must(edgeBox, edgeDemo, ["state", "add", "tiny map", "--exposure", "full"]);
    const twenty = entityIn((await must(edgeBox, edgeDemo, ["state", "add", "12345678901234567890"])).out);
    await must(edgeBox, edgeDemo, ["state", "place", twenty, "--exposure", "full", "--proposed"]);
    const thirteen = entityIn((await must(edgeBox, edgeDemo, ["state", "add", "13 characters", "--exposure", "full"])).out);
    const outgrown = await edgeSelf(["state", "confirm", twenty]);
    assert.notEqual(outgrown.code, 0, "a pending promotion landed past a cap the store grew into");
    assert.match(outgrown.out, /would put the project full tier over its cap \(21 of 30 tokens held\)/);
    assert.match(outgrown.out, /free room first with `self state place <id> --exposure index --why/);
    await must(edgeBox, edgeDemo, ["state", "place", thirteen, "--exposure", "index", "--why", "make room"]);
    await must(edgeBox, edgeDemo, ["state", "confirm", twenty]);
    assert.ok((await must(edgeBox, edgeDemo, ["state", "show", twenty])).out.includes("placement: project · full"));
});

test("retracting either half of a pair leaves the other confirmable and the caps honest", async () =>
{
    setCaps(edgeBox, { fullTokens: 4000, indexTokens: 18 });
    const rowA = entityIn((await must(edgeBox, edgeDemo, ["state", "add", "row a"])).out);
    const rowB = entityIn((await must(edgeBox, edgeDemo, ["state", "add", "row b", "--proposed", "--demote", rowA])).out);
    // The demotion half's record is retracted: its seat frees, so the add
    // half confirms without the demotion.
    await edgeApproved(["state", "retract", rowA, "--why", "obsolete"], rowA);
    await must(edgeBox, edgeDemo, ["state", "confirm", rowB]);
    assert.ok((await must(edgeBox, edgeDemo, ["state", "show", rowB])).out.includes("placement: project · index"));
    // The add half is retracted: the pending demotion stays confirmable —
    // a move toward search always fits — just no longer forced.
    const rowC = entityIn((await must(edgeBox, edgeDemo, ["state", "add", "row c", "--proposed", "--demote", rowB])).out);
    await edgeApproved(["state", "retract", rowC, "--why", "withdrawn"], rowC);
    await must(edgeBox, edgeDemo, ["state", "confirm", rowB]);
    assert.ok((await must(edgeBox, edgeDemo, ["state", "show", rowB])).out.includes("placement: project · search"));
});

test("review F3: an exact-swap pair confirms as one unit instead of deadlocking", async () =>
{
    setCaps(f3Box, { fullTokens: 8, indexTokens: 8 });
    const dweller = entityIn((await must(f3Box, f3Demo, ["state", "add", "12345678", "--exposure", "full"])).out);
    const idx = entityIn((await must(f3Box, f3Demo, ["state", "add", "idx"])).out);
    await must(f3Box, f3Demo, ["state", "place", idx, "--exposure", "full", "--proposed", "--demote", dweller]);
    // Both tiers are exactly full: only the pair's net effect fits, so the
    // confirm applies both halves in one append — from either half's id.
    const swap = await must(f3Box, f3Demo, ["state", "confirm", idx]);
    assert.equal([...swap.out.matchAll(/entity\.confirmed/g)].length, 2, `the pair did not land as one unit:\n${swap.out}`);
    assert.ok((await must(f3Box, f3Demo, ["state", "show", idx])).out.includes("placement: project · full"));
    assert.ok((await must(f3Box, f3Demo, ["state", "show", dweller])).out.includes("placement: project · index"));
    const again = await f3Self(["state", "confirm", dweller]);
    assert.notEqual(again.code, 0);
    assert.match(again.out, /already confirmed/);
});

test("a paired full demotion is refused while its own index destination lacks room", async () =>
{
    setCaps(edgeBox, { fullTokens: 25, indexTokens: 20 });
    // From the tests above: full holds "tiny map" (8) and the twenty-character
    // row; index holds exactly one record ("row b" left toward search).
    const list = (await must(edgeBox, edgeDemo, ["state", "list"])).out;
    const thirteen = list.match(/\be-[0-9a-z]{5}\b(?=.*index)/)[0];
    // The 20-character full row is the one whose departure frees enough.
    const twenty = list.split("\n").find((line) => line.includes("12345678901234567890")).match(/\be-[0-9a-z]{5}\b/)[0];
    const blocked = await edgeSelf(["state", "add", "ten chars!", "--exposure", "full", "--demote", twenty]);
    assert.notEqual(blocked.code, 0, "a paired demotion overfilled the index tier");
    assert.match(blocked.out, /would put the project index tier at 33 of 20 tokens/);
    assert.match(blocked.out, /free index room first with `self state place <id> --exposure search --why/);
    await must(edgeBox, edgeDemo, ["state", "place", thirteen, "--exposure", "search", "--why", "drained"]);
    await must(edgeBox, edgeDemo, ["state", "add", "ten chars!", "--exposure", "full", "--demote", twenty]);
    assert.ok((await must(edgeBox, edgeDemo, ["state", "show", twenty])).out.includes("placement: project · index"));
});
