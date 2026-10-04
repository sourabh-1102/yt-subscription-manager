import 'fake-indexeddb/auto';
import { beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { db } from '@/db/db';

beforeEach(async () => {
  fakeBrowser.reset();
  await db.open();
  await Promise.all(db.tables.map((t) => t.clear()));
});
