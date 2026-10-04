import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { browser } from 'wxt/browser';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/db/db';
import { DEFAULT_AUTH, DEFAULT_PREFS, getAuthState, getPrefs, STORAGE_KEYS, watchStorageKey } from '@/lib/prefs';
import type { AuthState, Prefs, Tag, WatchEvent } from '@/lib/types';
import type { MessageResult, UiMessage } from '@/lib/messages';
import { aggregateWatches, buildRows, type ChannelRow } from '@/features/logic';
import { getLedger, type QuotaLedger } from '@/services/quota';
import { isClientIdConfigured } from '@/lib/oauth-config';

/** Send a typed message to the service worker. */
export async function send<T = unknown>(msg: UiMessage): Promise<MessageResult<T>> {
  try {
    return ((await browser.runtime.sendMessage(msg)) as MessageResult<T>) ?? { ok: false, error: 'No response' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function useStorageValue<T>(key: string, load: () => Promise<T>, fallback: T): T {
  const [value, setValue] = useState<T>(fallback);
  useEffect(() => {
    let alive = true;
    void load().then((v) => alive && setValue(v));
    const off = watchStorageKey(key, () => void load().then((v) => alive && setValue(v)));
    return () => {
      alive = false;
      off();
    };
  }, [key]);
  return value;
}

export const useAuth = (): AuthState => {
  const a = useStorageValue(STORAGE_KEYS.auth, getAuthState, DEFAULT_AUTH);
  return { ...a, clientIdConfigured: isClientIdConfigured() };
};
export const usePrefs = (): Prefs => useStorageValue(STORAGE_KEYS.prefs, getPrefs, DEFAULT_PREFS);
export const useQuota = (): QuotaLedger =>
  useStorageValue(STORAGE_KEYS.quota, getLedger, { day: '', units: 0, writes: 0 });

// ---------- Hash router ----------
function subscribeHash(cb: () => void) {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

export function useRoute(): { path: string; params: URLSearchParams } {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  return useMemo(() => {
    const raw = hash.replace(/^#/, '') || '/overview';
    const [path, query] = raw.split('?');
    return { path: path || '/overview', params: new URLSearchParams(query) };
  }, [hash]);
}

export const navigate = (to: string) => {
  window.location.hash = to;
};

// ---------- Data ----------
export function useTags(): Tag[] {
  return useLiveQuery(() => db.tags.orderBy('order').toArray(), [], [] as Tag[]);
}

export function useWatchEvents(): WatchEvent[] | undefined {
  return useLiveQuery(() => db.watchEvents.toArray(), []);
}

/** All subscribed channels joined with local organization + watch stats. */
export function useChannelRows(opts: { subscribedOnly?: boolean } = {}): ChannelRow[] | undefined {
  const subscribedOnly = opts.subscribedOnly ?? true;
  const channels = useLiveQuery(
    () => (subscribedOnly ? db.channels.where('subscribed').equals(1).toArray() : db.channels.toArray()),
    [subscribedOnly],
  );
  const channelTags = useLiveQuery(() => db.channelTags.toArray(), []);
  const flags = useLiveQuery(() => db.flags.toArray(), []);
  const events = useWatchEvents();
  const stats = useMemo(() => (events ? aggregateWatches(events) : undefined), [events]);
  return useMemo(() => {
    if (!channels || !channelTags || !flags || !stats) return undefined;
    return buildRows(channels, channelTags, flags, stats);
  }, [channels, channelTags, flags, stats]);
}

export function useTheme(theme: Prefs['theme']) {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () =>
      document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && mq.matches));
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}

/** Selection set shared by list views. */
export function useSelection() {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  return {
    selected,
    toggle: (id: string) =>
      setSelected((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      }),
    setMany: (ids: string[], on: boolean) =>
      setSelected((s) => {
        const n = new Set(s);
        ids.forEach((id) => (on ? n.add(id) : n.delete(id)));
        return n;
      }),
    clear: () => setSelected(new Set()),
    replace: (ids: string[]) => setSelected(new Set(ids)),
  };
}
export type Selection = ReturnType<typeof useSelection>;
