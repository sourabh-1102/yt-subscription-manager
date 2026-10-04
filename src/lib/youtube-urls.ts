/**
 * Every outbound link is built here from validated ids — never from raw API strings —
 * so a malicious title/URL can't inject `javascript:` or off-site links.
 */
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export const isChannelId = (s: unknown): s is string => typeof s === 'string' && CHANNEL_ID_RE.test(s);
export const isVideoId = (s: unknown): s is string => typeof s === 'string' && VIDEO_ID_RE.test(s);

export const channelUrl = (id: string) =>
  isChannelId(id) ? `https://www.youtube.com/channel/${id}` : 'https://www.youtube.com/';

export const videoUrl = (id: string) =>
  isVideoId(id) ? `https://www.youtube.com/watch?v=${id}` : 'https://www.youtube.com/';

/** Only allow avatars from Google's image CDNs. */
export function safeImageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return undefined;
    if (/(^|\.)(ggpht\.com|googleusercontent\.com|ytimg\.com)$/.test(u.hostname)) return u.toString();
  } catch {
    /* invalid */
  }
  return undefined;
}

/** Extract a video id from a YouTube watch/shorts URL. */
export function videoIdFromUrl(href: string): string | undefined {
  try {
    const u = new URL(href);
    if (!/(^|\.)youtube\.com$/.test(u.hostname) && u.hostname !== 'youtu.be') return undefined;
    let id: string | null | undefined;
    if (u.hostname === 'youtu.be') id = u.pathname.slice(1);
    else if (u.pathname === '/watch') id = u.searchParams.get('v');
    else if (u.pathname.startsWith('/shorts/')) id = u.pathname.split('/')[2];
    return isVideoId(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Extract a channel id from `https://www.youtube.com/channel/UC…`. */
export function channelIdFromUrl(href: string | undefined): string | undefined {
  if (!href) return undefined;
  const m = /youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/.exec(href);
  return m?.[1];
}
