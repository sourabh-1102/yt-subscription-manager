import { z } from 'zod';
import { call, ApiError } from './youtube-api';
import type { PlaylistPrivacy } from '@/lib/types';

/**
 * Playlist endpoints of the YouTube Data API v3 (verified 2026-10-04):
 *   playlists.list / playlistItems.list / videos.list   1 unit   (scope: youtube.readonly)
 *   playlists.insert|update|delete                      50 units (scope: youtube)
 *   playlistItems.insert|update|delete                  50 units (scope: youtube)
 *   search.list                                         1 call from a separate 100-calls/day project bucket
 * Watch Later (WL) is NOT accessible: list returns empty, insert/delete deprecated (2016/2020).
 */
const COST = { read: 1, write: 50, search: 1 } as const;

const Thumbs = z
  .object({
    default: z.object({ url: z.string() }).optional(),
    medium: z.object({ url: z.string() }).optional(),
    high: z.object({ url: z.string() }).optional(),
  })
  .partial()
  .optional();
const pickThumb = (t: z.infer<typeof Thumbs>) => t?.medium?.url ?? t?.high?.url ?? t?.default?.url;
const ts = (s?: string) => (s ? Date.parse(s) || undefined : undefined);

const PlaylistRes = z.object({
  id: z.string(),
  snippet: z.object({
    title: z.string().max(500),
    description: z.string().max(10_000).optional(),
    publishedAt: z.string().optional(),
    thumbnails: Thumbs,
  }),
  status: z.object({ privacyStatus: z.enum(['public', 'unlisted', 'private']) }).partial().optional(),
  contentDetails: z.object({ itemCount: z.number() }).partial().optional(),
});

export interface PlaylistDTO {
  id: string;
  title: string;
  description: string;
  privacy: PlaylistPrivacy;
  itemCount: number;
  thumbnailUrl?: string;
  publishedAt?: number;
}

const toPlaylist = (p: z.infer<typeof PlaylistRes>): PlaylistDTO => ({
  id: p.id,
  title: p.snippet.title,
  description: p.snippet.description ?? '',
  privacy: p.status?.privacyStatus ?? 'private',
  itemCount: p.contentDetails?.itemCount ?? 0,
  thumbnailUrl: pickThumb(p.snippet.thumbnails),
  publishedAt: ts(p.snippet.publishedAt),
});

export async function listMyPlaylists(): Promise<PlaylistDTO[]> {
  const out: PlaylistDTO[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const raw = await call<unknown>('playlists', {
      params: { part: 'snippet,status,contentDetails', mine: 'true', maxResults: '50', pageToken },
      cost: COST.read,
    });
    const page = z.object({ nextPageToken: z.string().optional(), items: z.array(PlaylistRes).default([]) }).parse(raw);
    out.push(...page.items.map(toPlaylist));
    pageToken = page.nextPageToken;
  } while (pageToken && ++pages < 100);
  return out;
}

export interface PlaylistInput {
  title: string;
  description: string;
  privacy: PlaylistPrivacy;
}

export const PlaylistInputSchema = z.object({
  title: z.string().trim().min(1, 'Name is required').max(150, 'Name must be 150 characters or fewer'),
  description: z.string().max(5000, 'Description must be 5,000 characters or fewer'),
  privacy: z.enum(['public', 'unlisted', 'private']),
});

const body = (i: PlaylistInput) => ({
  snippet: { title: i.title.trim(), description: i.description },
  status: { privacyStatus: i.privacy },
});

export async function createPlaylist(i: PlaylistInput): Promise<PlaylistDTO> {
  const raw = await call<unknown>('playlists', {
    method: 'POST',
    params: { part: 'snippet,status,contentDetails' },
    body: body(i),
    write: true,
    cost: COST.write,
  });
  return toPlaylist(PlaylistRes.parse(raw));
}

export async function updatePlaylist(id: string, i: PlaylistInput): Promise<PlaylistDTO> {
  const raw = await call<unknown>('playlists', {
    method: 'PUT',
    params: { part: 'snippet,status' },
    body: { id, ...body(i) },
    write: true,
    cost: COST.write,
  });
  return toPlaylist(PlaylistRes.parse(raw));
}

export async function deletePlaylist(id: string): Promise<void> {
  await call<void>('playlists', { method: 'DELETE', params: { id }, write: true, cost: COST.write });
}

// ---------- Items ----------
const ItemRes = z.object({
  id: z.string(),
  snippet: z.object({
    title: z.string().max(500),
    position: z.number().optional(),
    publishedAt: z.string().optional(),
    thumbnails: Thumbs,
    videoOwnerChannelTitle: z.string().max(500).optional(),
    videoOwnerChannelId: z.string().max(64).optional(),
    resourceId: z.object({ videoId: z.string().max(20) }),
  }),
  contentDetails: z.object({ videoPublishedAt: z.string().optional() }).partial().optional(),
  status: z.object({ privacyStatus: z.string().optional() }).partial().optional(),
});

export interface PlaylistItemDTO {
  id: string;
  videoId: string;
  position: number;
  title: string;
  channelTitle?: string;
  channelId?: string;
  thumbnailUrl?: string;
  videoPublishedAt?: number;
  addedAt?: number;
  unavailable: boolean;
}

const toItem = (it: z.infer<typeof ItemRes>, fallbackPos: number): PlaylistItemDTO => {
  const unavailable =
    !it.snippet.videoOwnerChannelId && /^(Deleted|Private) video$/i.test(it.snippet.title.trim());
  return {
    id: it.id,
    videoId: it.snippet.resourceId.videoId,
    position: it.snippet.position ?? fallbackPos,
    title: it.snippet.title,
    channelTitle: it.snippet.videoOwnerChannelTitle,
    channelId: it.snippet.videoOwnerChannelId,
    thumbnailUrl: pickThumb(it.snippet.thumbnails),
    videoPublishedAt: ts(it.contentDetails?.videoPublishedAt),
    addedAt: ts(it.snippet.publishedAt),
    unavailable,
  };
};

/** All items of a playlist (1 unit per 50 items). */
export async function listPlaylistItems(playlistId: string): Promise<PlaylistItemDTO[]> {
  const out: PlaylistItemDTO[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const raw = await call<unknown>('playlistItems', {
      params: { part: 'snippet,contentDetails,status', playlistId, maxResults: '50', pageToken },
      cost: COST.read,
    });
    const page = z.object({ nextPageToken: z.string().optional(), items: z.array(ItemRes).default([]) }).parse(raw);
    page.items.forEach((it) => out.push(toItem(it, out.length)));
    pageToken = page.nextPageToken;
  } while (pageToken && ++pages < 400);
  return out;
}

export async function insertPlaylistItem(playlistId: string, videoId: string): Promise<{ id: string }> {
  const raw = await call<unknown>('playlistItems', {
    method: 'POST',
    params: { part: 'snippet' },
    body: { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } },
    write: true,
    cost: COST.write,
  });
  return z.object({ id: z.string() }).parse(raw);
}

export async function deletePlaylistItem(playlistItemId: string): Promise<void> {
  await call<void>('playlistItems', { method: 'DELETE', params: { id: playlistItemId }, write: true, cost: COST.write });
}

/** Reorder: requires the playlist to use Manual sorting (else 400 manualSortRequired). */
export async function movePlaylistItem(itemId: string, playlistId: string, videoId: string, position: number): Promise<void> {
  await call<unknown>('playlistItems', {
    method: 'PUT',
    params: { part: 'snippet' },
    body: { id: itemId, snippet: { playlistId, position, resourceId: { kind: 'youtube#video', videoId } } },
    write: true,
    cost: COST.write,
  });
}

// ---------- Videos ----------
const VideoRes = z.object({
  id: z.string(),
  snippet: z
    .object({
      title: z.string().max(500),
      channelTitle: z.string().max(500).optional(),
      channelId: z.string().max(64).optional(),
      publishedAt: z.string().optional(),
      thumbnails: Thumbs,
    })
    .optional(),
  contentDetails: z.object({ duration: z.string().max(40).optional() }).partial().optional(),
});

export interface VideoDTO {
  videoId: string;
  title: string;
  channelTitle?: string;
  channelId?: string;
  thumbnailUrl?: string;
  duration?: string;
  publishedAt?: number;
}

/** Video details for ≤50 ids per call (1 unit). Unknown/private ids are simply missing from the result. */
export async function getVideos(ids: string[]): Promise<VideoDTO[]> {
  const out: VideoDTO[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const raw = await call<unknown>('videos', {
      params: { part: 'snippet,contentDetails', id: ids.slice(i, i + 50).join(','), maxResults: '50' },
      cost: COST.read,
    });
    for (const v of z.object({ items: z.array(VideoRes).default([]) }).parse(raw).items) {
      out.push({
        videoId: v.id,
        title: v.snippet?.title ?? '',
        channelTitle: v.snippet?.channelTitle,
        channelId: v.snippet?.channelId,
        thumbnailUrl: pickThumb(v.snippet?.thumbnails),
        duration: v.contentDetails?.duration,
        publishedAt: ts(v.snippet?.publishedAt),
      });
    }
  }
  return out;
}

/** search.list — separate 100-calls/day project bucket. One call per search. */
export async function searchVideos(q: string): Promise<string[]> {
  const raw = await call<unknown>('search', {
    params: { part: 'id', q: q.slice(0, 200), type: 'video', maxResults: '25', safeSearch: 'none' },
    cost: COST.search,
  });
  return z
    .object({ items: z.array(z.object({ id: z.object({ videoId: z.string().optional() }) })).default([]) })
    .parse(raw)
    .items.map((i) => i.id.videoId)
    .filter((x): x is string => !!x);
}

// ---------- Human-readable errors ----------
export function humanizeError(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.reason) {
      case 'quotaExceeded':
      case 'dailyLimitExceeded':
        return 'YouTube API quota limit reached. Try again after midnight Pacific time.';
      case 'rateLimitExceeded':
      case 'userRateLimitExceeded':
        return 'Too many requests — YouTube asked us to slow down. Retry in a minute.';
      case 'playlistNotFound':
        return 'Playlist no longer exists.';
      case 'videoNotFound':
        return 'Video is unavailable (deleted or private).';
      case 'playlistItemNotFound':
        return 'This video is no longer in the playlist.';
      case 'manualSortRequired':
        return 'This playlist is sorted automatically. On YouTube, set the playlist’s sorting to “Manual”, then try again.';
      case 'playlistContainsMaximumNumberOfVideos':
        return 'The destination playlist is full (5,000 videos).';
      case 'playlistOperationUnsupported':
        return 'YouTube does not allow this change for this playlist.';
      case 'insufficientPermissions':
      case 'forbidden':
      case 'playlistItemsNotAccessible':
        return 'Permission required — allow “Manage your YouTube account” and try again.';
      case 'invalidPlaylistItemPosition':
        return 'That position is not valid for this playlist.';
    }
    if (e.status === 401) return 'Your Google session expired. Reconnect in Settings.';
    if (e.status === 404) return 'Not found — it may have been deleted on YouTube.';
    if (e.status >= 500) return 'YouTube had a temporary problem. Retry in a moment.';
    return 'YouTube rejected the request.';
  }
  if (e instanceof TypeError) return 'Network connection lost.';
  const msg = e instanceof Error ? e.message : String(e);
  return msg.slice(0, 200);
}
