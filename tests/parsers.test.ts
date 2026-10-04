import { describe, expect, it } from 'vitest';
import { parseCsv, parseSubscriptionsCsv, parseWatchHistory } from '@/services/takeout';
import { parseLatestPublished } from '@/services/rss';
import { channelIdFromUrl, channelUrl, safeImageUrl, videoIdFromUrl } from '@/lib/youtube-urls';

const CH = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
const CH2 = 'UCsBjURrPoezykLs9EqgamOA';

describe('Takeout watch history', () => {
  it('parses watches and skips ads / removed videos', () => {
    const data = [
      {
        header: 'YouTube',
        title: 'Watched Something',
        titleUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        subtitles: [{ name: 'Google for Developers', url: `https://www.youtube.com/channel/${CH}` }],
        time: '2025-05-01T10:00:00.000Z',
      },
      {
        header: 'YouTube',
        titleUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
        subtitles: [{ name: 'Ad', url: `https://www.youtube.com/channel/${CH2}` }],
        details: [{ name: 'From Google Ads' }],
        time: '2025-05-01T10:00:00.000Z',
      },
      { header: 'YouTube', title: 'Watched a video that has been removed', time: '2025-05-01T10:00:00.000Z' },
      'garbage',
    ];
    const r = parseWatchHistory(data);
    expect(r.watches).toEqual([
      { videoId: 'dQw4w9WgXcQ', channelId: CH, channelTitle: 'Google for Developers', watchedAt: Date.parse('2025-05-01T10:00:00.000Z') },
    ]);
    expect(r.skipped).toBe(3);
  });

  it('rejects non-array input', () => {
    expect(() => parseWatchHistory({ foo: 1 })).toThrow(/watch-history/);
  });
});

describe('Takeout subscriptions.csv', () => {
  it('parses quoted fields, BOM, header and duplicates', () => {
    const csv = `﻿Channel Id,Channel Url,Channel Title\r\n${CH},http://www.youtube.com/channel/${CH},"Google, for ""Devs"""\r\n${CH2},x,Other\n${CH},x,Dup\n`;
    expect(parseSubscriptionsCsv(csv)).toEqual([
      { channelId: CH, title: 'Google, for "Devs"' },
      { channelId: CH2, title: 'Other' },
    ]);
  });
  it('throws on files with no channels', () => {
    expect(() => parseSubscriptionsCsv('a,b,c\n1,2,3')).toThrow();
  });
  it('csv splitter handles embedded newlines', () => {
    expect(parseCsv('a,"b\nc",d\ne,f,g')).toEqual([
      ['a', 'b\nc', 'd'],
      ['e', 'f', 'g'],
    ]);
  });
});

describe('RSS', () => {
  it('reads the first entry published date', () => {
    const xml = `<feed><published>2010-01-01T00:00:00+00:00</published><entry><id>1</id><published>2026-09-30T12:00:00+00:00</published></entry><entry><published>2026-01-01T00:00:00+00:00</published></entry></feed>`;
    expect(parseLatestPublished(xml)).toBe(Date.parse('2026-09-30T12:00:00+00:00'));
  });
  it('returns undefined for channels without uploads', () => {
    expect(parseLatestPublished('<feed><title>x</title></feed>')).toBeUndefined();
  });
});

describe('URL safety', () => {
  it('only allows Google image CDNs over https', () => {
    expect(safeImageUrl('https://yt3.ggpht.com/abc=s88')).toBe('https://yt3.ggpht.com/abc=s88');
    expect(safeImageUrl('https://i.ytimg.com/vi/x/default.jpg')).toBeTruthy();
    expect(safeImageUrl('http://yt3.ggpht.com/abc')).toBeUndefined();
    expect(safeImageUrl('https://evil.com/ggpht.com.png')).toBeUndefined();
    expect(safeImageUrl('javascript:alert(1)')).toBeUndefined();
  });
  it('builds channel links only from valid ids', () => {
    expect(channelUrl(CH)).toBe(`https://www.youtube.com/channel/${CH}`);
    expect(channelUrl('javascript:alert(1)')).toBe('https://www.youtube.com/');
  });
  it('extracts video ids', () => {
    expect(videoIdFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10')).toBe('dQw4w9WgXcQ');
    expect(videoIdFromUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(videoIdFromUrl('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(videoIdFromUrl('https://www.youtube.com/feed/subscriptions')).toBeUndefined();
    expect(videoIdFromUrl('https://evil.com/watch?v=dQw4w9WgXcQ')).toBeUndefined();
  });
  it('extracts channel ids', () => {
    expect(channelIdFromUrl(`https://www.youtube.com/channel/${CH}`)).toBe(CH);
    expect(channelIdFromUrl('https://www.youtube.com/@handle')).toBeUndefined();
  });
});
