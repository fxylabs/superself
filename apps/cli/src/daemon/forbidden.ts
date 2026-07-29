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
// An absolute or relative path is judged by its last segment. The directories a
// program happens to sit under on somebody's machine are not a declaration — a
// node binary inside a checkout called `deploy-tools` says nothing about what
// the run does — while `/usr/local/bin/aws` says everything. Every other token
// is judged whole, so a shell payload with a host inside it is read as the one
// thing it is: the effect this run will have.
export function forbiddenCommand(command: unknown): ForbiddenMatch | null
{
    for (const token of tokens(command))
    {
        const match = wordMatch(judged(token));
        if (match !== null)
        {
            return { action: match.word, category: match.category };
        }
    }
    return null;
}

function tokens(command: unknown): string[]
{
    return Array.isArray(command) ? command.filter((token): token is string => typeof token === "string") : [];
}

// A token is a path when it is one filesystem name and nothing else. A shell
// payload has spaces in it and a bare URL has no leading slash, and neither is
// a program this machine happens to store somewhere.
const PATH_TOKEN = /^(?:\.{0,2}|~)\/\S*$/;

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
export function commandReachesNetwork(command: unknown): boolean
{
    return tokens(command).some((token) => reaches(judged(token)));
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
