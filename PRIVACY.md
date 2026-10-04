# Privacy Policy — YT Subscription Manager

_Effective: 4 October 2026_

YT Subscription Manager ("the extension") is a free Chrome extension that helps you organize, analyze and clean up your YouTube subscriptions. It is not affiliated with, endorsed by, or sponsored by YouTube or Google.

**Short version:** everything stays in your browser. We have no servers, we collect nothing, we sell nothing, and we show no ads.

## 1. What data the extension handles

| Data | Where it comes from | Why | Where it is stored |
|---|---|---|---|
| Your subscription list (channel ID, name, picture, subscription ID, subscribe date, upload count) | YouTube Data API, after you connect your account | To show and organize your subscriptions | Your browser only (IndexedDB) |
| Your own YouTube channel ID and name | YouTube Data API | To keep data from different accounts apart | Your browser only |
| Categories, favorites, Review Later, notes, bell plans | You | Organization features | Your browser only |
| Watch records: video ID, channel ID, date/time (**only if you turn on watch tracking**) | The page you are watching on youtube.com | Watch analytics and cleanup suggestions | Your browser only |
| Imported Google Takeout files (watch history, subscriptions) | Files you choose | Historical analytics / offline subscription list | Parsed in your browser; never uploaded |
| Last upload date of subscribed channels | Public YouTube channel feeds | "No recent uploads" cleanup filter | Your browser only |
| Your playlists and their videos (titles, channels, durations) | YouTube Data API | Playlist Manager | Your browser only (refreshed or deleted within 30 days) |
| Your Watch Later list (video IDs, titles, channels, durations) | Read from your own YouTube Watch Later page **when you press "Refresh from YouTube"**, or from a Takeout file you choose | Watch Later management | Your browser only |
| Unsubscribe history (channel, date, categories at the time) | Your confirmed actions | The Unsubscribed dashboard and re-subscribe | Your browser only |

## 2. What we never collect

- Passwords or Google credentials. Sign-in uses Google's official OAuth via Chrome. OAuth tokens are held by Chrome and are never stored, logged or transmitted by the extension except directly to Google's APIs.
- Your email address.
- Video titles from your history, search queries, comments, likes, or anything from websites other than youtube.com.
- Any activity in incognito windows (the extension is disabled there).
- Cookies or login sessions. Watch Later changes use your already-open, normally signed-in YouTube tab and YouTube's own buttons, only after you confirm.
- Telemetry, analytics, crash reports or advertising identifiers. The extension contains no third-party analytics or ad code.

## 3. How data is used and shared

Data is used **only** to provide the extension's features to you. It is **never** sold, shared with third parties, used for advertising, used to determine creditworthiness, or used for any purpose unrelated to the extension's single purpose.

The extension communicates only with:
- `www.googleapis.com` / `oauth2.googleapis.com` (YouTube Data API and Google sign-in), using your authorization;
- `www.youtube.com` (public channel feeds for last-upload dates, and the watch-tracking content script).

There is no developer-operated server.

## 4. Google API Services and YouTube

The extension uses YouTube API Services. By using it you agree to the [YouTube Terms of Service](https://www.youtube.com/t/terms). Google's privacy policy: <https://policies.google.com/privacy>.

The extension's use and transfer of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

- **Read-only by default** (`youtube.readonly`). The permission to manage subscriptions (`youtube`) is requested only when you first confirm an unsubscribe or re-subscribe in the Review Assistant.
- The extension changes your subscriptions **only** after you review the list of channels and explicitly confirm.
- Data obtained from the YouTube API is refreshed or deleted at least every 30 days.

## 5. Your controls

- **Watch tracking** is off by default. You can turn it on or off, pause it, exclude channels, and set automatic deletion (90 days to forever) in Settings.
- **Export / delete:** Settings → Backup exports all your data as JSON. "Reset analytics" and "Reset everything" delete data from your browser immediately.
- **Disconnect:** Settings → Disconnect revokes the extension's Google access and deletes data obtained from YouTube. You can also revoke access at <https://myaccount.google.com/permissions>. When access is revoked, YouTube API data is deleted from the extension within 7 days (immediately when you use Disconnect).
- **Uninstall:** removing the extension deletes all its stored data from your browser.

## 6. Security

Data stays in the browser's extension storage, isolated from websites. The extension loads no remote code, validates all imported files and API responses, and requests only the permissions it needs (`storage`, `identity`, `alarms`, and access to `https://www.youtube.com/*`).

## 7. Children

The extension is not directed at children under 13 and collects no personal information from anyone.

## 8. Changes

Material changes to this policy will be announced in the extension's release notes and reflected in the effective date above.

## 9. Contact

Questions or requests: open an issue on the project's repository or email the developer at the address listed on the Chrome Web Store page.
