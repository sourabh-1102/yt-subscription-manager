import { z } from 'zod';

/**
 * Typed message contract. Everything arriving at the service worker is validated with these
 * schemas — content-script messages in particular are untrusted.
 */
const VideoId = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
const ChannelId = z.string().regex(/^UC[A-Za-z0-9_-]{22}$/);

/** Sent by the youtube.com content script. Only ids + time; nothing else leaves the page. */
export const ContentMessage = z.object({
  type: z.literal('watch/observed'),
  videoId: VideoId,
  channelId: ChannelId.optional(),
  /** Display name of the channel as shown on the page (used to match a subscription locally). */
  channelName: z.string().max(200).optional(),
});
export type ContentMessage = z.infer<typeof ContentMessage>;

const PlaylistId = z.string().regex(/^[A-Za-z0-9_-]{2,64}$/);
const PlaylistInput = z.object({
  title: z.string().trim().min(1).max(150),
  description: z.string().max(5000),
  privacy: z.enum(['public', 'unlisted', 'private']),
});

/** Sent by extension pages (dashboard). */
export const UiMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('meta/ping') }),
  z.object({ type: z.literal('auth/signIn') }),
  z.object({ type: z.literal('auth/signOut'), deleteApiData: z.boolean() }),
  z.object({ type: z.literal('sync/run') }),
  z.object({ type: z.literal('rss/run') }),
  z.object({ type: z.literal('watch/resolvePending') }),
  z.object({ type: z.literal('categorize/suggest'), ids: z.array(z.string().max(64)).min(1).max(20_000) }),
  // ---- Playlist Manager ----
  z.object({ type: z.literal('pl/sync') }),
  z.object({ type: z.literal('pl/items'), playlistId: PlaylistId }),
  z.object({ type: z.literal('pl/create'), input: PlaylistInput }),
  z.object({ type: z.literal('pl/update'), id: PlaylistId, input: PlaylistInput }),
  z.object({ type: z.literal('pl/delete'), id: PlaylistId }),
  z.object({ type: z.literal('pl/reorder'), playlistId: PlaylistId, itemId: z.string().max(200), position: z.number().int().min(0).max(5000) }),
  z.object({ type: z.literal('pl/duplicates'), playlistId: PlaylistId, videoIds: z.array(VideoId).max(5000) }),
  z.object({ type: z.literal('pl/lookup'), ids: z.array(VideoId).min(1).max(500) }),
  z.object({ type: z.literal('pl/search'), q: z.string().trim().min(1).max(200) }),
  z.object({ type: z.literal('wl/enrich') }),
  z.object({ type: z.literal('pl/deleteMany'), ids: z.array(PlaylistId).min(1).max(500) }),
  z.object({
    type: z.literal('pl/merge'),
    sourceIds: z.array(PlaylistId).min(1).max(200),
    target: z.union([z.object({ id: PlaylistId }), z.object({ create: PlaylistInput })]),
    deleteSources: z.boolean(),
    skipDuplicates: z.boolean(),
  }),
  // Live Watch Later (YouTube website UI — only on explicit, confirmed user requests)
  z.object({ type: z.literal('wl/status') }),
  z.object({ type: z.literal('wl/open') }),
  z.object({ type: z.literal('wl/refreshLive') }),
  z.object({
    type: z.literal('wl/remove'),
    items: z.array(z.object({ videoId: VideoId, title: z.string().max(500).optional() })).min(1).max(5000),
    confirmed: z.literal(true),
  }),
  z.object({
    type: z.literal('wl/move'),
    items: z.array(z.object({ videoId: VideoId, title: z.string().max(500).optional() })).min(1).max(5000),
    destPlaylistId: PlaylistId,
    skipDuplicates: z.boolean(),
    confirmed: z.literal(true),
  }),
  z.object({
    type: z.literal('op/start'),
    kind: z.enum(['add', 'remove', 'move']),
    label: z.string().max(200),
    sourcePlaylistId: PlaylistId.optional(),
    destPlaylistId: PlaylistId.optional(),
    skipDuplicates: z.boolean().default(true),
    items: z
      .array(z.object({ videoId: VideoId, playlistItemId: z.string().max(200).optional(), title: z.string().max(500).optional() }))
      .min(1)
      .max(5000),
  }),
  z.object({ type: z.literal('trash/restoreVideos'), ids: z.array(z.string().max(64)).min(1).max(5000) }),
  z.object({ type: z.literal('trash/recreatePlaylist'), id: z.string().max(64) }),
  z.object({ type: z.literal('op/stop'), id: z.string().max(64) }),
  z.object({ type: z.literal('op/resume'), id: z.string().max(64) }),
  z.object({ type: z.literal('op/retry'), id: z.string().max(64) }),
  z.object({
    type: z.literal('queue/start'),
    kind: z.enum(['unsubscribe', 'resubscribe']),
    /** unsubscribe: channel ids. resubscribe: unsubscribed-entry ids. */
    ids: z.array(z.string().max(120)).min(1).max(5000),
    /** The literal text of the confirmation the user ticked (stored for the audit trail). */
    confirmed: z.literal(true),
  }),
  z.object({ type: z.literal('queue/stop'), batchId: z.string() }),
  z.object({ type: z.literal('queue/retryFailed'), batchId: z.string() }),
]);
export type UiMessage = z.infer<typeof UiMessage>;

export type MessageResult<T = unknown> = { ok: true; data?: T } | { ok: false; error: string; code?: string };
