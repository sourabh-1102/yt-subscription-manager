import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { DEFAULT_PREFS, STORAGE_KEYS } from '@/lib/defaults';
import type { Prefs } from '@/lib/types';
import { isChannelId, videoIdFromUrl } from '@/lib/youtube-urls';
import { DEFAULT_TIMING, detectPageState, loadUntil, readRows, removeFromWatchLater } from '@/features/wl-dom';

/**
 * Watch detection on youtube.com (opt-in; does nothing while tracking is off).
 *
 * Read-only: it never clicks, edits or injects anything into the page. It reports
 * { videoId, channelId?, channelName? } once a video has actually played for the
 * configured dwell time. Video titles, comments, searches and other pages are never read.
 */
export default defineContentScript({
  matches: ['https://www.youtube.com/*'],
  runAt: 'document_idle',
  main() {
    let prefs: Prefs = DEFAULT_PREFS;
    let currentVideo: string | undefined;
    let played = 0; // seconds of real playback for currentVideo
    let lastMediaTime: number | undefined;
    let lastWall = Date.now();
    let reported = false;

    const loadPrefs = async () => {
      const raw = (await browser.storage.local.get(STORAGE_KEYS.prefs))[STORAGE_KEYS.prefs] as Partial<Prefs> | undefined;
      prefs = { ...DEFAULT_PREFS, ...(raw ?? {}) };
    };
    void loadPrefs();
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && STORAGE_KEYS.prefs in changes) void loadPrefs();
    });

    /** Channel info from the page — best effort, verified against the current video id. */
    function readChannel(videoId: string): { channelId?: string; channelName?: string } {
      const out: { channelId?: string; channelName?: string } = {};
      // Classic microformat (only trusted when it belongs to the current video).
      const metaVideo = document.querySelector<HTMLMetaElement>('meta[itemprop="videoId"], meta[itemprop="identifier"]');
      const metaChannel = document.querySelector<HTMLMetaElement>('meta[itemprop="channelId"]');
      if (metaVideo?.content === videoId && isChannelId(metaChannel?.content)) out.channelId = metaChannel!.content;

      const watchFlexy = document.querySelector('ytd-watch-flexy');
      if (watchFlexy && watchFlexy.getAttribute('video-id') === videoId) {
        const ownerLink = document.querySelector<HTMLAnchorElement>(
          'ytd-watch-metadata ytd-channel-name a, #owner ytd-channel-name a, ytd-video-owner-renderer ytd-channel-name a',
        );
        const m = ownerLink?.href ? /\/channel\/(UC[A-Za-z0-9_-]{22})/.exec(ownerLink.href) : null;
        if (!out.channelId && m && isChannelId(m[1])) out.channelId = m[1];
        const name = ownerLink?.textContent?.trim();
        if (name) out.channelName = name.slice(0, 200);
      }
      return out;
    }

    function report(videoId: string) {
      reported = true;
      const ch = readChannel(videoId);
      browser.runtime.sendMessage({ type: 'watch/observed', videoId, ...ch }).catch(() => {
        /* extension reloaded / worker unavailable — ignore */
      });
    }

    function tick() {
      const now = Date.now();
      const wall = (now - lastWall) / 1000;
      lastWall = now;
      if (!prefs.trackingEnabled) return;

      const videoId = videoIdFromUrl(location.href);
      if (videoId !== currentVideo) {
        currentVideo = videoId;
        played = 0;
        lastMediaTime = undefined;
        reported = false;
      }
      if (!videoId || reported) return;

      const player = document.querySelector('#movie_player, #shorts-player');
      const video = player?.querySelector('video') ?? document.querySelector('video');
      if (!video || video.paused || video.readyState < 2) {
        lastMediaTime = video?.currentTime;
        return;
      }
      if (player?.classList.contains('ad-showing')) {
        lastMediaTime = undefined; // never count ads
        return;
      }
      const t = video.currentTime;
      if (lastMediaTime !== undefined) {
        const delta = t - lastMediaTime;
        // Count only forward playback that fits in elapsed wall time (ignores seeks; works when timers are throttled).
        if (delta > 0 && delta <= wall * Math.max(1, video.playbackRate) + 2) played += delta;
      }
      lastMediaTime = t;

      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Infinity;
      const needed = Math.max(5, Math.min(prefs.dwellSeconds, duration * 0.5));
      if (played >= needed) report(videoId);
    }

    setInterval(tick, 1000);

    // ---- Watch Later website integration (only on explicit, confirmed user requests) ----
    // Commands come only from this extension's service worker; nothing runs on its own.
    let busy = false;
    browser.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
      if (sender.id !== browser.runtime.id) return false;
      const m = msg as { type?: string; videoId?: string };
      if (m?.type === 'wl/ping') {
        sendResponse({ ok: true, state: detectPageState(document, location.href) });
        return false;
      }
      if (m?.type !== 'wl/read' && m?.type !== 'wl/remove') return false;
      if (busy) {
        sendResponse({ ok: false, code: 'busy', error: 'Another Watch Later action is still running in this tab.' });
        return false;
      }
      busy = true;
      void (async () => {
        try {
          if (m.type === 'wl/read') {
            const state = detectPageState(document, location.href);
            if (state !== 'ok') return sendResponse({ ok: false, code: state, state });
            await loadUntil(document, () => false, { ...DEFAULT_TIMING, waitMs: 8000 }, 400); // load the whole list
            sendResponse({ ok: true, rows: readRows(document) });
          } else {
            sendResponse(await removeFromWatchLater(document, location.href, String(m.videoId ?? '')));
          }
        } catch (e) {
          sendResponse({ ok: false, code: 'error', error: e instanceof Error ? e.message : String(e) });
        } finally {
          busy = false;
        }
      })();
      return true; // async response
    });
  },
});
