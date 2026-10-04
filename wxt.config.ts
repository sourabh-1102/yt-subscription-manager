import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync, existsSync } from 'node:fs';
import { BRAND } from './src/config/brand';

/** Minimal .env reader so the config does not depend on Vite internals. */
function readEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const file of ['.env', '.env.local']) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m) env[m[1]!] = m[2]!;
    }
  }
  return { ...env, ...(process.env as Record<string, string>) };
}

const env = readEnv();
/** Same value in every bundle of one build — lets the dashboard detect a stale service worker. */
const BUILD_ID = Date.now().toString(36);

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  vite: () => ({ plugins: [tailwindcss()], define: { __BUILD_ID__: JSON.stringify(BUILD_ID) } }),
  manifest: () => ({
    name: BRAND.name,
    short_name: BRAND.shortName,
    description: BRAND.description,
    // Keeps the unpacked extension ID stable so the OAuth client keeps working.
    // The Chrome Web Store assigns its own key on upload; remove for store builds if desired.
    ...(env.WXT_EXTENSION_KEY ? { key: env.WXT_EXTENSION_KEY } : {}),
    // storage: preferences. identity: Google sign-in. alarms: background sync + unsubscribe queue.
    permissions: ['storage', 'identity', 'alarms'],
    // Content script (watch tracking, opt-in) and public RSS feeds (last upload date).
    host_permissions: ['https://www.youtube.com/*'],
    // Never run (and never track) in incognito.
    incognito: 'not_allowed',
    action: { default_title: `Open ${BRAND.name}` },
    oauth2: {
      client_id: env.WXT_OAUTH_CLIENT_ID || 'MISSING_CLIENT_ID.apps.googleusercontent.com',
      // Read-only by default. The write scope is requested incrementally on the first confirmed unsubscribe.
      scopes: ['https://www.googleapis.com/auth/youtube.readonly'],
    },
  }),
});
