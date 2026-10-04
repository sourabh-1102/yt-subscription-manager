/** YouTube Data API v3 quota costs (verified 2026-10-04, see context.md §3). */
export const QUOTA_COST = {
  list: 1,
  subscriptionsDelete: 50,
  subscriptionsInsert: 50,
} as const;

/** Default project quota per day. Shared by every user of the extension. */
export const PROJECT_DAILY_QUOTA = 10_000;

/**
 * Per-user daily budget for write operations (unsubscribe / re-subscribe), in calls.
 * 40 calls × 50 units = 2,000 units. Raise after the Google API Compliance Audit grants more quota.
 */
export const DAILY_WRITE_CAP = 40;

/** YouTube API Developer Policies III.E.4: refresh or delete API data within 30 days. */
export const API_DATA_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Refresh well before the TTL so data never goes stale. */
export const API_REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** RSS "last upload" refresh: how many channels per background tick, and how stale before re-checking. */
export const RSS_BATCH_SIZE = 40;
export const RSS_RECHECK_MS = 24 * 60 * 60 * 1000;

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Hard limit for imported files (Takeout watch history can be large). */
export const MAX_IMPORT_BYTES = 150 * 1024 * 1024;

/**
 * Per-user daily budget for playlist write calls (50 units each → 7,500 units). The ledger is shared
 * with subscription changes; YouTube's real project quota still applies (ops pause on quotaExceeded).
 */
export const PLAYLIST_DAILY_WRITE_CAP = 150;

export const ALARMS = {
  bulk: 'ysm-bulk',
  sync: 'ysm-sync',
  rss: 'ysm-rss',
  queue: 'ysm-queue',
  maintenance: 'ysm-maintenance',
} as const;
