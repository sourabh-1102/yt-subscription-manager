import { z } from 'zod';
import { db } from '@/db/db';
import { getPrefs, PrefsSchema, setPrefs } from '@/lib/prefs';
import { MAX_IMPORT_BYTES } from '@/config/constants';

/**
 * Backup file format. Contains only local organization + analytics data.
 * OAuth tokens are never included (we never hold them).
 */
export const BACKUP_FORMAT = 'yt-subscription-manager-backup';
export const BACKUP_VERSION = 1;

const ChannelId = z.string().regex(/^UC[A-Za-z0-9_-]{22}$/);
const VideoId = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
const Str = (max: number) => z.string().max(max);
const Bit = z.union([z.literal(0), z.literal(1)]);

const BackupSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.literal(BACKUP_VERSION),
  exportedAt: z.number(),
  prefs: PrefsSchema.partial().optional(),
  channels: z
    .array(
      z.object({
        id: ChannelId,
        title: Str(500),
        thumbnailUrl: Str(2000).optional(),
        subscribed: Bit,
        subscriptionId: Str(200).optional(),
        subscribedAt: z.number().optional(),
        videoCount: z.number().optional(),
        source: z.enum(['api', 'takeout', 'watch', 'demo']),
        fetchedAt: z.number().optional(),
        lastUploadAt: z.number().optional(),
        lastUploadCheckedAt: z.number().optional(),
      }),
    )
    .max(100_000),
  tags: z.array(z.object({ id: Str(64), name: Str(60), emoji: Str(8), order: z.number() })).max(10_000),
  channelTags: z.array(z.object({ channelId: ChannelId, tagId: Str(64) })).max(1_000_000),
  flags: z
    .array(
      z.object({
        channelId: ChannelId,
        favorite: Bit.optional(),
        reviewLater: Bit.optional(),
        note: Str(2000).optional(),
        bellIntent: z.enum(['all', 'personalized', 'none']).optional(),
        bellDone: Bit.optional(),
      }),
    )
    .max(100_000),
  watchEvents: z
    .array(
      z.object({
        id: Str(40),
        videoId: VideoId,
        channelId: ChannelId,
        watchedAt: z.number(),
        source: z.enum(['tracked', 'takeout', 'demo']),
      }),
    )
    .max(2_000_000),
  unsubscribed: z
    .array(
      z.object({
        id: Str(120),
        batchId: Str(64),
        channelId: ChannelId,
        title: Str(500),
        thumbnailUrl: Str(2000).optional(),
        oldSubscriptionId: Str(200),
        tagIds: z.array(Str(64)).max(1000),
        flags: z.record(z.string(), z.unknown()).optional(),
        queuedAt: z.number(),
        doneAt: z.number().optional(),
        status: z.enum(['pending', 'unsubscribed', 'failed', 'resubscribed', 'resubscribe-pending', 'resubscribe-failed']),
        error: Str(300).optional(),
        resubBatchId: Str(64).optional(),
      }),
    )
    .max(100_000),
});
export type Backup = z.infer<typeof BackupSchema>;

export async function buildBackup(opts: { includeAnalytics?: boolean; channelIds?: string[] } = {}): Promise<Backup> {
  const includeAnalytics = opts.includeAnalytics ?? true;
  const only = opts.channelIds ? new Set(opts.channelIds) : undefined;
  const keep = <T extends { channelId: string }>(rows: T[]) => (only ? rows.filter((r) => only.has(r.channelId)) : rows);
  const channels = await db.channels.toArray();
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    prefs: only ? undefined : await getPrefs(),
    channels: only ? channels.filter((c) => only.has(c.id)) : channels,
    tags: await db.tags.toArray(),
    channelTags: keep(await db.channelTags.toArray()),
    flags: keep(await db.flags.toArray()),
    watchEvents: includeAnalytics ? keep(await db.watchEvents.toArray()) : [],
    unsubscribed: only ? [] : await db.unsubscribed.toArray(),
  } as Backup;
}

export function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const backupFilename = () => `yt-subscription-manager-backup-${new Date().toISOString().slice(0, 10)}.json`;

export async function readJsonFile(file: File): Promise<unknown> {
  if (file.size > MAX_IMPORT_BYTES) throw new Error(`File is too large (max ${MAX_IMPORT_BYTES / 1024 / 1024} MB).`);
  const text = await file.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('File is not valid JSON.');
  }
}

export function validateBackup(data: unknown): Backup {
  const r = BackupSchema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new Error(`Invalid backup file: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim());
  }
  return r.data;
}

/**
 * Restore. `replace` wipes local data first; `merge` keeps existing rows and adds/overwrites from the file.
 * API-sourced records keep their original fetchedAt so the 30-day TTL still applies.
 */
export async function restoreBackup(b: Backup, mode: 'merge' | 'replace'): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    if (mode === 'replace') await Promise.all(db.tables.map((t) => t.clear()));
    await db.channels.bulkPut(b.channels);
    await db.tags.bulkPut(b.tags);
    await db.channelTags.bulkPut(b.channelTags);
    await db.flags.bulkPut(b.flags);
    await db.watchEvents.bulkPut(b.watchEvents);
    // Imported pending entries never ran — don't resurrect them as active work.
    await db.unsubscribed.bulkPut(
      b.unsubscribed
        .filter((u) => u.status !== 'pending')
        .map((u) => ({
          ...u,
          flags: u.flags as never,
          status: u.status === 'resubscribe-pending' ? 'unsubscribed' : u.status,
          resubBatchId: u.status === 'resubscribe-pending' ? undefined : u.resubBatchId,
        })),
    );
  });
  if (b.prefs) await setPrefs({ ...b.prefs, trackingEnabled: (await getPrefs()).trackingEnabled });
}
