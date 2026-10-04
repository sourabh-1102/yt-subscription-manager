import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { monthlySeries, type ChannelRow } from '@/features/logic';
import { addTagToChannels, removeTagFromChannels, setFavorite, setNote, setReviewLater } from '@/db/repo';
import { channelUrl } from '@/lib/youtube-urls';
import { formatDate, relativeTime } from '@/lib/time';
import { useTags } from './hooks';
import { Avatar, Button, cx } from './primitives';
import { BarColumn } from './charts';

export function ChannelDrawer({ row, onClose }: { row: ChannelRow; onClose: () => void }) {
  const tags = useTags();
  const id = row.channel.id;
  const events = useLiveQuery(() => db.watchEvents.where('channelId').equals(id).toArray(), [id]);
  const [note, setNoteText] = useState(row.note ?? '');
  useEffect(() => setNoteText(row.note ?? ''), [id, row.note]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const series = events ? monthlySeries(events, 12) : [];

  return (
    <aside
      aria-label={`Details for ${row.channel.title}`}
      className="fixed top-0 right-0 z-30 flex h-full w-full max-w-md flex-col border-l border-line bg-surface shadow-2xl"
    >
      <div className="flex items-start gap-3 border-b border-line p-5">
        <Avatar url={row.channel.thumbnailUrl} title={row.channel.title} size={56} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold">{row.channel.title || 'Unknown channel'}</h2>
          <a href={channelUrl(id)} target="_blank" rel="noopener noreferrer" className="text-xs text-accent hover:underline">
            Open on YouTube ↗
          </a>
          <div className="mt-0.5 font-mono text-[11px] text-ink-3 select-all">{id}</div>
        </div>
        <button aria-label="Close details" onClick={onClose} className="rounded px-2 text-2xl leading-none text-ink-3 hover:text-ink">
          ×
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant={row.favorite ? 'primary' : 'secondary'} onClick={() => void setFavorite([id], !row.favorite)}>
            ⭐ {row.favorite ? 'Favorite' : 'Add to favorites'}
          </Button>
          <Button size="sm" variant={row.reviewLater ? 'primary' : 'secondary'} onClick={() => void setReviewLater([id], !row.reviewLater)}>
            🕐 {row.reviewLater ? 'In Review Later' : 'Review later'}
          </Button>
        </div>

        <dl className="grid grid-cols-2 gap-3 text-sm">
          {[
            ['Videos watched', String(row.watch?.count ?? 0)],
            ['Last watched', relativeTime(row.watch?.last)],
            ['First recorded watch', formatDate(row.watch?.first)],
            ['Last upload', row.channel.lastUploadAt ? relativeTime(row.channel.lastUploadAt) : 'Unknown'],
            ['Subscribed since', formatDate(row.channel.subscribedAt)],
            ['Status', row.channel.subscribed ? 'Subscribed' : 'Not subscribed'],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg bg-surface-2 px-3 py-2">
              <dt className="text-[11px] text-ink-3">{k}</dt>
              <dd className="font-medium">{v}</dd>
            </div>
          ))}
        </dl>

        <section>
          <h3 className="mb-2 text-xs font-semibold text-ink-2 uppercase">Watches per month</h3>
          {events && events.length > 0 ? (
            <BarColumn data={series.map((s) => ({ label: s.label, value: s.count }))} height={96} unit="watch" />
          ) : (
            <p className="text-sm text-ink-3">No watches recorded yet.</p>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold text-ink-2 uppercase">Categories</h3>
          <div className="flex flex-wrap gap-1.5">
            {tags.map((t) => {
              const on = row.tagIds.includes(t.id);
              return (
                <button
                  key={t.id}
                  aria-pressed={on}
                  onClick={() => void (on ? removeTagFromChannels(t.id, [id]) : addTagToChannels(t.id, [id]))}
                  className={cx(
                    'rounded-lg border px-2 py-1 text-xs',
                    on ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-2 hover:bg-surface-2',
                  )}
                >
                  {t.emoji} {t.name}
                </button>
              );
            })}
            {tags.length === 0 && <p className="text-sm text-ink-3">No categories yet — create one in the sidebar.</p>}
          </div>
        </section>

        <section>
          <label htmlFor="note" className="mb-2 block text-xs font-semibold text-ink-2 uppercase">
            Private note
          </label>
          <textarea
            id="note"
            value={note}
            maxLength={2000}
            onChange={(e) => setNoteText(e.target.value)}
            onBlur={() => note !== (row.note ?? '') && void setNote(id, note)}
            rows={3}
            className="w-full rounded-lg border border-line bg-surface p-2.5 text-sm"
            placeholder="Why you subscribed, what to watch…"
          />
        </section>
      </div>
    </aside>
  );
}
