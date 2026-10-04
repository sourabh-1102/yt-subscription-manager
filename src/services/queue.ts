import { browser } from 'wxt/browser';
import { db, newId } from '@/db/db';
import type { Batch, BatchKind, UnsubscribedEntry } from '@/lib/types';
import { msUntilQuotaReset } from '@/lib/time';
import { ALARMS } from '@/config/constants';
import { ApiError, deleteSubscription, insertSubscription } from './youtube-api';
import { writesRemainingToday } from './quota';
import { errMsg, getToken } from './auth';
import { setAuthState } from '@/lib/prefs';

/**
 * Unsubscribe / re-subscribe queue (context.md §11).
 *
 * A batch only exists after the user reviewed every channel and ticked the confirmation in the
 * Review Assistant. Once confirmed, it runs automatically — including resuming after the daily
 * cap resets — but a confirmed batch can never grow, and the user can Stop it at any time.
 */

export class QueueError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
  }
}

/** Make sure the write scope is granted (interactive — runs right after the user's confirm click). */
async function ensureWriteScope(): Promise<void> {
  try {
    await getToken(true, true);
    await setAuthState({ hasWriteScope: true });
  } catch (e) {
    throw new QueueError(`Permission to manage subscriptions was not granted. ${errMsg(e)}`, 'no-write-scope');
  }
}

export async function startBatch(kind: BatchKind, ids: string[]): Promise<Batch> {
  const unique = [...new Set(ids)];
  await ensureWriteScope();
  const batchId = newId();
  const now = Date.now();

  if (kind === 'unsubscribe') {
    const channels = (await db.channels.bulkGet(unique)).filter(
      (c): c is NonNullable<typeof c> => !!c && c.subscribed === 1 && !!c.subscriptionId,
    );
    if (!channels.length) throw new QueueError('None of the selected channels can be unsubscribed.', 'empty');
    const channelIds = channels.map((c) => c.id);
    const tagRows = await db.channelTags.where('channelId').anyOf(channelIds).toArray();
    const flagRows = await db.flags.bulkGet(channelIds);
    const entries: UnsubscribedEntry[] = channels.map((c, i) => {
      const { channelId: _omit, ...flags } = flagRows[i] ?? { channelId: c.id };
      return {
        id: `${batchId}:${c.id}`,
        batchId,
        channelId: c.id,
        title: c.title,
        thumbnailUrl: c.thumbnailUrl,
        oldSubscriptionId: c.subscriptionId!,
        tagIds: tagRows.filter((t) => t.channelId === c.id).map((t) => t.tagId),
        flags,
        queuedAt: now,
        status: 'pending',
      };
    });
    const batch: Batch = { id: batchId, kind, channelIds, confirmedAt: now, status: 'running' };
    // The entries ARE the backup: written before any API call.
    await db.transaction('rw', db.batches, db.unsubscribed, async () => {
      await db.batches.put(batch);
      await db.unsubscribed.bulkPut(entries);
    });
    void processQueue();
    return batch;
  }

  // resubscribe: ids are unsubscribed-entry ids
  const entries = (await db.unsubscribed.bulkGet(unique)).filter(
    (e): e is UnsubscribedEntry => !!e && (e.status === 'unsubscribed' || e.status === 'resubscribe-failed'),
  );
  if (!entries.length) throw new QueueError('None of the selected channels can be re-subscribed.', 'empty');
  const batch: Batch = {
    id: batchId,
    kind,
    channelIds: entries.map((e) => e.channelId),
    confirmedAt: now,
    status: 'running',
  };
  await db.transaction('rw', db.batches, db.unsubscribed, async () => {
    await db.batches.put(batch);
    await db.unsubscribed.bulkUpdate(
      entries.map((e) => ({ key: e.id, changes: { status: 'resubscribe-pending', resubBatchId: batchId, error: undefined } })),
    );
  });
  void processQueue();
  return batch;
}

export async function stopBatch(batchId: string): Promise<void> {
  const batch = await db.batches.get(batchId);
  if (!batch || batch.status === 'done' || batch.status === 'stopped') return;
  await db.transaction('rw', db.batches, db.unsubscribed, async () => {
    await db.batches.update(batchId, { status: 'stopped' });
    if (batch.kind === 'unsubscribe') {
      // Never executed → never happened. Remove from the archive.
      await db.unsubscribed.where('batchId').equals(batchId).filter((e) => e.status === 'pending').delete();
    } else {
      await db.unsubscribed
        .filter((e) => e.resubBatchId === batchId && e.status === 'resubscribe-pending')
        .modify({ status: 'unsubscribed', resubBatchId: undefined });
    }
  });
}

export async function retryFailed(batchId: string): Promise<void> {
  const batch = await db.batches.get(batchId);
  if (!batch) return;
  await db.transaction('rw', db.batches, db.unsubscribed, async () => {
    if (batch.kind === 'unsubscribe') {
      await db.unsubscribed.where('batchId').equals(batchId).filter((e) => e.status === 'failed').modify({ status: 'pending', error: undefined });
    } else {
      await db.unsubscribed
        .filter((e) => e.resubBatchId === batchId && e.status === 'resubscribe-failed')
        .modify({ status: 'resubscribe-pending', error: undefined });
    }
    await db.batches.update(batchId, { status: 'running', resumeAfter: undefined, lastError: undefined });
  });
  void processQueue();
}

async function nextItem(batch: Batch): Promise<UnsubscribedEntry | undefined> {
  return batch.kind === 'unsubscribe'
    ? db.unsubscribed.where('batchId').equals(batch.id).filter((e) => e.status === 'pending').first()
    : db.unsubscribed.filter((e) => e.resubBatchId === batch.id && e.status === 'resubscribe-pending').first();
}

async function pauseUntilReset(batch: Batch, reason: string) {
  const delay = msUntilQuotaReset();
  await db.batches.update(batch.id, { status: 'paused-quota', resumeAfter: Date.now() + delay, lastError: reason });
  await browser.alarms.create(ALARMS.queue, { when: Date.now() + delay });
}

async function runOne(batch: Batch, item: UnsubscribedEntry): Promise<'ok' | 'quota' | 'failed'> {
  try {
    if (batch.kind === 'unsubscribe') {
      try {
        await deleteSubscription(item.oldSubscriptionId);
      } catch (e) {
        // Already gone on YouTube's side — the user's intent is satisfied.
        if (!(e instanceof ApiError && e.status === 404)) throw e;
      }
      await db.transaction('rw', db.unsubscribed, db.channels, async () => {
        // `put`, not `update`: if the user pressed Stop while this call was in flight, the entry was
        // removed as "never executed" — but YouTube did process it, so it must reappear in the archive.
        await db.unsubscribed.put({ ...item, status: 'unsubscribed', doneAt: Date.now(), error: undefined });
        await db.channels.update(item.channelId, { subscribed: 0, subscriptionId: undefined });
      });
    } else {
      let subscriptionId: string | undefined;
      try {
        subscriptionId = (await insertSubscription(item.channelId)).id;
      } catch (e) {
        if (!(e instanceof ApiError && e.reason === 'subscriptionDuplicate')) throw e;
      }
      await db.transaction('rw', [db.unsubscribed, db.channels, db.channelTags, db.flags, db.tags], async () => {
        await db.unsubscribed.update(item.id, { status: 'resubscribed', error: undefined });
        const ch = await db.channels.get(item.channelId);
        await db.channels.put({
          ...(ch ?? { id: item.channelId, title: item.title, thumbnailUrl: item.thumbnailUrl, source: 'api' as const }),
          subscribed: 1,
          subscriptionId,
          subscribedAt: Date.now(),
        });
        // Restore the organization the channel had when it was unsubscribed.
        const existingTags = new Set((await db.tags.toArray()).map((t) => t.id));
        await db.channelTags.bulkPut(
          item.tagIds.filter((t) => existingTags.has(t)).map((tagId) => ({ channelId: item.channelId, tagId })),
        );
        if (item.flags && Object.keys(item.flags).length) {
          const cur = await db.flags.get(item.channelId);
          await db.flags.put({ ...item.flags, ...cur, channelId: item.channelId });
        }
      });
    }
    return 'ok';
  } catch (e) {
    if (e instanceof ApiError && e.isQuota) return 'quota';
    const msg =
      e instanceof ApiError && e.reason === 'subscriptionForbidden'
        ? 'YouTube refused this request (often a temporary limit on rapid subscribes). Retry later.'
        : errMsg(e);
    await db.unsubscribed.update(item.id, {
      status: batch.kind === 'unsubscribe' ? 'failed' : 'resubscribe-failed',
      error: msg.slice(0, 300),
    });
    return 'failed';
  }
}

/** Pacing between write calls (tests set this to 0). */
export const queueTiming = { delayMs: 400 };

let inFlight: Promise<void> | null = null;
let rerun = false;

/**
 * Drain all runnable batches. Safe to call repeatedly (alarm, startup, after start):
 * concurrent callers share the in-flight run, and a call that arrives mid-run triggers
 * one more pass so a just-confirmed batch is never left waiting for the next alarm.
 */
export function processQueue(): Promise<void> {
  if (inFlight) {
    rerun = true;
    return inFlight;
  }
  inFlight = (async () => {
    try {
      do {
        rerun = false;
        await drain();
      } while (rerun);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

async function drain(): Promise<void> {
  {
    // Wake batches whose quota pause has elapsed.
    const now = Date.now();
    await db.batches
      .where('status')
      .equals('paused-quota')
      .filter((b) => (b.resumeAfter ?? 0) <= now)
      .modify({ status: 'running', resumeAfter: undefined });

    for (;;) {
      const batch = await db.batches.where('status').equals('running').first();
      if (!batch) break;
      const item = await nextItem(batch);
      if (!item) {
        await db.batches.update(batch.id, { status: 'done' });
        continue;
      }
      if ((await writesRemainingToday()) <= 0) {
        await pauseUntilReset(batch, 'Daily limit reached. Resumes automatically after the quota resets.');
        continue;
      }
      // Re-read status: the user may have pressed Stop meanwhile.
      if ((await db.batches.get(batch.id))?.status !== 'running') continue;
      const r = await runOne(batch, item);
      if (r === 'quota') await pauseUntilReset(batch, 'YouTube API quota exhausted. Resumes automatically tomorrow.');
      if (queueTiming.delayMs) await new Promise((res) => setTimeout(res, queueTiming.delayMs)); // gentle pacing
    }
  }
}
