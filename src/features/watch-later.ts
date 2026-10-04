/**
 * What can be done with Watch Later, and HOW (verified against the official YouTube Data API docs:
 * revision history 2016-09-15 / 2020-09 — playlistItems.list on "WL" returns an empty list and
 * playlistItems.insert/delete support for WL is fully deprecated).
 *
 * "Website" capabilities are performed in the user's own signed-in YouTube tab by clicking YouTube's
 * visible UI (features/wl-dom.ts), only after the user selects videos and confirms. They are
 * verified (the row must disappear) and never use cookies, tokens or internal endpoints.
 */
export type WlCapability = { supported: boolean; how: string; via: 'api' | 'website' | 'takeout' | 'local' };

export const WL_CAPABILITIES = {
  listViaApi: { supported: false, via: 'api', how: 'YouTube’s API returns an empty list for Watch Later.' },
  modifyViaApi: { supported: false, via: 'api', how: 'Adding/removing Watch Later items through the API is deprecated (2020).' },
  readLive: { supported: true, via: 'website', how: 'Refresh from YouTube reads your real Watch Later page in a YouTube tab.' },
  removeViaWebsite: { supported: true, via: 'website', how: 'Removes via YouTube’s own “Remove from Watch later” menu in your YouTube tab, then checks the video is gone.' },
  moveToPlaylist: { supported: true, via: 'website', how: 'Adds to the playlist via the API first; removes from Watch Later only after that succeeded.' },
  importFromTakeout: { supported: true, via: 'takeout', how: 'Import “Watch later-videos.csv” from Google Takeout as a local snapshot.' },
  videoDetails: { supported: true, via: 'api', how: 'Titles, channels and durations via videos.list (1 unit per 50 videos).' },
  copyToPlaylist: { supported: true, via: 'api', how: 'playlistItems.insert into one of your normal playlists.' },
  addToWatchLater: { supported: false, via: 'api', how: 'Not offered — the API doesn’t support it.' },
  hideLocally: { supported: true, via: 'local', how: 'Hide videos in this extension only (YouTube is unchanged).' },
} as const satisfies Record<string, WlCapability>;

export type WlCapabilityKey = keyof typeof WL_CAPABILITIES;
export const canDo = (k: WlCapabilityKey) => WL_CAPABILITIES[k].supported;

/** "PT1H2M3S" → "1:02:03". */
export function formatDuration(iso?: string): string {
  if (!iso) return '';
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return '';
  const h = Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0);
  const min = Number(m[3] ?? 0);
  const s = Number(m[4] ?? 0);
  if (!h && !min && !s) return iso === 'P0D' ? 'Live' : '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(min)}:${pad(s)}` : `${min}:${pad(s)}`;
}

/** Extract video ids from pasted text (URLs, youtu.be links, shorts, or bare ids). */
export function extractVideoIds(text: string): string[] {
  const ids = new Set<string>();
  const re = /(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])|(?:^|[\s,;])([A-Za-z0-9_-]{11})(?=$|[\s,;])/g;
  for (const m of text.matchAll(re)) {
    const id = m[1] ?? m[2];
    if (id) ids.add(id);
  }
  return [...ids];
}
