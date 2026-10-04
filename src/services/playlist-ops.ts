import { db } from '@/db/db';
import type { PlaylistInput } from './playlist-api';
import { createPlaylistAndCache, ensureWriteScope, PlaylistError, syncPlaylistItems } from './playlists';
import { startOp } from './bulk';

/** Delete several playlists (each 50 units) through the bulk engine — with progress/stop/retry. */
export async function deletePlaylists(ids: string[]) {
  const pls = (await db.playlists.bulkGet([...new Set(ids)])).filter((p): p is NonNullable<typeof p> => !!p);
  if (!pls.length) throw new PlaylistError('No playlists selected.', 'bad-input');
  return startOp({
    kind: 'pl-delete',
    label: `Delete ${pls.length} playlist${pls.length === 1 ? '' : 's'}`,
    items: pls.map((p) => ({ videoId: '', targetPlaylistId: p.id, title: p.title })),
  });
}

export interface MergeInput {
  sourceIds: string[];
  /** Existing playlist id, or details for a new playlist. */
  target: { id: string } | { create: PlaylistInput };
  deleteSources: boolean;
  skipDuplicates: boolean;
}

/**
 * Merge/combine playlists: all videos of the sources (in order, de-duplicated) are added to the
 * target. Sources are deleted afterwards ONLY if requested and every add succeeded (see bulk.ts).
 */
export async function mergePlaylists(input: MergeInput) {
  await ensureWriteScope();
  const targetId = 'id' in input.target ? input.target.id : (await createPlaylistAndCache(input.target.create)).id;
  const sources = [...new Set(input.sourceIds)].filter((id) => id !== targetId);
  if (!sources.length) throw new PlaylistError('Pick at least one playlist to merge into the target.', 'bad-input');

  const seen = new Set<string>();
  const items: { videoId: string; title?: string }[] = [];
  for (const id of sources) {
    await syncPlaylistItems(id); // fresh contents (1 unit per 50 videos)
    const rows = await db.playlistItems.where('playlistId').equals(id).sortBy('position');
    for (const r of rows) {
      if (r.unavailable || seen.has(r.videoId)) continue;
      seen.add(r.videoId);
      items.push({ videoId: r.videoId, title: r.title });
    }
  }
  const target = await db.playlists.get(targetId);
  if (!items.length) throw new PlaylistError('The selected playlists have no videos to merge.', 'empty');
  return startOp({
    kind: 'merge',
    label: `Merge ${sources.length} playlist${sources.length === 1 ? '' : 's'} → ${target?.title ?? 'playlist'}`,
    destPlaylistId: targetId,
    skipDuplicates: input.skipDuplicates,
    deleteSourceIds: input.deleteSources ? sources : undefined,
    items,
  });
}
