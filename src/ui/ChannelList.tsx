import { useRef, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ChannelRow } from '@/features/logic';
import type { Tag } from '@/lib/types';
import { relativeTime } from '@/lib/time';
import { Avatar, Chip, cx } from './primitives';
import { DRAG_MIME } from './Sidebar';
import type { Selection } from './hooks';

const BELL_LABEL = { all: '🔔 All', personalized: '🔔 Personalized', none: '🔕 None' } as const;

/**
 * Virtualized channel list — stays fast at 5,000+ rows. Rows are draggable onto sidebar
 * categories (dragging a selected row drags the whole selection).
 */
export function ChannelList({
  rows,
  tags,
  selection,
  onOpen,
  renderMeta,
  height = 'calc(100vh - 210px)',
}: {
  rows: ChannelRow[];
  tags: Tag[];
  selection: Selection;
  onOpen?: (row: ChannelRow) => void;
  /** Optional replacement for the right-hand meta column. */
  renderMeta?: (row: ChannelRow) => ReactNode;
  height?: string;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 60,
    overscan: 12,
  });
  const tagMap = new Map(tags.map((t) => [t.id, t]));
  const allSelected = rows.length > 0 && rows.every((r) => selection.selected.has(r.channel.id));

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-line px-4 py-2 text-xs text-ink-3">
        <input
          type="checkbox"
          aria-label={allSelected ? 'Deselect all shown' : 'Select all shown'}
          checked={allSelected}
          onChange={() => selection.setMany(rows.map((r) => r.channel.id), !allSelected)}
          className="h-4 w-4 accent-[var(--color-accent)]"
        />
        <span>
          {rows.length.toLocaleString()} channel{rows.length === 1 ? '' : 's'}
        </span>
      </div>
      <div ref={parentRef} className="overflow-y-auto" style={{ height }} role="list" aria-label="Channels">
        <div style={{ height: v.getTotalSize(), position: 'relative' }}>
          {v.getVirtualItems().map((vi) => {
            const r = rows[vi.index]!;
            const id = r.channel.id;
            const checked = selection.selected.has(id);
            return (
              <div
                key={id}
                role="listitem"
                draggable
                onDragStart={(e) => {
                  const ids = checked ? [...selection.selected] : [id];
                  e.dataTransfer.setData(DRAG_MIME, JSON.stringify(ids));
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                className={cx(
                  'absolute left-0 flex w-full items-center gap-3 border-b border-line/60 px-4',
                  checked ? 'bg-accent-soft/60' : 'hover:bg-surface-2/60',
                )}
                style={{ height: vi.size, transform: `translateY(${vi.start}px)` }}
              >
                <input
                  type="checkbox"
                  aria-label={`Select ${r.channel.title || id}`}
                  checked={checked}
                  onChange={() => selection.toggle(id)}
                  className="h-4 w-4 shrink-0 accent-[var(--color-accent)]"
                />
                <Avatar url={r.channel.thumbnailUrl} title={r.channel.title} size={36} />
                <button
                  className="min-w-0 flex-1 text-left"
                  onClick={() => onOpen?.(r)}
                  aria-label={`Open details for ${r.channel.title || id}`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium">{r.channel.title || <i className="text-ink-3">Unknown channel</i>}</span>
                    {r.favorite && <span title="Favorite">⭐</span>}
                    {r.reviewLater && <span title="Review later">🕐</span>}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1 overflow-hidden">
                    {r.tagIds.length === 0 && <span className="text-[11px] text-ink-3">Uncategorized</span>}
                    {r.tagIds.slice(0, 3).map((t) => {
                      const tag = tagMap.get(t);
                      return tag ? (
                        <Chip key={t}>
                          {tag.emoji} {tag.name}
                        </Chip>
                      ) : null;
                    })}
                    {r.tagIds.length > 3 && <Chip>+{r.tagIds.length - 3}</Chip>}
                  </div>
                </button>
                {renderMeta ? (
                  renderMeta(r)
                ) : (
                  <div className="hidden shrink-0 grid-cols-[110px_80px_110px] gap-3 text-right text-xs text-ink-2 md:grid">
                    <div>
                      <div className="text-[10px] text-ink-3 uppercase">Last watched</div>
                      {relativeTime(r.watch?.last)}
                    </div>
                    <div>
                      <div className="text-[10px] text-ink-3 uppercase">Watched</div>
                      <span className="tabular-nums">{r.watch?.count ?? 0}</span>
                    </div>
                    <div>
                      <div className="text-[10px] text-ink-3 uppercase">Last upload</div>
                      {r.channel.lastUploadAt ? relativeTime(r.channel.lastUploadAt) : '—'}
                    </div>
                  </div>
                )}
                {r.bellIntent && !renderMeta && (
                  <span className="hidden text-[11px] text-ink-3 lg:inline" title="Your bell plan (Bell audit)">
                    {BELL_LABEL[r.bellIntent]}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
