import { db } from '@/db/db';
import type { Channel } from '@/lib/types';
import { isChannelId } from '@/lib/youtube-urls';
import { getAuthState, setAuthState } from '@/lib/prefs';
import { API_DATA_TTL_MS, API_REFRESH_AFTER_MS } from '@/config/constants';
import { getChannels, listMySubscriptionsPage, pickThumb, type SubscriptionItem } from './youtube-api';
import { errMsg } from './auth';
import { autoCategorizeNew } from './categorize';

const MAX_PAGES = 400; // 20,000 subscriptions — far above YouTube's own limit

/** Map an API subscription item onto a channel row, preserving local-only fields. */
export function subscriptionToChannel(item: SubscriptionItem, existing: Channel | undefined, now: number): Channel {
  return {
    ...existing,
    id: item.snippet.resourceId.channelId,
    title: item.snippet.title,
    thumbnailUrl: pickThumb(item.snippet.thumbnails),
    subscribed: 1,
    subscriptionId: item.id,
    subscribedAt: item.snippet.publishedAt ? Date.parse(item.snippet.publishedAt) : existing?.subscribedAt,
    videoCount: item.contentDetails?.totalItemCount ?? existing?.videoCount,
    source: 'api',
    fetchedAt: now,
  };
}

let running = false;

/** Full subscription sync. ~1 quota unit per 50 subscriptions. */
export async function syncSubscriptions(): Promise<{ count: number }> {
  if (running) return { count: -1 };
  running = true;
  await setAuthState({ syncing: true, lastSyncError: undefined });
  try {
    const now = Date.now();
    const seen = new Set<string>();
    const added: string[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const page = await listMySubscriptionsPage(pageToken);
      const items = page.items.filter((i) => isChannelId(i.snippet.resourceId.channelId));
      const existing = await db.channels.bulkGet(items.map((i) => i.snippet.resourceId.channelId));
      await db.channels.bulkPut(items.map((item, idx) => subscriptionToChannel(item, existing[idx], now)));
      items.forEach((it, idx) => {
        if (!existing[idx] || existing[idx]!.subscribed === 0) added.push(it.snippet.resourceId.channelId);
      });
      items.forEach((i) => seen.add(i.snippet.resourceId.channelId));
      pageToken = page.nextPageToken;
    } while (pageToken && ++pages < MAX_PAGES);

    // Anything we thought was subscribed but YouTube no longer lists was unsubscribed elsewhere.
    await db.channels
      .where('subscribed')
      .equals(1)
      .filter((c) => !seen.has(c.id) && c.source !== 'demo')
      .modify({ subscribed: 0, subscriptionId: undefined });

    await setAuthState({ syncing: false, lastSyncAt: now });
    // New subscriptions get a category automatically (setting, on by default). Never fails the sync.
    await autoCategorizeNew(added).catch(() => undefined);
    return { count: seen.size };
  } catch (e) {
    await setAuthState({ syncing: false, lastSyncError: errMsg(e) });
    throw e;
  } finally {
    running = false;
  }
}

/**
 * Refresh API metadata for channels that the subscription sync does not cover
 * (unsubscribed channels, channels resolved from watch history). 1 unit per 50 channels.
 */
export async function refreshStaleChannelMetadata(): Promise<void> {
  const cutoff = Date.now() - API_REFRESH_AFTER_MS;
  const stale = await db.channels
    .filter((c) => c.subscribed === 0 && c.fetchedAt !== undefined && c.fetchedAt < cutoff)
    .limit(500)
    .toArray();
  for (let i = 0; i < stale.length; i += 50) {
    const chunk = stale.slice(i, i + 50);
    const items = await getChannels(chunk.map((c) => c.id));
    const now = Date.now();
    const byId = new Map(items.map((it) => [it.id, it]));
    await db.transaction('rw', db.channels, db.unsubscribed, async () => {
      for (const c of chunk) {
        const it = byId.get(c.id);
        if (it?.snippet) {
          const thumb = pickThumb(it.snippet.thumbnails);
          await db.channels.update(c.id, { title: it.snippet.title, thumbnailUrl: thumb, fetchedAt: now });
          await db.unsubscribed.where('channelId').equals(c.id).modify({ title: it.snippet.title, thumbnailUrl: thumb });
        } else {
          // Channel no longer exists — keep the id (user's own organization data), drop API metadata.
          await db.channels.update(c.id, { fetchedAt: now, thumbnailUrl: undefined });
        }
      }
    });
  }
}

/**
 * YouTube API Developer Policies III.E.4: API data older than 30 days must be refreshed or deleted.
 * Called daily after refresh attempts — whatever is still stale (e.g. user signed out) is stripped.
 */
export async function enforceApiDataTtl(): Promise<number> {
  const cutoff = Date.now() - API_DATA_TTL_MS;
  const stale = await db.channels.filter((c) => c.fetchedAt !== undefined && c.fetchedAt < cutoff).toArray();
  if (!stale.length) return 0;
  const ids = stale.map((c) => c.id);
  await db.transaction('rw', db.channels, db.unsubscribed, async () => {
    await db.channels.bulkUpdate(
      ids.map((id) => ({
        key: id,
        changes: { title: '', thumbnailUrl: undefined, videoCount: undefined, fetchedAt: undefined, subscriptionId: undefined },
      })),
    );
    await db.unsubscribed.where('channelId').anyOf(ids).modify({ title: '', thumbnailUrl: undefined });
  });
  return ids.length;
}

/** Sync if signed in and the last sync is older than `maxAgeMs`. */
export async function syncIfStale(maxAgeMs: number): Promise<void> {
  const auth = await getAuthState();
  if (!auth.signedIn || auth.syncing) return;
  if (auth.lastSyncAt && Date.now() - auth.lastSyncAt < maxAgeMs) return;
  await syncSubscriptions().catch(() => undefined);
}
