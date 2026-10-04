import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { activityOf, type ChannelRow } from '@/features/logic';
import type { Tag } from '@/lib/types';
import { relativeTime } from '@/lib/time';
import { setFavorite } from '@/db/repo';
import { Avatar, cx } from './primitives';
import { DRAG_MIME } from './Sidebar';
import type { Selection } from './hooks';

const CARD_MIN_WIDTH = 240;
const CARD_HEIGHT = 196;
const GAP = 14;

/** Status label + dot (meaning is carried by the text, the dot is decoration). */
const ACTIVITY = {
  active: { label: 'Active', dot: 'bg-ok', text: 'text-ok' },
  inactive: { label: 'Inactive', dot: 'bg-warn', text: 'text-warn' },
  never: { label: 'Never watched', dot: 'bg-ink-3', text: 'text-ink-3' },
} as const;

function ChannelCard({
  r,
  tagMap,
  checked,
  inactiveDays,
  onToggle,
  onOpen,
  dragIds,
}: {
  r: ChannelRow;
  tagMap: Map<string, Tag>;
  checked: boolean;
  inactiveDays: number;
  onToggle: () => void;
  onOpen: () => void;
  dragIds: () => string[];
}) {
  const act = ACTIVITY[activityOf(r, inactiveDays)];
  const title = r.channel.title || 'Unknown channel';
  return (
    <article
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_MIME, JSON.stringify(dragIds()));
        e.dataTransfer.effectAllowed = 'copy';
      }}
      className={cx(
        'group relative flex h-full flex-col rounded-xl border bg-surface transition-colors duration-150',
        checked ? 'border-accent bg-accent-soft/40' : 'border-line hover:border-ink-3/50',
      )}
    >
      <div className="absolute top-3 right-3 flex items-center gap-1.5">
        <button
          aria-label={r.favorite ? `Remove ${title} from favorites` : `Add ${title} to favorites`}
          aria-pressed={r.favorite}
          title={r.favorite ? 'Favorite' : 'Add to favorites'}
          onClick={() => void setFavorite([r.channel.id], !r.favorite)}
          className={cx(
            'flex h-7 w-7 items-center justify-center rounded-md text-sm transition hover:bg-surface-2',
            r.favorite ? 'text-warn opacity-100' : 'text-ink-3 opacity-0 group-hover:opacity-100 focus:opacity-100',
          )}
        >
          {r.favorite ? '★' : '☆'}
        </button>
        <input
          type="checkbox"
          aria-label={`Select ${title}`}
          checked={checked}
          onChange={onToggle}
          className={cx(
            'h-4 w-4 accent-[var(--color-accent)] transition-opacity',
            checked ? 'opacity-100' : 'opacity-40 group-hover:opacity-100 focus:opacity-100',
          )}
        />
      </div>

      <button onClick={onOpen} className="flex min-h-0 flex-1 flex-col p-4 text-left" aria-label={`Open details for ${title}`}>
        <Avatar url={r.channel.thumbnailUrl} title={title} size={44} />
        <div className="mt-3 flex w-full items-center gap-1.5 pr-1">
          <h3 className="line-clamp-1 flex-1 font-semibold" title={title}>
            {title}
          </h3>
          {r.reviewLater && (
            <span title="Review later" aria-label="In Review Later" className="text-xs">
              🕐
            </span>
          )}
        </div>
        <div className="mt-1.5 flex h-5 w-full items-center gap-1.5 overflow-hidden text-[11px]">
          <span className={cx('flex shrink-0 items-center gap-1 font-medium', act.text)}>
            <span className={cx('h-1.5 w-1.5 rounded-full', act.dot)} aria-hidden />
            {act.label}
          </span>
          <span className="text-ink-3" aria-hidden>
            ·
          </span>
          {r.tagIds.length === 0 ? (
            <span className="truncate text-ink-3">Uncategorized</span>
          ) : (
            <span className="truncate text-ink-2">
              {r.tagIds
                .map((t) => tagMap.get(t))
                .filter((t): t is Tag => !!t)
                .map((t) => `${t.emoji} ${t.name}`)
                .join(', ')}
            </span>
          )}
        </div>

        <div className="mt-auto grid w-full grid-cols-3 gap-1 border-t border-line pt-3">
          {[
            ['Watched', String(r.watch?.count ?? 0)],
            ['Last seen', r.watch ? relativeTime(r.watch.last).replace(' ago', '') : '—'],
            ['Upload', r.channel.lastUploadAt ? relativeTime(r.channel.lastUploadAt).replace(' ago', '') : '—'],
          ].map(([k, v]) => (
            <div key={k} className="min-w-0">
              <div className="truncate text-sm font-semibold tabular-nums">{v}</div>
              <div className="text-[10px] tracking-wide text-ink-3 uppercase">{k}</div>
            </div>
          ))}
        </div>
      </button>
    </article>
  );
}

/** Virtualized responsive card grid — renders only visible rows, fine at 5,000+ channels. */
export function ChannelGrid({
  rows,
  tags,
  selection,
  inactiveDays,
  onOpen,
  height = 'calc(100vh - 210px)',
}: {
  rows: ChannelRow[];
  tags: Tag[];
  selection: Selection;
  inactiveDays: number;
  onOpen: (row: ChannelRow) => void;
  height?: string;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(4);
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = (entry?.contentRect.width ?? 1000) - 32;
      setCols(Math.max(1, Math.floor((w + GAP) / (CARD_MIN_WIDTH + GAP))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rowCount = Math.ceil(rows.length / cols);
  const v = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => CARD_HEIGHT + GAP,
    overscan: 3,
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
        <span className="ml-auto hidden sm:inline">Tip: drag cards onto a category in the sidebar</span>
      </div>
      <div ref={parentRef} className="overflow-y-auto px-4 pt-4" style={{ height }} role="list" aria-label="Channels">
        <div style={{ height: v.getTotalSize(), position: 'relative' }}>
          {v.getVirtualItems().map((vr) => (
            <div
              key={vr.key}
              className="absolute left-0 grid w-full"
              style={{
                transform: `translateY(${vr.start}px)`,
                height: CARD_HEIGHT,
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                gap: GAP,
              }}
            >
              {rows.slice(vr.index * cols, vr.index * cols + cols).map((r) => {
                const id = r.channel.id;
                const checked = selection.selected.has(id);
                return (
                  <div role="listitem" key={id} className="h-full">
                    <ChannelCard
                      r={r}
                      tagMap={tagMap}
                      checked={checked}
                      inactiveDays={inactiveDays}
                      onToggle={() => selection.toggle(id)}
                      onOpen={() => onOpen(r)}
                      dragIds={() => (checked ? [...selection.selected] : [id])}
                    />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
