# Changelog

## 1.0.0 — 2026-10-04

First complete release.

- Subscription dashboard with search, combinable filters and sorting. The list is virtualized and handles 5,000+ channels.
- Local categories (many-to-many, emoji, reorder), drag-and-drop, Favorites, Review Later, private notes.
- Google sign-in, read-only by default. The write scope is requested only when the user first confirms an unsubscribe.
- Subscription sync. YouTube API data is refreshed daily and enforced to a 30-day lifetime.
- Last upload date from public RSS feeds (no API quota).
- Opt-in watch tracking on youtube.com (video ID, channel ID, time). Ads are excluded, there is a dwell threshold, and channel exclusions, retention and incognito are respected.
- Google Takeout import for watch history (JSON) and subscriptions (CSV).
- Watch analytics: most watched, weekly trend, category distribution, watch frequency, "watched but not subscribed", and per-channel monthly history.
- Cleanup center with 10 combinable signals.
- Review Assistant: review every channel, confirm once, then automatic execution with progress, Stop, Retry, a per-user daily cap and auto-resume after the quota resets.
- Unsubscribed dashboard with single and bulk re-subscribe that restores categories and favorites.
- Bell audit: plan notification bells locally and apply them on YouTube with deep links.
- Backup and restore (merge or replace, schema-validated), reset analytics, reset all.
- Demo data mode, light and dark themes, privacy policy bundled in the extension.
