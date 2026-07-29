import { AttemptPlan } from "../attempt/plan.js";
import { WorkSpec } from "../spec/workspec.js";

// The categories nothing runs unattended, whatever any policy says.
//
// This is not a capability check — the runner's preflight already owns what an
// attempt may read, write and reach. This is the shorter list of effects that
// leave the machine and cannot be taken back: money moves, a person receives
// something, a package is public, infrastructure exists, bytes are gone, or the
// rules themselves changed. A policy stands in for an operator who is asleep,
// and none of those is a thing an operator can be assumed to have said yes to.
//
// So the list is categorical rather than budgeted: an overnight policy narrows
// what may run and can never widen it, and there is deliberately no flag, no
// risk class and no allow list anywhere in this product that admits one of
// these. The only way past it is a person, awake, doing it themselves.
//
// What this layer is not, said here rather than left to be discovered: it is
// not a security boundary. It reads a declaration — a tool list and an
// invocation — as literal text, and ordinary shell composition walks past it.
// `cu""rl` is not the word curl, a host decoded at runtime is not in the
// command, `/dev/tcp/host/80` names no client, and a fetch assembled from
// character codes says nothing at all. An author who wants past this gets past
// it. It is a fail-closed default against the effect nobody meant to run while
// they were asleep, which is the plainly written one that actually shows up.
// The bound that holds against an author who is trying is the runner's
// preflight — declared reads, writes, domains and secrets, enforced rather
// than read — and this list sits in front of it, not instead of it.
export const FORBIDDEN_ACTIONS = [
    "publish",
    "outreach",
    "payment",
    "purchase",
    "provision",
    "destructive",
    "policy-change"
];

// The words each category is actually declared under. A spec author writes
// `npm-publish`, `deploy` or `send-email`, never the category name, so matching
// only the canonical word would leave the list decorative.
//
// Matching errs closed on purpose: a capability declared as `email-parser` is
// refused, and the refusal names the category so its author can rename it or
// ask a person. The opposite error — a declaration nobody recognised running
// unattended — is the one this whole layer exists to prevent.
const ALIASES: Record<string, string[]> = {
    publish: ["publish", "npm", "release", "announce", "tweet"],
    outreach: ["outreach", "email", "mail", "sms", "dm", "slack", "discord"],
    payment: ["payment", "pay", "charge", "billing", "invoice", "stripe"],
    purchase: ["purchase", "buy", "checkout", "subscribe"],
    provision: ["provision", "deploy", "terraform", "kubectl", "helm", "aws", "gcloud"],
    destructive: ["destructive", "delete", "destroy", "drop", "wipe", "truncate", "rm", "rmrf"],
    "policy-change": ["policy-change", "sudo", "chmod", "escalate", "grant"]
};

// The category a declared action falls into, or null. The whole declaration is
// judged, and so is each word it is built from: `npm-publish` and `publishPkg`
// are the same ask under two spellings.
export function forbiddenAction(action: string): string | null
{
    return wordMatch(action)?.category ?? null;
}

// The category and the word that put it there. A tool name is short enough to
// quote back whole; a command is not, and a refusal that quoted a whole shell
// invocation would be a paragraph carrying this machine's paths in it.
interface WordMatch
{
    word: string;
    category: string;
}

function wordMatch(action: string): WordMatch | null
{
    const normalized = action.trim().toLowerCase();
    const words = [normalized.replace(/[^a-z0-9]/g, ""), ...wordsOf(action)];
    for (const [category, aliases] of Object.entries(ALIASES))
    {
        if (normalized === category)
        {
            return { word: normalized, category };
        }
        const word = words.find((part) => aliases.includes(part));
        if (word !== undefined)
        {
            return { word, category };
        }
    }
    return null;
}

// The words a declaration is built from, however it was cased or separated:
// `npm-publish`, `npm_publish` and `npmPublish` all arrive as two. Split before
// lowercasing, or a camel hump is not a boundary any more.
function wordsOf(action: string): string[]
{
    return action
        .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)
        .map((word) => word.toLowerCase())
        .filter((word) => word !== "");
}

export interface ForbiddenMatch
{
    action: string;
    category: string;
}

// What a declaration says it will do, judged. The tools a plan or a spec names
// are the one place a run states its own effects — everything else in either is
// a bound on effects the runner enforces — so that is what is read here.
export function forbiddenTools(tools: unknown): ForbiddenMatch | null
{
    if (!Array.isArray(tools))
    {
        return null;
    }
    for (const tool of tools)
    {
        const category = typeof tool === "string" ? forbiddenAction(tool) : null;
        if (category !== null)
        {
            return { action: String(tool), category };
        }
    }
    return null;
}

// The other half of what a run declares about itself. A capability list is a
// bound on what the run may reach; the command is the invocation that reaches
// it, and it is sealed declared bytes exactly like the rest — so a spec that
// names no tools at all and posts a charge through `curl` has declared a
// payment, whatever its tool list left out. Reading only the tools made the
// categorical list opt-in: an author who declared nothing was judged as having
// asked for nothing.
//
// What is read is the invocation, not everything the invocation carries —
// `invocation()` below is where that line is drawn and what it costs.
export function forbiddenCommand(command: unknown): ForbiddenMatch | null
{
    for (const token of invocation(command))
    {
        const match = wordMatch(token);
        if (match !== null)
        {
            return { action: match.word, category: match.category };
        }
    }
    return null;
}

// The tokens of a command array that state what it will do, with the payload
// it merely carries left out.
//
// A command array is one invocation rather than a document. argv[0] is the
// program, and what follows is either part of the invocation — a subcommand, a
// flag, a path, a URL — or an argument only the program itself knows how to
// read. In this product that argument is usually an agent prompt: a real plan
// here is ["claude", "-p", "<thousands of words of English>", "--model", …],
// and English contains "release", "checkout", "delete" and "grant" in their
// ordinary senses. Matching a table of program names against prose refuses
// legitimate work, and this list has no override by design — so a false
// positive here has no recovery except rewording somebody's prompt.
//
// The line: a token with whitespace in it was quoted to arrive as one
// argument, which is what a payload looks like and what an invocation token
// never is. The one exception is a shell's -c script, which is not carried
// anywhere — it is invocation text this machine executes word for word, and it
// is exactly where a command that declares nothing else hides a charge posted
// with `curl`.
//
// What the line gives up, stated rather than found out later:
//   - a payload that is a single word ("deploy") is still read as invocation,
//     because nothing tells it apart from a subcommand;
//   - a shell script that itself carries a prompt — sh -c "claude -p '…'" — is
//     read as code, so a word in that prose can still refuse it. Written as
//     ["claude", "-p", …] the same plan is payload again, which is how every
//     real plan in this product is written;
//   - a payload in another language (node -e, python -c) is not read at all.
//     This table is program and verb vocabulary, which is what shell words are
//     and what program source is not, and matching it against source would
//     produce noise rather than signal. What such a run may reach is the
//     capability declaration's statement and the runner's preflight enforces it.
function invocation(command: unknown): string[]
{
    const argv = tokens(command);
    const script = shellScript(argv);
    return argv.filter((token, index) => index === 0 || index === script || !/\s/.test(token)).map(judged);
}

// The shells whose -c argument is a script rather than a payload, and the flags
// that say so: `-c`, and the combined forms a wrapper writes like `-lc`.
const SHELLS = ["sh", "bash", "zsh", "dash", "ksh", "ash"];
const SHELL_C = /^-[a-z]*c$/;

// Where the script sits in the argument vector, or -1 when this command is not
// a shell being handed one.
function shellScript(argv: string[]): number
{
    if (argv.length === 0 || !SHELLS.includes(judged(argv[0])))
    {
        return -1;
    }
    const flag = argv.findIndex((token, index) => index > 0 && SHELL_C.test(token));
    return flag === -1 ? -1 : flag + 1;
}

function tokens(command: unknown): string[]
{
    return Array.isArray(command) ? command.filter((token): token is string => typeof token === "string") : [];
}

// A token is a path when it is one filesystem name and nothing else. A shell
// script has spaces in it and a bare URL has no leading slash, and neither is
// a program this machine happens to store somewhere.
const PATH_TOKEN = /^(?:\.{0,2}|~)\/\S*$/;

// An absolute or relative path is judged by its last segment. The directories a
// program happens to sit under on somebody's machine are not a declaration — a
// node binary inside a checkout called `deploy-tools` says nothing about what
// the run does — while `/usr/local/bin/aws` says everything.

function judged(token: string): string
{
    return PATH_TOKEN.test(token) ? token.slice(token.lastIndexOf("/") + 1) : token;
}

// The clients and the schemes a command reaches the network with. This is not a
// forbidden category — reaching the network is ordinary — it is what tells the
// risk class the truth when the capability declaration left it out.
const NETWORK_WORDS = ["curl", "wget", "ssh", "scp", "sftp", "rsync", "netcat", "telnet", "ftp", "http", "https"];

// Whether the command itself reaches off this machine. The runner builds its
// boundary from declared domains, so a spec that declares none and curls a host
// it never named is not internal risk — it is the case the declaration failed
// to state, and narrowing is the only honest way to guess.
//
// Read over the invocation for the same reason the forbidden list is: a URL
// quoted inside an agent's prompt is a thing the prompt mentions, and a run
// that is judged external for citing an issue link would be refused by every
// default policy for the rest of the night.
export function commandReachesNetwork(command: unknown): boolean
{
    return invocation(command).some(reaches);
}

function reaches(token: string): boolean
{
    return token.includes("://") || wordsOf(token).some((word) => NETWORK_WORDS.includes(word));
}

export function forbiddenDeclaration(plan: AttemptPlan): ForbiddenMatch | null
{
    return forbiddenTools(plan.capabilities.tools) ?? forbiddenCommand(plan.command);
}

// The same two questions asked of a sealed generation, so the wake set and the
// registration edge judge one declaration rather than two.
export function forbiddenSpec(spec: WorkSpec): ForbiddenMatch | null
{
    return forbiddenTools(spec.capabilities.tools) ?? forbiddenCommand(spec.command);
}

// One sentence, said the same way wherever the refusal lands: at registration,
// at a mid-run proposal, and in the wake set. A refusal that read differently
// in each place would look like three rules rather than one.
export function forbiddenRefusal(match: ForbiddenMatch, at: string): string
{
    return `${at} declares "${match.action}", which is ${match.category} — external publication, outreach, payment, purchase, ` +
        "cloud provisioning, destructive action and policy change are never done unattended, and no overnight policy can grant one";
}
