import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { activityOf, rangeStart, topChannels } from '@/features/logic';
import { formatDate, relativeTime } from '@/lib/time';
import { useAuth, useChannelRows, usePrefs, useTags, useWatchEvents } from '../hooks';
import { Avatar, Button, Card, EmptyState, Notice, PageHeader } from '../primitives';
import { BarList } from '../charts';
import { BatchProgress } from '../ReviewAssistant';
import { AutoCategorize } from '../AutoCategorize';
import { Thumb } from '../playlists/common';
import { useCategoryCards } from './Categories';

/** Playlists + Watch Later summary cards (Playlist Manager entry points). */
function LibraryCards() {
  const lib = useLiveQuery(async () => {
    const playlists = await db.playlists.toArray();
    const wl = await db.watchLater.filter((w) => !w.hidden).toArray();
    return {
      count: playlists.length,
      videos: playlists.reduce((n, p) => n + p.itemCount, 0),
      top: [...playlists].sort((a, b) => b.itemCount - a.itemCount).slice(0, 3),
      wlCount: wl.length,
      wlThumbs: wl.filter((w) => w.thumbnailUrl).slice(0, 3),
    };
  }, []);
  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold">Your library</h2>
      <div className="grid gap-4 md:grid-cols-2">
        <a href="#/playlists" className="group flex gap-4 rounded-2xl border border-line bg-surface p-5 transition-colors hover:border-accent">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm text-ink-2">
              <span aria-hidden>📚</span> Playlists
            </div>
            <div className="mt-2 text-3xl font-bold tabular-nums">{lib?.count ?? 0}</div>
            <div className="text-xs text-ink-3">{lib?.count ? `${lib.videos.toLocaleString()} videos in total` : 'Open to load your playlists'}</div>
            <div className="mt-3 text-sm text-accent">Manage playlists →</div>
          </div>
          <div className="hidden w-40 shrink-0 flex-col gap-1.5 sm:flex">
            {lib?.top.map((p) => (
              <div key={p.id} className="flex items-center gap-2">
                <Thumb url={p.thumbnailUrl} alt="" className="aspect-video w-14 rounded" />
                <span className="truncate text-xs text-ink-2">{p.title}</span>
              </div>
            ))}
          </div>
        </a>
        <a href="#/watch-later" className="group flex gap-4 rounded-2xl border border-line bg-surface p-5 transition-colors hover:border-accent">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm text-ink-2">
              <span aria-hidden>🔖</span> Watch Later
            </div>
            <div className="mt-2 text-3xl font-bold tabular-nums">{lib?.wlCount ?? 0}</div>
            <div className="text-xs text-ink-3">{lib?.wlCount ? 'videos imported from Takeout' : 'Import from Google Takeout'}</div>
            <div className="mt-3 text-sm text-accent">Open Watch Later →</div>
          </div>
          <div className="hidden w-40 shrink-0 grid-cols-2 gap-1.5 sm:grid">
            {lib?.wlThumbs.map((w) => <Thumb key={w.videoId} url={w.thumbnailUrl} alt="" className="aspect-video w-full rounded" />)}
          </div>
        </a>
      </div>
    </section>
  );
}

export function ConnectPrompt() {
  const auth = useAuth();
  return (
    <EmptyState icon="📭" title="No subscriptions here yet">
      <p>
        {auth.signedIn
          ? 'Your account is connected but no subscriptions were found. Try “Sync now” in Settings.'
          : 'Connect your YouTube account, import your Google Takeout subscriptions file, or load demo data to explore.'}
      </p>
      <div className="mt-4 flex justify-center gap-2">
        <Button variant="primary" onClick={() => (window.location.hash = '/settings')}>
          Open Settings
        </Button>
      </div>
    </EmptyState>
  );
}

export function TrackingBanner() {
  const prefs = usePrefs();
  if (prefs.trackingEnabled)
    return (
      <Notice>
        Watch analytics started <b>{formatDate(prefs.trackingStartedAt)}</b>. Earlier history isn’t available from YouTube’s API — import your
        Google Takeout watch history in Settings to fill the gap. “Never watched” only means “not since tracking started”.
      </Notice>
    );
  return (
    <Notice tone="warn">
      Watch tracking is <b>off</b>, so analytics can’t tell which channels you watch. Turn it on in{' '}
      <a href="#/settings" className="font-medium text-accent underline">
        Settings
      </a>{' '}
      (stays on this device) or import your Takeout watch history.
    </Notice>
  );
}

/** Flat stat cards; a small solid status dot carries the meaning (with the label, never color alone). */
const STAT_CARDS = [
  { key: 'watched', label: 'Channels watched', dot: 'bg-accent' },
  { key: 'active', label: 'Active', dot: 'bg-ok' },
  { key: 'inactive', label: 'Inactive', dot: 'bg-warn' },
  { key: 'never', label: 'Never watched', dot: 'bg-ink-3' },
] as const;

export function OverviewPage() {
  const rows = useChannelRows();
  const prefs = usePrefs();
  const auth = useAuth();
  const tags = useTags();
  const events = useWatchEvents();
  const activeBatches = useLiveQuery(() => db.batches.where('status').anyOf('running', 'paused-quota').toArray(), []);
  const [autoCat, setAutoCat] = useState(false);

  const summary = useMemo(() => {
    if (!rows) return undefined;
    let watched = 0;
    let active = 0;
    let favorites = 0;
    let uncategorized = 0;
    for (const r of rows) {
      if (r.watch) watched++;
      if (activityOf(r, prefs.inactiveDays) === 'active') active++;
      if (r.favorite) favorites++;
      if (!r.tagIds.length) uncategorized++;
    }
    return { total: rows.length, watched, never: rows.length - watched, active, inactive: watched - active, favorites, uncategorized };
  }, [rows, prefs.inactiveDays]);

  const categoryCards = useCategoryCards(rows, tags, prefs.inactiveDays);

  const top = useMemo(() => {
    if (!events || !rows) return [];
    const byId = new Map(rows.map((r) => [r.channel.id, r]));
    return topChannels(events, rangeStart('month'), 8)
      .filter((t) => byId.has(t.channelId))
      .map((t) => ({ ...t, row: byId.get(t.channelId)! }));
  }, [events, rows]);

  const recent = useMemo(
    () => (rows ? [...rows].filter((r) => r.watch).sort((a, b) => b.watch!.last - a.watch!.last).slice(0, 6) : []),
    [rows],
  );

  if (rows && rows.length === 0) {
    return (
      <>
        <PageHeader title="Overview" />
        <ConnectPrompt />
      </>
    );
  }

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const statHint: Record<(typeof STAT_CARDS)[number]['key'], string> = {
    watched: 'at least once, recorded',
    active: `watched in last ${prefs.inactiveDays} days`,
    inactive: 'watched before, not lately',
    never: 'since tracking started',
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <section className="rounded-2xl border border-line bg-surface p-6">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="text-sm text-ink-2">
              {greeting}
              {auth.accountTitle ? `, ${auth.accountTitle}` : ''}
            </p>
            <div className="mt-1 flex items-baseline gap-3">
              <span className="text-5xl font-bold tracking-tight tabular-nums">{summary?.total.toLocaleString() ?? '—'}</span>
              <span className="text-ink-2">subscriptions</span>
            </div>
          </div>
          <dl className="flex flex-wrap gap-6 text-sm">
            {(
              [
                ['Categories', categoryCards.length],
                ['Favorites', summary?.favorites ?? 0],
                ['Uncategorized', summary?.uncategorized ?? 0],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <dt className="text-ink-3">{k}</dt>
                <dd className="text-xl font-semibold tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-5">
          {summary && summary.uncategorized > 0 && (
            <Button variant="primary" onClick={() => setAutoCat(true)}>
              Auto-categorize {summary.uncategorized} channels
            </Button>
          )}
          <Button onClick={() => (window.location.hash = '/channels')}>Browse all</Button>
          <Button onClick={() => (window.location.hash = '/cleanup')}>Clean up</Button>
        </div>
      </section>

      {activeBatches?.map((b) => (
        <Card key={b.id} className="p-4">
          <BatchProgress batchId={b.id} compact />
        </Card>
      ))}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {STAT_CARDS.map((c) => (
          <div key={c.key} className="rounded-2xl border border-line bg-surface p-5">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${c.dot}`} aria-hidden />
              <span className="text-sm text-ink-2">{c.label}</span>
            </div>
            <div className="mt-2 text-3xl font-bold tracking-tight tabular-nums">{summary?.[c.key].toLocaleString() ?? '—'}</div>
            <div className="mt-0.5 text-xs text-ink-3">{statHint[c.key]}</div>
          </div>
        ))}
      </div>

      <TrackingBanner />

      <a
        href="#/categories"
        aria-label="Open Your Categories"
        className="group flex flex-wrap items-center gap-5 rounded-2xl border border-line bg-surface p-5 transition-colors hover:border-accent"
      >
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-2xl" aria-hidden>
          📚
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-lg font-semibold group-hover:text-accent">Your Categories</span>
            <span className="text-sm text-ink-2">
              {categoryCards.length
                ? `${categoryCards.length} categories · ${(summary?.total ?? 0) - (summary?.uncategorized ?? 0)} channels organized${summary?.uncategorized ? ` · ${summary.uncategorized} uncategorized` : ''}`
                : 'No categories yet — open to sort your channels automatically'}
            </span>
          </div>
          {categoryCards.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {categoryCards.slice(0, 8).map((c) => (
                <span key={c.id} className="inline-flex max-w-40 items-center gap-1 rounded-full bg-surface-2 px-2.5 py-1 text-xs text-ink-2">
                  <span aria-hidden>{c.emoji}</span>
                  <span className="truncate">{c.name}</span>
                  <span className="text-ink-3 tabular-nums">{c.count}</span>
                </span>
              ))}
              {categoryCards.length > 8 && <span className="rounded-full px-2 py-1 text-xs text-ink-3">+{categoryCards.length - 8} more</span>}
            </div>
          )}
        </div>
        <span className="shrink-0 text-sm font-medium text-accent">View all →</span>
      </a>

      <LibraryCards />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="rounded-2xl p-5">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="font-semibold">🏆 Most watched · last 30 days</h2>
            <a href="#/analytics" className="text-xs text-accent hover:underline">
              Analytics →
            </a>
          </div>
          {top.length ? (
            <BarList
              data={top.map((t, i) => ({
                key: t.channelId,
                label: (
                  <span className="flex items-center gap-2">
                    <span className="w-4 text-xs text-ink-3 tabular-nums">{i + 1}</span>
                    <Avatar url={t.row.channel.thumbnailUrl} title={t.row.channel.title} size={20} />
                    <span className="truncate">{t.row.channel.title}</span>
                  </span>
                ),
                value: t.count,
              }))}
            />
          ) : (
            <p className="text-sm text-ink-3">No watches recorded in the last 30 days.</p>
          )}
        </Card>
        <Card className="rounded-2xl p-5">
          <h2 className="mb-3 font-semibold">🕘 Recently watched</h2>
          {recent.length ? (
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {recent.map((r) => (
                <li key={r.channel.id} className="flex items-center gap-3 rounded-xl bg-surface-2/60 p-2.5 text-sm">
                  <Avatar url={r.channel.thumbnailUrl} title={r.channel.title} size={32} />
                  <div className="min-w-0">
                    <div className="truncate font-medium">{r.channel.title}</div>
                    <div className="text-xs text-ink-3">{relativeTime(r.watch?.last)}</div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-3">Nothing yet — turn on watch tracking in Settings.</p>
          )}
        </Card>
      </div>

      {autoCat && rows && <AutoCategorize rows={rows} onClose={() => setAutoCat(false)} />}
    </div>
  );
}
