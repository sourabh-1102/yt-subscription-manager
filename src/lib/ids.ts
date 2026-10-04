import { dayKey } from './time';

/** One watch per video per day. */
export const watchEventId = (videoId: string, ts: number) => `${videoId}:${dayKey(ts)}`;
