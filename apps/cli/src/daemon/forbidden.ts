import { AttemptPlan } from "../attempt/plan.js";

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
    const normalized = action.trim().toLowerCase();
    const words = [normalized.replace(/[^a-z0-9]/g, ""), ...wordsOf(action)];
    for (const [category, aliases] of Object.entries(ALIASES))
    {
        if (normalized === category || words.some((word) => aliases.includes(word)))
        {
            return category;
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

export function forbiddenDeclaration(plan: AttemptPlan): ForbiddenMatch | null
{
    return forbiddenTools(plan.capabilities.tools);
}

// One sentence, said the same way wherever the refusal lands: at registration,
// at a mid-run proposal, and in the wake set. A refusal that read differently
// in each place would look like three rules rather than one.
export function forbiddenRefusal(match: ForbiddenMatch, at: string): string
{
    return `${at} declares "${match.action}", which is ${match.category} — external publication, outreach, payment, purchase, ` +
        "cloud provisioning, destructive action and policy change are never done unattended, and no overnight policy can grant one";
}
