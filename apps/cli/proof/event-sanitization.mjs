// The guard every synced event crosses, driven directly so each shape it must
// refuse — and each shape it must not — is named on its own. The end-to-end
// half lives in proof.sh, where a real command is refused and the log is shown
// to be untouched; this half is the table of shapes, which a CLI proof cannot
// enumerate without a command per row.
import { homedir } from "node:os";
import { join } from "node:path";
import { assertSanitized } from "../dist/sanitize.js";

const failures = [];

// `rest` is what a row needs when the field under test is not the payload:
// refs and origin cross the same boundary in the same line.
function event(payload, rest)
{
    return { id: "01JTEST", ts: "2026-07-28T00:00:00.000Z", type: "decision.made", origin: { actor: "agent", confirmed: true }, project: "demo", payload, ...rest };
}

function refusal(payload, rest)
{
    try
    {
        assertSanitized(event(payload, rest));
        return null;
    }
    catch (error)
    {
        return error.message;
    }
}

// Refused, and the message names where it was without repeating what it was.
function refuses(what, payload, keyPath, secret, rest)
{
    const message = refusal(payload, rest);
    if (message === null)
    {
        failures.push(`${what}: recorded an event that should have been refused`);
        return;
    }
    if (!message.includes(keyPath))
    {
        failures.push(`${what}: the refusal does not say which key it was — ${message}`);
    }
    if (secret !== undefined && message.includes(secret))
    {
        failures.push(`${what}: the refusal printed the value it refused`);
    }
}

function records(what, payload, rest)
{
    const message = refusal(payload, rest);
    if (message !== null)
    {
        failures.push(`${what}: a legitimate event was refused — ${message}`);
    }
}

const HOME_PATH = join(homedir(), "notes", "private.md");
const KEY = "sk-live-AAAABBBBCCCCDDDDEEEE00001111";

// A field whose name says the value came off a machine, at any depth and
// through an array, however the name is spelled.
refuses("a raw prompt", { prompt: "you are an agent" }, "payload.prompt");
refuses("a process id", { attempt: "a-1", pid: 4321 }, "payload.pid");
refuses("a working directory", { cwd: "/srv/app" }, "payload.cwd", "/srv/app");
refuses("an environment map", { env: { PATH: "/usr/bin" } }, "payload.env");
refuses("a nested credential field", { result: { githubToken: "x" } }, "payload.result.githubToken");
refuses("a credential field inside an array", { runs: [{ ok: true }, { api_key: "x" }] }, "payload.runs[1].api_key");
refuses("a spelling of the same name", { "Access-Key": "x" }, "payload.Access-Key");

// A value that names this machine rather than the state.
refuses("a path under this machine's home", { text: `see ${HOME_PATH}` }, "payload.text", HOME_PATH);
refuses("a home path nested in an array", { notes: ["fine", `then ${HOME_PATH}`] }, "payload.notes[1]", HOME_PATH);

// A value shaped like key material, whatever field carries it.
refuses("a bearer header", { text: `Authorization: Bearer ${KEY}` }, "payload.text", KEY);
refuses("a provider key in prose", { text: `rotate ${KEY} tomorrow` }, "payload.text", KEY);
refuses("an assignment carrying key material", { why: `api_key=${KEY}` }, "payload.why", KEY);

// An explicit credential encoding is a leak at any entropy. Nothing below
// carries generated key material — a pasted config snippet and a human-chosen
// password are the common shape, not the rare one — and the entropy test that
// holds the eager rules back must not reach these.
refuses("a low-entropy secret in a JSON field", { text: 'the config has {"api_key": "abc123secret"}' }, "payload.text", "abc123secret");
refuses("a low-entropy assignment", { why: "password=hunter2correct works" }, "payload.why", "hunter2correct");
refuses("a named secret assignment", { text: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI" }, "payload.text", "wJalrXUtnFEMI");
refuses("a basic authorization header", { text: "Authorization: Basic dXNlcjpwYXNz" }, "payload.text", "dXNlcjpwYXNz");
refuses("a cookie header", { text: "cookie: session=abc" }, "payload.text", "session=abc");
refuses("a vendor-prefixed literal", { text: "rotated ghp_AAAAAAAAAAAAAAAA today" }, "payload.text", "ghp_AAAAAAAAAAAAAAAA");
refuses("an access key id", { text: "AKIAAAAAAAAAAAAAAAAA" }, "payload.text", "AKIAAAAAAAAAAAAAAAAA");

// A key is data too, and it is the one string the refusal cannot quote — so it
// is named by where it sits.
refuses("a home path used as a field name", { [HOME_PATH]: "ok" }, "payload key #0", HOME_PATH);
refuses("key material used as a field name", { [KEY]: { note: "x" } }, "payload key #0", KEY);
refuses("key material as a field name deeper in", { result: { ok: true, [KEY]: 1 } }, "payload.result key #1", KEY);

// The concept is what is forbidden, not the spelling: a payload shape added
// later reaches for the alias long before it reaches for the bare word.
refuses("a plural process id list", { PIDs: [1, 2] }, "payload.PIDs");
refuses("an alias of the environment map", { envVars: { PATH: "/usr/bin" } }, "payload.envVars");
refuses("a spelled-out environment map", { environmentVariables: { PATH: "/usr/bin" } }, "payload.environmentVariables");
refuses("an alias of the working directory", { workingDirectory: "/srv/app" }, "payload.workingDirectory", "/srv/app");
refuses("an alias of the home directory", { homePath: "/srv/app" }, "payload.homePath", "/srv/app");

// The home directory is one place however it is spelled. A filesystem that
// resolves it without regard to case must not be a way past the check, and on
// one that does regard case those letters name a different directory.
if (process.platform === "darwin" || process.platform === "win32")
{
    refuses("a home path in another case", { text: `see ${HOME_PATH.toUpperCase()}` }, "payload.text");
}
else if (HOME_PATH.toUpperCase() !== HOME_PATH)
{
    records("a path that only shares this home's letters", { text: `see ${HOME_PATH.toUpperCase()}` });
}

// The payload is not the only field that syncs. `--evidence` lands in refs and
// the session name lands in origin; neither passes another check.
refuses("a home path handed to --evidence", {}, "refs.commits[0]", HOME_PATH, { refs: { commits: [HOME_PATH] } });
refuses("key material handed to --evidence", {}, "refs.commits[0]", KEY, { refs: { commits: [KEY] } });
refuses("a home path in the session name", {}, "origin.session", HOME_PATH, { origin: { actor: "agent", confirmed: true, session: HOME_PATH } });

// The value of a variable whose name declares it a secret, caught by value in
// prose that matches no pattern at all, with the name in the refusal and the
// value nowhere in it.
process.env.PROOF_API_KEY = "ordinary-looking-declared-value";
refuses("a declared secret echoed in prose", { text: "the value is ordinary-looking-declared-value" }, "payload.text", "ordinary-looking-declared-value");
if (!(refusal({ text: "the value is ordinary-looking-declared-value" }) ?? "").includes("PROOF_API_KEY"))
{
    failures.push("a declared secret echoed in prose: the refusal does not say which variable leaked");
}
// Too short to be redacted by value, so it is not refused by value either:
// taking four characters out of every word that contains them would refuse
// most sentences. The runner already warns at launch that such a declaration
// is uncovered.
process.env.PROOF_API_KEY = "ab";
records("a declared secret below the redaction floor", { text: "ab is not a credential" });
delete process.env.PROOF_API_KEY;

// What the guard must not touch. Every one of these is a payload main's own
// verbs write, and prose about credentials is not a credential: a log that
// cannot hold the sentence someone wrote about token counting is a worse
// record than none.
records("a decision", { text: "supervisor events extend the run.* namespace", why: "integration owns attempt.*" });
records("prose about tokens", { text: "reduced token counting overhead by 40%" });
records("prose about basic authentication", { text: "we chose basic authentication for the admin surface" });
records("prose about secret scanning", { text: "secret scanning is on for every repository" });
records("a git head", { repository: "demo", head: "3fd418a8f0d9c2b1e4a5f6d7c8b9a0e1f2d3c4b5" });
records("a boundary digest", { attempt: "a-1", digest: "9f2b1c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809" });
records("a store-relative artifact path", { artifacts: [{ id: "ar-1", name: "brief.md", path: "artifacts/demo/ar-1-brief.md" }] });
// The integration train records what an attempt ran on purpose, so a command
// is judged by what it says rather than refused for what the field is called.
records("the commands an integration attempt ran", { attempt: "ia-1", commands: [{ command: "git rebase --onto main", exit: 0 }] });
records("a home path already folded to a placeholder", { text: "see ~/notes/private.md" });
records("a dedupe key", { repository: "demo", dedupe: "main:demo:3fd418a8f0d9c2b1e4a5f6d7c8b9a0e1f2d3c4b5:pr-1" });
records("counts and flags", { attempt: "a-1", runs: 3, reported: true, failure: null });

// The same prose with an identifier beside it. Every half of these is already
// recorded above on its own; judging the whole string instead of the span that
// matched is only visible once they share a sentence, which is what a report
// body written by hand actually looks like.
records("a branch slug beside prose about tokens", { text: "on feat/61-event-sanitization-guard we reduced token counting overhead" });
records("an issue slug beside prose about basic authentication", { text: "issue 148-pairing-token-replay: we chose basic authentication" });
records("a head sha beside prose about basic authentication", { text: "we chose basic authentication for the admin surface, head 3fd418a8f0d9c2b1e4a5f6d7c8b9a0e1f2d3c4b5" });
records("a report body carrying all of it", { text: "# brief\n\nbranch feat/61-event-sanitization-guard at 3fd418a8f0d9c2b1e4a5f6d7c8b9a0e1f2d3c4b5.\n\nwe kept basic authentication and reduced token counting overhead.\n" });

// A name that merely contains a forbidden word is a different field, so the
// word rule is a word rule and not a substring one.
records("a review envelope", { envelope: { id: "e-1", verdict: "approve" } });
records("an author", { author: "agent", authored: true });
records("a homepage", { homepage: "https://example.com/docs" });

// What refs and origin normally carry.
records("evidence, work, and a session name", {}, { refs: { commits: ["3fd418a8f0d9c2b1e4a5f6d7c8b9a0e1f2d3c4b5"], work: "01JWORK", artifacts: ["ar-1"] }, origin: { actor: "human", confirmed: true, session: "review-2026-07-28" } });

if (failures.length > 0)
{
    console.error(failures.join("\n"));
    process.exit(1);
}
console.log("event sanitization OK");
