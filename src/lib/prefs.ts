import { browser } from 'wxt/browser';
import { z } from 'zod';
import type { AuthState, Prefs } from './types';
import { DEFAULT_PREFS, STORAGE_KEYS } from './defaults';

export { DEFAULT_PREFS, STORAGE_KEYS };


export const PrefsSchema = z.object({
  trackingEnabled: z.boolean(),
  dwellSeconds: z.number().int().min(5).max(600),
  retentionDays: z.number().int().min(0).max(3650),
  excludedChannelIds: z.array(z.string().max(64)).max(10_000),
  theme: z.enum(['system', 'light', 'dark']),
  inactiveDays: z.number().int().min(7).max(3650),
  trackingStartedAt: z.number().optional(),
  onboardingDone: z.boolean(),
  autoCategorizeNew: z.boolean(),
});

const PREFS_KEY = STORAGE_KEYS.prefs;
const AUTH_KEY = STORAGE_KEYS.auth;

export async function getPrefs(): Promise<Prefs> {
  const raw = (await browser.storage.local.get(PREFS_KEY))[PREFS_KEY];
  const parsed = PrefsSchema.partial().safeParse(raw ?? {});
  return { ...DEFAULT_PREFS, ...(parsed.success ? parsed.data : {}) };
}

export async function setPrefs(patch: Partial<Prefs>): Promise<Prefs> {
  const next = { ...(await getPrefs()), ...patch };
  if (patch.trackingEnabled && !next.trackingStartedAt) next.trackingStartedAt = Date.now();
  await browser.storage.local.set({ [PREFS_KEY]: PrefsSchema.parse(next) });
  return next;
}

export const DEFAULT_AUTH: AuthState = {
  signedIn: false,
  hasWriteScope: false,
  syncing: false,
  clientIdConfigured: false,
};

export async function getAuthState(): Promise<AuthState> {
  const raw = (await browser.storage.local.get(AUTH_KEY))[AUTH_KEY] as Partial<AuthState> | undefined;
  return { ...DEFAULT_AUTH, ...(raw ?? {}) };
}

export async function setAuthState(patch: Partial<AuthState>): Promise<AuthState> {
  const next = { ...(await getAuthState()), ...patch };
  await browser.storage.local.set({ [AUTH_KEY]: next });
  return next;
}

/** Subscribe to a storage key from UI code. Returns an unsubscribe function. */
export function watchStorageKey<T>(key: string, cb: (value: T | undefined) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && key in changes) cb(changes[key]?.newValue as T | undefined);
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}

