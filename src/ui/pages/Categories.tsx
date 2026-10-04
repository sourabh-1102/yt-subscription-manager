import { useMemo, useState } from 'react';
import { activityOf, type ChannelRow } from '@/features/logic';
import type { Tag } from '@/lib/types';
import { useChannelRows, usePrefs, useTags } from '../hooks';
import { Avatar, Button, Card, PageHeader } from '../primitives';
import { AutoCategorize } from '../AutoCategorize';
import { TagEditor } from '../Sidebar';
import { ConnectPrompt } from './Overview';

export interface CategoryCardData {
  id: string;
  emoji: string;
  name: string;
  count: number;
  active: number;
  faces: ChannelRow[];
}

/** One card per category: count, active share, most-watched faces (same data as before). */
export function useCategoryCards(rows: ChannelRow[] | undefined, tags: Tag[], inactiveDays: number): CategoryCardData[] {
  return useMemo(() => {
    if (!rows) return [];
    return tags
      .map((t) => {
        const members = rows.filter((r) => r.tagIds.includes(t.id));
        return {
          id: t.id,
          emoji: t.emoji,
          name: t.name,
          count: members.length,
          active: members.filter((r) => activityOf(r, inactiveDays) === 'active').length,
          faces: [...members].sort((a, b) => (b.watch?.count ?? 0) - (a.watch?.count ?? 0)).slice(0, 5),
        };
      })
      .filter((c) => c.count > 0)
      .sort((a, b) => b.count - a.count);
  }, [rows, tags, inactiveDays]);
}

/** The category cards grid (moved unchanged from the Overview page). */
export function CategoryGrid({
  cards,
  uncategorized,
  total,
  onAutoCategorize,
}: {
  cards: CategoryCardData[];
  uncategorized: number;
  total: number;
  onAutoCategorize: () => void;
}) {
  if (cards.length === 0)
    return (
      <Card className="flex flex-wrap items-center justify-between gap-4 rounded-2xl p-6">
        <div>
          <div className="font-semibold">No categories yet</div>
          <div className="text-sm text-ink-2">Let the extension sort all {total} channels for you — you review before anything is saved.</div>
        </div>
        <Button variant="primary" onClick={onAutoCategorize}>
          Auto-categorize now
        </Button>
      </Card>
    );
  return (
    <div className="grid grid-cols-1 gap-4 min-[480px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {cards.map((c) => (
        <a key={c.id} href={`#/channels?tag=${c.id}`} className="group min-w-0 rounded-2xl border border-line bg-surface p-5 transition-colors hover:border-accent">
          <div className="flex items-start justify-between gap-2">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-2xl" aria-hidden>
              {c.emoji}
            </span>
            <span className="text-2xl font-bold tabular-nums">{c.count}</span>
          </div>
          <div className="mt-3 truncate font-semibold group-hover:text-accent" title={c.name}>
            {c.name}
          </div>
          <div className="mt-3 flex -space-x-2 overflow-hidden">
            {c.faces.map((r) => (
              <span key={r.channel.id} className="rounded-full ring-2 ring-surface" title={r.channel.title}>
                <Avatar url={r.channel.thumbnailUrl} title={r.channel.title} size={28} />
              </span>
            ))}
            {c.count > c.faces.length && (
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-surface-2 text-[10px] text-ink-2 ring-2 ring-surface">
                +{c.count - c.faces.length}
              </span>
            )}
          </div>
          <div className="mt-4">
            <div className="mb-1 flex justify-between text-[11px] text-ink-3">
              <span>Active</span>
              <span className="tabular-nums">
                {c.active}/{c.count}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-accent" style={{ width: `${(c.active / Math.max(1, c.count)) * 100}%` }} />
            </div>
          </div>
        </a>
      ))}
      {uncategorized > 0 && (
        <button
          onClick={onAutoCategorize}
          className="flex min-w-0 flex-col items-start rounded-2xl border-2 border-dashed border-line p-5 text-left transition hover:border-accent hover:bg-accent-soft/40"
        >
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-surface-2 text-2xl" aria-hidden>
            📂
          </span>
          <div className="mt-3 font-semibold">{uncategorized} uncategorized</div>
          <div className="mt-1 text-sm text-accent">Sort them automatically →</div>
        </button>
      )}
    </div>
  );
}

/** Full page with every category and its actions. */
export function CategoriesPage() {
  const rows = useChannelRows();
  const tags = useTags();
  const prefs = usePrefs();
  const cards = useCategoryCards(rows, tags, prefs.inactiveDays);
  const [autoCat, setAutoCat] = useState(false);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');
  const uncategorized = rows?.filter((r) => !r.tagIds.length).length ?? 0;
  const shown = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return ql ? cards.filter((c) => c.name.toLowerCase().includes(ql)) : cards;
  }, [cards, q]);

  if (rows && rows.length === 0)
    return (
      <>
        <PageHeader title="📚 Your Categories" />
        <ConnectPrompt />
      </>
    );

  return (
    <div>
      <PageHeader
        title="📚 Your Categories"
        subtitle={`Your subscribed channels, organized by topic · ${cards.length} categories${uncategorized ? ` · ${uncategorized} uncategorized` : ''}`}
        actions={
          <>
            <Button onClick={() => setCreating(true)}>+ New category</Button>
            <Button variant="primary" onClick={() => setAutoCat(true)}>
              Auto-categorize
            </Button>
          </>
        }
      />
      <div className="space-y-4 p-6">
        {cards.length > 6 && (
          <input
            type="search"
            name="q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search categories…"
            aria-label="Search categories"
            className="h-8 w-full max-w-sm rounded-lg border border-line bg-surface px-3 text-sm"
          />
        )}
        <CategoryGrid cards={shown} uncategorized={q ? 0 : uncategorized} total={rows?.length ?? 0} onAutoCategorize={() => setAutoCat(true)} />
        <p className="text-xs text-ink-3">Rename, change the icon, reorder or delete a category from the ⋯ menu next to it in the sidebar.</p>
      </div>
      {autoCat && rows && <AutoCategorize rows={rows} onClose={() => setAutoCat(false)} />}
      {creating && <TagEditor open onClose={() => setCreating(false)} />}
    </div>
  );
}
