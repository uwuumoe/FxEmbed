import { afterEach, expect, test, vi } from 'vitest';
import { app } from '../src/worker';
import threadSingle from './fixtures/bluesky/thread-single.json';

afterEach(() => {
  vi.restoreAllMocks();
});

test('CatgirlX Bluesky host routes profile posts to the Bluesky embed realm', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('app.bsky.feed.getPostThread')) {
      return new Response(JSON.stringify(threadSingle), { status: 200 });
    }
    if (url.includes('app.bsky.actor.getProfiles')) {
      return new Response(JSON.stringify({ profiles: [] }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const response = await app.request(
    'https://bsky.catgirlx.com/profile/author.test/post/rkeymain',
    { headers: { 'User-Agent': 'Discordbot/2.0' } }
  );

  expect(response.status).toBe(200);
  expect(response.headers.get('location')).toBeNull();
  expect(await response.text()).toContain('Hello world');
});
