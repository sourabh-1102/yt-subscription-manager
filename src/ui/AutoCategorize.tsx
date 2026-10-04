import { useMemo, useState } from 'react';
import { CATEGORY_DEFS, defByKey, FALLBACK_DEF } from '@/features/categorize';
import { applyCategorization } from '@/db/repo';
import type { ChannelRow } from '@/features/logic';
import { send, useAuth } from './hooks';
import { Avatar, Button, cx, Modal, Notice, useToast } from './primitives';

interface Suggestion {
  channelId: string;
  keys: string[];
  reason: string;
}

const ALL_DEFS = [...CATEGORY_DEFS, FALLBACK_DEF];
const SKIP = '__skip';

/**
 * Auto-categorize: analyze → review (grouped cards, change any channel) → apply.
 * Only adds local categories; never removes existing ones and never touches YouTube.
 */
export function AutoCategorize({ rows, onClose }: { rows: ChannelRow[]; onClose: () => void }) {
  const auth = useAuth();
  const toast = useToast();
  const uncategorized = rows.filter((r) => r.tagIds.length === 0);
  const [scope, setScope] = useState<'uncategorized' | 'all'>(uncategorized.length ? 'uncategorized' : 'all');
  const [step, setStep] = useState<'setup' | 'loading' | 'review'>('setup');
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<Map<string, string>>(new Map());
  const [reasons, setReasons] = useState<Map<string, string>>(new Map());
  const [applying, setApplying] = useState(false);

  const target = scope === 'uncategorized' ? uncategorized : rows;
  const byId = useMemo(() => new Map(rows.map((r) => [r.channel.id, r])), [rows]);

  const analyze = async () => {
    setStep('loading');
    setError(null);
    const res = await send<Suggestion[]>({ type: 'categorize/suggest', ids: target.map((r) => r.channel.id) });
    if (!res.ok || !res.data) {
      setError(res.ok ? 'No suggestions returned' : res.error);
      setStep('setup');
      return;
    }
    // Keep the primary suggestion (secondary is applied too unless the user changes the row).
    setChoice(new Map(res.data.map((s) => [s.channelId, s.keys.join('+')])));
    setReasons(new Map(res.data.map((s) => [s.channelId, s.reason])));
    setStep('review');
  };

  const groups = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const [id, value] of choice) {
      const primary = value.split('+')[0]!;
      m.set(primary, [...(m.get(primary) ?? []), id]);
    }
    return [...m].sort((a, b) => (a[0] === SKIP ? 1 : b[0] === SKIP ? -1 : b[1].length - a[1].length));
  }, [choice]);

  const apply = async () => {
    setApplying(true);
    const assignments = [...choice]
      .filter(([, v]) => v !== SKIP)
      .map(([channelId, v]) => ({ channelId, keys: v.split('+') }));
    const r = await applyCategorization(assignments);
    setApplying(false);
    toast(`Categorized ${r.assigned} channels${r.created ? ` · ${r.created} new categories` : ''}`);
    onClose();
  };

  const toApply = [...choice.values()].filter((v) => v !== SKIP).length;

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title="✨ Auto-categorize"
      footer={
        step === 'review' ? (
          <>
            <Button onClick={() => setStep('setup')}>Back</Button>
            <Button variant="primary" disabled={applying || toApply === 0} onClick={apply}>
              {applying ? 'Applying…' : `Apply to ${toApply} channels`}
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={step === 'loading' || target.length === 0} onClick={analyze}>
              {step === 'loading' ? 'Analyzing…' : `Analyze ${target.length} channels`}
            </Button>
          </>
        )
      }
    >
      {step !== 'review' && (
        <div className="space-y-4">
          <p className="text-sm text-ink-2">
            I’ll suggest a category for each channel from its name{auth.signedIn ? ', YouTube’s topic data and its description' : ''}. You review
            everything before anything is saved. Categories stay in this browser and never change YouTube.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                ['uncategorized', 'Only uncategorized', `${uncategorized.length} channels`],
                ['all', 'All subscriptions', `${rows.length} channels · adds, never removes`],
              ] as const
            ).map(([value, label, hint]) => (
              <button
                key={value}
                onClick={() => setScope(value)}
                aria-pressed={scope === value}
                className={cx(
                  'rounded-xl border p-4 text-left transition',
                  scope === value ? 'border-accent bg-accent-soft ring-1 ring-accent' : 'border-line hover:bg-surface-2',
                )}
              >
                <div className="font-medium">{label}</div>
                <div className="text-xs text-ink-3">{hint}</div>
              </button>
            ))}
          </div>
          {!auth.signedIn && <Notice>Not connected — suggestions will use channel names only. Connect in Settings for better results.</Notice>}
          {auth.signedIn && <Notice>Uses about {Math.ceil(target.length / 50)} YouTube API unit(s). Descriptions are used once and not stored.</Notice>}
          {error && <Notice tone="danger">{error}</Notice>}
          {step === 'loading' && (
            <div className="flex items-center gap-3 text-sm text-ink-2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" aria-hidden />
              Analyzing {target.length} channels…
            </div>
          )}
        </div>
      )}

      {step === 'review' && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {groups.map(([key, ids]) => {
              const def = key === SKIP ? { emoji: '⏭️', name: 'Skip' } : defByKey(key);
              return (
                <a
                  key={key}
                  href={`#cat-${key}`}
                  onClick={(e) => {
                    e.preventDefault();
                    document.getElementById(`cat-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                  className="rounded-full border border-line bg-surface-2 px-3 py-1 text-xs hover:border-accent"
                >
                  {def.emoji} {def.name} <b className="tabular-nums">{ids.length}</b>
                </a>
              );
            })}
          </div>
          {groups.map(([key, ids]) => {
            const def = key === SKIP ? { emoji: '⏭️', name: 'Skip (leave as is)' } : defByKey(key);
            return (
              <section key={key} id={`cat-${key}`} className="overflow-hidden rounded-xl border border-line">
                <header className="flex items-center gap-2 bg-surface-2 px-4 py-2.5">
                  <span className="text-lg" aria-hidden>
                    {def.emoji}
                  </span>
                  <h3 className="font-semibold">{def.name}</h3>
                  <span className="ml-auto text-xs text-ink-3 tabular-nums">{ids.length}</span>
                </header>
                <ul>
                  {ids.map((id) => {
                    const r = byId.get(id);
                    const value = choice.get(id) ?? SKIP;
                    return (
                      <li key={id} className="flex items-center gap-3 border-t border-line/60 px-4 py-2">
                        <Avatar url={r?.channel.thumbnailUrl} title={r?.channel.title ?? '?'} size={28} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{r?.channel.title}</div>
                          <div className="truncate text-[11px] text-ink-3">{reasons.get(id)}</div>
                        </div>
                        <select
                          aria-label={`Category for ${r?.channel.title}`}
                          value={value}
                          onChange={(e) => setChoice((m) => new Map(m).set(id, e.target.value))}
                          className="h-8 max-w-48 rounded-lg border border-line bg-surface px-2 text-xs"
                        >
                          {!ALL_DEFS.some((d) => d.key === value) && value !== SKIP && (
                            <option value={value}>{value.split('+').map((k) => `${defByKey(k).emoji} ${defByKey(k).name}`).join(' + ')}</option>
                          )}
                          {ALL_DEFS.map((d) => (
                            <option key={d.key} value={d.key}>
                              {d.emoji} {d.name}
                            </option>
                          ))}
                          <option value={SKIP}>⏭️ Skip</option>
                        </select>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
