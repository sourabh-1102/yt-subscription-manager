# Setup — Google sign-in (one-time, free)

The extension works without this (demo data and Google Takeout import). To connect real YouTube accounts you need your own **free** Google Cloud OAuth client. There is no client secret, and nothing here costs money.

## 1. Build and load the extension

```bash
npm install
npm run build
```

Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and select `.output/chrome-mv3`.

The dev build includes a public key (`WXT_EXTENSION_KEY` in `.env`), so the extension ID is always:

```
kcokgoojiblaodggipledjnngigmooce
```

The matching private key is in `keys/dev-key.pem`. It is git-ignored; never share or commit it.

## 2. Create the OAuth client (Google Cloud Console)

1. Go to <https://console.cloud.google.com/> and create a project, e.g. `yt-subscription-manager`.
2. **APIs & Services → Library**: enable **YouTube Data API v3**.
3. **APIs & Services → OAuth consent screen** (Google Auth Platform):
   - User type: **External**
   - App name: `YT Subscription Manager`, plus your support email
   - Scopes: add `https://www.googleapis.com/auth/youtube.readonly` and `https://www.googleapis.com/auth/youtube`
   - While in **Testing**, add your Google account(s) under **Test users**. Up to 100 users are allowed, and their tokens expire every 7 days.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Chrome Extension**
   - Item ID: `kcokgoojiblaodggipledjnngigmooce` (or your Chrome Web Store item ID, see below)
5. Copy the client ID (`xxxx.apps.googleusercontent.com`) into `.env`:

```
WXT_OAUTH_CLIENT_ID=xxxx.apps.googleusercontent.com
```

6. Run `npm run build` again, then click the reload icon on the extension in `chrome://extensions`.
7. Open the dashboard and go to **Settings → Connect YouTube account**.

### Playlist Manager

No extra setup is needed. It uses the same OAuth client and the same two scopes: `youtube.readonly` to view, and `youtube`, requested only on your first change. Make sure **YouTube Data API v3** is enabled; it already is if subscriptions sync. Watch Later works from a Google Takeout import, because the API doesn't expose it. See [docs/playlist-manager.md](docs/playlist-manager.md).

## 3. Chrome Web Store build

The Chrome Web Store assigns its own item ID. The steps differ depending on whether you keep the dev key.

**Option A: keep the dev key's ID.** Upload once, open the item in the Developer Dashboard → **Package → View public key**, and confirm the key matches. Usually it won't match, in which case use option B.

**Option B (typical):**
1. Upload the first ZIP.
2. Copy the store's **public key** into `WXT_EXTENSION_KEY`.
3. Create a second OAuth client (Chrome Extension type) for the store item ID.
4. Put that client ID in `.env`.
5. Rebuild and upload.

## 4. Before going public

Both items are free.

- **OAuth verification.** YouTube scopes are *sensitive*, so Google must verify the app before more than 100 users can sign in. You will need:
  - the privacy policy URL (host [PRIVACY.md](PRIVACY.md), e.g. on GitHub Pages);
  - a homepage URL on a domain you verified in Google Search Console;
  - a scope justification (see [docs/permissions.md](docs/permissions.md));
  - a demo video of the sign-in and unsubscribe flow.
- **Quota.** The default is 10,000 units/day **per project, shared by all users**. One unsubscribe costs 50 units. Apply for more quota through the YouTube API Services **Audit and Quota Extension** form, and describe the review-and-confirm flow.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Google sign-in is not configured" | `WXT_OAUTH_CLIENT_ID` is empty. Fill it in and rebuild. |
| `bad client id` / OAuth error | The OAuth client's Item ID doesn't match the extension ID shown in `chrome://extensions`. |
| "Error 400: invalid_request" / "Access blocked: …request is invalid" | You are not in **Google Chrome**. Brave, Edge, Opera, Vivaldi, Arc and Chromium build `getAuthToken` requests with a custom URI scheme that Google rejects. Load the extension in Google Chrome. Also make sure Chrome sign-in is allowed (`chrome://settings/syncSetup` → "Allow Chrome sign-in"). |
| "Access blocked: app has not completed verification" | Add your account as a test user, or complete verification. |
| `quotaExceeded` | The project's daily quota is used up. It resets at midnight Pacific; queued batches resume automatically. |
| Brand-account channel not offered | `chrome.identity` uses the Chrome profile's Google account. Sign into Chrome with the account that owns the channel (known limitation). |
