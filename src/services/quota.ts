import { browser } from 'wxt/browser';
import { pacificDayKey } from '@/lib/time';
import { DAILY_WRITE_CAP } from '@/config/constants';
import { STORAGE_KEYS } from '@/lib/prefs';

/** Local ledger of this user's API usage for the current quota day (Pacific time). */
export interface QuotaLedger {
  day: string;
  units: number;
  writes: number;
}

export async function getLedger(): Promise<QuotaLedger> {
  const raw = (await browser.storage.local.get(STORAGE_KEYS.quota))[STORAGE_KEYS.quota] as QuotaLedger | undefined;
  const today = pacificDayKey();
  return raw && raw.day === today ? raw : { day: today, units: 0, writes: 0 };
}

export async function recordUsage(units: number, isWrite = false): Promise<void> {
  const l = await getLedger();
  l.units += units;
  if (isWrite) l.writes += 1;
  await browser.storage.local.set({ [STORAGE_KEYS.quota]: l });
}

export async function writesRemainingToday(): Promise<number> {
  return Math.max(0, DAILY_WRITE_CAP - (await getLedger()).writes);
}
