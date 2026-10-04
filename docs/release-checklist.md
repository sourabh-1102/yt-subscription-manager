# Release checklist (Phases 12–13)

Steps marked 👤 need your own accounts. Everything else is already done in the repository.

## Build
- [x] `npm test`: 38 tests pass
- [x] `npm run compile`: type-check clean
- [x] `npm run build` creates `.output/chrome-mv3`
- [x] `npm run zip` creates `.output/yt-subscription-manager-1.0.0-chrome.zip`
- [x] Icons 16/32/48/128 (`public/icon`, regenerate with `node scripts/make-icons.mjs`)
- [x] Screenshots at 1280×800 in `store/screenshots/`
- [x] Privacy policy (`PRIVACY.md`, also bundled as `privacy.html`)
- [x] Permission justifications (`docs/permissions.md`)
- [x] Store copy (`docs/store-listing.md`)

## Google Cloud 👤
- [ ] Create the project and enable YouTube Data API v3 ([SETUP.md](../SETUP.md))
- [ ] Configure the OAuth consent screen with both YouTube scopes
- [ ] Create a Chrome Extension OAuth client for the dev ID, test with test users
- [ ] Host the privacy policy and homepage on a domain verified in Search Console. A GitHub Pages user site can be verified; otherwise a cheap custom domain works.

## Chrome Web Store 👤
- [ ] Register a developer account (one-time US$5 fee)
- [ ] Upload the ZIP as a **draft** to get the item ID and public key
- [ ] Create an OAuth client for the store item ID, set `WXT_OAUTH_CLIENT_ID` and `WXT_EXTENSION_KEY`, then rebuild and re-zip
- [ ] Fill in the listing from `docs/store-listing.md` and upload the screenshots
- [ ] Privacy tab: single purpose, permission justifications and data disclosures from `docs/permissions.md`, privacy policy URL
- [ ] Submit for review (expect an in-depth review because of host permissions)

## Google verification 👤
- [ ] Submit OAuth app verification with the scope justifications and a demo video (outline in `docs/permissions.md`)
- [ ] Submit the YouTube API Services Audit & Quota Extension form. Describe the Review Assistant flow, the per-user cap and that the extension is local-only. When approved, raise `DAILY_WRITE_CAP` in `src/config/constants.ts`.

## Each release
- [ ] Bump `version` in `package.json`
- [ ] Update `CHANGELOG.md`
- [ ] Run `npm test && npm run zip`
- [ ] Upload and submit
