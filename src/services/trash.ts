import { db } from '@/db/db';
import { markRestored } from '@/db/trash';
import type { DeletionLogEntry } from '@/lib/types';
import { getAuthState } from '@/lib/prefs';
import { API_DATA_TTL_MS, DAY_MS } from '@/config/constants';
import { startOp } from './bulk';
import { getVideos } from './playlist-api';
import { createPlaylistAndCache, PlaylistError } from './playlists';

/**
 * Restores from the deleted-items history (service worker). Only what YouTube's API allows:
 *  - playlist videos → added back to their original playlist (if it still exists)
 *  - deleted playlists → recreated (new playlist, same title/description/privacy, videos re-added)
 *  - Watch Later → NOT restorable (the API cannot add to Watch Later)
 */
export async function restorePlaylistVideos(logIds: string[]) {
  const logs = (await db.deletionLog.bulkGet(logIds)).filter(
    (l): l is DeletionLogEntry => !!l && l.kind === 'playlist-video' && !l.restoredAt && !!l.videoId && !!l.playlistId,
  );
  if (!logs.length) throw new PlaylistError('Nothing to restore.', 'empty');
  const groups = new Map<string, DeletionLogEntry[]>();
  for (const l of logs) groups.set(l.playlistId!, [...(groups.get(l.playlistId!) ?? []), l]);

  const started: string[] = [];
  const missing: string[] = [];
  for (const [playlistId, list] of groups) {
    const pl = await db.playlists.get(playlistId);
    if (!pl) {
      missing.push(list[0]?.playlistTitle ?? playlistId);
      continue;
    }
    const { op } = await startOp({
      kind: 'add',
      label: `Restore ${list.length} video${list.length === 1 ? '' : 's'} → ${pl.title}`,
      destPlaylistId: playlistId,
      skipDuplicates: true,
      items: list.map((l) => ({ videoId: l.videoId!, title: l.title, logId: l.id })),
    });
    started.push(op.id);
  }
  return { opIds: started, missingPlaylists: missing };
}

export async function recreatePlaylist(logId: string) {
  const log = await db.deletionLog.get(logId);
  if (!log || log.kind !== 'playlist') throw new PlaylistError('Not a deleted playlist.', 'bad-input');
  if (log.restoredAt) throw new PlaylistError('This playlist was already recreated.', 'done');
  const title = (log.playlistTitle || 'Restored playlist').slice(0, 150);
  const created = await createPlaylistAndCache({
    title,
    description: (log.description ?? '').slice(0, 5000),
    privacy: log.privacy ?? 'private',
  });
  await markRestored([logId], created.id);
  const videos = log.videos ?? [];
  if (!videos.length) return { playlistId: created.id, opId: undefined };
  const { op } = await startOp({
    kind: 'add',
    label: `Recreate “${title}” (${videos.length} videos)`,
    destPlaylistId: created.id,
    skipDuplicates: true,
    items: videos.map((v) => ({ videoId: v.videoId, title: v.title })),
  });
  return { playlistId: created.id, opId: op.id };
}

/**
 * YouTube API Developer Policies III.E.4: titles/thumbnails obtained from the API may be kept at most
 * 30 days. Video entries are refreshed via videos.list (1 unit per 50) when connected; whatever is
 * still stale after 30 days is stripped (ids, dates and notes stay).
 */
export async function enforceTrashTtl(): Promise<void> {
  const now = Date.now();
  const auth = await getAuthState();
  if (auth.signedIn) {
    const refreshCutoff = now - 25 * DAY_MS;
    const stale = await db.deletionLog
      .where('fetchedAt')
      .below(refreshCutoff)
      .filter((l) => !!l.videoId)
      .limit(1000)
      .toArray();
    try {
      const found = new Map((await getVideos([...new Set(stale.map((l) => l.videoId!))])).map((v) => [v.videoId, v]));
      await db.deletionLog.bulkUpdate(
        stale
          .filter((l) => found.has(l.videoId!))
          .map((l) => {
            const v = found.get(l.videoId!)!;
            return { key: l.id, changes: { title: v.title, channelTitle: v.channelTitle, thumbnailUrl: v.thumbnailUrl, fetchedAt: now } };
          }),
      );
    } catch {
      /* fall through to stripping */
    }
  }
  const cutoff = now - API_DATA_TTL_MS;
  await db.deletionLog
    .where('fetchedAt')
    .below(cutoff)
    .modify((l) => {
      delete l.title;
      delete l.channelTitle;
      delete l.thumbnailUrl;
      delete l.playlistTitle;
      delete l.description;
      if (l.videos) l.videos = l.videos.map((v) => ({ videoId: v.videoId }));
      delete l.fetchedAt;
    });
}
