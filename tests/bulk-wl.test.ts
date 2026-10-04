import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/db';

const m = vi.hoisted(() => ({
  insertPlaylistItem: vi.fn(),
  deletePlaylistItem: vi.fn(),
  deletePlaylist: vi.fn(),
  playlistVideoIds: vi.fn(),
  syncPlaylistItems: vi.fn(),
  ensureWriteScope: vi.fn(),
  removeOneLive: vi.fn(),
  order: [] as string[],
}));

vi.mock('@/services/playlist-api', async (orig) => ({
  ...(await orig<typeof import('@/services/playlist-api')>()),
  insertPlaylistItem: m.insertPlaylistItem,
  deletePlaylistItem: m.deletePlaylistItem,
  deletePlaylist: m.deletePlaylist,
}));
vi.mock('@/services/playlists', async (orig) => ({
  ...(await orig<typeof import('@/services/playlists')>()),
  playlistVideoIds: m.playlistVideoIds,
  syncPlaylistItems: m.syncPlaylistItems,
  ensureWriteScope: m.ensureWriteScope,
}));
vi.mock('@/services/wl-live', async (orig) => ({
  ...(await orig<typeof import('@/services/wl-live')>()),
  removeOneLive: m.removeOneLive,
}));

const { startOp, processOps, resumeOp, retryFailedOp, bulkTiming, summarize } = await import('@/services/bulk');
const { ApiError } = await import('@/services/youtube-api');
const { WlLiveError } = await import('@/services/wl-live');

const V = (n: number) => `video${String(n).padStart(6, '0')}`;
const wl = (n: number) => Array.from({ length: n }, (_, i) => ({ videoId: V(i), title: `W${i}` }));
const progress = async (opId: string) => summarize(await db.bulkOpItems.where('opId').equals(opId).toArray());

beforeEach(async () => {
  bulkTiming.delayMs = 0;
  bulkTiming.wlDelayMs = 0;
  m.order = [];
  m.insertPlaylistItem.mockReset().mockImplementation(async (pl: string, v: string) => {
    m.order.push(`add:${pl}:${v}`);
    return { id: 'x' };
  });
  m.deletePlaylistItem.mockReset().mockResolvedValue(undefined);
  m.deletePlaylist.mockReset().mockImplementation(async (id: string) => {
    m.order.push(`delpl:${id}`);
  });
  m.playlistVideoIds.mockReset().mockResolvedValue(new Set<string>());
  m.syncPlaylistItems.mockReset().mockResolvedValue(0);
  m.ensureWriteScope.mockReset().mockResolvedValue(undefined);
  m.removeOneLive.mockReset().mockImplementation(async (v: string) => {
    m.order.push(`wl:${v}`);
    return { ok: true };
  });
  await db.watchLater.bulkPut(wl(5).map((w) => ({ videoId: w.videoId, title: w.title, source: 'live' as const, importedAt: 1 })));
});

describe('remove from YouTube Watch Later (website UI)', () => {
  it('removes every selected video, verified, and updates the local list', async () => {
    const { op } = await startOp({ kind: 'wl-remove', label: 'x', items: wl(3) });
    await processOps();
    expect(m.removeOneLive).toHaveBeenCalledTimes(3);
    expect(await progress(op.id)).toMatchObject({ done: 3, failed: 0 });
    expect((await db.watchLater.toArray()).map((w) => w.videoId)).toEqual([V(3), V(4)]);
    expect(m.ensureWriteScope).not.toHaveBeenCalled(); // no API / OAuth involved
  });

  it('missing video and unverified removal are failures (row kept locally)', async () => {
    m.removeOneLive
      .mockResolvedValueOnce({ ok: false, code: 'not-found', error: 'Video not found in the current Watch Later list.' })
      .mockResolvedValueOnce({ ok: false, code: 'not-verified', error: 'YouTube didn’t confirm the removal' })
      .mockResolvedValueOnce({ ok: true });
    const { op } = await startOp({ kind: 'wl-remove', label: 'x', items: wl(3) });
    await processOps();
    expect(await progress(op.id)).toMatchObject({ done: 1, failed: 2 });
    const failed = await db.bulkOpItems.where('[opId+status]').equals([op.id, 'failed']).toArray();
    expect(failed.map((f) => f.error)).toEqual(['Video not found in the current Watch Later list.', 'YouTube didn’t confirm the removal']);
    expect(await db.watchLater.get(V(0))).toBeTruthy();
  });

  it('retry failed only re-runs failures — confirmed removals are never repeated', async () => {
    m.removeOneLive.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, code: 'not-verified', error: 'x' });
    const { op } = await startOp({ kind: 'wl-remove', label: 'x', items: wl(2) });
    await processOps();
    m.removeOneLive.mockClear();
    await retryFailedOp(op.id);
    await processOps();
    expect(m.removeOneLive).toHaveBeenCalledTimes(1);
    expect(m.removeOneLive).toHaveBeenCalledWith(V(1));
    expect(await progress(op.id)).toMatchObject({ done: 2, failed: 0 });
  });

  it('signed out of YouTube → stops with the sign-in message, pending items kept, resume continues', async () => {
    m.removeOneLive.mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(new WlLiveError('Please sign in to YouTube and try again.', 'signed-out'));
    const { op } = await startOp({ kind: 'wl-remove', label: 'x', items: wl(3) });
    await processOps();
    const o = await db.bulkOps.get(op.id);
    expect(o).toMatchObject({ status: 'stopped', lastError: 'Please sign in to YouTube and try again.' });
    expect(await progress(op.id)).toMatchObject({ done: 1, pending: 2, failed: 0 });
    m.removeOneLive.mockClear();
    await resumeOp(op.id);
    await processOps();
    expect(m.removeOneLive.mock.calls.map((c) => c[0])).toEqual([V(1), V(2)]);
    expect(await progress(op.id)).toMatchObject({ done: 3 });
  });
});

describe('safe move from Watch Later', () => {
  it('adds to the playlist (API) BEFORE removing from Watch Later (UI)', async () => {
    const { op } = await startOp({ kind: 'wl-move', label: 'x', destPlaylistId: 'PLd', items: wl(2) });
    await processOps();
    expect(m.order).toEqual([`add:PLd:${V(0)}`, `wl:${V(0)}`, `add:PLd:${V(1)}`, `wl:${V(1)}`]);
    expect(await progress(op.id)).toMatchObject({ done: 2 });
  });

  it('never touches Watch Later when the add failed', async () => {
    m.insertPlaylistItem.mockRejectedValueOnce(new ApiError('nf', 404, 'videoNotFound'));
    const { op } = await startOp({ kind: 'wl-move', label: 'x', destPlaylistId: 'PLd', items: wl(1) });
    await processOps();
    expect(m.removeOneLive).not.toHaveBeenCalled();
    expect(await progress(op.id)).toMatchObject({ failed: 1 });
  });

  it('says exactly what happened when the removal fails, and retry does not add twice', async () => {
    await db.playlists.put({ id: 'PLd', title: 'Programming', description: '', privacy: 'private', itemCount: 0, fetchedAt: Date.now() });
    m.removeOneLive.mockResolvedValueOnce({ ok: false, code: 'not-verified', error: 'still there' });
    const { op } = await startOp({ kind: 'wl-move', label: 'x', destPlaylistId: 'PLd', items: wl(1) });
    await processOps();
    const it0 = (await db.bulkOpItems.where('opId').equals(op.id).first())!;
    expect(it0).toMatchObject({ status: 'failed', added: 1 });
    expect(it0.error).toBe('Added to Programming, but could not remove from Watch Later: still there');
    await retryFailedOp(op.id);
    await processOps();
    expect(m.insertPlaylistItem).toHaveBeenCalledTimes(1);
    expect(m.removeOneLive).toHaveBeenCalledTimes(2);
    expect(await progress(op.id)).toMatchObject({ done: 1 });
  });

  it('a video already in the playlist is just removed from Watch Later', async () => {
    m.playlistVideoIds.mockResolvedValue(new Set([V(0)]));
    await startOp({ kind: 'wl-move', label: 'x', destPlaylistId: 'PLd', items: wl(1) });
    await processOps();
    expect(m.order).toEqual([`wl:${V(0)}`]);
  });
});

describe('bulk delete playlists', () => {
  it('deletes each playlist and clears its cache; 404 counts as deleted', async () => {
    await db.playlists.bulkPut(['A', 'B'].map((id) => ({ id: `PL${id}`, title: id, description: '', privacy: 'private' as const, itemCount: 1, fetchedAt: 1 })));
    await db.playlistTags.put({ playlistId: 'PLA', tagId: 't' });
    m.deletePlaylist.mockImplementationOnce(async () => {
      throw new ApiError('gone', 404, 'playlistNotFound');
    });
    const { op } = await startOp({
      kind: 'pl-delete',
      label: 'x',
      items: [
        { videoId: '', targetPlaylistId: 'PLA' },
        { videoId: '', targetPlaylistId: 'PLB' },
      ],
    });
    await processOps();
    expect(await progress(op.id)).toMatchObject({ done: 2 });
    expect(await db.playlists.count()).toBe(0);
    expect(await db.playlistTags.count()).toBe(0);
    expect(m.ensureWriteScope).toHaveBeenCalled();
  });
});

describe('merge playlists', () => {
  const mergeItems = [{ videoId: V(0) }, { videoId: V(1) }, { videoId: V(2) }];

  it('adds everything, skips duplicates, then deletes the sources only after full success', async () => {
    m.playlistVideoIds.mockResolvedValue(new Set([V(1)]));
    const { op, skipped } = await startOp({ kind: 'merge', label: 'x', destPlaylistId: 'PLt', items: mergeItems, deleteSourceIds: ['PL1', 'PL2', 'PLt'] });
    await processOps();
    expect(skipped).toBe(1);
    expect(m.order).toEqual([`add:PLt:${V(0)}`, `add:PLt:${V(2)}`, 'delpl:PL1', 'delpl:PL2']); // target is never deleted
    expect((await db.bulkOps.get(op.id))?.resultNote).toMatch(/Deleted 2 of 2 source playlists/);
  });

  it('keeps the source playlists if any video failed', async () => {
    m.insertPlaylistItem.mockRejectedValueOnce(new ApiError('nf', 404, 'videoNotFound'));
    const { op } = await startOp({ kind: 'merge', label: 'x', destPlaylistId: 'PLt', items: mergeItems, deleteSourceIds: ['PL1'] });
    await processOps();
    expect(m.deletePlaylist).not.toHaveBeenCalled();
    expect((await db.bulkOps.get(op.id))?.resultNote).toMatch(/Source playlists were kept because 1 video/);
  });
});
