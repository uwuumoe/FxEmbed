import { afterEach, expect, test, vi } from 'vitest';
import worker from '../src/worker';

afterEach(() => {
  vi.restoreAllMocks();
});

const testCtx = () => {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (p: Promise<unknown>) => pending.push(p),
      passThroughOnException: () => {}
    } as unknown as ExecutionContext,
    settle: () => Promise.all(pending)
  };
};

const mediaEnv = (handler: (request: Request) => Promise<Response>) => ({
  MEDIA_TRANSCODER_V2: {
    idFromName: () => 'test-transcoder',
    get: () => ({ fetch: handler })
  }
});

const okImage = () =>
  new Response('fake-bytes', {
    status: 200,
    headers: {
      'content-type': 'image/webp',
      'cache-control': 'public, max-age=86400, immutable'
    }
  });

test('identical media GETs reach the container once; repeat served from Workers cache', async () => {
  let calls = 0;
  const env = mediaEnv(async () => {
    calls++;
    return okImage();
  });
  const { ctx, settle } = testCtx();
  const url = 'https://gif.fxtwitter.com/tweet_video/cachetest123.webp';
  const headers = { 'User-Agent': 'Discordbot/2.0' };

  const first = await worker.fetch(new Request(url, { headers }), env as never, ctx);
  expect(first.status).toBe(200);
  expect(await first.text()).toBe('fake-bytes');
  await settle();

  const second = await worker.fetch(new Request(url, { headers }), env as never, ctx);
  expect(second.status).toBe(200);
  expect(await second.text()).toBe('fake-bytes');
  expect(calls).toBe(1);
});

test('mosaic output is stored in Workers cache and avoids repeated container compute', async () => {
  let calls = 0;
  const env = mediaEnv(async () => {
    calls++;
    return new Response('mosaic-bytes', {
      status: 200,
      headers: {
        'content-type': 'image/jpeg',
        'cache-control': 'public, max-age=86400, immutable'
      }
    });
  });
  const { ctx, settle } = testCtx();
  const url =
    'https://mosaic.fxtwitter.com/jpeg/1234567890/source-image-one/source-image-two';

  const first = await worker.fetch(new Request(url), env as never, ctx);
  expect(first.status).toBe(200);
  expect(await first.arrayBuffer()).toEqual(new TextEncoder().encode('mosaic-bytes').buffer);
  await settle();

  const second = await worker.fetch(new Request(url), env as never, ctx);
  expect(second.status).toBe(200);
  expect(await second.arrayBuffer()).toEqual(new TextEncoder().encode('mosaic-bytes').buffer);
  expect(calls).toBe(1);
});

test('range requests bypass the Workers media cache and are never stored', async () => {
  let calls = 0;
  const env = mediaEnv(async (request: Request) => {
    calls++;
    if (request.headers.has('range')) {
      return new Response('0123', {
        status: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-range': 'bytes 0-3/100',
          'accept-ranges': 'bytes'
        }
      });
    }
    return okImage();
  });
  const { ctx, settle } = testCtx();
  const url = 'https://video.fxtwitter.com/video?url=https%3A%2F%2Fvideo.twimg.com%2Ftest.mp4';

  const ranged = await worker.fetch(new Request(url, { headers: { Range: 'bytes=0-3' } }), env as never, ctx);
  expect(ranged.status).toBe(206);
  await settle();

  await worker.fetch(new Request(url), env as never, ctx);
  await settle();
  await worker.fetch(new Request(url), env as never, ctx);
  // 1 ranged passthrough + 1 plain miss; the repeat must not touch the container.
  expect(calls).toBe(2);
});

test('container errors are never served from or written to the Workers media cache', async () => {
  let calls = 0;
  const env = mediaEnv(async () => {
    calls++;
    return new Response('media unavailable', { status: 502 });
  });
  const { ctx, settle } = testCtx();
  const url = 'https://gif.fxtwitter.com/tweet_video/errortest456.gif';

  expect((await worker.fetch(new Request(url), env as never, ctx)).status).toBe(502);
  await settle();
  expect((await worker.fetch(new Request(url), env as never, ctx)).status).toBe(502);
  expect(calls).toBe(2);
});
