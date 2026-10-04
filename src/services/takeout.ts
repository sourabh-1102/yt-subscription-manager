import { z } from 'zod';
import { channelIdFromUrl, isChannelId, isVideoId, videoIdFromUrl } from '@/lib/youtube-urls';

/**
 * Google Takeout parsers. Everything runs locally in the dashboard; files never leave the browser.
 *  - YouTube → history → watch-history.json (user must pick JSON format in Takeout)
 *  - YouTube → subscriptions → subscriptions.csv
 */

export interface TakeoutWatch {
  videoId: string;
  channelId: string;
  channelTitle: string;
  watchedAt: number;
}

const HistoryItem = z.object({
  header: z.string().optional(),
  titleUrl: z.string().optional(),
  time: z.string(),
  subtitles: z.array(z.object({ name: z.string().optional(), url: z.string().optional() })).optional(),
  details: z.array(z.object({ name: z.string().optional() })).optional(),
});

export function parseWatchHistory(data: unknown): { watches: TakeoutWatch[]; skipped: number } {
  if (!Array.isArray(data)) throw new Error('This does not look like watch-history.json (expected a JSON array).');
  const watches: TakeoutWatch[] = [];
  let skipped = 0;
  for (const raw of data) {
    const r = HistoryItem.safeParse(raw);
    if (!r.success) {
      skipped++;
      continue;
    }
    const item = r.data;
    // Ads watched are listed with details: [{ name: 'From Google Ads' }]
    const isAd = item.details?.some((d) => /google ads/i.test(d.name ?? ''));
    const videoId = item.titleUrl ? videoIdFromUrl(item.titleUrl) : undefined;
    const sub = item.subtitles?.[0];
    const channelId = channelIdFromUrl(sub?.url);
    const watchedAt = Date.parse(item.time);
    if (isAd || !videoId || !channelId || !Number.isFinite(watchedAt)) {
      skipped++;
      continue;
    }
    watches.push({ videoId, channelId, channelTitle: (sub?.name ?? '').slice(0, 200), watchedAt });
  }
  return { watches, skipped };
}

/** RFC-4180-ish CSV line splitter (handles quoted commas and doubled quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim()));
}

export interface TakeoutSubscription {
  channelId: string;
  title: string;
}

/** Columns: Channel Id, Channel Url, Channel Title (header names are localized — match by content). */
export function parseSubscriptionsCsv(text: string): TakeoutSubscription[] {
  const out: TakeoutSubscription[] = [];
  const seen = new Set<string>();
  for (const row of parseCsv(text.replace(/^﻿/, ''))) {
    const id = row[0]?.trim();
    if (!isChannelId(id) || seen.has(id)) continue; // also skips the header row
    seen.add(id);
    out.push({ channelId: id, title: (row[2] ?? '').trim().slice(0, 200) });
  }
  if (!out.length) throw new Error('No channels found. Expected Takeout subscriptions.csv (Channel Id, Channel Url, Channel Title).');
  return out;
}

export interface TakeoutWatchLater {
  videoId: string;
  addedAt?: number;
}

/**
 * Takeout → YouTube → playlists → "Watch later-videos.csv" (name is localized).
 * Handles both formats:
 *   new: "Video ID,Playlist Video Creation Timestamp" / "<id>,2024-01-05T12:00:00+00:00"
 *   old: playlist header block, blank line, then "Video Id,Time Added" / "<id>,2021-05-01 12:00:00 UTC"
 */
export function parseWatchLaterCsv(text: string): TakeoutWatchLater[] {
  const out: TakeoutWatchLater[] = [];
  const seen = new Set<string>();
  for (const row of parseCsv(text.replace(/^﻿/, ''))) {
    const id = row[0]?.trim();
    if (!isVideoId(id) || seen.has(id)) continue;
    seen.add(id);
    const rawTs = (row[1] ?? '').trim().replace(/ UTC$/, 'Z').replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, '$1T$2');
    const t = Date.parse(rawTs);
    out.push({ videoId: id, addedAt: Number.isFinite(t) ? t : undefined });
  }
  if (!out.length) throw new Error('No videos found. Choose “Watch later-videos.csv” from your Takeout “playlists” folder.');
  return out;
}
