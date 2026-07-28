// The guard every synced event crosses, driven directly so each shape it must
// refuse — and each shape it must not — is named on its own. The end-to-end
// half lives in proof.sh, where a real command is refused and the log is shown
// to be untouched; this half is the table of shapes, which a CLI proof cannot
// enumerate without a command per row.
import { homedir } from "node:os";
import { join } from "node:path";
import { assertSanitized } from "../dist/sanitize.js";

const failures = [];

function event(payload)
{
    return { id: "01JTEST", ts: "2026-07-28T00:00:00.000Z", type: "decision.made", origin: { actor: "agent", confirmed: true }, project: "demo", payload };
}

function refusal(payload)
{
    try
    {
        assertSanitized(event(payload));
        return null;
    }
    catch (error)
    {
        return error.message;
    }
}

// Refused, and the message names where it was without repeating what it was.
function refuses(what, payload, keyPath, secret)
{
    const message = refusal(payload);
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

function records(what, payload)
{
    const message = refusal(payload);
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

if (failures.length > 0)
{
    console.error(failures.join("\n"));
    process.exit(1);
}
console.log("event sanitization OK");
