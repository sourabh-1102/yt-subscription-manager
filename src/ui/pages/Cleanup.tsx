import { useMemo, useState } from 'react';
import { CLEANUP_RULES, cleanupReason, matchesRule, sortRows, type CleanupRule } from '@/features/logic';
import { useChannelRows, useSelection, useTags } from '../hooks';
import { cx, EmptyState, PageHeader } from '../primitives';
import { ChannelList } from '../ChannelList';
import { BulkBar } from '../BulkBar';
import { ChannelDrawer } from '../ChannelDrawer';
import { TrackingBanner, ConnectPrompt } from './Overview';

/**
 * Cleanup center. Rules only *suggest* channels — nothing happens until the user selects
 * channels and goes through the Review Assistant.
 */
export function CleanupPage() {
  const rows = useChannelRows();
  const tags = useTags();
  const selection = useSelection();
  const [rules, setRules] = useState<Set<CleanupRule>>(new Set(['never']));
  const [mode, setMode] = useState<'any' | 'all'>('any');
  const [open, setOpen] = useState<string | null>(null);

  const counts = useMemo(() => {
    const m = new Map<CleanupRule, number>();
    if (rows) for (const rule of CLEANUP_RULES) m.set(rule.id, rows.filter((r) => matchesRule(r, rule.id)).length);
    return m;
  }, [rows]);

  const candidates = useMemo(() => {
    if (!rows || rules.size === 0) return [];
    const list = rows.filter((r) =>
      mode === 'any' ? [...rules].some((rule) => matchesRule(r, rule)) : [...rules].every((rule) => matchesRule(r, rule)),
    );
    return sortRows(list, 'lastWatched', 'asc');
  }, [rows, rules, mode]);

  const openRow = open ? rows?.find((r) => r.channel.id === open) : undefined;

  if (rows && rows.length === 0)
    return (
      <>
        <PageHeader title="Cleanup center" />
        <ConnectPrompt />
      </>
    );

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="🧹 Cleanup center"
        subtitle="Pick the signals that matter to you. Suggestions only — nothing is changed until you review and confirm."
      />
      <div className="space-y-3 border-b border-line px-6 py-4">
        <TrackingBanner />
        <div className="flex flex-wrap gap-2">
          {CLEANUP_RULES.map((rule) => {
            const on = rules.has(rule.id);
            return (
              <button
                key={rule.id}
                aria-pressed={on}
                title={rule.hint}
                onClick={() =>
                  setRules((s) => {
                    const n = new Set(s);
                    if (n.has(rule.id)) n.delete(rule.id);
                    else n.add(rule.id);
                    return n;
                  })
                }
                className={cx(
                  'rounded-full border px-3 py-1 text-xs',
                  on ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-line text-ink-2 hover:bg-surface-2',
                )}
              >
                {rule.label} <span className="tabular-nums opacity-70">{counts.get(rule.id) ?? 0}</span>
              </button>
            );
          })}
        </div>
        {rules.size > 1 && (
          <div className="flex items-center gap-2 text-xs text-ink-2">
            Match
            {(['any', 'all'] as const).map((m) => (
              <button
                key={m}
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={cx('rounded-md px-2 py-0.5', mode === m ? 'bg-accent text-accent-ink' : 'border border-line')}
              >
                {m === 'any' ? 'any signal' : 'all signals'}
              </button>
            ))}
          </div>
        )}
      </div>
      <BulkBar selection={selection} rows={rows ?? []} />
      {candidates.length === 0 ? (
        <EmptyState icon="✨" title={rules.size ? 'Nothing to clean up' : 'Pick at least one signal'}>
          {rules.size ? 'No subscriptions match these signals.' : 'Choose signals above to see suggestions.'}
        </EmptyState>
      ) : (
        <ChannelList
          rows={candidates}
          tags={tags}
          selection={selection}
          onOpen={(r) => setOpen(r.channel.id)}
          height="calc(100vh - 300px)"
          renderMeta={(r) => <span className="hidden max-w-xs shrink-0 truncate text-xs text-ink-2 md:block">{cleanupReason(r)}</span>}
        />
      )}
      {openRow && <ChannelDrawer row={openRow} onClose={() => setOpen(null)} />}
    </div>
  );
}
