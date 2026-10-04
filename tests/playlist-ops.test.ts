import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/db';

const m = vi.hoisted(() => ({
  startOp: vi.fn(),
  syncPlaylistItems: vi.fn(),
  ensureWriteScope: vi.fn(),
  createPlaylistAndCache: vi.fn(),
}));
vi.mock('@/services/bulk', async (orig) => ({ ...(await orig<typeof import('@/services/bulk')>()), startOp: m.startOp }));
vi.mock('@/services/playlists', async (orig) => ({
  ...(await orig<typeof import('@/services/playlists')>()),
  syncPlaylistItems: m.syncPlaylistItems,
  ensureWriteScope: m.ensureWriteScope,
  createPlaylistAndCache: m.createPlaylistAndCache,
}));

const { mergePlaylists, deletePlaylists } = await import('@/services/playlist-ops');
const { autoCategorizePlaylists, addTagToPlaylists, deleteTag } = await import('@/db/repo');

const pl = (id: string, title: string, description = '') => ({ id, title, description, privacy: 'private' as const, itemCount: 2, fetchedAt: 1 });
const item = (playlistId: string, videoId: string, position: number, unavailable = 0 as 0 | 1) => ({
  id: `${playlistId}-${position}`,
  playlistId,
  videoId,
  position,
  title: videoId,
  unavailable,
  fetchedAt: 1,
});

beforeEach(async () => {
  Object.values(m).forEach((f) => f.mockReset());
  m.startOp.mockResolvedValue({ op: { id: 'op' }, skipped: 0 });
  m.ensureWriteScope.mockResolvedValue(undefined);
  m.syncPlaylistItems.mockResolvedValue(0);
  await db.playlists.bulkPut([pl('PL1', 'Rust'), pl('PL2', 'Go'), pl('PLt', 'Target')]);
  await db.playlistItems.bulkPut([
    item('PL1', 'aaaaaaaaaaa', 0),
    item('PL1', 'bbbbbbbbbbb', 1),
    item('PL2', 'bbbbbbbbbbb', 0), // duplicate across sources
    item('PL2', 'ccccccccccc', 1, 1), // deleted video
    item('PL2', 'ddddddddddd', 2),
  ]);
});

describe('mergePlaylists', () => {
  it('collects unique available videos in order and excludes the target from the sources', async () => {
    await mergePlaylists({ sourceIds: ['PL1', 'PL2', 'PLt'], target: { id: 'PLt' }, deleteSources: true, skipDuplicates: true });
    const arg = m.startOp.mock.calls[0]![0];
    expect(arg).toMatchObject({ kind: 'merge', destPlaylistId: 'PLt', skipDuplicates: true, deleteSourceIds: ['PL1', 'PL2'] });
    expect(arg.items.map((i: { videoId: string }) => i.videoId)).toEqual(['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ddddddddddd']);
    expect(m.syncPlaylistItems).toHaveBeenCalledTimes(2); // fresh contents of each source
  });

  it('can merge into a brand-new playlist', async () => {
    m.createPlaylistAndCache.mockResolvedValue(pl('PLnew', 'Combined'));
    await mergePlaylists({ sourceIds: ['PL1'], target: { create: { title: 'Combined', description: '', privacy: 'private' } }, deleteSources: false, skipDuplicates: true });
    expect(m.startOp.mock.calls[0]![0]).toMatchObject({ destPlaylistId: 'PLnew', deleteSourceIds: undefined });
  });

  it('requires a source other than the target', async () => {
    await expect(mergePlaylists({ sourceIds: ['PLt'], target: { id: 'PLt' }, deleteSources: false, skipDuplicates: true })).rejects.toThrow(/at least one/);
  });
});

describe('deletePlaylists', () => {
  it('creates one pl-delete op for the selected playlists', async () => {
    await deletePlaylists(['PL1', 'PL2', 'PL1']);
    expect(m.startOp.mock.calls[0]![0]).toMatchObject({ kind: 'pl-delete', items: [{ targetPlaylistId: 'PL1' }, { targetPlaylistId: 'PL2' }] });
  });
});

describe('playlist categories (local)', () => {
  it('auto-categorizes playlists by title/description and reuses categories', async () => {
    await db.playlists.bulkPut([pl('PLa', 'Python coding tutorials'), pl('PLb', 'Lofi music for study', 'chill beats songs')]);
    const n = await autoCategorizePlaylists(['PLa', 'PLb'], true);
    expect(n).toBe(2);
    const tags = await db.tags.toArray();
    const nameOf = async (pid: string) =>
      (await db.playlistTags.where('playlistId').equals(pid).toArray()).map((t) => tags.find((x) => x.id === t.tagId)?.name);
    expect(await nameOf('PLa')).toContain('Programming');
    expect(await nameOf('PLb')).toContain('Music');
    // second run with onlyUncategorized does nothing
    expect(await autoCategorizePlaylists(['PLa', 'PLb'], true)).toBe(0);
  });

  it('deleting a category also removes it from playlists', async () => {
    await db.tags.put({ id: 't1', name: 'X', emoji: '📁', order: 1 });
    await addTagToPlaylists('t1', ['PL1']);
    await deleteTag('t1');
    expect(await db.playlistTags.count()).toBe(0);
  });
});
