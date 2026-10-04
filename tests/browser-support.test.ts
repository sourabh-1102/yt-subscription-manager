import { describe, expect, it } from 'vitest';
import { detectBrowserSupport } from '@/lib/browser-support';

const b = (...names: string[]) => names.map((brand) => ({ brand, version: '130' }));

describe('Google sign-in browser support', () => {
  it('allows genuine Google Chrome', () => {
    expect(detectBrowserSupport(b('Google Chrome', 'Chromium', 'Not?A_Brand'))).toEqual({ supported: true, browser: 'Google Chrome' });
  });
  it('blocks Brave (brand or navigator.brave)', () => {
    expect(detectBrowserSupport(b('Brave', 'Chromium', 'Not?A_Brand')).supported).toBe(false);
    expect(detectBrowserSupport(b('Chromium', 'Not?A_Brand'), { isBrave: true })).toEqual({ supported: false, browser: 'Brave' });
  });
  it('blocks Edge, Opera and plain Chromium', () => {
    expect(detectBrowserSupport(b('Microsoft Edge', 'Chromium', 'Not?A_Brand'))).toEqual({ supported: false, browser: 'Microsoft Edge' });
    expect(detectBrowserSupport(b('Opera', 'Chromium'))).toEqual({ supported: false, browser: 'Opera' });
    expect(detectBrowserSupport(b('Chromium', 'Not?A_Brand'))).toEqual({ supported: false, browser: 'Chromium' });
  });
  it('falls back to the user agent when client hints are missing', () => {
    expect(detectBrowserSupport(undefined, { userAgent: 'Mozilla/5.0 Chrome/130.0 Safari/537.36 Edg/130.0' }).supported).toBe(false);
    expect(detectBrowserSupport(undefined, { userAgent: 'Mozilla/5.0 Chrome/130.0 Safari/537.36' }).supported).toBe(true);
  });
});
