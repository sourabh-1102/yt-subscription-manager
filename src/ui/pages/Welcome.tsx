import { useState } from 'react';
import { BRAND } from '@/config/brand';
import { setPrefs } from '@/lib/prefs';
import { loadDemoData } from '@/services/demo';
import { navigate, send, useAuth } from '../hooks';
import { Button, Card, Notice } from '../primitives';
import { currentBrowserSupport, unsupportedBrowserMessage } from '@/lib/browser-support';

const browserSupport = currentBrowserSupport();

/** First-run: explain what is stored, ask for tracking consent explicitly, pick a data source. */
export function WelcomePage() {
  const auth = useAuth();
  const [tracking, setTracking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = async (then: 'connect' | 'demo' | 'skip') => {
    setBusy(true);
    setError(null);
    try {
      await setPrefs({ onboardingDone: true, trackingEnabled: tracking });
      if (then === 'connect') {
        const r = await send({ type: 'auth/signIn' });
        if (!r.ok) throw new Error(r.error);
      }
      if (then === 'demo') await loadDemoData(1000);
      navigate('/overview');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Card className="w-full max-w-xl p-7">
        <div className="text-3xl" aria-hidden>
          ▤
        </div>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Welcome to {BRAND.name}</h1>
        <p className="mt-1 text-ink-2">A private command center for your YouTube subscriptions. Free, no ads, no account with us.</p>

        <ul className="mt-5 space-y-2 text-sm">
          <li>🔒 Everything stays in this browser. No servers, no analytics SDKs, nothing sold.</li>
          <li>🔑 Google sign-in is read-only. Changing subscriptions asks again, and only after you review and confirm.</li>
          <li>🗂️ Categories, favorites and notes never change your YouTube account.</li>
        </ul>

        <div className="mt-6 rounded-xl border border-line p-4">
          <label className="flex items-start gap-3">
            <input type="checkbox" checked={tracking} onChange={(e) => setTracking(e.target.checked)} className="mt-1 h-4 w-4 accent-[var(--color-accent)]" />
            <span className="text-sm">
              <b>Turn on watch tracking (optional)</b>
              <span className="mt-0.5 block text-ink-2">
                To show which subscriptions you actually watch, the extension records the <i>video ID, channel ID and time</i> of videos you play on
                youtube.com for at least 30 seconds. It never records titles, searches, comments or other websites, never runs in incognito, and
                you can pause it or delete it anytime. YouTube’s API has no watch history, so analytics start today (or import your Google Takeout
                history later).
              </span>
            </span>
          </label>
        </div>

        {error && (
          <div className="mt-4">
            <Notice tone="danger">{error}</Notice>
          </div>
        )}

        <div className="mt-6 flex flex-wrap gap-2">
          <Button variant="primary" disabled={busy || !auth.clientIdConfigured || !browserSupport.supported} onClick={() => finish('connect')}>
            Connect YouTube account
          </Button>
          <Button disabled={busy} onClick={() => finish('demo')}>
            Explore with demo data
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => finish('skip')}>
            Skip for now
          </Button>
        </div>
        {!browserSupport.supported && <p className="mt-3 text-xs text-warn">{unsupportedBrowserMessage(browserSupport.browser)}</p>}
        {!auth.clientIdConfigured && (
          <p className="mt-3 text-xs text-ink-3">Google sign-in isn’t configured in this build. You can still import Google Takeout files in Settings.</p>
        )}
      </Card>
    </div>
  );
}
