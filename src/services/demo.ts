import { db, newId } from '@/db/db';
import type { Channel, Tag, WatchEvent } from '@/lib/types';
import { DAY_MS } from '@/config/constants';
import { watchEventId } from '@/lib/ids';

/**
 * Demo data so the dashboard can be explored (and reviewed) without signing in.
 * Everything is tagged `source: 'demo'` and can be removed in one click.
 */
const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

const WORDS_A = ['Code', 'Quantum', 'Daily', 'Pixel', 'Retro', 'Deep', 'Tiny', 'Urban', 'Cosmic', 'Honest', 'Lazy', 'Mighty', 'Simple', 'Wild', 'Curious', 'Linear', 'Neon', 'Silent', 'Atomic', 'Open'];
const WORDS_B = ['Academy', 'Labs', 'Kitchen', 'Garage', 'Studio', 'Talks', 'Science', 'Gaming', 'Music', 'News', 'Physics', 'Builds', 'Explained', 'Theory', 'Travels', 'Maths', 'Dev', 'Chess', 'History', 'Design'];

export async function loadDemoData(count = 1000): Promise<void> {
  const r = rng(42 + count);
  const now = Date.now();
  const rid = (len: number) => Array.from({ length: len }, () => ID_CHARS[Math.floor(r() * 64)]).join('');

  const tagDefs: [string, string][] = [
    ['Study', '📚'], ['Programming', '💻'], ['AI', '🤖'], ['Gaming', '🎮'], ['Music', '🎵'], ['News', '📰'],
  ];
  const existingTags = await db.tags.toArray();
  const tags: Tag[] = tagDefs.map(([name, emoji], i) =>
    existingTags.find((t) => t.name === name) ?? { id: newId(), name, emoji, order: 100 + i },
  );

  const channels: Channel[] = [];
  const events: WatchEvent[] = [];
  const channelTags: { channelId: string; tagId: string }[] = [];
  for (let i = 0; i < count; i++) {
    const id = `UC${rid(22)}`;
    const title = `${WORDS_A[Math.floor(r() * WORDS_A.length)]} ${WORDS_B[Math.floor(r() * WORDS_B.length)]}${r() < 0.4 ? ` ${i}` : ''}`;
    channels.push({
      id,
      title,
      subscribed: 1,
      subscribedAt: now - Math.floor(r() * 3000) * DAY_MS,
      videoCount: Math.floor(r() * 2000),
      source: 'demo',
      lastUploadAt: r() < 0.9 ? now - Math.floor(r() ** 3 * 900) * DAY_MS : undefined,
      lastUploadCheckedAt: now,
    });
    if (r() < 0.6) channelTags.push({ channelId: id, tagId: tags[Math.floor(r() * tags.length)]!.id });
    // ~45% never watched; the rest follow a long-tail distribution.
    if (r() < 0.55) {
      const n = Math.floor(r() ** 4 * 120) + 1;
      const recency = r() ** 2 * 400;
      for (let k = 0; k < n; k++) {
        const ts = now - Math.floor((recency + r() * 200) * DAY_MS);
        const videoId = rid(11);
        events.push({ id: watchEventId(videoId, ts), videoId, channelId: id, watchedAt: ts, source: 'demo' });
      }
    }
  }
  await db.transaction('rw', [db.tags, db.channels, db.channelTags, db.watchEvents, db.flags], async () => {
    await db.tags.bulkPut(tags);
    await db.channels.bulkPut(channels);
    await db.channelTags.bulkPut(channelTags);
    await db.watchEvents.bulkPut(events);
    await db.flags.bulkPut(
      channels.filter(() => r() < 0.04).map((c) => ({ channelId: c.id, favorite: 1 as const })),
    );
  });
}

export async function removeDemoData(): Promise<void> {
  await db.transaction('rw', [db.channels, db.channelTags, db.watchEvents, db.flags], async () => {
    const ids = await db.channels.where('source').equals('demo').primaryKeys();
    await db.channelTags.where('channelId').anyOf(ids).delete();
    await db.flags.bulkDelete(ids);
    await db.watchEvents.where('source').equals('demo').delete();
    await db.channels.bulkDelete(ids);
  });
}
