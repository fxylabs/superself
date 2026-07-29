import { parseCommand, subcommand } from "../args.js";
import { attemptMarker, confirmHuman, HumanConfirmation } from "../human.js";
import { ProjectContext, requireProject } from "../paths.js";
import { makeEvent, recordEvent } from "../pipeline.js";
import { CliError } from "../types.js";
import {
    describePolicy,
    loadPolicy,
    OvernightPolicy,
    policyVersion,
    RISK_CLASSES,
    RiskClass,
    validTime
} from "./policy.js";

const USAGE = "usage: self overnight set [--from 22:00] [--to 07:00] [--digest-at 07:30] [--auto-dispatch] [--project p] " +
    "[--risk r] [--kind k] [--provider p] [--model m] [--max-concurrent n] [--budget-usd n] [--max-runs n] [--stop-after n] | show | off";

const OPTIONS = {
    from: { type: "string" },
    to: { type: "string" },
    "digest-at": { type: "string" },
    "auto-dispatch": { type: "boolean" },
    project: { type: "string", multiple: true },
    risk: { type: "string", multiple: true },
    kind: { type: "string", multiple: true },
    provider: { type: "string", multiple: true },
    model: { type: "string", multiple: true },
    "max-concurrent": { type: "string" },
    "budget-usd": { type: "string" },
    "max-runs": { type: "string" },
    "stop-after": { type: "string" }
} as const;

export function runOvernightCommand(rest: string[]): void
{
    switch (subcommand("overnight", rest))
    {
        case "set": cmdSet(rest.slice(1)); return;
        case "show": case undefined: cmdShow(rest.slice(1)); return;
        case "off": cmdOff(rest.slice(1)); return;
        default: throw new CliError(USAGE);
    }
}

// Everything defaults to the narrowest thing that is still a policy: one
// project, internal risk, a concurrency of one, and auto-dispatch off. A flag
// widens what the operator names and nothing widens itself, which is what lets
// `self overnight set` with no flags be a safe thing to type.
function cmdSet(args: string[]): void
{
    const ctx = requireProject(process.cwd());
    const { values } = parseCommand("overnight", args, OPTIONS, 0);
    const policy: OvernightPolicy = {
        version: policyVersion(ctx.storeDir, ctx.project) + 1,
        setAt: new Date().toISOString(),
        from: validTime(values.from ?? "22:00", "--from"),
        to: validTime(values.to ?? "07:00", "--to"),
        digestAt: validTime(values["digest-at"] ?? "07:30", "--digest-at"),
        projects: values.project ?? [ctx.project],
        riskClasses: risks(values.risk),
        kinds: values.kind ?? ["implementation"],
        providers: values.provider ?? null,
        models: values.model ?? null,
        maxConcurrent: count(values["max-concurrent"], 1, "--max-concurrent"),
        budgetUsd: values["budget-usd"] === undefined ? null : amount(values["budget-usd"]),
        maxRuns: values["max-runs"] === undefined ? null : count(values["max-runs"], 1, "--max-runs"),
        stopAfterFailures: values["stop-after"] === undefined ? null : count(values["stop-after"], 1, "--stop-after"),
        autoDispatch: values["auto-dispatch"] === true
    };
    // Everything above is a parse: a flag that is not a time, not a risk class
    // or not a whole number is answered before a person is asked for anything,
    // because a typo costs the command and nothing else.
    const confirmation = grantedByHand(policy);
    recordEvent(
        ctx,
        makeEvent(ctx.project, "overnight.set", { version: policy.version, policy: policy as unknown as Record<string, unknown>, confirmation }, undefined, true),
        `overnight policy v${policy.version}, ${policy.from}–${policy.to}`
    );
    console.log(describePolicy(policy).join("\n"));
}

// The one thing in this product that authorizes spending a provider's money
// with nobody watching, gated the way `self work approve` is gated. Two
// different processes are refused here and they are refused for two different
// reasons.
//
// An attempt is refused by its marker: the policy names the risk classes, the
// budget and the concurrency an agent's own runs are bounded by, and an agent
// that could write it would be bounding itself. A marker is only the honest
// half of that, though — a process that sets its own environment can take one
// off — so the terminal is the half that actually holds. An agent attempt has
// no terminal to be at, and nothing it can put in its environment gives it one.
function grantedByHand(policy: OvernightPolicy): HumanConfirmation
{
    const marker = attemptMarker();
    if (marker !== undefined)
    {
        throw new CliError(`an overnight policy cannot be set from an agent attempt — this process carries the attempt marker ${marker}, ` +
            "and the policy that bounds what an attempt may spend is written by a person at their own terminal");
    }
    const window = `${policy.from}-${policy.to}`;
    const confirmation = confirmHuman(`overnight policy v${policy.version} — ${grant(policy)}`, window);
    if ("code" in confirmation)
    {
        throw new CliError(`${confirmation.detail} [${confirmation.code}] — next: ${confirmation.next}`);
    }
    return confirmation;
}

// What the operator is being asked to grant, on one line, before they type the
// window back. The flags they passed are the statement; this is that statement
// read out in the terms that cost something.
function grant(policy: OvernightPolicy): string
{
    const spend = policy.budgetUsd === null ? "no ceiling on declared cost" : `at most $${policy.budgetUsd} declared`;
    return policy.autoDispatch
        ? `${policy.from}–${policy.to} local, ${policy.riskClasses.join("/")} risk, up to ${policy.maxConcurrent} attempt(s) at once, ${spend}`
        : `${policy.from}–${policy.to} local, auto-dispatch off — nothing is woken under it`;
}

// Risk is the one allow list this refuses to widen past what it understands: an
// unrecognised class would be permanently unmatchable, so a policy naming one
// would silently wake nothing and read as if it had been set.
function risks(values: string[] | undefined): RiskClass[]
{
    const asked = (values ?? ["internal"]).map((value) => value.trim().toLowerCase());
    const unknown = asked.filter((value) => !RISK_CLASSES.includes(value as RiskClass));
    if (unknown.length > 0)
    {
        throw new CliError(`--risk "${unknown[0]}" is not a risk class — a spec is judged ${RISK_CLASSES.join(", ")} by what it declares`);
    }
    return asked as RiskClass[];
}

function count(value: string | undefined, fallback: number, flag: string): number
{
    if (value === undefined)
    {
        return fallback;
    }
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1)
    {
        throw new CliError(`${flag} expects a whole number of at least 1`);
    }
    return number;
}

function amount(value: string): number
{
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0)
    {
        throw new CliError("--budget-usd expects a positive amount");
    }
    return number;
}

function cmdShow(args: string[]): void
{
    const ctx = requireProject(process.cwd());
    const { values } = parseCommand("overnight", args, { json: { type: "boolean" } }, 0);
    const policy = loadPolicy(ctx.storeDir, ctx.project);
    if (values.json === true)
    {
        console.log(JSON.stringify(policy, null, 2));
        return;
    }
    console.log(policy === null
        ? "no overnight policy is in force — the daemon supervises what exists and dispatches nothing new"
        : describePolicy(policy).join("\n"));
}

// Revocation is a recorded event rather than the absence of one: a night that
// stopped early has to be as legible afterwards as a night that never started.
//
// An attempt is refused this too — an agent revoking the policy that governs it
// is the same process reaching for the same document. It is not asked for a
// terminal, though, and that asymmetry with `set` is deliberate: revoking only
// narrows, and a person who wants unattended spending to stop must never be
// held up by a script that has no terminal to be at.
function cmdOff(args: string[]): void
{
    const ctx = requireProject(process.cwd());
    parseCommand("overnight", args, {}, 0);
    const marker = attemptMarker();
    if (marker !== undefined)
    {
        throw new CliError(`an overnight policy cannot be revoked from an agent attempt — this process carries the attempt marker ${marker}, ` +
            "and the policy an attempt runs under is not one it may change");
    }
    const policy = revocable(ctx);
    recordEvent(
        ctx,
        makeEvent(ctx.project, "overnight.revoked", { version: policy.version }),
        `overnight policy v${policy.version} revoked`
    );
    console.log("overnight policy revoked — the daemon keeps supervising and dispatches nothing new");
}

function revocable(ctx: ProjectContext): OvernightPolicy
{
    const policy = loadPolicy(ctx.storeDir, ctx.project);
    if (policy === null)
    {
        throw new CliError("no overnight policy is in force — there is nothing to revoke");
    }
    return policy;
}
