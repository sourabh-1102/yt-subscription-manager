import { useState } from 'react';
import type { ChannelRow } from '@/features/logic';
import { cleanupReason } from '@/features/logic';
import { addTagToChannels, removeTagFromChannels, setFavorite, setReviewLater } from '@/db/repo';
import { buildBackup, downloadJson } from '@/services/backup';
import { useTags, type Selection } from './hooks';
import { Button, useToast } from './primitives';
import { ReviewAssistant, type ReviewItem } from './ReviewAssistant';

/** Bulk actions for the current selection. Everything except Unsubscribe is local-only. */
export function BulkBar({ selection, rows }: { selection: Selection; rows: ChannelRow[] }) {
  const tags = useTags();
  const toast = useToast();
  const [review, setReview] = useState<ReviewItem[] | null>(null);
  const ids = [...selection.selected];
  if (!ids.length) return null;

  const byId = new Map(rows.map((r) => [r.channel.id, r]));
  const done = (msg: string) => toast(msg);

  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-accent-soft px-4 py-2 text-sm">
      <b className="mr-1 tabular-nums">{ids.length} selected</b>
      <select
        aria-label="Add to category"
        className="h-7 rounded-lg border border-line bg-surface px-2 text-xs"
        value=""
        onChange={(e) => {
          const t = tags.find((x) => x.id === e.target.value);
          if (t) void addTagToChannels(t.id, ids).then(() => done(`Added ${ids.length} to ${t.name}`));
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
          if (t) void removeTagFromChannels(t.id, ids).then(() => done(`Removed ${ids.length} from ${t.name}`));
        }}
      >
        <option value="">－ Remove from category…</option>
        {tags.map((t) => (
          <option key={t.id} value={t.id}>
            {t.emoji} {t.name}
          </option>
        ))}
      </select>
      <Button size="sm" onClick={() => void setFavorite(ids, true).then(() => done('Added to Favorites'))}>
        ⭐ Favorite
      </Button>
      <Button size="sm" onClick={() => void setFavorite(ids, false).then(() => done('Removed from Favorites'))}>
        Unfavorite
      </Button>
      <Button size="sm" onClick={() => void setReviewLater(ids, true).then(() => done('Moved to Review Later'))}>
        🕐 Review later
      </Button>
      <Button size="sm" onClick={() => void setReviewLater(ids, false).then(() => done('Removed from Review Later'))}>
        Clear review
      </Button>
      <Button
        size="sm"
        onClick={async () => {
          downloadJson(await buildBackup({ channelIds: ids }), `channels-export-${ids.length}.json`);
          done(`Exported ${ids.length} channels`);
        }}
      >
        Export
      </Button>
      <span className="mx-1 h-5 w-px bg-line" aria-hidden />
      <Button
        size="sm"
        variant="danger-outline"
        onClick={() => {
          const chosen = ids.map((id) => byId.get(id)).filter((r): r is ChannelRow => !!r);
          const eligible = chosen.filter((r) => !!r.channel.subscriptionId);
          if (!eligible.length) {
            toast('These channels can only be unsubscribed after you connect your YouTube account and sync (Settings).', 'error');
            return;
          }
          if (eligible.length < chosen.length)
            toast(`${chosen.length - eligible.length} channel(s) skipped — not synced from your YouTube account.`, 'info');
          setReview(
            eligible.map((r) => ({
              id: r.channel.id,
              title: r.channel.title,
              thumbnailUrl: r.channel.thumbnailUrl,
              detail: cleanupReason(r),
            })),
          );
        }}
      >
        Unsubscribe…
      </Button>
      <Button size="sm" variant="ghost" className="ml-auto" onClick={selection.clear}>
        Clear selection
      </Button>
      {review && (
        <ReviewAssistant
          kind="unsubscribe"
          items={review}
          onClose={() => {
            setReview(null);
            selection.clear();
          }}
        />
      )}
    </div>
  );
}
