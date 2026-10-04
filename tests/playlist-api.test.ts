import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/auth', async (orig) => ({
  ...(await orig<typeof import('@/services/auth')>()),
  getToken: vi.fn(async () => 'tok'),
}));

const api = await import('@/services/playlist-api');
const { ApiError } = await import('@/services/youtube-api');

type Call = { url: URL; method: string; body?: unknown; auth?: string };
let calls: Call[];
let responses: { status?: number; json: unknown }[];

beforeEach(() => {
  calls = [];
  responses = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: URL, init: RequestInit) => {
      calls.push({
        url: new URL(String(url)),
        method: init.method ?? 'GET',
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        auth: (init.headers as Record<string, string>).Authorization,
      });
      const r = responses.shift() ?? { json: {} };
      const status = r.status ?? 200;
      return { ok: status < 400, status, json: async () => r.json } as Response;
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const pl = (id: string, title: string, n = 3, privacy = 'public') => ({
  id,
  snippet: { title, description: 'd', publishedAt: '2024-01-01T00:00:00Z', thumbnails: { medium: { url: 'https://i.ytimg.com/x.jpg' } } },
  status: { privacyStatus: privacy },
  contentDetails: { itemCount: n },
});

describe('playlists', () => {
  it('lists all pages of my playlists', async () => {
    responses.push({ json: { nextPageToken: 'p2', items: [pl('PL1', 'A')] } }, { json: { items: [pl('PL2', 'B', 9, 'private')] } });
    const r = await api.listMyPlaylists();
    expect(r.map((p) => [p.id, p.privacy, p.itemCount])).toEqual([
      ['PL1', 'public', 3],
      ['PL2', 'private', 9],
    ]);
    expect(calls[0]!.url.searchParams.get('mine')).toBe('true');
    expect(calls[1]!.url.searchParams.get('pageToken')).toBe('p2');
    expect(calls[0]!.auth).toBe('Bearer tok');
  });

  it('creates, updates and deletes with the right methods and bodies', async () => {
    responses.push({ json: pl('PLn', 'New', 0, 'unlisted') }, { json: pl('PLn', 'Renamed') }, { status: 204, json: undefined });
    const created = await api.createPlaylist({ title: '  New ', description: 'x', privacy: 'unlisted' });
    expect(created).toMatchObject({ id: 'PLn', privacy: 'unlisted' });
    expect(calls[0]).toMatchObject({ method: 'POST', body: { snippet: { title: 'New', description: 'x' }, status: { privacyStatus: 'unlisted' } } });
    await api.updatePlaylist('PLn', { title: 'Renamed', description: '', privacy: 'public' });
    expect(calls[1]).toMatchObject({ method: 'PUT', body: { id: 'PLn' } });
    await api.deletePlaylist('PLn');
    expect(calls[2]!.method).toBe('DELETE');
    expect(calls[2]!.url.searchParams.get('id')).toBe('PLn');
  });

  it('validates playlist input', async () => {
    expect(api.PlaylistInputSchema.safeParse({ title: ' ', description: '', privacy: 'public' }).success).toBe(false);
    expect(api.PlaylistInputSchema.safeParse({ title: 'x'.repeat(151), description: '', privacy: 'public' }).success).toBe(false);
    expect(api.PlaylistInputSchema.safeParse({ title: 'ok', description: '', privacy: 'secret' }).success).toBe(false);
  });
});

describe('playlist items', () => {
  it('lists items and flags deleted/private videos', async () => {
    responses.push({
      json: {
        items: [
          { id: 'i1', snippet: { title: 'Video', position: 0, resourceId: { videoId: 'dQw4w9WgXcQ' }, videoOwnerChannelTitle: 'Ch', videoOwnerChannelId: 'UC_x5XG1OV2P6uZZ5FSM9Ttw' } },
          { id: 'i2', snippet: { title: 'Deleted video', position: 1, resourceId: { videoId: 'aaaaaaaaaaa' } } },
        ],
      },
    });
    const items = await api.listPlaylistItems('PL1');
    expect(items.map((i) => [i.id, i.position, i.unavailable])).toEqual([
      ['i1', 0, false],
      ['i2', 1, true],
    ]);
  });

  it('insert / delete / reorder send the documented bodies', async () => {
    responses.push({ json: { id: 'new' } }, { status: 204, json: undefined }, { json: {} });
    expect(await api.insertPlaylistItem('PL1', 'dQw4w9WgXcQ')).toEqual({ id: 'new' });
    expect(calls[0]).toMatchObject({ method: 'POST', body: { snippet: { playlistId: 'PL1', resourceId: { kind: 'youtube#video', videoId: 'dQw4w9WgXcQ' } } } });
    await api.deletePlaylistItem('i1');
    expect(calls[1]).toMatchObject({ method: 'DELETE' });
    await api.movePlaylistItem('i1', 'PL1', 'dQw4w9WgXcQ', 4);
    expect(calls[2]).toMatchObject({ method: 'PUT', body: { id: 'i1', snippet: { playlistId: 'PL1', position: 4 } } });
  });

  it('reports a playlist without manual sorting as a readable error', async () => {
    responses.push({ status: 400, json: { error: { message: 'x', errors: [{ reason: 'manualSortRequired' }] } } });
    const err = await api.movePlaylistItem('i1', 'PL1', 'dQw4w9WgXcQ', 0).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(api.humanizeError(err)).toMatch(/Manual/);
  });
});

describe('videos & search', () => {
  it('batches videos.list by 50', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `vid${String(i).padStart(8, '0')}`);
    responses.push({ json: { items: [{ id: ids[0], snippet: { title: 'T' }, contentDetails: { duration: 'PT3M' } }] } }, { json: { items: [] } });
    const v = await api.getVideos(ids);
    expect(calls).toHaveLength(2);
    expect(v[0]).toMatchObject({ title: 'T', duration: 'PT3M' });
  });
  it('search returns video ids from one call', async () => {
    responses.push({ json: { items: [{ id: { videoId: 'dQw4w9WgXcQ' } }, { id: {} }] } });
    expect(await api.searchVideos('lofi')).toEqual(['dQw4w9WgXcQ']);
    expect(calls[0]!.url.pathname).toMatch(/search$/);
  });
});

describe('humanizeError', () => {
  it.each([
    [new ApiError('', 403, 'quotaExceeded'), /quota limit/],
    [new ApiError('', 404, 'playlistNotFound'), /no longer exists/],
    [new ApiError('', 403, 'insufficientPermissions'), /Permission required/],
    [new ApiError('', 401), /session expired/],
    [new TypeError('Failed to fetch'), /Network connection lost/],
  ])('%s', (e, re) => {
    expect(api.humanizeError(e)).toMatch(re);
  });
});
