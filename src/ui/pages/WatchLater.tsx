import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import type { BulkOp, WatchLaterItem } from '@/lib/types';
import { DAY_MS } from '@/config/constants';
import { parseWatchLaterCsv } from '@/services/takeout';
import { WL_CAPABILITIES } from '@/features/watch-later';
import { relativeTime } from '@/lib/time';
import { send, useAuth } from '../hooks';
import { Button, ConfirmDialog, cx, EmptyState, Modal, Notice, PageHeader, Select, useToast } from '../primitives';
import { ActiveOps, OpProgressModal } from '../playlists/common';
import { AddToPlaylist } from '../playlists/dialogs';
import { VideoList, type VideoRow } from '../playlists/VideoList';

type SortKey = 'page' | 'added-desc' | 'added-asc' | 'title' | 'long' | 'short';
type AgeFilter = 'any' | '30' | '90' | '180' | '365';
type LiveStatus = { tabOpen: boolean; state?: 'ok' | 'not-watch-later' | 'signed-out' | 'loading'; meta?: { syncedAt: number; count: number } };

/** "PT1H2M3S" → seconds (for sorting). */
function seconds(iso?: string): number {
  const m = iso ? /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso) : null;
  if (!m) return 0;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

/**
 * Watch Later.
 *  - Live YouTube: read from / changed on the real Watch Later page via YouTube's own website UI
 *    (the official API has no Watch Later access). Every change is confirmed and verified.
 *  - Google Takeout import: a local snapshot, clearly labelled as such.
 */
export function WatchLaterPage() {
  const auth = useAuth();
  const toast = useToast();
  const items = useLiveQuery(() => db.watchLater.toArray(), []);
  const [live, setLive] = useState<LiveStatus | null>(null);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('page');
  const [age, setAge] = useState<AgeFilter>('any');
  const [showHidden, setShowHidden] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<null | 'import' | 'refresh' | 'details'>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    null | { kind: 'remove'; rows: VideoRow[] } | { kind: 'copy'; rows: VideoRow[] } | { kind: 'move'; rows: VideoRow[] } | { kind: 'progress'; opId: string }
  >(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadStatus = async () => {
    const r = await send<LiveStatus>({ type: 'wl/status' });
    if (r.ok && r.data) setLive(r.data);
  };
  useEffect(() => {
    void loadStatus();
    const id = setInterval(loadStatus, 10_000);
    return () => clearInterval(id);
  }, []);

  const source: 'live' | 'takeout' | 'none' = !items?.length ? 'none' : items.some((w) => w.source === 'live') ? 'live' : 'takeout';

  const refreshLive = async () => {
    setBusy('refresh');
    setError(null);
    const r = await send<{ count: number }>({ type: 'wl/refreshLive' });
    setBusy(null);
    void loadStatus();
    if (!r.ok) return setError(r.error);
    setSelected(new Set());
    toast(`Loaded ${r.data?.count ?? 0} videos from your YouTube Watch Later`);
  };

  const importFile = async (file: File) => {
    setBusy('import');
    setError(null);
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('File too large.');
      const parsed = parseWatchLaterCsv(await file.text());
      const now = Date.now();
      await db.transaction('rw', db.watchLater, async () => {
        const prev = new Map((await db.watchLater.toArray()).map((w) => [w.videoId, w]));
        await db.watchLater.clear(); // a Takeout import replaces the local list (snapshot)
        await db.watchLater.bulkPut(
          parsed.map((p): WatchLaterItem => {
            const old = prev.get(p.videoId);
            return { ...old, videoId: p.videoId, addedAt: p.addedAt, source: 'takeout', importedAt: now };
          }),
        );
      });
      toast(`Imported ${parsed.length} videos from Google Takeout`);
      if (auth.signedIn) {
        const r = await send<number>({ type: 'wl/enrich' });
        if (!r.ok) setError(`Imported, but video details couldn’t be loaded: ${r.error}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const rows: VideoRow[] = useMemo(() => {
    if (!items) return [];
    const ql = q.trim().toLowerCase();
    const cutoff = age === 'any' ? Infinity : Date.now() - Number(age) * DAY_MS;
    const list = items.filter(
      (w) =>
        (showHidden || !w.hidden) &&
        (age === 'any' || (w.addedAt ?? Infinity) < cutoff) &&
        (!ql || `${w.title ?? ''} ${w.channelTitle ?? ''} ${w.videoId}`.toLowerCase().includes(ql)),
    );
    const cmp: Record<SortKey, ((a: WatchLaterItem, b: WatchLaterItem) => number) | null> = {
      page: null,
      'added-desc': (a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0),
      'added-asc': (a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0),
      title: (a, b) => (a.title ?? '').localeCompare(b.title ?? ''),
      long: (a, b) => seconds(b.duration) - seconds(a.duration),
      short: (a, b) => seconds(a.duration) - seconds(b.duration),
    };
    const sorted = cmp[sort] ? [...list].sort(cmp[sort]!) : list;
    return sorted.map((w) => ({
      key: w.videoId,
      videoId: w.videoId,
      title: w.title || (w.unavailable ? 'Unavailable video' : 'Loading details…'),
      channelTitle: w.channelTitle,
      thumbnailUrl: w.thumbnailUrl,
      duration: w.duration,
      publishedAt: w.publishedAt,
      addedAt: w.addedAt,
      unavailable: !!w.unavailable,
    }));
  }, [items, q, sort, age, showHidden]);

  const hiddenCount = items?.filter((w) => w.hidden).length ?? 0;
  const missingDetails = items?.filter((w) => !w.fetchedAt && !w.title).length ?? 0;
  const hasDates = !!items?.some((w) => w.addedAt);
  const selRows = rows.filter((r) => selected.has(r.key));

  const setHidden = async (ids: string[], on: boolean) => {
    await db.watchLater.bulkUpdate(ids.map((id) => ({ key: id, changes: { hidden: on ? (1 as const) : (0 as const) } })));
    setSelected(new Set());
    toast(on ? `Hid ${ids.length} videos in this extension (YouTube is unchanged)` : `Unhid ${ids.length} videos`);
  };

  const startRemove = async (list: VideoRow[]) => {
    const r = await send<{ op: BulkOp }>({
      type: 'wl/remove',
      confirmed: true,
      items: list.map((x) => ({ videoId: x.videoId, title: x.title })),
    });
    if (!r.ok || !r.data) throw new Error(r.ok ? 'Could not start.' : r.error);
    setSelected(new Set());
    setDialog({ kind: 'progress', opId: r.data.op.id });
  };

  const tabLine =
    live === null
      ? 'Checking YouTube tab…'
      : !live.tabOpen
        ? 'YouTube Watch Later tab: not open'
        : live.state === 'ok'
          ? 'YouTube Watch Later tab: open and ready'
          : live.state === 'signed-out'
            ? 'YouTube tab: not signed in — please sign in to YouTube'
            : 'YouTube tab: loading…';

  return (
    <div>
      <PageHeader
        title="🔖 Watch Later"
        subtitle="Manage your actual YouTube Watch Later list."
        actions={
          <>
            <input
              ref={fileRef}
              type="file"
              name="wl-file"
              accept=".csv,text/csv"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importFile(f);
                e.target.value = '';
              }}
            />
            <Button variant="primary" disabled={!!busy} onClick={refreshLive}>
              {busy === 'refresh' ? 'Reading YouTube…' : 'Refresh from YouTube'}
            </Button>
            <Button onClick={() => void send({ type: 'wl/open' }).then(loadStatus)}>Open on YouTube ↗</Button>
            <Button disabled={!!busy} onClick={() => fileRef.current?.click()}>
              {busy === 'import' ? 'Importing…' : 'Import Takeout'}
            </Button>
          </>
        }
      />
      <div className="space-y-4 p-6">
        {/* Source — never mix live and imported data without saying which is which */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-line bg-surface px-4 py-3 text-sm">
          <div>
            <span className="text-ink-3">Source: </span>
            {source === 'live' ? (
              <span className="font-medium">
                <span className="text-ok">●</span> Live YouTube Watch Later
                {live?.meta && <span className="font-normal text-ink-3"> · synced {relativeTime(live.meta.syncedAt)}</span>}
              </span>
            ) : source === 'takeout' ? (
              <span className="font-medium">
                <span className="text-ink-3">○</span> Imported from Google Takeout <span className="font-normal text-ink-3">(local snapshot — may be out of date)</span>
              </span>
            ) : (
              <span className="text-ink-3">Nothing loaded yet</span>
            )}
          </div>
          <div className={cx('text-xs', live?.state === 'signed-out' ? 'text-danger' : 'text-ink-3')}>{tabLine}</div>
          {missingDetails > 0 && auth.signedIn && (
            <Button
              size="sm"
              className="ml-auto"
              disabled={!!busy}
              onClick={async () => {
                setBusy('details');
                const r = await send<number>({ type: 'wl/enrich' });
                setBusy(null);
                if (!r.ok) setError(r.error);
              }}
            >
              Load details ({missingDetails})
            </Button>
          )}
        </div>

        <Notice>
          YouTube’s official API does not provide normal access to Watch Later. Live Watch Later changes are therefore performed through YouTube’s own
          website in a YouTube tab. <b>Your videos are never deleted from YouTube</b> — removing from Watch Later only removes them from this list.
        </Notice>
        {error && <Notice tone="danger">{error}</Notice>}
        <ActiveOps />

        {items && items.length === 0 ? (
          <EmptyState icon="🔖" title="Load your Watch Later">
            <p>
              Press <b>Refresh from YouTube</b> — a YouTube tab opens on your Watch Later page (you must be signed in to YouTube) and the list is read from
              it. Or import a Google Takeout file.
            </p>
            <div className="mt-4 flex justify-center gap-2">
              <Button variant="primary" onClick={refreshLive} disabled={!!busy}>
                Refresh from YouTube
              </Button>
              <Button onClick={() => fileRef.current?.click()}>Import Takeout</Button>
            </div>
          </EmptyState>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              name="q"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search title or channel…"
              aria-label="Search Watch Later"
              className="h-8 min-w-56 flex-1 rounded-lg border border-line bg-surface px-3 text-sm"
            />
            {hasDates && (
              <Select<AgeFilter>
                label="Added"
                value={age}
                onChange={setAge}
                options={[
                  { value: 'any', label: 'Added any time' },
                  { value: '30', label: 'Added over 30 days ago' },
                  { value: '90', label: 'Added over 3 months ago' },
                  { value: '180', label: 'Added over 6 months ago' },
                  { value: '365', label: 'Added over 1 year ago' },
                ]}
              />
            )}
            <Select<SortKey>
              label="Sort"
              value={sort}
              onChange={setSort}
              options={[
                { value: 'page', label: source === 'live' ? 'YouTube order' : 'File order' },
                ...(hasDates
                  ? [
                      { value: 'added-desc' as const, label: 'Recently added' },
                      { value: 'added-asc' as const, label: 'Oldest added' },
                    ]
                  : []),
                { value: 'title', label: 'Title A–Z' },
                { value: 'long', label: 'Longest' },
                { value: 'short', label: 'Shortest' },
              ]}
            />
            <label className="flex items-center gap-1.5 text-xs text-ink-2">
              <input type="checkbox" name="show-hidden" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Show hidden ({hiddenCount})
            </label>
          </div>
        )}
      </div>

      {selected.size > 0 && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-y border-line bg-accent-soft px-6 py-2 text-sm">
          <b className="tabular-nums">{selected.size} selected</b>
          <Button size="sm" disabled={!auth.signedIn} onClick={() => setDialog({ kind: 'copy', rows: selRows })}>
            Add to Playlist
          </Button>
          <Button size="sm" disabled={!auth.signedIn} onClick={() => setDialog({ kind: 'move', rows: selRows })}>
            Move to Playlist
          </Button>
          <Button size="sm" variant="danger-outline" onClick={() => setDialog({ kind: 'remove', rows: selRows })}>
            Remove from YouTube Watch Later
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void setHidden([...selected], true)} title="Only hides them in this extension">
            Hide here
          </Button>
          {showHidden && (
            <Button size="sm" variant="ghost" onClick={() => void setHidden([...selected], false)}>
              Unhide
            </Button>
          )}
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>
            Deselect all
          </Button>
        </div>
      )}

      {items && items.length > 0 && (
        <VideoList
          rows={rows}
          selected={selected}
          onSelectedChange={setSelected}
          onAdd={auth.signedIn ? (r) => setDialog({ kind: 'copy', rows: [r] }) : undefined}
          onRemove={(r) => setDialog({ kind: 'remove', rows: [r] })}
          height="calc(100vh - 380px)"
          empty={<EmptyState icon="🔍" title="No videos match" />}
        />
      )}

      {dialog?.kind === 'copy' && (
        <AddToPlaylist
          videos={dialog.rows.map((r) => ({ videoId: r.videoId, title: r.title }))}
          onStarted={() => setSelected(new Set())}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'move' && (
        <MoveFromWatchLater
          rows={dialog.rows}
          onClose={() => setDialog(null)}
          onStarted={(opId) => {
            setSelected(new Set());
            setDialog({ kind: 'progress', opId });
          }}
        />
      )}
      {dialog?.kind === 'progress' && <OpProgressModal opId={dialog.opId} onClose={() => setDialog(null)} />}
      <ConfirmDialog
        open={dialog?.kind === 'remove'}
        title={
          dialog?.kind === 'remove'
            ? `Remove ${dialog.rows.length} video${dialog.rows.length === 1 ? '' : 's'} from your YouTube Watch Later?`
            : ''
        }
        danger
        confirmLabel="Remove"
        body={
          <div className="space-y-2">
            <p>
              This removes the videos from your Watch Later list. <b>It does NOT delete the videos from YouTube.</b>
            </p>
            <p className="text-xs text-ink-3">
              A YouTube tab opens on your Watch Later page and the extension uses YouTube’s own “Remove from Watch later” option for each video, matched by
              video ID, then checks it’s gone. Keep that tab open until it finishes. Make sure the YouTube tab is signed in to the account you want to change.
              {source === 'takeout' && ' Your list is a Takeout snapshot — videos that are no longer in Watch Later will be reported as not found.'}
            </p>
            <p className="text-xs text-ink-3">{WL_CAPABILITIES.removeViaWebsite.how}</p>
          </div>
        }
        onConfirm={async () => {
          if (dialog?.kind === 'remove') await startRemove(dialog.rows);
        }}
        onClose={() => setDialog((d) => (d?.kind === 'remove' ? null : d))}
      />
    </div>
  );
}

/** Safe move: add to playlist (API) → confirmed → remove from Watch Later (website) → verified. */
function MoveFromWatchLater({ rows, onClose, onStarted }: { rows: VideoRow[]; onClose: () => void; onStarted: (opId: string) => void }) {
  const playlists = useLiveQuery(() => db.playlists.toArray(), []);
  const [dest, setDest] = useState('');
  const [skip, setSkip] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const n = rows.length;
  return (
    <Modal
      open
      onClose={onClose}
      title={`Move ${n} video${n === 1 ? '' : 's'} to a playlist`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!dest || busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              const r = await send<{ op: BulkOp }>({
                type: 'wl/move',
                confirmed: true,
                destPlaylistId: dest,
                skipDuplicates: skip,
                items: rows.map((x) => ({ videoId: x.videoId, title: x.title })),
              });
              setBusy(false);
              if (r.ok && r.data) onStarted(r.data.op.id);
              else setError(r.ok ? 'Could not start.' : r.error);
            }}
          >
            Move {n} video{n === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="wl-dest" className="text-xs font-medium text-ink-2">
            Destination playlist
          </label>
          <select id="wl-dest" value={dest} onChange={(e) => setDest(e.target.value)} className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-2 text-sm">
            <option value="">Choose a playlist…</option>
            {[...(playlists ?? [])]
              .sort((a, b) => a.title.localeCompare(b.title))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} ({p.itemCount})
                </option>
              ))}
          </select>
          {playlists?.length === 0 && <p className="mt-1 text-xs text-ink-3">Open 📚 Playlists and press Refresh first.</p>}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="skip-dupes" checked={skip} onChange={(e) => setSkip(e.target.checked)} /> Don’t add videos that are already in the
          playlist (they’re still removed from Watch Later)
        </label>
        <ol className="list-inside list-decimal space-y-1 text-xs text-ink-2">
          <li>Each video is added to the playlist through YouTube’s official API.</li>
          <li>Only after YouTube confirms that, it’s removed from Watch Later in your YouTube tab and checked.</li>
          <li>If the removal fails, you’ll see “Added to …, but could not remove from Watch Later”.</li>
        </ol>
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Modal>
  );
}
