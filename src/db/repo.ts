import { db, newId } from './db';
import type { BellIntent, ChannelFlags, Tag } from '@/lib/types';
import type { TakeoutSubscription, TakeoutWatch } from '@/services/takeout';
import { watchEventId } from '@/lib/ids';
import { logDeletion, markRestored } from './trash';

/**
 * Local organization operations. These never touch YouTube — moving a channel between
 * categories, favoriting, etc. only changes this browser's database.
 */

// ---------- Tags (categories) ----------
export async function createTag(name: string, emoji = '📁'): Promise<Tag> {
  const order = ((await db.tags.orderBy('order').last())?.order ?? 0) + 1;
  const tag: Tag = { id: newId(), name: name.trim().slice(0, 60) || 'Untitled', emoji: emoji.slice(0, 8), order };
  await db.tags.put(tag);
  return tag;
}

export async function updateTag(id: string, patch: Partial<Pick<Tag, 'name' | 'emoji' | 'order'>>) {
  await db.tags.update(id, {
    ...patch,
    ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 60) || 'Untitled' } : {}),
  });
}

export async function deleteTag(id: string) {
  const tag = await db.tags.get(id);
  if (tag) {
    const channelIds = (await db.channelTags.where('tagId').equals(id).toArray()).map((r) => r.channelId);
    const playlistIds = (await db.playlistTags.where('tagId').equals(id).toArray()).map((r) => r.playlistId);
    await logDeletion({ kind: 'category', note: id, tagName: tag.name, tagEmoji: tag.emoji, channelIds, playlistIds });
  }
  await db.transaction('rw', db.tags, db.channelTags, db.playlistTags, async () => {
    await db.channelTags.where('tagId').equals(id).delete();
    await db.playlistTags.where('tagId').equals(id).delete();
    await db.tags.delete(id);
  });
}

export async function moveTag(id: string, dir: -1 | 1) {
  const tags = await db.tags.orderBy('order').toArray();
  const i = tags.findIndex((t) => t.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= tags.length) return;
  await db.transaction('rw', db.tags, async () => {
    await db.tags.update(tags[i]!.id, { order: tags[j]!.order });
    await db.tags.update(tags[j]!.id, { order: tags[i]!.order });
  });
}

export async function addTagToChannels(tagId: string, channelIds: string[]) {
  await db.channelTags.bulkPut(channelIds.map((channelId) => ({ channelId, tagId })));
}

export async function removeTagFromChannels(tagId: string, channelIds: string[]) {
  await db.channelTags.bulkDelete(channelIds.map((c) => [c, tagId] as [string, string]));
}

// ---------- Auto-categorization ----------
/**
 * Assign suggested category keys to channels. Reuses an existing category with the same name
 * (case-insensitive), otherwise creates it. Adds categories; never removes existing ones.
 */
export async function applyCategorization(assignments: { channelId: string; keys: string[] }[]): Promise<{ assigned: number; created: number }> {
  const { defByKey } = await import('@/features/categorize');
  const keys = [...new Set(assignments.flatMap((a) => a.keys))];
  let created = 0;
  const tagIdByKey = new Map<string, string>();
  await db.transaction('rw', db.tags, db.channelTags, async () => {
    const tags = await db.tags.toArray();
    let order = Math.max(0, ...tags.map((t) => t.order));
    for (const key of keys) {
      const def = defByKey(key);
      const existing = tags.find((t) => t.name.trim().toLowerCase() === def.name.toLowerCase());
      if (existing) tagIdByKey.set(key, existing.id);
      else {
        const tag: Tag = { id: newId(), name: def.name, emoji: def.emoji, order: ++order };
        await db.tags.put(tag);
        tags.push(tag);
        tagIdByKey.set(key, tag.id);
        created++;
      }
    }
    await db.channelTags.bulkPut(
      assignments.flatMap((a) => a.keys.map((k) => ({ channelId: a.channelId, tagId: tagIdByKey.get(k)! }))),
    );
  });
  return { assigned: assignments.filter((a) => a.keys.length).length, created };
}

/** Bring back a deleted category with its channel/playlist assignments (local only). */
export async function restoreCategory(logId: string): Promise<{ channels: number; playlists: number }> {
  const log = await db.deletionLog.get(logId);
  if (!log || log.kind !== 'category' || log.restoredAt) throw new Error('Nothing to restore.');
  const tag = await createTag(log.tagName ?? 'Restored category', log.tagEmoji ?? '📁');
  const channels = (await db.channels.bulkGet(log.channelIds ?? [])).filter((c): c is NonNullable<typeof c> => !!c).map((c) => c.id);
  const playlists = (await db.playlists.bulkGet(log.playlistIds ?? [])).filter((p): p is NonNullable<typeof p> => !!p).map((p) => p.id);
  await addTagToChannels(tag.id, channels);
  await db.playlistTags.bulkPut(playlists.map((playlistId) => ({ playlistId, tagId: tag.id })));
  await markRestored([logId]);
  return { channels: channels.length, playlists: playlists.length };
}

// ---------- Playlist categories (local only — never sent to YouTube) ----------
export async function addTagToPlaylists(tagId: string, playlistIds: string[]) {
  await db.playlistTags.bulkPut(playlistIds.map((playlistId) => ({ playlistId, tagId })));
}

export async function removeTagFromPlaylists(tagId: string, playlistIds: string[]) {
  await db.playlistTags.bulkDelete(playlistIds.map((p) => [p, tagId] as [string, string]));
}

/** Suggest + apply categories to playlists from their title/description (local keyword rules, no API). */
export async function autoCategorizePlaylists(playlistIds: string[], onlyUncategorized: boolean): Promise<number> {
  const { classifyChannel, defByKey } = await import('@/features/categorize');
  const pls = (await db.playlists.bulkGet(playlistIds)).filter((p): p is NonNullable<typeof p> => !!p);
  const tagged = new Set((await db.playlistTags.where('playlistId').anyOf(playlistIds).toArray()).map((t) => t.playlistId));
  const targets = onlyUncategorized ? pls.filter((p) => !tagged.has(p.id)) : pls;
  let n = 0;
  await db.transaction('rw', db.tags, db.playlistTags, async () => {
    const tags = await db.tags.toArray();
    let order = Math.max(0, ...tags.map((t) => t.order));
    const idFor = async (key: string) => {
      const def = defByKey(key);
      const ex = tags.find((t) => t.name.trim().toLowerCase() === def.name.toLowerCase());
      if (ex) return ex.id;
      const tag: Tag = { id: newId(), name: def.name, emoji: def.emoji, order: ++order };
      await db.tags.put(tag);
      tags.push(tag);
      return tag.id;
    };
    for (const p of targets) {
      const { keys } = classifyChannel({ title: p.title, description: p.description });
      for (const k of keys) await db.playlistTags.put({ playlistId: p.id, tagId: await idFor(k) });
      n++;
    }
  });
  return n;
}

// ---------- Flags ----------
async function patchFlags(channelIds: string[], patch: Partial<Omit<ChannelFlags, 'channelId'>>) {
  await db.transaction('rw', db.flags, async () => {
    const existing = await db.flags.bulkGet(channelIds);
    await db.flags.bulkPut(channelIds.map((channelId, i) => ({ ...existing[i], ...patch, channelId })));
  });
}

export const setFavorite = (ids: string[], on: boolean) => patchFlags(ids, { favorite: on ? 1 : 0 });
export const setReviewLater = (ids: string[], on: boolean) => patchFlags(ids, { reviewLater: on ? 1 : 0 });
export const setNote = (id: string, note: string) => patchFlags([id], { note: note.slice(0, 2000) });
export const setBellIntent = (ids: string[], bellIntent: BellIntent | undefined) =>
  patchFlags(ids, { bellIntent, bellDone: 0 });
export const setBellDone = (ids: string[], done: boolean) => patchFlags(ids, { bellDone: done ? 1 : 0 });

// ---------- Takeout imports ----------
export async function importTakeoutWatches(
  watches: TakeoutWatch[],
  excluded: string[],
): Promise<{ added: number; duplicates: number }> {
  const ex = new Set(excluded);
  let added = 0;
  let duplicates = 0;
  const CHUNK = 2000;
  for (let i = 0; i < watches.length; i += CHUNK) {
    const chunk = watches.slice(i, i + CHUNK).filter((w) => !ex.has(w.channelId));
    await db.transaction('rw', db.watchEvents, db.channels, async () => {
      const ids = chunk.map((w) => watchEventId(w.videoId, w.watchedAt));
      const existing = await db.watchEvents.bulkGet(ids);
      const fresh = new Map<string, (typeof chunk)[number]>();
      chunk.forEach((w, idx) => {
        if (existing[idx] || fresh.has(ids[idx]!)) duplicates++;
        else fresh.set(ids[idx]!, w);
      });
      await db.watchEvents.bulkPut(
        [...fresh].map(([id, w]) => ({ id, videoId: w.videoId, channelId: w.channelId, watchedAt: w.watchedAt, source: 'takeout' as const })),
      );
      added += fresh.size;
      // Remember channel names for watched-but-not-subscribed channels.
      const chIds = [...new Set(chunk.map((w) => w.channelId))];
      const known = await db.channels.bulkGet(chIds);
      const titleOf = new Map(chunk.map((w) => [w.channelId, w.channelTitle]));
      await db.channels.bulkPut(
        chIds
          .filter((_, idx) => !known[idx])
          .map((id) => ({ id, title: titleOf.get(id) ?? '', subscribed: 0 as const, source: 'takeout' as const })),
      );
    });
  }
  return { added, duplicates };
}

/** Offline mode: subscription list from Takeout (no Google sign-in needed). */
export async function importTakeoutSubscriptions(subs: TakeoutSubscription[]): Promise<{ added: number; updated: number }> {
  let added = 0;
  let updated = 0;
  await db.transaction('rw', db.channels, async () => {
    const existing = await db.channels.bulkGet(subs.map((s) => s.channelId));
    await db.channels.bulkPut(
      subs.map((s, i) => {
        const ex = existing[i];
        if (ex) updated++;
        else added++;
        // Never downgrade a fresh API record; otherwise mark as subscribed from Takeout.
        return ex?.source === 'api'
          ? { ...ex, subscribed: 1 as const }
          : { ...ex, id: s.channelId, title: s.title || ex?.title || '', subscribed: 1 as const, source: 'takeout' as const };
      }),
    );
  });
  return { added, updated };
}

// ---------- Reset ----------
export async function resetAnalytics() {
  await db.transaction('rw', db.watchEvents, db.pendingVideos, async () => {
    await db.watchEvents.clear();
    await db.pendingVideos.clear();
  });
}

export async function resetAllData() {
  await db.transaction('rw', db.tables, async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
  });
}

/** Delete data that came from the YouTube API (on disconnect). User-created data is kept. */
export async function deleteApiData() {
  await db.transaction('rw', db.channels, db.unsubscribed, async () => {
    await db.channels.where('source').equals('api').modify({
      title: '',
      thumbnailUrl: undefined,
      subscriptionId: undefined,
      videoCount: undefined,
      fetchedAt: undefined,
    });
    await db.channels.filter((c) => c.fetchedAt !== undefined).modify({ title: '', thumbnailUrl: undefined, fetchedAt: undefined });
    await db.unsubscribed.toCollection().modify({ title: '', thumbnailUrl: undefined });
  });
}
