import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import type { UnsubscribedEntry, UnsubStatus } from '@/lib/types';
import { formatDate } from '@/lib/time';
import { channelUrl } from '@/lib/youtube-urls';
import { useTags } from '../hooks';
import { Avatar, Button, Card, Chip, ConfirmDialog, cx, EmptyState, PageHeader, Select, useToast } from '../primitives';
import { BatchProgress, ReviewAssistant, type ReviewItem } from '../ReviewAssistant';

const STATUS: Record<UnsubStatus, { label: string; cls: string }> = {
  pending: { label: 'Queued', cls: 'text-ink-2' },
  unsubscribed: { label: 'Unsubscribed', cls: 'text-ink-2' },
  failed: { label: 'Failed', cls: 'text-danger' },
  resubscribed: { label: 'Re-subscribed', cls: 'text-ok' },
  'resubscribe-pending': { label: 'Re-subscribing…', cls: 'text-accent' },
  'resubscribe-failed': { label: 'Re-subscribe failed', cls: 'text-danger' },
};

/** 🗑 Unsubscribed dashboard: everything unsubscribed through the extension, with re-subscribe. */
export function UnsubscribedPage() {
  const entries = useLiveQuery(() => db.unsubscribed.toArray(), []);
  const batches = useLiveQuery(() => db.batches.toArray(), []);
  const tags = useTags();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'all' | 'unsubscribed' | 'resubscribed' | 'failed'>('all');
  const [batchFilter, setBatchFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [review, setReview] = useState<ReviewItem[] | null>(null);
  const [forget, setForget] = useState(false);

  const active = batches?.filter((b) => b.status === 'running' || b.status === 'paused-quota') ?? [];
  const recentFinished = (batches ?? [])
    .filter((b) => b.status === 'done' && Date.now() - b.confirmedAt < 864e5)
    .sort((a, b) => b.confirmedAt - a.confirmedAt)
    .slice(0, 2);

  const shown = useMemo(() => {
    if (!entries) return [];
    const ql = q.trim().toLowerCase();
    return entries
      .filter((e) => {
        if (batchFilter && e.batchId !== batchFilter) return false;
        if (status === 'unsubscribed' && e.status !== 'unsubscribed') return false;
        if (status === 'resubscribed' && e.status !== 'resubscribed') return false;
        if (status === 'failed' && !e.status.includes('failed')) return false;
        if (ql && !e.title.toLowerCase().includes(ql)) return false;
        return true;
      })
      .sort((a, b) => (b.doneAt ?? b.queuedAt) - (a.doneAt ?? a.queuedAt));
  }, [entries, q, status, batchFilter]);

  const batchOptions = useMemo(() => {
    const m = new Map<string, { at: number; n: number }>();
    for (const e of entries ?? []) {
      const cur = m.get(e.batchId);
      m.set(e.batchId, { at: Math.min(cur?.at ?? Infinity, e.queuedAt), n: (cur?.n ?? 0) + 1 });
    }
    return [...m].sort((a, b) => b[1].at - a[1].at);
  }, [entries]);

  const tagMap = new Map(tags.map((t) => [t.id, t]));
  const resubscribable = (e: UnsubscribedEntry) => e.status === 'unsubscribed' || e.status === 'resubscribe-failed';
  const selectable = shown.filter(resubscribable);
  const allSel = selectable.length > 0 && selectable.every((e) => selected.has(e.id));

  const openReview = (list: UnsubscribedEntry[]) =>
    setReview(
      list.filter(resubscribable).map((e) => ({
        id: e.id,
        title: e.title,
        thumbnailUrl: e.thumbnailUrl,
        detail: `Unsubscribed ${formatDate(e.doneAt)}`,
      })),
    );

  return (
    <div>
      <PageHeader
        title="🗑 Unsubscribed"
        subtitle="Every channel you unsubscribed with this extension. Made a mistake? Re-subscribe — categories and favorites come back too."
        actions={
          <Button variant="ghost" onClick={() => setForget(true)} disabled={!entries?.some((e) => e.status === 'resubscribed' || e.status === 'unsubscribed')}>
            Clear history…
          </Button>
        }
      />
      <div className="space-y-4 p-6">
        {[...active, ...recentFinished].map((b) => (
          <Card key={b.id} className="p-4">
            <div className="mb-2 text-xs text-ink-3">
              {b.kind === 'unsubscribe' ? 'Unsubscribe' : 'Re-subscribe'} batch · confirmed {formatDate(b.confirmedAt)}
            </div>
            <BatchProgress batchId={b.id} compact />
          </Card>
        ))}

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search unsubscribed channels…"
            aria-label="Search unsubscribed channels"
            className="h-8 min-w-56 flex-1 rounded-lg border border-line bg-surface px-3 text-sm"
          />
          <Select
            label="Status"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all', label: 'All statuses' },
              { value: 'unsubscribed', label: 'Unsubscribed' },
              { value: 'resubscribed', label: 'Re-subscribed' },
              { value: 'failed', label: 'Failed' },
            ]}
          />
          <Select
            label="Batch"
            value={batchFilter}
            onChange={setBatchFilter}
            options={[
              { value: '', label: 'All batches' },
              ...batchOptions.map(([id, b]) => ({ value: id, label: `${formatDate(b.at)} · ${b.n} channels` })),
            ]}
          />
        </div>

        {selected.size > 0 && (
          <div className="flex items-center gap-2 rounded-lg bg-accent-soft px-4 py-2 text-sm">
            <b>{selected.size} selected</b>
            <Button size="sm" variant="primary" onClick={() => openReview(shown.filter((e) => selected.has(e.id)))}>
              Re-subscribe…
            </Button>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </div>
        )}

        {!entries ? null : shown.length === 0 ? (
          <EmptyState icon="🗑" title="Nothing here">
            Channels you unsubscribe through the Review Assistant appear here so you can undo mistakes.
          </EmptyState>
        ) : (
          <Card>
            <div className="flex items-center gap-3 border-b border-line px-4 py-2 text-xs text-ink-3">
              <input
                type="checkbox"
                aria-label="Select all re-subscribable"
                checked={allSel}
                onChange={() => setSelected(allSel ? new Set() : new Set(selectable.map((e) => e.id)))}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
              {shown.length} entries
            </div>
            <ul>
              {shown.map((e) => (
                <li key={e.id} className="flex items-center gap-3 border-b border-line/60 px-4 py-2.5 last:border-0">
                  <input
                    type="checkbox"
                    aria-label={`Select ${e.title}`}
                    disabled={!resubscribable(e)}
                    checked={selected.has(e.id)}
                    onChange={() =>
                      setSelected((s) => {
                        const n = new Set(s);
                        if (n.has(e.id)) n.delete(e.id);
                        else n.add(e.id);
                        return n;
                      })
                    }
                    className="h-4 w-4 accent-[var(--color-accent)] disabled:opacity-30"
                  />
                  <Avatar url={e.thumbnailUrl} title={e.title} size={34} />
                  <div className="min-w-0 flex-1">
                    <a href={channelUrl(e.channelId)} target="_blank" rel="noopener noreferrer" className="truncate font-medium hover:underline">
                      {e.title || e.channelId}
                    </a>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-ink-3">
                      <span>{e.doneAt ? `Unsubscribed ${formatDate(e.doneAt)}` : `Queued ${formatDate(e.queuedAt)}`}</span>
                      {e.tagIds.map((t) => {
                        const tag = tagMap.get(t);
                        return tag ? (
                          <Chip key={t}>
                            {tag.emoji} {tag.name}
                          </Chip>
                        ) : null;
                      })}
                      {e.flags?.favorite === 1 && <Chip>⭐</Chip>}
                    </div>
                    {e.error && <div className="mt-0.5 text-[11px] text-danger">{e.error}</div>}
                  </div>
                  <span className={cx('text-xs', STATUS[e.status].cls)}>{STATUS[e.status].label}</span>
                  {resubscribable(e) && (
                    <Button size="sm" onClick={() => openReview([e])}>
                      Re-subscribe
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
      {review && (
        <ReviewAssistant
          kind="resubscribe"
          items={review}
          onClose={() => {
            setReview(null);
            setSelected(new Set());
          }}
        />
      )}
      <ConfirmDialog
        open={forget}
        title="Clear unsubscribe history?"
        danger
        confirmLabel="Clear history"
        body="Removes finished entries (unsubscribed and re-subscribed) from this list. You will no longer be able to re-subscribe from here. Your YouTube account is not changed."
        onConfirm={async () => {
          await db.unsubscribed.where('status').anyOf('unsubscribed', 'resubscribed').delete();
          toast('History cleared');
        }}
        onClose={() => setForget(false)}
      />
    </div>
  );
}
