import Dexie, { type EntityTable } from 'dexie';
import type {
  Batch,
  BulkOp,
  BulkOpItem,
  Playlist,
  PlaylistItem,
  WatchLaterItem,
  Channel,
  ChannelFlags,
  ChannelTag,
  PendingVideo,
  PlaylistTag,
  DeletionLogEntry,
  Tag,
  UnsubscribedEntry,
  WatchEvent,
} from '@/lib/types';

/**
 * Single local database (extension origin). Content scripts cannot reach it — they message the
 * service worker instead. Dexie propagates changes across the dashboard tab(s) and the worker,
 * so `useLiveQuery` views update when the background writes.
 */
export class AppDB extends Dexie {
  channels!: EntityTable<Channel, 'id'>;
  tags!: EntityTable<Tag, 'id'>;
  channelTags!: Dexie.Table<ChannelTag, [string, string]>;
  flags!: EntityTable<ChannelFlags, 'channelId'>;
  watchEvents!: EntityTable<WatchEvent, 'id'>;
  pendingVideos!: EntityTable<PendingVideo, 'videoId'>;
  batches!: EntityTable<Batch, 'id'>;
  unsubscribed!: EntityTable<UnsubscribedEntry, 'id'>;
  // Playlist Manager (v2)
  playlists!: EntityTable<Playlist, 'id'>;
  playlistItems!: EntityTable<PlaylistItem, 'id'>;
  watchLater!: EntityTable<WatchLaterItem, 'videoId'>;
  bulkOps!: EntityTable<BulkOp, 'id'>;
  bulkOpItems!: EntityTable<BulkOpItem, 'id'>;
  playlistTags!: Dexie.Table<PlaylistTag, [string, string]>;
  deletionLog!: EntityTable<DeletionLogEntry, 'id'>;

  constructor(name = 'ysm') {
    super(name);
    this.version(1).stores({
      channels: '&id, subscribed, source, fetchedAt, lastUploadCheckedAt',
      tags: '&id, order',
      channelTags: '[channelId+tagId], channelId, tagId',
      flags: '&channelId, favorite, reviewLater',
      watchEvents: '&id, channelId, watchedAt, source, videoId',
      pendingVideos: '&videoId',
      batches: '&id, status',
      unsubscribed: '&id, batchId, channelId, status, doneAt',
    });
    // v2 — additive only: Playlist Manager tables.
    this.version(2).stores({
      playlists: '&id, fetchedAt',
      playlistItems: '&id, playlistId, videoId, [playlistId+position], fetchedAt',
      watchLater: '&videoId, addedAt, hidden, fetchedAt',
      bulkOps: '&id, status, createdAt',
      bulkOpItems: '&id, opId, [opId+status]',
    });
    // v3 — additive: playlist categories + Watch Later source.
    this.version(3).stores({
      playlistTags: '[playlistId+tagId], playlistId, tagId',
      watchLater: '&videoId, addedAt, hidden, fetchedAt, source',
    });
    // v4 — additive: history of deleted/removed items.
    this.version(4).stores({
      deletionLog: '&id, kind, at, playlistId, videoId, opId, fetchedAt',
    });
  }
}

export const db = new AppDB();

export const newId = () => crypto.randomUUID();
