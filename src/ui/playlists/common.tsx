import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import type { BulkOp, PlaylistPrivacy } from '@/lib/types';
import { safeImageUrl } from '@/lib/youtube-urls';
import { summarize } from '@/features/bulk-summary';
import { send } from '../hooks';
import { Button, cx, Modal } from '../primitives';

export function Thumb({ url, alt, className }: { url?: string; alt: string; className?: string }) {
  const safe = safeImageUrl(url);
  return (
    <div className={cx('relative shrink-0 overflow-hidden rounded-lg bg-surface-2', className)}>
      {safe && (
        <img
          src={safe}
          alt={alt}
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={(e) => (e.currentTarget.style.visibility = 'hidden')}
          className="h-full w-full object-cover"
        />
      )}
    </div>
  );
}

const PRIVACY: Record<PlaylistPrivacy, { label: string; icon: string }> = {
  public: { label: 'Public', icon: '🌐' },
  unlisted: { label: 'Unlisted', icon: '🔗' },
  private: { label: 'Private', icon: '🔒' },
};

export function PrivacyBadge({ privacy }: { privacy: PlaylistPrivacy }) {
  const p = PRIVACY[privacy];
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-2">
      <span aria-hidden>{p.icon}</span>
      {p.label}
    </span>
  );
}

const VERB: Record<BulkOp['kind'], string> = {
  add: 'Adding videos',
  remove: 'Removing videos',
  move: 'Moving videos',
  'pl-delete': 'Deleting playlists',
  merge: 'Merging playlists',
  'wl-remove': 'Removing from YouTube Watch Later',
  'wl-move': 'Moving from Watch Later',
};

export function useOpProgress(opId: string | null) {
  return useLiveQuery(async () => {
    if (!opId) return undefined;
    const op = await db.bulkOps.get(opId);
    if (!op) return undefined;
    const items = await db.bulkOpItems.where('opId').equals(opId).toArray();
    return { op, items, ...summarize(items) };
  }, [opId]);
}

/** Progress for one bulk op: bar, counters, Stop / Resume / Retry failed, failure list. */
export function OpProgress({ opId, compact }: { opId: string; compact?: boolean }) {
  const p = useOpProgress(opId);
  if (!p) return null;
  const { op, total, done, failed, skipped, pending } = p;
  const processed = done + failed + skipped;
  const pct = total ? (processed / total) * 100 : 100;
  const status: Record<BulkOp['status'], string> = {
    running: `${VERB[op.kind]}…`,
    'paused-quota': op.lastError ?? 'Paused — continues after the quota resets.',
    stopped: pending ? 'Stopped. Resume continues with the remaining videos.' : 'Stopped.',
    done: 'Finished.',
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{op.label}</span>
        <span className="text-ink-2 tabular-nums">
          {processed} / {total}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="text-ok">
          ✓ {done} {op.kind === 'wl-remove' ? 'removed' : 'completed'}
        </span>
        {failed > 0 && <span className="text-danger">✗ {failed} failed</span>}
        {skipped > 0 && <span className="text-ink-3">⤼ {skipped} skipped (already there)</span>}
        {pending > 0 && <span className="text-ink-3">{pending} pending</span>}
        <span className="text-ink-3">{status[op.status]}</span>
      </div>
      <div className="flex flex-wrap gap-2 pt-1">
        {(op.status === 'running' || op.status === 'paused-quota') && (
          <Button size="sm" variant="danger-outline" onClick={() => void send({ type: 'op/stop', id: op.id })}>
            Stop
          </Button>
        )}
        {op.status === 'stopped' && pending > 0 && (
          <Button size="sm" onClick={() => void send({ type: 'op/resume', id: op.id })}>
            Resume
          </Button>
        )}
        {failed > 0 && op.status !== 'running' && (
          <Button size="sm" onClick={() => void send({ type: 'op/retry', id: op.id })}>
            Retry {failed} failed
          </Button>
        )}
      </div>
      {op.resultNote && <p className="text-xs text-ink-2">{op.resultNote}</p>}
      {!compact && failed > 0 && (
        <ul className="max-h-36 overflow-y-auto rounded-lg border border-line text-xs">
          {p.items
            .filter((i) => i.status === 'failed')
            .map((i) => (
              <li key={i.id} className="border-b border-line/60 px-3 py-1.5 last:border-0">
                <b>{i.title || i.videoId}</b> — <span className="text-ink-3">{i.error}</span>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

export function OpProgressModal({ opId, onClose }: { opId: string; onClose: () => void }) {
  const p = useOpProgress(opId);
  const finished = p && (p.op.status === 'done' || p.op.status === 'stopped');
  return (
    <Modal
      open
      onClose={onClose}
      title={finished ? 'Done' : 'Working…'}
      footer={
        <Button variant="primary" onClick={onClose}>
          {finished ? 'Close' : 'Run in background'}
        </Button>
      }
    >
      <OpProgress opId={opId} />
      {!finished && <p className="mt-4 text-xs text-ink-3">You can close this — it keeps running and survives browser restarts.</p>}
    </Modal>
  );
}

/** Active or recently finished ops touching a playlist (shown above lists). */
export function ActiveOps({ playlistId }: { playlistId?: string }) {
  const ops = useLiveQuery(async () => {
    const all = await db.bulkOps.orderBy('createdAt').reverse().limit(20).toArray();
    return all.filter(
      (o) =>
        (o.status !== 'done' || Date.now() - o.createdAt < 10 * 60 * 1000) &&
        (!playlistId || o.sourcePlaylistId === playlistId || o.destPlaylistId === playlistId),
    );
  }, [playlistId]);
  if (!ops?.length) return null;
  return (
    <div className="space-y-3">
      {ops.slice(0, 3).map((o) => (
        <div key={o.id} className="rounded-xl border border-line bg-surface p-4">
          <OpProgress opId={o.id} compact />
        </div>
      ))}
    </div>
  );
}
