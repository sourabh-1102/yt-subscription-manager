import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import type { Batch, BatchKind } from '@/lib/types';
import { DAILY_WRITE_CAP } from '@/config/constants';
import { formatDate } from '@/lib/time';
import { send, useAuth, useQuota } from './hooks';
import { Avatar, Button, cx, Modal, Notice } from './primitives';

export interface ReviewItem {
  /** unsubscribe: channel id. resubscribe: unsubscribed-entry id. */
  id: string;
  title: string;
  thumbnailUrl?: string;
  detail?: string;
}

/**
 * Review Assistant (context.md §11).
 *   Step 1 — review every channel (each row must be scrolled into view; any row can be removed)
 *   Step 2 — tick "I confirm" → one button
 *   Step 3 — runs automatically in the background with progress + Stop
 *   Step 4 — done summary
 */
export function ReviewAssistant({
  kind,
  items,
  onClose,
}: {
  kind: BatchKind;
  items: ReviewItem[];
  onClose: () => void;
}) {
  const [included, setIncluded] = useState<Set<string>>(() => new Set(items.map((i) => i.id)));
  const [seen, setSeen] = useState<Set<string>>(new Set());
  const [confirmed, setConfirmed] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const auth = useAuth();
  const quota = useQuota();

  const verb = kind === 'unsubscribe' ? 'Unsubscribe' : 'Re-subscribe';
  const n = included.size;
  const allSeen = items.every((i) => seen.has(i.id));

  // Any change to the batch resets the confirmation.
  useEffect(() => setConfirmed(false), [included]);

  // Mark rows reviewed once they've been visible.
  useEffect(() => {
    const root = listRef.current;
    if (!root || batchId) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const ids = entries.filter((e) => e.isIntersecting).map((e) => (e.target as HTMLElement).dataset.id!);
        if (ids.length) setSeen((s) => (ids.every((id) => s.has(id)) ? s : new Set([...s, ...ids])));
      },
      { root, threshold: 0.6 },
    );
    root.querySelectorAll('[data-id]').forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, [items, batchId]);

  const start = async () => {
    setStarting(true);
    setError(null);
    const res = await send<Batch>({ type: 'queue/start', kind, ids: [...included], confirmed: true });
    setStarting(false);
    if (res.ok && res.data) setBatchId(res.data.id);
    else if (!res.ok) setError(res.error);
  };

  if (batchId) return <BatchProgressModal batchId={batchId} onClose={onClose} />;

  const writesLeft = Math.max(0, DAILY_WRITE_CAP - quota.writes);
  const days = Math.ceil(Math.max(0, n - writesLeft) / DAILY_WRITE_CAP);

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={`Review before you ${verb.toLowerCase()}`}
      footer={
        <div className="flex w-full flex-col gap-3">
          <label
            className={cx(
              'flex items-start gap-2.5 rounded-lg border p-3 text-sm',
              allSeen && n > 0 ? 'border-line' : 'border-line opacity-50',
            )}
          >
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-[var(--color-danger)]"
              disabled={!allSeen || n === 0}
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>
              <b>OK, I have reviewed these channels and I confirm:</b> {verb.toLowerCase()} {kind === 'unsubscribe' ? 'from ' : 'to '}
              <b>{n}</b> channel{n === 1 ? '' : 's'} on my YouTube account.
              {!allSeen && (
                <span className="block text-xs text-ink-3">Scroll through the whole list to unlock this ({seen.size}/{items.length} reviewed).</span>
              )}
            </span>
          </label>
          {error && <Notice tone="danger">{error}</Notice>}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant={kind === 'unsubscribe' ? 'danger' : 'primary'}
              disabled={!confirmed || n === 0 || starting || !auth.signedIn}
              onClick={start}
            >
              {starting ? 'Starting…' : `${verb} ${n} channel${n === 1 ? '' : 's'}`}
            </Button>
          </div>
        </div>
      }
    >
      <p className="text-sm text-ink-2">
        You selected <b className="text-ink">{items.length}</b> channel{items.length === 1 ? '' : 's'}. Please review them — untick
        any you want to keep. After you confirm, I’ll {verb.toLowerCase()} all of them automatically.
      </p>
      <div className="mt-3 space-y-2">
        {!auth.signedIn && (
          <Notice tone="warn">Connect your YouTube account in Settings first — changing subscriptions needs it.</Notice>
        )}
        {kind === 'unsubscribe' && !auth.hasWriteScope && auth.signedIn && (
          <Notice>Google will ask you once to allow “Manage your YouTube account” — needed to unsubscribe. Read-only access stays the default.</Notice>
        )}
        {kind === 'resubscribe' && (
          <Notice>Re-subscribing restores the channel and its categories here, but YouTube resets the bell to its default and the original subscribe date is lost.</Notice>
        )}
        {n > writesLeft && (
          <Notice tone="warn">
            YouTube’s free API quota allows about {DAILY_WRITE_CAP} changes per day. {writesLeft} run today; the rest continue
            automatically over the next {days} day{days === 1 ? '' : 's'}. You can stop at any time.
          </Notice>
        )}
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-ink-3">
        <span>
          Reviewed {seen.size} / {items.length}
        </span>
        <span>{n} will be {kind === 'unsubscribe' ? 'unsubscribed' : 're-subscribed'}</span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded bg-surface-2">
        <div className="h-full bg-accent transition-all" style={{ width: `${(seen.size / Math.max(1, items.length)) * 100}%` }} />
      </div>
      <div ref={listRef} className="mt-3 max-h-[42vh] overflow-y-auto rounded-lg border border-line">
        {items.map((it) => {
          const on = included.has(it.id);
          return (
            <label
              key={it.id}
              data-id={it.id}
              className={cx('flex cursor-pointer items-center gap-3 border-b border-line/60 px-3 py-2 last:border-0', !on && 'opacity-50')}
            >
              <input
                type="checkbox"
                checked={on}
                aria-label={`Include ${it.title}`}
                onChange={() =>
                  setIncluded((s) => {
                    const x = new Set(s);
                    if (x.has(it.id)) x.delete(it.id);
                    else x.add(it.id);
                    return x;
                  })
                }
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
              <Avatar url={it.thumbnailUrl} title={it.title} size={30} />
              <div className="min-w-0 flex-1">
                <div className={cx('truncate text-sm font-medium', !on && 'line-through')}>{it.title || 'Unknown channel'}</div>
                {it.detail && <div className="truncate text-xs text-ink-3">{it.detail}</div>}
              </div>
              {seen.has(it.id) && <span className="text-xs text-ok" aria-label="reviewed">✓</span>}
            </label>
          );
        })}
      </div>
    </Modal>
  );
}

export function useBatchProgress(batchId: string) {
  return useLiveQuery(async () => {
    const batch = await db.batches.get(batchId);
    if (!batch) return undefined;
    const entries =
      batch.kind === 'unsubscribe'
        ? await db.unsubscribed.where('batchId').equals(batchId).toArray()
        : await db.unsubscribed.filter((e) => e.resubBatchId === batchId).toArray();
    const ok = batch.kind === 'unsubscribe' ? 'unsubscribed' : 'resubscribed';
    const fail = batch.kind === 'unsubscribe' ? 'failed' : 'resubscribe-failed';
    return {
      batch,
      entries,
      total: batch.channelIds.length,
      done: entries.filter((e) => e.status === ok || (batch.kind === 'resubscribe' && e.status === 'resubscribed')).length,
      failed: entries.filter((e) => e.status === fail),
    };
  }, [batchId]);
}

export function BatchProgress({ batchId, compact }: { batchId: string; compact?: boolean }) {
  const p = useBatchProgress(batchId);
  if (!p) return null;
  const { batch, total, done, failed } = p;
  const verb = batch.kind === 'unsubscribe' ? 'Unsubscribed' : 'Re-subscribed';
  const pct = total ? ((done + failed.length) / total) * 100 : 0;
  const status =
    batch.status === 'running'
      ? 'Working…'
      : batch.status === 'paused-quota'
        ? `Paused — resumes automatically ${batch.resumeAfter ? `after ${formatDate(batch.resumeAfter)} reset` : 'later'}`
        : batch.status === 'stopped'
          ? 'Stopped by you'
          : 'Finished';
  return (
    <div className={cx(compact ? '' : 'space-y-3')}>
      <div className="flex items-center justify-between text-sm">
        <span>
          {verb} <b className="tabular-nums">{done}</b> / {total}
          {failed.length > 0 && <span className="text-danger"> · {failed.length} failed</span>}
        </span>
        <span className="text-xs text-ink-3">{status}</span>
      </div>
      <div
        className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
      </div>
      {batch.lastError && batch.status === 'paused-quota' && <p className="mt-1.5 text-xs text-ink-3">{batch.lastError}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {(batch.status === 'running' || batch.status === 'paused-quota') && (
          <Button size="sm" variant="danger-outline" onClick={() => void send({ type: 'queue/stop', batchId })}>
            Stop
          </Button>
        )}
        {failed.length > 0 && batch.status !== 'running' && (
          <Button size="sm" onClick={() => void send({ type: 'queue/retryFailed', batchId })}>
            Retry {failed.length} failed
          </Button>
        )}
      </div>
      {!compact && failed.length > 0 && (
        <ul className="max-h-40 overflow-y-auto rounded-lg border border-line text-xs">
          {failed.map((f) => (
            <li key={f.id} className="border-b border-line/60 px-3 py-1.5 last:border-0">
              <b>{f.title || f.channelId}</b> — <span className="text-ink-3">{f.error}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BatchProgressModal({ batchId, onClose }: { batchId: string; onClose: () => void }) {
  const p = useBatchProgress(batchId);
  const finished = p && (p.batch.status === 'done' || p.batch.status === 'stopped');
  const title = useMemo(
    () => (finished ? 'Done' : p?.batch.kind === 'resubscribe' ? 'Re-subscribing…' : 'Unsubscribing…'),
    [finished, p?.batch.kind],
  );
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <a href="#/unsubscribed" onClick={onClose} className="mr-auto self-center text-sm text-accent hover:underline">
            Open Unsubscribed dashboard →
          </a>
          <Button variant="primary" onClick={onClose}>
            {finished ? 'Close' : 'Run in background'}
          </Button>
        </>
      }
    >
      <BatchProgress batchId={batchId} />
      {!finished && (
        <p className="mt-4 text-xs text-ink-3">You can close this window — it keeps running in the background and survives browser restarts.</p>
      )}
      {finished && p && (
        <p className="mt-4 text-sm">
          {p.batch.kind === 'unsubscribe' ? 'Unsubscribed from' : 'Re-subscribed to'} <b>{p.done}</b> channel{p.done === 1 ? '' : 's'}.
          {p.failed.length > 0 && ` ${p.failed.length} failed.`}{' '}
          {p.batch.kind === 'unsubscribe' && 'Made a mistake? Re-subscribe from the Unsubscribed dashboard.'}
        </p>
      )}
    </Modal>
  );
}
