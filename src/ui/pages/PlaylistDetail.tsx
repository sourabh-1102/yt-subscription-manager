import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import type { BulkOp } from '@/lib/types';
import { relativeTime } from '@/lib/time';
import { navigate, send, useAuth, useRoute } from '../hooks';
import { Button, ConfirmDialog, EmptyState, Notice, Select, useToast } from '../primitives';
import { ActiveOps, OpProgressModal, PrivacyBadge, Thumb } from '../playlists/common';
import { AddToPlaylist, AddVideos, PlaylistForm, type PickedVideo } from '../playlists/dialogs';
import { VideoList, type VideoRow } from '../playlists/VideoList';

type SortKey = 'position' | 'title' | 'added-desc' | 'published-desc';

export function PlaylistDetailPage() {
  const { params } = useRoute();
  const id = params.get('id') ?? '';
  const auth = useAuth();
  const toast = useToast();
  const playlist = useLiveQuery(() => db.playlists.get(id), [id]);
  const items = useLiveQuery(() => db.playlistItems.where('playlistId').equals(id).sortBy('position'), [id]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('position');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    | null
    | { kind: 'edit' }
    | { kind: 'delete' }
    | { kind: 'remove'; rows: VideoRow[] }
    | { kind: 'addTo'; videos: PickedVideo[] }
    | { kind: 'addVideos' }
    | { kind: 'progress'; opId: string }
  >(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    const r = await send<number>({ type: 'pl/items', playlistId: id });
    setLoading(false);
    if (!r.ok) setError(r.error);
  };

  // Fetch items on first open (or when the cache is older than 10 minutes).
  useEffect(() => {
    if (playlist && auth.signedIn && (!playlist.itemsFetchedAt || Date.now() - playlist.itemsFetchedAt > 10 * 60 * 1000)) void load();
    setSelected(new Set());
  }, [playlist?.id, auth.signedIn]);

  const rows: VideoRow[] = useMemo(() => {
    if (!items) return [];
    const ql = q.trim().toLowerCase();
    const list = items
      .filter((i) => !ql || `${i.title} ${i.channelTitle ?? ''}`.toLowerCase().includes(ql))
      .map((i) => ({
        key: i.id,
        videoId: i.videoId,
        title: i.title,
        channelTitle: i.channelTitle,
        thumbnailUrl: i.thumbnailUrl,
        duration: i.duration,
        publishedAt: i.videoPublishedAt,
        addedAt: i.addedAt,
        position: i.position,
        unavailable: !!i.unavailable,
      }));
    if (sort === 'title') list.sort((a, b) => a.title.localeCompare(b.title));
    if (sort === 'added-desc') list.sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
    if (sort === 'published-desc') list.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
    return list;
  }, [items, q, sort]);

  /** Extra copies of the same video (the first occurrence by position is kept). */
  const duplicateRows: VideoRow[] = useMemo(() => {
    if (!items) return [];
    const seen = new Set<string>();
    const out: VideoRow[] = [];
    for (const i of items) {
      if (seen.has(i.videoId)) out.push({ key: i.id, videoId: i.videoId, title: i.title, position: i.position });
      else seen.add(i.videoId);
    }
    return out;
  }, [items]);

  if (playlist === undefined && items === undefined) return null;
  if (!playlist)
    return (
      <EmptyState icon="🔍" title="Playlist not found">
        It may have been deleted. <a className="text-accent underline" href="#/playlists">Back to playlists</a>
      </EmptyState>
    );

  const selRows = rows.filter((r) => selected.has(r.key));
  const picked = (list: VideoRow[]): PickedVideo[] => list.map((r) => ({ videoId: r.videoId, title: r.title, playlistItemId: r.key }));
  const canReorder = sort === 'position' && !q.trim() && auth.signedIn;

  const startRemove = async (list: VideoRow[]) => {
    const r = await send<{ op: BulkOp }>({
      type: 'op/start',
      kind: 'remove',
      label: `Remove ${list.length} video${list.length === 1 ? '' : 's'} from ${playlist.title}`,
      sourcePlaylistId: playlist.id,
      skipDuplicates: true,
      items: list.map((r) => ({ videoId: r.videoId, title: r.title, playlistItemId: r.key })),
    });
    if (!r.ok || !r.data) throw new Error(r.ok ? 'Could not start.' : r.error);
    setSelected(new Set());
    setDialog({ kind: 'progress', opId: r.data.op.id });
  };

  return (
    <div>
      <div className="flex flex-wrap items-start gap-5 border-b border-line px-6 pt-5 pb-4">
        <Thumb url={playlist.thumbnailUrl} alt="" className="aspect-video w-48" />
        <div className="min-w-0 flex-1">
          <a href="#/playlists" className="text-xs text-accent hover:underline">
            ← Playlists
          </a>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">{playlist.title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-2">
            <PrivacyBadge privacy={playlist.privacy} />
            <span>{playlist.itemCount} videos</span>
            {playlist.itemsFetchedAt && <span className="text-xs text-ink-3">· updated {relativeTime(playlist.itemsFetchedAt)}</span>}
          </div>
          {playlist.description && <p className="mt-2 line-clamp-2 max-w-3xl text-sm text-ink-2">{playlist.description}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={load} disabled={loading || !auth.signedIn}>
            {loading ? 'Loading…' : 'Refresh'}
          </Button>
          <Button variant="primary" onClick={() => setDialog({ kind: 'addVideos' })} disabled={!auth.signedIn}>
            + Add videos
          </Button>
          <Button onClick={() => setDialog({ kind: 'edit' })} disabled={!auth.signedIn}>
            Edit
          </Button>
          <a
            href={`https://www.youtube.com/playlist?list=${encodeURIComponent(playlist.id)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-9 items-center rounded-lg border border-line px-3.5 text-sm hover:bg-surface-2"
          >
            Open on YouTube ↗
          </a>
          <Button variant="danger-outline" onClick={() => setDialog({ kind: 'delete' })} disabled={!auth.signedIn}>
            Delete
          </Button>
        </div>
      </div>

      <div className="space-y-3 px-6 pt-4">
        {error && <Notice tone="danger">{error}</Notice>}
        {duplicateRows.length > 0 && auth.signedIn && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-warn/30 bg-warn/10 px-4 py-2.5 text-sm">
            <span>
              This playlist contains <b>{duplicateRows.length}</b> duplicate video{duplicateRows.length === 1 ? '' : 's'} (the same video more than once).
            </span>
            <Button size="sm" onClick={() => setDialog({ kind: 'remove', rows: duplicateRows })}>
              Remove duplicates (keep first)
            </Button>
          </div>
        )}
        <ActiveOps playlistId={playlist.id} />
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            name="q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search in this playlist…"
            aria-label="Search videos"
            className="h-8 min-w-56 flex-1 rounded-lg border border-line bg-surface px-3 text-sm"
          />
          <Select<SortKey>
            label="Sort"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'position', label: 'Playlist order' },
              { value: 'title', label: 'Title A–Z' },
              { value: 'added-desc', label: 'Recently added' },
              { value: 'published-desc', label: 'Recently published' },
            ]}
          />
        </div>
        {!canReorder && sort !== 'position' && <p className="text-xs text-ink-3">Switch to “Playlist order” without a search to drag-reorder.</p>}
      </div>

      {selected.size > 0 && (
        <div className="sticky top-0 z-10 mt-3 flex flex-wrap items-center gap-2 border-y border-line bg-accent-soft px-6 py-2 text-sm">
          <b className="tabular-nums">Selected: {selected.size} video{selected.size === 1 ? '' : 's'}</b>
          <Button size="sm" onClick={() => setDialog({ kind: 'addTo', videos: picked(selRows) })}>
            Add to playlist / Move…
          </Button>
          <Button size="sm" variant="danger-outline" onClick={() => setDialog({ kind: 'remove', rows: selRows })}>
            Remove…
          </Button>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>
            Deselect all
          </Button>
        </div>
      )}

      <div className="mt-3">
        {!items || (loading && !items.length) ? (
          <div className="space-y-2 px-6" aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg bg-surface-2" />
            ))}
          </div>
        ) : (
          <VideoList
            rows={rows}
            selected={selected}
            onSelectedChange={setSelected}
            reorderable={canReorder}
            onReorder={async (row, toIndex) => {
              const target = rows[toIndex];
              if (!target || target.position === undefined) return;
              const r = await send({ type: 'pl/reorder', playlistId: playlist.id, itemId: row.key, position: target.position });
              if (!r.ok) toast(r.error, 'error');
              else toast('Order saved on YouTube');
            }}
            onRemove={auth.signedIn ? (row) => setDialog({ kind: 'remove', rows: [row] }) : undefined}
            onAdd={auth.signedIn ? (row) => setDialog({ kind: 'addTo', videos: picked([row]) }) : undefined}
            empty={
              <EmptyState icon="🎞️" title={q ? 'No videos match' : 'This playlist is empty'}>
                {!q && 'Use “+ Add videos” to paste links or search YouTube.'}
              </EmptyState>
            }
          />
        )}
      </div>

      {dialog?.kind === 'edit' && <PlaylistForm playlist={playlist} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'addVideos' && <AddVideos playlist={playlist} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'addTo' && (
        <AddToPlaylist
          videos={dialog.videos}
          sourcePlaylistId={playlist.id}
          allowMove
          onStarted={() => setSelected(new Set())}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'progress' && <OpProgressModal opId={dialog.opId} onClose={() => setDialog(null)} />}
      <ConfirmDialog
        open={dialog?.kind === 'remove'}
        title={dialog?.kind === 'remove' ? `Remove ${dialog.rows.length} video${dialog.rows.length === 1 ? '' : 's'} from this playlist?` : ''}
        danger
        confirmLabel="Remove"
        body={
          <>
            They’ll be removed from <b>{playlist.title}</b> on YouTube. The videos themselves aren’t deleted, and you can add them back later.
          </>
        }
        onConfirm={async () => {
          if (dialog?.kind === 'remove') await startRemove(dialog.rows);
        }}
        onClose={() => setDialog((d) => (d?.kind === 'remove' ? null : d))}
      />
      <ConfirmDialog
        open={dialog?.kind === 'delete'}
        title="Delete playlist permanently?"
        danger
        confirmLabel="Delete playlist"
        body={
          <>
            <b>{playlist.title}</b> ({playlist.itemCount} videos) will be deleted from your YouTube account. This can’t be undone. The videos themselves are
            not deleted.
          </>
        }
        onConfirm={async () => {
          const r = await send({ type: 'pl/delete', id: playlist.id });
          if (!r.ok) throw new Error(r.error);
          toast('Playlist deleted');
          navigate('/playlists');
        }}
        onClose={() => setDialog(null)}
      />
    </div>
  );
}
