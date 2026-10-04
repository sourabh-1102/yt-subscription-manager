import { db } from '@/db/db';
import type { DeletionLogEntry, Playlist, PlaylistItem, WatchLaterItem } from '@/lib/types';
import { logDeletion } from '@/db/trash';
import { setAuthState } from '@/lib/prefs';
import { isVideoId } from '@/lib/youtube-urls';
import { API_DATA_TTL_MS } from '@/config/constants';
import { errMsg, getTokenDetails } from './auth';
import {
  createPlaylist,
  deletePlaylist,
  getVideos,
  listMyPlaylists,
  listPlaylistItems,
  movePlaylistItem,
  searchVideos,
  updatePlaylist,
  type PlaylistDTO,
  type PlaylistInput,
  type VideoDTO,
} from './playlist-api';

/**
 * Playlist Manager — service-worker side. All Google calls happen here; the UI reads the
 * cached results from IndexedDB (live queries) and sends typed messages for actions.
 */

export class PlaylistError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
  }
}

/** Write scope ('youtube') is requested only when the user starts a change (incremental auth). */
export async function ensureWriteScope(): Promise<void> {
  try {
    await getTokenDetails(true, true);
    await setAuthState({ hasWriteScope: true });
  } catch (e) {
    throw new PlaylistError(`Permission required to change playlists. ${errMsg(e)}`, 'no-write-scope');
  }
}

const toRow = (p: PlaylistDTO, prev: Playlist | undefined, now: number): Playlist => ({
  ...p,
  fetchedAt: now,
  itemsFetchedAt: prev?.itemsFetchedAt,
});

/** Refresh the list of the user's playlists (1 unit per 50 playlists). */
export async function syncPlaylists(): Promise<number> {
  const list = await listMyPlaylists();
  const now = Date.now();
  await db.transaction('rw', db.playlists, db.playlistItems, async () => {
    const prev = new Map((await db.playlists.toArray()).map((p) => [p.id, p]));
    const ids = new Set(list.map((p) => p.id));
    // Playlists deleted on YouTube: drop them and their cached items.
    const gone = [...prev.keys()].filter((id) => !ids.has(id));
    if (gone.length) {
      await db.playlists.bulkDelete(gone);
      await db.playlistItems.where('playlistId').anyOf(gone).delete();
    }
    await db.playlists.bulkPut(list.map((p) => toRow(p, prev.get(p.id), now)));
  });
  return list.length;
}

/** Fetch all items of one playlist and their durations (1 unit/50 items + 1 unit/50 videos). */
export async function syncPlaylistItems(playlistId: string): Promise<number> {
  const items = await listPlaylistItems(playlistId);
  const durations = new Map<string, string | undefined>();
  const ids = items.filter((i) => !i.unavailable).map((i) => i.videoId);
  try {
    for (const v of await getVideos(ids)) durations.set(v.videoId, v.duration);
  } catch {
    /* durations are optional */
  }
  const now = Date.now();
  const rows: PlaylistItem[] = items.map((i) => ({
    id: i.id,
    playlistId,
    videoId: i.videoId,
    position: i.position,
    title: i.title,
    channelTitle: i.channelTitle,
    channelId: i.channelId,
    thumbnailUrl: i.thumbnailUrl,
    duration: durations.get(i.videoId),
    videoPublishedAt: i.videoPublishedAt,
    addedAt: i.addedAt,
    unavailable: i.unavailable ? 1 : 0,
    fetchedAt: now,
  }));
  await db.transaction('rw', db.playlistItems, db.playlists, async () => {
    await db.playlistItems.where('playlistId').equals(playlistId).delete();
    await db.playlistItems.bulkPut(rows);
    await db.playlists.update(playlistId, { itemsFetchedAt: now, itemCount: rows.length });
  });
  return rows.length;
}

export async function createPlaylistAndCache(input: PlaylistInput): Promise<Playlist> {
  await ensureWriteScope();
  const p = await createPlaylist(input);
  const row: Playlist = { ...p, fetchedAt: Date.now(), itemsFetchedAt: Date.now() };
  await db.playlists.put(row);
  return row;
}

export async function updatePlaylistAndCache(id: string, input: PlaylistInput): Promise<Playlist> {
  await ensureWriteScope();
  const p = await updatePlaylist(id, input);
  const prev = await db.playlists.get(id);
  // update response omits contentDetails → keep the known item count / thumbnail.
  const row: Playlist = {
    ...prev,
    ...p,
    itemCount: prev?.itemCount ?? p.itemCount,
    thumbnailUrl: p.thumbnailUrl ?? prev?.thumbnailUrl,
    fetchedAt: Date.now(),
    itemsFetchedAt: prev?.itemsFetchedAt,
  };
  await db.playlists.put(row);
  return row;
}

/** Snapshot of a playlist (meta + videos) taken BEFORE it is deleted, so it can be recreated. */
export async function snapshotPlaylist(id: string): Promise<Partial<DeletionLogEntry>> {
  const pl = await db.playlists.get(id);
  if (!pl?.itemsFetchedAt) await syncPlaylistItems(id).catch(() => undefined);
  const items = await db.playlistItems.where('playlistId').equals(id).sortBy('position');
  return {
    playlistId: id,
    playlistTitle: pl?.title,
    description: pl?.description,
    privacy: pl?.privacy,
    thumbnailUrl: pl?.thumbnailUrl,
    videos: items.filter((i) => !i.unavailable).slice(0, 5000).map((i) => ({ videoId: i.videoId, title: i.title, channelTitle: i.channelTitle })),
    fetchedAt: pl?.fetchedAt ?? Date.now(),
  };
}

export async function deletePlaylistAndCache(id: string): Promise<void> {
  await ensureWriteScope();
  const snap = await snapshotPlaylist(id);
  await deletePlaylist(id);
  await logDeletion({ kind: 'playlist', ...snap });
  await db.transaction('rw', db.playlists, db.playlistItems, db.playlistTags, async () => {
    await db.playlists.delete(id);
    await db.playlistItems.where('playlistId').equals(id).delete();
    await db.playlistTags.where('playlistId').equals(id).delete();
  });
}

/**
 * Move one item to a new 0-based position. The UI only changes after this resolves:
 * on success the playlist is re-fetched so positions are exactly what YouTube reports.
 */
export async function reorderItem(playlistId: string, itemId: string, position: number): Promise<void> {
  await ensureWriteScope();
  const item = await db.playlistItems.get(itemId);
  if (!item || item.playlistId !== playlistId) throw new PlaylistError('This video is no longer in the playlist. Refresh and try again.', 'stale');
  await movePlaylistItem(itemId, playlistId, item.videoId, position);
  await syncPlaylistItems(playlistId);
}

/** Video ids already in a playlist (uses the cache when fresh, otherwise fetches). */
export async function playlistVideoIds(playlistId: string, maxAgeMs = 10 * 60 * 1000): Promise<Set<string>> {
  const p = await db.playlists.get(playlistId);
  if (!p?.itemsFetchedAt || Date.now() - p.itemsFetchedAt > maxAgeMs) await syncPlaylistItems(playlistId);
  return new Set((await db.playlistItems.where('playlistId').equals(playlistId).toArray()).map((i) => i.videoId));
}

export async function checkDuplicates(playlistId: string, videoIds: string[]): Promise<string[]> {
  const existing = await playlistVideoIds(playlistId);
  return [...new Set(videoIds)].filter((v) => existing.has(v));
}

/** Pasted links / ids → video details (1 unit per 50). */
export async function lookupVideos(ids: string[]): Promise<VideoDTO[]> {
  const valid = [...new Set(ids.filter(isVideoId))].slice(0, 500);
  return valid.length ? getVideos(valid) : [];
}

/** search.list (separate 100/day bucket) + videos.list for durations. */
export async function searchYouTube(q: string): Promise<VideoDTO[]> {
  const ids = await searchVideos(q);
  if (!ids.length) return [];
  const details = await getVideos(ids);
  const byId = new Map(details.map((d) => [d.videoId, d]));
  return ids.map((id) => byId.get(id)).filter((v): v is VideoDTO => !!v);
}

/** Watch Later: fill titles/channels/durations for imported ids (1 unit per 50). */
export async function enrichWatchLater(limit = 2000): Promise<number> {
  const todo = (await db.watchLater.filter((w) => !w.fetchedAt).limit(limit).toArray()).map((w) => w.videoId);
  if (!todo.length) return 0;
  const found = new Map((await getVideos(todo)).map((v) => [v.videoId, v]));
  const now = Date.now();
  await db.transaction('rw', db.watchLater, async () => {
    for (const id of todo) {
      const v = found.get(id);
      const patch: Partial<WatchLaterItem> = v
        ? { title: v.title, channelTitle: v.channelTitle, channelId: v.channelId, thumbnailUrl: v.thumbnailUrl, duration: v.duration, publishedAt: v.publishedAt, unavailable: 0, fetchedAt: now }
        : { unavailable: 1, fetchedAt: now };
      await db.watchLater.update(id, patch);
    }
  });
  return todo.length;
}

/** 30-day rule (YouTube API Developer Policies III.E.4) for playlist/WL caches. */
export async function enforcePlaylistTtl(): Promise<void> {
  const cutoff = Date.now() - API_DATA_TTL_MS;
  await db.playlistItems.where('fetchedAt').below(cutoff).delete();
  await db.playlists.where('fetchedAt').below(cutoff).delete();
  // Keep the user's own Takeout data (ids + added date); drop API metadata.
  await db.watchLater
    .where('fetchedAt')
    .below(cutoff)
    .modify({ title: undefined, channelTitle: undefined, channelId: undefined, thumbnailUrl: undefined, duration: undefined, publishedAt: undefined, fetchedAt: undefined });
}
