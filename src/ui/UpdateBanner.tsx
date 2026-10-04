import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { BUILD_ID } from '@/lib/build';
import { send } from './hooks';

/**
 * After a rebuild, extension pages load the new code on refresh but the service worker keeps
 * running the old build until the extension itself is reloaded. Detect that mismatch and offer a
 * one-click reload instead of failing later with confusing errors.
 */
export function UpdateBanner() {
  const [stale, setStale] = useState(false);
  useEffect(() => {
    void send<{ build: string }>({ type: 'meta/ping' }).then((r) => {
      setStale(!r.ok || r.data?.build !== BUILD_ID);
    });
  }, []);
  if (!stale) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 border-b border-warn/30 bg-warn/10 px-6 py-2.5 text-sm">
      <span>
        <b>The extension was updated.</b> Reload it to finish — some actions won’t work until then.
      </span>
      <button
        onClick={() => browser.runtime.reload()}
        className="rounded-lg bg-accent px-3 py-1 text-xs font-semibold text-accent-ink hover:bg-accent-strong"
      >
        Reload extension
      </button>
    </div>
  );
}
