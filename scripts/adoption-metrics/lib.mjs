// Pure helpers for the adoption-metrics snapshot, kept apart from snapshot.mjs
// (which runs on import) so they can be tested with node --test.

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

function fmt(value)
{
    return value === null || value === undefined ? '—' : String(value);
}

const VERDICT = 'reach: (reviewer fills: yes/mirror)';

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
    out.push(`    GSC impressions ${fmt(row.manual?.gscImpressions)} clicks ${fmt(row.manual?.gscClicks)} | sitemap last read ${fmt(row.sitemapLastRead)} | pageviews global ${fmt(row.reach?.global)} | referrals search ${fmt(row.referrals?.search)} llm ${fmt(row.referrals?.llm)}`);
    out.push('    followers — | tag feed: n/a | posting rights: n/a');
    out.push(`    ${VERDICT}`);
    return out;
}
