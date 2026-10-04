import { useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { formatDuration } from '@/features/watch-later';
import { formatDate } from '@/lib/time';
import { videoUrl } from '@/lib/youtube-urls';
import { cx } from '../primitives';
import { Thumb } from './common';

export interface VideoRow {
  /** Unique row key (playlistItem id, or video id for Watch Later). */
  key: string;
  videoId: string;
  title: string;
  channelTitle?: string;
  thumbnailUrl?: string;
  duration?: string;
  publishedAt?: number;
  addedAt?: number;
  /** 0-based playlist position (shown 1-based). */
  position?: number;
  unavailable?: boolean;
}

const ROW_H = 76;

/**
 * Virtualized video list (thousands of rows, ~20 DOM nodes).
 * Selection: click checkbox; Shift+click selects the range from the last clicked row.
 * Reorder: drag the ☰ handle; the list only changes after YouTube confirms (onReorder resolves).
 */
export function VideoList({
  rows,
  selected,
  onSelectedChange,
  onRemove,
  onAdd,
  reorderable,
  onReorder,
  height = 'calc(100vh - 330px)',
  empty,
}: {
  rows: VideoRow[];
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
  onRemove?: (row: VideoRow) => void;
  onAdd?: (row: VideoRow) => void;
  reorderable?: boolean;
  onReorder?: (row: VideoRow, toIndex: number) => Promise<void>;
  height?: string;
  empty?: React.ReactNode;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const lastClicked = useRef<number | null>(null);
  const shiftDown = useRef(false);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => ROW_H, overscan: 10 });

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.key));

  const toggle = (index: number, shift: boolean) => {
    const next = new Set(selected);
    const row = rows[index]!;
    const turnOn = !selected.has(row.key);
    if (shift && lastClicked.current !== null) {
      const [a, b] = [Math.min(lastClicked.current, index), Math.max(lastClicked.current, index)];
      for (let i = a; i <= b; i++) {
        if (turnOn) next.add(rows[i]!.key);
        else next.delete(rows[i]!.key);
      }
    } else if (turnOn) next.add(row.key);
    else next.delete(row.key);
    lastClicked.current = index;
    onSelectedChange(next);
  };

  if (!rows.length) return <>{empty}</>;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-line px-4 py-2 text-xs text-ink-3">
        <input
          type="checkbox"
          aria-label={allSelected ? 'Deselect all' : 'Select all'}
          checked={allSelected}
          onChange={() => onSelectedChange(allSelected ? new Set() : new Set(rows.map((r) => r.key)))}
          className="h-4 w-4 accent-[var(--color-accent)]"
        />
        <span>{rows.length.toLocaleString()} videos</span>
        <span className="ml-auto hidden sm:inline">Shift+click to select a range{reorderable ? ' · drag ☰ to reorder' : ''}</span>
      </div>
      {saving && (
        <div role="status" className="border-b border-line bg-accent-soft px-4 py-1.5 text-xs">
          Saving new order on YouTube…
        </div>
      )}
      <div ref={parentRef} className="overflow-y-auto" style={{ height }} role="list" aria-label="Videos">
        <div style={{ height: v.getTotalSize(), position: 'relative' }}>
          {v.getVirtualItems().map((vi) => {
            const r = rows[vi.index]!;
            const checked = selected.has(r.key);
            return (
              <div
                key={r.key}
                role="listitem"
                onDragOver={(e) => {
                  if (!dragKey) return;
                  e.preventDefault();
                  setOverIndex(vi.index);
                }}
                onDrop={async (e) => {
                  e.preventDefault();
                  const from = rows.find((x) => x.key === dragKey);
                  setDragKey(null);
                  setOverIndex(null);
                  if (!from || !onReorder || from.key === r.key) return;
                  setSaving(from.key);
                  try {
                    await onReorder(from, vi.index);
                  } finally {
                    setSaving(null);
                  }
                }}
                className={cx(
                  'absolute left-0 flex w-full items-center gap-3 border-b border-line/60 px-4',
                  checked ? 'bg-accent-soft/50' : 'hover:bg-surface-2/60',
                  overIndex === vi.index && dragKey && 'border-t-2 border-t-accent',
                  saving === r.key && 'opacity-50',
                )}
                style={{ height: vi.size, transform: `translateY(${vi.start}px)` }}
              >
                {reorderable && (
                  <span
                    draggable={!saving}
                    onDragStart={(e) => {
                      setDragKey(r.key);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => {
                      setDragKey(null);
                      setOverIndex(null);
                    }}
                    title="Drag to reorder"
                    aria-label={`Reorder ${r.title}`}
                    className="cursor-grab px-1 text-ink-3 select-none hover:text-ink"
                  >
                    ☰
                  </span>
                )}
                <input
                  type="checkbox"
                  aria-label={`Select ${r.title}`}
                  checked={checked}
                  // Record Shift before the click; toggle in onChange so React keeps the box in sync.
                  onMouseDown={(e) => (shiftDown.current = e.shiftKey)}
                  onKeyDown={(e) => (shiftDown.current = e.shiftKey)}
                  onChange={() => {
                    toggle(vi.index, shiftDown.current);
                    shiftDown.current = false;
                  }}
                  className="h-4 w-4 shrink-0 accent-[var(--color-accent)]"
                />
                {r.position !== undefined && <span className="w-8 shrink-0 text-right text-xs text-ink-3 tabular-nums">{r.position + 1}</span>}
                <a href={videoUrl(r.videoId)} target="_blank" rel="noopener noreferrer" className="relative shrink-0" tabIndex={-1}>
                  <Thumb url={r.thumbnailUrl} alt="" className="aspect-video w-24" />
                  {r.duration && (
                    <span className="absolute right-1 bottom-1 rounded bg-black/80 px-1 text-[10px] text-white tabular-nums">
                      {formatDuration(r.duration)}
                    </span>
                  )}
                </a>
                <div className="min-w-0 flex-1">
                  <a
                    href={videoUrl(r.videoId)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cx('line-clamp-1 text-sm font-medium hover:underline', r.unavailable && 'text-ink-3 italic')}
                  >
                    {r.title || r.videoId}
                  </a>
                  <div className="truncate text-xs text-ink-3">
                    {[r.channelTitle, r.publishedAt ? `published ${formatDate(r.publishedAt)}` : '', r.addedAt ? `added ${formatDate(r.addedAt)}` : '']
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {onAdd && (
                    <button
                      onClick={() => onAdd(r)}
                      title="Add to playlist"
                      aria-label={`Add ${r.title} to a playlist`}
                      className="rounded-md px-2 py-1 text-xs text-ink-2 hover:bg-surface-2 hover:text-ink"
                    >
                      ＋ Playlist
                    </button>
                  )}
                  {onRemove && (
                    <button
                      onClick={() => onRemove(r)}
                      title="Remove"
                      aria-label={`Remove ${r.title}`}
                      className="rounded-md px-2 py-1 text-xs text-danger hover:bg-danger-soft"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
