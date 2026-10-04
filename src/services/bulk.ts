import { browser } from 'wxt/browser';
import { db, newId } from '@/db/db';
import type { BulkOp, BulkOpItem, BulkOpKind } from '@/lib/types';
import { msUntilQuotaReset } from '@/lib/time';
import { ALARMS, PLAYLIST_DAILY_WRITE_CAP } from '@/config/constants';
import { summarize } from '@/features/bulk-summary';
import { ApiError } from './youtube-api';
import { deletePlaylist, deletePlaylistItem, humanizeError, insertPlaylistItem } from './playlist-api';
import { getLedger } from './quota';
import { ensureWriteScope, PlaylistError, playlistVideoIds, snapshotPlaylist, syncPlaylistItems } from './playlists';
import { removeOneLive, WlLiveError } from './wl-live';
import { logDeletion, markRestored } from '@/db/trash';
import type { DeletionLogEntry } from '@/lib/types';

// ---------- Deleted-items log helpers (local history; written only after a confirmed removal) ----------
async function playlistVideoLogFields(op: BulkOp, item: BulkOpItem): Promise<Partial<DeletionLogEntry>> {
  const cached = item.playlistItemId ? await db.playlistItems.get(item.playlistItemId) : undefined;
  const pl = op.sourcePlaylistId ? await db.playlists.get(op.sourcePlaylistId) : undefined;
  return {
    videoId: item.videoId,
    title: cached?.title ?? item.title,
    channelTitle: cached?.channelTitle,
    thumbnailUrl: cached?.thumbnailUrl,
    playlistId: op.sourcePlaylistId,
    playlistTitle: pl?.title,
    fetchedAt: cached?.fetchedAt ?? pl?.fetchedAt ?? Date.now(),
  };
}


/**
 * Bulk operation engine.
 *
 * - Persisted in IndexedDB: progress survives tab closes, worker restarts and browser restarts.
 * - Sequential (concurrency 1) with pacing — never fires hundreds of requests at once.
 * - API steps pause on quota exhaustion / daily cap and resume automatically after the reset.
 * - Stop keeps unfinished items pending → Resume continues exactly where it stopped; completed
 *   items are never repeated; Retry failed re-runs only failures.
 * - Two-step kinds (move, wl-move) persist `added` after the add succeeds, so the removal never
 *   happens before the copy is confirmed, and a retry never adds twice.
 * - Watch Later removal (wl-*) goes through YouTube's own website UI and is verified (wl-live.ts).
 */

export const bulkTiming = { delayMs: 300, wlDelayMs: 900 };

export interface StartOpInput {
  kind: BulkOpKind;
  label: string;
  sourcePlaylistId?: string;
  destPlaylistId?: string;
  items: { videoId: string; playlistItemId?: string; targetPlaylistId?: string; title?: string; logId?: string }[];
  /** add/move/merge/wl-move: skip videos already in the destination (default true). */
  skipDuplicates?: boolean;
  /** merge: delete these playlists after a fully successful merge. */
  deleteSourceIds?: string[];
}

const NEEDS_DEST: BulkOpKind[] = ['add', 'move', 'merge', 'wl-move'];
const USES_API_WRITE = (kind: BulkOpKind) => kind !== 'wl-remove';

export async function startOp(input: StartOpInput): Promise<{ op: BulkOp; skipped: number }> {
  const { kind } = input;
  if (NEEDS_DEST.includes(kind) && !input.destPlaylistId) throw new PlaylistError('Choose a destination playlist.', 'bad-input');
  if ((kind === 'remove' || kind === 'move') && !input.sourcePlaylistId) throw new PlaylistError('Missing source playlist.', 'bad-input');
  if (kind === 'move' && input.sourcePlaylistId === input.destPlaylistId) throw new PlaylistError('Source and destination are the same playlist.', 'bad-input');
  if ((kind === 'remove' || kind === 'move') && input.items.some((i) => !i.playlistItemId)) {
    throw new PlaylistError('Some selected videos can’t be removed from their source.', 'bad-input');
  }
  if (kind === 'pl-delete' && input.items.some((i) => !i.targetPlaylistId)) throw new PlaylistError('Missing playlist to delete.', 'bad-input');
  if (USES_API_WRITE(kind)) await ensureWriteScope();

  // De-duplicate the selection itself.
  const keyOf = (i: StartOpInput['items'][number]) =>
    kind === 'remove' || kind === 'move' ? i.playlistItemId : kind === 'pl-delete' ? i.targetPlaylistId : i.videoId;
  const seen = new Set<string>();
  const items = input.items.filter((i) => {
    const k = keyOf(i);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const existing =
    NEEDS_DEST.includes(kind) && input.skipDuplicates !== false ? await playlistVideoIds(input.destPlaylistId!) : new Set<string>();

  const op: BulkOp = {
    id: newId(),
    kind,
    label: input.label.slice(0, 200),
    sourcePlaylistId: input.sourcePlaylistId,
    destPlaylistId: input.destPlaylistId,
    deleteSourceIds: kind === 'merge' ? input.deleteSourceIds?.filter((id) => id !== input.destPlaylistId) : undefined,
    createdAt: Date.now(),
    status: 'running',
  };
  let skipped = 0;
  const rows: BulkOpItem[] = items.map((it, index) => {
    const dup = existing.has(it.videoId);
    const row: BulkOpItem = {
      id: `${op.id}:${index}`,
      opId: op.id,
      index,
      videoId: it.videoId,
      title: it.title?.slice(0, 300),
      playlistItemId: it.playlistItemId,
      targetPlaylistId: it.targetPlaylistId,
      logId: it.logId,
      status: 'pending',
    };
    if (dup && (kind === 'add' || kind === 'merge')) {
      row.status = 'skipped';
      row.error = 'Already in the destination playlist';
      skipped++;
    }
    // Already in the destination: only the removal step is still needed.
    if (dup && (kind === 'move' || kind === 'wl-move')) row.added = 1;
    return row;
  });
  await db.transaction('rw', db.bulkOps, db.bulkOpItems, async () => {
    await db.bulkOps.put(op);
    await db.bulkOpItems.bulkPut(rows);
  });
  // Restores of videos that are already back in the playlist count as restored.
  const restoredByDup = rows.filter((r) => r.status === 'skipped' && r.logId).map((r) => r.logId!);
  if (restoredByDup.length) await markRestored(restoredByDup);
  void processOps();
  return { op, skipped };
}

export async function stopOp(opId: string): Promise<void> {
  const op = await db.bulkOps.get(opId);
  if (!op || op.status === 'done' || op.status === 'stopped') return;
  await db.bulkOps.update(opId, { status: 'stopped', resumeAfter: undefined });
}

/** Continue a stopped op (pending items only — completed ones are never repeated). */
export async function resumeOp(opId: string): Promise<void> {
  const op = await db.bulkOps.get(opId);
  if (!op || op.status === 'running') return;
  await db.bulkOps.update(opId, { status: 'running', resumeAfter: undefined, lastError: undefined });
  void processOps();
}

export async function retryFailedOp(opId: string): Promise<number> {
  const failed = await db.bulkOpItems.where('[opId+status]').equals([opId, 'failed']).toArray();
  await db.transaction('rw', db.bulkOps, db.bulkOpItems, async () => {
    await db.bulkOpItems.bulkUpdate(failed.map((f) => ({ key: f.id, changes: { status: 'pending' as const, error: undefined } })));
    await db.bulkOps.update(opId, { status: 'running', resumeAfter: undefined, lastError: undefined, resultNote: undefined });
  });
  void processOps();
  return failed.length;
}

async function pause(op: BulkOp, reason: string) {
  const delay = msUntilQuotaReset();
  await db.bulkOps.update(op.id, { status: 'paused-quota', resumeAfter: Date.now() + delay, lastError: reason });
  try {
    await browser.alarms.create(ALARMS.bulk, { when: Date.now() + delay });
  } catch {
    /* alarms unavailable (tests) — startup/next action resumes it */
  }
}

/** Thrown when the whole op must stop (e.g. signed out of YouTube) — the item stays pending. */
class StopOp extends Error {}

async function removeFromLiveWatchLater(videoId: string, opId: string, note?: string): Promise<void> {
  const before = await db.watchLater.get(videoId);
  let r;
  try {
    r = await removeOneLive(videoId);
  } catch (e) {
    if (e instanceof WlLiveError && (e.code === 'signed-out' || e.code === 'no-tab' || e.code === 'not-watch-later' || e.code === 'no-response')) {
      throw new StopOp(e.message);
    }
    throw e;
  }
  if (!r.ok) {
    if (r.code === 'signed-out' || r.code === 'not-watch-later') throw new StopOp(r.error);
    throw new Error(r.error);
  }
  // Confirmed gone on YouTube → update the local representation and record it.
  await db.watchLater.delete(videoId);
  await logDeletion({
    kind: 'watch-later',
    opId,
    note,
    videoId,
    title: before?.title,
    channelTitle: before?.channelTitle,
    thumbnailUrl: before?.thumbnailUrl,
    // Titles read from the YouTube page are not API data; Takeout-enriched ones are (videos.list).
    fetchedAt: before?.fetchedAt,
  });
}

async function runItem(op: BulkOp, item: BulkOpItem): Promise<'ok' | 'quota' | 'failed' | 'stop'> {
  try {
    switch (op.kind) {
      case 'add':
      case 'merge':
        await insertPlaylistItem(op.destPlaylistId!, item.videoId);
        if (item.logId) await markRestored([item.logId]);
        break;
      case 'remove': {
        const log = await playlistVideoLogFields(op, item);
        try {
          await deletePlaylistItem(item.playlistItemId!);
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 404)) throw e; // already gone = done
        }
        await logDeletion({ kind: 'playlist-video', opId: op.id, ...log });
        break;
      }
      case 'pl-delete': {
        const snap = await snapshotPlaylist(item.targetPlaylistId!);
        try {
          await deletePlaylist(item.targetPlaylistId!);
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 404)) throw e;
        }
        await logDeletion({ kind: 'playlist', opId: op.id, ...snap });
        await db.transaction('rw', db.playlists, db.playlistItems, db.playlistTags, async () => {
          await db.playlists.delete(item.targetPlaylistId!);
          await db.playlistItems.where('playlistId').equals(item.targetPlaylistId!).delete();
          await db.playlistTags.where('playlistId').equals(item.targetPlaylistId!).delete();
        });
        break;
      }
      case 'move': {
        const log = await playlistVideoLogFields(op, item);
        if (!item.added) {
          await insertPlaylistItem(op.destPlaylistId!, item.videoId);
          await db.bulkOpItems.update(item.id, { added: 1 }); // persisted before touching the source
        }
        try {
          await deletePlaylistItem(item.playlistItemId!);
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 404)) {
            if (e instanceof ApiError && e.isQuota) throw e;
            throw new Error(`Copied, but couldn’t remove it from the source playlist: ${humanizeError(e)}`);
          }
        }
        const dest = (await db.playlists.get(op.destPlaylistId!))?.title;
        await logDeletion({ kind: 'playlist-video', opId: op.id, note: `Moved to ${dest ?? 'another playlist'}`, ...log });
        break;
      }
      case 'wl-remove':
        await removeFromLiveWatchLater(item.videoId, op.id);
        break;
      case 'wl-move': {
        if (!item.added) {
          await insertPlaylistItem(op.destPlaylistId!, item.videoId);
          await db.bulkOpItems.update(item.id, { added: 1 }); // confirmed BEFORE touching Watch Later
        }
        const dest = (await db.playlists.get(op.destPlaylistId!))?.title ?? 'the playlist';
        try {
          await removeFromLiveWatchLater(item.videoId, op.id, `Moved to ${dest}`);
        } catch (e) {
          if (e instanceof StopOp) throw e;
          throw new Error(`Added to ${dest}, but could not remove from Watch Later: ${e instanceof Error ? e.message : String(e)}`);
        }
        break;
      }
    }
    await db.bulkOpItems.update(item.id, { status: 'done', error: undefined });
    return 'ok';
  } catch (e) {
    if (e instanceof StopOp) {
      await db.bulkOps.update(op.id, { status: 'stopped', lastError: e.message });
      return 'stop';
    }
    if (e instanceof ApiError && e.isQuota) return 'quota';
    const msg = e instanceof ApiError ? humanizeError(e) : e instanceof Error ? e.message : String(e);
    await db.bulkOpItems.update(item.id, { status: 'failed', error: msg.slice(0, 300) });
    return 'failed';
  }
}

/** Re-fetch the playlists an op touched so lists/counts are accurate (cache invalidation). */
async function refreshAffected(op: BulkOp) {
  for (const id of [op.sourcePlaylistId, op.destPlaylistId]) {
    if (!id) continue;
    const p = await db.playlists.get(id);
    if (p) await syncPlaylistItems(id).catch(() => undefined);
  }
}

/** Merge follow-up: delete the source playlists only if EVERY video was added. */
async function finishMerge(op: BulkOp) {
  const p = summarize(await db.bulkOpItems.where('opId').equals(op.id).toArray());
  if (!op.deleteSourceIds?.length) {
    await db.bulkOps.update(op.id, { resultNote: `Merged: ${p.done} added, ${p.skipped} already there.` });
    return;
  }
  if (p.failed > 0) {
    await db.bulkOps.update(op.id, {
      resultNote: `Source playlists were kept because ${p.failed} video(s) could not be added. Retry the failed ones, then delete the sources manually.`,
    });
    return;
  }
  let deleted = 0;
  const errors: string[] = [];
  const target = (await db.playlists.get(op.destPlaylistId!))?.title;
  for (const id of op.deleteSourceIds) {
    try {
      const snap = await snapshotPlaylist(id);
      await deletePlaylist(id);
      await logDeletion({ kind: 'playlist', opId: op.id, note: `Merged into ${target ?? 'another playlist'}`, ...snap });
      await db.playlists.delete(id);
      await db.playlistItems.where('playlistId').equals(id).delete();
      await db.playlistTags.where('playlistId').equals(id).delete();
      deleted++;
    } catch (e) {
      errors.push(humanizeError(e));
    }
  }
  await db.bulkOps.update(op.id, {
    resultNote: `Merged: ${p.done} added, ${p.skipped} already there. Deleted ${deleted} of ${op.deleteSourceIds.length} source playlists.${errors.length ? ` Not deleted: ${errors[0]}` : ''}`,
  });
}

let inFlight: Promise<void> | null = null;
let rerun = false;

/** Drain runnable ops. Concurrent callers share one run; late calls trigger another pass. */
export function processOps(): Promise<void> {
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
  const now = Date.now();
  await db.bulkOps
    .where('status')
    .equals('paused-quota')
    .filter((o) => (o.resumeAfter ?? 0) <= now)
    .modify({ status: 'running', resumeAfter: undefined });

  for (;;) {
    const op = (await db.bulkOps.where('status').equals('running').sortBy('createdAt'))[0];
    if (!op) break;
    const next = (await db.bulkOpItems.where('[opId+status]').equals([op.id, 'pending']).sortBy('index'))[0];
    if (!next) {
      await db.bulkOps.update(op.id, { status: 'done' });
      if (op.kind === 'merge') await finishMerge(op);
      await refreshAffected(op);
      continue;
    }
    const needsApiWrite = USES_API_WRITE(op.kind) && !(op.kind === 'wl-move' && next.added);
    if (needsApiWrite && (await getLedger()).writes >= PLAYLIST_DAILY_WRITE_CAP) {
      await pause(op, 'Daily change limit reached. Continues automatically after the YouTube quota resets.');
      continue;
    }
    if ((await db.bulkOps.get(op.id))?.status !== 'running') continue; // Stop pressed
    const r = await runItem(op, next);
    if (r === 'quota') {
      await pause(op, 'YouTube API quota limit reached. Continues automatically after it resets.');
      await refreshAffected(op);
    }
    const delay = op.kind.startsWith('wl-') ? bulkTiming.wlDelayMs : bulkTiming.delayMs;
    if (delay) await new Promise((res) => setTimeout(res, delay));
  }
}

export { summarize, type OpProgress } from '@/features/bulk-summary';
