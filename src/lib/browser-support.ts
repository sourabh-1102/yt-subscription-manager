/**
 * Google sign-in uses chrome.identity.getAuthToken with a "Chrome extension" OAuth client.
 * That only works in genuine Google Chrome. Other Chromium browsers (Brave, Edge, Opera,
 * Vivaldi, Arc, plain Chromium) implement getAuthToken with a custom-URI-scheme web flow that
 * Google has rejected since Oct 2023 with "Error 400: invalid_request".
 * Safe to import from UI and worker (no token code here).
 */
interface Brand {
  brand: string;
  version: string;
}

export interface BrowserSupport {
  supported: boolean;
  /** Human-readable browser name when it can be determined. */
  browser: string;
}

const KNOWN_OTHERS: [RegExp, string][] = [
  [/brave/i, 'Brave'],
  [/edge/i, 'Microsoft Edge'],
  [/opera|opr/i, 'Opera'],
  [/vivaldi/i, 'Vivaldi'],
  [/yandex/i, 'Yandex'],
  [/samsung/i, 'Samsung Internet'],
];

export function detectBrowserSupport(
  brands: Brand[] | undefined,
  extra: { isBrave?: boolean; userAgent?: string } = {},
): BrowserSupport {
  if (extra.isBrave) return { supported: false, browser: 'Brave' };
  const names = (brands ?? []).map((b) => b.brand);
  for (const [re, label] of KNOWN_OTHERS) if (names.some((n) => re.test(n))) return { supported: false, browser: label };
  if (names.includes('Google Chrome')) return { supported: true, browser: 'Google Chrome' };
  if (names.length) return { supported: false, browser: names.find((n) => !/not.?a.?brand/i.test(n)) ?? 'this browser' };
  // No client hints (very old builds): fall back to the UA string.
  const ua = extra.userAgent ?? '';
  if (/Edg\//.test(ua)) return { supported: false, browser: 'Microsoft Edge' };
  if (/OPR\//.test(ua)) return { supported: false, browser: 'Opera' };
  return { supported: /Chrome\//.test(ua), browser: /Chrome\//.test(ua) ? 'Google Chrome' : 'this browser' };
}

export function currentBrowserSupport(): BrowserSupport {
  const nav = (globalThis as { navigator?: Navigator & { userAgentData?: { brands?: Brand[] }; brave?: unknown } }).navigator;
  return detectBrowserSupport(nav?.userAgentData?.brands, { isBrave: !!nav?.brave, userAgent: nav?.userAgent });
}

export const unsupportedBrowserMessage = (browser: string) =>
  `Google sign-in only works in Google Chrome. ${browser} blocks Chrome-extension sign-in ` +
  `(Google returns "Error 400: invalid_request"). Open this extension in Google Chrome to connect your YouTube account — ` +
  `demo data, Takeout import and everything local still work here.`;
