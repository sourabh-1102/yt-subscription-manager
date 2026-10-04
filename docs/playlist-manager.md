# Playlist Manager

A separate module of the extension for managing the user's own YouTube playlists and their Watch Later list. It reuses the existing sign-in, API client, quota tracking, database and design system, and it doesn't change how subscriptions work.

## Architecture

```
UI (dashboard)                               Service worker (only place that talks to Google)
──────────────────────────────               ───────────────────────────────────────────────
pages/Playlists.tsx        ──pl/sync──────▶  services/playlists.ts   (cache + validation + write-scope upgrade)
pages/PlaylistDetail.tsx   ──pl/items─────▶       │
pages/WatchLater.tsx       ──pl/create|update|delete|reorder──▶
playlists/dialogs.tsx      ──pl/duplicates|lookup|search──────▶  services/playlist-api.ts (typed, zod-validated)
playlists/VideoList.tsx    ──op/start|stop|resume|retry──────▶  services/bulk.ts (persisted bulk engine)
playlists/common.tsx  ◀── live queries on IndexedDB (playlists, playlistItems, watchLater, bulkOps, bulkOpItems)
```

- All messages are validated with zod in `lib/messages.ts`.
- The UI never holds tokens. The dashboard bundle contains no token code; this is checked after each build.
- New tables are in Dexie schema **v2**, as a purely additive migration: `playlists`, `playlistItems`, `watchLater`, `bulkOps`, `bulkOpItems`.
- The only changes to shared files are additive: new messages, sidebar entries, routes, an Overview card, a `PUT` method and an exported `call` in `youtube-api.ts`, and the `ysm-bulk` alarm.

## API endpoints & quota (verified 2026-10-04)

| Operation | Endpoint | Cost | Scope |
|---|---|---|---|
| List my playlists | `playlists.list mine=true` (50/page) | 1 | `youtube.readonly` |
| List videos in a playlist | `playlistItems.list` (50/page) | 1 | `youtube.readonly` |
| Durations / details / pasted links | `videos.list` (50 ids) | 1 | `youtube.readonly` |
| Search YouTube | `search.list` | 1 call from a **separate 100-calls/day bucket per project** | `youtube.readonly` |
| Create / edit / delete playlist | `playlists.insert/update/delete` | 50 | `youtube` |
| Add / remove video | `playlistItems.insert/delete` | 50 | `youtube` |
| Reorder | `playlistItems.update` (`snippet.position`) | 50 | `youtube` |

The project quota is 10,000 units per day, shared by all users. Writes are limited by `PLAYLIST_DAILY_WRITE_CAP` (150 per user per day) in `config/constants.ts`.

## OAuth

- Viewing playlists only needs the read-only scope that sign-in already grants.
- The first time you create, edit, delete, add, remove, move or reorder, `ensureWriteScope()` requests the `youtube` scope interactively. This is the same incremental flow unsubscribe uses, with the same OAuth client and no new client.
- If the request is declined, nothing is changed and you get a clear "Permission required" message.

## Watch Later

### What the official API allows (verified)

The [revision history](https://developers.google.com/youtube/v3/revision_history) states:
- Since 2016-09-12, `playlistItems.list` on `WL` returns an empty list.
- Since 2020-09, `playlistItems.insert` and `playlistItems.delete` support for `WL` is fully deprecated.

**So nothing about Watch Later uses the YouTube Data API**, apart from `videos.list` to fill in details for Takeout rows.

### How it works instead

| Capability | Source | How |
|---|---|---|
| **Live list** ("Refresh from YouTube") | YouTube website | Opens or reuses the user's own signed-in tab at `youtube.com/playlist?list=WL`. The content script scrolls the list to load all of it and reads each row: video ID from the row's watch link, title, channel, duration text and thumbnail. The local list is replaced and labelled **● Live YouTube Watch Later**. |
| **Remove from YouTube Watch Later** (single or bulk) | YouTube website | For each confirmed video: find the row **by video ID**, open its ⋮ menu, click YouTube's own "Remove from Watch later" item, then **verify the row disappeared**. Only then is the item marked removed and dropped from the local list. |
| **Move to Playlist** | API + website | 1. `playlistItems.insert` into the playlist. 2. Persist `added`. 3. Remove from Watch Later via the website. 4. Verify. If the removal fails: "Added to <playlist>, but could not remove from Watch Later: <reason>". A retry only does the removal. |
| **Add / copy to Playlist** | API | `playlistItems.insert`. Watch Later is not changed. |
| **Takeout import** | Local | `Watch later-videos.csv`, labelled **○ Imported from Google Takeout (local snapshot)**. Removing from this snapshot is never described as a YouTube change. |
| **Hide here** | Local | Extension-only flag |

### Safeguards (`features/wl-dom.ts`)

- Acts only on `https://www.youtube.com/playlist?list=WL`. Any other page returns "The YouTube tab is not on your Watch Later page."
- Matching is by **video ID only**, never by title, position or thumbnail. Two videos with the same title are handled correctly; this is covered by a test.
- If the video isn't present after loading the whole list, it reports "Video not found in the current Watch Later list." and nothing is clicked.
- If the menu item isn't found, the menu is closed and the item fails. This happens with an unsupported UI language; English plus about 15 common languages are matched.
- If the row is still present after clicking, the item fails with "not verified". **Success is reported only after verification.**
- A signed-out YouTube tab gives "Please sign in to YouTube and try again." The op stops with pending items kept, so **Resume** continues.
- The extension never reads cookies, extracts tokens, calls internal YouTube endpoints, or asks for passwords. It only uses the normal page.
- The content script acts only on commands from this extension's service worker (sender check). Those are sent only after the user selects videos and confirms.
- Removing from Watch Later **never deletes the video from YouTube**. The UI says so in the banner and in every confirmation.

### Policy notes (honest assessment)

- **YouTube API policies** don't apply to UI interaction; there is no API involvement.
- **YouTube's Terms of Service** restrict accessing the service "using any automated means". This feature acts only on the user's own account, only on explicit, per-batch confirmation, at human pace (about 1 action/second), so it is the user's own action performed for them. It is still a judgment call; be aware of it before Chrome Web Store publication.
- **Chrome Web Store:** allowed when the behaviour is disclosed. It's covered by the single purpose, the host-permission justification (`docs/permissions.md`) and the privacy policy.
- **Fragility:** if YouTube changes its Watch Later page layout, actions fail safely with clear errors. They never remove the wrong video, and the selectors live in one file for quick updates.

### Testing

- `tests/wl-dom.test.ts` (jsdom) simulates YouTube's Watch Later DOM. It covers: matching, same-title rows, missing videos, lazy loading, localized menus, unknown language, failed verification, wrong page and signed out.
- `tests/bulk-wl.test.ts` covers the engine: remove, failure, retry without repeats, stop on sign-out then resume, and safe move ordering.
- An end-to-end run in Chromium served a YouTube-structured Watch Later page at the real youtube.com URL. Results:
  - "Refresh from YouTube" loaded all 30 videos, including the lazy-loaded ones.
  - Exactly the 3 selected videos were removed, including one in the lazy-loaded part and one sharing its title.
  - A video absent from the page was reported "not found" with nothing touched.
- Against the real youtube.com while signed out, the page was correctly detected as signed out (`ServiceLogin` link, no list).
- **Not yet verified against a real signed-in Watch Later**; the automated browser can't sign in. Do the manual test in the README section below once.

## More playlist features

- **Multi-select playlists:** checkboxes on the cards, plus select all.
- **Delete selected playlists:** a `pl-delete` bulk op with progress, stop and retry. The confirmation lists every playlist.
- **Merge / combine:** videos of the selected playlists go into an existing playlist or a new one.
  - Each video is added once, unavailable videos are skipped, and videos already in the target are skipped by default.
  - Optionally the sources are deleted, but **only if every add succeeded**; the target itself is never deleted.
- **Remove duplicates:** removes repeated videos inside a playlist, keeping the first occurrence.
- **Playlist categories:**
  - They reuse the channel categories and are stored only in this extension (`playlistTags`, Dexie v3).
  - Filter by category, add or remove a category for selected playlists, and **✨ Auto-categorize**, which uses local keyword rules on title and description with no API.
  - Deleting a category removes it from playlists too.

## Bulk operation engine (`services/bulk.ts`)

- **Persisted:** each op and each item are stored in IndexedDB, so progress survives closing the tab, worker restarts and browser restarts.
- **Sequential**, one request at a time, 300 ms apart. It never fires hundreds of requests in parallel.
- **Statuses:** op `running | paused-quota | stopped | done`; item `pending | done | failed | skipped`.
- **Quota or daily cap reached:** the op pauses and resumes automatically after the Pacific-midnight reset, via the `ysm-bulk` alarm.
- **Stop** takes effect between items. Unfinished items stay pending, so **Resume** continues and never repeats completed items. **Retry failed** re-runs only the failed ones.
- **Safe move:**
  1. Add the video to the destination.
  2. Persist `added = 1`.
  3. Then remove it from the source.

  If the add fails, the source is never touched. If the removal fails, a retry only removes, so nothing is added twice. A video already in the destination is only removed from the source.
- **Duplicates:** the destination's contents are checked first, using the cache if under 10 minutes old. Duplicates are skipped by default, or you can choose **Add anyway**. Duplicates within the selection itself are always collapsed.
- **Errors** are shown in plain language (`humanizeError`): quota, permission, playlist not found, video unavailable, manual sorting required, network lost. Raw API details stay in the service worker.

## Reordering

The order changes on screen only after YouTube confirms. On a successful `playlistItems.update` the playlist is re-fetched, so positions are exactly YouTube's; on failure nothing changes and the error is shown. If the playlist is sorted automatically on YouTube, the API returns `manualSortRequired` and the message tells you to switch it to **Manual**. Drag-reorder is available only in "Playlist order" view without a search.

## Caching & the 30-day rule

| What | When it refreshes |
|---|---|
| Playlists | Cached and refreshed with **Refresh** |
| Playlist items | Fetched on open if older than 10 minutes, and after every op that touches the playlist |
| After create / edit / delete | The cache updates immediately |

The daily maintenance job deletes playlist and item caches older than 30 days and strips API metadata from Watch Later entries, keeping your own Takeout ids and dates. This follows YouTube API Developer Policies III.E.4.

## Not supported / limitations

- **Watch Later:** adding to it isn't offered. Removal works only through the YouTube website (see above) and needs a signed-in YouTube tab kept open while it runs.

- **Search:** about 100 searches per day for the whole project. Pasting links (unlimited, 1 unit per 50) is the main way to add videos.
- **"Last updated":** the API doesn't expose it, so creation dates are shown.
- **Playlists you don't own:** not shown, since `mine=true` only returns yours.
- **Reorder** needs Manual sorting on YouTube.
- **Large changes:** each add, remove or reorder costs 50 units, so very large changes spread over several days.

## Deleted items (history)

Route `/deleted`, sidebar **🗑 Deleted items**. Entries are stored locally in `deletionLog` (Dexie v4), plus the existing `unsubscribed` table for channels. An entry is written **only after a removal is confirmed**: an API success, or a verified Watch Later UI removal.

| Type | Logged by | Restore |
|---|---|---|
| Channels (unsubscribed) | existing queue → `unsubscribed` | Re-subscribe in the Unsubscribed dashboard |
| Playlist videos (removed / moved) | `bulk.ts` remove/move | **Add back** → `add` op into the original playlist (skips if already there). Needs the playlist to still exist. |
| Playlists (deleted, incl. merge sources) | `bulk.ts` pl-delete / merge, `deletePlaylistAndCache` | **Recreate**: new playlist with the same title, description and privacy; the saved video list is re-added. YouTube can't undelete, so the link changes. |
| Watch Later (removed / moved) | `bulk.ts` wl-remove / wl-move after verification | No API to add back. **Copy to playlist** or open the video. |
| Categories (local) | `repo.deleteTag` | **Restore**: the category and its channel and playlist assignments |

- Restores run through the same bulk engine: progress, stop, retry, quota pause.
- Successful restore items mark their log entry as restored (via `logId`).
- 30-day rule: YouTube-sourced titles are refreshed via `videos.list` when connected, otherwise stripped after 30 days. IDs, dates, notes and local category data are kept until the user clears the history.
- **Export** downloads the history as JSON. **Clear history** clears only the local log and never changes YouTube.
