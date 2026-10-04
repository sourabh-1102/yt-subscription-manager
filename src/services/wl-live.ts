import { browser } from 'wxt/browser';
import { db } from '@/db/db';
import type { WatchLaterItem } from '@/lib/types';
import { durationTextToIso, isWatchLaterUrl, type RemoveResult, type WlPageState, type WlRow } from '@/features/wl-dom';

/**
 * Live Watch Later (service-worker side). Talks to the content script in the user's own,
 * normally signed-in YouTube tab on https://www.youtube.com/playlist?list=WL.
 * No cookies, no tokens, no internal endpoints — the content script only uses the visible page.
 */
export const WL_URL = 'https://www.youtube.com/playlist?list=WL';
const LIVE_META_KEY = 'wlLive';

export interface WlLiveMeta {
  syncedAt: number;
  count: number;
}

export class WlLiveError extends Error {
  constructor(
    message: string,
    public code: WlPageState | 'no-tab' | 'no-response' | 'error',
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function findWlTab(): Promise<{ id: number; url: string } | undefined> {
  // Host permission for youtube.com lets us see these tabs' URLs (no "tabs" permission needed).
  const tabs = await browser.tabs.query({ url: 'https://www.youtube.com/playlist*' });
  const t = tabs.find((x) => x.id !== undefined && isWatchLaterUrl(x.url ?? ''));
  return t ? { id: t.id!, url: t.url! } : undefined;
}

export async function sendToTab<T>(tabId: number, msg: unknown, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      browser.tabs.sendMessage(tabId, msg) as Promise<T>,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new WlLiveError('The YouTube tab stopped responding.', 'no-response')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function ping(tabId: number): Promise<WlPageState | undefined> {
  try {
    const r = await sendToTab<{ ok: boolean; state: WlPageState }>(tabId, { type: 'wl/ping' }, 3000);
    return r?.state;
  } catch {
    return undefined; // content script not ready yet
  }
}

/** Current status without opening anything. */
export async function liveStatus(): Promise<{ tabOpen: boolean; state?: WlPageState; meta?: WlLiveMeta }> {
  const meta = (await browser.storage.local.get(LIVE_META_KEY))[LIVE_META_KEY] as WlLiveMeta | undefined;
  const tab = await findWlTab();
  return { tabOpen: !!tab, state: tab ? await ping(tab.id) : undefined, meta };
}

/**
 * Find (or open) the real Watch Later tab and wait until the page is ready.
 * `focus` brings it to the front — YouTube only lazy-loads long lists in a visible tab.
 */
export async function ensureWlTab(focus: boolean, waitMs = 45_000): Promise<number> {
  let tab = await findWlTab();
  if (!tab) {
    const created = await browser.tabs.create({ url: WL_URL, active: true });
    if (created.id === undefined) throw new WlLiveError('Could not open YouTube.', 'no-tab');
    tab = { id: created.id, url: WL_URL };
  } else if (focus) {
    await browser.tabs.update(tab.id, { active: true });
  }
  const end = Date.now() + waitMs;
  for (;;) {
    const state = await ping(tab.id);
    if (state === 'ok') return tab.id;
    if (state === 'signed-out') throw new WlLiveError('Please sign in to YouTube and try again.', 'signed-out');
    if (state === 'not-watch-later') throw new WlLiveError('The YouTube tab navigated away from Watch Later.', 'not-watch-later');
    if (Date.now() > end) throw new WlLiveError('YouTube Watch Later did not finish loading. Check the tab and try again.', 'no-response');
    await sleep(700);
  }
}

/** Read the real Watch Later list from the page and make it the local list (source: live). */
export async function refreshLiveWatchLater(): Promise<WlLiveMeta> {
  const tabId = await ensureWlTab(true);
  const r = await sendToTab<{ ok: boolean; rows?: WlRow[]; code?: string; error?: string }>(tabId, { type: 'wl/read' }, 4 * 60_000);
  if (!r?.ok || !r.rows) {
    if (r?.code === 'signed-out') throw new WlLiveError('Please sign in to YouTube and try again.', 'signed-out');
    throw new WlLiveError(r?.error ?? 'Could not read Watch Later from YouTube.', 'error');
  }
  const rows = r.rows;
  const now = Date.now();
  await db.transaction('rw', db.watchLater, async () => {
    const prev = new Map((await db.watchLater.toArray()).map((w) => [w.videoId, w]));
    await db.watchLater.clear(); // the live page is the source of truth
    await db.watchLater.bulkPut(
      rows.map((row): WatchLaterItem => {
        const p = prev.get(row.videoId);
        return {
          videoId: row.videoId,
          title: row.title || p?.title,
          channelTitle: row.channelTitle ?? p?.channelTitle,
          thumbnailUrl: row.thumbnailUrl ?? p?.thumbnailUrl,
          duration: durationTextToIso(row.durationText) ?? p?.duration,
          // "Date added" is not shown on the page; keep it from a Takeout import if we have it.
          addedAt: p?.addedAt,
          publishedAt: p?.publishedAt,
          hidden: p?.hidden,
          source: 'live',
          importedAt: now,
        };
      }),
    );
  });
  const meta: WlLiveMeta = { syncedAt: now, count: rows.length };
  await browser.storage.local.set({ [LIVE_META_KEY]: meta });
  return meta;
}

/** Remove one video from the REAL Watch Later via YouTube's own UI, verified. */
export async function removeOneLive(videoId: string): Promise<RemoveResult> {
  const tabId = await ensureWlTab(false);
  const r = await sendToTab<RemoveResult>(tabId, { type: 'wl/remove', videoId }, 60_000);
  return r ?? { ok: false, code: 'not-verified', error: 'No answer from the YouTube tab.' };
}
