import { z } from 'zod';
import { dropCachedToken, getToken } from './auth';
import { recordUsage } from './quota';
import { QUOTA_COST } from '@/config/constants';

/**
 * Thin client for the handful of YouTube Data API v3 methods we use.
 * Only the service worker imports this module.
 */
const BASE = 'https://www.googleapis.com/youtube/v3';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public reason?: string,
  ) {
    super(message);
  }
  get isQuota() {
    return ['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded'].includes(
      this.reason ?? '',
    );
  }
}

export interface CallOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  params?: Record<string, string | undefined>;
  body?: unknown;
  write?: boolean;
  cost: number;
}

export async function call<T>(resource: string, opts: CallOpts): Promise<T> {
  const url = new URL(`${BASE}/${resource}`);
  for (const [k, v] of Object.entries(opts.params ?? {})) if (v !== undefined) url.searchParams.set(k, v);

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(false, opts.write);
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    // Every request costs quota, even failed ones.
    await recordUsage(opts.cost, !!opts.write && opts.method !== 'GET');
    if (res.status === 401 && attempt === 0) {
      await dropCachedToken(token); // expired — Chrome will mint a fresh one
      continue;
    }
    if (res.status === 204) return undefined as T;
    const json: unknown = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = (json as { error?: { message?: string; errors?: { reason?: string }[] } }).error;
      throw new ApiError(err?.message ?? `HTTP ${res.status}`, res.status, err?.errors?.[0]?.reason);
    }
    return json as T;
  }
  throw new ApiError('Authorization failed', 401);
}

// ---------- Response schemas (API data is untrusted input) ----------
const Thumbs = z
  .object({
    default: z.object({ url: z.string() }).optional(),
    medium: z.object({ url: z.string() }).optional(),
  })
  .partial()
  .optional();

const SubscriptionItem = z.object({
  id: z.string(),
  snippet: z.object({
    title: z.string().max(500),
    publishedAt: z.string().optional(),
    resourceId: z.object({ channelId: z.string() }),
    thumbnails: Thumbs,
  }),
  contentDetails: z.object({ totalItemCount: z.number().optional() }).partial().optional(),
});
export type SubscriptionItem = z.infer<typeof SubscriptionItem>;

const SubscriptionsPage = z.object({
  nextPageToken: z.string().optional(),
  items: z.array(SubscriptionItem).default([]),
});

const ChannelItem = z.object({
  id: z.string(),
  snippet: z.object({ title: z.string().max(500), thumbnails: Thumbs }).optional(),
});
const ChannelsPage = z.object({ items: z.array(ChannelItem).default([]) });

const VideoItem = z.object({
  id: z.string(),
  snippet: z.object({ channelId: z.string(), channelTitle: z.string().max(500).optional() }),
});
const VideosPage = z.object({ items: z.array(VideoItem).default([]) });

const ChannelSignalsItem = z.object({
  id: z.string(),
  snippet: z.object({ title: z.string().max(500), description: z.string().max(10_000).optional() }).optional(),
  topicDetails: z.object({ topicCategories: z.array(z.string().max(300)).max(50).optional() }).optional(),
  brandingSettings: z.object({ channel: z.object({ keywords: z.string().max(2000).optional() }).partial().optional() }).optional(),
});
export type ChannelSignalsItem = z.infer<typeof ChannelSignalsItem>;

// ---------- Methods ----------
export async function listMySubscriptionsPage(pageToken?: string) {
  const raw = await call<unknown>('subscriptions', {
    params: { part: 'snippet,contentDetails', mine: 'true', maxResults: '50', order: 'alphabetical', pageToken },
    cost: QUOTA_COST.list,
  });
  return SubscriptionsPage.parse(raw);
}

export async function getMyChannel() {
  const raw = await call<unknown>('channels', { params: { part: 'snippet', mine: 'true' }, cost: QUOTA_COST.list });
  return ChannelsPage.parse(raw).items[0];
}

/** ≤50 ids per call. */
export async function getChannels(ids: string[]) {
  const raw = await call<unknown>('channels', {
    params: { part: 'snippet', id: ids.slice(0, 50).join(','), maxResults: '50' },
    cost: QUOTA_COST.list,
  });
  return ChannelsPage.parse(raw).items;
}

/**
 * Categorization signals for ≤50 channels in ONE call (1 quota unit): description, YouTube's topic
 * categories and channel keywords. Used transiently to suggest categories — not stored.
 */
export async function getChannelSignals(ids: string[]) {
  const raw = await call<unknown>('channels', {
    params: { part: 'snippet,topicDetails,brandingSettings', id: ids.slice(0, 50).join(','), maxResults: '50' },
    cost: QUOTA_COST.list,
  });
  return z.object({ items: z.array(ChannelSignalsItem).default([]) }).parse(raw).items;
}

/** ≤50 ids per call. Used only to map videoId → channelId (no titles are stored). */
export async function getVideosChannel(ids: string[]) {
  const raw = await call<unknown>('videos', {
    params: { part: 'snippet', id: ids.slice(0, 50).join(','), maxResults: '50' },
    cost: QUOTA_COST.list,
  });
  return VideosPage.parse(raw).items;
}

export async function deleteSubscription(subscriptionId: string): Promise<void> {
  await call<void>('subscriptions', {
    method: 'DELETE',
    params: { id: subscriptionId },
    write: true,
    cost: QUOTA_COST.subscriptionsDelete,
  });
}

export async function insertSubscription(channelId: string): Promise<{ id: string }> {
  const raw = await call<unknown>('subscriptions', {
    method: 'POST',
    params: { part: 'snippet' },
    body: { snippet: { resourceId: { kind: 'youtube#channel', channelId } } },
    write: true,
    cost: QUOTA_COST.subscriptionsInsert,
  });
  return z.object({ id: z.string() }).parse(raw);
}

export const pickThumb = (t: z.infer<typeof Thumbs>) => t?.medium?.url ?? t?.default?.url;
