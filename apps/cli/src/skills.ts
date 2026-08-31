// The derived reading of a registered skill (#391): what a project can answer
// with, which version of each skill holds, what happens where a project skill
// and a workspace skill share a name, and what a caller still has to fill in
// before pasting the line. Domain layer — it reads the entity fold and its own
// peers only, never the model that calls it.
//
// Nothing here is stored. A skill is an entity labelled `skill`: its name is
// the text, its purpose the `why`, its one-line body the reserved metadata
// `criteria`, and its longer recipe the reserved `artifact`. Its version is its
// place in the supersedes chain, derived on every read the way a runbook's
// edition is, so no stored field can contradict the log.

import { chainVersion, EntityState, isCurrent, orderEntities, supersedesChain } from "@superself/fold";
import { oneLine } from "./style.js";

// The one label this surface records under. Never a row in `BUILTIN_ROWS` —
// see `SKILL_ROW` in `skill.ts` for why.
export const SKILL_LABEL = "skill";

export function isSkill(entity: EntityState): boolean
{
    return entity.labels.includes(SKILL_LABEL) && entity.source === undefined;
}

// The whole chain a skill id belongs to, oldest version first. The walk is
// `@superself/fold` `entities.ts` `supersedesChain`, shared with the runbook
// editions; what is a
// skill is this module's to say, and that is all this wrapper adds.
export function skillChain(entities: EntityState[], id: string): EntityState[]
{
    return supersedesChain(entities, id, isSkill);
}

// Which version this one is, counted from the root. Re-exported through this
// module so a reader of a skill page never has to know the walk is shared.
export function skillVersion(chain: EntityState[], id: string): number
{
    return chainVersion(chain, id);
}

// The skills a log still answers with: one per chain, the confirmed version
// that holds. A withdrawn skill has left, and a replacement nobody confirmed
// yet is not a skill anything reaches by name.
export function liveSkills(entities: EntityState[]): EntityState[]
{
    return entities.filter((entity) => isSkill(entity) && entity.status === "confirmed" && isCurrent(entity));
}

/* ── the placeholders a caller fills (§1.5) ────────────────────────── */

// A hole a caller fills before pasting: `{{tag}}` — a lower-case letter, then
// letters, digits, `-` and `_`. Recognised and reported, never substituted:
// substitution is only useful at the moment of execution, and nothing here
// executes anything.
const PLACEHOLDER = /\{\{([a-z][a-z0-9_-]*)\}\}/g;

// Anything that opens a `{{` and is not that: `{{ tag }}`, `{{Tag}}`, `{{}}`,
// or a brace that never closes. Returned as the text a refusal names, so a
// record can never promise a hole no caller can find.
const SUSPECT = /\{\{([^{}]*)(\}\})?/g;

export function placeholdersIn(lines: string[]): string[]
{
    const found: string[] = [];
    for (const line of lines)
    {
        for (const match of line.matchAll(PLACEHOLDER))
        {
            if (!found.includes(match[1]))
            {
                found.push(match[1]);
            }
        }
    }
    return found;
}

export function malformedPlaceholder(lines: string[]): string | undefined
{
    for (const line of lines)
    {
        for (const match of line.matchAll(SUSPECT))
        {
            if (match[2] === undefined || !/^[a-z][a-z0-9_-]*$/.test(match[1]))
            {
                return match[0];
            }
        }
    }
    return undefined;
}

/* ── one skill, read whole ─────────────────────────────────────────── */

// Everything a render says about one skill, derived in one place so the piped
// context, the terminal context, `skill list` and `skill show` cannot describe
// the same skill four ways.
export interface SkillReading
{
    skill: EntityState;
    name: string;
    purpose: string;
    // Whether the skill renders in every registered project rather than in one.
    workspace: boolean;
    // The workspace skill this project skill answers in place of, where there
    // is one. Disclosed wherever a skill renders: two records of one name, both
    // current, with no word about it is exactly the defect the disclosure
    // exists to prevent.
    shadows?: EntityState;
    // Set on a workspace skill a project skill of the same name answers for
    // here. It is listed and marked, and no name reaches it in this project.
    shadowed: boolean;
}

// The skills that answer in one project, with the shadowing resolved. The
// argument is the set a context render is built from — this project's own
// confirmed live records plus every other project's workspace-scoped ones — so
// a reading exists exactly where a row renders.
export function readSkills(rendered: EntityState[]): SkillReading[]
{
    const skills = orderEntities(liveSkills(rendered));
    const own = byName(skills.filter((item) => item.scope !== "workspace"));
    const shared = byName(skills.filter((item) => item.scope === "workspace"));
    return skills.map((skill): SkillReading => ({
        skill,
        name: skill.text,
        purpose: skill.why ?? "",
        workspace: skill.scope === "workspace",
        shadows: skill.scope === "workspace" ? undefined : shared.get(skill.text),
        shadowed: skill.scope === "workspace" && own.has(skill.text)
    }));
}

// First one wins, in the order the placement projection already puts them in:
// a second record of one name at one scope can only come from a raw
// `state add --label skill`, which this surface accepts rather than polices.
function byName(skills: EntityState[]): Map<string, EntityState>
{
    const found = new Map<string, EntityState>();
    for (const skill of skills)
    {
        if (!found.has(skill.text))
        {
            found.set(skill.text, skill);
        }
    }
    return found;
}

// The set a name actually reaches here: everything a project skill shadows has
// left it. A context that listed a skill no name reaches would be a row a
// reader cannot act on.
export function effectiveSkills(rendered: EntityState[]): SkillReading[]
{
    return readSkills(rendered).filter((reading) => !reading.shadowed);
}

// The one line both context renders print for a skill: the name a person
// types, what it is for, and the scope disclosure. Composed here so the piped
// page and the terminal page can never describe one skill two ways — the rule
// `runbookRow` states for the same reason.
//
// The command line and the recipe are deliberately absent. Context is a
// name-and-purpose index; the body is what `self skill show` is for.
export function skillRow(reading: SkillReading): string
{
    const purpose = reading.purpose === "" ? "no purpose recorded" : oneLine(reading.purpose);
    return `${oneLine(reading.name)}${scopeNote(reading)} — ${purpose}`;
}

function scopeNote(reading: SkillReading): string
{
    if (reading.shadows !== undefined)
    {
        return " (shadows a workspace skill)";
    }
    return reading.workspace ? " (workspace)" : "";
}
