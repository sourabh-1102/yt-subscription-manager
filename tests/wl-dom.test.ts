// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  detectPageState,
  durationTextToIso,
  findRow,
  isWatchLaterUrl,
  readRows,
  removeFromWatchLater,
  videoIdFromHref,
  type WlTiming,
} from '@/features/wl-dom';

const WL = 'https://www.youtube.com/playlist?list=WL';
const T: WlTiming = { waitMs: 400, pollMs: 10 };

interface FakeOpts {
  /** Menu item labels; default English. */
  labels?: string[];
  /** If false, clicking "remove" does nothing (YouTube didn't apply it). */
  removeWorks?: boolean;
  /** Rows to render initially; the rest load via the continuation sentinel. */
  pageSize?: number;
}

/** Minimal fake of YouTube's Watch Later DOM: rows, ⋮ menu popup, removal, lazy loading. */
function buildPage(videos: { id: string; title: string }[], opts: FakeOpts = {}) {
  const { labels = ['Add to queue', 'Save to playlist', 'Remove from Watch later', 'Share'], removeWorks = true, pageSize = videos.length } = opts;
  document.body.innerHTML = '<ytd-browse><ytd-playlist-video-list-renderer><div id="contents"></div></ytd-playlist-video-list-renderer></ytd-browse>';
  const contents = document.querySelector('#contents')!;
  let rendered = 0;
  const removed: string[] = [];

  const addRow = (v: { id: string; title: string }, i: number) => {
    const row = document.createElement('ytd-playlist-video-renderer');
    row.innerHTML = `
      <a id="thumbnail" href="/watch?v=${v.id}&list=WL&index=${i + 1}"><img src="https://i.ytimg.com/vi/${v.id}/hqdefault.jpg"></a>
      <ytd-thumbnail-overlay-time-status-renderer><span id="text">12:34</span></ytd-thumbnail-overlay-time-status-renderer>
      <a id="video-title" href="/watch?v=${v.id}&list=WL&index=${i + 1}">${v.title}</a>
      <ytd-channel-name><a>Channel ${i}</a></ytd-channel-name>
      <div id="menu"><ytd-menu-renderer><button aria-label="Action menu">⋮</button></ytd-menu-renderer></div>`;
    row.querySelector('#menu button')!.addEventListener('click', () => {
      document.querySelector('ytd-menu-popup-renderer')?.remove();
      const popup = document.createElement('ytd-menu-popup-renderer');
      for (const label of labels) {
        const item = document.createElement('ytd-menu-service-item-renderer');
        item.innerHTML = `<yt-formatted-string>${label}</yt-formatted-string>`;
        item.addEventListener('click', () => {
          popup.remove();
          if (/remove|हटाएं|quitar/i.test(label) && removeWorks) {
            setTimeout(() => {
              removed.push(v.id);
              row.remove();
            }, 20);
          }
        });
        popup.appendChild(item);
      }
      document.body.appendChild(popup);
    });
    const sentinel = contents.querySelector('ytd-continuation-item-renderer');
    contents.insertBefore(row, sentinel);
  };

  const renderMore = () => {
    const next = videos.slice(rendered, rendered + pageSize);
    next.forEach((v, k) => addRow(v, rendered + k));
    rendered += next.length;
    let sentinel = contents.querySelector('ytd-continuation-item-renderer');
    if (rendered < videos.length) {
      if (!sentinel) {
        sentinel = document.createElement('ytd-continuation-item-renderer');
        contents.appendChild(sentinel);
      }
      (sentinel as HTMLElement).scrollIntoView = () => setTimeout(renderMore, 10);
    } else sentinel?.remove();
  };
  renderMore();
  return { removed };
}

const vids = (n: number, title = (i: number) => `Video ${i}`) =>
  Array.from({ length: n }, (_, i) => ({ id: `vid${String(i).padStart(8, '0')}`, title: title(i) }));

beforeEach(() => {
  document.body.innerHTML = '';
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => undefined);
});

describe('page detection', () => {
  it('recognises the real Watch Later URL only', () => {
    expect(isWatchLaterUrl(WL)).toBe(true);
    expect(isWatchLaterUrl('https://www.youtube.com/playlist?list=PLabc')).toBe(false);
    expect(isWatchLaterUrl('https://evil.com/playlist?list=WL')).toBe(false);
  });
  it('detects ok / signed-out / wrong page', () => {
    buildPage(vids(2));
    expect(detectPageState(document, WL)).toBe('ok');
    expect(detectPageState(document, 'https://www.youtube.com/')).toBe('not-watch-later');
    document.body.innerHTML = '<ytd-button-renderer><a href="https://accounts.google.com/ServiceLogin?x">Sign in</a></ytd-button-renderer>';
    expect(detectPageState(document, WL)).toBe('signed-out');
  });
  it('reports sign-in requirement instead of acting', async () => {
    document.body.innerHTML = '<a href="https://accounts.google.com/ServiceLogin">Sign in</a>';
    const r = await removeFromWatchLater(document, WL, 'vid00000000', T);
    expect(r).toMatchObject({ ok: false, code: 'signed-out', error: 'Please sign in to YouTube and try again.' });
  });
});

describe('reading the live list', () => {
  it('reads ids, titles, channels, durations', () => {
    buildPage(vids(3));
    const rows = readRows(document);
    expect(rows.map((r) => r.videoId)).toEqual(['vid00000000', 'vid00000001', 'vid00000002']);
    expect(rows[0]).toMatchObject({ title: 'Video 0', channelTitle: 'Channel 0', durationText: '12:34', index: 1 });
  });
  it('parses video ids from row links', () => {
    expect(videoIdFromHref('/watch?v=dQw4w9WgXcQ&list=WL&index=3')).toBe('dQw4w9WgXcQ');
    expect(videoIdFromHref('/watch?v=bad')).toBeUndefined();
  });
  it('converts duration text', () => {
    expect(durationTextToIso('12:34')).toBe('PT12M34S');
    expect(durationTextToIso('1:02:03')).toBe('PT1H2M3S');
    expect(durationTextToIso('LIVE')).toBeUndefined();
  });
});

describe('removing from the real Watch Later (UI)', () => {
  it('removes the selected video via YouTube’s menu and verifies it is gone', async () => {
    const page = buildPage(vids(3));
    const r = await removeFromWatchLater(document, WL, 'vid00000001', T);
    expect(r).toEqual({ ok: true });
    expect(page.removed).toEqual(['vid00000001']);
    expect(findRow(document, 'vid00000001')).toBeUndefined();
    expect(findRow(document, 'vid00000000')).toBeTruthy();
  });

  it('matches by video id — never removes a different video with the same title', async () => {
    const page = buildPage(vids(3, () => 'Same title'));
    await removeFromWatchLater(document, WL, 'vid00000002', T);
    expect(page.removed).toEqual(['vid00000002']);
  });

  it('missing video → "not found" and nothing is removed', async () => {
    const page = buildPage(vids(2));
    const r = await removeFromWatchLater(document, WL, 'zzzzzzzzzzz', T);
    expect(r).toMatchObject({ ok: false, code: 'not-found', error: 'Video not found in the current Watch Later list.' });
    expect(page.removed).toEqual([]);
  });

  it('loads more of a long list (lazy loading) to find older videos', async () => {
    const page = buildPage(vids(25), { pageSize: 10 });
    expect(readRows(document)).toHaveLength(10);
    const r = await removeFromWatchLater(document, WL, 'vid00000022', T);
    expect(r).toEqual({ ok: true });
    expect(page.removed).toEqual(['vid00000022']);
  });

  it('unknown menu language → clear failure, row untouched', async () => {
    const page = buildPage(vids(1), { labels: ['Zur Warteschlange', 'Teilen'] });
    const r = await removeFromWatchLater(document, WL, 'vid00000000', T);
    expect(r).toMatchObject({ ok: false, code: 'remove-item-not-found' });
    expect(page.removed).toEqual([]);
    expect(findRow(document, 'vid00000000')).toBeTruthy();
  });

  it('works with a localized (Hindi) menu', async () => {
    const page = buildPage(vids(1), { labels: ['कतार में जोड़ें', 'बाद में देखें से हटाएं'] });
    expect(await removeFromWatchLater(document, WL, 'vid00000000', T)).toEqual({ ok: true });
    expect(page.removed).toEqual(['vid00000000']);
  });

  it('reports failure when YouTube did not actually remove it (verification)', async () => {
    buildPage(vids(1), { removeWorks: false });
    const r = await removeFromWatchLater(document, WL, 'vid00000000', T);
    expect(r).toMatchObject({ ok: false, code: 'not-verified' });
  });

  it('refuses to act outside the Watch Later page', async () => {
    const page = buildPage(vids(1));
    const r = await removeFromWatchLater(document, 'https://www.youtube.com/playlist?list=PLother', 'vid00000000', T);
    expect(r).toMatchObject({ ok: false, code: 'not-watch-later' });
    expect(page.removed).toEqual([]);
  });
});
