import type { BulkOpItem } from '@/lib/types';

export interface OpProgress {
  total: number;
  done: number;
  failed: number;
  skipped: number;
  pending: number;
}

/** Pure progress summary (UI-safe: no API/token code). */
export function summarize(items: Pick<BulkOpItem, 'status'>[]): OpProgress {
  const p: OpProgress = { total: items.length, done: 0, failed: 0, skipped: 0, pending: 0 };
  for (const i of items) p[i.status === 'done' ? 'done' : i.status === 'failed' ? 'failed' : i.status === 'skipped' ? 'skipped' : 'pending']++;
  return p;
}
