import { describe, expect, it } from 'vitest';
import { classifyChannel, topicSlug } from '@/features/categorize';
import { applyCategorization } from '@/db/repo';
import { db } from '@/db/db';

const W = (s: string) => `https://en.wikipedia.org/wiki/${s}`;

describe('classifyChannel', () => {
  it.each([
    [{ title: 'Adda247 Regulatory Bodies & SO' }, 'study'],
    [{ title: 'Adda247 Skills' }, 'study'],
    [{ title: 'Physics Wallah - Alakh Pandey' }, 'study'],
    [{ title: 'Fireship', description: 'High-intensity code tutorials for web developers. JavaScript, TypeScript, React.' }, 'programming'],
    [{ title: 'Two Minute Papers', description: 'Artificial intelligence and machine learning research explained.' }, 'ai'],
    [{ title: 'T-Series' }, 'music'],
    [{ title: 'Some Channel', topics: [W('Video_game_culture'), W('Action_game')] }, 'gaming'],
    [{ title: 'Kabita’s Kitchen', description: 'Easy Indian recipes' }, 'food'],
    [{ title: 'Aaj Tak' }, 'news'],
    [{ title: 'Hanuman Bhajan Sangrah' }, 'devotional'],
    [{ title: 'Marques Brownlee', description: 'Quality tech videos. Smartphone reviews.', topics: [W('Technology')] }, 'tech'],
    [{ title: 'Random Person', topics: [W('Lifestyle_(sociology)')] }, 'lifestyle'],
  ])('%o → %s', (signals, key) => {
    expect(classifyChannel(signals).keys[0]).toBe(key);
  });

  it('uses whole words — "ai" does not match "said" or "Aaru"', () => {
    expect(classifyChannel({ title: 'He said hello' }).keys).toEqual(['other']);
    expect(classifyChannel({ title: '@Aaru Vibes Official' }).keys[0]).not.toBe('ai');
  });

  it('matches Hindi keywords', () => {
    expect(classifyChannel({ title: 'भजन संध्या' }).keys[0]).toBe('devotional');
  });

  it('can suggest two strong categories', () => {
    const r = classifyChannel({ title: 'AI coding with Python', description: 'machine learning and programming tutorials' });
    expect(r.keys).toEqual(expect.arrayContaining(['ai', 'programming']));
  });

  it('falls back to Other when nothing matches', () => {
    expect(classifyChannel({ title: 'Alok' })).toEqual({ keys: ['other'], reason: 'No clear signal' });
  });

  it('parses topic URLs', () => {
    expect(topicSlug(W('Lifestyle_(sociology)'))).toBe('Lifestyle_(sociology)');
  });
});

describe('applyCategorization', () => {
  it('reuses existing categories by name and creates missing ones', async () => {
    await db.tags.put({ id: 'mine', name: 'study', emoji: '📖', order: 1 });
    const r = await applyCategorization([
      { channelId: 'UC_x5XG1OV2P6uZZ5FSM9Ttw', keys: ['study'] },
      { channelId: 'UCsBjURrPoezykLs9EqgamOA', keys: ['music', 'entertainment'] },
    ]);
    expect(r).toEqual({ assigned: 2, created: 2 });
    expect(await db.channelTags.get(['UC_x5XG1OV2P6uZZ5FSM9Ttw', 'mine'])).toBeTruthy();
    expect(await db.tags.count()).toBe(3);
    expect(await db.channelTags.where('channelId').equals('UCsBjURrPoezykLs9EqgamOA').count()).toBe(2);
  });
});
