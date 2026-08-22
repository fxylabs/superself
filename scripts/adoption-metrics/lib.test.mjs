import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devtoCounters, isDryRun, reachVerdictLines } from './lib.mjs';

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
