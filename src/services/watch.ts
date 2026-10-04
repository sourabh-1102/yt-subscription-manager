import { db } from '@/db/db';
import type { Channel, WatchEvent } from '@/lib/types';
import { getAuthState, getPrefs } from '@/lib/prefs';
import { getVideosChannel } from './youtube-api';
import { DAY_MS } from '@/config/constants';

export { watchEventId } from '@/lib/ids';
import { watchEventId } from '@/lib/ids';

const MAX_PENDING = 5000;

/** Normalise a display name for local matching. */
const norm = (s: string) => s.normalize('NFKC').trim().toLowerCase();

/**
 * Find the subscribed channel whose title exactly matches `name` — only if exactly one matches.
 * Zero-quota way to attribute a watch without calling videos.list.
 */
export async function matchSubscribedByName(name: string): Promise<Channel | undefined> {
  const n = norm(name);
  if (!n) return undefined;
  const matches = await db.channels
    .where('subscribed')
    .equals(1)
    .filter((c) => norm(c.title) === n)
    .limit(2)
    .toArray();
  return matches.length === 1 ? matches[0] : undefined;
}

/** Called for every watch observed by the content script (already validated). */
export async function recordObservedWatch(
  msg: { videoId: string; channelId?: string; channelName?: string },
  now = Date.now(),
): Promise<'recorded' | 'pending' | 'ignored'> {
  const prefs = await getPrefs();
  if (!prefs.trackingEnabled) return 'ignored';

  let channelId = msg.channelId;
  if (!channelId && msg.channelName) channelId = (await matchSubscribedByName(msg.channelName))?.id;

  if (!channelId) {
    if ((await db.pendingVideos.count()) < MAX_PENDING) {
      await db.pendingVideos.put({ videoId: msg.videoId, watchedAt: now });
    }
    void resolvePendingVideos().catch(() => undefined);
    return 'pending';
  }
  if (prefs.excludedChannelIds.includes(channelId)) return 'ignored';

  await putWatch({ videoId: msg.videoId, channelId, watchedAt: now, source: 'tracked' }, msg.channelName);
  return 'recorded';
}

async function putWatch(ev: Omit<WatchEvent, 'id'>, channelTitle?: string) {
  await db.transaction('rw', db.watchEvents, db.channels, async () => {
    const id = watchEventId(ev.videoId, ev.watchedAt);
    if (!(await db.watchEvents.get(id))) await db.watchEvents.put({ ...ev, id });
    if (!(await db.channels.get(ev.channelId))) {
      // A watched channel the user is not subscribed to — remembered for "watched but not subscribed".
      await db.channels.put({ id: ev.channelId, title: channelTitle ?? '', subscribed: 0, source: 'watch' });
    }
  });
}

/** Resolve pending videos → channel via videos.list (1 unit per 50 videos). Requires sign-in. */
export async function resolvePendingVideos(): Promise<number> {
  const auth = await getAuthState();
  if (!auth.signedIn) return 0;
  const prefs = await getPrefs();
  // Drop anything older than 30 days that never resolved.
  await db.pendingVideos.filter((p) => p.watchedAt < Date.now() - 30 * DAY_MS).delete();
  const pending = await db.pendingVideos.limit(500).toArray();
  let resolved = 0;
  for (let i = 0; i < pending.length; i += 50) {
    const chunk = pending.slice(i, i + 50);
    const items = await getVideosChannel(chunk.map((p) => p.videoId));
    const byVideo = new Map(items.map((v) => [v.id, v.snippet]));
    const now = Date.now();
    for (const p of chunk) {
      const sn = byVideo.get(p.videoId);
      if (sn && !prefs.excludedChannelIds.includes(sn.channelId)) {
        await putWatch({ videoId: p.videoId, channelId: sn.channelId, watchedAt: p.watchedAt, source: 'tracked' });
        // Title came from the API → mark it as API data so the 30-day TTL applies.
        const ch = await db.channels.get(sn.channelId);
        if (ch && ch.subscribed === 0 && !ch.title && sn.channelTitle) {
          await db.channels.update(sn.channelId, { title: sn.channelTitle, fetchedAt: now });
        }
        resolved++;
      }
      // Unknown/private/deleted videos are dropped too — nothing to attribute.
      await db.pendingVideos.delete(p.videoId);
    }
  }
  return resolved;
}

/** Apply the user's retention setting. */
export async function enforceWatchRetention(): Promise<void> {
  const { retentionDays } = await getPrefs();
  if (!retentionDays) return;
  const cutoff = Date.now() - retentionDays * DAY_MS;
  await db.watchEvents.where('watchedAt').below(cutoff).delete();
}

/** Exclude a channel: stop tracking and delete what was already recorded for it. */
export async function purgeChannelWatches(channelId: string): Promise<void> {
  await db.watchEvents.where('channelId').equals(channelId).delete();
}
