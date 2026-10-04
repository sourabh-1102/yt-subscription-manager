import { useMemo, useState } from 'react';
import type { BellIntent } from '@/lib/types';
import { setBellDone, setBellIntent } from '@/db/repo';
import { channelUrl } from '@/lib/youtube-urls';
import { applyFilters, DEFAULT_FILTERS } from '@/features/logic';
import { useChannelRows, usePrefs, useTags } from '../hooks';
import { Avatar, Button, Card, ConfirmDialog, cx, Notice, PageHeader, Select, useToast } from '../primitives';
import { ConnectPrompt } from './Overview';

const OPTIONS: { value: BellIntent; label: string }[] = [
  { value: 'all', label: '🔔 All' },
  { value: 'personalized', label: '🔔 Personalized' },
  { value: 'none', label: '🔕 None' },
];

/**
 * Bell audit. YouTube's API cannot read or change notification bells, and automating clicks on
 * youtube.com would break YouTube's policies — so the user plans bells here and applies them on
 * YouTube with one click per channel, tracking progress locally.
 */
export function BellAuditPage() {
  const rows = useChannelRows();
  const tags = useTags();
  const prefs = usePrefs();
  const toast = useToast();
  const [tag, setTag] = useState('');
  const [show, setShow] = useState<'todo' | 'all' | 'done' | 'unplanned'>('all');
  const [q, setQ] = useState('');
  const [bulk, setBulk] = useState<(typeof OPTIONS)[number] | null>(null);

  const list = useMemo(() => {
    if (!rows) return [];
    return applyFilters(rows, { ...DEFAULT_FILTERS, tag, q, sort: 'watchCount', dir: 'desc' }, tags, prefs.inactiveDays).filter((r) =>
      show === 'todo' ? r.bellIntent && !r.bellDone : show === 'done' ? r.bellDone : show === 'unplanned' ? !r.bellIntent : true,
    );
  }, [rows, tags, tag, q, show, prefs.inactiveDays]);

  const planned = rows?.filter((r) => r.bellIntent).length ?? 0;
  const done = rows?.filter((r) => r.bellIntent && r.bellDone).length ?? 0;

  if (rows && rows.length === 0)
    return (
      <>
        <PageHeader title="Bell audit" />
        <ConnectPrompt />
      </>
    );

  return (
    <div>
      <PageHeader
        title="🔔 Bell audit"
        subtitle={`${done} of ${planned} planned bell changes applied`}
        actions={
          <Select
            label="Show"
            value={show}
            onChange={setShow}
            options={[
              { value: 'all', label: 'All channels' },
              { value: 'todo', label: 'To apply on YouTube' },
              { value: 'done', label: 'Applied' },
              { value: 'unplanned', label: 'No plan yet' },
            ]}
          />
        }
      />
      <div className="space-y-4 p-6">
        <Notice>
          YouTube does not let apps read or change notification bells, so this extension can’t flip them for you. Plan the bell you want here
          (bulk by category works), then press <b>Open</b> — set the bell on YouTube and mark it done. Your plan is saved in this browser.
        </Notice>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search…"
            aria-label="Search channels"
            className="h-8 min-w-48 flex-1 rounded-lg border border-line bg-surface px-3 text-sm"
          />
          <Select
            label="Category"
            value={tag}
            onChange={setTag}
            options={[{ value: '', label: 'All categories' }, { value: 'untagged', label: 'Uncategorized' }, ...tags.map((t) => ({ value: t.id, label: `${t.emoji} ${t.name}` }))]}
          />
          <span className="text-xs text-ink-3">Set plan for all {list.length} shown:</span>
          {OPTIONS.map((o) => (
            <Button
              key={o.value}
              size="sm"
              onClick={() =>
                list.length > 25
                  ? setBulk(o)
                  : void setBellIntent(list.map((r) => r.channel.id), o.value).then(() => toast(`Planned ${o.label} for ${list.length} channels`))
              }
            >
              {o.label}
            </Button>
          ))}
        </div>
        <Card>
          <ul>
            {list.slice(0, 500).map((r) => (
              <li key={r.channel.id} className="flex flex-wrap items-center gap-3 border-b border-line/60 px-4 py-2.5 last:border-0">
                <Avatar url={r.channel.thumbnailUrl} title={r.channel.title} size={30} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{r.channel.title}</span>
                <div className="flex rounded-lg border border-line p-0.5" role="radiogroup" aria-label={`Bell plan for ${r.channel.title}`}>
                  {OPTIONS.map((o) => (
                    <button
                      key={o.value}
                      role="radio"
                      aria-checked={r.bellIntent === o.value}
                      onClick={() => void setBellIntent([r.channel.id], r.bellIntent === o.value ? undefined : o.value)}
                      className={cx('rounded-md px-2 py-0.5 text-xs', r.bellIntent === o.value ? 'bg-accent text-accent-ink' : 'text-ink-2 hover:text-ink')}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
                <a
                  href={channelUrl(r.channel.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-lg border border-line px-2.5 py-1 text-xs hover:bg-surface-2"
                >
                  Open ↗
                </a>
                <label className={cx('flex items-center gap-1.5 text-xs', !r.bellIntent && 'opacity-40')}>
                  <input
                    type="checkbox"
                    disabled={!r.bellIntent}
                    checked={r.bellDone}
                    onChange={(e) => void setBellDone([r.channel.id], e.target.checked)}
                    className="h-4 w-4 accent-[var(--color-ok)]"
                  />
                  Done
                </label>
              </li>
            ))}
          </ul>
          {list.length > 500 && <p className="px-4 py-3 text-xs text-ink-3">Showing first 500 — narrow with search or category.</p>}
          {list.length === 0 && <p className="px-4 py-6 text-center text-sm text-ink-3">No channels.</p>}
        </Card>
      </div>
      <ConfirmDialog
        open={!!bulk}
        title={`Plan ${bulk?.label ?? ''} for ${list.length} channels?`}
        confirmLabel="Apply plan"
        body="This replaces the bell plan (and resets the Done mark) for every channel currently shown. It only changes this checklist, not YouTube."
        onConfirm={async () => {
          if (!bulk) return;
          await setBellIntent(list.map((r) => r.channel.id), bulk.value);
          toast(`Planned ${bulk.label} for ${list.length} channels`);
        }}
        onClose={() => setBulk(null)}
      />
    </div>
  );
}
