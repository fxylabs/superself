import { parseCommand, subcommand } from "../args.js";
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
    recordEvent(
        ctx,
        makeEvent(ctx.project, "overnight.set", { version: policy.version, policy: policy as unknown as Record<string, unknown> }),
        `overnight policy v${policy.version}, ${policy.from}–${policy.to}`
    );
    console.log(describePolicy(policy).join("\n"));
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
function cmdOff(args: string[]): void
{
    const ctx = requireProject(process.cwd());
    parseCommand("overnight", args, {}, 0);
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
