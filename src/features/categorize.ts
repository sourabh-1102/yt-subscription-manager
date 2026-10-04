/**
 * Automatic categorization (pure, unit-tested).
 *
 * Signals, strongest first:
 *  1. Keywords in the channel title (also Hindi / Hinglish terms)
 *  2. YouTube's own topic classification (channels.topicDetails.topicCategories)
 *  3. Keywords in the channel description / channel keywords
 *
 * Output is a SUGGESTION mapped onto the user's local categories — the user reviews it, and it
 * never changes anything on YouTube. No scores or metrics are shown or stored.
 */

export interface CategoryDef {
  key: string;
  name: string;
  emoji: string;
  /** Matched as whole words (latin) or substrings (non-latin), case-insensitive. */
  words: string[];
  /** Wikipedia topic slugs from topicDetails.topicCategories. */
  topics: string[];
}

export const CATEGORY_DEFS: CategoryDef[] = [
  {
    key: 'study',
    name: 'Study',
    emoji: '📚',
    words: [
      'exam', 'exams', 'ssc', 'upsc', 'neet', 'jee', 'gate', 'cbse', 'icse', 'ncert', 'banking', 'ibps', 'sbi po', 'railway', 'rrb',
      'class 10', 'class 11', 'class 12', 'board exam', 'lecture', 'lectures', 'coaching', 'academy', 'classes', 'education', 'educational',
      'study', 'studies', 'students', 'teacher', 'ma\'am', 'tuition', 'preparation', 'syllabus', 'mock test', 'current affairs',
      'gk', 'adda247', 'unacademy', 'physics wallah', 'pw', 'vedantu', 'byju', 'padhai', 'पढ़ाई', 'परीक्षा', 'शिक्षा', 'कक्षा',
      'gate cse', 'govt job', 'sarkari', 'सरकारी', 'regulatory bodies', 'skills', 'upskill', 'interview prep',
    ],
    topics: [],
  },
  {
    key: 'programming',
    name: 'Programming',
    emoji: '💻',
    words: [
      'programming', 'programmer', 'coding', 'coder', 'code', 'developer', 'developers', 'dev', 'software', 'javascript', 'typescript', 'python',
      'java', 'c++', 'react', 'nextjs', 'next.js', 'node', 'nodejs', 'web development', 'web dev', 'frontend', 'backend', 'full stack',
      'fullstack', 'dsa', 'leetcode', 'algorithms', 'data structures', 'devops', 'linux', 'git', 'github', 'rust', 'golang', 'kubernetes',
      'docker', 'aws', 'android development', 'flutter', 'kotlin', 'swift', 'sql', 'database', 'cs50', 'computer science', 'fireship',
      'freecodecamp', 'hackathon', 'open source',
    ],
    topics: [],
  },
  {
    key: 'ai',
    name: 'AI',
    emoji: '🤖',
    words: [
      'ai', 'a.i.', 'artificial intelligence', 'machine learning', 'deep learning', 'ml', 'llm', 'llms', 'chatgpt', 'gpt', 'openai', 'claude',
      'gemini', 'midjourney', 'stable diffusion', 'neural network', 'data science', 'generative ai', 'prompt engineering', 'ai tools', 'agents',
    ],
    topics: [],
  },
  {
    key: 'tech',
    name: 'Tech',
    emoji: '📱',
    words: [
      'tech', 'technology', 'gadget', 'gadgets', 'smartphone', 'smartphones', 'unboxing', 'review', 'reviews', 'iphone', 'android', 'laptop',
      'pc build', 'hardware', 'apple', 'samsung', 'tech news', 'tech tips', 'technical', 'टेक', 'mobile',
    ],
    topics: ['Technology'],
  },
  {
    key: 'science',
    name: 'Science',
    emoji: '🔬',
    words: [
      'science', 'physics', 'chemistry', 'biology', 'space', 'astronomy', 'nasa', 'universe', 'experiment', 'experiments', 'math', 'maths',
      'mathematics', 'engineering', 'scientist', 'documentary', 'explained', 'history', 'geography', 'facts', 'knowledge', 'विज्ञान',
    ],
    topics: ['Knowledge'],
  },
  {
    key: 'finance',
    name: 'Finance',
    emoji: '💰',
    words: [
      'finance', 'financial', 'money', 'stock', 'stocks', 'stock market', 'share market', 'trading', 'trader', 'investing', 'investment',
      'investor', 'mutual fund', 'mutual funds', 'sip', 'crypto', 'bitcoin', 'personal finance', 'business', 'startup', 'startups',
      'entrepreneur', 'marketing', 'economy', 'economics', 'tax', 'income', 'शेयर', 'पैसा',
    ],
    topics: ['Business'],
  },
  {
    key: 'news',
    name: 'News',
    emoji: '📰',
    words: [
      'news', 'breaking', 'headlines', 'live news', 'samachar', 'politics', 'political', 'election', 'debate', 'journalist', 'journalism',
      'reporter', 'current events', 'समाचार', 'खबर', 'न्यूज़', 'aaj tak', 'ndtv', 'times now', 'wion', 'bbc',
    ],
    topics: ['Politics', 'Military', 'Society'],
  },
  {
    key: 'music',
    name: 'Music',
    emoji: '🎵',
    words: [
      'music', 'song', 'songs', 'singer', 'singing', 'lyrics', 'lyrical', 'official music', 'remix', 'lofi', 'lo-fi', 'beats', 'album',
      'band', 'records', 'dj', 'rapper', 'rap', 'hip hop', 'cover', 'covers', 'bollywood songs', 'punjabi', 'गाना', 'गाने', 'संगीत', 'gaana',
      'vevo', 't-series', 'saregama', 'zee music',
    ],
    topics: [
      'Music', 'Christian_music', 'Classical_music', 'Country_music', 'Electronic_music', 'Hip_hop_music', 'Independent_music',
      'Jazz', 'Music_of_Asia', 'Music_of_Latin_America', 'Pop_music', 'Reggae', 'Rhythm_and_blues', 'Rock_music', 'Soul_music',
    ],
  },
  {
    key: 'gaming',
    name: 'Gaming',
    emoji: '🎮',
    words: [
      'gaming', 'gamer', 'gamers', 'gameplay', 'games', 'game', 'minecraft', 'gta', 'bgmi', 'pubg', 'free fire', 'freefire', 'valorant',
      'fortnite', 'roblox', 'call of duty', 'cod', 'esports', 'walkthrough', 'lets play', "let's play", 'speedrun', 'twitch', 'playstation',
      'xbox', 'nintendo', 'steam',
    ],
    topics: [
      'Video_game_culture', 'Action_game', 'Action-adventure_game', 'Casual_game', 'Music_video_game', 'Puzzle_video_game',
      'Racing_video_game', 'Role-playing_video_game', 'Simulation_video_game', 'Sports_game', 'Strategy_video_game',
    ],
  },
  {
    key: 'sports',
    name: 'Sports',
    emoji: '⚽',
    words: [
      'sports', 'sport', 'cricket', 'football', 'soccer', 'ipl', 'fifa', 'nba', 'basketball', 'tennis', 'f1', 'formula 1', 'wwe', 'ufc',
      'boxing', 'chess', 'kabaddi', 'badminton', 'highlights', 'क्रिकेट',
    ],
    topics: [
      'Sport', 'American_football', 'Association_football', 'Baseball', 'Basketball', 'Boxing', 'Cricket', 'Golf', 'Ice_hockey',
      'Mixed_martial_arts', 'Motorsport', 'Professional_wrestling', 'Tennis', 'Volleyball',
    ],
  },
  {
    key: 'fitness',
    name: 'Health & Fitness',
    emoji: '🏋️',
    words: [
      'fitness', 'workout', 'workouts', 'gym', 'bodybuilding', 'yoga', 'health', 'healthy', 'diet', 'nutrition', 'doctor', 'medical',
      'weight loss', 'exercise', 'meditation', 'mental health', 'physio', 'योग', 'स्वास्थ्य',
    ],
    topics: ['Physical_fitness', 'Health'],
  },
  {
    key: 'food',
    name: 'Food',
    emoji: '🍳',
    words: ['food', 'recipe', 'recipes', 'cooking', 'cook', 'kitchen', 'chef', 'baking', 'street food', 'foodie', 'khana', 'रेसिपी', 'खाना'],
    topics: ['Food'],
  },
  {
    key: 'travel',
    name: 'Travel & Vlogs',
    emoji: '✈️',
    words: ['travel', 'travels', 'traveling', 'travelling', 'traveller', 'traveler', 'tour', 'trip', 'vlog', 'vlogs', 'vlogger', 'vlogging', 'backpacking', 'nomad', 'yatra', 'यात्रा'],
    topics: ['Tourism'],
  },
  {
    key: 'lifestyle',
    name: 'Lifestyle',
    emoji: '✨',
    words: [
      'lifestyle', 'fashion', 'beauty', 'makeup', 'skincare', 'style', 'diy', 'crafts', 'home decor', 'family', 'couple', 'motivation',
      'motivational', 'self improvement', 'productivity', 'podcast', 'podcasts', 'parenting', 'cars', 'bikes', 'automobile', 'pets',
    ],
    topics: ['Lifestyle_(sociology)', 'Fashion', 'Physical_attractiveness', 'Hobby', 'Pet', 'Vehicle'],
  },
  {
    key: 'devotional',
    name: 'Devotional',
    emoji: '🙏',
    words: ['bhajan', 'bhakti', 'aarti', 'katha', 'kirtan', 'devotional', 'spiritual', 'mantra', 'gurbani', 'islamic', 'gospel', 'भजन', 'आरती', 'कथा', 'भक्ति'],
    topics: ['Religion'],
  },
  {
    key: 'entertainment',
    name: 'Entertainment',
    emoji: '🎬',
    words: [
      'entertainment', 'comedy', 'funny', 'prank', 'pranks', 'roast', 'meme', 'memes', 'movie', 'movies', 'film', 'films', 'web series',
      'shorts', 'reaction', 'reacts', 'trailer', 'bollywood', 'hollywood', 'tv', 'serial', 'drama', 'stand up', 'standup', 'sketch',
      'animation', 'cartoon', 'kids', 'मनोरंजन', 'कॉमेडी',
    ],
    topics: ['Entertainment', 'Film', 'Humour', 'Performing_arts', 'Television_program'],
  },
];

/** Used when nothing matches, so every channel gets a category. */
export const FALLBACK_DEF: CategoryDef = { key: 'other', name: 'Other', emoji: '🗂️', words: [], topics: [] };

export interface ChannelSignals {
  title: string;
  description?: string;
  keywords?: string;
  /** Topic URLs or slugs, e.g. https://en.wikipedia.org/wiki/Music */
  topics?: string[];
}

export interface CategorySuggestion {
  /** Category keys, best first (1 or 2). */
  keys: string[];
  /** Human explanation (e.g. "title: coding · YouTube topic: Technology"). */
  reason: string;
}

const isLatin = (w: string) => /^[\x00-\x7f]+$/.test(w);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Precompiled matchers per category: latin words need word boundaries ("ai" must not match "said"). */
const MATCHERS = CATEGORY_DEFS.map((def) => {
  const latin = def.words.filter(isLatin);
  const other = def.words.filter((w) => !isLatin(w)).map((w) => w.toLowerCase());
  const re = latin.length ? new RegExp(`(?:^|[^a-z0-9])(${latin.map(escapeRe).join('|')})(?=$|[^a-z0-9])`, 'gi') : null;
  return { def, re, other, topics: new Set(def.topics.map((t) => t.toLowerCase())) };
});

function matchWords(text: string, m: (typeof MATCHERS)[number]): string[] {
  if (!text) return [];
  const found = new Set<string>();
  const lower = text.toLowerCase();
  if (m.re) for (const hit of lower.matchAll(m.re)) if (hit[1]) found.add(hit[1]);
  for (const w of m.other) if (lower.includes(w)) found.add(w);
  return [...found];
}

export const topicSlug = (t: string) => decodeURIComponent(t.split('/wiki/').pop() ?? t);

const WEIGHT = { title: 3, topic: 2.5, description: 1, keywords: 1 } as const;

export function classifyChannel(s: ChannelSignals): CategorySuggestion {
  const topicSlugs = (s.topics ?? []).map((t) => topicSlug(t).toLowerCase());
  const text = { description: (s.description ?? '').slice(0, 3000), keywords: s.keywords ?? '' };
  const scored = MATCHERS.map((m) => {
    const titleHits = matchWords(s.title, m);
    const topicHits = topicSlugs.filter((t) => m.topics.has(t));
    const descHits = matchWords(text.description, m);
    const kwHits = matchWords(text.keywords, m);
    const score =
      titleHits.length * WEIGHT.title +
      topicHits.length * WEIGHT.topic +
      Math.min(descHits.length, 4) * WEIGHT.description +
      Math.min(kwHits.length, 4) * WEIGHT.keywords;
    const why: string[] = [];
    if (titleHits.length) why.push(`name: ${titleHits.slice(0, 2).join(', ')}`);
    if (topicHits.length) why.push(`YouTube topic: ${topicHits.map((t) => t.replace(/_/g, ' ')).join(', ')}`);
    if (descHits.length || kwHits.length) why.push(`about: ${[...new Set([...descHits, ...kwHits])].slice(0, 3).join(', ')}`);
    return { key: m.def.key, score, why: why.join(' · ') };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return { keys: [FALLBACK_DEF.key], reason: 'No clear signal' };
  const [first, second] = scored;
  const keys = [first!.key];
  // A second category only when it's nearly as strong (e.g. AI + Programming).
  if (second && second.score >= 3 && second.score >= first!.score * 0.55) keys.push(second.key);
  return { keys, reason: first!.why };
}

export const defByKey = (key: string): CategoryDef =>
  CATEGORY_DEFS.find((d) => d.key === key) ?? FALLBACK_DEF;
