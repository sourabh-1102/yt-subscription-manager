import { useEffect, useMemo, useRef, useState } from 'react';
import { applyFilters, DEFAULT_FILTERS, type ChannelRow, type Filters, type SortKey, type WatchFilter } from '@/features/logic';
import { useChannelRows, usePrefs, useRoute, useSelection, useTags } from '../hooks';
import { ChannelList } from '../ChannelList';
import { BulkBar } from '../BulkBar';
import { ChannelDrawer } from '../ChannelDrawer';
import { Button, cx, EmptyState, PageHeader, Select } from '../primitives';
import { ChannelGrid } from '../ChannelGrid';
import { AutoCategorize } from '../AutoCategorize';

const VIEW_KEY = 'ysm:view';
function readView(): 'grid' | 'list' {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}
import { ConnectPrompt } from './Overview';

export function ChannelsPage() {
  const { params } = useRoute();
  const tags = useTags();
  const prefs = usePrefs();
  const rows = useChannelRows();
  const selection = useSelection();
  const [open, setOpen] = useState<string | null>(null);
  const [f, setF] = useState<Filters>(DEFAULT_FILTERS);
  const searchRef = useRef<HTMLInputElement>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(readView);
  const [autoCat, setAutoCat] = useState(false);
  const changeView = (v: 'grid' | 'list') => {
    setViewMode(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* storage unavailable */
    }
  };

  const view = params.get('view');
  const tagParam = params.get('tag') ?? '';

  // Sidebar route drives the base filter; the filter bar refines it.
  useEffect(() => {
    setF((cur) => ({
      ...cur,
      tag: tagParam,
      favoritesOnly: view === 'favorites',
      reviewLaterOnly: view === 'review',
      watch: view === 'inactive' ? 'inactive' : cur.watch === 'inactive' && view !== 'inactive' ? 'all' : cur.watch,
    }));
    selection.clear();
  }, [view, tagParam]);

  // Sidebar ✨ opens the auto-categorize dialog via ?auto=1.
  useEffect(() => {
    if (params.get('auto') === '1') {
      setAutoCat(true);
      history.replaceState(null, '', '#/channels');
    }
  }, [params]);

  // "/" focuses search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const shown = useMemo(
    () => (rows ? applyFilters(rows, f, tags, prefs.inactiveDays) : []),
    [rows, f, tags, prefs.inactiveDays],
  );
  const openRow = open ? rows?.find((r) => r.channel.id === open) : undefined;

  const tag = tags.find((t) => t.id === tagParam);
  const title =
    view === 'favorites'
      ? '⭐ Favorites'
      : view === 'review'
        ? '🕐 Review Later'
        : view === 'inactive'
          ? '💤 Inactive'
          : tagParam === 'untagged'
            ? '📂 Uncategorized'
            : tag
              ? `${tag.emoji} ${tag.name}`
              : '📋 All subscriptions';

  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setF((x) => ({ ...x, [k]: v }));

  if (rows && rows.length === 0) {
    return (
      <>
        <PageHeader title={title} />
        <ConnectPrompt />
      </>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={title}
        subtitle={
          view === 'inactive'
            ? `Watched before, but not in the last ${prefs.inactiveDays} days.`
            : 'Categories, favorites and notes are stored only in this browser — they never change your YouTube account.'
        }
        actions={
          <>
            <Button variant="primary" onClick={() => setAutoCat(true)}>
              ✨ Auto-categorize
            </Button>
            <div role="group" aria-label="View" className="flex rounded-lg border border-line bg-surface p-0.5">
              {(['grid', 'list'] as const).map((m) => (
                <button
                  key={m}
                  aria-pressed={viewMode === m}
                  onClick={() => changeView(m)}
                  className={cx('rounded-md px-2.5 py-1 text-xs', viewMode === m ? 'bg-accent text-accent-ink' : 'text-ink-2 hover:text-ink')}
                >
                  {m === 'grid' ? '▦ Cards' : '☰ List'}
                </button>
              ))}
            </div>
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <input
          ref={searchRef}
          type="search"
          value={f.q}
          onChange={(e) => set('q', e.target.value)}
          placeholder="Search channels, categories, notes…  ( / )"
          aria-label="Search channels"
          className="h-8 min-w-56 flex-1 rounded-lg border border-line bg-surface px-3 text-sm"
        />
        <Select<string>
          label="Category"
          value={f.tag}
          onChange={(v) => set('tag', v)}
          options={[
            { value: '', label: 'All categories' },
            { value: 'untagged', label: 'Uncategorized' },
            ...tags.map((t) => ({ value: t.id, label: `${t.emoji} ${t.name}` })),
          ]}
        />
        <Select<WatchFilter>
          label="Watch status"
          value={f.watch}
          onChange={(v) => set('watch', v)}
          options={[
            { value: 'all', label: 'Any watch status' },
            { value: 'watched', label: 'Watched' },
            { value: 'never', label: 'Never watched' },
            { value: 'active', label: 'Active' },
            { value: 'inactive', label: 'Inactive' },
          ]}
        />
        <Select<Filters['bell']>
          label="Bell plan"
          value={f.bell}
          onChange={(v) => set('bell', v)}
          options={[
            { value: 'any', label: 'Any bell plan' },
            { value: 'all', label: '🔔 All' },
            { value: 'personalized', label: '🔔 Personalized' },
            { value: 'none', label: '🔕 None' },
            { value: 'unset', label: 'No bell plan' },
          ]}
        />
        <Select<string>
          label="Sort"
          value={`${f.sort}:${f.dir}`}
          onChange={(v) => {
            const [s, d] = v.split(':') as [SortKey, 'asc' | 'desc'];
            setF((x) => ({ ...x, sort: s, dir: d }));
          }}
          options={[
            { value: 'title:asc', label: 'Name A–Z' },
            { value: 'title:desc', label: 'Name Z–A' },
            { value: 'lastWatched:desc', label: 'Recently watched' },
            { value: 'lastWatched:asc', label: 'Least recently watched' },
            { value: 'watchCount:desc', label: 'Most watched' },
            { value: 'watchCount:asc', label: 'Least watched' },
            { value: 'lastUpload:desc', label: 'Latest upload' },
            { value: 'lastUpload:asc', label: 'Oldest upload' },
            { value: 'subscribedAt:desc', label: 'Newest subscription' },
            { value: 'subscribedAt:asc', label: 'Oldest subscription' },
          ]}
        />
      </div>
      <BulkBar selection={selection} rows={rows ?? []} />
      {!rows ? (
        <p className="p-6 text-sm text-ink-3">Loading…</p>
      ) : shown.length === 0 ? (
        <EmptyState icon="🔍" title="No channels match">
          Try a different search or filter.
        </EmptyState>
      ) : (
        viewMode === 'grid' ? (
          <ChannelGrid rows={shown} tags={tags} selection={selection} inactiveDays={prefs.inactiveDays} onOpen={(r: ChannelRow) => setOpen(r.channel.id)} />
        ) : (
          <ChannelList rows={shown} tags={tags} selection={selection} onOpen={(r: ChannelRow) => setOpen(r.channel.id)} />
        )
      )}
      {autoCat && rows && <AutoCategorize rows={rows} onClose={() => setAutoCat(false)} />}
      {openRow && <ChannelDrawer row={openRow} onClose={() => setOpen(null)} />}
    </div>
  );
}
