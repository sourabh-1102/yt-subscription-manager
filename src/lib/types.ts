/** Where a channel record came from. Only `api` records are subject to the 30-day TTL. */
export type ChannelSource = 'api' | 'takeout' | 'watch' | 'demo';

export interface Channel {
  /** YouTube channel id (UC…). */
  id: string;
  title: string;
  thumbnailUrl?: string;
  /** 1 = currently subscribed, 0 = not (Dexie can't index booleans). */
  subscribed: 0 | 1;
  /** subscriptions resource id — required for subscriptions.delete. Only present for `api` source. */
  subscriptionId?: string;
  subscribedAt?: number;
  /** Total public uploads reported by subscriptions.contentDetails (displayed raw, never scored). */
  videoCount?: number;
  source: ChannelSource;
  /** When the API metadata was last fetched (TTL anchor). */
  fetchedAt?: number;
  lastUploadAt?: number;
  lastUploadCheckedAt?: number;
}

export interface Tag {
  id: string;
  name: string;
  emoji: string;
  order: number;
}

export interface ChannelTag {
  channelId: string;
  tagId: string;
}

export type BellIntent = 'all' | 'personalized' | 'none';

export interface ChannelFlags {
  channelId: string;
  favorite?: 0 | 1;
  reviewLater?: 0 | 1;
  note?: string;
  /** Bell audit: what the user wants the bell to be (local only — the API cannot read or set it). */
  bellIntent?: BellIntent;
  /** Bell audit: user has set it on YouTube. */
  bellDone?: 0 | 1;
}

export type WatchSource = 'tracked' | 'takeout' | 'demo';

export interface WatchEvent {
  /** `${videoId}:${YYYY-MM-DD}` — one watch per video per day. */
  id: string;
  videoId: string;
  channelId: string;
  watchedAt: number;
  source: WatchSource;
}

/** A tracked video whose channel is not known yet (resolved later via videos.list). */
export interface PendingVideo {
  videoId: string;
  watchedAt: number;
}

export type BatchKind = 'unsubscribe' | 'resubscribe';
export type BatchStatus = 'running' | 'paused-quota' | 'stopped' | 'done';

export interface Batch {
  id: string;
  kind: BatchKind;
  channelIds: string[];
  confirmedAt: number;
  status: BatchStatus;
  /** Set when paused because of the daily cap / API quota. */
  resumeAfter?: number;
  lastError?: string;
}

export type UnsubStatus = 'pending' | 'unsubscribed' | 'failed' | 'resubscribed' | 'resubscribe-pending' | 'resubscribe-failed';

/** One row per channel per unsubscribe batch. Backs the Unsubscribed dashboard. */
export interface UnsubscribedEntry {
  /** `${batchId}:${channelId}` */
  id: string;
  batchId: string;
  channelId: string;
  title: string;
  thumbnailUrl?: string;
  oldSubscriptionId: string;
  tagIds: string[];
  flags?: Omit<ChannelFlags, 'channelId'>;
  queuedAt: number;
  doneAt?: number;
  status: UnsubStatus;
  error?: string;
  /** For re-subscribe batches: which batch is re-subscribing this entry. */
  resubBatchId?: string;
}

export interface Prefs {
  trackingEnabled: boolean;
  /** Seconds of actual playback before a video counts as watched. */
  dwellSeconds: number;
  /** 0 = keep forever. */
  retentionDays: number;
  excludedChannelIds: string[];
  theme: 'system' | 'light' | 'dark';
  /** "Inactive" = not watched for this many days. */
  inactiveDays: number;
  /** When tracking was first enabled — analytics cover data from this point on. */
  trackingStartedAt?: number;
  onboardingDone: boolean;
  /** Automatically categorize newly synced subscriptions. */
  autoCategorizeNew: boolean;
}

export interface AuthState {
  signedIn: boolean;
  accountChannelId?: string;
  accountTitle?: string;
  hasWriteScope: boolean;
  lastSyncAt?: number;
  lastSyncError?: string;
  syncing: boolean;
  clientIdConfigured: boolean;
}

// ================= Playlist Manager =================
export type PlaylistPrivacy = 'public' | 'unlisted' | 'private';

/** One of the user's own playlists (API data → fetchedAt drives the 30-day TTL). */
export interface Playlist {
  id: string;
  title: string;
  description: string;
  privacy: PlaylistPrivacy;
  itemCount: number;
  thumbnailUrl?: string;
  /** Creation date (the API does not expose a "last updated" time). */
  publishedAt?: number;
  fetchedAt: number;
  /** When the items of this playlist were last fetched completely. */
  itemsFetchedAt?: number;
}

export interface PlaylistItem {
  /** playlistItems resource id (needed to remove/reorder). */
  id: string;
  playlistId: string;
  videoId: string;
  position: number;
  title: string;
  channelTitle?: string;
  channelId?: string;
  thumbnailUrl?: string;
  /** ISO 8601 duration, e.g. PT12M3S. */
  duration?: string;
  videoPublishedAt?: number;
  addedAt?: number;
  /** Private / deleted videos. */
  unavailable?: 0 | 1;
  fetchedAt: number;
}

/** Watch Later entry — the list comes from a Google Takeout import (the API cannot read WL). */
export interface WatchLaterItem {
  videoId: string;
  addedAt?: number;
  title?: string;
  channelTitle?: string;
  channelId?: string;
  thumbnailUrl?: string;
  duration?: string;
  publishedAt?: number;
  unavailable?: 0 | 1;
  /** Where this row came from: a Takeout snapshot, or read live from the YouTube Watch Later page. */
  source?: 'takeout' | 'live';
  /** Hidden in this extension only (YouTube's Watch Later is unchanged). */
  hidden?: 0 | 1;
  /** Set when title/channel/etc. came from videos.list (API data → 30-day TTL). */
  fetchedAt?: number;
  importedAt: number;
}

/**
 * add/remove/move: playlist items via the official API.
 * pl-delete: delete whole playlists (API). merge: add videos into a target playlist (API), then
 * optionally delete the source playlists only if every add succeeded.
 * wl-remove: remove from the REAL Watch Later via YouTube's own website UI (no API exists).
 * wl-move: add to a playlist via the API, confirm, THEN remove from Watch Later via the website UI.
 */
export type BulkOpKind = 'add' | 'remove' | 'move' | 'pl-delete' | 'merge' | 'wl-remove' | 'wl-move';
export type BulkOpStatus = 'running' | 'paused-quota' | 'stopped' | 'done';
export type BulkItemStatus = 'pending' | 'done' | 'failed' | 'skipped';

/** A persisted, resumable bulk playlist operation. */
export interface BulkOp {
  id: string;
  kind: BulkOpKind;
  label: string;
  sourcePlaylistId?: string;
  destPlaylistId?: string;
  createdAt: number;
  status: BulkOpStatus;
  resumeAfter?: number;
  lastError?: string;
  /** merge: playlists to delete after a fully successful merge. */
  deleteSourceIds?: string[];
  /** Human summary written when the op finishes (e.g. merge follow-up result). */
  resultNote?: string;
}

export interface BulkOpItem {
  /** `${opId}:${index}` */
  id: string;
  opId: string;
  index: number;
  videoId: string;
  title?: string;
  /** Source playlistItem id (remove / move). */
  playlistItemId?: string;
  /** pl-delete: the playlist to delete. */
  targetPlaylistId?: string;
  /** Restores: the deletion-log entry this item restores (marked restored on success). */
  logId?: string;
  status: BulkItemStatus;
  /** Move: the add step already succeeded (so a retry never adds twice). */
  added?: 0 | 1;
  error?: string;
}

/** Local category (reuses the channel categories) assigned to a playlist. Never sent to YouTube. */
export interface PlaylistTag {
  playlistId: string;
  tagId: string;
}

// ================= Deleted items (history) =================
export type DeletionKind = 'playlist-video' | 'playlist' | 'watch-later' | 'category';

export interface DeletedVideoInfo {
  videoId: string;
  title?: string;
  channelTitle?: string;
}

/**
 * One deleted/removed thing. Logged right before (or right after a verified) removal, so the user
 * can see what changed and restore it where YouTube allows. Unsubscribed channels are tracked in
 * the existing `unsubscribed` table (not duplicated here).
 */
export interface DeletionLogEntry {
  id: string;
  kind: DeletionKind;
  at: number;
  /** Bulk operation that did it (if any). */
  opId?: string;
  /** Free-text context, e.g. "Moved to Programming" or "Merged into Rust + Go". */
  note?: string;

  // playlist-video / watch-later
  videoId?: string;
  title?: string;
  channelTitle?: string;
  thumbnailUrl?: string;
  playlistId?: string;
  playlistTitle?: string;

  // playlist (deleted playlist snapshot)
  description?: string;
  privacy?: PlaylistPrivacy;
  videos?: DeletedVideoInfo[];

  // category (local)
  tagName?: string;
  tagEmoji?: string;
  channelIds?: string[];
  playlistIds?: string[];

  /** When titles etc. came from YouTube (30-day rule). Unset = user/local data. */
  fetchedAt?: number;
  restoredAt?: number;
  /** Recreated playlist id (playlist restores). */
  restoredTo?: string;
}
