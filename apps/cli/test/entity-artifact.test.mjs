// A record points at a registered artifact (#238). One test per cell of the
// approved case table in docs/maintainers/case-tables/238-entity-artifact.md,
// named by its cell number, asserting that cell's stated outcome. The table is
// the review surface: a cell the table lacks is a path nothing proves.
//
// Cells 39-42 and 45 are the removal half and landed with `artifact prune`
// (#239 C): they are run by artifact-prune.test.mjs, two of them by tests whose
// names carry both tables' numbers. The 41 cells here are this branch's own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { artifactPointer } from "../dist/entities.js";
import { foldProject } from "../dist/fold.js";
import { approvedIn, demoWorkspace, git, idIn, machine, must, mustPerson, selfIn, workIdIn } from "./harness.mjs";

// What a reference costs the tier holding the record: the rendered pointer,
// read off the one constant the render itself reads. A number written here
// instead would let the wording and the cost drift apart, which is the whole
// defect the shared constant exists to prevent.
const POINTER = artifactPointer("a-xxxxx").length;

function artifactIdIn(text)
{
    const match = text.match(/\ba-[0-9a-z]{5}\b/);
    if (match === null)
    {
        throw new Error(`no artifact id in: ${text}`);
    }
    return match[0];
}

function entityIdIn(text)
{
    const match = text.match(/\be-[0-9a-z]{5}\b/);
    if (match === null)
    {
        throw new Error(`no entity id in: ${text}`);
    }
    return match[0];
}

function logPath(ws, project)
{
    return join(ws, ".superself", "projects", project, "log.jsonl");
}

// A project registered and never written to has no log file yet, which is the
// starting state several cells count events from.
function events(ws, project = "demo")
{
    const file = logPath(ws, project);
    const raw = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
    return raw === "" ? [] : raw.split("\n").map((line) => JSON.parse(line));
}

function storeCommits(box, ws)
{
    return Number(execFileSync("git", ["-C", join(ws, ".superself"), "rev-list", "--count", "HEAD"],
        { env: box.env, encoding: "utf8" }).trim());
}

// Caps are user-set values in the store's config.json, in tokens (#213). One
// token per character, so every cap below is a character count and the pointer
// costs exactly POINTER of them.
function setCaps(box, caps)
{
    const file = join(box.root, "ws", ".superself", "config.json");
    const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    writeFileSync(file, JSON.stringify({ ...config, tokensPerCharacter: 1, tokensMeasured: true, ...caps }) + "\n");
}

// A workspace with one project, one guide file in it, and that guide
// registered — the floor most cells below stand on.
async function withGuide(text = "a guide too long for a context line\n")
{
    const box = machine();
    const { ws, demo } = await demoWorkspace(box);
    writeFileSync(join(demo, "guide.md"), text);
    const artifact = artifactIdIn((await must(box, demo, ["artifact", "add", "guide.md"])).out);
    return { box, ws, demo, artifact };
}

function storedFile(ws, artifact, project = "demo")
{
    return join(ws, ".superself", "artifacts", project, `${artifact}-guide.md`);
}

/* ── registering an artifact with no report behind it (1-9) ────────── */

const reg = machine();
const regPaths = await demoWorkspace(reg);

test("1: a plain file registers on its own, and lists with no work unit", async () =>
{
    writeFileSync(join(regPaths.demo, "guide.md"), "the guide\n");
    const added = await must(reg, regPaths.demo, ["artifact", "add", "guide.md", "--why", "the API guide"]);
    const id = artifactIdIn(added.out);
    const registered = events(regPaths.ws).filter((event) => event.type === "artifact.registered");
    assert.equal(registered.length, 1);
    assert.equal(registered[0].payload.artifacts[0].id, id);
    assert.equal(registered[0].payload.why, "the API guide");
    assert.deepEqual(registered[0].refs.artifacts, [id]);
    assert.equal(registered[0].refs.work, undefined, "a registration stands behind no work unit");
    assert.match((await must(reg, regPaths.demo, ["artifact", "list"])).out, new RegExp(`${id}\\s+\\S+\\s+demo\\s+-\\s+guide\\.md`));
});

test("2: a directory registers as one bundle", async () =>
{
    const dir = join(regPaths.demo, "docs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), "# docs\n");
    writeFileSync(join(dir, "detail.md"), "detail\n");
    const id = artifactIdIn((await must(reg, regPaths.demo, ["artifact", "add", "docs"])).out);
    assert.match((await must(reg, regPaths.demo, ["artifact", "list"])).out, new RegExp(`${id}\\s+\\S+\\s+demo\\s+-\\s+docs/ \\(2 files\\)`));
});

test("3: bytes the project already stores are stored once and referenced twice", async () =>
{
    writeFileSync(join(regPaths.demo, "copy.md"), "the guide\n");
    const twin = artifactIdIn((await must(reg, regPaths.demo, ["artifact", "add", "copy.md"])).out);
    const first = events(regPaths.ws).find((event) => event.type === "artifact.registered").payload.artifacts[0];
    const second = events(regPaths.ws).filter((event) => event.type === "artifact.registered")
        .map((event) => event.payload.artifacts[0]).find((meta) => meta.id === twin);
    assert.notEqual(second.id, first.id, "each registration keeps its own id");
    assert.equal(second.path, first.path, "and shares the stored path rather than copying the bytes again");
});

test("4: a registration outside any project is refused", async () =>
{
    const refused = await selfIn(reg, reg.root, ["artifact", "add", "guide.md"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /not inside a registered project/);
});

test("5: a file over the byte bound is refused", async () =>
{
    const huge = join(regPaths.demo, "huge.bin");
    writeFileSync(huge, "");
    truncateSync(huge, 100 * 1024 * 1024 + 1);
    const before = events(regPaths.ws).length;
    const refused = await selfIn(reg, regPaths.demo, ["artifact", "add", "huge.bin"]);
    rmSync(huge);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /over the 104857600-byte bound/);
    assert.equal(events(regPaths.ws).length, before, "a refused registration writes no event");
});

test("6: a path that does not exist is refused, and writes no event", async () =>
{
    const before = events(regPaths.ws).length;
    const refused = await selfIn(reg, regPaths.demo, ["artifact", "add", "nope.md"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /artifact "nope\.md" does not exist/);
    assert.equal(events(regPaths.ws).length, before);
});

test("7: registering a file is not evidence, so it never opens `work done`", async () =>
{
    const work = workIdIn((await mustPerson(reg, regPaths.demo, ["work", "add", "the flow works"])).out);
    await must(reg, regPaths.demo, ["artifact", "add", "guide.md"]);
    const refused = await selfIn(reg, regPaths.demo, ["work", "done", work]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`${work} has no evidence for done`));
});

test("8: a registered artifact opens", async () =>
{
    const id = artifactIdIn((await must(reg, regPaths.demo, ["artifact", "list"])).out);
    const opened = await must(reg, regPaths.demo, ["artifact", "open", id]);
    assert.match(opened.out, new RegExp(`\\(${id}\\) resolves to that path`));
});

test("9: a registered artifact is found by search", async () =>
{
    assert.match((await must(reg, regPaths.demo, ["artifact", "search", "guide.md"])).out, /guide\.md/);
});

/* ── a record referencing one (10-18) ──────────────────────────────── */

test("10: an id this project stores is recorded on the record, in one event", async () =>
{
    const { box, ws, demo, artifact } = await withGuide();
    const before = events(ws).length;
    const rule = idIn((await must(box, demo, ["convention", "add", "API design follows the guide", "--artifact", artifact])).out);
    assert.equal(events(ws).length, before + 1, "an id already stored registers nothing");
    assert.match((await must(box, demo, ["state", "show", rule])).out, new RegExp(`artifact: ${artifact}`));
});

test("11: a path registers first and the record is written second", async () =>
{
    const box = machine();
    const { ws, demo } = await demoWorkspace(box);
    writeFileSync(join(demo, "guide.md"), "the guide\n");
    const before = events(ws).length;
    await must(box, demo, ["convention", "add", "API design follows the guide", "--artifact", "./guide.md"]);
    const written = events(ws).slice(before);
    assert.equal(written.length, 2);
    assert.equal(written[0].type, "artifact.registered");
    assert.equal(written[1].type, "entity.confirmed");
    assert.equal(written[1].payload.artifact, written[0].payload.artifacts[0].id);
});

test("12: an id nothing recorded is refused, and writes no event", async () =>
{
    const { box, ws, demo } = await withGuide();
    const before = events(ws).length;
    const refused = await selfIn(box, demo, ["convention", "add", "a rule", "--artifact", "a-zzzzz"]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /unknown artifact "a-zzzzz" in project "demo"/);
    assert.equal(events(ws).length, before);
});

test("13: another project's artifact is refused at the project boundary", async () =>
{
    const { box, ws, demo } = await withGuide();
    const other = join(ws, "other");
    mkdirSync(other, { recursive: true });
    git(box, other, ["init", "-q", "-b", "main"]);
    await must(box, other, ["project", "init", "--name", "other", "--desc", "the second project"]);
    writeFileSync(join(other, "elsewhere.md"), "another project's guide\n");
    const theirs = artifactIdIn((await must(box, other, ["artifact", "add", "elsewhere.md"])).out);
    const before = events(ws).length;
    const refused = await selfIn(box, demo, ["convention", "add", "a rule", "--artifact", theirs]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`unknown artifact "${theirs}" in project "demo"`));
    assert.equal(events(ws).length, before);
});

// The state `artifact prune` leaves behind (#239 C): the bytes and the record
// are gone from what the project's log says it holds. The removal verb does
// not exist yet, so the registry is put into that state directly — a fixture
// for the condition, not a way past a gate. What is asserted is the gate that
// will meet a pruned id: a reference resolves against the project's current
// registry, never against an id's spelling.
test("14: an id the project's registry no longer holds is refused", async () =>
{
    const { box, ws, demo, artifact } = await withGuide();
    const kept = events(ws).filter((event) => event.type !== "artifact.registered");
    writeFileSync(logPath(ws, "demo"), kept.map((event) => JSON.stringify(event)).join("\n") + "\n");
    foldProject(join(ws, ".superself"), "demo");
    const refused = await selfIn(box, demo, ["convention", "add", "a rule", "--artifact", artifact]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`unknown artifact "${artifact}" in project "demo"`));
});

test("15: a second --artifact is refused by name, with how many times it was passed", async () =>
{
    const { box, ws, demo, artifact } = await withGuide();
    const before = events(ws).length;
    const refused = await selfIn(box, demo, ["convention", "add", "a rule", "--artifact", artifact, "--artifact", artifact]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /--artifact names one artifact and was passed 2 times/);
    assert.equal(events(ws).length, before);
});

test("16: without --artifact a record carries no reference", async () =>
{
    const { box, demo } = await withGuide();
    const rule = idIn((await must(box, demo, ["convention", "add", "a rule with no guide"])).out);
    assert.doesNotMatch((await must(box, demo, ["state", "show", rule])).out, /artifact:/);
});

test("17: a registration that lands before the record is refused leaves an artifact nothing points at", async () =>
{
    const box = machine();
    const { ws, demo } = await demoWorkspace(box);
    writeFileSync(join(demo, "guide.md"), "the guide\n");
    setCaps(box, { fullTokens: 1 });
    const before = events(ws).length;
    const refused = await selfIn(box, demo, ["convention", "add", "a rule the cap refuses", "--artifact", "./guide.md"]);
    assert.notEqual(refused.code, 0);
    const written = events(ws).slice(before);
    assert.equal(written.length, 1);
    assert.equal(written[0].type, "artifact.registered", "the artifact stands, and the record it was for does not");
    assert.match((await must(box, demo, ["artifact", "list"])).out, /guide\.md/);
});

test("18: `state add --artifact` records the same field through the same check", async () =>
{
    const { box, demo, artifact } = await withGuide();
    const note = entityIdIn((await must(box, demo, ["state", "add", "a note", "--artifact", artifact])).out);
    assert.match((await must(box, demo, ["state", "show", note])).out, new RegExp(`artifact: ${artifact}`));
    assert.notEqual((await selfIn(box, demo, ["state", "add", "another note", "--artifact", "a-zzzzz"])).code, 0);
});

/* ── what the retention cap charges (19-27) ────────────────────────── */

test("19: with room in the tier, a referencing record is admitted", async () =>
{
    const { box, demo, artifact } = await withGuide();
    setCaps(box, { fullTokens: 4000 });
    const rule = idIn((await must(box, demo, ["convention", "add", "a rule", "--artifact", artifact])).out);
    assert.match((await must(box, demo, ["state", "show", rule])).out, /placement: project · full/);
});

test("20: the pointer is what a refusal counts, and the number says so", async () =>
{
    const { box, demo, artifact } = await withGuide();
    const text = "abcdefghij";
    setCaps(box, { fullTokens: text.length });
    const refused = await selfIn(box, demo, ["convention", "add", text, "--artifact", artifact]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`this text adds ${text.length + POINTER} more`));
});

test("21: the reference moves the refusal boundary by exactly the pointer's cost", async () =>
{
    const text = "abcdefghij";
    const bare = await withGuide();
    setCaps(bare.box, { fullTokens: text.length });
    assert.equal((await selfIn(bare.box, bare.demo, ["convention", "add", text])).code, 0,
        "at a cap the text exactly fits, an unreferencing record is admitted");
    const tight = await withGuide();
    setCaps(tight.box, { fullTokens: text.length });
    assert.notEqual((await selfIn(tight.box, tight.demo, ["convention", "add", text, "--artifact", tight.artifact])).code, 0,
        "the same text with a reference does not");
    const roomy = await withGuide();
    setCaps(roomy.box, { fullTokens: text.length + POINTER });
    assert.equal((await selfIn(roomy.box, roomy.demo, ["convention", "add", text, "--artifact", roomy.artifact])).code, 0,
        "and it fits again once the cap covers the pointer");
});

test("22: the artifact's own length is not counted — a long guide costs the pointer", async () =>
{
    const text = "abcdefghij";
    const { box, demo, artifact } = await withGuide("x".repeat(12_000) + "\n");
    setCaps(box, { fullTokens: text.length + POINTER });
    assert.equal((await selfIn(box, demo, ["convention", "add", text, "--artifact", artifact])).code, 0);
});

test("23: --demote frees the room a referencing record needs", async () =>
{
    const text = "abcdefghij";
    const { box, demo, artifact } = await withGuide();
    setCaps(box, { fullTokens: text.length + POINTER, indexTokens: 4000 });
    const first = idIn((await must(box, demo, ["convention", "add", text])).out);
    const refused = await selfIn(box, demo, ["convention", "add", text, "--artifact", artifact]);
    assert.notEqual(refused.code, 0);
    assert.equal((await selfIn(box, demo, ["convention", "add", text, "--artifact", artifact, "--demote", first])).code, 0);
});

test("24: an index-exposure record is charged the pointer against the index cap", async () =>
{
    const text = "abcdefghij";
    const { box, demo, artifact } = await withGuide();
    setCaps(box, { indexTokens: text.length });
    const refused = await selfIn(box, demo, ["state", "add", text, "--exposure", "index", "--artifact", artifact]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, new RegExp(`index tier holds 0 of ${text.length} tokens and this text adds ${text.length + POINTER} more`));
    setCaps(box, { indexTokens: text.length + POINTER });
    const note = entityIdIn((await must(box, demo, ["state", "add", text, "--exposure", "index", "--artifact", artifact])).out);
    assert.match((await must(box, demo, ["context"])).out, new RegExp(`- .*${text}.* — see \`self artifact open ${artifact}\``));
    assert.match((await must(box, demo, ["state", "show", note])).out, /placement: project · index/);
});

test("25: a search-exposure record has no cap, and its pointer renders in `self search`", async () =>
{
    const { box, demo, artifact } = await withGuide();
    setCaps(box, { fullTokens: 1, indexTokens: 1 });
    const note = entityIdIn((await must(box, demo, ["state", "add", "a searchable note", "--exposure", "search", "--artifact", artifact])).out);
    const found = (await must(box, demo, ["search", "--all", "a searchable note"])).out;
    assert.match(found, new RegExp(note));
    assert.match(found, new RegExp(`— see \`self artifact open ${artifact}\``));
});

test("26: a supersession credits the predecessor's pointer as well as its text", async () =>
{
    const text = "abcdefghij";
    const { box, demo, artifact } = await withGuide();
    setCaps(box, { fullTokens: text.length + POINTER });
    const first = idIn((await must(box, demo, ["convention", "add", text, "--artifact", artifact])).out);
    // Displacing a record is a person's call (#173), so the swap runs through
    // the typed-answer path; the cap gate refuses before the disclosure, so a
    // refusal here would still come back as a non-zero code.
    const swap = await approvedIn(box, demo, ["convention", "add", text, "--supersedes", first, "--artifact", artifact], first);
    assert.equal(swap.code, 0,
        "an exact swap fits, which it only does when the seat the predecessor frees includes its pointer");
});

test("27: the confirm-time check counts the pointer too", async () =>
{
    const text = "abcdefghij";
    const { box, demo, artifact } = await withGuide();
    setCaps(box, { fullTokens: text.length });
    // `convention add` states a rule outright and takes no --proposed, and
    // `state confirm` refuses a preset-labeled record toward its own verb — so
    // the propose/confirm pair is asserted on the raw record it is declared on.
    const proposal = entityIdIn((await must(box, demo,
        ["state", "add", text, "--exposure", "full", "--artifact", artifact, "--proposed"])).out);
    const refused = await selfIn(box, demo, ["state", "confirm", proposal]);
    assert.notEqual(refused.code, 0, "a proposal passes the add and the confirm is where the tier is judged");
    setCaps(box, { fullTokens: text.length + POINTER });
    assert.equal((await selfIn(box, demo, ["state", "confirm", proposal])).code, 0);
});

/* ── what a reader sees (28-38, 43, 44) ────────────────────────────── */

test("28: context renders the rule and a pointer to its guide", async () =>
{
    const { box, demo, artifact } = await withGuide();
    await must(box, demo, ["convention", "add", "API design follows the guide", "--artifact", artifact]);
    assert.match((await must(box, demo, ["context"])).out,
        new RegExp(`- \\[convention\\] API design follows the guide — see \`self artifact open ${artifact}\``));
});

test("29: a workspace-scoped rule renders its pointer elsewhere, and the artifact opens there", async () =>
{
    const { box, ws, demo, artifact } = await withGuide();
    await must(box, demo, ["convention", "add", "every project follows the guide", "--artifact", artifact, "--workspace"]);
    const other = join(ws, "other");
    mkdirSync(other, { recursive: true });
    git(box, other, ["init", "-q", "-b", "main"]);
    await must(box, other, ["project", "init", "--name", "other", "--desc", "the second project"]);
    assert.match((await must(box, other, ["context"])).out, new RegExp(`— see \`self artifact open ${artifact}\``));
    assert.match((await must(box, other, ["artifact", "open", artifact])).out, new RegExp(`\\(${artifact}\\) resolves to that path`));
});

test("30: a context budget that cannot hold the row omits the whole row, never the pointer alone", async () =>
{
    const { box, demo, artifact } = await withGuide();
    // One token per character makes the context budget 3,000 characters, and
    // the filler spends more than that above the referencing record — which
    // sorts last, because rows leave a section from the bottom up.
    setCaps(box, { fullTokens: 100_000, indexTokens: 100_000 });
    for (let index = 0; index < 20; index += 1)
    {
        await must(box, demo, ["state", "add", `filler ${index} `.repeat(40), "--exposure", "full", "--priority", "1"]);
    }
    const text = "API design follows the guide";
    await must(box, demo, ["state", "add", text, "--exposure", "full", "--priority", "900", "--artifact", artifact]);
    const rendered = (await must(box, demo, ["context"])).out;
    assert.equal(rendered.includes(text), rendered.includes(`self artifact open ${artifact}`),
        "the row renders whole or not at all — a pointer never outlives the record in front of it");
    assert.equal(rendered.includes(text), false, "and with the budget spent above it, it is gone");
});

test("31: the handoff packet carries the pointer", async () =>
{
    const { box, demo, artifact } = await withGuide();
    await must(box, demo, ["convention", "add", "API design follows the guide", "--artifact", artifact]);
    const work = workIdIn((await mustPerson(box, demo, ["work", "add", "the flow works"])).out);
    const packet = (await must(box, demo, ["handoff", work])).out;
    assert.match(packet, new RegExp(`CONVENTION .* \\| API design follows the guide — see \`self artifact open ${artifact}\``));
});

test("32: the terminal render carries the pointer", async () =>
{
    const { box, demo, artifact } = await withGuide();
    await must(box, demo, ["convention", "add", "API design follows the guide", "--artifact", artifact]);
    assert.match((await must(box, demo, ["context", "--pretty"])).out,
        new RegExp(`API design follows the guide — see \`self artifact open ${artifact}\``));
});

test("33: `self search --type convention` carries the pointer", async () =>
{
    const { box, demo, artifact } = await withGuide();
    await must(box, demo, ["convention", "add", "API design follows the guide", "--artifact", artifact]);
    assert.match((await must(box, demo, ["search", "--type", "convention", "--all"])).out,
        new RegExp(`API design follows the guide — see \`self artifact open ${artifact}\``));
});

test("34: bytes this machine has not synced leave the pointer standing and the open refused", async () =>
{
    const { box, ws, demo, artifact } = await withGuide();
    await must(box, demo, ["convention", "add", "API design follows the guide", "--artifact", artifact]);
    rmSync(storedFile(ws, artifact));
    assert.match((await must(box, demo, ["context"])).out, new RegExp(`— see \`self artifact open ${artifact}\``));
    const refused = await selfIn(box, demo, ["artifact", "open", artifact]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /run `self sync` to fetch it/);
});

test("35: `self status` says one line about a live record whose artifact is missing", async () =>
{
    const { box, ws, demo, artifact } = await withGuide();
    const rule = idIn((await must(box, demo, ["convention", "add", "API design follows the guide", "--artifact", artifact])).out);
    rmSync(storedFile(ws, artifact));
    const health = (await must(box, demo, ["status"])).out.split("\n").filter((line) => line.includes(artifact));
    assert.equal(health.length, 1);
    assert.match(health[0], new RegExp(`${rule} artifact ${artifact} guide.md is missing from this store`));
});

test("36: an artifact whose stored bytes no longer match its digest raises a signal", async () =>
{
    const { box, ws, demo, artifact } = await withGuide();
    await must(box, demo, ["convention", "add", "API design follows the guide", "--artifact", artifact]);
    writeFileSync(storedFile(ws, artifact), "something else entirely\n");
    const health = (await must(box, demo, ["status"])).out.split("\n").filter((line) => line.includes(artifact));
    assert.equal(health.length, 1);
    assert.match(health[0], /no longer matches the digest/);
});

test("37: a retracted record's reference raises nothing — a dead record renders nowhere", async () =>
{
    const { box, ws, demo, artifact } = await withGuide();
    const rule = idIn((await must(box, demo, ["convention", "add", "API design follows the guide", "--artifact", artifact])).out);
    await approvedIn(box, demo, ["convention", "drop", rule, "--why", "the guide was withdrawn"], rule);
    rmSync(storedFile(ws, artifact));
    assert.equal((await must(box, demo, ["status"])).out.split("\n").filter((line) => line.includes(artifact)).length, 0);
});

test("38: a successor stated without --artifact drops the pointer, and the artifact stays stored", async () =>
{
    const { box, demo, artifact } = await withGuide();
    const first = idIn((await must(box, demo, ["convention", "add", "API design follows the guide", "--artifact", artifact])).out);
    await approvedIn(box, demo, ["convention", "add", "API design is settled here", "--supersedes", first], first);
    const rendered = (await must(box, demo, ["context"])).out;
    assert.match(rendered, /API design is settled here/);
    assert.doesNotMatch(rendered, /self artifact open/);
    assert.match((await must(box, demo, ["artifact", "list"])).out, new RegExp(artifact));
});

test("43: only the project whose log holds the record says the line", async () =>
{
    const { box, ws, demo, artifact } = await withGuide();
    await must(box, demo, ["convention", "add", "every project follows the guide", "--artifact", artifact, "--workspace"]);
    const other = join(ws, "other");
    mkdirSync(other, { recursive: true });
    git(box, other, ["init", "-q", "-b", "main"]);
    await must(box, other, ["project", "init", "--name", "other", "--desc", "the second project"]);
    rmSync(storedFile(ws, artifact));
    assert.equal((await must(box, demo, ["status"])).out.split("\n").filter((line) => line.includes(artifact)).length, 1);
    assert.equal((await must(box, other, ["status"])).out.split("\n").filter((line) => line.includes(artifact)).length, 0);
});

test("44: a proposal is live, so its reference is checked too", async () =>
{
    const { box, ws, demo, artifact } = await withGuide();
    const proposal = entityIdIn((await must(box, demo,
        ["state", "add", "a proposed rule", "--exposure", "full", "--artifact", artifact, "--proposed"])).out);
    rmSync(storedFile(ws, artifact));
    const health = (await must(box, demo, ["status"])).out.split("\n").filter((line) => line.includes(artifact));
    assert.equal(health.length, 1);
    assert.match(health[0], new RegExp(`${proposal} artifact ${artifact} guide.md is missing`));
});

/* ── the two commits a path input costs (46) ───────────────────────── */

test("46: a path input is two writes, so the store takes two commits", async () =>
{
    const box = machine();
    const { ws, demo } = await demoWorkspace(box);
    writeFileSync(join(demo, "guide.md"), "the guide\n");
    const before = storeCommits(box, ws);
    await must(box, demo, ["convention", "add", "API design follows the guide", "--artifact", "./guide.md"]);
    assert.equal(storeCommits(box, ws) - before, 2,
        "the registration and the record are separate writes, so a clone pulling between them sees an artifact nothing points at");
});
