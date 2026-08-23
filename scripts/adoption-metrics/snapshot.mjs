#!/usr/bin/env node
// Adoption-metrics snapshot: fetches every external adoption signal the project
// tracks and appends one dated row to snapshots.jsonl, then prints the latest
// rows side by side so a weekly review is one command.
//
//   node scripts/adoption-metrics/snapshot.mjs            fetch, append, show
//   node scripts/adoption-metrics/snapshot.mjs --dry-run  fetch and show, no append (--dry also works)
//   node scripts/adoption-metrics/snapshot.mjs --view     show the record only
//
// PostHog, Search Console and dev.to views need credentials from the macOS
// keychain; without an entry the field degrades to null. Any fetched field can
// be entered by hand:
//
//   --posthog <n>            LLM-referral pageviews, last 7 days
//   --gsc-impressions <n>    Search Console impressions, whole domain
//   --gsc-clicks <n>         Search Console clicks, whole domain
//
// Entering both by hand skips the Search Console call altogether, so the
// per-piece readings and the sitemap read are unknown (null) for that row.
//
// The record is append-only: a bad row is corrected by appending a new row.

import { readFileSync, appendFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createSign } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    devtoCounters, domainAnalyticsBody, isDryRun, loadChannels, needsSearchConsole,
    pieceSearchResult, pieceSlugs, reachVerdictLines, searchAnalyticsBody, searchWindow,
} from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORD = join(HERE, 'snapshots.jsonl');
const REPO = 'fxylabs/superself';
// Accounts that belong to the project. GitHub's author_association alone cannot
// tell them apart: the maintainer authors from a personal account whose
// association is only CONTRIBUTOR, so it must be named here explicitly.
const INTERNAL_USERS = new Set(['tonite31']);

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const argOf = (name) =>
{
    const i = args.indexOf(name);
    return i === -1 ? null : args[i + 1];
};

async function getJson(url)
{
    const res = await fetch(url, { headers: { 'User-Agent': 'superself-adoption-metrics' } });
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    return res.json();
}

function packageNames()
{
    const appsDir = join(HERE, '..', '..', 'apps');
    return readdirSync(appsDir)
        .map((d) => join(appsDir, d, 'package.json'))
        .filter((p) => existsSync(p))
        .map((p) => JSON.parse(readFileSync(p, 'utf8')))
        .filter((pkg) => !pkg.private)
        .map((pkg) => pkg.name);
}

// This repository is past one hundred issues and pull requests, so the listing
// pages until a page comes back short instead of trusting a single call.
async function allIssues()
{
    const issues = [];
    for (let page = 1; ; page += 1)
    {
        const batch = await getJson(`https://api.github.com/repos/${REPO}/issues?state=all&per_page=100&page=${page}`);
        issues.push(...batch);
        if (batch.length < 100) return issues;
    }
}

async function fetchGithub()
{
    const repo = await getJson(`https://api.github.com/repos/${REPO}`);
    const internalAssoc = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
    const external = (await allIssues())
        .filter((i) => !internalAssoc.has(i.author_association) && !INTERNAL_USERS.has(i.user.login));
    return {
        stars: repo.stargazers_count,
        forks: repo.forks_count,
        watchers: repo.subscribers_count,
        externalIssues: external.filter((i) => !i.pull_request).length,
        externalPRs: external.filter((i) => i.pull_request).length,
    };
}

// npm publishes a day's counts partway through the following day, so which
// seven-day window a run sees depends on when it runs. A run before the roll
// reads the same window yesterday's row read and every package repeats its
// previous number, which is indistinguishable from a day nobody downloaded
// anything. The window travels with the row so the two can be told apart.
async function fetchNpm(names)
{
    const downloads = {};
    let window = null;
    for (const name of names)
    {
        const encoded = name.replace('/', '%2F');
        const d = await getJson(`https://api.npmjs.org/downloads/point/last-week/${encoded}`)
            .catch(() => ({ downloads: null }));
        downloads[name] = d.downloads ?? 0;
        if (d.start && d.end) window = { start: d.start, end: d.end };
    }
    return { downloads, window };
}

// PostHog: one project (513406) receives events from several products, so the
// host filter is what scopes the count to the superselfs.com site — the app
// host (app.superselfs.com) is deliberately excluded, this measures the site.
// The personal API key (query:read only) lives in the macOS keychain; its value
// never reaches stdout. Missing key or a failed query degrades to null, and the
// --posthog flag still overrides.
const POSTHOG_PROJECT = 513406;
const LLM_DOMAINS = "'chatgpt.com','chat.openai.com','perplexity.ai','www.perplexity.ai','claude.ai','gemini.google.com','copilot.microsoft.com'";
// The two social channels the site actually receives traffic from. They read as
// one 'other' bucket without their own classes, which hides the only channel
// still delivering anyone in a week where the rest are at zero.
const X_DOMAINS = "'t.co','twitter.com','www.twitter.com','x.com','www.x.com'";
const THREADS_DOMAINS = "'l.threads.com','www.threads.com','threads.com','www.threads.net','threads.net'";
// The audience the global adoption objective is measured against is everyone
// outside the home market; KR traffic arrives through a Korean-language funnel
// and would otherwise read as progress on a goal it does not serve.
const HOME_COUNTRY = 'KR';

async function posthogQuery(query)
{
    let key;
    try
    {
        key = execFileSync('security', ['find-generic-password', '-s', 'posthog', '-a', 'personal-api-key', '-w'],
            { encoding: 'utf8' }).trim();
    }
    catch
    {
        return null;
    }
    const res = await fetch(`https://us.posthog.com/api/projects/${POSTHOG_PROJECT}/query/`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
    }).catch(() => null);
    if (!res || !res.ok) return null;
    return (await res.json()).results ?? null;
}

async function fetchPosthogLlmReferrals()
{
    const results = await posthogQuery(`select count() from events where event='$pageview' and properties.$host='superselfs.com' and properties.$referring_domain in (${LLM_DOMAINS}) and timestamp > now() - interval 7 day`);
    return results?.[0]?.[0] ?? null;
}

// Where the last seven days of site pageviews came from, classified by
// referring domain. '$direct' is PostHog's own marker for no referrer.
async function fetchReferralClasses()
{
    const results = await posthogQuery(`select multiIf(
        properties.$referring_domain in (${LLM_DOMAINS}), 'llm',
        properties.$referring_domain in ('www.google.com','google.com','www.bing.com','bing.com','duckduckgo.com','search.brave.com'), 'search',
        properties.$referring_domain = 'dev.to', 'devto',
        properties.$referring_domain in ('www.reddit.com','reddit.com','old.reddit.com','out.reddit.com'), 'reddit',
        properties.$referring_domain in ('github.com','www.github.com'), 'github',
        properties.$referring_domain in (${X_DOMAINS}), 'x',
        properties.$referring_domain in (${THREADS_DOMAINS}), 'threads',
        properties.$referring_domain = '$direct', 'direct',
        'other') as cls, count()
        from events where event='$pageview' and properties.$host='superselfs.com' and timestamp > now() - interval 7 day group by cls`);
    if (results === null) return null;
    const referrals = { llm: 0, search: 0, devto: 0, reddit: 0, github: 0, x: 0, threads: 0, direct: 0, other: 0 };
    for (const [cls, n] of results) referrals[cls] = n;
    return referrals;
}

// Where the last seven days of site pageviews came from geographically, as the
// two counts the adoption objective is read against: everyone outside the home
// market, and the home market itself.
async function fetchReach()
{
    const results = await posthogQuery(`select multiIf(
        properties.$geoip_country_code = '${HOME_COUNTRY}', 'home',
        properties.$geoip_country_code = '', 'unknown',
        isNull(properties.$geoip_country_code), 'unknown',
        'global') as region, count()
        from events where event='$pageview' and properties.$host='superselfs.com' and timestamp > now() - interval 7 day group by region`);
    if (results === null) return null;
    const reach = { global: 0, home: 0, unknown: 0 };
    for (const [region, n] of results) reach[region] = n;
    return reach;
}

// Channel counters for published pieces, listed in channels.json. dev.to
// articles map back to pieces through their canonical URL; a reddit thread is
// read unauthenticated and the counted comment is the first one linking our
// domain, so no per-comment permalink bookkeeping. Failures degrade to null.
const SITE_DOMAIN = 'superselfs.com';

// dev.to's public listing carries reactions and comments but no view count, so
// views need the author's own key from the macOS keychain. Without it the
// public listing still answers for reactions and comments and views alone
// degrades to null.
function devtoKey()
{
    try
    {
        return execFileSync('security', ['find-generic-password', '-s', 'devto', '-a', 'api-key', '-w'],
            { encoding: 'utf8' }).trim();
    }
    catch
    {
        return null;
    }
}

// Answers { articles, authenticated }. The flag is what makes the fallback
// explicit: when the key is absent or the authenticated call fails, the public
// listing still answers for reactions and comments, and views read null —
// never 0, which would look like a measured "nobody came".
async function devtoArticles(username)
{
    const key = devtoKey();
    if (key)
    {
        const res = await fetch('https://dev.to/api/articles/me/published', {
            headers: { 'api-key': key, 'User-Agent': 'superself-adoption-metrics' },
        }).catch(() => null);
        if (res?.ok) return { articles: await res.json(), authenticated: true };
        console.error('devto: authenticated listing failed, falling back to the public listing (views read null)');
    }
    const articles = await getJson(`https://dev.to/api/articles?username=${username}`).catch(() => null);
    return { articles, authenticated: false };
}

// Follower count for the reach verdict; needs the author key, null without it.
async function devtoFollowers()
{
    const key = devtoKey();
    if (!key) return null;
    const res = await fetch('https://dev.to/api/followers/users?per_page=1000', {
        headers: { 'api-key': key, 'User-Agent': 'superself-adoption-metrics' },
    }).catch(() => null);
    if (!res?.ok) return null;
    return (await res.json()).length;
}

function commentTexts(node, out)
{
    for (const child of node?.data?.children ?? [])
    {
        if (child.kind === 't1')
        {
            out.push({ body: child.data.body ?? '', score: child.data.score ?? null });
            commentTexts(child.data.replies, out);
        }
    }
    return out;
}

async function fetchChannels(config, searchByPiece)
{
    if (!config) return null;

    const devto = {};
    const { articles, authenticated } = await devtoArticles(config.devtoUsername);
    for (const piece of config.pieces)
    {
        const article = articles?.find((a) => a.canonical_url?.endsWith(`/${piece.slug}`));
        devto[piece.slug] = devtoCounters(article, authenticated);
    }

    const reddit = {};
    for (const piece of config.pieces)
    {
        for (const url of piece.reddit ?? [])
        {
            const thread = await getJson(`${url.replace(/\/$/, '')}.json`).catch(() => null);
            const ours = thread ? commentTexts(thread[1], []).find((c) => c.body.includes(SITE_DOMAIN)) : null;
            reddit[url] = ours?.score ?? null;
        }
    }
    return { devto, devtoFollowers: await devtoFollowers(), reddit, search: searchByPiece };
}

// Search Console: the shared service account authenticates via a self-signed
// JWT; the key JSON sits base64-encoded in the keychain and, like PostHog, a
// missing entry degrades to null and the value never reaches stdout. The
// property is a domain property, so the site identifier is the sc-domain form
// rather than a URL prefix, while the sitemap keeps its full URL.
const GSC_SITE = 'sc-domain:superselfs.com';
const SITEMAP_URL = 'https://superselfs.com/sitemap.xml';

function gscKeychainJson()
{
    try
    {
        const b64 = execFileSync('security', ['find-generic-password', '-s', 'gsc', '-a', 'service-account', '-w'],
            { encoding: 'utf8' }).trim();
        return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    }
    catch
    {
        return null;
    }
}

async function gscAccessToken(sa)
{
    const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/webmasters.readonly',
        aud: sa.token_uri,
        iat: now,
        exp: now + 600,
    })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
    // A network failure here (2026-08-19: DNS could not resolve the token host)
    // must degrade this field to null, not kill the run and lose the day's row.
    const res = await fetch(sa.token_uri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${unsigned}.${signature}`,
    }).catch(() => null);
    if (!res || !res.ok) return null;
    return (await res.json()).access_token ?? null;
}

function searchAnalyticsUrl(site)
{
    return `https://www.googleapis.com/webmasters/v3/sites/${site}/searchAnalytics/query`;
}

// The second request against the same property, same credentials and same
// window as the domain totals: the page dimension plus a filter naming every
// piece, so each piece reads its own impressions and clicks instead of having
// a whole-domain number stand in for it. A failure here is null (unknown) for
// every piece and leaves the domain totals beside it untouched.
async function fetchPieceSearch(site, auth, window, slugs)
{
    const body = searchAnalyticsBody(slugs, window);
    if (body === null) return pieceSearchResult(null, slugs);
    const answer = await fetch(searchAnalyticsUrl(site), {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    return pieceSearchResult(answer, slugs);
}

async function fetchGsc(config)
{
    const slugs = pieceSlugs(config);
    const window = searchWindow(Date.now());
    const unknown = {
        impressions: null, clicks: null, sitemapLastRead: null,
        window, searchByPiece: pieceSearchResult(null, slugs),
    };
    const sa = gscKeychainJson();
    if (!sa) return unknown;
    const token = await gscAccessToken(sa);
    if (!token) return unknown;
    const site = encodeURIComponent(GSC_SITE);
    const auth = { Authorization: `Bearer ${token}` };

    const query = await fetch(searchAnalyticsUrl(site), {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(domainAnalyticsBody(window)),
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

    const sitemap = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${site}/sitemaps/${encodeURIComponent(SITEMAP_URL)}`, { headers: auth })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null);

    // A failed call (no permission yet, network) is null; a successful call
    // with no rows is a real measured zero.
    return {
        impressions: query === null ? null : (query.rows?.[0]?.impressions ?? 0),
        clicks: query === null ? null : (query.rows?.[0]?.clicks ?? 0),
        sitemapLastRead: sitemap?.lastDownloaded?.slice(0, 10) ?? null,
        window,
        searchByPiece: await fetchPieceSearch(site, auth, window, slugs),
    };
}

function manualFields()
{
    const num = (name) => (argOf(name) === null ? null : Number(argOf(name)));
    return {
        posthogLlmReferrals: num('--posthog'),
        gscImpressions: num('--gsc-impressions'),
        gscClicks: num('--gsc-clicks'),
    };
}

function readRecord()
{
    if (!existsSync(RECORD)) return [];
    return readFileSync(RECORD, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function fmt(value)
{
    return value === null || value === undefined ? '—' : String(value);
}

function delta(curr, prev)
{
    if (typeof curr !== 'number' || typeof prev !== 'number') return '';
    const d = curr - prev;
    return d === 0 ? '' : d > 0 ? ` (+${d})` : ` (${d})`;
}

function printView(rows)
{
    if (rows.length === 0)
    {
        console.log('no snapshots recorded yet');
        return;
    }
    const curr = rows[rows.length - 1];
    const prev = rows.length > 1 ? rows[rows.length - 2] : null;
    console.log(`\nsnapshot ${curr.date}${prev ? ` (vs ${prev.date})` : ' (baseline)'}\n`);

    const line = (label, c, p) => console.log(`  ${label.padEnd(28)} ${fmt(c)}${p === undefined ? '' : delta(c, p)}`);
    line('GitHub stars', curr.github.stars, prev?.github.stars);
    line('GitHub forks', curr.github.forks, prev?.github.forks);
    line('GitHub watchers', curr.github.watchers, prev?.github.watchers);
    line('external issues (all time)', curr.github.externalIssues, prev?.github.externalIssues);
    line('external PRs (all time)', curr.github.externalPRs, prev?.github.externalPRs);
    console.log('');
    const window = curr.npmWindow;
    line('npm window', window ? `${window.start}..${window.end}` : '—');
    for (const [name, n] of Object.entries(curr.npm))
    {
        line(`npm ${name} /wk`, n, prev?.npm[name]);
    }
    if (window && prev?.npmWindow && prev.npmWindow.end === window.end)
    {
        console.log('  ^ same window as the previous row: these counts repeat, they did not stand still');
    }
    console.log('');
    line('PostHog LLM referrals', curr.manual.posthogLlmReferrals, prev?.manual.posthogLlmReferrals);
    const gscWindow = curr.gscWindow;
    line('GSC window', gscWindow ? `${gscWindow.start}..${gscWindow.end}` : '—');
    line('GSC impressions (domain)', curr.manual.gscImpressions, prev?.manual.gscImpressions);
    line('GSC clicks (domain)', curr.manual.gscClicks, prev?.manual.gscClicks);
    line('sitemap last read', curr.sitemapLastRead ?? '—');
    if (curr.reach)
    {
        console.log('');
        line('pageviews global (7d)', curr.reach.global, prev?.reach?.global);
        line(`pageviews ${HOME_COUNTRY.toLowerCase()} (7d)`, curr.reach.home, prev?.reach?.home);
        line('pageviews unknown (7d)', curr.reach.unknown, prev?.reach?.unknown);
    }
    if (curr.referrals)
    {
        console.log('');
        for (const [cls, n] of Object.entries(curr.referrals))
        {
            line(`referrals ${cls} (7d)`, n, prev?.referrals?.[cls]);
        }
    }
    if (curr.channels)
    {
        console.log('');
        for (const [slug, c] of Object.entries(curr.channels.devto))
        {
            line(`devto ${slug} views`, c?.views ?? null, prev?.channels?.devto?.[slug]?.views);
            line(`devto ${slug} reactions`, c?.reactions ?? null, prev?.channels?.devto?.[slug]?.reactions);
            line(`devto ${slug} comments`, c?.comments ?? null, prev?.channels?.devto?.[slug]?.comments);
        }
        for (const [url, score] of Object.entries(curr.channels.reddit))
        {
            line(`reddit ${url.split('/comments/')[1]?.split('/')[0] ?? url} score`, score, prev?.channels?.reddit?.[url]);
        }
        // Per piece, never a total: a domain property answers for the landing
        // page and the docs too, so a sum of these is not site traffic.
        if (curr.channels.search === null) line('search per piece', '— (Search Console did not answer)');
        for (const [slug, s] of Object.entries(curr.channels.search ?? {}))
        {
            line(`search ${slug} impressions`, s?.impressions ?? null, prev?.channels?.search?.[slug]?.impressions);
            line(`search ${slug} clicks`, s?.clicks ?? null, prev?.channels?.search?.[slug]?.clicks);
        }
    }
    console.log('');
    for (const l of reachVerdictLines(curr)) console.log(`  ${l}`);
    console.log('');
}

if (has('--view'))
{
    printView(readRecord());
    process.exit(0);
}

// One row per date: a rerun on a day that already has its row (manual run after
// the scheduled one, or vice versa) must not duplicate it.
const today = new Date().toISOString().slice(0, 10);
const dry = isDryRun(args);
if (!dry && readRecord().some((r) => r.date === today))
{
    console.log(`snapshot for ${today} already recorded; skipping`);
    process.exit(0);
}

const manual = manualFields();
if (manual.posthogLlmReferrals === null)
{
    manual.posthogLlmReferrals = await fetchPosthogLlmReferrals();
}
// Both Search Console readings come from one call, so hand-entering the domain
// totals skips the per-piece request too and leaves it unknown — the same way
// it already leaves the sitemap read unknown.
const channelsConfig = loadChannels(HERE);
let sitemapLastRead = null;
let gscWindow = null;
let searchByPiece = null;
if (needsSearchConsole(manual))
{
    const gsc = await fetchGsc(channelsConfig);
    manual.gscImpressions = manual.gscImpressions ?? gsc.impressions;
    manual.gscClicks = manual.gscClicks ?? gsc.clicks;
    sitemapLastRead = gsc.sitemapLastRead;
    gscWindow = gsc.window;
    searchByPiece = gsc.searchByPiece;
}

const npm = await fetchNpm(packageNames());
const row = {
    date: new Date().toISOString().slice(0, 10),
    github: await fetchGithub(),
    npm: npm.downloads,
    npmWindow: npm.window,
    manual,
    sitemapLastRead,
    gscWindow,
    referrals: await fetchReferralClasses(),
    reach: await fetchReach(),
    channels: await fetchChannels(channelsConfig, searchByPiece),
};

if (dry)
{
    printView([...readRecord(), row]);
    process.exit(0);
}

appendFileSync(RECORD, JSON.stringify(row) + '\n');
printView(readRecord());
