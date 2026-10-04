import type { BellIntent, Channel, ChannelFlags, Tag, WatchEvent } from '@/lib/types';
import { DAY_MS } from '@/config/constants';

/**
 * Pure, testable view-model logic. All analytics here are computed from the user's OWN
 * locally recorded watch data — never from YouTube API statistics (Developer Policies III.E.4.h).
 */

export interface WatchStats {
  count: number;
  first: number;
  last: number;
}

export interface ChannelRow {
  channel: Channel;
  tagIds: string[];
  favorite: boolean;
  reviewLater: boolean;
  note?: string;
  bellIntent?: BellIntent;
  bellDone: boolean;
  watch?: WatchStats;
}

export type Activity = 'active' | 'inactive' | 'never';

export function aggregateWatches(events: Iterable<Pick<WatchEvent, 'channelId' | 'watchedAt'>>): Map<string, WatchStats> {
  const m = new Map<string, WatchStats>();
  for (const e of events) {
    const s = m.get(e.channelId);
    if (!s) m.set(e.channelId, { count: 1, first: e.watchedAt, last: e.watchedAt });
    else {
      s.count++;
      if (e.watchedAt < s.first) s.first = e.watchedAt;
      if (e.watchedAt > s.last) s.last = e.watchedAt;
    }
  }
  return m;
}

export function buildRows(
  channels: Channel[],
  channelTags: { channelId: string; tagId: string }[],
  flags: ChannelFlags[],
  stats: Map<string, WatchStats>,
): ChannelRow[] {
  const tagsBy = new Map<string, string[]>();
  for (const ct of channelTags) {
    const arr = tagsBy.get(ct.channelId);
    if (arr) arr.push(ct.tagId);
    else tagsBy.set(ct.channelId, [ct.tagId]);
  }
  const flagsBy = new Map(flags.map((f) => [f.channelId, f]));
  return channels.map((channel) => {
    const f = flagsBy.get(channel.id);
    return {
      channel,
      tagIds: tagsBy.get(channel.id) ?? [],
      favorite: f?.favorite === 1,
      reviewLater: f?.reviewLater === 1,
      note: f?.note,
      bellIntent: f?.bellIntent,
      bellDone: f?.bellDone === 1,
      watch: stats.get(channel.id),
    };
  });
}

export function activityOf(row: ChannelRow, inactiveDays: number, now = Date.now()): Activity {
  if (!row.watch) return 'never';
  return now - row.watch.last <= inactiveDays * DAY_MS ? 'active' : 'inactive';
}

export type WatchFilter = 'all' | 'watched' | 'never' | 'inactive' | 'active';
export type SortKey = 'title' | 'lastWatched' | 'watchCount' | 'subscribedAt' | 'lastUpload';

export interface Filters {
  q: string;
  /** tag id, or special: '' = all, 'untagged' */
  tag: string;
  watch: WatchFilter;
  bell: 'any' | BellIntent | 'unset';
  favoritesOnly: boolean;
  reviewLaterOnly: boolean;
  sort: SortKey;
  dir: 'asc' | 'desc';
}

export const DEFAULT_FILTERS: Filters = {
  q: '',
  tag: '',
  watch: 'all',
  bell: 'any',
  favoritesOnly: false,
  reviewLaterOnly: false,
  sort: 'title',
  dir: 'asc',
};

export function applyFilters(
  rows: ChannelRow[],
  f: Filters,
  tags: Tag[],
  inactiveDays: number,
  now = Date.now(),
): ChannelRow[] {
  const q = f.q.trim().toLowerCase();
  const tagName = new Map(tags.map((t) => [t.id, t.name.toLowerCase()]));
  const out = rows.filter((r) => {
    if (f.favoritesOnly && !r.favorite) return false;
    if (f.reviewLaterOnly && !r.reviewLater) return false;
    if (f.tag === 'untagged' ? r.tagIds.length > 0 : f.tag && !r.tagIds.includes(f.tag)) return false;
    if (f.watch !== 'all') {
      const a = activityOf(r, inactiveDays, now);
      if (f.watch === 'watched' ? a === 'never' : a !== f.watch) return false;
    }
    if (f.bell !== 'any' && (f.bell === 'unset' ? !!r.bellIntent : r.bellIntent !== f.bell)) return false;
    if (q) {
      // Search matches channel name, category names, and the note.
      const hay = [r.channel.title, r.note ?? '', ...r.tagIds.map((t) => tagName.get(t) ?? '')].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  return sortRows(out, f.sort, f.dir);
}

export function sortRows(rows: ChannelRow[], key: SortKey, dir: 'asc' | 'desc'): ChannelRow[] {
  const sign = dir === 'asc' ? 1 : -1;
  const val = (r: ChannelRow): number | string => {
    switch (key) {
      case 'title':
        return r.channel.title.toLowerCase();
      case 'lastWatched':
        return r.watch?.last ?? 0;
      case 'watchCount':
        return r.watch?.count ?? 0;
      case 'subscribedAt':
        return r.channel.subscribedAt ?? 0;
      case 'lastUpload':
        return r.channel.lastUploadAt ?? 0;
    }
  };
  return [...rows].sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    if (va < vb) return -sign;
    if (va > vb) return sign;
    return a.channel.title.localeCompare(b.channel.title);
  });
}

// ---------- Cleanup ----------
export type CleanupRule =
  | 'never'
  | 'inactive30'
  | 'inactive90'
  | 'inactive180'
  | 'inactive365'
  | 'noUploads180'
  | 'noUploads365'
  | 'lowActivity'
  | 'uncategorized'
  | 'reviewLater';

export const CLEANUP_RULES: { id: CleanupRule; label: string; hint: string }[] = [
  { id: 'never', label: 'Never watched', hint: 'No recorded watch since tracking started' },
  { id: 'inactive30', label: 'Not watched in 30 days', hint: 'Watched before, nothing in the last 30 days' },
  { id: 'inactive90', label: 'Not watched in 90 days', hint: 'Watched before, nothing in the last 90 days' },
  { id: 'inactive180', label: 'Not watched in 6 months', hint: 'Watched before, nothing in the last 6 months' },
  { id: 'inactive365', label: 'Not watched in 1 year', hint: 'Watched before, nothing in the last year' },
  { id: 'noUploads180', label: 'No uploads in 6 months', hint: 'Channel has not published for 6 months' },
  { id: 'noUploads365', label: 'No uploads in 1 year', hint: 'Channel has not published for a year' },
  { id: 'lowActivity', label: 'Low activity', hint: '2 or fewer watches ever, none in 90 days' },
  { id: 'uncategorized', label: 'Uncategorized', hint: 'Not in any category yet' },
  { id: 'reviewLater', label: 'Review Later list', hint: 'Channels you parked for review' },
];

export function matchesRule(r: ChannelRow, rule: CleanupRule, now = Date.now()): boolean {
  const since = (d: number) => now - d * DAY_MS;
  const inactiveFor = (d: number) => !!r.watch && r.watch.last < since(d);
  switch (rule) {
    case 'never':
      return !r.watch;
    case 'inactive30':
      return inactiveFor(30);
    case 'inactive90':
      return inactiveFor(90);
    case 'inactive180':
      return inactiveFor(180);
    case 'inactive365':
      return inactiveFor(365);
    case 'noUploads180':
      return !!r.channel.lastUploadAt && r.channel.lastUploadAt < since(180);
    case 'noUploads365':
      return !!r.channel.lastUploadAt && r.channel.lastUploadAt < since(365);
    case 'lowActivity':
      return !!r.watch && r.watch.count <= 2 && r.watch.last < since(90);
    case 'uncategorized':
      return r.tagIds.length === 0;
    case 'reviewLater':
      return r.reviewLater;
  }
}

/** Human reason shown next to a cleanup candidate. */
export function cleanupReason(r: ChannelRow, now = Date.now()): string {
  const parts: string[] = [];
  if (!r.watch) parts.push('Never watched');
  else parts.push(`Last watched ${Math.floor((now - r.watch.last) / DAY_MS)} days ago`);
  if (r.channel.lastUploadAt) {
    const d = Math.floor((now - r.channel.lastUploadAt) / DAY_MS);
    if (d > 90) parts.push(`no uploads for ${d >= 365 ? `${Math.floor(d / 365)} yr` : `${Math.floor(d / 30)} mo`}`);
  }
  return parts.join(' · ');
}

// ---------- Analytics ----------
export const RANGES = [
  { id: 'today', label: 'Today', days: 1 },
  { id: 'week', label: '7 days', days: 7 },
  { id: 'month', label: '30 days', days: 30 },
  { id: 'quarter', label: '3 months', days: 90 },
  { id: 'year', label: '1 year', days: 365 },
  { id: 'all', label: 'All time', days: 0 },
] as const;
export type RangeId = (typeof RANGES)[number]['id'];

export function rangeStart(id: RangeId, now = Date.now()): number {
  const r = RANGES.find((x) => x.id === id)!;
  if (!r.days) return 0;
  if (id === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  return now - r.days * DAY_MS;
}

export function topChannels(events: WatchEvent[], from: number, limit = 10): { channelId: string; count: number }[] {
  const m = new Map<string, number>();
  for (const e of events) if (e.watchedAt >= from) m.set(e.channelId, (m.get(e.channelId) ?? 0) + 1);
  return [...m]
    .map(([channelId, count]) => ({ channelId, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/** Share of watches per category in range. A channel in two categories counts toward both. */
export function categoryDistribution(
  events: WatchEvent[],
  from: number,
  tagsByChannel: Map<string, string[]>,
): { tagId: string; count: number; share: number }[] {
  const m = new Map<string, number>();
  let total = 0;
  for (const e of events) {
    if (e.watchedAt < from) continue;
    const tags = tagsByChannel.get(e.channelId);
    const keys = tags?.length ? tags : ['untagged'];
    for (const k of keys) {
      m.set(k, (m.get(k) ?? 0) + 1);
      total++;
    }
  }
  return [...m]
    .map(([tagId, count]) => ({ tagId, count, share: total ? count / total : 0 }))
    .sort((a, b) => b.count - a.count);
}

/** Watches per week for the last `weeks` weeks (oldest first). */
export function weeklySeries(events: WatchEvent[], weeks = 12, now = Date.now()): number[] {
  const out = new Array<number>(weeks).fill(0);
  const start = now - weeks * 7 * DAY_MS;
  for (const e of events) {
    if (e.watchedAt < start || e.watchedAt > now) continue;
    const idx = Math.min(weeks - 1, Math.floor((e.watchedAt - start) / (7 * DAY_MS)));
    out[idx]!++;
  }
  return out;
}

/** Watches per month for one channel, last `months` months (oldest first). */
export function monthlySeries(events: WatchEvent[], months = 12, now = Date.now()): { label: string; count: number }[] {
  const d = new Date(now);
  const buckets: { key: string; label: string; count: number }[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    buckets.push({
      key: `${m.getFullYear()}-${m.getMonth()}`,
      label: m.toLocaleDateString(undefined, { month: 'short' }),
      count: 0,
    });
  }
  const idx = new Map(buckets.map((b, i) => [b.key, i]));
  for (const e of events) {
    const t = new Date(e.watchedAt);
    const i = idx.get(`${t.getFullYear()}-${t.getMonth()}`);
    if (i !== undefined) buckets[i]!.count++;
  }
  return buckets.map(({ label, count }) => ({ label, count }));
}
