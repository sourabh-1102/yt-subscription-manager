import { DAY_MS } from '@/config/constants';

export const dayKey = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/** YouTube quota resets at midnight Pacific Time. */
export function pacificDayKey(ts = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts));
}

/** Milliseconds until the next Pacific midnight (+5 min safety margin). */
export function msUntilQuotaReset(now = Date.now()): number {
  const today = pacificDayKey(now);
  // Step forward in 15-minute increments until the Pacific date changes — robust across DST.
  let t = now;
  while (pacificDayKey(t) === today) t += 15 * 60 * 1000;
  return t - now + 5 * 60 * 1000;
}

export function relativeTime(ts: number | undefined, now = Date.now()): string {
  if (!ts) return 'Never';
  const diff = now - ts;
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(diff / DAY_MS);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return `${months} mo ago`;
  const years = Math.floor(days / 365.25);
  return `${years} yr${years > 1 ? 's' : ''} ago`;
}

export const formatDate = (ts: number | undefined) =>
  ts ? new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
