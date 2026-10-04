# Permission & scope justifications

Paste-ready text for the Chrome Web Store "Privacy practices" tab and the Google OAuth verification form.

## Single purpose

> Help users organize, analyze and clean up their YouTube subscriptions in a private, local dashboard.

## Chrome permissions

| Permission | Justification | Alternatives considered |
|---|---|---|
| `storage` | Saves the user's preferences (theme, tracking settings, retention) and the local quota counter in the browser. | None. Required for settings to persist. |
| `identity` | Signs the user in with Google's official OAuth (`chrome.identity.getAuthToken`) so the extension can read their subscription list through the YouTube Data API, and change subscriptions only after explicit confirmation. | Scraping youtube.com was rejected: it is fragile and against policy. |
| `alarms` | Runs background jobs in the Manifest V3 service worker: a daily subscription refresh (also keeps API data within YouTube's 30-day freshness rule), last-upload checks, and resuming a user-confirmed unsubscribe batch after the daily quota resets. | `setTimeout` does not survive service-worker shutdown. |
| Host: `https://www.youtube.com/*` | (1) An opt-in content script that, while watch tracking is enabled, records the video ID, channel ID and time of videos the user plays. (2) Fetches each subscribed channel's public RSS feed to show its last upload date, which uses no API quota. (3) **Watch Later management, only when the user asks:** after the user presses "Refresh from YouTube", it reads the user's own Watch Later page; after the user selects videos and confirms, it uses YouTube's visible "Remove from Watch later" menu for those videos. YouTube's API offers no access to Watch Later. It also lets the extension find the open Watch Later tab (`tabs.query` by URL; no `tabs` permission needed). | `history` was rejected: it shows a much broader warning (all browsing on all sites) and has no channel information. `<all_urls>` is not needed. |

**Not requested:** `tabs` (opening the dashboard uses `tabs.create`, which needs no permission), `history`, `webNavigation`, `cookies`, `<all_urls>` and `externally_connectable`. Incognito is set to `not_allowed`.

## Remote code

> No. All code is bundled in the package. The extension loads no remote scripts and uses no `eval`.

## Google OAuth scopes

| Scope | Sensitivity | Why it is needed | When it is requested |
|---|---|---|---|
| `https://www.googleapis.com/auth/youtube.readonly` | Sensitive | Read the user's own subscription list (`subscriptions.list mine=true`), their channel name (`channels.list mine=true`), and map watched video IDs to channels (`videos.list`). | At "Connect YouTube account" |
| `https://www.googleapis.com/auth/youtube` | Sensitive | Unsubscribe (`subscriptions.delete`) and re-subscribe (`subscriptions.insert`). The API offers no narrower scope for these operations. | Only when the user first confirms an unsubscribe or re-subscribe in the Review Assistant (incremental authorization) |

**Demo video outline for OAuth verification:**
1. Install → Welcome screen (data disclosure, tracking opt-in).
2. Connect → consent screen showing the read-only scope → subscriptions appear.
3. Organize into categories (local only).
4. Cleanup center → select channels → Review Assistant: review every channel, tick the confirmation → the incremental consent screen appears with the manage scope → progress → Unsubscribed dashboard → re-subscribe.
5. Settings → Disconnect (revokes the token and deletes API data).

## Data usage disclosures (Chrome Web Store)

| Category | Collected? | Notes |
|---|---|---|
| Personally identifiable information | No | |
| Health / Financial / Authentication info | No | OAuth tokens are handled by Chrome and never stored by the extension |
| Personal communications | No | |
| Location | No | |
| Web history | **Yes, only if the user enables watch tracking** | youtube.com video ID, channel ID and time; stored locally only |
| User activity | No | |
| Website content | No | |

Certify all three statements: data is not sold to third parties; it is not used or transferred for purposes unrelated to the single purpose; and it is not used to determine creditworthiness or for lending.
