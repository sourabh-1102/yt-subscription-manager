import { browser } from 'wxt/browser';

/** True when the build has a real OAuth client ID (safe to import from UI — no token code here). */
export function isClientIdConfigured(): boolean {
  const id = browser.runtime.getManifest().oauth2?.client_id ?? '';
  return id.endsWith('.apps.googleusercontent.com') && !id.startsWith('MISSING_CLIENT_ID');
}
