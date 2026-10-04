/**
 * Watch Later — YouTube website UI integration (runs in the content script on youtube.com).
 *
 * The YouTube Data API cannot read or modify Watch Later, so — only when the user explicitly asks
 * and confirms — this module performs the same clicks the user would: open the video's ⋮ menu on
 * the real Watch Later page and choose YouTube's own "Remove from Watch later" item. It then VERIFIES
 * the video disappeared before reporting success.
 *
 * Safety rules (enforced here):
 *  - Videos are matched ONLY by video id (from the row's watch link) — never by title/position.
 *  - Only acts on https://www.youtube.com/playlist?list=WL (the real Watch Later page).
 *  - Never touches cookies, tokens or internal YouTube endpoints; only visible UI elements.
 *  - If anything is ambiguous (menu item not found, row still present), it reports failure.
 *
 * Everything takes `doc`/`win` parameters so it is unit-testable with a fake DOM.
 */

export type WlPageState = 'ok' | 'not-watch-later' | 'signed-out' | 'loading';

export interface WlRow {
  videoId: string;
  title: string;
  channelTitle?: string;
  durationText?: string;
  thumbnailUrl?: string;
  /** 1-based position on the page. */
  index: number;
}

export interface WlTiming {
  /** Max wait for a menu / row change. */
  waitMs: number;
  /** Poll interval. */
  pollMs: number;
}

export const DEFAULT_TIMING: WlTiming = { waitMs: 6000, pollMs: 100 };

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** "Remove from Watch later" in YouTube's most common UI languages (menu text is localized). */
export const REMOVE_LABELS = [
  'remove from watch later',
  'बाद में देखें से हटाएं',
  'बाद में देखें से निकालें',
  'quitar de ver más tarde',
  'eliminar de ver más tarde',
  'remover de assistir mais tarde',
  'supprimer de à regarder plus tard',
  'aus „später ansehen“ entfernen',
  'aus "später ansehen" entfernen',
  'rimuovi da guarda più tardi',
  'verwijderen uit later bekijken',
  'удалить из списка «смотреть позже»',
  '「後で見る」から削除',
  '나중에 볼 동영상에서 삭제',
  'hapus dari tonton nanti',
  'izle listesinden kaldır',
];

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

export function isWatchLaterUrl(href: string): boolean {
  try {
    const u = new URL(href);
    return u.hostname === 'www.youtube.com' && u.pathname === '/playlist' && u.searchParams.get('list') === 'WL';
  } catch {
    return false;
  }
}

/** Video id from a row link like /watch?v=ID&list=WL&index=3 */
export function videoIdFromHref(href: string | null | undefined): string | undefined {
  if (!href) return undefined;
  try {
    const v = new URL(href, 'https://www.youtube.com').searchParams.get('v');
    return v && VIDEO_ID_RE.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

const ROW_SELECTOR = 'ytd-playlist-video-renderer';

export function getRows(doc: Document): Element[] {
  return [...doc.querySelectorAll(ROW_SELECTOR)];
}

function rowVideoId(row: Element): string | undefined {
  const a = row.querySelector<HTMLAnchorElement>('a#video-title, a#thumbnail, a[href*="/watch?v="]');
  return videoIdFromHref(a?.getAttribute('href'));
}

export function findRow(doc: Document, videoId: string): Element | undefined {
  return getRows(doc).find((r) => rowVideoId(r) === videoId);
}

export function detectPageState(doc: Document, href: string): WlPageState {
  if (!isWatchLaterUrl(href)) return 'not-watch-later';
  const list = doc.querySelector('ytd-playlist-video-list-renderer');
  if (list || getRows(doc).length) return 'ok';
  // Signed-out YouTube shows a "Sign in" link to Google accounts and no playlist.
  if (doc.querySelector('a[href*="accounts.google.com/ServiceLogin"], ytd-button-renderer a[href*="ServiceLogin"]')) return 'signed-out';
  return 'loading';
}

export function readRows(doc: Document): WlRow[] {
  const out: WlRow[] = [];
  const seen = new Set<string>();
  getRows(doc).forEach((row, i) => {
    const videoId = rowVideoId(row);
    if (!videoId || seen.has(videoId)) return;
    seen.add(videoId);
    const title = row.querySelector('#video-title')?.textContent?.trim() ?? '';
    const channelTitle = row.querySelector('ytd-channel-name a, #channel-name a, ytd-channel-name')?.textContent?.trim() || undefined;
    const durationText =
      row.querySelector('ytd-thumbnail-overlay-time-status-renderer #text, ytd-thumbnail-overlay-time-status-renderer, .badge-shape-wiz__text')?.textContent?.trim() ||
      undefined;
    const img = row.querySelector<HTMLImageElement>('img');
    const src = img?.getAttribute('src') || undefined;
    out.push({
      videoId,
      title,
      channelTitle,
      durationText,
      thumbnailUrl: src && src.startsWith('https://') ? src : `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      index: i + 1,
    });
  });
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | undefined | null | false, t: WlTiming): Promise<T | undefined> {
  const end = Date.now() + t.waitMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return undefined;
    await sleep(t.pollMs);
  }
}

/** Visible menu items currently open (YouTube renders the popup at the end of <body>). */
function openMenuItems(doc: Document): Element[] {
  return [
    ...doc.querySelectorAll(
      'ytd-menu-popup-renderer ytd-menu-service-item-renderer, ytd-menu-popup-renderer tp-yt-paper-item, yt-list-item-view-model, [role="menuitem"]',
    ),
  ].filter((el) => !(el as HTMLElement).hidden && (el as HTMLElement).getAttribute('aria-hidden') !== 'true');
}

export function findRemoveItem(doc: Document): Element | undefined {
  return openMenuItems(doc).find((el) => {
    const text = norm(el.textContent);
    return REMOVE_LABELS.some((l) => text === l || text.includes(l));
  });
}

function closeMenus(doc: Document) {
  doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  doc.body?.click();
}

/** Scroll to the "load more" sentinel until the video appears or the list ends. */
export async function loadUntil(doc: Document, predicate: () => boolean, t: WlTiming, maxRounds = 200): Promise<boolean> {
  for (let i = 0; i < maxRounds; i++) {
    if (predicate()) return true;
    const more = doc.querySelector('ytd-playlist-video-list-renderer ytd-continuation-item-renderer, ytd-continuation-item-renderer');
    if (!more) return predicate();
    const before = getRows(doc).length;
    (more as HTMLElement).scrollIntoView?.({ block: 'end' });
    const grew = await waitFor(() => getRows(doc).length > before, t);
    if (!grew) return predicate();
  }
  return predicate();
}

export type RemoveResult =
  | { ok: true }
  | { ok: false; code: 'not-watch-later' | 'signed-out' | 'not-found' | 'menu-not-found' | 'remove-item-not-found' | 'not-verified'; error: string };

export const REMOVE_ERRORS = {
  'not-watch-later': 'The YouTube tab is not on your Watch Later page.',
  'signed-out': 'Please sign in to YouTube and try again.',
  'not-found': 'Video not found in the current Watch Later list.',
  'menu-not-found': 'Couldn’t open the video’s menu on YouTube (the page layout may have changed).',
  'remove-item-not-found':
    'Couldn’t find YouTube’s “Remove from Watch later” option. If your YouTube language isn’t English, switch it to English and retry.',
  'not-verified': 'YouTube didn’t confirm the removal — the video is still in Watch Later.',
} as const;

const fail = (code: keyof typeof REMOVE_ERRORS): RemoveResult => ({ ok: false, code, error: REMOVE_ERRORS[code] });

/** Remove ONE video (matched by id) from the real Watch Later list, then verify it is gone. */
export async function removeFromWatchLater(doc: Document, href: string, videoId: string, t: WlTiming = DEFAULT_TIMING): Promise<RemoveResult> {
  if (!VIDEO_ID_RE.test(videoId)) return fail('not-found');
  const state = detectPageState(doc, href);
  if (state === 'not-watch-later') return fail('not-watch-later');
  if (state === 'signed-out') return fail('signed-out');

  const present = await loadUntil(doc, () => !!findRow(doc, videoId), t);
  const row = present ? findRow(doc, videoId) : undefined;
  if (!row) return fail('not-found');

  const menuBtn = row.querySelector<HTMLElement>('#menu button, ytd-menu-renderer button, yt-icon-button#button, button[aria-label]');
  if (!menuBtn) return fail('menu-not-found');
  (row as HTMLElement).scrollIntoView?.({ block: 'center' });
  menuBtn.click();

  const item = await waitFor(() => findRemoveItem(doc), t);
  if (!item) {
    closeMenus(doc);
    return fail('remove-item-not-found');
  }
  // Re-check the row is still the one we opened (the list may have shifted).
  if (rowVideoId(row) !== videoId) {
    closeMenus(doc);
    return fail('not-found');
  }
  (item as HTMLElement).click();

  const gone = await waitFor(() => !findRow(doc, videoId), t);
  return gone ? { ok: true } : fail('not-verified');
}

/** "12:34" / "1:02:03" → "PT12M34S" (for consistent display/sorting). */
export function durationTextToIso(text?: string): string | undefined {
  const m = text?.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!m) return undefined;
  const [, h, min, s] = m;
  return `PT${h ? `${Number(h)}H` : ''}${Number(min)}M${Number(s)}S`;
}
