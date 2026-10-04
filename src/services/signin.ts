import { db } from '@/db/db';
import { getAuthState, setAuthState } from '@/lib/prefs';
import { authLog, errMsg, getTokenDetails, revokeAll, SCOPE_WRITE } from './auth';
import { getMyChannel } from './youtube-api';
import { syncSubscriptions } from './sync';

export class SignInError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
  }
}

/**
 * Connect flow (runs in the service worker):
 *   interactive getAuthToken → channels.list(mine) → persist "connected" → subscription sync.
 *
 * The connected state is saved as soon as Google and the API have answered, BEFORE the sync,
 * so the UI flips to "Connected" even if the sync is slow or fails. Whether the write scope is
 * granted comes from the token's grantedScopes — no second getAuthToken probe.
 */
export async function signIn(): Promise<{ count: number }> {
  authLog('signIn: start');
  const { grantedScopes } = await getTokenDetails(true);

  let me: Awaited<ReturnType<typeof getMyChannel>>;
  try {
    me = await getMyChannel();
    authLog('signIn: channels.list(mine) ok', { hasChannel: !!me });
  } catch (e) {
    authLog('signIn: channels.list(mine) failed', { error: errMsg(e) });
    throw new SignInError(`Signed in to Google, but YouTube API request failed: ${errMsg(e)}`, 'api-failed');
  }
  if (!me) {
    throw new SignInError(
      'This Google account has no YouTube channel. Create one at youtube.com (or pick the account that owns your channel) and try again.',
      'no-channel',
    );
  }

  const prev = await getAuthState();
  if (prev.accountChannelId && prev.accountChannelId !== me.id) {
    // Data in this browser belongs to a different YouTube account — don't mix it.
    const hasData = (await db.channels.where('source').equals('api').count()) > 0;
    if (hasData) {
      await revokeAll();
      throw new SignInError(
        `This browser holds data for another YouTube account (${prev.accountTitle ?? 'unknown'}). Export it, then use Settings → Reset all data before connecting a different account.`,
        'account-mismatch',
      );
    }
  }

  await setAuthState({
    signedIn: true,
    accountChannelId: me.id,
    accountTitle: me.snippet?.title,
    hasWriteScope: grantedScopes.includes(SCOPE_WRITE),
    clientIdConfigured: true,
  });
  authLog('signIn: connected state saved', { signedIn: true });

  try {
    const r = await syncSubscriptions();
    authLog('signIn: sync done', { count: r.count });
    return r;
  } catch (e) {
    // Still connected; the error is shown in Settings (lastSyncError) and the daily alarm retries.
    authLog('signIn: sync failed', { error: errMsg(e) });
    return { count: 0 };
  }
}
