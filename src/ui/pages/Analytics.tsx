import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { categoryDistribution, RANGES, rangeStart, topChannels, weeklySeries, type RangeId } from '@/features/logic';
import { useChannelRows, useTags, useWatchEvents } from '../hooks';
import { Avatar, Card, cx, EmptyState, PageHeader } from '../primitives';
import { BarColumn, BarList, Stat } from '../charts';
import { TrackingBanner } from './Overview';
import { ChannelDrawer } from '../ChannelDrawer';

export function AnalyticsPage() {
  const [range, setRange] = useState<RangeId>('month');
  const [open, setOpen] = useState<string | null>(null);
  const events = useWatchEvents();
  const rows = useChannelRows({ subscribedOnly: false });
  const tags = useTags();
  const channelTags = useLiveQuery(() => db.channelTags.toArray(), []);

  const data = useMemo(() => {
    if (!events || !rows || !channelTags) return undefined;
    const from = rangeStart(range);
    const inRange = events.filter((e) => e.watchedAt >= from);
    const byId = new Map(rows.map((r) => [r.channel.id, r]));
    const tagsByChannel = new Map<string, string[]>();
    for (const ct of channelTags) tagsByChannel.set(ct.channelId, [...(tagsByChannel.get(ct.channelId) ?? []), ct.tagId]);
    const subscribedIds = new Set(rows.filter((r) => r.channel.subscribed).map((r) => r.channel.id));
    const channelsInRange = new Set(inRange.map((e) => e.channelId));
    const notSubscribed = topChannels(inRange, 0, 1000).filter((t) => !subscribedIds.has(t.channelId));
    return {
      total: inRange.length,
      channels: channelsInRange.size,
      subscribedWatched: [...channelsInRange].filter((c) => subscribedIds.has(c)).length,
      top: topChannels(inRange, 0, 15).map((t) => ({ ...t, row: byId.get(t.channelId) })),
      dist: categoryDistribution(inRange, 0, tagsByChannel),
      weekly: weeklySeries(events, 12),
      notSubscribed: notSubscribed.slice(0, 8).map((t) => ({ ...t, row: byId.get(t.channelId) })),
      counts: RANGES.map((r) => ({ ...r, n: events.filter((e) => e.watchedAt >= rangeStart(r.id)).length })),
    };
  }, [events, rows, channelTags, range]);

  const tagName = new Map(tags.map((t) => [t.id, `${t.emoji} ${t.name}`]));
  const openRow = open ? rows?.find((r) => r.channel.id === open) : undefined;
  const weekLabels = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.now() - (11 - i) * 7 * 864e5);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  });

  return (
    <div>
      <PageHeader
        title="Watch analytics"
        subtitle="Built only from watches recorded in this browser and your imported Takeout history. Nothing is uploaded."
        actions={
          <div role="tablist" aria-label="Time range" className="flex rounded-lg border border-line bg-surface p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.id}
                role="tab"
                aria-selected={range === r.id}
                onClick={() => setRange(r.id)}
                className={cx('rounded-md px-2.5 py-1 text-xs', range === r.id ? 'bg-accent text-accent-ink' : 'text-ink-2 hover:text-ink')}
              >
                {r.label}
              </button>
            ))}
          </div>
        }
      />
      <div className="space-y-5 p-6">
        <TrackingBanner />
        {!data ? (
          <p className="text-sm text-ink-3">Loading…</p>
        ) : events!.length === 0 ? (
          <EmptyState icon="📊" title="No watch data yet">
            Turn on watch tracking in Settings, or import your Google Takeout watch history to see analytics immediately.
          </EmptyState>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Videos watched" value={data.total.toLocaleString()} hint={RANGES.find((r) => r.id === range)?.label} />
              <Stat label="Channels watched" value={data.channels.toLocaleString()} />
              <Stat label="…of them subscribed" value={data.subscribedWatched.toLocaleString()} />
              <Stat label="All-time videos" value={events!.length.toLocaleString()} />
            </div>

            <Card className="p-5">
              <h2 className="mb-1 font-semibold">Videos watched per week</h2>
              <p className="mb-4 text-xs text-ink-3">Last 12 weeks</p>
              <BarColumn data={data.weekly.map((v, i) => ({ label: weekLabels[i]!, value: v }))} height={150} unit="video" />
            </Card>

            <div className="grid gap-5 lg:grid-cols-2">
              <Card className="p-5">
                <h2 className="mb-3 font-semibold">Most watched channels</h2>
                {data.top.length ? (
                  <BarList
                    data={data.top.map((t, i) => ({
                      key: t.channelId,
                      label: (
                        <button className="flex w-full items-center gap-2 text-left hover:underline" onClick={() => t.row && setOpen(t.channelId)}>
                          <span className="w-5 text-xs text-ink-3 tabular-nums">{i + 1}</span>
                          <Avatar url={t.row?.channel.thumbnailUrl} title={t.row?.channel.title ?? '?'} size={20} />
                          <span className="truncate">{t.row?.channel.title || 'Unknown channel'}</span>
                          {t.row && !t.row.channel.subscribed && <span className="text-[10px] text-ink-3">(not subscribed)</span>}
                        </button>
                      ),
                      value: t.count,
                    }))}
                  />
                ) : (
                  <p className="text-sm text-ink-3">No watches in this range.</p>
                )}
              </Card>
              <Card className="p-5">
                <h2 className="mb-1 font-semibold">Watch distribution by category</h2>
                <p className="mb-3 text-xs text-ink-3">Share of watches. A channel in two categories counts toward both.</p>
                {data.dist.length ? (
                  <BarList
                    data={data.dist.map((d) => ({
                      key: d.tagId,
                      label: d.tagId === 'untagged' ? '📂 Uncategorized' : (tagName.get(d.tagId) ?? 'Deleted category'),
                      value: d.share * 100,
                      title: `${d.count} watches`,
                    }))}
                    format={(v) => `${v.toFixed(0)}%`}
                  />
                ) : (
                  <p className="text-sm text-ink-3">No watches in this range.</p>
                )}
              </Card>
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <Card className="p-5">
                <h2 className="mb-3 font-semibold">Watch frequency</h2>
                <table className="w-full text-sm">
                  <tbody>
                    {data.counts.map((c) => (
                      <tr key={c.id} className="border-b border-line/60 last:border-0">
                        <td className="py-1.5 text-ink-2">{c.label}</td>
                        <td className="py-1.5 text-right font-medium tabular-nums">{c.n.toLocaleString()} videos</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
              <Card className="p-5">
                <h2 className="mb-1 font-semibold">Watched, but not subscribed</h2>
                <p className="mb-3 text-xs text-ink-3">Channels you keep coming back to.</p>
                {data.notSubscribed.length ? (
                  <ul className="space-y-2 text-sm">
                    {data.notSubscribed.map((t) => (
                      <li key={t.channelId} className="flex items-center gap-2">
                        <Avatar url={t.row?.channel.thumbnailUrl} title={t.row?.channel.title ?? '?'} size={20} />
                        <span className="min-w-0 flex-1 truncate">{t.row?.channel.title || 'Unknown channel'}</span>
                        <span className="text-xs text-ink-3 tabular-nums">{t.count}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-ink-3">None in this range.</p>
                )}
              </Card>
            </div>
          </>
        )}
      </div>
      {openRow && <ChannelDrawer row={openRow} onClose={() => setOpen(null)} />}
    </div>
  );
}
