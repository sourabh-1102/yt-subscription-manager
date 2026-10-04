import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthState } from '@/lib/prefs';

const m = vi.hoisted(() => ({
  getTokenDetails: vi.fn(),
  getMyChannel: vi.fn(),
  syncSubscriptions: vi.fn(),
}));

vi.mock('@/services/auth', async (orig) => {
  const real = await orig<typeof import('@/services/auth')>();
  return { ...real, getTokenDetails: m.getTokenDetails, revokeAll: vi.fn(async () => undefined) };
});
vi.mock('@/services/youtube-api', async (orig) => {
  const real = await orig<typeof import('@/services/youtube-api')>();
  return { ...real, getMyChannel: m.getMyChannel };
});
vi.mock('@/services/sync', async (orig) => {
  const real = await orig<typeof import('@/services/sync')>();
  return { ...real, syncSubscriptions: m.syncSubscriptions };
});

const { signIn } = await import('@/services/signin');
const { withTimeout, SCOPE_READ, SCOPE_WRITE } = await import('@/services/auth');

const ME = { id: 'UC_x5XG1OV2P6uZZ5FSM9Ttw', snippet: { title: 'My Channel' } };

beforeEach(() => {
  m.getTokenDetails.mockReset().mockResolvedValue({ token: 't', grantedScopes: [SCOPE_READ] });
  m.getMyChannel.mockReset().mockResolvedValue(ME);
  m.syncSubscriptions.mockReset().mockResolvedValue({ count: 42 });
});

describe('signIn flow', () => {
  it('calls getAuthToken exactly once (no hanging write-scope probe) and saves connected state', async () => {
    expect(await signIn()).toEqual({ count: 42 });
    expect(m.getTokenDetails).toHaveBeenCalledTimes(1);
    expect(m.getTokenDetails).toHaveBeenCalledWith(true);
    const a = await getAuthState();
    expect(a).toMatchObject({ signedIn: true, accountChannelId: ME.id, accountTitle: 'My Channel', hasWriteScope: false });
  });

  it('marks the write scope from grantedScopes', async () => {
    m.getTokenDetails.mockResolvedValue({ token: 't', grantedScopes: [SCOPE_READ, SCOPE_WRITE] });
    await signIn();
    expect((await getAuthState()).hasWriteScope).toBe(true);
  });

  it('is already "connected" while the sync is still running', async () => {
    let finishSync!: (v: { count: number }) => void;
    m.syncSubscriptions.mockReturnValue(new Promise((r) => (finishSync = r)));
    const p = signIn();
    await vi.waitFor(async () => expect((await getAuthState()).signedIn).toBe(true));
    finishSync({ count: 3 });
    expect(await p).toEqual({ count: 3 });
  });

  it('stays connected if the first sync fails', async () => {
    m.syncSubscriptions.mockRejectedValue(new Error('quotaExceeded'));
    expect(await signIn()).toEqual({ count: 0 });
    expect((await getAuthState()).signedIn).toBe(true);
  });

  it('reports a YouTube API failure after Google sign-in clearly', async () => {
    m.getMyChannel.mockRejectedValue(new Error('YouTube Data API v3 has not been used in project 123'));
    await expect(signIn()).rejects.toThrow(/YouTube API request failed/);
    expect((await getAuthState()).signedIn).toBe(false);
  });

  it('rejects accounts without a YouTube channel', async () => {
    m.getMyChannel.mockResolvedValue(undefined);
    await expect(signIn()).rejects.toThrow(/no YouTube channel/);
  });

  it('propagates a cancelled/failed getAuthToken', async () => {
    m.getTokenDetails.mockRejectedValue(new Error('Sign-in was cancelled or failed: The user did not approve access.'));
    await expect(signIn()).rejects.toThrow(/did not approve/);
    expect(m.getMyChannel).not.toHaveBeenCalled();
  });
});

describe('withTimeout', () => {
  it('turns a never-resolving getAuthToken into an error', async () => {
    await expect(withTimeout(new Promise(() => undefined), 20, 'chrome.identity.getAuthToken')).rejects.toThrow(/did not respond/);
  });
  it('passes through results', async () => {
    expect(await withTimeout(Promise.resolve(1), 1000, 'x')).toBe(1);
  });
});
