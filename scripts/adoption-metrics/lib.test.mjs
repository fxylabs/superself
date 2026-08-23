// Per-piece Search Console readings (#300) ship with a case table settled
// before the code, posted on the issue and repeated here, because the feature
// is a small state machine and every cell below is one test in this file.
//
// Variables:
//   P  pieces in channels.json      none | one | several (3, one with no rows)
//   G  Search Console answer        rows for all | rows for some | empty |
//                                   network failure | unauthenticated |
//                                   per-piece request alone fails
//   R  row shape                    domain columns unchanged (every cell) |
//                                   per-piece block present / null / {}
//
// {} is "no piece was asked about", null is "asked and not answered", and a
// piece reading 0 is a measured zero. Nothing turns a failure into a 0.
//
//   #   P         G                        expected
//   1   none      domain query ok          search {}, domain totals as today
//   2   none      network failure          search {}, domain totals null
//   3   none      unauthenticated          search {}, domain totals null
//   4   one       rows for all             that row's impressions and clicks
//   5   one       empty                    { impressions: 0, clicks: 0 }
//   6   one       network failure          search null
//   7   one       unauthenticated          search null
//   8   one       per-piece request 403    domain totals kept, search null
//   9   several   rows for all             each slug its own row, none borrowed
//   10  several   rows for some            the piece with no row reads 0/0
//   11  several   empty                    all three read 0/0
//   12  several   network failure          search null, every piece together
//   13  several   unauthenticated          search null
//   14  one       rows split by spelling   summed, not under-counted
//   15  one       rows for other URLs      dropped, never added to a piece
//   16  one       request shape            page dimension + piece filter, and
//                                          the domain body keeps no dimensions
//   17  one       both totals given by hand  no call at all: search null
//   18  one       a row from before this   no block: renders, prints nothing
//   19  one       verdict, readings present  one per-piece line per piece
//   20  one       verdict, readings null   "per piece: unknown"
//   21  regex slug  rows for all           escaped in the filter, still matches
//   22  one       run from another cwd     channels.json resolves module-relative
//   23  one       window                   seven days ending two days back
//   24  one       domain request alone fails  mirror of cell 8: the pieces keep
//                                          their readings, the domain reads —
//
// Cell 24 was not in the table posted on the issue. The self-adversarial pass
// found it: the table named the per-piece request failing on its own but not
// the domain request failing on its own, and the two requests fail
// independently.
//
// What snapshot.mjs resolves from outside its arguments, which is what cell 22
// pins: no environment variable at all; channels.json and snapshots.jsonl from
// the module's own directory, never the working directory; keychain item names
// only (gsc/service-account, posthog/personal-api-key, devto/api-key), whose
// values never reach stdout and whose absence degrades a field to null; the
// wall clock, for the window, which the row records as gscWindow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    devtoCounters, domainAnalyticsBody, isDryRun, loadChannels, needsSearchConsole,
    pageKeyPath, pieceSearchResult, pieceSlugs, reachVerdictLines,
    searchAnalyticsBody, searchWindow,
} from './lib.mjs';

const article = { public_reactions_count: 0, comments_count: 0, page_views_count: 0 };

test('authenticated dev.to listing: a measured 0 views stays 0', () =>
{
    assert.deepEqual(devtoCounters(article, true), { reactions: 0, comments: 0, views: 0 });
});

test('authenticated listing with the field missing: views unknown', () =>
{
    assert.equal(devtoCounters({ public_reactions_count: 1, comments_count: 2 }, true).views, null);
});

test('unauthenticated (public) listing: views are null, never 0, even if a count is present', () =>
{
    assert.deepEqual(devtoCounters(article, false), { reactions: 0, comments: 0, views: null });
});

test('no article: the whole counter is null', () =>
{
    assert.equal(devtoCounters(null, true), null);
});

test('--dry and --dry-run both mean no append', () =>
{
    assert.equal(isDryRun(['--dry']), true);
    assert.equal(isDryRun(['--dry-run']), true);
    assert.equal(isDryRun(['--view']), false);
});

test('reach verdict prints one block per channel plus site/search, each with the fill-in line', () =>
{
    const row = {
        manual: { gscImpressions: 25, gscClicks: 0 },
        sitemapLastRead: '2026-08-18',
        reach: { global: 11 },
        referrals: { search: 1, llm: 0 },
        channels: {
            devtoFollowers: 0,
            devto: { 'state-not-memory': { reactions: 0, comments: 0, views: null } },
            reddit: { 'https://www.reddit.com/r/ClaudeAI/comments/1vdggl8/x/': null },
        },
    };
    const lines = reachVerdictLines(row);
    assert.equal(lines.filter((l) => l.includes('reach: (reviewer fills: yes/mirror)')).length, 3);
    assert.ok(lines.some((l) => l === '  devto state-not-memory'));
    assert.ok(lines.some((l) => l.includes('followers 0') && l.includes('views —')));
    assert.ok(lines.some((l) => l.includes('tag feed: unknown')));
    assert.ok(lines.some((l) => l === '  reddit 1vdggl8'));
    assert.ok(lines.some((l) => l.includes('browser-only')));
    assert.ok(lines.some((l) => l === '  site/search'));
    assert.ok(lines.some((l) => l.includes('GSC impressions 25 clicks 0')));
});

test('reach verdict on an old row without channels still prints site/search', () =>
{
    const lines = reachVerdictLines({ manual: {}, referrals: null, reach: null });
    assert.equal(lines.filter((l) => l.includes('reviewer fills')).length, 1);
});

// ---------------------------------------------------------------------------
// Per-piece Search Console readings — one test per cell of the table above.
// No test issues a real request; every answer below is a literal fixture.

const HERE = dirname(fileURLToPath(import.meta.url));
const WINDOW = { start: '2026-08-15', end: '2026-08-21' };
const PIECE = 'state-not-memory';
const THREE = ['state-not-memory', 'second-piece', 'quiet-piece'];

const pageRow = (url, impressions, clicks) => ({ keys: [url], impressions, clicks });
const filterOf = (body) => body.dimensionFilterGroups[0].filters[0];

test('cell 1 — no pieces, domain query answers: no per-piece request is issued and the block is {}', () =>
{
    assert.equal(searchAnalyticsBody([], WINDOW), null);
    assert.deepEqual(pieceSearchResult({ rows: [pageRow('https://superselfs.com/', 22, 0)] }, []), {});
});

test('cell 2 — no pieces, network failure: the block is {}, because nothing was asked about', () =>
{
    assert.deepEqual(pieceSearchResult(null, []), {});
});

test('cell 3 — no pieces, unauthenticated: the block is {} rather than unknown', () =>
{
    assert.deepEqual(pieceSearchResult(undefined, pieceSlugs({ pieces: [] })), {});
});

test('cell 4 — one piece with rows: the piece carries its own row, not the domain aggregate', () =>
{
    const answer = { rows: [pageRow(`https://superselfs.com/updates/${PIECE}`, 7, 2)] };
    assert.deepEqual(pieceSearchResult(answer, [PIECE]), { [PIECE]: { impressions: 7, clicks: 2 } });
});

test('cell 5 — one piece, the call answers with no rows: a measured zero, never null', () =>
{
    assert.deepEqual(pieceSearchResult({ rows: [] }, [PIECE]), { [PIECE]: { impressions: 0, clicks: 0 } });
    assert.deepEqual(pieceSearchResult({}, [PIECE]), { [PIECE]: { impressions: 0, clicks: 0 } });
});

test('cell 6 — one piece, network failure: the block is null, never a zero reading', () =>
{
    assert.equal(pieceSearchResult(null, [PIECE]), null);
});

test('cell 7 — one piece, unauthenticated: the block is null', () =>
{
    assert.equal(pieceSearchResult(undefined, [PIECE]), null);
});

test('cell 8 — the per-piece request alone fails: the block is null and no domain row leaks into a piece', () =>
{
    assert.equal(pieceSearchResult(null, [PIECE]), null);
    // A whole-domain aggregate row carries no page key, and that number
    // standing in for a piece is exactly what this feature exists to stop.
    const aggregate = { rows: [{ impressions: 25, clicks: 1 }] };
    assert.deepEqual(pieceSearchResult(aggregate, [PIECE]), { [PIECE]: { impressions: 0, clicks: 0 } });
});

test('cell 9 — several pieces with rows: each slug reads its own row, none borrowed from another', () =>
{
    const answer = { rows: [
        pageRow('https://superselfs.com/updates/state-not-memory', 7, 2),
        pageRow('https://superselfs.com/updates/second-piece', 3, 0),
        pageRow('https://superselfs.com/updates/quiet-piece', 11, 4),
    ] };
    assert.deepEqual(pieceSearchResult(answer, THREE), {
        'state-not-memory': { impressions: 7, clicks: 2 },
        'second-piece': { impressions: 3, clicks: 0 },
        'quiet-piece': { impressions: 11, clicks: 4 },
    });
});

test('cell 10 — several pieces, rows for some: the piece with no row reads zero, the others keep theirs', () =>
{
    const answer = { rows: [
        pageRow('https://superselfs.com/updates/state-not-memory', 7, 2),
        pageRow('https://superselfs.com/updates/second-piece', 3, 0),
    ] };
    assert.deepEqual(pieceSearchResult(answer, THREE), {
        'state-not-memory': { impressions: 7, clicks: 2 },
        'second-piece': { impressions: 3, clicks: 0 },
        'quiet-piece': { impressions: 0, clicks: 0 },
    });
});

test('cell 11 — several pieces, empty answer: all three read zero', () =>
{
    const result = pieceSearchResult({ rows: [] }, THREE);
    assert.deepEqual(Object.values(result), [
        { impressions: 0, clicks: 0 }, { impressions: 0, clicks: 0 }, { impressions: 0, clicks: 0 },
    ]);
});

test('cell 12 — several pieces, network failure: every piece is unknown together', () =>
{
    assert.equal(pieceSearchResult(null, THREE), null);
});

test('cell 13 — several pieces, unauthenticated: every piece is unknown together', () =>
{
    assert.equal(pieceSearchResult(undefined, THREE), null);
});

test('cell 14 — one piece canonical at more than one spelling: the split rows are summed', () =>
{
    const answer = { rows: [
        pageRow(`https://superselfs.com/updates/${PIECE}`, 7, 2),
        pageRow(`https://superselfs.com/updates/${PIECE}/`, 3, 1),
        pageRow(`https://WWW.superselfs.com/updates/${PIECE}?utm=x`, 5, 0),
    ] };
    assert.deepEqual(pieceSearchResult(answer, [PIECE]), { [PIECE]: { impressions: 15, clicks: 3 } });
    assert.equal(pageKeyPath(`https://WWW.superselfs.com/updates/${PIECE}/`), `/updates/${PIECE}`);
});

test('cell 15 — rows for the landing page and the docs: dropped, never added to a piece', () =>
{
    const answer = { rows: [
        pageRow('https://superselfs.com/', 22, 0),
        pageRow('https://superselfs.com/docs/getting-started', 9, 1),
        pageRow(`https://superselfs.com/updates/${PIECE}`, 7, 2),
    ] };
    assert.deepEqual(pieceSearchResult(answer, [PIECE]), { [PIECE]: { impressions: 7, clicks: 2 } });
    const match = new RegExp(filterOf(searchAnalyticsBody([PIECE], WINDOW)).expression);
    assert.equal(match.test('https://superselfs.com/'), false);
    assert.equal(match.test('https://superselfs.com/docs/getting-started'), false);
    assert.equal(match.test(`https://superselfs.com/updates/${PIECE}`), true);
});

test('cell 16 — request shape: the per-piece body names the page dimension, the domain body still has none', () =>
{
    const body = searchAnalyticsBody([PIECE], WINDOW);
    assert.deepEqual(body.dimensions, ['page']);
    assert.equal(body.startDate, WINDOW.start);
    assert.equal(body.endDate, WINDOW.end);
    assert.ok(body.rowLimit >= 1);
    assert.equal(filterOf(body).dimension, 'page');
    assert.ok(filterOf(body).expression.includes(PIECE));
    // Byte for byte what the domain request has always sent, so every existing
    // reader of snapshots.jsonl keeps the same two numbers from the same query.
    assert.equal(JSON.stringify(domainAnalyticsBody(WINDOW)),
        '{"startDate":"2026-08-15","endDate":"2026-08-21"}');
});

test('cell 17 — both domain totals entered by hand: Search Console is not called, so the block stays unknown', () =>
{
    assert.equal(needsSearchConsole({ gscImpressions: 340, gscClicks: 9 }), false);
    assert.equal(needsSearchConsole({ gscImpressions: 340, gscClicks: null }), true);
    assert.equal(needsSearchConsole({ gscImpressions: null, gscClicks: null }), true);
});

test('cell 18 — a row recorded before this change: it renders, and prints no per-piece line', () =>
{
    const lines = reachVerdictLines({
        manual: { gscImpressions: 22, gscClicks: 0 },
        channels: { devto: {}, reddit: {} },
    });
    assert.ok(lines.some((l) => l === '  site/search'));
    assert.equal(lines.some((l) => l.includes('per piece')), false);
    assert.ok(lines.some((l) => l.includes('(whole domain)')));
});

test('cell 19 — reach verdict with readings: one per-piece line per piece under site/search', () =>
{
    const lines = reachVerdictLines({
        manual: { gscImpressions: 22, gscClicks: 0 },
        gscWindow: WINDOW,
        channels: { devto: {}, reddit: {}, search: {
            'state-not-memory': { impressions: 7, clicks: 2 },
            'second-piece': { impressions: 0, clicks: 0 },
        } },
    });
    assert.ok(lines.some((l) => l === '    per piece state-not-memory: impressions 7 clicks 2'));
    assert.ok(lines.some((l) => l === '    per piece second-piece: impressions 0 clicks 0'));
    assert.ok(lines.some((l) => l.includes('(whole domain, 2026-08-15..2026-08-21)')));
});

test('cell 20 — reach verdict with the readings unknown: it says unknown, it does not say zero', () =>
{
    const lines = reachVerdictLines({ manual: {}, channels: { devto: {}, reddit: {}, search: null } });
    assert.ok(lines.some((l) => l === '    per piece: unknown (Search Console did not answer)'));
    assert.equal(lines.some((l) => l.includes('impressions 0')), false);
});

test('cell 21 — a slug carrying a regex metacharacter is escaped in the filter and still matches', () =>
{
    const slug = 'a+b(c).d';
    const match = new RegExp(filterOf(searchAnalyticsBody([slug], WINDOW)).expression);
    assert.equal(match.test(`https://superselfs.com/updates/${slug}`), true);
    assert.equal(match.test('https://superselfs.com/updates/aXbc-d'), false);
});

test('cell 22 — run from another working directory: channels.json resolves from the module, not the cwd', () =>
{
    const decoy = mkdtempSync(join(tmpdir(), 'adoption-cwd-'));
    mkdirSync(join(decoy, 'nested'), { recursive: true });
    writeFileSync(join(decoy, 'channels.json'), JSON.stringify({ pieces: [{ slug: 'decoy' }] }));
    const before = process.cwd();
    try
    {
        process.chdir(decoy);
        assert.ok(pieceSlugs(loadChannels(HERE)).includes(PIECE));
        assert.deepEqual(pieceSlugs(loadChannels(decoy)), ['decoy']);
        assert.equal(loadChannels(join(decoy, 'nested')), null);
    }
    finally
    {
        process.chdir(before);
    }
});

test('cell 23 — the window is the seven days ending two days back, and the request asks for it', () =>
{
    const window = searchWindow(Date.parse('2026-08-23T14:00:00Z'));
    assert.deepEqual(window, { start: '2026-08-15', end: '2026-08-21' });
    const body = searchAnalyticsBody([PIECE], window);
    assert.equal(body.startDate, '2026-08-15');
    assert.equal(body.endDate, '2026-08-21');
});

test('cell 24 — the domain request alone fails: the pieces keep their readings, the domain reads unknown', () =>
{
    const lines = reachVerdictLines({
        manual: { gscImpressions: null, gscClicks: null },
        gscWindow: WINDOW,
        channels: { devto: {}, reddit: {}, search: { [PIECE]: { impressions: 7, clicks: 2 } } },
    });
    assert.ok(lines.some((l) => l.includes('GSC impressions — clicks — (whole domain')));
    assert.ok(lines.some((l) => l === `    per piece ${PIECE}: impressions 7 clicks 2`));
});
