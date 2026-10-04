import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/oauth-config', () => ({ isClientIdConfigured: () => true }));
vi.mock('@/lib/browser-support', async (orig) => ({
  ...(await orig<typeof import('@/lib/browser-support')>()),
  currentBrowserSupport: () => ({ supported: true, browser: 'Google Chrome' }),
}));

const { getTokenDetails, authTiming, SCOPE_READ } = await import('@/services/auth');

type Details = { interactive: boolean; scopes: string[] };
let getAuthToken: ReturnType<typeof vi.fn>;
let runtime: { lastError?: { message: string }; getPlatformInfo: () => Promise<unknown> };

beforeEach(() => {
  authTiming.silentMs = 50;
  authTiming.interactiveMs = 80;
  authTiming.heartbeatMs = 20;
  runtime = { getPlatformInfo: vi.fn(async () => ({})) };
  getAuthToken = vi.fn();
  vi.stubGlobal('chrome', { identity: { getAuthToken }, runtime });
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getAuthToken wrapper', () => {
  it('uses the MV3 promise form and returns token + grantedScopes', async () => {
    getAuthToken.mockImplementation(async (_d: Details) => ({ token: 'tok', grantedScopes: [SCOPE_READ] }));
    const r = await getTokenDetails(true);
    expect(r).toEqual({ token: 'tok', grantedScopes: [SCOPE_READ] });
    // silent first; succeeded, so no interactive prompt
    expect(getAuthToken).toHaveBeenCalledTimes(1);
    expect(getAuthToken.mock.calls[0]![0]).toEqual({ interactive: false, scopes: [SCOPE_READ] });
  });

  it('falls back to interactive when the silent call is rejected', async () => {
    getAuthToken.mockImplementation(async (d: Details) => {
      if (!d.interactive) throw new Error('OAuth2 not granted or revoked.');
      return { token: 'tok', grantedScopes: [SCOPE_READ] };
    });
    expect((await getTokenDetails(true)).token).toBe('tok');
    expect(getAuthToken.mock.calls.map((c) => (c[0] as Details).interactive)).toEqual([false, true]);
  });

  it('supports the legacy callback form and reads runtime.lastError', async () => {
    getAuthToken.mockImplementation((d: Details, cb?: (a?: unknown, b?: unknown) => void) => {
      if (!cb) return undefined; // no promise support
      if (!d.interactive) {
        runtime.lastError = { message: 'The user is not signed in.' };
        cb(undefined);
        runtime.lastError = undefined;
      } else cb('tok2', [SCOPE_READ]);
      return undefined;
    });
    expect(await getTokenDetails(true)).toEqual({ token: 'tok2', grantedScopes: [SCOPE_READ] });
  });

  it('turns a never-completing interactive call into a concrete, actionable error', async () => {
    getAuthToken.mockImplementation(async (d: Details) => {
      if (!d.interactive) throw new Error('The user is not signed in.');
      return new Promise(() => undefined); // Chrome never answers
    });
    await expect(getTokenDetails(true)).rejects.toThrow(/signed in to Chrome itself[\s\S]*The user is not signed in/);
    expect(runtime.getPlatformInfo).toHaveBeenCalled(); // heartbeat kept the worker busy
  });

  it('reports a missing identity API instead of hanging', async () => {
    vi.stubGlobal('chrome', { runtime });
    await expect(getTokenDetails(false)).rejects.toThrow(/unavailable/);
  });

  it('a synchronous throw is surfaced', async () => {
    getAuthToken.mockImplementation(() => {
      throw new Error('Invalid OAuth2 Client ID.');
    });
    await expect(getTokenDetails(true)).rejects.toThrow(/Invalid OAuth2 Client ID/);
  });

  it('never logs the token', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    getAuthToken.mockImplementation(async () => ({ token: 'SECRET-TOKEN-VALUE', grantedScopes: [SCOPE_READ] }));
    await getTokenDetails(true);
    expect(JSON.stringify(info.mock.calls)).not.toContain('SECRET-TOKEN-VALUE');
  });
});
