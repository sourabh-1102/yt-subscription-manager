/**
 * Minimal single-series charts in plain HTML/CSS (no chart library).
 * One accent hue (single series → no legend), thin bars with 4px rounded data-ends anchored
 * to the baseline, 2px gaps, recessive axes, direct labels and a hover/focus tooltip.
 */
import { useState } from 'react';

export function BarColumn({
  data,
  height = 140,
  unit,
}: {
  data: { label: string; value: number }[];
  height?: number;
  unit: string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const [hover, setHover] = useState<number | null>(null);
  return (
    <figure>
      <div className="relative flex items-end gap-[2px] border-b border-line" style={{ height }}>
        {data.map((d, i) => (
          <div
            key={i}
            tabIndex={0}
            aria-label={`${d.label}: ${d.value} ${unit}${d.value === 1 ? '' : 'es'}`}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(i)}
            onBlur={() => setHover(null)}
            className="relative flex h-full flex-1 items-end outline-none"
          >
            <div
              className="w-full rounded-t-[4px] bg-accent transition-opacity"
              style={{ height: `${(d.value / max) * 100}%`, minHeight: d.value ? 2 : 0, opacity: hover === null || hover === i ? 1 : 0.45 }}
            />
            {hover === i && (
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 rounded-md border border-line bg-surface px-2 py-1 text-xs whitespace-nowrap shadow">
                <b className="tabular-nums">{d.value}</b> <span className="text-ink-3">· {d.label}</span>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-[2px] text-[10px] text-ink-3">
        {data.map((d, i) => (
          <div key={i} className="flex-1 truncate text-center">
            {data.length > 14 && i % 2 ? '' : d.label}
          </div>
        ))}
      </div>
    </figure>
  );
}

/** Horizontal labelled bars: label · bar · value. */
export function BarList({
  data,
  format = (v) => v.toLocaleString(),
}: {
  data: { key: string; label: React.ReactNode; value: number; title?: string }[];
  format?: (v: number) => string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <ul className="space-y-2">
      {data.map((d) => (
        <li key={d.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_56px] items-center gap-3 text-sm" title={d.title}>
          <div className="min-w-0 truncate">{d.label}</div>
          <div className="h-2.5 rounded-r-[4px] bg-surface-2">
            <div className="h-full rounded-r-[4px] bg-accent" style={{ width: `${(d.value / max) * 100}%`, minWidth: d.value ? 2 : 0 }} />
          </div>
          <div className="text-right text-xs text-ink-2 tabular-nums">{format(d.value)}</div>
        </li>
      ))}
    </ul>
  );
}

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3.5">
      <div className="text-xs text-ink-2">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-ink-3">{hint}</div>}
    </div>
  );
}
