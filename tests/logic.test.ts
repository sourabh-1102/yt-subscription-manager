import { describe, expect, it } from 'vitest';
import {
  activityOf,
  aggregateWatches,
  applyFilters,
  buildRows,
  categoryDistribution,
  DEFAULT_FILTERS,
  matchesRule,
  weeklySeries,
} from '@/features/logic';
import type { Channel, Tag, WatchEvent } from '@/lib/types';
import { DAY_MS } from '@/config/constants';

const NOW = Date.parse('2026-10-04T12:00:00Z');
const ch = (id: string, title: string, extra: Partial<Channel> = {}): Channel => ({
  id,
  title,
  subscribed: 1,
  source: 'api',
  ...extra,
});
const ev = (channelId: string, daysAgo: number, v = 'x'): WatchEvent => ({
  id: `${v}${daysAgo}`,
  videoId: `${v}`.padEnd(11, 'a'),
  channelId,
  watchedAt: NOW - daysAgo * DAY_MS,
  source: 'tracked',
});

const channels = [
  ch('A', 'Fireship', { lastUploadAt: NOW - 2 * DAY_MS }),
  ch('B', 'Physics Wallah', { lastUploadAt: NOW - 400 * DAY_MS }),
  ch('C', 'Some Channel'),
];
const tags: Tag[] = [
  { id: 't1', name: 'Tech', emoji: '💻', order: 1 },
  { id: 't2', name: 'Study', emoji: '📚', order: 2 },
];
const events = [ev('A', 1), ev('A', 3), ev('A', 10), ev('B', 200)];
const rows = buildRows(
  channels,
  [
    { channelId: 'A', tagId: 't1' },
    { channelId: 'B', tagId: 't2' },
    { channelId: 'B', tagId: 't1' },
  ],
  [{ channelId: 'C', favorite: 1, bellIntent: 'none' }],
  aggregateWatches(events),
);
const byId = (id: string) => rows.find((r) => r.channel.id === id)!;

describe('aggregation & activity', () => {
  it('aggregates watch stats', () => {
    expect(byId('A').watch).toEqual({ count: 3, first: NOW - 10 * DAY_MS, last: NOW - DAY_MS });
    expect(byId('C').watch).toBeUndefined();
  });
  it('classifies activity', () => {
    expect(activityOf(byId('A'), 90, NOW)).toBe('active');
    expect(activityOf(byId('B'), 90, NOW)).toBe('inactive');
    expect(activityOf(byId('C'), 90, NOW)).toBe('never');
  });
});

describe('filters', () => {
  const run = (f: Partial<typeof DEFAULT_FILTERS>) => applyFilters(rows, { ...DEFAULT_FILTERS, ...f }, tags, 90, NOW).map((r) => r.channel.id);
  it('searches by name and category name', () => {
    expect(run({ q: 'fire' })).toEqual(['A']);
    expect(run({ q: 'study' })).toEqual(['B']);
  });
  it('filters by tag, untagged, favorites', () => {
    expect(run({ tag: 't1' })).toEqual(['A', 'B']);
    expect(run({ tag: 'untagged' })).toEqual(['C']);
    expect(run({ favoritesOnly: true })).toEqual(['C']);
  });
  it('filters by watch status and combines filters', () => {
    expect(run({ watch: 'never' })).toEqual(['C']);
    expect(run({ watch: 'watched' })).toEqual(['A', 'B']);
    expect(run({ watch: 'inactive', tag: 't1' })).toEqual(['B']);
  });
  it('filters by bell plan without confusing "any" and "All"', () => {
    expect(run({ bell: 'any' })).toHaveLength(3);
    expect(run({ bell: 'none' })).toEqual(['C']);
    expect(run({ bell: 'all' })).toEqual([]);
    expect(run({ bell: 'unset' })).toEqual(['A', 'B']);
  });
  it('sorts by watch count', () => {
    expect(run({ sort: 'watchCount', dir: 'desc' })).toEqual(['A', 'B', 'C']);
  });
});

describe('cleanup rules', () => {
  it('flags the right channels', () => {
    expect(matchesRule(byId('C'), 'never', NOW)).toBe(true);
    expect(matchesRule(byId('B'), 'inactive180', NOW)).toBe(true);
    expect(matchesRule(byId('B'), 'inactive365', NOW)).toBe(false);
    expect(matchesRule(byId('B'), 'noUploads365', NOW)).toBe(true);
    expect(matchesRule(byId('A'), 'noUploads180', NOW)).toBe(false);
    expect(matchesRule(byId('B'), 'lowActivity', NOW)).toBe(true);
    expect(matchesRule(byId('C'), 'uncategorized', NOW)).toBe(true);
  });
});

describe('analytics', () => {
  it('splits watches across categories', () => {
    const tagsBy = new Map([
      ['A', ['t1']],
      ['B', ['t2', 't1']],
    ]);
    const d = categoryDistribution(events, 0, tagsBy);
    expect(d.find((x) => x.tagId === 't1')?.count).toBe(4);
    expect(d.find((x) => x.tagId === 't2')?.count).toBe(1);
    expect(d.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1);
  });
  it('builds a weekly series', () => {
    const s = weeklySeries(events, 12, NOW);
    expect(s).toHaveLength(12);
    expect(s.reduce((a, b) => a + b, 0)).toBe(3); // the 200-day-old watch is outside 12 weeks
    expect(s[11]).toBe(2);
  });
});
