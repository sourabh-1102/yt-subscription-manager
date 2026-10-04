import { db } from '@/db/db';
import { applyCategorization } from '@/db/repo';
import { getAuthState, getPrefs } from '@/lib/prefs';
import { classifyChannel, type ChannelSignals } from '@/features/categorize';
import { getChannelSignals } from './youtube-api';
import { authLog, errMsg } from './auth';

export interface Suggestion {
  channelId: string;
  keys: string[];
  reason: string;
}

/**
 * Suggest categories for channels (service worker). When connected, YouTube topic data,
 * descriptions and channel keywords are fetched (1 quota unit per 50 channels) and used
 * transiently; otherwise only channel names are used.
 */
export async function suggestCategories(channelIds: string[]): Promise<Suggestion[]> {
  const channels = (await db.channels.bulkGet(channelIds)).filter((c): c is NonNullable<typeof c> => !!c);
  const signals = new Map<string, ChannelSignals>(channels.map((c) => [c.id, { title: c.title }]));

  const auth = await getAuthState();
  const apiIds = channels.filter((c) => c.source !== 'demo').map((c) => c.id);
  if (auth.signedIn && apiIds.length) {
    for (let i = 0; i < apiIds.length; i += 50) {
      try {
        for (const it of await getChannelSignals(apiIds.slice(i, i + 50))) {
          const s = signals.get(it.id);
          if (!s) continue;
          s.description = it.snippet?.description;
          s.topics = it.topicDetails?.topicCategories;
          s.keywords = it.brandingSettings?.channel?.keywords;
        }
      } catch (e) {
        // Fall back to names only for this chunk — still useful.
        authLog('categorize: signals fetch failed', { error: errMsg(e) });
      }
    }
  }
  return channels.map((c) => ({ channelId: c.id, ...classifyChannel(signals.get(c.id)!) }));
}

/** After a sync: categorize newly added subscriptions that have no category yet (if enabled). */
export async function autoCategorizeNew(channelIds: string[]): Promise<number> {
  if (!channelIds.length || !(await getPrefs()).autoCategorizeNew) return 0;
  const tagged = new Set((await db.channelTags.where('channelId').anyOf(channelIds).toArray()).map((t) => t.channelId));
  const untagged = channelIds.filter((id) => !tagged.has(id));
  if (!untagged.length) return 0;
  const suggestions = await suggestCategories(untagged);
  await applyCategorization(suggestions.map((s) => ({ channelId: s.channelId, keys: s.keys })));
  return suggestions.length;
}
