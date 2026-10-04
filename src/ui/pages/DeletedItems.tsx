import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import type { DeletionLogEntry, UnsubscribedEntry } from '@/lib/types';
import { clearDeletionLog } from '@/db/trash';
import { restoreCategory } from '@/db/repo';
import { formatDate, relativeTime } from '@/lib/time';
import { channelUrl, videoUrl } from '@/lib/youtube-urls';
import { DAY_MS } from '@/config/constants';
import { downloadJson } from '@/services/backup';
import { send, useAuth } from '../hooks';
import { Avatar, Button, ConfirmDialog, cx, EmptyState, Notice, PageHeader, Select, useToast } from '../primitives';
import { ActiveOps, OpProgressModal, Thumb } from '../playlists/common';
import { AddToPlaylist } from '../playlists/dialogs';

type Tab = 'all' | 'channel' | 'playlist-video' | 'playlist' | 'watch-later' | 'category';
type Range = 'all' | '1' | '7' | '30';

interface Row {
  key: string;
  kind: Exclude<Tab, 'all'>;
  at: number;
  title: string;
  context: string;
  thumb?: string;
  round?: boolean;
  href?: string;
  restored: boolean;
  restoredNote?: string;
  log?: DeletionLogEntry;
  unsub?: UnsubscribedEntry;
}

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'all', label: 'All', icon: '🗂️' },
  { id: 'channel', label: 'Channels', icon: '📺' },
  { id: 'playlist-video', label: 'Playlist videos', icon: '🎞️' },
  { id: 'playlist', label: 'Playlists', icon: '📚' },
  { id: 'watch-later', label: 'Watch Later', icon: '🔖' },
  { id: 'category', label: 'Categories', icon: '🏷️' },
];

function toRows(logs: DeletionLogEntry[], unsubs: UnsubscribedEntry[]): Row[] {
  const rows: Row[] = [];
  for (const u of unsubs) {
    if (!['unsubscribed', 'resubscribed', 'resubscribe-pending', 'resubscribe-failed'].includes(u.status)) continue;
    rows.push({
      key: `u:${u.id}`,
      kind: 'channel',
      at: u.doneAt ?? u.queuedAt,
      title: u.title || u.channelId,
      context: 'Unsubscribed',
      thumb: u.thumbnailUrl,
      round: true,
      href: channelUrl(u.channelId),
      restored: u.status === 'resubscribed',
      restoredNote: 'Re-subscribed',
      unsub: u,
    });
  }
  for (const l of logs) {
    const base = { key: l.id, at: l.at, restored: !!l.restoredAt, log: l };
    if (l.kind === 'playlist-video')
      rows.push({
        ...base,
        kind: 'playlist-video',
        title: l.title || l.videoId || 'Video',
        context: l.note ? `${l.note} · from ${l.playlistTitle ?? 'a playlist'}` : `Removed from ${l.playlistTitle ?? 'a playlist'}`,
        thumb: l.thumbnailUrl,
        href: l.videoId ? videoUrl(l.videoId) : undefined,
        restoredNote: 'Added back',
      });
    else if (l.kind === 'playlist')
      rows.push({
        ...base,
        kind: 'playlist',
        title: l.playlistTitle || 'Deleted playlist',
        context: `Playlist deleted · ${l.videos?.length ?? 0} videos saved${l.note ? ` · ${l.note}` : ''}`,
        thumb: l.thumbnailUrl,
        restoredNote: 'Recreated',
      });
    else if (l.kind === 'watch-later')
      rows.push({
        ...base,
        kind: 'watch-later',
        title: l.title || l.videoId || 'Video',
        context: `Removed from YouTube Watch Later${l.note ? ` · ${l.note}` : ''}${l.channelTitle ? ` · ${l.channelTitle}` : ''}`,
        thumb: l.thumbnailUrl ?? (l.videoId ? `https://i.ytimg.com/vi/${l.videoId}/mqdefault.jpg` : undefined),
        href: l.videoId ? videoUrl(l.videoId) : undefined,
      });
    else if (l.kind === 'category')
      rows.push({
        ...base,
        kind: 'category',
        title: `${l.tagEmoji ?? '📁'} ${l.tagName ?? 'Category'}`,
        context: `Category deleted · had ${l.channelIds?.length ?? 0} channels, ${l.playlistIds?.length ?? 0} playlists`,
        restoredNote: 'Restored',
      });
  }
  return rows.sort((a, b) => b.at - a.at);
}

/** 🗑 Deleted items — everything removed through the extension, grouped by type, with restore where possible. */
export function DeletedItemsPage() {
  const auth = useAuth();
  const toast = useToast();
  const logs = useLiveQuery(() => db.deletionLog.toArray(), []);
  const unsubs = useLiveQuery(() => db.unsubscribed.toArray(), []);
  const [tab, setTab] = useState<Tab>('all');
  const [range, setRange] = useState<Range>('all');
  const [q, setQ] = useState('');
  const [hideRestored, setHideRestored] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(200);
  const [dialog, setDialog] = useState<
    null | { kind: 'recreate'; log: DeletionLogEntry } | { kind: 'copy'; rows: Row[] } | { kind: 'clear' } | { kind: 'progress'; opId: string }
  >(null);
  const [error, setError] = useState<string | null>(null);

  const all = useMemo(() => (logs && unsubs ? toRows(logs, unsubs) : undefined), [logs, unsubs]);
  const counts = useMemo(() => {
    const c: Record<Tab, number> = { all: 0, channel: 0, 'playlist-video': 0, playlist: 0, 'watch-later': 0, category: 0 };
    for (const r of all ?? []) {
      c.all++;
      c[r.kind]++;
    }
    return c;
  }, [all]);

  const shown = useMemo(() => {
    if (!all) return [];
    const ql = q.trim().toLowerCase();
    const since = range === 'all' ? 0 : Date.now() - Number(range) * DAY_MS;
    return all.filter(
      (r) =>
        (tab === 'all' || r.kind === tab) &&
        r.at >= since &&
        (!hideRestored || !r.restored) &&
        (!ql || `${r.title} ${r.context}`.toLowerCase().includes(ql)),
    );
  }, [all, tab, range, q, hideRestored]);

  const restorableVideos = shown.filter((r) => r.kind === 'playlist-video' && !r.restored);
  const selVideoRows = restorableVideos.filter((r) => selected.has(r.key));
  const selWlRows = shown.filter((r) => r.kind === 'watch-later' && selected.has(r.key));

  const restoreVideos = async (rows: Row[]) => {
    setError(null);
    const r = await send<{ opIds: string[]; missingPlaylists: string[] }>({ type: 'trash/restoreVideos', ids: rows.map((x) => x.key) });
    if (!r.ok) return setError(r.error);
    setSelected(new Set());
    if (r.data?.missingPlaylists.length) setError(`Can’t add back to deleted playlist(s): ${r.data.missingPlaylists.join(', ')}. Recreate the playlist first.`);
    if (r.data?.opIds.length === 1) setDialog({ kind: 'progress', opId: r.data.opIds[0]! });
    else if (r.data?.opIds.length) toast(`Restoring into ${r.data.opIds.length} playlists — see progress above`);
  };

  const toggle = (key: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  return (
    <div>
      <PageHeader
        title="🗑 Deleted items"
        subtitle="Everything removed through this extension — what, when and where. Restore it where YouTube allows."
        actions={
          <>
            <Button
              disabled={!all?.length}
              onClick={() => downloadJson({ exportedAt: Date.now(), items: logs, unsubscribed: unsubs }, `deleted-items-${new Date().toISOString().slice(0, 10)}.json`)}
            >
              Export
            </Button>
            <Button variant="ghost" disabled={!logs?.length} onClick={() => setDialog({ kind: 'clear' })}>
              Clear history…
            </Button>
          </>
        }
      />
      <div className="space-y-4 p-6">
        <div role="tablist" aria-label="Type" className="flex flex-wrap gap-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => {
                setTab(t.id);
                setSelected(new Set());
              }}
              className={cx(
                'flex items-center gap-1.5 rounded-xl border px-3 py-2 text-sm transition-colors',
                tab === t.id ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface text-ink-2 hover:border-ink-3/60',
              )}
            >
              <span aria-hidden>{t.icon}</span>
              {t.label}
              <span className="rounded-md bg-surface-2 px-1.5 text-xs text-ink-3 tabular-nums">{counts[t.id]}</span>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            name="q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search deleted items…"
            aria-label="Search deleted items"
            className="h-8 min-w-56 flex-1 rounded-lg border border-line bg-surface px-3 text-sm"
          />
          <Select<Range>
            label="When"
            value={range}
            onChange={setRange}
            options={[
              { value: 'all', label: 'Any time' },
              { value: '1', label: 'Last 24 hours' },
              { value: '7', label: 'Last 7 days' },
              { value: '30', label: 'Last 30 days' },
            ]}
          />
          <label className="flex items-center gap-1.5 text-xs text-ink-2">
            <input type="checkbox" name="hide-restored" checked={hideRestored} onChange={(e) => setHideRestored(e.target.checked)} /> Hide restored
          </label>
        </div>

        {tab === 'watch-later' && (
          <Notice>YouTube doesn’t allow apps to add videos back to Watch Later. You can open them, or copy them to one of your playlists.</Notice>
        )}
        {tab === 'channel' && (
          <Notice>
            Re-subscribe from the{' '}
            <a href="#/unsubscribed" className="font-medium text-accent underline">
              Unsubscribed dashboard
            </a>{' '}
            — categories and favorites come back too.
          </Notice>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
        <ActiveOps />

        {(selVideoRows.length > 0 || selWlRows.length > 0) && (
          <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-accent-soft px-4 py-2 text-sm">
            <b className="tabular-nums">{selVideoRows.length + selWlRows.length} selected</b>
            {selVideoRows.length > 0 && (
              <Button size="sm" variant="primary" disabled={!auth.signedIn} onClick={() => void restoreVideos(selVideoRows)}>
                Add {selVideoRows.length} back to their playlists
              </Button>
            )}
            {selWlRows.length > 0 && (
              <Button size="sm" disabled={!auth.signedIn} onClick={() => setDialog({ kind: 'copy', rows: selWlRows })}>
                Copy {selWlRows.length} to a playlist
              </Button>
            )}
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>
              Deselect all
            </Button>
          </div>
        )}

        {!all ? null : shown.length === 0 ? (
          <EmptyState icon="🗑" title={all.length ? 'Nothing matches' : 'Nothing deleted yet'}>
            {all.length
              ? 'Try another type, date range or search.'
              : 'When you unsubscribe, remove videos, delete playlists, clear Watch Later or delete categories here, they show up in this list.'}
          </EmptyState>
        ) : (
          <ul className="overflow-hidden rounded-xl border border-line bg-surface">
            {shown.slice(0, limit).map((r) => {
              const selectable = (r.kind === 'playlist-video' && !r.restored) || r.kind === 'watch-later';
              return (
                <li key={r.key} className={cx('flex items-center gap-3 border-b border-line/60 px-4 py-2.5 last:border-0', r.restored && 'opacity-70')}>
                  <input
                    type="checkbox"
                    aria-label={`Select ${r.title}`}
                    disabled={!selectable}
                    checked={selected.has(r.key)}
                    onChange={() => toggle(r.key)}
                    className="h-4 w-4 shrink-0 accent-[var(--color-accent)] disabled:opacity-20"
                  />
                  {r.round ? (
                    <Avatar url={r.thumb} title={r.title} size={36} />
                  ) : r.kind === 'category' ? (
                    <span className="flex h-9 w-16 items-center justify-center rounded-lg bg-surface-2 text-lg" aria-hidden>
                      🏷️
                    </span>
                  ) : (
                    <Thumb url={r.thumb} alt="" className="aspect-video w-16" />
                  )}
                  <div className="min-w-0 flex-1">
                    {r.href ? (
                      <a href={r.href} target="_blank" rel="noopener noreferrer" className="line-clamp-1 text-sm font-medium hover:underline">
                        {r.title}
                      </a>
                    ) : (
                      <div className="line-clamp-1 text-sm font-medium">{r.title}</div>
                    )}
                    <div className="truncate text-xs text-ink-3">
                      {r.context} · <span title={formatDate(r.at)}>{relativeTime(r.at)}</span>
                    </div>
                  </div>
                  {r.restored ? (
                    <span className="shrink-0 rounded-md bg-ok/10 px-2 py-0.5 text-xs text-ok">✓ {r.restoredNote}</span>
                  ) : (
                    <RowActions
                      row={r}
                      signedIn={auth.signedIn}
                      onRestoreVideo={() => void restoreVideos([r])}
                      onRecreate={() => r.log && setDialog({ kind: 'recreate', log: r.log })}
                      onCopy={() => setDialog({ kind: 'copy', rows: [r] })}
                      onRestoreCategory={async () => {
                        try {
                          const res = await restoreCategory(r.key);
                          toast(`Category restored (${res.channels} channels, ${res.playlists} playlists)`);
                        } catch (e) {
                          setError(e instanceof Error ? e.message : String(e));
                        }
                      }}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {shown.length > limit && (
          <div className="text-center">
            <Button onClick={() => setLimit((l) => l + 200)}>Show more ({shown.length - limit} left)</Button>
          </div>
        )}
        <p className="text-xs text-ink-3">
          Stored only in this browser. Video and playlist titles from YouTube are kept for 30 days (YouTube policy); IDs and dates stay until you clear
          the history.
        </p>
      </div>

      {dialog?.kind === 'copy' && (
        <AddToPlaylist
          videos={dialog.rows.filter((r) => r.log?.videoId).map((r) => ({ videoId: r.log!.videoId!, title: r.title }))}
          onStarted={() => setSelected(new Set())}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'progress' && <OpProgressModal opId={dialog.opId} onClose={() => setDialog(null)} />}
      <ConfirmDialog
        open={dialog?.kind === 'recreate'}
        title="Recreate this playlist?"
        confirmLabel="Recreate"
        body={
          dialog?.kind === 'recreate' ? (
            <div className="space-y-2">
              <p>
                A new playlist “<b>{dialog.log.playlistTitle || 'Restored playlist'}</b>” ({dialog.log.privacy ?? 'private'}) will be created on your
                YouTube account and its {dialog.log.videos?.length ?? 0} saved videos added back in order.
              </p>
              <p className="text-xs text-ink-3">
                YouTube can’t undelete playlists, so it gets a new link. Each video uses 50 API units; large playlists continue automatically after the daily
                limit resets.
              </p>
            </div>
          ) : null
        }
        onConfirm={async () => {
          if (dialog?.kind !== 'recreate') return;
          const r = await send<{ playlistId: string; opId?: string }>({ type: 'trash/recreatePlaylist', id: dialog.log.id });
          if (!r.ok) throw new Error(r.error);
          if (r.data?.opId) setDialog({ kind: 'progress', opId: r.data.opId });
          else toast('Playlist recreated');
        }}
        onClose={() => setDialog((d) => (d?.kind === 'recreate' ? null : d))}
      />
      <ConfirmDialog
        open={dialog?.kind === 'clear'}
        title={tab === 'all' ? 'Clear the whole deleted-items history?' : `Clear the “${TABS.find((t) => t.id === tab)?.label}” history?`}
        danger
        confirmLabel="Clear history"
        body={
          <>
            This only clears this extension’s history — nothing on YouTube changes. You won’t be able to restore these items from here afterwards.
            {(tab === 'all' || tab === 'channel') && ' Unsubscribed channels are managed in the Unsubscribed dashboard and are not cleared here.'}
          </>
        }
        onConfirm={async () => {
          await clearDeletionLog(tab === 'all' || tab === 'channel' ? undefined : tab);
          setSelected(new Set());
          toast('History cleared');
        }}
        onClose={() => setDialog((d) => (d?.kind === 'clear' ? null : d))}
      />
    </div>
  );
}

function RowActions({
  row,
  signedIn,
  onRestoreVideo,
  onRecreate,
  onCopy,
  onRestoreCategory,
}: {
  row: Row;
  signedIn: boolean;
  onRestoreVideo: () => void;
  onRecreate: () => void;
  onCopy: () => void;
  onRestoreCategory: () => void;
}) {
  switch (row.kind) {
    case 'channel':
      return (
        <a href="#/unsubscribed" className="shrink-0 rounded-md px-2 py-1 text-xs text-accent hover:bg-surface-2">
          Re-subscribe →
        </a>
      );
    case 'playlist-video':
      return (
        <Button size="sm" disabled={!signedIn} onClick={onRestoreVideo}>
          Add back
        </Button>
      );
    case 'playlist':
      return (
        <Button size="sm" disabled={!signedIn} onClick={onRecreate}>
          Recreate
        </Button>
      );
    case 'watch-later':
      return (
        <Button size="sm" disabled={!signedIn} onClick={onCopy} title="YouTube doesn’t allow adding back to Watch Later">
          Copy to playlist
        </Button>
      );
    case 'category':
      return (
        <Button size="sm" onClick={onRestoreCategory}>
          Restore
        </Button>
      );
  }
}
