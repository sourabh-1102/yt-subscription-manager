# Security & performance review (Phase 10)

_Performed 2026-10-04 against build 1.0.0._

## Results

| Area | Check | Result |
|---|---|---|
| XSS | No `dangerouslySetInnerHTML`, `innerHTML`, `eval` or `new Function` in `src/` | ✅ None found |
| XSS | Channel titles and notes are rendered as React text (escaped) | ✅ |
| Links | All YouTube links are built from validated IDs (`channelUrl`, `videoUrl`); external links use `rel="noopener noreferrer"` | ✅ |
| Images | Avatars are allowed only from `https://*.ggpht.com`, `*.googleusercontent.com` and `*.ytimg.com`, with `referrerPolicy=no-referrer` | ✅ |
| Tokens | Token code (`getAuthToken`, `Bearer`) exists only in background modules. The dashboard bundle has 0 occurrences (verified in build output). Tokens are never persisted, logged, or sent to pages or content scripts | ✅ |
| Revocation | Disconnect revokes at `oauth2.googleapis.com/revoke` and clears Chrome's token cache | ✅ |
| Messaging | Messages are accepted only from `sender.id === runtime.id`. Content-script messages and UI messages use separate zod schemas, so a content script cannot trigger UI actions. There is no `externally_connectable` | ✅ |
| Content script | Read-only and isolated world. It reads only the URL video ID, owner channel link/name and `<video>` playback time. It does not run in incognito, and does nothing while tracking is off | ✅ |
| Untrusted input | API responses, backup files and Takeout files are validated with zod or strict parsers, with size limits (150 MB JSON / 20 MB CSV) | ✅ |
| Destructive writes | Unsubscribes run only through `queue/start` with `confirmed: true`, which the UI sends only after every row is reviewed and the checkbox is ticked. Batches cannot grow, and Stop is honoured between calls | ✅ (tested) |
| Stop race | An unsubscribe that is in flight when Stop is pressed is still archived, so it can be re-subscribed | ✅ Fixed + tested |
| CSP | Manifest V3 default CSP, no remote code, Tailwind compiled at build time | ✅ |
| Permissions | `storage`, `identity`, `alarms`, plus host `https://www.youtube.com/*` only | ✅ |
| Supply chain | 6 runtime dependencies (react, react-dom, dexie, dexie-react-hooks, zod, @tanstack/react-virtual); `npm audit`: 0 vulnerabilities | ✅ |

## Performance (headless Chromium, demo + synthetic data)

| Scenario | Result |
|---|---|
| 1,000 channels / ~12k watch events: overview render | ~1.5 s cold, including demo generation |
| 5,000 channels: subscription list ready after a full reload | **~0.45 s** |
| Search across 5,000 channels | **~45 ms** |
| List rendering | Virtualized (`@tanstack/react-virtual`), so only about 25 rows are in the DOM at any size |
| Content script size | 5.6 kB (injected on youtube.com) |
| API cost per full sync | 1 unit per 50 subscriptions (1,000 subs = 20 units) |
| Last-upload checks | 0 API units (public RSS), 40 channels per 30-minute tick, 250 ms apart |

## Known limitations / follow-ups

- The dashboard chunk is 528 kB minified (React + Dexie + zod). It loads from local disk, so this is acceptable, but route-level code splitting could be added later.
- Watch detection depends on YouTube's page structure for the channel link. If YouTube changes it, watches fall back to name-matching against subscriptions, then to `videos.list` (1 unit per 50 videos).
- `chrome.identity.getAuthToken` uses the Chrome profile's Google account, so brand-account channel selection is limited.
- The 400 ms pacing between write calls is conservative. YouTube may still return `subscriptionForbidden` for rapid re-subscribes; affected items are marked failed and can be retried.
