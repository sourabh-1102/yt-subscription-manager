import { describe, expect, it, vi } from 'vitest';
import { db } from '@/db/db';
import { setPrefs, getPrefs } from '@/lib/prefs';
import { recordObservedWatch } from '@/services/watch';
import { buildBackup, restoreBackup, validateBackup } from '@/services/backup';
import { importTakeoutSubscriptions, importTakeoutWatches } from '@/db/repo';
import { enforceApiDataTtl, subscriptionToChannel } from '@/services/sync';
import { DAY_MS } from '@/config/constants';

const CH = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
const CH2 = 'UCsBjURrPoezykLs9EqgamOA';
const VID = 'dQw4w9WgXcQ';

describe('watch tracking', () => {
  it('ignores watches while tracking is off (default)', async () => {
    expect((await getPrefs()).trackingEnabled).toBe(false);
    expect(await recordObservedWatch({ videoId: VID, channelId: CH })).toBe('ignored');
    expect(await db.watchEvents.count()).toBe(0);
  });

  it('records once per video per day, and stamps trackingStartedAt', async () => {
    await setPrefs({ trackingEnabled: true });
    expect((await getPrefs()).trackingStartedAt).toBeTypeOf('number');
    const t = Date.parse('2026-10-04T10:00:00Z');
    await recordObservedWatch({ videoId: VID, channelId: CH }, t);
    await recordObservedWatch({ videoId: VID, channelId: CH }, t + 3600_000);
    await recordObservedWatch({ videoId: VID, channelId: CH }, t + DAY_MS);
    expect(await db.watchEvents.count()).toBe(2);
  });

  it('respects excluded channels', async () => {
    await setPrefs({ trackingEnabled: true, excludedChannelIds: [CH] });
    expect(await recordObservedWatch({ videoId: VID, channelId: CH })).toBe('ignored');
  });

  it('matches by channel name locally, otherwise queues as pending', async () => {
    await setPrefs({ trackingEnabled: true });
    await db.channels.put({ id: CH2, title: 'Veritasium', subscribed: 1, source: 'api' });
    expect(await recordObservedWatch({ videoId: VID, channelName: ' veritasium ' })).toBe('recorded');
    expect((await db.watchEvents.toArray())[0]?.channelId).toBe(CH2);
    expect(await recordObservedWatch({ videoId: 'aaaaaaaaaaa', channelName: 'Unknown' })).toBe('pending');
    expect(await db.pendingVideos.count()).toBe(1);
  });
});

describe('backup', () => {
  it('round-trips and rejects tampered files', async () => {
    await db.channels.put({ id: CH, title: 'A', subscribed: 1, source: 'api', fetchedAt: 1 });
    await db.tags.put({ id: 't', name: 'Tech', emoji: '💻', order: 1 });
    await db.channelTags.put({ channelId: CH, tagId: 't' });
    await db.watchEvents.put({ id: `${VID}:2026-01-01`, videoId: VID, channelId: CH, watchedAt: 5, source: 'tracked' });
    const backup = JSON.parse(JSON.stringify(await buildBackup()));
    await db.delete();
    await db.open();
    await restoreBackup(validateBackup(backup), 'replace');
    expect(await db.channelTags.count()).toBe(1);
    expect((await db.channels.get(CH))?.fetchedAt).toBe(1); // TTL anchor preserved

    expect(() => validateBackup({ ...backup, channels: [{ id: 'javascript:alert(1)' }] })).toThrow(/Invalid backup/);
    expect(() => validateBackup({ format: 'other' })).toThrow();
  });

  it('does not resurrect queued (never executed) unsubscribes', async () => {
    const b = await buildBackup();
    b.unsubscribed.push({
      id: `x:${CH}`,
      batchId: 'x',
      channelId: CH,
      title: 'A',
      oldSubscriptionId: 's',
      tagIds: [],
      queuedAt: 1,
      status: 'pending',
    });
    await restoreBackup(validateBackup(b), 'merge');
    expect(await db.unsubscribed.count()).toBe(0);
  });
});

describe('takeout import', () => {
  it('imports watches with dedupe and remembers channel names', async () => {
    const w = { videoId: VID, channelId: CH, channelTitle: 'Google', watchedAt: Date.parse('2025-01-01T00:00:00Z') };
    expect(await importTakeoutWatches([w, w], [])).toEqual({ added: 1, duplicates: 1 });
    expect(await importTakeoutWatches([w], [])).toEqual({ added: 0, duplicates: 1 });
    expect((await db.channels.get(CH))?.title).toBe('Google');
  });
  it('subscriptions import never downgrades API records', async () => {
    await db.channels.put({ id: CH, title: 'API title', subscribed: 1, source: 'api', subscriptionId: 's', fetchedAt: 1 });
    await importTakeoutSubscriptions([
      { channelId: CH, title: 'csv title' },
      { channelId: CH2, title: 'New' },
    ]);
    expect((await db.channels.get(CH))?.title).toBe('API title');
    expect((await db.channels.get(CH2))?.source).toBe('takeout');
  });
});

describe('API data TTL (YouTube policy III.E.4)', () => {
  it('strips API metadata older than 30 days but keeps user data', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-04T00:00:00Z'));
    await db.channels.bulkPut([
      { id: CH, title: 'Old', thumbnailUrl: 'https://yt3.ggpht.com/a', subscribed: 1, source: 'api', fetchedAt: Date.now() - 31 * DAY_MS },
      { id: CH2, title: 'Fresh', subscribed: 1, source: 'api', fetchedAt: Date.now() - DAY_MS },
    ]);
    await db.channelTags.put({ channelId: CH, tagId: 't' });
    expect(await enforceApiDataTtl()).toBe(1);
    const old = await db.channels.get(CH);
    expect(old?.title).toBe('');
    expect(old?.thumbnailUrl).toBeUndefined();
    expect((await db.channels.get(CH2))?.title).toBe('Fresh');
    expect(await db.channelTags.count()).toBe(1);
    vi.useRealTimers();
  });

  it('maps subscription items while keeping local fields', () => {
    const c = subscriptionToChannel(
      {
        id: 'subid',
        snippet: { title: 'T', publishedAt: '2020-01-01T00:00:00Z', resourceId: { channelId: CH }, thumbnails: { default: { url: 'u' } } },
        contentDetails: { totalItemCount: 5 },
      },
      { id: CH, title: 'old', subscribed: 0, source: 'takeout', lastUploadAt: 42 },
      100,
    );
    expect(c).toMatchObject({ subscribed: 1, subscriptionId: 'subid', source: 'api', fetchedAt: 100, lastUploadAt: 42, videoCount: 5 });
  });
});
