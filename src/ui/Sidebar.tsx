import { useState, type DragEvent, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { BRAND } from '@/config/brand';
import { addTagToChannels, createTag, deleteTag, moveTag, setFavorite, setReviewLater, updateTag } from '@/db/repo';
import { navigate, useAuth, useRoute, useTags } from './hooks';
import { Button, ConfirmDialog, cx, Modal, useToast } from './primitives';
import type { Tag } from '@/lib/types';

/** MIME type used when dragging channels from the list onto a sidebar target. */
export const DRAG_MIME = 'application/x-ysm-channels';

function readDrag(e: DragEvent): string[] {
  try {
    const ids = JSON.parse(e.dataTransfer.getData(DRAG_MIME) || '[]') as unknown;
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function NavItem({
  to,
  icon,
  label,
  count,
  active,
  onDropIds,
  extra,
}: {
  to: string;
  icon: string;
  label: string;
  count?: number;
  active: boolean;
  onDropIds?: (ids: string[]) => void;
  extra?: ReactNode;
}) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={cx(
        'group flex items-center rounded-lg',
        active ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
        over && 'ring-2 ring-accent',
      )}
      onDragOver={
        onDropIds
          ? (e) => {
              if (e.dataTransfer.types.includes(DRAG_MIME)) {
                e.preventDefault();
                setOver(true);
              }
            }
          : undefined
      }
      onDragLeave={() => setOver(false)}
      onDrop={
        onDropIds
          ? (e) => {
              e.preventDefault();
              setOver(false);
              onDropIds(readDrag(e));
            }
          : undefined
      }
    >
      <a
        href={`#${to}`}
        aria-current={active ? 'page' : undefined}
        className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1.5 text-sm"
      >
        <span className="w-5 shrink-0 text-center" aria-hidden>
          {icon}
        </span>
        <span className="truncate">{label}</span>
        {count !== undefined && <span className="ml-auto text-xs text-ink-3 tabular-nums">{count}</span>}
      </a>
      {extra}
    </div>
  );
}

const EMOJIS = ['📁', '📚', '💻', '🤖', '🎮', '🎵', '🎬', '📰', '💼', '⭐', '🍳', '🏋️', '✈️', '🔬', '🎨', '🧠', '💰', '⚽', '🎙️', '🧩'];

export function TagEditor({
  open,
  tag,
  onClose,
}: {
  open: boolean;
  tag?: Tag;
  onClose: () => void;
}) {
  const [name, setName] = useState(tag?.name ?? '');
  const [emoji, setEmoji] = useState(tag?.emoji ?? '📁');
  const toast = useToast();
  const save = async () => {
    if (!name.trim()) return;
    if (tag) await updateTag(tag.id, { name, emoji });
    else await createTag(name, emoji);
    toast(tag ? 'Category updated' : `Category “${name.trim()}” created`);
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={tag ? 'Edit category' : 'New category'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={!name.trim()}>
            Save
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="block text-xs font-medium text-ink-2" htmlFor="tag-name">
          Name
        </label>
        <input
          id="tag-name"
          autoFocus
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm"
          placeholder="e.g. Programming"
        />
        <div className="mt-4 text-xs font-medium text-ink-2">Icon</div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {EMOJIS.map((em) => (
            <button
              key={em}
              type="button"
              aria-label={`Icon ${em}`}
              aria-pressed={emoji === em}
              onClick={() => setEmoji(em)}
              className={cx('h-9 w-9 rounded-lg text-lg', emoji === em ? 'bg-accent-soft ring-2 ring-accent' : 'hover:bg-surface-2')}
            >
              {em}
            </button>
          ))}
        </div>
      </form>
    </Modal>
  );
}

export function Sidebar() {
  const { path, params } = useRoute();
  const tags = useTags();
  const auth = useAuth();
  const toast = useToast();
  const [editing, setEditing] = useState<Tag | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Tag | null>(null);
  const [menu, setMenu] = useState<string | null>(null);

  const counts = useLiveQuery(async () => {
    const subscribed = await db.channels.where('subscribed').equals(1).primaryKeys();
    const subSet = new Set(subscribed);
    const ct = await db.channelTags.toArray();
    const byTag = new Map<string, number>();
    const tagged = new Set<string>();
    for (const r of ct) {
      if (!subSet.has(r.channelId)) continue;
      byTag.set(r.tagId, (byTag.get(r.tagId) ?? 0) + 1);
      tagged.add(r.channelId);
    }
    const flags = await db.flags.toArray();
    return {
      all: subscribed.length,
      byTag,
      untagged: subscribed.length - tagged.size,
      favorites: flags.filter((f) => f.favorite === 1 && subSet.has(f.channelId)).length,
      review: flags.filter((f) => f.reviewLater === 1 && subSet.has(f.channelId)).length,
      unsubscribed: await db.unsubscribed.where('status').anyOf('unsubscribed', 'pending', 'failed').count(),
      playlists: await db.playlists.count(),
      deleted: (await db.deletionLog.filter((l) => !l.restoredAt).count()) + (await db.unsubscribed.where('status').equals('unsubscribed').count()),
      watchLater: await db.watchLater.filter((w) => !w.hidden).count(),
    };
  }, []);

  const view = params.get('view');
  const tagParam = params.get('tag');
  const isChannels = path === '/channels';

  return (
    <nav aria-label="Main" className="flex w-60 shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-sm font-bold text-accent-ink" aria-hidden>
          ▤
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{BRAND.name}</div>
          <div className="text-[11px] text-ink-3">Local · Private · Free</div>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
        <NavItem to="/overview" icon="🏠" label="Overview" active={path === '/overview'} />
        <NavItem to="/channels" icon="📋" label="All subscriptions" count={counts?.all} active={isChannels && !view && !tagParam} />
        <NavItem
          to="/channels?view=favorites"
          icon="⭐"
          label="Favorites"
          count={counts?.favorites}
          active={isChannels && view === 'favorites'}
          onDropIds={(ids) => void setFavorite(ids, true).then(() => toast(`${ids.length} added to Favorites`))}
        />
        <NavItem
          to="/channels?view=review"
          icon="🕐"
          label="Review Later"
          count={counts?.review}
          active={isChannels && view === 'review'}
          onDropIds={(ids) => void setReviewLater(ids, true).then(() => toast(`${ids.length} moved to Review Later`))}
        />

        <div className="flex items-center justify-between px-2.5 pt-4 pb-1">
          <a href="#/categories" title="Open all categories" className="text-[11px] font-semibold tracking-wide text-ink-3 uppercase hover:text-accent">
            Categories
          </a>
          <span className="flex items-center gap-0.5">
            <button
              aria-label="Auto-categorize"
              title="Auto-categorize"
              onClick={() => navigate('/channels?auto=1')}
              className="rounded px-1.5 text-sm leading-none text-ink-3 hover:bg-surface-2 hover:text-ink"
            >
              ✨
            </button>
            <button
              aria-label="New category"
              title="New category"
              onClick={() => setEditing('new')}
              className="rounded px-1.5 text-base leading-none text-ink-3 hover:bg-surface-2 hover:text-ink"
            >
              +
            </button>
          </span>
        </div>
        {tags.map((t, i) => (
          <NavItem
            key={t.id}
            to={`/channels?tag=${t.id}`}
            icon={t.emoji}
            label={t.name}
            count={counts?.byTag.get(t.id) ?? 0}
            active={isChannels && tagParam === t.id}
            onDropIds={(ids) => void addTagToChannels(t.id, ids).then(() => toast(`${ids.length} added to ${t.name}`))}
            extra={
              <div className="relative">
                <button
                  aria-label={`Options for ${t.name}`}
                  aria-expanded={menu === t.id}
                  onClick={() => setMenu(menu === t.id ? null : t.id)}
                  className="mr-1 rounded px-1.5 text-ink-3 opacity-0 group-hover:opacity-100 hover:text-ink focus:opacity-100"
                >
                  ⋯
                </button>
                {menu === t.id && (
                  <div
                    className="absolute top-7 right-0 z-20 w-36 rounded-lg border border-line bg-surface p-1 text-sm text-ink shadow-lg"
                    onMouseLeave={() => setMenu(null)}
                  >
                    {[
                      ['Rename / icon', () => setEditing(t)],
                      ['Move up', () => void moveTag(t.id, -1)],
                      ['Move down', () => void moveTag(t.id, 1)],
                      ['Delete', () => setDeleting(t)],
                    ].map(([label, fn], k) => (
                      <button
                        key={label as string}
                        disabled={(k === 1 && i === 0) || (k === 2 && i === tags.length - 1)}
                        onClick={() => {
                          setMenu(null);
                          (fn as () => void)();
                        }}
                        className={cx(
                          'block w-full rounded px-2 py-1.5 text-left hover:bg-surface-2 disabled:opacity-40',
                          label === 'Delete' && 'text-danger',
                        )}
                      >
                        {label as string}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            }
          />
        ))}
        <NavItem
          to="/channels?tag=untagged"
          icon="📂"
          label="Uncategorized"
          count={counts?.untagged}
          active={isChannels && tagParam === 'untagged'}
        />
        {tags.length === 0 && (
          <p className="px-2.5 py-1 text-xs text-ink-3">Create categories with +, then drag channels onto them.</p>
        )}

        <div className="px-2.5 pt-4 pb-1 text-[11px] font-semibold tracking-wide text-ink-3 uppercase">Library</div>
        <NavItem to="/playlists" icon="📚" label="Playlists" count={counts?.playlists} active={path === '/playlists' || path === '/playlist'} />
        <NavItem to="/watch-later" icon="🔖" label="Watch Later" count={counts?.watchLater} active={path === '/watch-later'} />

        <div className="px-2.5 pt-4 pb-1 text-[11px] font-semibold tracking-wide text-ink-3 uppercase">Insights</div>
        <NavItem to="/channels?view=inactive" icon="💤" label="Inactive" active={isChannels && view === 'inactive'} />
        <NavItem to="/analytics" icon="📊" label="Watch analytics" active={path === '/analytics'} />
        <NavItem to="/cleanup" icon="🧹" label="Cleanup center" active={path === '/cleanup'} />
        <NavItem to="/bells" icon="🔔" label="Bell audit" active={path === '/bells'} />
        <NavItem to="/unsubscribed" icon="📤" label="Unsubscribed" count={counts?.unsubscribed} active={path === '/unsubscribed'} />
        <NavItem to="/deleted" icon="🗑" label="Deleted items" count={counts?.deleted} active={path === '/deleted'} />
      </div>

      <div className="border-t border-line p-2">
        <NavItem to="/settings" icon="⚙️" label="Settings & data" active={path === '/settings'} />
        <div className="truncate px-2.5 pt-1 text-[11px] text-ink-3">
          {auth.signedIn ? `Connected: ${auth.accountTitle ?? 'YouTube account'}` : 'Not connected'}
        </div>
      </div>

      {editing && <TagEditor open tag={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={!!deleting}
        title="Delete category?"
        danger
        confirmLabel="Delete category"
        body={
          <>
            Delete <b>{deleting?.emoji} {deleting?.name}</b>? Channels stay subscribed and keep their other categories —
            only this local category is removed.
          </>
        }
        onConfirm={async () => {
          if (deleting) await deleteTag(deleting.id);
          if (tagParam === deleting?.id) navigate('/channels');
          toast('Category deleted');
        }}
        onClose={() => setDeleting(null)}
      />
    </nav>
  );
}
