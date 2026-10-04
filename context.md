# Project Context — YT Subscription Manager

> Reference for contributors. Read before writing code. Last updated: 2026-10-04. **Status: v1.0.0 built, phases 0–12 done in code; phase 13 (store/Google submissions) needs the owner's accounts.**
> If anything here conflicts with live Google/Chrome docs, the live docs win — update this file.

## 1. What we're building
A free, local-first Chrome MV3 extension: a dashboard to organize, analyze, and clean up a user's YouTube subscriptions.
No backend. No ads. No paid tiers. No telemetry. User data never leaves the browser except direct calls to Google's official APIs.

Priority order for every decision: **Correctness → Security → Privacy → Reliability → UX → Performance.**

## 2. Name / branding
**Decision (owner, 2026-10-04): working name is "YT Subscription Manager".**
Known risk, accepted by the owner: YouTube Branding Guidelines forbid "YouTube", "YT" or any variant in an app name.
This can cause Chrome Web Store rejection, and it is checked during the YouTube API Compliance Audit (quota) and OAuth verification.
Mitigations:
- The name lives in ONE place (`src/config/brand.ts` + the manifest `name`/`short_name`). Never hard-code it elsewhere, so a rename is a one-line change.
- Never use the YouTube logo, red play-button iconography or YouTube's colour scheme in our icon or branding.
- The description says "works with YouTube" and "not affiliated with or endorsed by YouTube or Google".

## 3. Verified platform facts (checked 2026-10-04)

### YouTube Data API v3. Quota is per Google Cloud project and shared by ALL users
| Method | Cost | Use |
|---|---|---|
| `subscriptions.list` (`mine=true`, 50/page) | 1 | Fetch subscriptions |
| `subscriptions.delete` | **50** | Unsubscribe |
| `subscriptions.insert` | **50** | Undo unsubscribe (re-subscribe) |
| `channels.list` (≤50 ids/call) | 1 | Channel metadata, uploads playlist id, `mine=true` for own channel id |
| `videos.list` (≤50 ids/call) | 1 | Resolve videoId → channelId |
| `playlistItems.list` | 1 | Latest upload per channel (1 call per channel) |
| `activities.list` | 1 | **Deprecated. Do not use.** |
| `search.list` | 100 | **Never use.** |

- The default quota is 10,000 units/day per project, and it resets at midnight Pacific. Every request costs at least 1 unit, even an invalid one.
- Getting more quota requires a free **API Compliance Audit**, and the extra quota may only be used for the approved use case.
- **The API has no watch history.** `relatedPlaylists.watchHistory` returns the placeholder `HL`, which is empty (since 2016). Watch Later (`WL`) is also inaccessible.
- **The API has no notification (bell) setting.** No endpoint reads or writes All/Personalized/None.
- Scopes: `youtube.readonly` (read) and `youtube` (needed for subscriptions.delete/insert). Both are **sensitive** scopes, so production needs OAuth verification. That is free but needs a privacy policy, a verified domain and a demo video. An app in "Testing" status is capped at 100 test users, and its tokens expire after 7 days.

### YouTube API Developer Policies (sections that constrain us)
- **III.E.4.c/d**: Do not store API data for more than **30 days** without refreshing it. Every cached API record must carry `fetchedAt`. Refresh stale records or delete them.
- **III.E.4.h**: Do not use API data to create "new or derived data or metrics". **Watch analytics must be built from data the user generates locally** (their own browsing, their own Takeout export), never from API stats. Do not compute scores from subscriber counts, view counts, etc.
- **III.E.2.a**: Do not aggregate API data across channels. Show raw API fields (e.g. the last upload date) as they are. Aggregates come only from local watch data.
- **III.E.3.d / III.I.2**: Every write (unsubscribe) must be clearly identified and expressly consented to before it runs. Never automate it.
- **III.D.2.c.1**: Give users an easy way to revoke access, and delete Authorized Data within 7 days of revocation.
- **III.A.2**: A privacy policy must be prominent and easy to reach.
- **III.I.1**: Do not replicate YouTube's core UX without adding significant independent value. We must not become a video feed or player.

### Chrome / MV3
- The service worker is ephemeral (it is killed after about 30s idle). No in-memory state. Use `chrome.alarms` for periodic jobs.
- Remote code is banned. Everything is bundled, with no `eval` or CDN scripts. The default extension CSP is fine.
- `chrome.identity.getAuthToken` uses the "Chrome Extension" OAuth client type, has no client secret, and Chrome caches and refreshes the token. It works in Chrome only, not Brave or Arc reliably. It also uses the Chrome profile's Google account, so it may not offer a brand-account or channel picker. This needs testing in Phase 4.
- `chrome.storage.local` holds 10 MB by default (`unlimitedStorage` lifts the limit). `chrome.storage.sync` holds ~100 KB total and 8 KB per item.
- IndexedDB belongs to the extension origin. Content scripts run under youtube.com's origin and **cannot** reach it, so they must message the service worker.

## 4. Feature decisions
| Feature | Approach | Status |
|---|---|---|
| Subscription list | `subscriptions.list` + `channels.list`, about 40 units per 1,000 subs | Possible |
| Categories/tags, favorites, review later | Local only, many-to-many tags | Possible |
| Last upload date | Public channel RSS feed `youtube.com/feeds/videos.xml?channel_id=` (0 quota). `playlistItems.list` as an on-demand fallback | Possible. RSS is unofficial and sometimes flaky, so degrade gracefully |
| Watch tracking (from install) | Content script on youtube.com: videoId from URL, channelId from the page or `videos.list`, counted as "watched" after a dwell threshold | Possible. Opt-in with a clear disclosure |
| Historical watch data | **Google Takeout import** (`watch-history.json`), parsed locally | Possible, manual |
| Unsubscribe | `subscriptions.delete`, user-confirmed, queued, with a per-user daily cap | Possible but quota-bound (50 units each) |
| Undo unsubscribe | `subscriptions.insert`. The original subscribe date is lost and the bell resets to default | Partial |
| Notification bell view/change | **Not possible via API.** No DOM automation. Instead: deep links to the channel page plus a local "bell intent" checklist | Redesigned |
| Subscriber/view-count based "engagement" | Not allowed (derived metrics policy) | Dropped |
| Low engagement | Defined only from local watch data | Possible |
| Auto-categorization | `features/categorize.ts`: keyword rules (EN + Hindi) on name/description/keywords + YouTube `topicDetails.topicCategories` (channels.list, 1 unit/50; used transiently, not stored). Review screen before applying; new subscriptions auto-categorized after each sync (pref `autoCategorizeNew`, default on). Adds categories, never removes. | Done |

## 5. Architecture (as built, v1.0.0)
- **WXT 0.21** (Vite 8) + **React 19** + TypeScript (strict, `noUncheckedIndexedAccess`) + **Tailwind 4**.
- Runtime dependencies: react, react-dom, dexie, dexie-react-hooks, zod, @tanstack/react-virtual. Do not add more without a reason.
- Entry points (`src/entrypoints/`):
  - `dashboard/`: full-tab React app. Clicking the toolbar icon opens it (no popup). Hash routes: `/overview`, `/channels?tag=|view=favorites|review|inactive`, `/analytics`, `/cleanup`, `/unsubscribed`, `/bells`, `/settings`, `/welcome`.
  - `background.ts`: service worker. Handles OAuth, all Google calls, alarms (sync every 6 h, RSS every 30 min, queue every 15 min, maintenance daily) and the message router.
  - `youtube.content.ts`: opt-in watch detection, 5.6 kB. It imports only `lib/defaults` and `lib/youtube-urls`, so keep it free of zod and other heavy code.
- Only the service worker talks to Google. The UI reads and writes IndexedDB directly for local data (Dexie live queries update across the worker and tabs). Everything that touches YouTube goes through messages (`lib/messages.ts`, zod).
- Token code lives only in `services/auth.ts`, `services/youtube-api.ts` and `services/queue.ts`. The UI imports `lib/oauth-config.ts` for the "configured?" check, never the auth module.
- Layout:
```
src/config/      brand.ts (name, single source), constants.ts (quota costs, caps, TTLs, alarm names)
src/lib/         types, defaults, prefs (zod), messages, ids, time, youtube-urls (safe link builders), oauth-config
src/db/          db.ts (Dexie schema v1), repo.ts (tags/flags/imports/reset; never touches YouTube)
src/services/    auth, youtube-api, quota, sync (+TTL), rss, watch, queue, takeout, backup, demo
src/features/    logic.ts: pure filters, cleanup rules and analytics (unit-tested)
src/ui/          App, Sidebar, ChannelGrid (virtualized cards, default) / ChannelList, AutoCategorize, BulkBar, ChannelDrawer, ReviewAssistant, charts, primitives, pages/*
tests/           parsers, logic, queue, data (Vitest + fake-indexeddb + WXT fake browser)
scripts/         build-privacy.mjs (PRIVACY.md → public/privacy.html), make-icons.mjs
```

## 6. Data model (IndexedDB "ysm", Dexie v1)
- **One account per browser profile.** Signing in with a different YouTube account while API data exists is refused with `account-mismatch`; the user must export and reset first.
- `channels`: id, title, thumbnailUrl, subscribed (0/1), subscriptionId, subscribedAt, videoCount, source (`api|takeout|watch|demo`), fetchedAt (TTL anchor; set ⇒ API data), lastUploadAt, lastUploadCheckedAt
- `tags`: id (uuid), name, emoji, order. `channelTags`: [channelId+tagId] (many-to-many)
- `flags`: channelId, favorite, reviewLater, note, bellIntent (`all|personalized|none`), bellDone
- `watchEvents`: id = `videoId:YYYY-MM-DD` (one per video per day), videoId, channelId, watchedAt, source (`tracked|takeout|demo`). No titles.
- `pendingVideos`: tracked videos whose channel isn't known yet. Resolved by local name match, then `videos.list`; dropped after 30 days.
- `batches`: id, kind (`unsubscribe|resubscribe`), channelIds, confirmedAt, status (`running|paused-quota|stopped|done`), resumeAfter, lastError
- `unsubscribed`: id = `batchId:channelId`, title, thumbnailUrl, oldSubscriptionId, tagIds, flags snapshot, queuedAt, doneAt, status, error, resubBatchId
- No rollup table: analytics aggregate `watchEvents` in memory (fine at 100k+ events).
- `chrome.storage.local`: `prefs`, `auth` (signedIn, account title/id, hasWriteScope, lastSync), `quota` (Pacific-day ledger of units and writes).
- **Never stored:** OAuth tokens, email, video titles, searches, comments, non-YouTube browsing.

## 7. Hard rules
1. Do not invent APIs. Verify against the live docs and record the result in §3.
2. No YouTube DOM automation, with **one owner-approved exception (2026-10-04): Watch Later** (the API has no access). See `features/wl-dom.ts` and `docs/playlist-manager.md`. The safeguards must stay:
   - only acts on `/playlist?list=WL`, only on an explicit, confirmed user request;
   - matches videos by video id only;
   - uses YouTube's visible "Remove from Watch later" menu item, then verifies the row is gone;
   - no cookies, tokens or internal endpoints.

   Never extend this to other actions (bells, unsubscribe, likes) without the owner's approval.
3. Never unsubscribe without explicit consent. Follow the Unsubscribe Consent Flow in §11 exactly.
4. Treat every input as untrusted: API strings, content-script messages, imported JSON. Validate with zod. Never use `dangerouslySetInnerHTML`. Only allow `https://www.youtube.com/...` links.
5. Never pass tokens to content scripts or UI pages. Never persist or log tokens.
6. Keep permissions minimal. Each new permission needs a written justification in `docs/permissions.md`.
7. Respect the 30-day TTL on API data.
8. No analytics SDKs, no remote config, no remote code.
9. Watch tracking is opt-in, can be paused, honours the excluded-channel list, never runs in incognito, and lets the user set retention and delete everything.
10. Build one phase at a time. Test each phase before moving on.

## 8. Permissions (final)
| Permission | Why |
|---|---|
| `storage` | Prefs, auth state, quota ledger |
| `identity` | OAuth via getAuthToken |
| `alarms` | Sync, RSS refresh, queue resume, maintenance (TTL, retention) |
| host `https://www.youtube.com/*` | Watch-tracking content script + public RSS feeds |
| ~~`unlimitedStorage`~~ | Not needed: IndexedDB isn't bound by the 10 MB storage.local limit |
| ~~`history`, `tabs`, `<all_urls>`, `webNavigation`~~ | Not needed. `tabs.create` needs no permission |
`incognito: "not_allowed"`. Paste-ready justifications are in `docs/permissions.md`.
Google API calls (`www.googleapis.com`) work from the service worker without a host permission because they support CORS.

## 9. Phases: status
| # | Phase | Status |
|---|---|---|
| 0 | Research | ✅ |
| 1 | Foundation (WXT, SW, messaging, Dexie) | ✅ |
| 2 | UI (+ demo data, 1k–5k channels) | ✅ |
| 3 | Local data layer, export/import, reset | ✅ |
| 4 | OAuth (readonly + incremental write), disconnect/revoke | ✅ code. 👤 needs an OAuth client ID (SETUP.md) |
| 5 | Subscription sync, 30-day TTL, quota ledger, RSS | ✅ |
| 6 | Watch tracking + Takeout import | ✅ |
| 7 | Analytics | ✅ |
| 8 | Cleanup + Review Assistant + Unsubscribed dashboard | ✅ |
| 9 | Bell audit | ✅ |
| 10 | Perf + security review | ✅ `docs/security-review.md` (5k list ~0.45 s, search ~45 ms) |
| 11 | Privacy policy, disclosures | ✅ `PRIVACY.md`, `docs/permissions.md` |
| 12 | Production build, icons, screenshots, listing | ✅ `npm run zip`, `store/`, `docs/store-listing.md` |
| 13 | Store + OAuth verification + quota audit | 👤 owner. `docs/release-checklist.md` |

Verification so far: 38 automated tests; headless-Chromium smoke tests of every page, light and dark, the Review Assistant gating and 5k performance. **Not yet verified against the live YouTube API**: that needs a real OAuth client. When testing it, check the brand-account behaviour, large-list paging and that channel-link selectors still match on youtube.com.

## 9b. Playlist Manager (module, added 2026-10-04)
Full details are in `docs/playlist-manager.md`.

- **Files:** `services/playlist-api.ts` (endpoints), `services/playlists.ts` (cache, write-scope upgrade), `services/bulk.ts` (persisted add/remove/move engine), `features/watch-later.ts` (capability matrix), `ui/pages/{Playlists,PlaylistDetail,WatchLater}.tsx`, `ui/playlists/*`. Dexie v2 tables.
- **Watch Later:** the API can't list, add or remove it. It is imported from Takeout CSV; copying into playlists is supported, removal is not. DOM automation was rejected.
- **search.list** has its own 100-calls/day project bucket, so pasting links is the main way to add videos.
- **Safe move:** add, persist `added`, then remove. Never remove before the add succeeds.
- **Deleted items:** `deletionLog` (Dexie v4), written only after confirmed removals. Restore where the API allows: add back, recreate playlist, restore category.
  Watch Later can't be re-added (no API). Page: `ui/pages/DeletedItems.tsx`.

## 10. Storage location (owner decision)
Everything is stored in the user's own browser (IndexedDB + chrome.storage.local). There is no cloud, no backend, no server of ours, and no chrome.storage.sync in v1.
Note: storing data locally does **not** exempt us from the YouTube API policies. The 30-day refresh rule and the derived-metrics ban still apply to data that came from the API.
Data the user generated themselves (tracked watches, Takeout imports, tags, favorites) is not API data, so it is free of those rules.

## 11. Unsubscribe flow: "Review Assistant" (Phase 8). Owner-approved design, do not shortcut
Principle: the user reviews everything and confirms once. After that, the extension does the rest automatically.

**Step 0: Select.** The user selects channels (checkboxes, filters, select all, or the Cleanup Center). Selecting never triggers anything.
The **Unsubscribe** button is red/secondary and has no keyboard shortcut.

**Step 1: Review Assistant opens** (a full-screen wizard, not a tiny dialog).
- Message: "You selected N channels. Please review them before I unsubscribe."
- Each channel is shown as a row: avatar, name, tags, last watched, last upload, and a ✓ keep-in-batch toggle (✓ by default). Unticking a row removes that channel from the batch.
- A "Reviewed X / N" counter. A row counts as reviewed once it has been scrolled into view.
- **The confirm step stays locked until every row has been reviewed**, i.e. the user has scrolled through the whole list.

**Step 2: Confirm.**
- Checkbox: "☐ OK, I have reviewed these channels and I confirm: unsubscribe from N channels."
- The **Unsubscribe N channels** button is enabled only when the checkbox is ticked. If the batch changes in Step 1, the checkbox resets.
- On the first use, the `youtube` write scope is requested here (incremental auth), with copy explaining why.

**Step 3: Automatic execution** (no more clicks needed).
- Before any API call, the batch is written to the `unsubscribed` table with status `pending`. That table is the backup.
- The service worker runs the queue one call at a time, with a progress bar and a **Stop** button.
- If the daily quota or cap runs out, **the same confirmed batch resumes automatically** after the quota resets.
  - This is still covered by the user's consent: no new channels can be added to it.
  - It stays visible as "Pending (resumes tomorrow)" with a Stop button.
- Each item ends as `unsubscribed` or `failed` (with the reason). Failed items can be retried with one click.

**Step 4: Done screen.** "Unsubscribed from X channels. Y failed." with links to the Unsubscribed dashboard.

**Unsubscribed dashboard** (its own sidebar entry: 🗑 Unsubscribed)
- It lists every channel ever unsubscribed through the extension: avatar, name, date, batch, the tags it had at the time, and its status.
- It supports search, filter by batch or date, and select.
- **Re-subscribe** works for a single channel or in bulk. Bulk re-subscribe uses the same Review Assistant flow, because it is also a write.
  - A re-subscribe calls `subscriptions.insert` (50 units).
  - On success the channel moves back to the subscriptions list, and its old tags, favorite and notes are restored automatically.
- Caveats shown in the UI:
  - The bell resets to YouTube's default.
  - The original subscribe date is lost.
  - YouTube may rate-limit mass re-subscribes (`subscriptionForbidden` / rate errors), in which case the queue retries later.
- Entries are kept until the user deletes them, and they are included in export/backup.

**Never:** unsubscribe without Steps 1–2, unsubscribe on a schedule or by automatic rules, or add new channels to an already confirmed batch.

## 12. Open questions
- [x] Product name: "YT Subscription Manager" (owner accepted the branding risk, see §2)
- [ ] Brand-account / multi-channel behaviour of `getAuthToken` versus `launchWebAuthFlow`
- [ ] Is `subscriptions.list mine=true` capped for very large lists? Test with 1k+ and 2k+ accounts
- [ ] Domain for OAuth verification (GitHub Pages vs. a cheap custom domain)
- [x] Per-user daily write cap: `DAILY_WRITE_CAP = 40` (2,000 units) in `src/config/constants.ts`. Raise after the quota audit.
