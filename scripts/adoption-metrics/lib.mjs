// Helpers for the adoption-metrics snapshot, kept apart from snapshot.mjs
// (which runs on import) so they can be tested with node --test. Everything
// here decides from its arguments alone — the one file read, loadChannels,
// takes the directory to read from — so no test needs a network or a keychain.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// dev.to's public listing carries no view count, so a view count is only
// meaningful when the authenticated listing answered. Unauthenticated reads
// must say "unknown" (null), never 0 — a 0 here would read as "nobody came".
export function devtoCounters(article, authenticated)
{
    if (!article) return null;
    return {
        reactions: article.public_reactions_count ?? null,
        comments: article.comments_count ?? null,
        views: authenticated ? (article.page_views_count ?? null) : null,
    };
}

export function isDryRun(args)
{
    return args.includes('--dry') || args.includes('--dry-run');
}

// channels.json is the one registry of published pieces, and it sits beside
// the script rather than in the working directory — the daily job runs from
// wherever launchd puts it, so the caller passes the module's own directory
// and nothing here reads the process's current directory.
export function loadChannels(dir)
{
    const path = join(dir, 'channels.json');
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
}

export function pieceSlugs(config)
{
    return (config?.pieces ?? []).map((piece) => piece.slug);
}

// Search analytics lags about two days, so the window ends the day before
// yesterday and covers the seven days up to it. It travels with the row for
// the same reason npmWindow does: the row is stamped with the run date, and a
// reader who takes these numbers for that date's traffic reads them wrong.
export function searchWindow(nowMs)
{
    const day = (offset) => new Date(nowMs - offset * 86400000).toISOString().slice(0, 10);
    return { start: day(8), end: day(2) };
}

// The site path a piece is published at. channels.json carries only the slug,
// and the path is convention; this is the one place that convention is
// written down.
export function piecePagePath(slug)
{
    return `/updates/${slug}`;
}

// Search Console answers with the canonical URL, and the same piece can be
// canonical at more than one spelling — a trailing slash, a capitalised host,
// a www prefix on a domain property. Rows are matched on the path alone so
// those spellings land on the same piece instead of splitting it.
export function pageKeyPath(key)
{
    const raw = String(key ?? '').trim().toLowerCase();
    const path = raw.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/, '').replace(/[?#].*$/, '');
    return path.replace(/\/+$/, '') || '/';
}

function escapeRegex(text)
{
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The domain-total request, unchanged from before per-piece readings existed:
// no dimensions key, so the API answers with a single whole-property row. It
// is its own builder because "the domain totals do not move" is the promise
// every existing reader of snapshots.jsonl is owed, and a promise wants a
// place a test can hold it to.
export function domainAnalyticsBody(window)
{
    return { startDate: window.start, endDate: window.end };
}

// Both Search Console readings come from one call. Hand-entering the domain
// totals therefore skips the per-piece request too, the same way it already
// skips the sitemap read.
export function needsSearchConsole(manual)
{
    return manual.gscImpressions === null || manual.gscClicks === null;
}

// The per-piece request: the same window as the domain totals, plus the page
// dimension and a filter naming every piece. The expression is anchored at
// both ends so it reads the same whether the API matches it partially or
// whole. No pieces means no request — there is nothing to ask about.
export function searchAnalyticsBody(slugs, window)
{
    if (slugs.length === 0) return null;
    const alternatives = slugs.map((slug) => escapeRegex(slug)).join('|');
    return {
        startDate: window.start,
        endDate: window.end,
        dimensions: ['page'],
        rowLimit: 1000,
        dimensionFilterGroups: [{
            filters: [{
                dimension: 'page',
                operator: 'includingRegex',
                expression: `^.*${escapeRegex(piecePagePath(''))}(${alternatives})/?$`,
            }],
        }],
    };
}

// Reads the per-piece block out of the API's answer. Three outcomes, and the
// difference between them is the whole point: {} is "no piece was asked
// about", null is "asked and not answered", and a piece with 0 is a measured
// zero. A URL that belongs to no piece — the landing page, a docs page, which
// a domain property returns too — is dropped rather than added to anything.
export function pieceSearchResult(response, slugs)
{
    if (slugs.length === 0) return {};
    if (response === null || response === undefined) return null;
    const totals = new Map();
    for (const row of response.rows ?? [])
    {
        const path = pageKeyPath(row.keys?.[0]);
        const seen = totals.get(path) ?? { impressions: 0, clicks: 0 };
        totals.set(path, {
            impressions: seen.impressions + (row.impressions ?? 0),
            clicks: seen.clicks + (row.clicks ?? 0),
        });
    }
    return Object.fromEntries(slugs.map((slug) =>
        [slug, totals.get(pageKeyPath(piecePagePath(slug))) ?? { impressions: 0, clicks: 0 }]));
}

function fmt(value)
{
    return value === null || value === undefined ? '—' : String(value);
}

const VERDICT = 'reach: (reviewer fills: yes/mirror)';

// What a reviewer needs to state a piece's own search reading instead of
// quoting a domain-scope number at it. A row recorded before per-piece
// readings existed carries no block at all and prints nothing.
function pieceSearchVerdictLines(search)
{
    if (search === undefined) return [];
    if (search === null) return ['    per piece: unknown (Search Console did not answer)'];
    return Object.entries(search).map(([slug, piece]) =>
        `    per piece ${slug}: impressions ${fmt(piece?.impressions)} clicks ${fmt(piece?.clicks)}`);
}

// One block per channel with the inputs a reviewer needs to judge reach, and a
// line the reviewer fills in by hand: "yes" when the channel carries its own
// audience, "mirror" when it only echoes traffic that arrived elsewhere.
// Followers print when the channel can answer them, tag-feed entry is never
// retrievable so it reads "unknown", and posting rights are always manual.
export function reachVerdictLines(row)
{
    const out = ['reach verdict per channel'];
    const channels = row.channels ?? { devto: {}, reddit: {} };
    const followers = row.channels?.devtoFollowers;
    for (const [slug, c] of Object.entries(channels.devto ?? {}))
    {
        out.push(`  devto ${slug}`);
        out.push(`    followers ${fmt(followers)} | views ${fmt(c?.views)} reactions ${fmt(c?.reactions)} comments ${fmt(c?.comments)}`);
        out.push('    tag feed: unknown | posting rights: (manual)');
        out.push(`    ${VERDICT}`);
    }
    for (const [url, score] of Object.entries(channels.reddit ?? {}))
    {
        const id = url.split('/comments/')[1]?.split('/')[0] ?? url;
        out.push(`  reddit ${id}`);
        out.push(`    score ${fmt(score)} (browser-only: unauthenticated JSON is 403 from this network; read in Chrome at review) | followers —`);
        out.push('    tag feed: n/a | posting rights: (manual)');
        out.push(`    ${VERDICT}`);
    }
    out.push('  site/search');
    const covering = row.gscWindow ? `, ${row.gscWindow.start}..${row.gscWindow.end}` : '';
    out.push(`    GSC impressions ${fmt(row.manual?.gscImpressions)} clicks ${fmt(row.manual?.gscClicks)} (whole domain${covering}) | sitemap last read ${fmt(row.sitemapLastRead)} | pageviews global ${fmt(row.reach?.global)} | referrals search ${fmt(row.referrals?.search)} llm ${fmt(row.referrals?.llm)}`);
    out.push(...pieceSearchVerdictLines(row.channels?.search));
    out.push('    followers — | tag feed: n/a | posting rights: n/a');
    out.push(`    ${VERDICT}`);
    return out;
}
