import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { ContentMessage, UiMessage, type MessageResult } from '@/lib/messages';
import { ALARMS, DAY_MS } from '@/config/constants';
import { getAuthState, setAuthState } from '@/lib/prefs';
import { authLog, errMsg, isClientIdConfigured, NotSignedInError, revokeAll } from '@/services/auth';
import { signIn, SignInError } from '@/services/signin';
import { suggestCategories } from '@/services/categorize';
import { BUILD_ID } from '@/lib/build';
import {
  checkDuplicates,
  createPlaylistAndCache,
  deletePlaylistAndCache,
  enforcePlaylistTtl,
  enrichWatchLater,
  lookupVideos,
  PlaylistError,
  reorderItem,
  searchYouTube,
  syncPlaylistItems,
  syncPlaylists,
  updatePlaylistAndCache,
} from '@/services/playlists';
import { processOps, resumeOp, retryFailedOp, startOp, stopOp } from '@/services/bulk';
import { humanizeError } from '@/services/playlist-api';
import { deletePlaylists, mergePlaylists } from '@/services/playlist-ops';
import { enforceTrashTtl, recreatePlaylist, restorePlaylistVideos } from '@/services/trash';
import { ensureWlTab, liveStatus, refreshLiveWatchLater, WlLiveError } from '@/services/wl-live';
import { ApiError } from '@/services/youtube-api';
import { enforceApiDataTtl, refreshStaleChannelMetadata, syncIfStale, syncSubscriptions } from '@/services/sync';
import { refreshLastUploads } from '@/services/rss';
import { enforceWatchRetention, recordObservedWatch, resolvePendingVideos } from '@/services/watch';
import { processQueue, QueueError, retryFailed, startBatch, stopBatch } from '@/services/queue';
import { deleteApiData } from '@/db/repo';
import { db } from '@/db/db';

/**
 * Service worker: the only context that talks to Google. Stateless between wake-ups —
 * everything durable lives in IndexedDB / chrome.storage, periodic work runs on alarms.
 */
export default defineBackground(() => {
  // Toolbar click → open (or focus) the dashboard tab. No `tabs` permission needed.
  browser.action.onClicked.addListener(async () => {
    const url = browser.runtime.getURL('/dashboard.html');
    await browser.tabs.create({ url });
  });

  browser.runtime.onInstalled.addListener(async ({ reason }) => {
    await setupAlarms();
    await setAuthState({ clientIdConfigured: isClientIdConfigured(), syncing: false });
    if (reason === 'install') await browser.tabs.create({ url: browser.runtime.getURL('/dashboard.html#/welcome') });
  });

  browser.runtime.onStartup.addListener(async () => {
    await setupAlarms();
    await setAuthState({ syncing: false });
    void processQueue();
  });

  browser.alarms.onAlarm.addListener(async (alarm) => {
    try {
      switch (alarm.name) {
        case ALARMS.sync:
          await syncIfStale(DAY_MS);
          await resolvePendingVideos();
          break;
        case ALARMS.rss:
          await refreshLastUploads();
          break;
        case ALARMS.queue:
          await processQueue();
          await processOps();
          break;
        case ALARMS.bulk:
          await processOps();
          break;
        case ALARMS.maintenance:
          await runMaintenance();
          break;
      }
    } catch (e) {
      console.warn(`[ysm] alarm ${alarm.name} failed:`, errMsg(e));
    }
  });

  browser.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    // Only accept messages from this extension (pages + our own content script).
    if (sender.id !== browser.runtime.id) return false;
    const fromContentScript = !!sender.tab && !sender.url?.startsWith(browser.runtime.getURL(''));
    const handler = fromContentScript ? handleContent(raw) : handleUi(raw);
    handler.then(sendResponse, (e: unknown) => {
      authLog('message handler rejected', { error: errMsg(e) });
      sendResponse({
        ok: false,
        // API errors are shown in plain language; details stay in the worker console.
        error: e instanceof ApiError ? humanizeError(e) : errMsg(e),
        code: e instanceof QueueError || e instanceof NotSignedInError || e instanceof SignInError || e instanceof PlaylistError || e instanceof WlLiveError
            ? e.code
            : e instanceof ApiError
              ? e.reason
              : undefined,
      } satisfies MessageResult);
    });
    return true; // async response
  });

  // A batch may have been interrupted by a worker shutdown.
  void processQueue();
  void processOps();
});

async function setupAlarms() {
  await browser.alarms.create(ALARMS.sync, { periodInMinutes: 6 * 60, delayInMinutes: 1 });
  await browser.alarms.create(ALARMS.rss, { periodInMinutes: 30, delayInMinutes: 2 });
  await browser.alarms.create(ALARMS.queue, { periodInMinutes: 15 });
  await browser.alarms.create(ALARMS.maintenance, { periodInMinutes: 24 * 60, delayInMinutes: 5 });
}

async function runMaintenance() {
  const auth = await getAuthState();
  if (auth.signedIn) {
    await syncIfStale(DAY_MS).catch(() => undefined);
    await refreshStaleChannelMetadata().catch(() => undefined);
  }
  await enforceApiDataTtl();
  await enforceWatchRetention();
  await enforcePlaylistTtl();
  await enforceTrashTtl().catch(() => undefined);
  // Finished batches older than 90 days: keep the archive entries, drop the batch bookkeeping.
  await db.batches.filter((b) => b.status === 'done' && b.confirmedAt < Date.now() - 90 * DAY_MS).delete();
}

async function handleContent(raw: unknown): Promise<MessageResult> {
  const msg = ContentMessage.safeParse(raw);
  if (!msg.success) return { ok: false, error: 'Invalid message' };
  return { ok: true, data: await recordObservedWatch(msg.data) };
}

async function handleUi(raw: unknown): Promise<MessageResult> {
  const parsed = UiMessage.safeParse(raw);
  if (!parsed.success) {
    const type = (raw as { type?: unknown })?.type;
    return { ok: false, code: 'unknown-request', error: `Unknown request "${typeof type === 'string' ? type : '?'}" — the extension may need a reload.` };
  }
  const msg = parsed.data;
  switch (msg.type) {
    case 'meta/ping':
      return { ok: true, data: { build: BUILD_ID } };
    case 'auth/signIn': {
      authLog('message: auth/signIn received');
      const r = await signIn();
      void resolvePendingVideos().catch(() => undefined);
      void refreshLastUploads().catch(() => undefined);
      authLog('message: auth/signIn responding', { ok: true });
      return { ok: true, data: r };
    }
    case 'auth/signOut': {
      await revokeAll();
      if (msg.deleteApiData) await deleteApiData();
      await setAuthState({ signedIn: false, hasWriteScope: false, syncing: false });
      return { ok: true };
    }
    case 'sync/run':
      return { ok: true, data: await syncSubscriptions() };
    case 'rss/run':
      return { ok: true, data: await refreshLastUploads() };
    case 'categorize/suggest':
      return { ok: true, data: await suggestCategories(msg.ids) };
    // ---- Playlist Manager ----
    case 'pl/sync':
      return { ok: true, data: await syncPlaylists() };
    case 'pl/items':
      return { ok: true, data: await syncPlaylistItems(msg.playlistId) };
    case 'pl/create':
      return { ok: true, data: await createPlaylistAndCache(msg.input) };
    case 'pl/update':
      return { ok: true, data: await updatePlaylistAndCache(msg.id, msg.input) };
    case 'pl/delete':
      await deletePlaylistAndCache(msg.id);
      return { ok: true };
    case 'pl/reorder':
      await reorderItem(msg.playlistId, msg.itemId, msg.position);
      return { ok: true };
    case 'pl/duplicates':
      return { ok: true, data: await checkDuplicates(msg.playlistId, msg.videoIds) };
    case 'pl/lookup':
      return { ok: true, data: await lookupVideos(msg.ids) };
    case 'pl/search':
      return { ok: true, data: await searchYouTube(msg.q) };
    case 'wl/enrich':
      return { ok: true, data: await enrichWatchLater() };
    case 'pl/deleteMany':
      return { ok: true, data: await deletePlaylists(msg.ids) };
    case 'pl/merge':
      return { ok: true, data: await mergePlaylists(msg) };
    case 'wl/status':
      return { ok: true, data: await liveStatus() };
    case 'wl/open':
      await ensureWlTab(true, 1).catch(() => undefined); // opens/focuses; readiness not required
      return { ok: true };
    case 'wl/refreshLive':
      return { ok: true, data: await refreshLiveWatchLater() };
    case 'wl/remove':
      return {
        ok: true,
        data: await startOp({
          kind: 'wl-remove',
          label: `Remove ${msg.items.length} video${msg.items.length === 1 ? '' : 's'} from YouTube Watch Later`,
          items: msg.items,
        }),
      };
    case 'wl/move': {
      const dest = await db.playlists.get(msg.destPlaylistId);
      return {
        ok: true,
        data: await startOp({
          kind: 'wl-move',
          label: `Move ${msg.items.length} video${msg.items.length === 1 ? '' : 's'} from Watch Later → ${dest?.title ?? 'playlist'}`,
          destPlaylistId: msg.destPlaylistId,
          skipDuplicates: msg.skipDuplicates,
          items: msg.items,
        }),
      };
    }
    case 'op/start':
      return { ok: true, data: await startOp(msg) };
    case 'trash/restoreVideos':
      return { ok: true, data: await restorePlaylistVideos(msg.ids) };
    case 'trash/recreatePlaylist':
      return { ok: true, data: await recreatePlaylist(msg.id) };
    case 'op/stop':
      await stopOp(msg.id);
      return { ok: true };
    case 'op/resume':
      await resumeOp(msg.id);
      return { ok: true };
    case 'op/retry':
      return { ok: true, data: await retryFailedOp(msg.id) };
    case 'watch/resolvePending':
      return { ok: true, data: await resolvePendingVideos() };
    case 'queue/start':
      return { ok: true, data: await startBatch(msg.kind, msg.ids) };
    case 'queue/stop':
      await stopBatch(msg.batchId);
      return { ok: true };
    case 'queue/retryFailed':
      await retryFailed(msg.batchId);
      return { ok: true };
  }
}
