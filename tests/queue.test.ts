import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/db/db';
import { DAILY_WRITE_CAP } from '@/config/constants';

const api = vi.hoisted(() => ({
  deleteSubscription: vi.fn(async (_id: string) => undefined),
  insertSubscription: vi.fn(async (_id: string) => ({ id: 'newsub' })),
}));

vi.mock('@/services/youtube-api', async (orig) => {
  const real = await orig<typeof import('@/services/youtube-api')>();
  return { ...real, ...api };
});
vi.mock('@/services/auth', async (orig) => {
  const real = await orig<typeof import('@/services/auth')>();
  return { ...real, getToken: vi.fn(async () => 'token') };
});

const { startBatch, processQueue, stopBatch, queueTiming } = await import('@/services/queue');
const { ApiError } = await import('@/services/youtube-api');
const { recordUsage } = await import('@/services/quota');

const id = (n: number) => `UC${String(n).padStart(22, '0')}`;

async function seed(n: number) {
  await db.channels.bulkPut(
    Array.from({ length: n }, (_, i) => ({
      id: id(i),
      title: `Channel ${i}`,
      subscribed: 1 as const,
      subscriptionId: `sub${i}`,
      source: 'api' as const,
      fetchedAt: Date.now(),
    })),
  );
  await db.tags.put({ id: 'tag1', name: 'Tech', emoji: '💻', order: 1 });
  await db.channelTags.put({ channelId: id(0), tagId: 'tag1' });
  await db.flags.put({ channelId: id(0), favorite: 1 });
}

beforeEach(() => {
  queueTiming.delayMs = 0;
  api.deleteSubscription.mockReset().mockResolvedValue(undefined);
  api.insertSubscription.mockReset().mockResolvedValue({ id: 'newsub' });
});

describe('unsubscribe queue', () => {
  it('unsubscribes a confirmed batch and archives it with a snapshot', async () => {
    await seed(3);
    const batch = await startBatch('unsubscribe', [id(0), id(1)]);
    await processQueue();
    expect(api.deleteSubscription).toHaveBeenCalledTimes(2);
    expect((await db.channels.get(id(0)))?.subscribed).toBe(0);
    expect((await db.channels.get(id(2)))?.subscribed).toBe(1); // untouched
    const entries = await db.unsubscribed.where('batchId').equals(batch.id).toArray();
    expect(entries.map((e) => e.status)).toEqual(['unsubscribed', 'unsubscribed']);
    const e0 = entries.find((e) => e.channelId === id(0))!;
    expect(e0.tagIds).toEqual(['tag1']);
    expect(e0.flags?.favorite).toBe(1);
    expect((await db.batches.get(batch.id))?.status).toBe('done');
  });

  it('never unsubscribes channels that are not synced from the API', async () => {
    await db.channels.put({ id: id(9), title: 'Takeout only', subscribed: 1, source: 'takeout' });
    await expect(startBatch('unsubscribe', [id(9)])).rejects.toThrow(/None of the selected/);
    expect(api.deleteSubscription).not.toHaveBeenCalled();
  });

  it('treats 404 (already unsubscribed) as success, other errors as failed', async () => {
    await seed(2);
    api.deleteSubscription
      .mockRejectedValueOnce(new ApiError('not found', 404, 'subscriptionNotFound'))
      .mockRejectedValueOnce(new ApiError('boom', 500));
    const batch = await startBatch('unsubscribe', [id(0), id(1)]);
    await processQueue();
    const entries = await db.unsubscribed.where('batchId').equals(batch.id).toArray();
    expect(entries.map((e) => e.status).sort()).toEqual(['failed', 'unsubscribed']);
  });

  it('pauses on quota errors and keeps the rest pending', async () => {
    await seed(3);
    api.deleteSubscription.mockRejectedValueOnce(new ApiError('quota', 403, 'quotaExceeded'));
    const batch = await startBatch('unsubscribe', [id(0), id(1), id(2)]);
    await processQueue();
    const b = await db.batches.get(batch.id);
    expect(b?.status).toBe('paused-quota');
    expect(b?.resumeAfter).toBeGreaterThan(Date.now());
    expect(await db.unsubscribed.where('status').equals('pending').count()).toBe(3);
  });

  it('respects the per-user daily write cap', async () => {
    await seed(2);
    for (let i = 0; i < DAILY_WRITE_CAP; i++) await recordUsage(50, true);
    const batch = await startBatch('unsubscribe', [id(0), id(1)]);
    await processQueue();
    expect(api.deleteSubscription).not.toHaveBeenCalled();
    expect((await db.batches.get(batch.id))?.status).toBe('paused-quota');
  });

  it('stop halts the batch and removes never-executed entries', async () => {
    await seed(3);
    let release!: () => void;
    let started!: () => void;
    const inCall = new Promise<void>((r) => (started = r));
    api.deleteSubscription.mockImplementationOnce(
      () =>
        new Promise<undefined>((r) => {
          started();
          release = () => r(undefined);
        }),
    );
    const batch = await startBatch('unsubscribe', [id(0), id(1), id(2)]);
    await inCall; // first API call is in flight
    await stopBatch(batch.id);
    release();
    await processQueue();
    expect(api.deleteSubscription).toHaveBeenCalledTimes(1);
    expect((await db.batches.get(batch.id))?.status).toBe('stopped');
    const left = await db.unsubscribed.where('batchId').equals(batch.id).toArray();
    expect(left.map((e) => e.status)).toEqual(['unsubscribed']); // only the one already sent to YouTube
  });

  it('re-subscribe restores subscription, categories and favorites', async () => {
    await seed(1);
    const b1 = await startBatch('unsubscribe', [id(0)]);
    await processQueue();
    await db.channelTags.clear();
    await db.flags.clear();
    const entry = (await db.unsubscribed.where('batchId').equals(b1.id).first())!;
    await startBatch('resubscribe', [entry.id]);
    await processQueue();
    expect(api.insertSubscription).toHaveBeenCalledWith(id(0));
    const c = await db.channels.get(id(0));
    expect(c?.subscribed).toBe(1);
    expect(c?.subscriptionId).toBe('newsub');
    expect(await db.channelTags.get([id(0), 'tag1'])).toBeTruthy();
    expect((await db.flags.get(id(0)))?.favorite).toBe(1);
    expect((await db.unsubscribed.get(entry.id))?.status).toBe('resubscribed');
  });
});
