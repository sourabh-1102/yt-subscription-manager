import { useRef, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { browser } from 'wxt/browser';
import { db } from '@/db/db';
import { setPrefs } from '@/lib/prefs';
import { formatDate, relativeTime } from '@/lib/time';
import { DAILY_WRITE_CAP } from '@/config/constants';
import { BRAND } from '@/config/brand';
import { importTakeoutSubscriptions, importTakeoutWatches, resetAllData, resetAnalytics } from '@/db/repo';
import { backupFilename, buildBackup, downloadJson, readJsonFile, restoreBackup, validateBackup, type Backup } from '@/services/backup';
import { parseSubscriptionsCsv, parseWatchHistory } from '@/services/takeout';
import { loadDemoData, removeDemoData } from '@/services/demo';
import { purgeChannelWatches } from '@/services/watch';
import { currentBrowserSupport, unsupportedBrowserMessage } from '@/lib/browser-support';

const browserSupport = currentBrowserSupport();
import { send, useAuth, usePrefs, useQuota } from '../hooks';
import { Button, Card, ConfirmDialog, Modal, Notice, PageHeader, Select, Toggle, useToast } from '../primitives';

function Section({ title, desc, children }: { title: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <Card className="p-5">
      <h2 className="font-semibold">{title}</h2>
      {desc && <p className="mt-0.5 text-sm text-ink-2">{desc}</p>}
      <div className="mt-4 space-y-3">{children}</div>
    </Card>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-xs text-ink-3">{hint}</div>}
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function FileButton({ accept, label, onFile }: { accept: string; label: string; onFile: (f: File) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = '';
        }}
      />
      <Button onClick={() => ref.current?.click()}>{label}</Button>
    </>
  );
}

export function SettingsPage() {
  const auth = useAuth();
  const prefs = usePrefs();
  const quota = useQuota();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | 'analytics' | 'all' | 'disconnect'>(null);
  const [pendingRestore, setPendingRestore] = useState<Backup | null>(null);
  const stats = useLiveQuery(async () => ({
    channels: await db.channels.where('subscribed').equals(1).count(),
    events: await db.watchEvents.count(),
    pending: await db.pendingVideos.count(),
    demo: await db.channels.where('source').equals('demo').count(),
    tags: await db.tags.count(),
  }), []);
  const excluded = useLiveQuery(
    async () => (await db.channels.bulkGet(prefs.excludedChannelIds)).map((c, i) => ({ id: prefs.excludedChannelIds[i]!, title: c?.title })),
    [prefs.excludedChannelIds.join(',')],
  );

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <PageHeader title="⚙️ Settings & data" subtitle="Everything is stored in this browser only. No servers, no tracking, no ads." />
      <div className="mx-auto max-w-3xl space-y-5 p-6">
        {error && <Notice tone="danger">{error}</Notice>}

        <Section
          title="YouTube account"
          desc="Read-only access to list your subscriptions. Permission to change subscriptions is requested only when you first confirm an unsubscribe."
        >
          {!auth.clientIdConfigured && (
            <Notice tone="warn">
              Google sign-in isn’t configured in this build (no OAuth client ID). You can still use Takeout import and demo data. Developers: see
              SETUP.md.
            </Notice>
          )}
          {!browserSupport.supported && <Notice tone="warn">{unsupportedBrowserMessage(browserSupport.browser)}</Notice>}
          {auth.signedIn ? (
            <>
              <Row label={`Connected: ${auth.accountTitle ?? 'YouTube account'}`} hint={auth.hasWriteScope ? 'Read + manage subscriptions' : 'Read-only'}>
                <Button
                  disabled={auth.syncing || busy === 'sync'}
                  onClick={() =>
                    run('sync', async () => {
                      const r = await send<{ count: number }>({ type: 'sync/run' });
                      if (!r.ok) throw new Error(r.error);
                      toast(`Synced ${r.data?.count ?? 0} subscriptions`);
                    })
                  }
                >
                  {auth.syncing ? 'Syncing…' : 'Sync now'}
                </Button>
                <Button variant="danger-outline" onClick={() => setConfirm('disconnect')}>
                  Disconnect
                </Button>
              </Row>
              <p className="text-xs text-ink-3">
                Last sync: {auth.lastSyncAt ? relativeTime(auth.lastSyncAt) : 'never'}
                {auth.lastSyncError && <span className="text-danger"> · {auth.lastSyncError}</span>} · Synced daily automatically. Channel data from
                YouTube is refreshed or deleted within 30 days, per YouTube’s API policies.
              </p>
            </>
          ) : (
            <Row label="Not connected" hint="Uses Google’s official sign-in. We never see your password.">
              <Button
                variant="primary"
                disabled={busy === 'signin' || !auth.clientIdConfigured || !browserSupport.supported}
                onClick={() =>
                  run('signin', async () => {
                    const r = await send<{ count: number }>({ type: 'auth/signIn' });
                    if (!r.ok) throw new Error(r.error);
                    toast(`Connected — ${r.data?.count ?? 0} subscriptions synced`);
                  })
                }
              >
                {busy === 'signin' ? 'Connecting…' : 'Connect YouTube account'}
              </Button>
            </Row>
          )}
          <p className="text-xs text-ink-3">
            API usage today (this device): {quota.units} units · {quota.writes}/{DAILY_WRITE_CAP} subscription changes. You can also revoke access any
            time at{' '}
            <a className="text-accent underline" href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer">
              Google Account → Security → Third-party access
            </a>
            .
          </p>
        </Section>

        <Section
          title="Watch tracking"
          desc="When on, the extension notes which video you watched on youtube.com (video ID, channel ID, time) after it has played for a while. Stored only in this browser; never in incognito; never titles, searches or other sites."
        >
          <Row label="Track videos I watch on youtube.com" hint={prefs.trackingStartedAt ? `Analytics since ${formatDate(prefs.trackingStartedAt)}` : 'Off by default'}>
            <Toggle checked={prefs.trackingEnabled} label="Watch tracking" onChange={(v) => void setPrefs({ trackingEnabled: v })} />
          </Row>
          <Row label="Count a video as watched after" hint="Seconds of actual playback (ads excluded)">
            <Select
              label="Dwell time"
              value={String(prefs.dwellSeconds)}
              onChange={(v) => void setPrefs({ dwellSeconds: Number(v) })}
              options={['10', '30', '60', '120', '300'].map((s) => ({ value: s, label: `${s} seconds` }))}
            />
          </Row>
          <Row label="Keep watch history for" hint="Older entries are deleted automatically">
            <Select
              label="Retention"
              value={String(prefs.retentionDays)}
              onChange={(v) => void setPrefs({ retentionDays: Number(v) })}
              options={[
                { value: '0', label: 'Forever' },
                { value: '90', label: '90 days' },
                { value: '180', label: '6 months' },
                { value: '365', label: '1 year' },
                { value: '730', label: '2 years' },
              ]}
            />
          </Row>
          <Row label="Treat channels as inactive after" hint="Not watched for this long">
            <Select
              label="Inactive threshold"
              value={String(prefs.inactiveDays)}
              onChange={(v) => void setPrefs({ inactiveDays: Number(v) })}
              options={['30', '60', '90', '180', '365'].map((s) => ({ value: s, label: `${s} days` }))}
            />
          </Row>
          {stats && stats.pending > 0 && (
            <p className="text-xs text-ink-3">
              {stats.pending} watched video(s) waiting to be matched to a channel{auth.signedIn ? ' (resolved automatically)' : ' — connect your account to resolve them'}.
            </p>
          )}
          <div>
            <div className="text-sm font-medium">Never track these channels</div>
            <p className="text-xs text-ink-3">Add from a channel’s ID (UC…). Existing history for that channel is deleted.</p>
            <ExcludeInput
              onAdd={async (id) => {
                if (prefs.excludedChannelIds.includes(id)) return;
                await setPrefs({ excludedChannelIds: [...prefs.excludedChannelIds, id] });
                await purgeChannelWatches(id);
                toast('Channel excluded and its history deleted');
              }}
            />
            <ul className="mt-2 space-y-1">
              {excluded?.map((x) => (
                <li key={x.id} className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-1.5 text-sm">
                  <span className="truncate">{x.title || x.id}</span>
                  <button
                    className="text-xs text-accent hover:underline"
                    onClick={() => void setPrefs({ excludedChannelIds: prefs.excludedChannelIds.filter((i) => i !== x.id) })}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </Section>

        <Section title="Organization" desc="Categories are stored only in this browser and never change your YouTube account.">
          <Row
            label="Auto-categorize new subscriptions"
            hint="When a sync finds channels you just subscribed to, give them a category automatically (uses YouTube topic data, ~1 API unit per 50)."
          >
            <Toggle checked={prefs.autoCategorizeNew} label="Auto-categorize new subscriptions" onChange={(v) => void setPrefs({ autoCategorizeNew: v })} />
          </Row>
        </Section>

        <Section
          title="Import from Google Takeout"
          desc={
            <>
              Get your history at{' '}
              <a className="text-accent underline" href="https://takeout.google.com/" target="_blank" rel="noopener noreferrer">
                takeout.google.com
              </a>{' '}
              → deselect all → <b>YouTube and YouTube Music</b> → “Multiple formats” → set <b>history</b> to <b>JSON</b>. Files are read here and never
              uploaded.
            </>
          }
        >
          <Row label="Watch history" hint="history/watch-history.json — fills analytics with your past viewing">
            <FileButton
              accept=".json,application/json"
              label={busy === 'wh' ? 'Importing…' : 'Import watch-history.json'}
              onFile={(f) =>
                run('wh', async () => {
                  const { watches, skipped } = parseWatchHistory(await readJsonFile(f));
                  const r = await importTakeoutWatches(watches, prefs.excludedChannelIds);
                  toast(`Imported ${r.added.toLocaleString()} watches (${r.duplicates} duplicates, ${skipped} ads/removed videos skipped)`);
                })
              }
            />
          </Row>
          <Row label="Subscriptions" hint="subscriptions/subscriptions.csv — works without connecting your account">
            <FileButton
              accept=".csv,text/csv"
              label={busy === 'subs' ? 'Importing…' : 'Import subscriptions.csv'}
              onFile={(f) =>
                run('subs', async () => {
                  if (f.size > 20 * 1024 * 1024) throw new Error('File too large.');
                  const r = await importTakeoutSubscriptions(parseSubscriptionsCsv(await f.text()));
                  toast(`Imported ${r.added} new channels (${r.updated} already known)`);
                })
              }
            />
          </Row>
        </Section>

        <Section title="Backup & restore" desc="Categories, favorites, Review Later, notes, bell plans, unsubscribe history and analytics. No login data is ever included.">
          <Row label="Export everything" hint={stats ? `${stats.channels} channels · ${stats.tags} categories · ${stats.events.toLocaleString()} watches` : undefined}>
            <Button onClick={() => run('export', async () => downloadJson(await buildBackup(), backupFilename()))}>Export JSON</Button>
          </Row>
          <Row label="Import a backup" hint="You’ll choose merge or replace">
            <FileButton
              accept=".json,application/json"
              label="Import JSON"
              onFile={(f) => run('import', async () => setPendingRestore(validateBackup(await readJsonFile(f))))}
            />
          </Row>
        </Section>

        <Section title="Appearance">
          <Row label="Theme">
            <Select
              label="Theme"
              value={prefs.theme}
              onChange={(v) => void setPrefs({ theme: v })}
              options={[
                { value: 'system', label: 'System' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
            />
          </Row>
        </Section>

        <Section title="Demo data" desc="Explore the dashboard with 1,000 made-up channels. Demo data is clearly separated and removable.">
          <Row label={stats?.demo ? `${stats.demo} demo channels loaded` : 'No demo data'}>
            <Button disabled={busy === 'demo'} onClick={() => run('demo', async () => (await loadDemoData(1000), toast('Demo data loaded')))}>
              Load demo data
            </Button>
            <Button disabled={!stats?.demo} onClick={() => run('demo', async () => (await removeDemoData(), toast('Demo data removed')))}>
              Remove demo data
            </Button>
          </Row>
        </Section>

        <Section title="Danger zone">
          <Row label="Reset analytics" hint="Deletes all recorded and imported watch history">
            <Button variant="danger-outline" onClick={() => setConfirm('analytics')}>
              Reset analytics
            </Button>
          </Row>
          <Row label="Reset all extension data" hint="Deletes everything stored by this extension in this browser">
            <Button variant="danger-outline" onClick={() => setConfirm('all')}>
              Reset everything
            </Button>
          </Row>
        </Section>

        <p className="pb-6 text-center text-xs text-ink-3">
          {BRAND.name} v{browser.runtime.getManifest().version} · Free & open · Not affiliated with YouTube or Google ·{' '}
          <a className="underline" href={browser.runtime.getURL('/privacy.html')} target="_blank" rel="noopener noreferrer">
            Privacy policy
          </a>
        </p>
      </div>

      <ConfirmDialog
        open={confirm === 'disconnect'}
        title="Disconnect your YouTube account?"
        confirmLabel="Disconnect & delete YouTube data"
        danger
        body="Revokes this extension’s access with Google and deletes channel names and pictures fetched from YouTube. Your own categories, favorites, notes and watch analytics stay (they’re yours)."
        onConfirm={async () => {
          const r = await send({ type: 'auth/signOut', deleteApiData: true });
          if (!r.ok) throw new Error(r.error);
          toast('Disconnected');
        }}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'analytics'}
        title="Reset analytics?"
        confirmLabel="Delete watch history"
        danger
        body="All recorded and imported watch history will be permanently deleted from this browser. Consider exporting a backup first."
        onConfirm={async () => {
          await resetAnalytics();
          toast('Analytics reset');
        }}
        onClose={() => setConfirm(null)}
      />
      <ConfirmDialog
        open={confirm === 'all'}
        title="Reset everything?"
        confirmLabel="Delete all data"
        danger
        body="Deletes all categories, favorites, notes, analytics and unsubscribe history in this browser and disconnects your account. Your YouTube subscriptions are NOT changed. This cannot be undone — export a backup first."
        onConfirm={async () => {
          await send({ type: 'auth/signOut', deleteApiData: true });
          await resetAllData();
          await browser.storage.local.clear();
          toast('All data deleted');
        }}
        onClose={() => setConfirm(null)}
      />
      <Modal
        open={!!pendingRestore}
        onClose={() => setPendingRestore(null)}
        title="Restore backup"
        footer={
          <>
            <Button onClick={() => setPendingRestore(null)}>Cancel</Button>
            <Button
              onClick={() =>
                run('restore', async () => {
                  await restoreBackup(pendingRestore!, 'merge');
                  setPendingRestore(null);
                  toast('Backup merged');
                })
              }
            >
              Merge into current data
            </Button>
            <Button
              variant="danger"
              onClick={() =>
                run('restore', async () => {
                  await restoreBackup(pendingRestore!, 'replace');
                  setPendingRestore(null);
                  toast('Backup restored');
                })
              }
            >
              Replace current data
            </Button>
          </>
        }
      >
        {pendingRestore && (
          <div className="space-y-2 text-sm">
            <p>Backup from {formatDate(pendingRestore.exportedAt)} contains:</p>
            <ul className="list-inside list-disc text-ink-2">
              <li>{pendingRestore.channels.length.toLocaleString()} channels</li>
              <li>{pendingRestore.tags.length} categories</li>
              <li>{pendingRestore.watchEvents.length.toLocaleString()} watch records</li>
              <li>{pendingRestore.unsubscribed.length} unsubscribe history entries</li>
            </ul>
            <p className="text-ink-3">Restoring never changes your YouTube account.</p>
          </div>
        )}
      </Modal>
    </div>
  );
}

function ExcludeInput({ onAdd }: { onAdd: (id: string) => void | Promise<void> }) {
  const [v, setV] = useState('');
  const valid = /^UC[A-Za-z0-9_-]{22}$/.test(v.trim());
  return (
    <form
      className="mt-2 flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) {
          void onAdd(v.trim());
          setV('');
        }
      }}
    >
      <input
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder="UCxxxxxxxxxxxxxxxxxxxxxx"
        aria-label="Channel ID to exclude"
        className="h-8 flex-1 rounded-lg border border-line bg-surface px-3 font-mono text-xs"
      />
      <Button size="md" disabled={!valid} type="submit">
        Exclude
      </Button>
    </form>
  );
}
