import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/db';
import { DAY_MS } from '@/config/constants';

const m = vi.hoisted(() => ({
  insertPlaylistItem: vi.fn(),
  deletePlaylistItem: vi.fn(),
  deletePlaylist: vi.fn(),
  createPlaylist: vi.fn(),
  getVideos: vi.fn(),
  listPlaylistItems: vi.fn(),
  getTokenDetails: vi.fn(),
  removeOneLive: vi.fn(),
}));
vi.mock('@/services/playlist-api', async (orig) => ({ ...(await orig<typeof import('@/services/playlist-api')>()), ...m }));
vi.mock('@/services/auth', async (orig) => ({ ...(await orig<typeof import('@/services/auth')>()), getTokenDetails: m.getTokenDetails }));
vi.mock('@/services/wl-live', async (orig) => ({ ...(await orig<typeof import('@/services/wl-live')>()), removeOneLive: m.removeOneLive }));

const { startOp, processOps, bulkTiming } = await import('@/services/bulk');
const { restorePlaylistVideos, recreatePlaylist, enforceTrashTtl } = await import('@/services/trash');
const { deletePlaylistAndCache } = await import('@/services/playlists');
const { deleteTag, restoreCategory, addTagToChannels } = await import('@/db/repo');

const V = (n: number) => `video${String(n).padStart(6, '0')}`;
const pl = (id: string, title: string, n = 2) => ({ id, title, description: 'desc', privacy: 'unlisted' as const, itemCount: n, fetchedAt: Date.now(), itemsFetchedAt: Date.now() });
const plItem = (playlistId: string, i: number) => ({
  id: `${playlistId}-i${i}`,
  playlistId,
  videoId: V(i),
  position: i,
  title: `Video ${i}`,
  channelTitle: 'Chan',
  thumbnailUrl: 'https://i.ytimg.com/x.jpg',
  fetchedAt: Date.now(),
});
const logs = (kind?: string) => db.deletionLog.filter((l) => !kind || l.kind === kind).toArray();

beforeEach(async () => {
  bulkTiming.delayMs = 0;
  bulkTiming.wlDelayMs = 0;
  m.insertPlaylistItem.mockReset().mockResolvedValue({ id: 'new' });
  m.deletePlaylistItem.mockReset().mockResolvedValue(undefined);
  m.deletePlaylist.mockReset().mockResolvedValue(undefined);
  m.createPlaylist.mockReset().mockImplementation(async (i: { title: string }) => ({ ...pl('PLnew', i.title, 0) }));
  m.getVideos.mockReset().mockResolvedValue([]);
  m.listPlaylistItems.mockReset().mockResolvedValue([]);
  m.getTokenDetails.mockReset().mockResolvedValue({ token: 't', grantedScopes: [] });
  m.removeOneLive.mockReset().mockResolvedValue({ ok: true });
  await db.playlists.bulkPut([pl('PLa', 'Rust'), pl('PLb', 'Go')]);
  await db.playlistItems.bulkPut([plItem('PLa', 0), plItem('PLa', 1), plItem('PLb', 2)]);
});

describe('logging deletions', () => {
  it('logs removed playlist videos with title, channel and playlist', async () => {
    await startOp({ kind: 'remove', label: 'x', sourcePlaylistId: 'PLa', items: [{ videoId: V(0), playlistItemId: 'PLa-i0' }] });
    await processOps();
    const [l] = await logs('playlist-video');
    expect(l).toMatchObject({ videoId: V(0), title: 'Video 0', channelTitle: 'Chan', playlistId: 'PLa', playlistTitle: 'Rust' });
  });

  it('logs moves with where they went', async () => {
    await startOp({ kind: 'move', label: 'x', sourcePlaylistId: 'PLa', destPlaylistId: 'PLb', items: [{ videoId: V(1), playlistItemId: 'PLa-i1' }] });
    await processOps();
    expect((await logs('playlist-video'))[0]).toMatchObject({ note: 'Moved to Go', playlistTitle: 'Rust' });
  });

  it('does not log anything when the removal failed', async () => {
    m.deletePlaylistItem.mockRejectedValue(new Error('boom'));
    await startOp({ kind: 'remove', label: 'x', sourcePlaylistId: 'PLa', items: [{ videoId: V(0), playlistItemId: 'PLa-i0' }] });
    await processOps();
    expect(await logs()).toHaveLength(0);
  });

  it('snapshots a playlist (meta + videos) before deleting it — bulk and single', async () => {
    await startOp({ kind: 'pl-delete', label: 'x', items: [{ videoId: '', targetPlaylistId: 'PLa' }] });
    await processOps();
    await deletePlaylistAndCache('PLb');
    const pls = await logs('playlist');
    expect(pls.map((p) => p.playlistTitle).sort()).toEqual(['Go', 'Rust']);
    const rust = pls.find((p) => p.playlistTitle === 'Rust')!;
    expect(rust).toMatchObject({ privacy: 'unlisted', description: 'desc' });
    expect(rust.videos?.map((v) => v.videoId)).toEqual([V(0), V(1)]);
  });

  it('logs Watch Later removals only after a verified removal', async () => {
    await db.watchLater.bulkPut([
      { videoId: V(5), title: 'Saved A', channelTitle: 'C', source: 'live', importedAt: 1 },
      { videoId: V(6), title: 'Saved B', source: 'live', importedAt: 1 },
    ]);
    m.removeOneLive.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, code: 'not-verified', error: 'still there' });
    await startOp({ kind: 'wl-remove', label: 'x', items: [{ videoId: V(5) }, { videoId: V(6) }] });
    await processOps();
    const wl = await logs('watch-later');
    expect(wl.map((l) => l.title)).toEqual(['Saved A']);
  });

  it('logs merged-and-deleted source playlists with a note', async () => {
    await startOp({ kind: 'merge', label: 'x', destPlaylistId: 'PLb', items: [{ videoId: V(0) }], deleteSourceIds: ['PLa'] });
    await processOps();
    expect((await logs('playlist'))[0]).toMatchObject({ playlistTitle: 'Rust', note: 'Merged into Go' });
  });
});

describe('restoring', () => {
  it('adds removed videos back to their playlists and marks them restored', async () => {
    await db.deletionLog.bulkPut([
      { id: 'l1', kind: 'playlist-video', at: 1, videoId: V(7), playlistId: 'PLa', title: 'x' },
      { id: 'l2', kind: 'playlist-video', at: 1, videoId: V(8), playlistId: 'PLb', title: 'y' },
      { id: 'l3', kind: 'playlist-video', at: 1, videoId: V(9), playlistId: 'PLgone', playlistTitle: 'Old' },
    ]);
    const r = await restorePlaylistVideos(['l1', 'l2', 'l3']);
    expect(r.opIds).toHaveLength(2);
    expect(r.missingPlaylists).toEqual(['Old']);
    await processOps();
    expect(m.insertPlaylistItem.mock.calls.map((c) => c.join(':')).sort()).toEqual([`PLa:${V(7)}`, `PLb:${V(8)}`]);
    expect((await db.deletionLog.get('l1'))?.restoredAt).toBeTypeOf('number');
    expect((await db.deletionLog.get('l3'))?.restoredAt).toBeUndefined();
  });

  it('a video that is already back in the playlist counts as restored', async () => {
    await db.deletionLog.put({ id: 'l4', kind: 'playlist-video', at: 1, videoId: V(0), playlistId: 'PLa' });
    await restorePlaylistVideos(['l4']);
    await processOps();
    expect(m.insertPlaylistItem).not.toHaveBeenCalled();
    expect((await db.deletionLog.get('l4'))?.restoredAt).toBeTypeOf('number');
  });

  it('recreates a deleted playlist with the same details and videos', async () => {
    await db.deletionLog.put({
      id: 'p1',
      kind: 'playlist',
      at: 1,
      playlistTitle: 'Rust',
      description: 'desc',
      privacy: 'unlisted',
      videos: [{ videoId: V(1) }, { videoId: V(2) }],
    });
    const r = await recreatePlaylist('p1');
    expect(m.createPlaylist).toHaveBeenCalledWith({ title: 'Rust', description: 'desc', privacy: 'unlisted' });
    await processOps();
    expect(m.insertPlaylistItem.mock.calls.map((c) => c[1])).toEqual([V(1), V(2)]);
    expect(await db.deletionLog.get('p1')).toMatchObject({ restoredTo: r.playlistId });
    await expect(recreatePlaylist('p1')).rejects.toThrow(/already/);
  });

  it('deleting a category is logged and can be restored with its assignments', async () => {
    await db.channels.put({ id: 'UC_x5XG1OV2P6uZZ5FSM9Ttw', title: 'c', subscribed: 1, source: 'api' });
    await db.tags.put({ id: 't1', name: 'Rust stuff', emoji: '🦀', order: 1 });
    await addTagToChannels('t1', ['UC_x5XG1OV2P6uZZ5FSM9Ttw']);
    await db.playlistTags.put({ playlistId: 'PLa', tagId: 't1' });
    await deleteTag('t1');
    const [log] = await logs('category');
    expect(log).toMatchObject({ tagName: 'Rust stuff', tagEmoji: '🦀', channelIds: ['UC_x5XG1OV2P6uZZ5FSM9Ttw'], playlistIds: ['PLa'] });
    expect(await restoreCategory(log!.id)).toEqual({ channels: 1, playlists: 1 });
    const tag = (await db.tags.toArray())[0]!;
    expect(tag.name).toBe('Rust stuff');
    expect(await db.channelTags.where('tagId').equals(tag.id).count()).toBe(1);
    expect(await db.playlistTags.where('tagId').equals(tag.id).count()).toBe(1);
  });
});

describe('30-day rule for the history', () => {
  it('strips YouTube titles after 30 days but keeps ids and dates', async () => {
    const old = Date.now() - 31 * DAY_MS;
    await db.deletionLog.bulkPut([
      { id: 'o1', kind: 'playlist', at: old, playlistTitle: 'Rust', videos: [{ videoId: V(1), title: 'T' }], fetchedAt: old },
      { id: 'o2', kind: 'category', at: old, tagName: 'Mine' },
    ]);
    await enforceTrashTtl();
    const o1 = await db.deletionLog.get('o1');
    expect(o1?.playlistTitle).toBeUndefined();
    expect(o1?.videos).toEqual([{ videoId: V(1) }]);
    expect(o1?.at).toBe(old);
    expect((await db.deletionLog.get('o2'))?.tagName).toBe('Mine'); // local data is untouched
  });
});
