import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import type { BulkOp, Playlist, PlaylistPrivacy } from '@/lib/types';
import { extractVideoIds, formatDuration } from '@/features/watch-later';
import { validatePlaylistInput } from '@/features/playlist-input';
import { formatDate } from '@/lib/time';
import { send } from '../hooks';
import { Button, cx, Modal, Notice, useToast } from '../primitives';
import { OpProgressModal, Thumb } from './common';

// ---------- Create / edit playlist ----------
export function PlaylistForm({
  playlist,
  onClose,
  onSaved,
}: {
  playlist?: Playlist;
  onClose: () => void;
  onSaved?: (p: Playlist) => void;
}) {
  const [title, setTitle] = useState(playlist?.title ?? '');
  const [description, setDescription] = useState(playlist?.description ?? '');
  const [privacy, setPrivacy] = useState<PlaylistPrivacy>(playlist?.privacy ?? 'private');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const invalid = validatePlaylistInput({ title, description });

  const save = async () => {
    if (invalid) return setError(invalid);
    setBusy(true);
    setError(null);
    const input = { title: title.trim(), description, privacy };
    const r = playlist
      ? await send<Playlist>({ type: 'pl/update', id: playlist.id, input })
      : await send<Playlist>({ type: 'pl/create', input });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    toast(playlist ? 'Playlist updated on YouTube' : `Playlist “${input.title}” created`);
    if (r.data) onSaved?.(r.data);
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={playlist ? 'Edit playlist' : 'Create playlist'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !!invalid} onClick={save}>
            {busy ? 'Saving…' : playlist ? 'Save changes' : 'Create playlist'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div>
          <label htmlFor="pl-title" className="text-xs font-medium text-ink-2">
            Name
          </label>
          <input
            id="pl-title"
            name="title"
            autoFocus
            maxLength={150}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm"
            placeholder="e.g. Programming tutorials"
          />
          <div className="mt-1 text-right text-[11px] text-ink-3">{title.trim().length}/150</div>
        </div>
        <div>
          <label htmlFor="pl-desc" className="text-xs font-medium text-ink-2">
            Description
          </label>
          <textarea
            id="pl-desc"
            name="description"
            rows={3}
            maxLength={5000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="mt-1 w-full rounded-lg border border-line bg-surface p-2.5 text-sm"
          />
        </div>
        <fieldset>
          <legend className="text-xs font-medium text-ink-2">Privacy</legend>
          <div className="mt-1.5 grid grid-cols-3 gap-2">
            {(['public', 'unlisted', 'private'] as const).map((p) => (
              <label
                key={p}
                className={cx(
                  'cursor-pointer rounded-lg border px-3 py-2 text-sm capitalize',
                  privacy === p ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2',
                )}
              >
                <input type="radio" name="privacy" value={p} checked={privacy === p} onChange={() => setPrivacy(p)} className="sr-only" />
                {p}
              </label>
            ))}
          </div>
        </fieldset>
        {playlist && <p className="text-xs text-ink-3">Changes are saved to your YouTube account.</p>}
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    </Modal>
  );
}

// ---------- Add / copy / move to playlist ----------
export interface PickedVideo {
  videoId: string;
  title?: string;
  playlistItemId?: string;
}

export function AddToPlaylist({
  videos,
  sourcePlaylistId,
  allowMove,
  onClose,
  onStarted,
}: {
  videos: PickedVideo[];
  sourcePlaylistId?: string;
  allowMove?: boolean;
  onClose: () => void;
  onStarted?: () => void;
}) {
  const playlists = useLiveQuery(() => db.playlists.toArray(), []);
  const [dest, setDest] = useState('');
  const [mode, setMode] = useState<'copy' | 'move'>('copy');
  const [dupes, setDupes] = useState<string[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [skipDupes, setSkipDupes] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opId, setOpId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const options = useMemo(
    () => (playlists ?? []).filter((p) => p.id !== sourcePlaylistId).sort((a, b) => a.title.localeCompare(b.title)),
    [playlists, sourcePlaylistId],
  );

  useEffect(() => {
    setDupes(null);
    if (!dest) return;
    let alive = true;
    setChecking(true);
    void send<string[]>({ type: 'pl/duplicates', playlistId: dest, videoIds: videos.map((v) => v.videoId) }).then((r) => {
      if (!alive) return;
      setChecking(false);
      if (r.ok) setDupes(r.data ?? []);
      else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [dest, videos]);

  if (opId) return <OpProgressModal opId={opId} onClose={onClose} />;
  if (creating)
    return (
      <PlaylistForm
        onClose={() => setCreating(false)}
        onSaved={(p) => {
          setCreating(false);
          setDest(p.id);
        }}
      />
    );

  const n = videos.length;
  const destName = options.find((p) => p.id === dest)?.title ?? '';
  const effective = mode === 'copy' && skipDupes ? n - (dupes?.length ?? 0) : n;

  const start = async () => {
    setError(null);
    const r = await send<{ op: BulkOp }>({
      type: 'op/start',
      kind: mode === 'move' ? 'move' : 'add',
      label: `${mode === 'move' ? 'Move' : 'Add'} ${n} video${n === 1 ? '' : 's'} → ${destName}`,
      sourcePlaylistId: mode === 'move' ? sourcePlaylistId : undefined,
      destPlaylistId: dest,
      skipDuplicates: skipDupes,
      items: videos.map((v) => ({ videoId: v.videoId, title: v.title, playlistItemId: mode === 'move' ? v.playlistItemId : undefined })),
    });
    if (!r.ok || !r.data) return setError(r.ok ? 'Could not start.' : r.error);
    onStarted?.();
    setOpId(r.data.op.id);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Add ${n} video${n === 1 ? '' : 's'} to a playlist`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!dest || checking || dupes === null || (mode === 'copy' && effective === 0)} onClick={start}>
            {mode === 'move' ? `Move ${n} videos` : `Add ${effective} video${effective === 1 ? '' : 's'}`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="dest" className="text-xs font-medium text-ink-2">
            Destination
          </label>
          <div className="mt-1 flex gap-2">
            <select
              id="dest"
              value={dest}
              onChange={(e) => setDest(e.target.value)}
              className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 text-sm"
            >
              <option value="">Choose a playlist…</option>
              {options.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title} ({p.itemCount})
                </option>
              ))}
            </select>
            <Button onClick={() => setCreating(true)}>+ New</Button>
          </div>
          {playlists && playlists.length === 0 && (
            <p className="mt-1 text-xs text-ink-3">No playlists loaded yet — open Playlists and press Refresh, or create one.</p>
          )}
        </div>

        {allowMove && sourcePlaylistId && (
          <fieldset>
            <legend className="text-xs font-medium text-ink-2">Mode</legend>
            <div className="mt-1.5 grid grid-cols-2 gap-2">
              {(
                [
                  ['copy', 'Copy', 'Keep them in this playlist too'],
                  ['move', 'Move', 'Add to destination, then remove from here'],
                ] as const
              ).map(([v, label, hint]) => (
                <label
                  key={v}
                  className={cx('cursor-pointer rounded-lg border p-3', mode === v ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2')}
                >
                  <input type="radio" name="mode" value={v} checked={mode === v} onChange={() => setMode(v)} className="sr-only" />
                  <div className="text-sm font-medium">{label}</div>
                  <div className="text-xs text-ink-3">{hint}</div>
                </label>
              ))}
            </div>
            {mode === 'move' && (
              <p className="mt-2 text-xs text-ink-3">Safe move: each video is removed from here only after YouTube confirms it was added to the destination.</p>
            )}
          </fieldset>
        )}

        {checking && <p className="text-sm text-ink-3">Checking for duplicates…</p>}
        {dupes && dupes.length > 0 && (
          <Notice tone="warn">
            <b>
              {dupes.length} selected video{dupes.length === 1 ? ' is' : 's are'} already in this playlist.
            </b>
            <div className="mt-2 flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" name="dupes" checked={skipDupes} onChange={() => setSkipDupes(true)} /> Skip duplicates
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="dupes" checked={!skipDupes} onChange={() => setSkipDupes(false)} /> Add anyway
              </label>
            </div>
          </Notice>
        )}
        {dupes && dupes.length === 0 && dest && <p className="text-xs text-ok">✓ No duplicates in the destination.</p>}
        <p className="text-xs text-ink-3">Each added video uses 50 YouTube API units. Large batches continue automatically if the daily limit is reached.</p>
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Modal>
  );
}

// ---------- Add videos (paste links / search) ----------
interface FoundVideo {
  videoId: string;
  title: string;
  channelTitle?: string;
  thumbnailUrl?: string;
  duration?: string;
  publishedAt?: number;
}

export function AddVideos({ playlist, onClose }: { playlist: Playlist; onClose: () => void }) {
  const [tab, setTab] = useState<'paste' | 'search'>('paste');
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<FoundVideo[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [next, setNext] = useState(false);

  const load = async () => {
    setBusy(true);
    setError(null);
    const r =
      tab === 'paste'
        ? await (async () => {
            const ids = extractVideoIds(text);
            if (!ids.length) return { ok: false as const, error: 'No YouTube video links or ids found.' };
            return send<FoundVideo[]>({ type: 'pl/lookup', ids: ids.slice(0, 500) });
          })()
        : await send<FoundVideo[]>({ type: 'pl/search', q });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    const list = r.data ?? [];
    setResults(list);
    setPicked(new Set(list.map((v) => v.videoId)));
    if (!list.length) setError('No videos found.');
  };

  if (next)
    return (
      <AddToPlaylistFixed
        playlist={playlist}
        videos={results.filter((v) => picked.has(v.videoId)).map((v) => ({ videoId: v.videoId, title: v.title }))}
        onClose={onClose}
      />
    );

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={`Add videos to “${playlist.title}”`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={picked.size === 0} onClick={() => setNext(true)}>
            Add {picked.size} selected…
          </Button>
        </>
      }
    >
      <div role="tablist" className="mb-4 flex gap-1 rounded-lg border border-line p-0.5 text-sm">
        {(
          [
            ['paste', 'Paste links'],
            ['search', 'Search YouTube'],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            role="tab"
            aria-selected={tab === v}
            onClick={() => {
              setTab(v);
              setResults([]);
              setError(null);
            }}
            className={cx('flex-1 rounded-md px-3 py-1.5', tab === v ? 'bg-accent text-accent-ink' : 'text-ink-2 hover:text-ink')}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'paste' ? (
        <div className="space-y-2">
          <textarea
            name="links"
            aria-label="Video links"
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste YouTube links or video ids — one per line, or separated by spaces/commas"
            className="w-full rounded-lg border border-line bg-surface p-2.5 font-mono text-xs"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-ink-3">{extractVideoIds(text).length} video id(s) detected · 1 API unit per 50</span>
            <Button disabled={busy || !text.trim()} onClick={load}>
              {busy ? 'Looking up…' : 'Look up videos'}
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
        >
          <div className="flex gap-2">
            <input
              name="q"
              aria-label="Search YouTube"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search YouTube…"
              className="h-9 flex-1 rounded-lg border border-line bg-surface px-3 text-sm"
            />
            <Button type="submit" disabled={busy || !q.trim()}>
              {busy ? 'Searching…' : 'Search'}
            </Button>
          </div>
          <p className="text-xs text-ink-3">
            YouTube allows only ~100 searches per day for this extension in total, so use search sparingly — pasting links is unlimited.
          </p>
        </form>
      )}
      {error && (
        <div className="mt-3">
          <Notice tone="danger">{error}</Notice>
        </div>
      )}
      {results.length > 0 && (
        <ul className="mt-4 max-h-[45vh] space-y-1 overflow-y-auto">
          {results.map((v) => (
            <li key={v.videoId}>
              <label className="flex cursor-pointer items-center gap-3 rounded-lg p-1.5 hover:bg-surface-2">
                <input
                  type="checkbox"
                  checked={picked.has(v.videoId)}
                  onChange={() =>
                    setPicked((s) => {
                      const n = new Set(s);
                      if (n.has(v.videoId)) n.delete(v.videoId);
                      else n.add(v.videoId);
                      return n;
                    })
                  }
                  className="h-4 w-4 accent-[var(--color-accent)]"
                />
                <Thumb url={v.thumbnailUrl} alt="" className="aspect-video w-28" />
                <div className="min-w-0 flex-1">
                  <div className="line-clamp-2 text-sm font-medium">{v.title}</div>
                  <div className="text-xs text-ink-3">
                    {v.channelTitle} · {formatDuration(v.duration)} · {formatDate(v.publishedAt)}
                  </div>
                </div>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/** Add to a fixed destination (used by AddVideos). Skips duplicates by default. */
function AddToPlaylistFixed({ playlist, videos, onClose }: { playlist: Playlist; videos: PickedVideo[]; onClose: () => void }) {
  const [dupes, setDupes] = useState<string[] | null>(null);
  const [skip, setSkip] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opId, setOpId] = useState<string | null>(null);
  useEffect(() => {
    void send<string[]>({ type: 'pl/duplicates', playlistId: playlist.id, videoIds: videos.map((v) => v.videoId) }).then((r) =>
      r.ok ? setDupes(r.data ?? []) : setError(r.error),
    );
  }, [playlist.id, videos]);
  if (opId) return <OpProgressModal opId={opId} onClose={onClose} />;
  const count = skip ? videos.length - (dupes?.length ?? 0) : videos.length;
  return (
    <Modal
      open
      onClose={onClose}
      title={`Add to “${playlist.title}”`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={dupes === null || count === 0}
            onClick={async () => {
              const r = await send<{ op: BulkOp }>({
                type: 'op/start',
                kind: 'add',
                label: `Add ${videos.length} videos → ${playlist.title}`,
                destPlaylistId: playlist.id,
                skipDuplicates: skip,
                items: videos.map((v) => ({ videoId: v.videoId, title: v.title })),
              });
              if (r.ok && r.data) setOpId(r.data.op.id);
              else setError(r.ok ? 'Could not start.' : r.error);
            }}
          >
            Add {count} video{count === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      {dupes === null && !error && <p className="text-sm text-ink-3">Checking for duplicates…</p>}
      {dupes && dupes.length > 0 && (
        <Notice tone="warn">
          <b>
            {dupes.length} selected video{dupes.length === 1 ? ' is' : 's are'} already in this playlist.
          </b>
          <div className="mt-2 flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" name="dupes2" checked={skip} onChange={() => setSkip(true)} /> Skip duplicates
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="dupes2" checked={!skip} onChange={() => setSkip(false)} /> Add anyway
            </label>
          </div>
        </Notice>
      )}
      {dupes && dupes.length === 0 && <p className="text-sm">Ready to add {videos.length} videos.</p>}
      {error && <Notice tone="danger">{error}</Notice>}
    </Modal>
  );
}
