import type { Prefs } from './types';

/** Dependency-free defaults (imported by the content script, so keep this file tiny). */
export const DEFAULT_PREFS: Prefs = {
  trackingEnabled: false,
  dwellSeconds: 30,
  retentionDays: 0,
  excludedChannelIds: [],
  theme: 'system',
  inactiveDays: 90,
  onboardingDone: false,
  autoCategorizeNew: true,
};

export const STORAGE_KEYS = { prefs: 'prefs', auth: 'auth', quota: 'quota' } as const;
