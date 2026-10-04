import { browser } from 'wxt/browser';
import { isClientIdConfigured } from '@/lib/oauth-config';
import { currentBrowserSupport, unsupportedBrowserMessage } from '@/lib/browser-support';

export { isClientIdConfigured };

/**
 * OAuth via chrome.identity.getAuthToken (service worker only).
 * Chrome stores and refreshes tokens itself — we never persist, log, or forward them.
 */
export const SCOPE_READ = 'https://www.googleapis.com/auth/youtube.readonly';
export const SCOPE_WRITE = 'https://www.googleapis.com/auth/youtube';

/**
 * TEMPORARY diagnostics for the sign-in flow. Logs step names, booleans, scope names and error
 * messages only — never tokens. View in chrome://extensions → service worker → Console.
 * Set to false once sign-in is confirmed working.
 */
export const AUTH_DEBUG = true;
export function authLog(step: string, info: Record<string, unknown> = {}): void {
  if (AUTH_DEBUG) console.info(`[ysm:auth] ${step}`, info);
}

/** Timeouts (exported so tests can shrink them). Interactive waits for the user. */
export const authTiming = {
  interactiveMs: 3 * 60 * 1000,
  silentMs: 15 * 1000,
  heartbeatMs: 15 * 1000,
};

export class NotSignedInError extends Error {
  code = 'not-signed-in';
  constructor(message = 'Not connected to a Google account.') {
    super(message);
  }
}

export interface TokenDetails {
  token: string;
  /** Scopes Chrome reports as granted for this token (scope names are not secret). */
  grantedScopes: string[];
}

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not respond within ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

type IdentityApi = {
  getAuthToken?: (d: { interactive: boolean; scopes: string[] }, cb?: (a?: unknown, b?: unknown) => void) => unknown;
};
type ChromeLike = { identity?: IdentityApi; runtime?: { lastError?: { message?: string }; getPlatformInfo?: () => Promise<unknown> } };

/** The real chrome.* namespace (not a wrapper), so we see exactly what Chrome provides. */
const chromeApi = (): ChromeLike | undefined => (globalThis as { chrome?: ChromeLike }).chrome;

function normalize(a: unknown, b?: unknown): TokenDetails {
  const obj = a && typeof a === 'object' ? (a as { token?: unknown; grantedScopes?: unknown }) : undefined;
  const token = typeof a === 'string' ? a : typeof obj?.token === 'string' ? obj.token : undefined;
  const scopesRaw = Array.isArray(b) ? b : Array.isArray(obj?.grantedScopes) ? obj.grantedScopes : [];
  if (!token) throw new Error('getAuthToken returned no token');
  return { token, grantedScopes: scopesRaw.filter((x): x is string => typeof x === 'string') };
}

/**
 * Calls chrome.identity.getAuthToken. MV3 Chrome returns a Promise<GetAuthTokenResult> when no
 * callback is passed — that is the primary path. If a build returns nothing (no promise support),
 * we fall back to the callback form and read chrome.runtime.lastError inside the callback.
 */
function rawGetAuthToken(details: { interactive: boolean; scopes: string[] }): Promise<TokenDetails> {
  const c = chromeApi();
  authLog('getAuthToken: env', {
    chromeIdentityExists: !!c?.identity,
    typeofGetAuthToken: typeof c?.identity?.getAuthToken,
  });
  const fn = c?.identity?.getAuthToken;
  if (typeof fn !== 'function') {
    return Promise.reject(new Error('chrome.identity.getAuthToken is unavailable (is the "identity" permission in the manifest?)'));
  }
  let ret: unknown;
  try {
    authLog('getAuthToken: invoking now (promise form)', { interactive: details.interactive });
    ret = fn.call(c!.identity, details);
    authLog('getAuthToken: invoke returned synchronously', {
      returnedThenable: !!ret && typeof (ret as { then?: unknown }).then === 'function',
    });
  } catch (e) {
    authLog('getAuthToken: threw synchronously', { error: errMsg(e) });
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
  if (ret && typeof (ret as Promise<unknown>).then === 'function') {
    return (ret as Promise<unknown>).then((r) => normalize(r));
  }
  // Callback fallback (older Chrome without promise support).
  return new Promise((resolve, reject) => {
    authLog('getAuthToken: falling back to callback form');
    fn.call(c!.identity, details, (a, b) => {
      const lastError = chromeApi()?.runtime?.lastError;
      authLog('getAuthToken: callback fired', { lastError: lastError?.message ?? null, hasToken: typeof a === 'string' || !!(a as { token?: string })?.token });
      if (lastError) return reject(new Error(lastError.message ?? 'Unknown identity error'));
      try {
        resolve(normalize(a, b));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** Logs "still waiting" and pings an extension API so the service worker is not shut down mid-flow. */
function startHeartbeat(label: string): () => void {
  const t0 = Date.now();
  const id = setInterval(() => {
    authLog(`${label}: still waiting`, { seconds: Math.round((Date.now() - t0) / 1000) });
    void chromeApi()?.runtime?.getPlatformInfo?.().catch(() => undefined);
  }, authTiming.heartbeatMs);
  return () => clearInterval(id);
}

async function attempt(interactive: boolean, write: boolean, scopes: string[]): Promise<TokenDetails> {
  authLog('getAuthToken: called', { interactive, write });
  const stop = startHeartbeat(`getAuthToken(interactive=${interactive})`);
  try {
    const r = await withTimeout(
      rawGetAuthToken({ interactive, scopes }),
      interactive ? authTiming.interactiveMs : authTiming.silentMs,
      'chrome.identity.getAuthToken',
    );
    authLog('getAuthToken: resolved', { interactive, write, hasToken: !!r.token, grantedScopes: r.grantedScopes });
    return r;
  } catch (e) {
    authLog('getAuthToken: rejected', { interactive, write, error: errMsg(e) });
    throw e;
  } finally {
    stop();
  }
}

const TIMEOUT_HELP =
  'Chrome did not finish Google sign-in. Check: (1) you are signed in to Chrome itself (profile icon, top-right → Sign in / Turn on sync) ' +
  'with a test-user account; (2) no Chrome sign-in or permission window is still open behind other windows; ' +
  '(3) then reload the extension at chrome://extensions and try again.';

/**
 * Token for API calls. For interactive requests we first try silently: if access was already
 * granted it returns immediately with no UI, and if not, Chrome's error message (e.g. "The user is
 * not signed in.") is logged as a diagnostic before the interactive prompt.
 */
export async function getTokenDetails(interactive: boolean, write = false): Promise<TokenDetails> {
  if (!isClientIdConfigured()) {
    throw new NotSignedInError('Google sign-in is not configured in this build (missing OAuth client ID). See SETUP.md.');
  }
  const support = currentBrowserSupport();
  if (!support.supported) throw new NotSignedInError(unsupportedBrowserMessage(support.browser));
  const scopes = write ? [SCOPE_READ, SCOPE_WRITE] : [SCOPE_READ];

  let silentError = '';
  try {
    return await attempt(false, write, scopes);
  } catch (e) {
    silentError = errMsg(e);
    if (!interactive) throw new NotSignedInError(`Not connected: ${silentError}`);
  }
  try {
    return await attempt(true, write, scopes);
  } catch (e) {
    const msg = errMsg(e);
    if (/did not respond/.test(msg)) throw new NotSignedInError(`${TIMEOUT_HELP} (Chrome said: "${silentError}")`);
    throw new NotSignedInError(`Sign-in was cancelled or failed: ${msg}`);
  }
}

export async function getToken(interactive: boolean, write = false): Promise<string> {
  return (await getTokenDetails(interactive, write)).token;
}

export async function dropCachedToken(token: string): Promise<void> {
  try {
    await browser.identity.removeCachedAuthToken({ token });
  } catch {
    /* ignore */
  }
}

/** Revoke our access at Google and clear Chrome's token cache. */
export async function revokeAll(): Promise<void> {
  for (const write of [true, false]) {
    try {
      const token = await getToken(false, write);
      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `token=${encodeURIComponent(token)}`,
      });
      await dropCachedToken(token);
    } catch {
      /* not granted / already revoked */
    }
  }
  try {
    await browser.identity.clearAllCachedAuthTokens();
  } catch {
    /* older Chrome */
  }
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
