import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import type { BulkOp, Playlist, PlaylistPrivacy } from '@/lib/types';
import { formatDate, relativeTime } from '@/lib/time';
import { addTagToPlaylists, autoCategorizePlaylists, removeTagFromPlaylists } from '@/db/repo';
import { validatePlaylistInput } from '@/features/playlist-input';
import { navigate, send, useAuth, useTags } from '../hooks';
import { Button, ConfirmDialog, cx, EmptyState, Modal, Notice, PageHeader, Select, useToast } from '../primitives';
import { ActiveOps, OpProgressModal, PrivacyBadge, Thumb } from '../playlists/common';
import { PlaylistForm } from '../playlists/dialogs';

type SortKey = 'title' | 'count-desc' | 'count-asc' | 'newest' | 'oldest';

export function PlaylistsPage() {
  const auth = useAuth();
  const toast = useToast();
  const tags = useTags();
  const playlists = useLiveQuery(() => db.playlists.toArray(), []);
  const playlistTags = useLiveQuery(() => db.playlistTags.toArray(), []);
  const [q, setQ] = useState('');
  const [privacy, setPrivacy] = useState<'all' | PlaylistPrivacy>('all');
  const [tagFilter, setTagFilter] = useState('');
  const [sort, setSort] = useState<SortKey>('title');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<null | 'create' | 'delete' | 'merge' | { opId: string }>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setBusy(true);
    setError(null);
    const r = await send<number>({ type: 'pl/sync' });
    setBusy(false);
    if (!r.ok) setError(r.error);
    else toast(`Loaded ${r.data ?? 0} playlists`);
  };

  useEffect(() => {
    if (auth.signedIn && playlists && playlists.length === 0) void refresh();
  }, [auth.signedIn, playlists?.length === 0]);

  const tagsByPlaylist = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const t of playlistTags ?? []) m.set(t.playlistId, [...(m.get(t.playlistId) ?? []), t.tagId]);
    return m;
  }, [playlistTags]);
  const tagMap = new Map(tags.map((t) => [t.id, t]));

  const shown = useMemo(() => {
    if (!playlists) return [];
    const ql = q.trim().toLowerCase();
    const list = playlists.filter((p) => {
      const pt = tagsByPlaylist.get(p.id) ?? [];
      if (privacy !== 'all' && p.privacy !== privacy) return false;
      if (tagFilter === 'untagged' ? pt.length > 0 : tagFilter && !pt.includes(tagFilter)) return false;
      const tagNames = pt.map((t) => tagMap.get(t)?.name ?? '').join(' ');
      return !ql || `${p.title} ${p.description} ${tagNames}`.toLowerCase().includes(ql);
    });
    const cmp: Record<SortKey, (a: Playlist, b: Playlist) => number> = {
      title: (a, b) => a.title.localeCompare(b.title),
      'count-desc': (a, b) => b.itemCount - a.itemCount,
      'count-asc': (a, b) => a.itemCount - b.itemCount,
      newest: (a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0),
      oldest: (a, b) => (a.publishedAt ?? 0) - (b.publishedAt ?? 0),
    };
    return [...list].sort(cmp[sort]);
  }, [playlists, q, privacy, sort, tagFilter, tagsByPlaylist, tags]);

  const lastFetched = playlists?.reduce((m, p) => Math.max(m, p.fetchedAt), 0);
  const sel = (playlists ?? []).filter((p) => selected.has(p.id));
  const allShownSelected = shown.length > 0 && shown.every((p) => selected.has(p.id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div>
      <PageHeader
        title="📚 Playlists"
        subtitle={lastFetched ? `Your YouTube playlists · updated ${relativeTime(lastFetched)}` : 'Your YouTube playlists'}
        actions={
          <>
            <Button onClick={refresh} disabled={busy || !auth.signedIn}>
              {busy ? 'Refreshing…' : 'Refresh'}
            </Button>
            <Button
              onClick={async () => {
                const n = await autoCategorizePlaylists((playlists ?? []).map((p) => p.id), true);
                toast(n ? `Categorized ${n} playlists (local only)` : 'All playlists already have a category');
              }}
              disabled={!playlists?.length}
            >
              ✨ Auto-categorize
            </Button>
            <Button variant="primary" onClick={() => setDialog('create')} disabled={!auth.signedIn}>
              + Create playlist
            </Button>
          </>
        }
      />
      <div className="space-y-4 p-6">
        {!auth.signedIn && <Notice tone="warn">Connect your YouTube account in Settings to manage playlists.</Notice>}
        {error && <Notice tone="danger">{error}</Notice>}
        <ActiveOps />
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="checkbox"
            aria-label={allShownSelected ? 'Deselect all' : 'Select all shown'}
            checked={allShownSelected}
            onChange={() => setSelected(allShownSelected ? new Set() : new Set(shown.map((p) => p.id)))}
            className="h-4 w-4 accent-[var(--color-accent)]"
          />
          <input
            type="search"
            name="q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search playlists or categories…"
            aria-label="Search playlists"
            className="h-8 min-w-56 flex-1 rounded-lg border border-line bg-surface px-3 text-sm"
          />
          <div role="group" aria-label="Privacy" className="flex rounded-lg border border-line bg-surface p-0.5 text-xs">
            {(['all', 'public', 'unlisted', 'private'] as const).map((p) => (
              <button
                key={p}
                aria-pressed={privacy === p}
                onClick={() => setPrivacy(p)}
                className={cx('rounded-md px-2.5 py-1 capitalize', privacy === p ? 'bg-accent text-accent-ink' : 'text-ink-2 hover:text-ink')}
              >
                {p}
              </button>
            ))}
          </div>
          <Select<string>
            label="Category"
            value={tagFilter}
            onChange={setTagFilter}
            options={[
              { value: '', label: 'All categories' },
              { value: 'untagged', label: 'Uncategorized' },
              ...tags.map((t) => ({ value: t.id, label: `${t.emoji} ${t.name}` })),
            ]}
          />
          <Select<SortKey>
            label="Sort"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'title', label: 'Name A–Z' },
              { value: 'count-desc', label: 'Most videos' },
              { value: 'count-asc', label: 'Fewest videos' },
              { value: 'newest', label: 'Newest' },
              { value: 'oldest', label: 'Oldest' },
            ]}
          />
        </div>
        <p className="text-xs text-ink-3">
          Categories are stored only in this extension. YouTube’s API doesn’t provide a “last updated” time, so dates shown are creation dates.
        </p>

        {selected.size > 0 && (
          <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-accent-soft px-4 py-2 text-sm">
            <b className="tabular-nums">
              {selected.size} playlist{selected.size === 1 ? '' : 's'} selected
            </b>
            <Button size="sm" disabled={!auth.signedIn} onClick={() => setDialog('merge')}>
              Merge / combine…
            </Button>
            <select
              aria-label="Add to category"
              className="h-7 rounded-lg border border-line bg-surface px-2 text-xs"
              value=""
              onChange={(e) => {
                const t = tags.find((x) => x.id === e.target.value);
                if (t) void addTagToPlaylists(t.id, [...selected]).then(() => toast(`Added ${selected.size} to ${t.name}`));
              }}
            >
              <option value="">＋ Add to category…</option>
              {tags.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.emoji} {t.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Remove from category"
              className="h-7 rounded-lg border border-line bg-surface px-2 text-xs"
              value=""
              onChange={(e) => {
                const t = tags.find((x) => x.id === e.target.value);
                if (t) void removeTagFromPlaylists(t.id, [...selected]).then(() => toast(`Removed ${selected.size} from ${t.name}`));
              }}
            >
              <option value="">－ Remove from category…</option>
              {tags.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.emoji} {t.name}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              onClick={async () => {
                const n = await autoCategorizePlaylists([...selected], false);
                toast(`Categorized ${n} playlists`);
              }}
            >
              ✨ Auto-categorize
            </Button>
            <Button size="sm" variant="danger-outline" disabled={!auth.signedIn} onClick={() => setDialog('delete')}>
              Delete…
            </Button>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>
              Deselect all
            </Button>
          </div>
        )}

        {!playlists ? (
          <PlaylistSkeleton />
        ) : shown.length === 0 ? (
          <EmptyState icon="📚" title={playlists.length ? 'No playlists match' : 'No playlists yet'}>
            {playlists.length ? 'Try a different search or filter.' : auth.signedIn ? 'Press Refresh, or create your first playlist.' : ''}
          </EmptyState>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {shown.map((p) => {
              const checked = selected.has(p.id);
              const pt = (tagsByPlaylist.get(p.id) ?? []).map((t) => tagMap.get(t)).filter((t): t is NonNullable<typeof t> => !!t);
              return (
                <div
                  key={p.id}
                  className={cx(
                    'group relative overflow-hidden rounded-xl border bg-surface transition-colors',
                    checked ? 'border-accent ring-1 ring-accent' : 'border-line hover:border-accent',
                  )}
                >
                  <input
                    type="checkbox"
                    aria-label={`Select ${p.title}`}
                    checked={checked}
                    onChange={() => toggle(p.id)}
                    className={cx(
                      'absolute top-2.5 left-2.5 z-10 h-4.5 w-4.5 accent-[var(--color-accent)]',
                      checked ? 'opacity-100' : 'opacity-70 group-hover:opacity-100',
                    )}
                  />
                  <button onClick={() => navigate(`/playlist?id=${encodeURIComponent(p.id)}`)} className="block w-full text-left" aria-label={`Open ${p.title}`}>
                    <div className="relative">
                      <Thumb url={p.thumbnailUrl} alt="" className="aspect-video w-full rounded-none" />
                      <span className="absolute right-2 bottom-2 rounded-md bg-black/80 px-1.5 py-0.5 text-xs text-white tabular-nums">
                        ▤ {p.itemCount} videos
                      </span>
                    </div>
                    <div className="p-4">
                      <h3 className="line-clamp-1 font-semibold group-hover:text-accent">{p.title}</h3>
                      <p className="mt-1 line-clamp-2 h-8 text-xs text-ink-3">{p.description || 'No description'}</p>
                      <div className="mt-2 flex h-5 items-center gap-1 overflow-hidden text-[11px]">
                        {pt.length ? (
                          pt.map((t) => (
                            <span key={t.id} className="shrink-0 rounded-md bg-accent-soft px-1.5 py-0.5 text-accent">
                              {t.emoji} {t.name}
                            </span>
                          ))
                        ) : (
                          <span className="text-ink-3">Uncategorized</span>
                        )}
                      </div>
                      <div className="mt-2 flex items-center justify-between">
                        <PrivacyBadge privacy={p.privacy} />
                        <span className="text-[11px] text-ink-3">Created {formatDate(p.publishedAt)}</span>
                      </div>
                    </div>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {dialog === 'create' && <PlaylistForm onClose={() => setDialog(null)} onSaved={(p) => navigate(`/playlist?id=${encodeURIComponent(p.id)}`)} />}
      {dialog === 'merge' && (
        <MergeDialog
          selected={sel}
          all={playlists ?? []}
          onClose={() => setDialog(null)}
          onStarted={(opId) => {
            setSelected(new Set());
            setDialog({ opId });
          }}
        />
      )}
      {dialog && typeof dialog === 'object' && <OpProgressModal opId={dialog.opId} onClose={() => setDialog(null)} />}
      <ConfirmDialog
        open={dialog === 'delete'}
        title={`Delete ${sel.length} playlist${sel.length === 1 ? '' : 's'} permanently?`}
        danger
        confirmLabel={`Delete ${sel.length} playlist${sel.length === 1 ? '' : 's'}`}
        body={
          <div className="space-y-2">
            <p>These playlists will be deleted from your YouTube account. This can’t be undone. The videos themselves are not deleted.</p>
            <ul className="max-h-40 list-inside list-disc overflow-y-auto text-ink">
              {sel.map((p) => (
                <li key={p.id}>
                  {p.title} <span className="text-ink-3">({p.itemCount} videos)</span>
                </li>
              ))}
            </ul>
          </div>
        }
        onConfirm={async () => {
          const r = await send<{ op: BulkOp }>({ type: 'pl/deleteMany', ids: sel.map((p) => p.id) });
          if (!r.ok || !r.data) throw new Error(r.ok ? 'Could not start.' : r.error);
          setSelected(new Set());
          setDialog({ opId: r.data.op.id });
        }}
        onClose={() => setDialog((d) => (d === 'delete' ? null : d))}
      />
    </div>
  );
}

/** Merge/combine: all videos of the selected playlists into one target (existing or new). */
function MergeDialog({
  selected,
  all,
  onClose,
  onStarted,
}: {
  selected: Playlist[];
  all: Playlist[];
  onClose: () => void;
  onStarted: (opId: string) => void;
}) {
  const [mode, setMode] = useState<'existing' | 'new'>(selected.length > 1 ? 'existing' : 'new');
  const [targetId, setTargetId] = useState(selected[0]?.id ?? '');
  const [name, setName] = useState(selected.length ? `${selected.map((p) => p.title).slice(0, 2).join(' + ')}${selected.length > 2 ? ' + …' : ''}` : '');
  const [privacy, setPrivacy] = useState<PlaylistPrivacy>('private');
  const [deleteSources, setDeleteSources] = useState(false);
  const [skipDuplicates, setSkip] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sources = mode === 'existing' ? selected.filter((p) => p.id !== targetId) : selected;
  const totalVideos = sources.reduce((n, p) => n + p.itemCount, 0);
  const invalid = mode === 'new' ? validatePlaylistInput({ title: name, description: '' }) : !targetId ? 'Choose a target playlist.' : null;

  const start = async () => {
    if (invalid) return setError(invalid);
    if (!sources.length) return setError('Select at least one other playlist to merge.');
    setBusy(true);
    setError(null);
    const r = await send<{ op: BulkOp }>({
      type: 'pl/merge',
      sourceIds: sources.map((p) => p.id),
      target: mode === 'existing' ? { id: targetId } : { create: { title: name.trim(), description: `Merged from: ${sources.map((p) => p.title).join(', ')}`.slice(0, 5000), privacy } },
      deleteSources,
      skipDuplicates,
    });
    setBusy(false);
    if (r.ok && r.data) onStarted(r.data.op.id);
    else setError(r.ok ? 'Could not start.' : r.error);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Merge / combine playlists"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !!invalid || !sources.length} onClick={start}>
            {busy ? 'Preparing…' : `Merge ${sources.length} playlist${sources.length === 1 ? '' : 's'}`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <fieldset>
          <legend className="text-xs font-medium text-ink-2">Combine into</legend>
          <div className="mt-1.5 grid grid-cols-2 gap-2">
            {(
              [
                ['existing', 'An existing playlist'],
                ['new', 'A new playlist'],
              ] as const
            ).map(([v, label]) => (
              <label key={v} className={cx('cursor-pointer rounded-lg border px-3 py-2 text-sm', mode === v ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2')}>
                <input type="radio" name="merge-mode" className="sr-only" checked={mode === v} onChange={() => setMode(v)} />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        {mode === 'existing' ? (
          <div>
            <label htmlFor="merge-target" className="text-xs font-medium text-ink-2">
              Target playlist
            </label>
            <select id="merge-target" value={targetId} onChange={(e) => setTargetId(e.target.value)} className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-2 text-sm">
              {[...all]
                .sort((a, b) => a.title.localeCompare(b.title))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title} ({p.itemCount}){selected.some((s) => s.id === p.id) ? ' — selected' : ''}
                  </option>
                ))}
            </select>
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <div>
              <label htmlFor="merge-name" className="text-xs font-medium text-ink-2">
                New playlist name
              </label>
              <input id="merge-name" name="merge-name" maxLength={150} value={name} onChange={(e) => setName(e.target.value)} className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm" />
            </div>
            <div>
              <label htmlFor="merge-privacy" className="text-xs font-medium text-ink-2">
                Privacy
              </label>
              <select id="merge-privacy" value={privacy} onChange={(e) => setPrivacy(e.target.value as PlaylistPrivacy)} className="mt-1 h-9 rounded-lg border border-line bg-surface px-2 text-sm">
                <option value="private">Private</option>
                <option value="unlisted">Unlisted</option>
                <option value="public">Public</option>
              </select>
            </div>
          </div>
        )}
        <div className="rounded-lg bg-surface-2 p-3 text-sm">
          <div className="text-xs text-ink-3">Videos will be copied from:</div>
          <ul className="mt-1 max-h-28 list-inside list-disc overflow-y-auto">
            {sources.map((p) => (
              <li key={p.id}>
                {p.title} <span className="text-ink-3">({p.itemCount})</span>
              </li>
            ))}
          </ul>
          {!sources.length && <p className="text-xs text-danger">Select at least one playlist other than the target.</p>}
          <div className="mt-1 text-xs text-ink-3">About {totalVideos} videos · 50 API units each · same video is added only once</div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="skip-dupes" checked={skipDuplicates} onChange={(e) => setSkip(e.target.checked)} /> Skip videos already in the target
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="delete-sources" className="mt-0.5" checked={deleteSources} onChange={(e) => setDeleteSources(e.target.checked)} />
          <span>
            Delete the source playlists afterwards
            <span className="block text-xs text-ink-3">Only happens if every video was added successfully. Otherwise the sources are kept.</span>
          </span>
        </label>
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Modal>
  );
}

function PlaylistSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true" aria-label="Loading playlists">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="overflow-hidden rounded-xl border border-line bg-surface">
          <div className="aspect-video animate-pulse bg-surface-2" />
          <div className="space-y-2 p-4">
            <div className="h-4 w-2/3 animate-pulse rounded bg-surface-2" />
            <div className="h-3 w-full animate-pulse rounded bg-surface-2" />
          </div>
        </div>
      ))}
    </div>
  );
}
