#!/usr/bin/env bash
# Domain suite: the evidence bundle — the same pinned inputs compiling to the
# same bytes, a moved source refusing rather than being quietly recompiled, the
# disclosure screen refusing what must not be published while the store's own id
# grammar still compiles, and both format versions refusing by name.
# Runs alone: bash proof/suites/evidence-bundle.sh
set -euo pipefail
CLI_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
. "$CLI_DIR/proof/lib.sh"

demo_workspace
OUT="$ROOT/out"
mkdir -p "$OUT"

# the research-profile fixture: decisions, a work unit with a report, a
# milestone under an objective, and one commit of the project repo
cd "$DEMO"
echo "# evidence fixture" > README.md
git add README.md
git commit -qm "seed the evidence fixture"
COMMIT="$(git rev-parse HEAD)"
DEC="$(SELF decide "compile evidence from pinned state" --why "a reader must be able to recheck the claim" > /dev/null; grep -o '"id":"[0-9a-z]*","ts":"[^"]*","type":"decision.confirmed"' "$LOG_A" | tail -1 | sed 's/"id":"\([0-9a-z]*\)".*/\1/')"
OID="$(SELF objective add "ship the evidence compiler" --horizon week --target 2026-08-31 | tail -1)"
MID="$(SELF milestone add "a bundle recompiles to the same bytes" --objective "$OID" --exit "two compiles agree" | tail -1)"
# the cited unit takes the shapes real state has: proposed and accepted, so it
# carries work.accepted and work.linked; required and covered, so it carries a
# requirement text and a coverage revision; policy-declared, so it carries the
# model class and the fresh-review flag. One key the profile has not declared
# refuses the whole stream, so the fixture has to exercise the whole surface.
PID="$(SELF work propose "the evidence bundle compiles deterministically" --milestone "$MID" \
    --value "a reader can recheck which state supported a claim" \
    --risk "a compile that is not reproducible proves nothing" \
    --capacity "one change set" --evidence-plan "two compiles agree byte for byte" \
    --success "two compiles produce one digest" --stop "the digest depends on the machine" \
    --confidence medium --expires 2026-08-31 | sed -n 's/.*\[\([0-9a-z]*\)\].*/\1/p' | tail -1)"
WID="$(SELF work accept "$PID" | tail -1)"
SELF work start "$WID" > /dev/null
SELF work policy "$WID" --model opus --fresh-review --why "the canonical serializer is the whole claim" > /dev/null
RID="$(SELF work require "$WID" "the same pinned inputs give the same bytes" | tail -1)"
REPORT="$(SELF report "$WID" "compiled the first bundle over the pinned store" | sed -n 's/.*\[\([0-9a-z]*\)\].*/\1/p' | tail -1)"
SELF work met "$WID" --requirement "$RID" --report "$REPORT" --why "two compiles of one manifest agree byte for byte" > /dev/null
[ -n "$DEC" ] || fail "the fixture decision id was not captured"
# a second decision, so a prefix that matches more than one record has more than
# one record to be ambiguous over
SELF decide "version the bundle format apart from the manifest format" --why "either can move without the other" > /dev/null

manifest()
{
    cat > "$1" <<EOF
{
  "format": "${2:-self.evidence.manifest@1}",
  "profile": "research",
  "project": "demo",
  "select": {
    "decisions": ["$DEC"],
    "work": ["$WID"],
    "reports": [],
    "milestones": ["$MID"],
    "commits": [{ "repo": "demo", "commit": "$COMMIT" }]
  },
  "pins": { "git": [{ "repo": "demo", "commit": "$COMMIT" }] },
  "exclude": []
}
EOF
}

# an unpinned manifest refuses, and --pin writes the one that does not
cd "$OUT"
manifest "$OUT/unpinned.json"
UNPINNED="$(SELF evidence compile "$OUT/unpinned.json" --out first.json 2>&1 || true)"
echo "$UNPINNED" | grep -q "pins.self.head" || fail "an unpinned manifest did not name the missing pin"
echo "$UNPINNED" | grep -q -- "--pin" || fail "the unpinned refusal did not say how to pin"
[ -e "$OUT/first.json" ] && fail "a refused compile still wrote a bundle"
SELF evidence compile "$OUT/unpinned.json" --pin --out pinned.json | grep -q '"name":"pinned.json"' || fail "--pin did not report its result envelope"
grep -q '"logSha256"' "$OUT/pinned.json" || fail "--pin wrote no log hash"

# reproducibility: two compiles of the same pinned manifest are byte-identical
ENVELOPE="$(SELF evidence compile "$OUT/pinned.json" --out first.json)"
SELF evidence compile "$OUT/pinned.json" --out second.json > /dev/null
cmp -s "$OUT/first.json" "$OUT/second.json" || fail "two compiles of one pinned manifest differed"
echo "$ENVELOPE" | grep -q '"name":"first.json"' || fail "compile reported a path instead of a name"
echo "$ENVELOPE" | grep -q '"sha256":"[0-9a-f]\{64\}"' || fail "compile reported no digest"
DIGEST_A="$(node -e 'const b=require(process.argv[1]);console.log(b.digest)' "$OUT/first.json")"
DIGEST_B="$(node -e 'const b=require(process.argv[1]);console.log(b.digest)' "$OUT/second.json")"
[ "$DIGEST_A" = "$DIGEST_B" ] || fail "two compiles disagreed on the bundle digest"
[ -n "$DIGEST_A" ] || fail "the bundle carries no digest"
# canonical bytes: compact, LF only, exactly one trailing newline, sorted keys
[ "$(wc -l < "$OUT/first.json" | tr -d ' ')" = "1" ] || fail "the bundle is not one canonical line"
grep -q $'\r' "$OUT/first.json" && fail "the bundle carries a CR"
head -c 1 "$OUT/first.json" | grep -q "{" || fail "the bundle does not start with an object"
node -e '
const fs = require("node:fs");
const text = fs.readFileSync(process.argv[1], "utf8");
const keys = Object.keys(JSON.parse(text));
const sorted = [...keys].sort();
if (keys.join(",") !== sorted.join(",")) { console.error("keys unsorted: " + keys); process.exit(1); }
if (!text.endsWith("}\n")) { console.error("no single trailing newline"); process.exit(1); }
' "$OUT/first.json" || fail "the bundle bytes are not canonical"
# no wall clock: nothing in the bundle carries today's date except source rows
node -e '
const bundle = require(process.argv[1]);
const prov = JSON.stringify(bundle.provenance);
if (/\d{4}-\d{2}-\d{2}T/.test(prov)) { console.error("provenance carries a timestamp: " + prov); process.exit(1); }
' "$OUT/first.json" || fail "the bundle recorded a compile-time clock"
# the profile fixture holds every source kind the research profile carries
node -e '
const bundle = require(process.argv[1]);
const kinds = [...new Set(bundle.sources.map((s) => s.kind))].sort().join(",");
if (kinds !== "commit,decision,milestone,work") { console.error("kinds: " + kinds); process.exit(1); }
if (bundle.facts.length < 4) { console.error("facts: " + bundle.facts.length); process.exit(1); }
// the cited unit really carried the shapes the profile had to be audited for
const unit = bundle.sources.find((s) => s.kind === "work");
const types = unit.record.events.map((e) => e.type).join(",");
for (const wanted of ["work.created", "work.linked", "work.accepted", "work.policy-declared", "work.required", "work.covered"])
{
    if (!types.includes(wanted)) { console.error("the fixture unit never recorded " + wanted + " — got " + types); process.exit(1); }
}
const keys = [...new Set(unit.record.events.flatMap((e) => Object.keys(e.payload)))].sort().join(",");
for (const wanted of ["text", "milestone", "freshReview", "model", "requirementRevision", "proposal", "report"])
{
    if (!keys.includes(wanted)) { console.error("the fixture unit never carried " + wanted + " — got " + keys); process.exit(1); }
}
const ordered = [...bundle.facts].sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
if (JSON.stringify(ordered) !== JSON.stringify(bundle.facts)) { console.error("facts unordered"); process.exit(1); }
' "$OUT/first.json" || fail "the research fixture bundle is not the editorial input it claims"

# verify holds, and show reads the same rows piped
SELF evidence verify "$OUT/first.json" | grep -q "verifies" || fail "a fresh bundle did not verify"
SHOWN="$(SELF evidence show "$OUT/first.json")"
echo "$SHOWN" | grep -q "^bundle self.evidence.bundle@1" || fail "show printed no bundle line"
echo "$SHOWN" | grep -q "^sources 4" || fail "show did not list the sources"
echo "$SHOWN" | grep -q "^facts " || fail "show did not list the facts"
echo "$SHOWN" | grep -q "^exclusions 0" || fail "show did not list the exclusions"
echo "$SHOWN" | grep -q "$(printf '\033')" && fail "show emitted colour into a pipe"
[ "$SHOWN" = "$(SELF evidence show "$OUT/first.json" --plain)" ] || fail "--plain changed the piped bytes"

# fail-closed: tampering with the file is caught without the store at all
node -e '
const fs = require("node:fs");
const bundle = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
bundle.facts[0].statement = "a claim nobody recorded";
fs.writeFileSync(process.argv[2], JSON.stringify(bundle) + "\n");
' "$OUT/first.json" "$OUT/tampered.json"
TAMPER="$(SELF evidence verify "$OUT/tampered.json" 2>&1 || true)"
echo "$TAMPER" | grep -q "digest" || fail "an edited bundle was not caught by its digest"
SELF evidence verify "$OUT/tampered.json" > /dev/null 2>&1 && fail "an edited bundle verified"

# a recomputed digest is not integrity: a source row and its facts dropped, then
# the digest recomputed with this repository's own canonical module, still has
# to fail — the embedded manifest still selects the row the file no longer holds
node -e '
const fs = require("node:fs");
const { digestOf, canonicalBytes } = require(process.argv[3]);
const bundle = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const dropped = bundle.sources.find((s) => s.kind === "decision");
const carried = new Set([dropped.record.id]);
bundle.sources = bundle.sources.filter((s) => s !== dropped);
bundle.facts = bundle.facts.filter((f) => !carried.has(f.ref));
bundle.digest = "";
bundle.digest = digestOf(bundle);
fs.writeFileSync(process.argv[2], canonicalBytes(bundle));
console.log(dropped.ref);
' "$OUT/first.json" "$OUT/dropped.json" "$CLI_DIR/dist/evidence/canonical.js" > "$ROOT/dropped.ref"
DROPPED_REF="$(cat "$ROOT/dropped.ref")"
[ -n "$DROPPED_REF" ] || fail "the dropped-source fixture named no ref"
node -e '
const bundle = require(process.argv[1]);
const { digestOf } = require(process.argv[2]);
const copy = { ...bundle, digest: "" };
if (digestOf(copy) !== bundle.digest) { console.error("the fixture did not recompute the digest"); process.exit(1); }
' "$OUT/dropped.json" "$CLI_DIR/dist/evidence/canonical.js" || fail "the dropped-source fixture is not self-consistent"
DROPPED="$(SELF evidence verify "$OUT/dropped.json" 2>&1 || true)"
echo "$DROPPED" | grep -q "$DROPPED_REF" || fail "verify did not name the source dropped from the bundle — got: $DROPPED"
echo "$DROPPED" | grep -q "carries no row for it" || fail "verify did not say the selected row is missing"
SELF evidence verify "$OUT/dropped.json" > /dev/null 2>&1 && fail "a bundle with a dropped source verified"
# and a fact dropped on its own, with every row still carried
node -e '
const fs = require("node:fs");
const { digestOf, canonicalBytes } = require(process.argv[3]);
const bundle = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
bundle.facts = bundle.facts.slice(1);
bundle.digest = "";
bundle.digest = digestOf(bundle);
fs.writeFileSync(process.argv[2], canonicalBytes(bundle));
' "$OUT/first.json" "$OUT/thinned.json" "$CLI_DIR/dist/evidence/canonical.js"
THINNED="$(SELF evidence verify "$OUT/thinned.json" 2>&1 || true)"
echo "$THINNED" | grep -q "facts" || fail "a bundle missing one fact still verified"
# and a fact left pointing at a source that is gone, caught without the store
node -e '
const fs = require("node:fs");
const { digestOf, canonicalBytes } = require(process.argv[3]);
const bundle = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
bundle.sources = bundle.sources.filter((s) => s.kind !== "commit");
bundle.digest = "";
bundle.digest = digestOf(bundle);
fs.writeFileSync(process.argv[2], canonicalBytes(bundle));
' "$OUT/first.json" "$OUT/orphaned.json" "$CLI_DIR/dist/evidence/canonical.js"
ORPHANED="$(SELF evidence show "$OUT/orphaned.json" 2>&1 || true)"
echo "$ORPHANED" | grep -q "does not carry" || fail "show rendered a bundle whose facts outlive their sources"
SELF evidence show "$OUT/orphaned.json" > /dev/null 2>&1 && fail "show rendered a structurally hollow bundle"
# an exclusion line quietly deleted from the carried copy is caught too
node -e '
const fs = require("node:fs");
const { digestOf, canonicalBytes } = require(process.argv[3]);
const bundle = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
bundle.pins.self.head = "01kyvzvraamhewfvbk7t586s99";
bundle.digest = "";
bundle.digest = digestOf(bundle);
fs.writeFileSync(process.argv[2], canonicalBytes(bundle));
' "$OUT/first.json" "$OUT/repinned.json" "$CLI_DIR/dist/evidence/canonical.js"
REPINNED="$(SELF evidence show "$OUT/repinned.json" 2>&1 || true)"
echo "$REPINNED" | grep -q "embedded manifest" || fail "a bundle whose carried pins left its manifest behind was rendered"
# the event count is the one pin the embedded manifest never states, so it is
# reconciled against the store instead
node -e '
const fs = require("node:fs");
const { digestOf, canonicalBytes } = require(process.argv[3]);
const bundle = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
bundle.pins.eventCount = bundle.pins.eventCount + 7;
bundle.digest = "";
bundle.digest = digestOf(bundle);
fs.writeFileSync(process.argv[2], canonicalBytes(bundle));
' "$OUT/first.json" "$OUT/miscounted.json" "$CLI_DIR/dist/evidence/canonical.js"
MISCOUNTED="$(SELF evidence verify "$OUT/miscounted.json" 2>&1 || true)"
echo "$MISCOUNTED" | grep -q "pins.eventCount" || fail "a bundle claiming a log length the store never had verified"

# fail-closed: a rewritten source event refuses to recompile, and verify on the
# bundle compiled before the rewrite names the source that moved
cp "$LOG_A" "$ROOT/log.before"
node -e '
const fs = require("node:fs");
const [file, id] = process.argv.slice(1);
const lines = fs.readFileSync(file, "utf8").split("\n").filter((line) => line !== "");
const rewritten = lines.map((line) =>
{
    const event = JSON.parse(line);
    if (event.id !== id) { return line; }
    event.payload.text = "a decision text nobody confirmed";
    return JSON.stringify(event);
});
fs.writeFileSync(file, rewritten.join("\n") + "\n");
' "$LOG_A" "$DEC"
MOVED="$(SELF evidence compile "$OUT/pinned.json" --out moved.json 2>&1 || true)"
echo "$MOVED" | grep -q "history was rewritten" || fail "a rewritten log still compiled under its old pin"
[ -e "$OUT/moved.json" ] && fail "a refused compile wrote a bundle"
DIVERGED="$(SELF evidence verify "$OUT/first.json" 2>&1 || true)"
echo "$DIVERGED" | grep -q "$DEC" || fail "verify did not name the source that changed"
echo "$DIVERGED" | grep -q "logSha256" || fail "verify did not name the diverged log pin"
cp "$ROOT/log.before" "$LOG_A"
SELF evidence verify "$OUT/first.json" | grep -q "verifies" || fail "the restored log did not verify again"

# privacy-negative: a credential-shaped value, an absolute path, and a field the
# profile does not carry each refuse. Each arrives by hand, because the event
# guard refuses the first two at the door — this is the second screen, over what
# leaves the store rather than what enters it.
plant()
{
    node -e '
const fs = require("node:fs");
const [file, payload] = process.argv.slice(1);
const lines = fs.readFileSync(file, "utf8").split("\n").filter((line) => line !== "");
const last = JSON.parse(lines[lines.length - 1]);
const planted = { id: process.env.PLANT_ID, ts: last.ts, type: "decision.confirmed",
    origin: { actor: "agent", confirmed: true }, project: "demo", payload: JSON.parse(payload) };
fs.writeFileSync(file, [...lines, JSON.stringify(planted)].join("\n") + "\n");
' "$LOG_A" "$1"
}

refuses()
{
    PLANT_ID="$1"
    export PLANT_ID
    cp "$ROOT/log.before" "$LOG_A"
    plant "$2"
    cat > "$OUT/planted.json" <<EOF
{ "format": "self.evidence.manifest@1", "profile": "research", "project": "demo",
  "select": { "decisions": ["$PLANT_ID"] }, "pins": {}, "exclude": [] }
EOF
    rm -f "$OUT/planted.pinned.json"
    SELF evidence compile "$OUT/planted.json" --pin --out planted.pinned.json > /dev/null
    OUTPUT="$(SELF evidence compile "$OUT/planted.pinned.json" --out planted.bundle.json 2>&1 || true)"
    echo "$OUTPUT" | grep -q "$3" || fail "the disclosure screen did not refuse $3 — got: $OUTPUT"
    [ -e "$OUT/planted.bundle.json" ] && fail "a refused compile wrote a bundle"
    rm -f "$OUT/planted.pinned.json"
}

refuses 01kyvzvraamhewfvbk7t586s01 '{"text":"rotate AKIA1234567890ABCDEF before publishing"}' "credential"
refuses 01kyvzvraamhewfvbk7t586s02 '{"text":"the report landed in /Users/example/work/out.json"}' "absolute filesystem path"
refuses 01kyvzvraamhewfvbk7t586s03 '{"text":"a decision","detail":"a field the profile never declared"}' "research profile does not carry"
# a path names the machine wherever it sits in the value, not only after a space
refuses 01kyvzvraamhewfvbk7t586s05 '{"text":"output:/Users/example/work/out.json"}' "absolute filesystem path"
refuses 01kyvzvraamhewfvbk7t586s06 '{"text":"failed at/Users/example/work/out.json"}' "absolute filesystem path"
refuses 01kyvzvraamhewfvbk7t586s07 '{"text":"see file:///Users/example/work/out.json"}' "absolute filesystem path"

# the store's own id grammar is not key material: a note citing joined event ids
# compiles, which is the false positive the credential rule used to raise (#133)
PLANT_ID=01kyvzvraamhewfvbk7t586s04
export PLANT_ID
cp "$ROOT/log.before" "$LOG_A"
plant '{"text":"supersedes decisions-01kyvzvraamhewfvbk7t586s80-01kyvzvyw7tkjyz8v695a1cbmt"}'
cat > "$OUT/ids.json" <<EOF
{ "format": "self.evidence.manifest@1", "profile": "research", "project": "demo",
  "select": { "decisions": ["$PLANT_ID"] }, "pins": {}, "exclude": [] }
EOF
SELF evidence compile "$OUT/ids.json" --pin --out ids.pinned.json > /dev/null
SELF evidence compile "$OUT/ids.pinned.json" --out ids.bundle.json > /dev/null || fail "a note citing joined event ids was refused as a credential"

# a web URL carries a path that resolves for every reader, so it is not the
# machine-naming path the screen is about
PLANT_ID=01kyvzvraamhewfvbk7t586s08
export PLANT_ID
cp "$ROOT/log.before" "$LOG_A"
plant '{"text":"stated in https://github.com/fxylabs/superself/issues/145"}'
cat > "$OUT/url.json" <<EOF
{ "format": "self.evidence.manifest@1", "profile": "research", "project": "demo",
  "select": { "decisions": ["$PLANT_ID"] }, "pins": {}, "exclude": [] }
EOF
SELF evidence compile "$OUT/url.json" --pin --out url.pinned.json > /dev/null
SELF evidence compile "$OUT/url.pinned.json" --out url.bundle.json > /dev/null || fail "a decision citing an issue URL was refused as a filesystem path"
cp "$ROOT/log.before" "$LOG_A"

# selectors fail closed in two distinguishable ways
cat > "$OUT/missing.json" <<EOF
{ "format": "self.evidence.manifest@1", "profile": "research", "project": "demo",
  "select": { "decisions": ["zzzzzzzzzz"] }, "pins": {}, "exclude": [] }
EOF
SELF evidence compile "$OUT/missing.json" --pin --out missing.pinned.json > /dev/null
NOMATCH="$(SELF evidence compile "$OUT/missing.pinned.json" --out none.json 2>&1 || true)"
echo "$NOMATCH" | grep -q "matches the selector \"zzzzzzzzzz\"" || fail "a selector matching nothing did not name itself"
echo "$NOMATCH" | grep -q "demo" || fail "a zero-match refusal did not name the store it searched"
cat > "$OUT/ambiguous.json" <<EOF
{ "format": "self.evidence.manifest@1", "profile": "research", "project": "demo",
  "select": { "decisions": ["0"] }, "pins": {}, "exclude": [] }
EOF
SELF evidence compile "$OUT/ambiguous.json" --pin --out ambiguous.pinned.json > /dev/null
AMBIG="$(SELF evidence compile "$OUT/ambiguous.pinned.json" --out none.json 2>&1 || true)"
echo "$AMBIG" | grep -q "matches 2 records" || fail "an ambiguous selector did not count its candidates"
echo "$AMBIG" | grep -q "$DEC" || fail "an ambiguous selector did not name its candidates"

# naming one source twice is two claims about one record, and it would leave the
# bundle with two rows for a ref the reconciliation expects once
cat > "$OUT/duplicate.json" <<EOF
{ "format": "self.evidence.manifest@1", "profile": "research", "project": "demo",
  "select": { "decisions": ["$DEC", "$DEC"] }, "pins": {}, "exclude": [] }
EOF
SELF evidence compile "$OUT/duplicate.json" --pin --out duplicate.pinned.json > /dev/null
DUPLICATE="$(SELF evidence compile "$OUT/duplicate.pinned.json" --out duplicate.bundle.json 2>&1 || true)"
echo "$DUPLICATE" | grep -q "more than once" || fail "a duplicated selector compiled two rows for one ref"
echo "$DUPLICATE" | grep -q "$DEC" || fail "a duplicated selector was not named"
[ -e "$OUT/duplicate.bundle.json" ] && fail "a refused compile wrote a bundle"

# an exclusion is visible in the bundle, and one that withholds nothing refuses
cat > "$OUT/excluded.json" <<EOF
{ "format": "self.evidence.manifest@1", "profile": "research", "project": "demo",
  "select": { "decisions": ["$DEC"], "work": ["$WID"] },
  "pins": {}, "exclude": [{ "ref": "$WID", "why": "the unit is still open" }] }
EOF
SELF evidence compile "$OUT/excluded.json" --pin --out excluded.pinned.json > /dev/null
SELF evidence compile "$OUT/excluded.pinned.json" --out excluded.bundle.json > /dev/null
node -e '
const bundle = require(process.argv[1]);
if (bundle.exclusions.length !== 1) { console.error("exclusion not recorded"); process.exit(1); }
if (bundle.sources.some((s) => s.ref === process.argv[2])) { console.error("excluded source compiled"); process.exit(1); }
' "$OUT/excluded.bundle.json" "$WID" || fail "an exclusion was not visible in the bundle"
cat > "$OUT/stale.json" <<EOF
{ "format": "self.evidence.manifest@1", "profile": "research", "project": "demo",
  "select": { "decisions": ["$DEC"] }, "pins": {},
  "exclude": [{ "ref": "w-nothing", "why": "never selected" }] }
EOF
SELF evidence compile "$OUT/stale.json" --pin --out stale.pinned.json > /dev/null
STALE="$(SELF evidence compile "$OUT/stale.pinned.json" --out stale.bundle.json 2>&1 || true)"
echo "$STALE" | grep -q "never included" || fail "an exclusion that withholds nothing was accepted"

# a pinned commit that does not resolve, and a pin that is an abbreviation
cat > "$OUT/badcommit.json" <<EOF
{ "format": "self.evidence.manifest@1", "profile": "research", "project": "demo",
  "select": { "commits": [{ "repo": "demo", "commit": "$COMMIT" }] },
  "pins": { "self": { "head": "unset", "logSha256": "unset" },
            "git": [{ "repo": "demo", "commit": "0000000000000000000000000000000000000000" }] },
  "exclude": [] }
EOF
BADCOMMIT="$(SELF evidence compile "$OUT/badcommit.json" --pin --out badcommit.pinned.json 2>&1 || true)"
echo "$BADCOMMIT" | grep -q "does not resolve in repository \"demo\"" || fail "an unresolvable commit pin was accepted"
cat > "$OUT/shortpin.json" <<EOF
{ "format": "self.evidence.manifest@1", "profile": "research", "project": "demo",
  "select": { "decisions": ["$DEC"] },
  "pins": { "git": [{ "repo": "demo", "commit": "$(echo "$COMMIT" | cut -c1-12)" }] }, "exclude": [] }
EOF
SHORTPIN="$(SELF evidence compile "$OUT/shortpin.json" --pin --out shortpin.pinned.json 2>&1 || true)"
echo "$SHORTPIN" | grep -q "full 40-character length" || fail "an abbreviated commit pin was accepted"

# unknown format versions refuse by name, on the manifest and on the bundle
manifest "$OUT/future.json" "self.evidence.manifest@2"
FUTURE="$(SELF evidence compile "$OUT/future.json" --out future.bundle.json 2>&1 || true)"
echo "$FUTURE" | grep -q "self.evidence.manifest@2" || fail "an unknown manifest version was not named"
echo "$FUTURE" | grep -q "self.evidence.manifest@1" || fail "an unknown manifest version did not name what is supported"
node -e '
const fs = require("node:fs");
const bundle = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
bundle.format = "self.evidence.bundle@2";
fs.writeFileSync(process.argv[2], JSON.stringify(bundle) + "\n");
' "$OUT/first.json" "$OUT/future.bundle"
FUTUREB="$(SELF evidence verify "$OUT/future.bundle" 2>&1 || true)"
echo "$FUTUREB" | grep -q "self.evidence.bundle@2" || fail "an unknown bundle version was not named"
echo "$FUTUREB" | grep -q "self.evidence.bundle@1" || fail "an unknown bundle version did not name what is supported"
SELF evidence show "$OUT/future.bundle" > /dev/null 2>&1 && fail "show read a bundle version it does not implement"

# output is a name, never a path, and never overwrites
OUTPATH="$(SELF evidence compile "$OUT/pinned.json" --out "$ROOT/elsewhere.json" 2>&1 || true)"
echo "$OUTPATH" | grep -q "is a path" || fail "--out accepted a path"
OVERWRITE="$(SELF evidence compile "$OUT/pinned.json" --out first.json 2>&1 || true)"
echo "$OVERWRITE" | grep -q "already exists" || fail "compile overwrote an existing bundle"
# a dangling symlink is not an existing file, and asking before writing would
# follow it out of the working directory
ln -s "$ROOT/nowhere/escaped.json" "$OUT/dangling.json"
DANGLING="$(SELF evidence compile "$OUT/pinned.json" --out dangling.json 2>&1 || true)"
echo "$DANGLING" | grep -q "already exists" || fail "compile followed a dangling symlink out of the working directory"
[ -e "$ROOT/nowhere/escaped.json" ] && fail "compile wrote through a dangling symlink"

# the whole subsystem writes no project state: no event, no store commit
LOG_AFTER="$(wc -l < "$LOG_A")"
STORE_AFTER="$(git -C "$STORE" rev-list --count HEAD)"
SELF evidence compile "$OUT/pinned.json" --out third.json > /dev/null
SELF evidence verify "$OUT/third.json" > /dev/null
SELF evidence show "$OUT/third.json" > /dev/null
[ "$(wc -l < "$LOG_A")" = "$LOG_AFTER" ] || fail "an evidence command appended an event"
[ "$(git -C "$STORE" rev-list --count HEAD)" = "$STORE_AFTER" ] || fail "an evidence command committed to the store"

echo "evidence-bundle OK"
