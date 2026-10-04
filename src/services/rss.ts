import { db } from '@/db/db';
import { RSS_BATCH_SIZE, RSS_RECHECK_MS } from '@/config/constants';
import { isChannelId } from '@/lib/youtube-urls';

/**
 * Latest upload date from the channel's public Atom feed — costs zero API quota.
 * Unofficial-but-public endpoint: treat failures as "unknown", never as errors.
 */
export function parseLatestPublished(xml: string): number | undefined {
  const entry = /<entry>([\s\S]*?)<\/entry>/.exec(xml)?.[1];
  if (!entry) return undefined;
  const published = /<published>([^<]+)<\/published>/.exec(entry)?.[1];
  const ts = published ? Date.parse(published) : NaN;
  return Number.isFinite(ts) ? ts : undefined;
}

export async function fetchLatestUpload(channelId: string): Promise<{ ok: boolean; lastUploadAt?: number }> {
  if (!isChannelId(channelId)) return { ok: false };
  try {
    const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, {
      credentials: 'omit',
    });
    if (!res.ok) return { ok: false };
    return { ok: true, lastUploadAt: parseLatestPublished(await res.text()) };
  } catch {
    return { ok: false };
  }
}

/** Refresh the stalest subscribed channels. Called from an alarm; bounded per run. */
export async function refreshLastUploads(batch = RSS_BATCH_SIZE): Promise<number> {
  const cutoff = Date.now() - RSS_RECHECK_MS;
  const due = await db.channels
    .where('subscribed')
    .equals(1)
    .filter((c) => c.source !== 'demo' && (!c.lastUploadCheckedAt || c.lastUploadCheckedAt < cutoff))
    .toArray();
  due.sort((a, b) => (a.lastUploadCheckedAt ?? 0) - (b.lastUploadCheckedAt ?? 0));
  const chunk = due.slice(0, batch);
  for (const c of chunk) {
    const r = await fetchLatestUpload(c.id);
    await db.channels.update(c.id, {
      lastUploadCheckedAt: Date.now(),
      ...(r.ok ? { lastUploadAt: r.lastUploadAt } : {}),
    });
    await new Promise((res) => setTimeout(res, 250)); // be gentle
  }
  return chunk.length;
}
