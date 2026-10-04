import { db, newId } from './db';
import type { DeletionLogEntry } from '@/lib/types';

/**
 * Deleted-items log (local only). Writing here never touches YouTube.
 * Safe to import from both the UI and the service worker.
 */
export async function logDeletion(entry: Omit<DeletionLogEntry, 'id' | 'at'> & { at?: number }): Promise<string> {
  const id = newId();
  await db.deletionLog.put({ ...entry, id, at: entry.at ?? Date.now() });
  return id;
}

export async function markRestored(ids: string[], restoredTo?: string): Promise<void> {
  const now = Date.now();
  await db.deletionLog.bulkUpdate(ids.map((id) => ({ key: id, changes: { restoredAt: now, ...(restoredTo ? { restoredTo } : {}) } })));
}

export async function clearDeletionLog(kind?: DeletionLogEntry['kind']): Promise<void> {
  if (kind) await db.deletionLog.where('kind').equals(kind).delete();
  else await db.deletionLog.clear();
}
