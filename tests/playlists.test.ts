import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/db';
import { getAuthState } from '@/lib/prefs';
import { DAY_MS } from '@/config/constants';

const m = vi.hoisted(() => ({
  listMyPlaylists: vi.fn(),
  listPlaylistItems: vi.fn(),
  getVideos: vi.fn(),
  movePlaylistItem: vi.fn(),
  createPlaylist: vi.fn(),
  deletePlaylist: vi.fn(),
  getTokenDetails: vi.fn(),
}));
vi.mock('@/services/playlist-api', async (orig) => ({ ...(await orig<typeof import('@/services/playlist-api')>()), ...m }));
vi.mock('@/services/auth', async (orig) => ({ ...(await orig<typeof import('@/services/auth')>()), getTokenDetails: m.getTokenDetails }));

const svc = await import('@/services/playlists');
const { parseWatchLaterCsv } = await import('@/services/takeout');
const { WL_CAPABILITIES, canDo, extractVideoIds, formatDuration } = await import('@/features/watch-later');
const { validatePlaylistInput } = await import('@/features/playlist-input');

const dto = (id: string, n = 1) => ({ id, title: id, description: '', privacy: 'private' as const, itemCount: n });
const item = (id: string, videoId: string, position: number) => ({ id, videoId, position, title: id, unavailable: false });

beforeEach(() => {
  Object.values(m).forEach((f) => f.mockReset());
  m.getVideos.mockResolvedValue([]);
  m.getTokenDetails.mockResolvedValue({ token: 't', grantedScopes: [] });
});

describe('playlist cache', () => {
  it('sync adds new playlists and drops ones deleted on YouTube (with their items)', async () => {
    await db.playlists.put({ ...dto('OLD'), fetchedAt: 1 });
    await db.playlistItems.put({ id: 'x', playlistId: 'OLD', videoId: 'aaaaaaaaaaa', position: 0, title: '', fetchedAt: 1 });
    m.listMyPlaylists.mockResolvedValue([dto('PL1', 4), dto('PL2')]);
    expect(await svc.syncPlaylists()).toBe(2);
    expect((await db.playlists.toArray()).map((p) => p.id).sort()).toEqual(['PL1', 'PL2']);
    expect(await db.playlistItems.count()).toBe(0);
  });

  it('fetches items with durations and updates the count', async () => {
    await db.playlists.put({ ...dto('PL1', 0), fetchedAt: 1 });
    m.listPlaylistItems.mockResolvedValue([item('i1', 'dQw4w9WgXcQ', 0), item('i2', 'aaaaaaaaaaa', 1)]);
    m.getVideos.mockResolvedValue([{ videoId: 'dQw4w9WgXcQ', title: 'T', duration: 'PT4M' }]);
    await svc.syncPlaylistItems('PL1');
    expect((await db.playlistItems.get('i1'))?.duration).toBe('PT4M');
    expect((await db.playlists.get('PL1'))?.itemCount).toBe(2);
  });

  it('duplicate check uses the destination contents', async () => {
    await db.playlists.put({ ...dto('PL1'), fetchedAt: Date.now(), itemsFetchedAt: Date.now() });
    await db.playlistItems.put({ id: 'i1', playlistId: 'PL1', videoId: 'dQw4w9WgXcQ', position: 0, title: '', fetchedAt: Date.now() });
    expect(await svc.checkDuplicates('PL1', ['dQw4w9WgXcQ', 'aaaaaaaaaaa', 'dQw4w9WgXcQ'])).toEqual(['dQw4w9WgXcQ']);
    expect(m.listPlaylistItems).not.toHaveBeenCalled(); // fresh cache, no API call
  });

  it('reorder updates YouTube first, then re-reads real positions', async () => {
    await db.playlists.put({ ...dto('PL1', 2), fetchedAt: 1 });
    await db.playlistItems.bulkPut([
      { id: 'i1', playlistId: 'PL1', videoId: 'dQw4w9WgXcQ', position: 0, title: 'a', fetchedAt: 1 },
      { id: 'i2', playlistId: 'PL1', videoId: 'aaaaaaaaaaa', position: 1, title: 'b', fetchedAt: 1 },
    ]);
    m.listPlaylistItems.mockResolvedValue([item('i2', 'aaaaaaaaaaa', 0), item('i1', 'dQw4w9WgXcQ', 1)]);
    await svc.reorderItem('PL1', 'i2', 0);
    expect(m.movePlaylistItem).toHaveBeenCalledWith('i2', 'PL1', 'aaaaaaaaaaa', 0);
    expect((await db.playlistItems.get('i2'))?.position).toBe(0);
  });

  it('a failed reorder leaves the cached order untouched', async () => {
    await db.playlistItems.put({ id: 'i1', playlistId: 'PL1', videoId: 'dQw4w9WgXcQ', position: 3, title: 'a', fetchedAt: 1 });
    m.movePlaylistItem.mockRejectedValue(new Error('manualSortRequired'));
    await expect(svc.reorderItem('PL1', 'i1', 0)).rejects.toThrow();
    expect((await db.playlistItems.get('i1'))?.position).toBe(3);
  });

  it('create/delete keep the cache in sync', async () => {
    m.createPlaylist.mockResolvedValue(dto('PLn', 0));
    await svc.createPlaylistAndCache({ title: 'n', description: '', privacy: 'private' });
    expect(await db.playlists.get('PLn')).toBeTruthy();
    await svc.deletePlaylistAndCache('PLn');
    expect(await db.playlists.get('PLn')).toBeUndefined();
  });

  it('enforces the 30-day API data rule but keeps Takeout ids', async () => {
    const old = Date.now() - 31 * DAY_MS;
    await db.playlists.put({ ...dto('PL1'), fetchedAt: old });
    await db.watchLater.put({ videoId: 'dQw4w9WgXcQ', title: 'T', fetchedAt: old, importedAt: 1, addedAt: 5 });
    await svc.enforcePlaylistTtl();
    expect(await db.playlists.count()).toBe(0);
    const w = await db.watchLater.get('dQw4w9WgXcQ');
    expect(w).toMatchObject({ videoId: 'dQw4w9WgXcQ', addedAt: 5 });
    expect(w?.title).toBeUndefined();
  });
});

describe('write permission upgrade', () => {
  it('requests the write scope interactively and records it', async () => {
    await svc.ensureWriteScope();
    expect(m.getTokenDetails).toHaveBeenCalledWith(true, true);
    expect((await getAuthState()).hasWriteScope).toBe(true);
  });
  it('turns a refusal into a clear PlaylistError', async () => {
    m.getTokenDetails.mockRejectedValue(new Error('The user did not approve access.'));
    await expect(svc.ensureWriteScope()).rejects.toMatchObject({ code: 'no-write-scope' });
  });
  it('playlist writes never run without the permission', async () => {
    m.getTokenDetails.mockRejectedValue(new Error('denied'));
    await expect(svc.createPlaylistAndCache({ title: 'n', description: '', privacy: 'private' })).rejects.toThrow(/Permission required/);
    expect(m.createPlaylist).not.toHaveBeenCalled();
  });
});

describe('Watch Later', () => {
  it('capability matrix: nothing via the API; removal only via the website UI', () => {
    expect(canDo('listViaApi')).toBe(false);
    expect(canDo('modifyViaApi')).toBe(false);
    expect(canDo('addToWatchLater')).toBe(false);
    expect(WL_CAPABILITIES.removeViaWebsite).toMatchObject({ supported: true, via: 'website' });
    expect(WL_CAPABILITIES.readLive.via).toBe('website');
    expect(canDo('copyToPlaylist')).toBe(true);
    expect(canDo('importFromTakeout')).toBe(true);
    expect(Object.values(WL_CAPABILITIES).every((c) => c.how.length > 10)).toBe(true);
  });

  it('parses the new Takeout CSV format', () => {
    const csv = 'Video ID,Playlist Video Creation Timestamp\ndQw4w9WgXcQ,2024-01-05T12:00:00+00:00\naaaaaaaaaaa,2023-02-01T00:00:00+00:00\n';
    expect(parseWatchLaterCsv(csv)).toEqual([
      { videoId: 'dQw4w9WgXcQ', addedAt: Date.parse('2024-01-05T12:00:00+00:00') },
      { videoId: 'aaaaaaaaaaa', addedAt: Date.parse('2023-02-01T00:00:00+00:00') },
    ]);
  });

  it('parses the old Takeout CSV format', () => {
    const csv =
      'Playlist Id,Channel Id,Time Created,Time Updated,Title,Description,Visibility\nWL,UC_x5XG1OV2P6uZZ5FSM9Ttw,2015-01-01 00:00:00 UTC,,Watch later,,Private\n\nVideo Id,Time Added\ndQw4w9WgXcQ,2021-05-01 12:00:00 UTC\n';
    expect(parseWatchLaterCsv(csv)).toEqual([{ videoId: 'dQw4w9WgXcQ', addedAt: Date.parse('2021-05-01T12:00:00Z') }]);
  });

  it('rejects files without videos', () => {
    expect(() => parseWatchLaterCsv('a,b\n1,2')).toThrow(/Watch later-videos.csv/);
  });
});

describe('helpers', () => {
  it('extracts video ids from pasted text', () => {
    expect(
      extractVideoIds('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1, https://youtu.be/aaaaaaaaaaa\nhttps://www.youtube.com/shorts/bbbbbbbbbbb ccccccccccc'),
    ).toEqual(['dQw4w9WgXcQ', 'aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']);
  });
  it('formats durations', () => {
    expect(formatDuration('PT4M5S')).toBe('4:05');
    expect(formatDuration('PT1H2M3S')).toBe('1:02:03');
    expect(formatDuration('P0D')).toBe('Live');
  });
  it('validates playlist names', () => {
    expect(validatePlaylistInput({ title: ' ', description: '' })).toMatch(/required/);
    expect(validatePlaylistInput({ title: 'x'.repeat(151), description: '' })).toMatch(/150/);
    expect(validatePlaylistInput({ title: 'ok', description: 'x'.repeat(5001) })).toMatch(/5,000/);
    expect(validatePlaylistInput({ title: 'Good name', description: '' })).toBeNull();
  });
});
