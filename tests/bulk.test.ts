import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/db';

const m = vi.hoisted(() => ({
  insertPlaylistItem: vi.fn(),
  deletePlaylistItem: vi.fn(),
  playlistVideoIds: vi.fn(),
  syncPlaylistItems: vi.fn(),
  ensureWriteScope: vi.fn(),
  order: [] as string[],
}));

vi.mock('@/services/playlist-api', async (orig) => ({
  ...(await orig<typeof import('@/services/playlist-api')>()),
  insertPlaylistItem: m.insertPlaylistItem,
  deletePlaylistItem: m.deletePlaylistItem,
}));
vi.mock('@/services/playlists', async (orig) => ({
  ...(await orig<typeof import('@/services/playlists')>()),
  playlistVideoIds: m.playlistVideoIds,
  syncPlaylistItems: m.syncPlaylistItems,
  ensureWriteScope: m.ensureWriteScope,
}));

const { startOp, processOps, stopOp, resumeOp, retryFailedOp, bulkTiming, summarize } = await import('@/services/bulk');
const { ApiError } = await import('@/services/youtube-api');
const { recordUsage } = await import('@/services/quota');
const { PLAYLIST_DAILY_WRITE_CAP } = await import('@/config/constants');

const V = (n: number) => `video${String(n).padStart(6, '0')}`; // 11 chars
const items = (n: number, withItemId = false) =>
  Array.from({ length: n }, (_, i) => ({ videoId: V(i), title: `T${i}`, ...(withItemId ? { playlistItemId: `pi${i}` } : {}) }));
const progress = async (opId: string) => summarize(await db.bulkOpItems.where('opId').equals(opId).toArray());

beforeEach(() => {
  bulkTiming.delayMs = 0;
  m.order = [];
  m.insertPlaylistItem.mockReset().mockImplementation(async (pl: string, v: string) => {
    m.order.push(`add:${pl}:${v}`);
    return { id: 'x' };
  });
  m.deletePlaylistItem.mockReset().mockImplementation(async (id: string) => {
    m.order.push(`del:${id}`);
  });
  m.playlistVideoIds.mockReset().mockResolvedValue(new Set<string>());
  m.syncPlaylistItems.mockReset().mockResolvedValue(0);
  m.ensureWriteScope.mockReset().mockResolvedValue(undefined);
});

describe('bulk add', () => {
  it('adds every video, sequentially, and finishes', async () => {
    const { op } = await startOp({ kind: 'add', label: 'x', destPlaylistId: 'PLd', items: items(5) });
    await processOps();
    expect(m.insertPlaylistItem).toHaveBeenCalledTimes(5);
    expect(await progress(op.id)).toMatchObject({ total: 5, done: 5, failed: 0 });
    expect((await db.bulkOps.get(op.id))?.status).toBe('done');
    expect(m.ensureWriteScope).toHaveBeenCalled(); // write permission requested on demand
  });

  it('skips duplicates by default, or adds anyway', async () => {
    m.playlistVideoIds.mockResolvedValue(new Set([V(0), V(1)]));
    const a = await startOp({ kind: 'add', label: 'x', destPlaylistId: 'PLd', items: items(4) });
    await processOps();
    expect(a.skipped).toBe(2);
    expect(await progress(a.op.id)).toMatchObject({ done: 2, skipped: 2 });

    m.insertPlaylistItem.mockClear();
    await startOp({ kind: 'add', label: 'x', destPlaylistId: 'PLd', items: items(4), skipDuplicates: false });
    await processOps();
    expect(m.insertPlaylistItem).toHaveBeenCalledTimes(4);
  });

  it('de-duplicates the selection itself', async () => {
    const { op } = await startOp({ kind: 'add', label: 'x', destPlaylistId: 'PLd', items: [...items(2), ...items(2)] });
    expect((await progress(op.id)).total).toBe(2);
  });

  it('records failures and retries only the failed ones', async () => {
    m.insertPlaylistItem.mockRejectedValueOnce(new ApiError('nf', 404, 'videoNotFound'));
    const { op } = await startOp({ kind: 'add', label: 'x', destPlaylistId: 'PLd', items: items(3) });
    await processOps();
    expect(await progress(op.id)).toMatchObject({ done: 2, failed: 1 });
    const failed = await db.bulkOpItems.where('[opId+status]').equals([op.id, 'failed']).first();
    expect(failed?.error).toMatch(/unavailable/);
    m.insertPlaylistItem.mockClear();
    expect(await retryFailedOp(op.id)).toBe(1);
    await processOps();
    expect(m.insertPlaylistItem).toHaveBeenCalledTimes(1);
    expect(await progress(op.id)).toMatchObject({ done: 3, failed: 0 });
  });

  it('pauses on quota exhaustion and keeps the rest pending (no lost state)', async () => {
    m.insertPlaylistItem.mockImplementationOnce(async () => ({ id: 'a' })).mockRejectedValueOnce(new ApiError('q', 403, 'quotaExceeded'));
    const { op } = await startOp({ kind: 'add', label: 'x', destPlaylistId: 'PLd', items: items(4) });
    await processOps();
    expect((await db.bulkOps.get(op.id))?.status).toBe('paused-quota');
    expect(await progress(op.id)).toMatchObject({ done: 1, pending: 3, failed: 0 });
  });

  it('respects the daily write cap', async () => {
    for (let i = 0; i < PLAYLIST_DAILY_WRITE_CAP; i++) await recordUsage(50, true);
    const { op } = await startOp({ kind: 'add', label: 'x', destPlaylistId: 'PLd', items: items(2) });
    await processOps();
    expect(m.insertPlaylistItem).not.toHaveBeenCalled();
    expect((await db.bulkOps.get(op.id))?.status).toBe('paused-quota');
  });

  it('stop halts between items and resume continues without repeating', async () => {
    let release!: () => void;
    m.insertPlaylistItem.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = () => r({ id: 'a' });
        }),
    );
    const { op } = await startOp({ kind: 'add', label: 'x', destPlaylistId: 'PLd', items: items(4) });
    await vi.waitFor(() => expect(m.insertPlaylistItem).toHaveBeenCalledTimes(1));
    await stopOp(op.id);
    release();
    await processOps();
    expect(m.insertPlaylistItem).toHaveBeenCalledTimes(1);
    expect(await progress(op.id)).toMatchObject({ done: 1, pending: 3 });
    await resumeOp(op.id);
    await processOps();
    expect(m.insertPlaylistItem).toHaveBeenCalledTimes(4);
    expect(await progress(op.id)).toMatchObject({ done: 4, pending: 0 });
  });
});

describe('bulk remove', () => {
  it('removes by playlistItem id; 404 counts as already removed', async () => {
    m.deletePlaylistItem.mockImplementationOnce(async () => {
      throw new ApiError('gone', 404, 'playlistItemNotFound');
    });
    await db.playlists.put({ id: 'PLs', title: 's', description: '', privacy: 'private', itemCount: 3, fetchedAt: Date.now() });
    const { op } = await startOp({ kind: 'remove', label: 'x', sourcePlaylistId: 'PLs', items: items(3, true) });
    await processOps();
    expect(await progress(op.id)).toMatchObject({ done: 3, failed: 0 });
    expect(m.syncPlaylistItems).toHaveBeenCalledWith('PLs'); // cache refreshed afterwards (if cached)
  });

  it('refuses items without a playlistItem id', async () => {
    await expect(startOp({ kind: 'remove', label: 'x', sourcePlaylistId: 'PLs', items: items(1) })).rejects.toThrow(/can’t be removed/);
  });
});

describe('safe move', () => {
  it('adds to the destination BEFORE removing from the source', async () => {
    const { op } = await startOp({ kind: 'move', label: 'x', sourcePlaylistId: 'PLs', destPlaylistId: 'PLd', items: items(2, true) });
    await processOps();
    expect(m.order).toEqual([`add:PLd:${V(0)}`, 'del:pi0', `add:PLd:${V(1)}`, 'del:pi1']);
    expect(await progress(op.id)).toMatchObject({ done: 2 });
  });

  it('never removes from the source when the add failed', async () => {
    m.insertPlaylistItem.mockRejectedValueOnce(new ApiError('nf', 404, 'videoNotFound'));
    const { op } = await startOp({ kind: 'move', label: 'x', sourcePlaylistId: 'PLs', destPlaylistId: 'PLd', items: items(1, true) });
    await processOps();
    expect(m.deletePlaylistItem).not.toHaveBeenCalled();
    expect(await progress(op.id)).toMatchObject({ failed: 1 });
  });

  it('if the removal fails, retry only removes (never adds twice)', async () => {
    m.deletePlaylistItem.mockRejectedValueOnce(new ApiError('x', 500));
    const { op } = await startOp({ kind: 'move', label: 'x', sourcePlaylistId: 'PLs', destPlaylistId: 'PLd', items: items(1, true) });
    await processOps();
    const it0 = (await db.bulkOpItems.where('opId').equals(op.id).first())!;
    expect(it0).toMatchObject({ status: 'failed', added: 1 });
    expect(it0.error).toMatch(/Copied, but couldn’t remove/);
    await retryFailedOp(op.id);
    await processOps();
    expect(m.insertPlaylistItem).toHaveBeenCalledTimes(1);
    expect(m.deletePlaylistItem).toHaveBeenCalledTimes(2);
    expect(await progress(op.id)).toMatchObject({ done: 1 });
  });

  it('a video already in the destination is only removed from the source', async () => {
    m.playlistVideoIds.mockResolvedValue(new Set([V(0)]));
    await startOp({ kind: 'move', label: 'x', sourcePlaylistId: 'PLs', destPlaylistId: 'PLd', items: items(1, true) });
    await processOps();
    expect(m.order).toEqual(['del:pi0']);
  });

  it('rejects moving into the same playlist', async () => {
    await expect(startOp({ kind: 'move', label: 'x', sourcePlaylistId: 'PLs', destPlaylistId: 'PLs', items: items(1, true) })).rejects.toThrow(/same playlist/);
  });
});

describe('permissions', () => {
  it('does not start anything when the write permission is refused', async () => {
    m.ensureWriteScope.mockRejectedValue(new Error('Permission required'));
    await expect(startOp({ kind: 'add', label: 'x', destPlaylistId: 'PLd', items: items(1) })).rejects.toThrow(/Permission/);
    expect(await db.bulkOps.count()).toBe(0);
  });
});
