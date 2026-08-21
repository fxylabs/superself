#!/usr/bin/env node
/**
 * The sales pages are raw HTML served verbatim, so every statutory value is
 * inlined five times over. This check is the single source that keeps them
 * honest: site/business-facts.json holds the values, and a page that prints a
 * different company name, registration number, address, phone, email or
 * effective date fails the build instead of shipping a wrong disclosure.
 *
 * It also holds the rest of the raw-HTML floor those pages have no framework
 * for: the shared shell stays byte-identical across them, every internal link
 * and same-page anchor resolves, and every tag closes.
 *
 * Run: pnpm check:business-facts
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const PAGES = join(SITE, "pages");

const facts = JSON.parse(readFileSync(join(SITE, "business-facts.json"), "utf8"));
const company = facts.company;

/* index.html is the landing, not a sales page: it carries the legal links but
   not the seller block, so the value checks below run on the five sales pages. */
const salesPages = Object.values(facts.routes).filter((file) => file !== "index.html");
const allPages = Object.values(facts.routes);

const source = new Map(allPages.map((file) => [file, readFileSync(join(PAGES, file), "utf8")]));

const problems = [];

function fail(page, message)
{
    problems.push(`${page}: ${message}`);
}

/* ---------- 1. every statutory value is present, verbatim ---------- */

const required = [
    ["legalName", company.legalName],
    ["representative", company.representative],
    ["businessRegistrationNumber", company.businessRegistrationNumber],
    ["mailOrderSalesNumber", company.mailOrderSalesNumber],
    ["address", company.address],
    ["email", company.email],
    ["phone", company.phone],
];

for (const page of salesPages)
{
    const html = source.get(page);

    for (const [key, value] of required)
    {
        if (!value)
        {
            fail("business-facts.json", `${key} is empty`);
        }
        else if (!html.includes(value))
        {
            fail(page, `missing ${key} — the page must print "${value}"`);
        }
    }
}

/* ---------- 2. no drifted variant of a value anywhere on a page ----------
   Presence alone would pass a page that also prints a stale number somewhere
   else, so each value-shaped match on the page must be the approved value. */

const shapes = [
    ["businessRegistrationNumber", /\d{3}-\d{2}-\d{5}/g, (m) => m],
    ["mailOrderSalesNumber", /\d{4}-[가-힣]+-\d{4}/g, (m) => m],
    ["phone", /0\d{1,2}-\d{3,4}-\d{4}/g, (m) => m],
    ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => m],
    ["legalName", /주식회사\s?[가-힣A-Za-z]+/g, (m) => m],
    ["representative", /대표(?:자|이사)?[:\s]+([가-힣]{2,4})/g, (m, groups) => groups[0]],
];

for (const page of salesPages)
{
    const html = source.get(page);

    for (const [key, pattern, pick] of shapes)
    {
        for (const match of html.matchAll(pattern))
        {
            const found = pick(match[0], match.slice(1));

            if (found !== company[key])
            {
                fail(page, `${key} drifted — found "${found}", business-facts.json says "${company[key]}"`);
            }
        }
    }

    /* The address runs to the end of its text node, so compare the prefix. */
    for (const match of html.matchAll(/서울특별시[^<]*/g))
    {
        if (!match[0].startsWith(company.address))
        {
            fail(page, `address drifted — found "${match[0].slice(0, 60)}…"`);
        }
    }
}

/* ---------- 3. the effective date is a placeholder or a real date ---------- */

const effective = facts.EFFECTIVE_DATE;

if (!/^DEPLOY_DATE_PLACEHOLDER$|^\d{4}-\d{2}-\d{2}$/.test(effective ?? ""))
{
    fail("business-facts.json", `EFFECTIVE_DATE must be DEPLOY_DATE_PLACEHOLDER or an ISO date, found "${effective ?? ""}"`);
}

for (const page of facts.effectiveDateRequiredOn)
{
    const html = source.get(page);

    if (!html)
    {
        fail(page, "listed in effectiveDateRequiredOn but not in routes");
        continue;
    }

    const shown = [...html.matchAll(/시행일:\s*([^<]*)/g)].map((match) => match[1].trim());

    if (shown.length === 0)
    {
        fail(page, "no 시행일 line — the page must show the effective date");
    }

    for (const value of shown)
    {
        if (value === "")
        {
            fail(page, "시행일 is empty");
        }
        else if (value !== effective)
        {
            fail(page, `시행일 drifted — shows "${value}", business-facts.json says "${effective}"`);
        }
    }
}

/* The terms carry the date a second time, in the addendum that enacts them. */
if (!source.get("terms.html").includes(`이 약관은 ${effective}부터 시행합니다.`))
{
    fail("terms.html", `the addendum must enact the terms on ${effective}`);
}

/* ---------- 4. the shared shell stays one shell ---------- */

function styleBlock(html)
{
    const start = html.indexOf("<style>");
    const end = html.indexOf("</style>");

    return start < 0 || end < 0 ? null : html.slice(start, end);
}

const reference = styleBlock(source.get(salesPages[0]));

for (const page of salesPages.slice(1))
{
    if (styleBlock(source.get(page)) !== reference)
    {
        fail(page, `its <style> block differs from ${salesPages[0]} — the sales pages share one shell`);
    }
}

/* ---------- 5. every internal link and same-page anchor resolves ---------- */

const publicFiles = new Set(readdirSync(join(SITE, "public")).map((name) => `/${name}`));
const siteConfig = readFileSync(join(ROOT, "spfn.site.yaml"), "utf8");
const mounted = new Set([...siteConfig.matchAll(/^\s*(?:route|path):\s*(\S+)/gm)].map((match) => match[1]));
const routes = new Set(Object.keys(facts.routes));

for (const page of allPages)
{
    const html = source.get(page);
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));

    for (const match of html.matchAll(/href="([^"]+)"/g))
    {
        const href = match[1];

        if (href.startsWith("#"))
        {
            if (!ids.has(href.slice(1)))
            {
                fail(page, `anchor ${href} has no matching id`);
            }
            continue;
        }

        if (!href.startsWith("/")) continue;

        const known = routes.has(href)
            || publicFiles.has(href)
            || mounted.has(href)
            || [...mounted].some((route) => route !== "/" && href.startsWith(`${route}/`));

        if (!known)
        {
            fail(page, `link ${href} resolves to no page, mount, or public file`);
        }
    }
}

/* ---------- 6. every tag closes ---------- */

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

function tagEnd(html, from)
{
    let quote = null;

    for (let i = from; i < html.length; i += 1)
    {
        const char = html[i];

        if (quote)
        {
            if (char === quote) quote = null;
        }
        else if (char === '"' || char === "'")
        {
            quote = char;
        }
        else if (char === ">")
        {
            return i;
        }
    }

    return -1;
}

for (const page of allPages)
{
    const html = source.get(page);
    const stack = [];
    let i = 0;

    while (i < html.length)
    {
        const lt = html.indexOf("<", i);

        if (lt < 0) break;

        if (html.startsWith("<!--", lt))
        {
            i = html.indexOf("-->", lt) + 3;
            continue;
        }

        if (html.startsWith("<!", lt))
        {
            i = tagEnd(html, lt) + 1;
            continue;
        }

        const gt = tagEnd(html, lt);

        if (gt < 0)
        {
            fail(page, `unterminated tag at offset ${lt}`);
            break;
        }

        const raw = html.slice(lt + 1, gt);
        const name = raw.replace(/^\//, "").split(/[\s/>]/)[0].toLowerCase();

        if (raw.startsWith("/"))
        {
            const open = stack.pop();

            if (open !== name)
            {
                fail(page, `</${name}> closes ${open ? `<${open}>` : "nothing"}`);
                break;
            }
        }
        else if (!VOID.has(name) && !raw.endsWith("/"))
        {
            /* Script and style bodies are not markup; skip to their close. */
            if (name === "script" || name === "style")
            {
                const close = html.indexOf(`</${name}>`, gt);

                if (close < 0)
                {
                    fail(page, `<${name}> is never closed`);
                    break;
                }

                i = close + name.length + 3;
                continue;
            }

            stack.push(name);
        }

        i = gt + 1;
    }

    if (stack.length > 0)
    {
        fail(page, `unclosed: ${stack.map((name) => `<${name}>`).join(", ")}`);
    }
}

/* ---------- report ---------- */

if (problems.length > 0)
{
    console.error("business-facts check failed:\n");
    for (const problem of problems) console.error(`  ${problem}`);
    console.error(`\n${problems.length} problem(s). Fix the page, or change site/business-facts.json and every page in one commit.`);
    process.exit(1);
}

console.log(`business-facts check passed — ${allPages.length} pages, ${required.length} statutory values, effective date "${effective}".`);
