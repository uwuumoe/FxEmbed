import { afterEach, expect, test, vi } from 'vitest';
import { handle } from '../src/server.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

afterEach(() => vi.unstubAllGlobals());

test('PDS blobs have a month at the edge and one day in browsers', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('blob'))
  );
  const writeHead = vi.fn();
  const end = vi.fn();
  await handle(
    {
      method: 'GET',
      url: '/pds-cache?did=did:plc:abcdefghijklmnopqrst&cid=bafybeigdyrzt5x',
      headers: {}
    } as IncomingMessage,
    { writeHead, end } as unknown as ServerResponse
  );
  expect(writeHead).toHaveBeenCalledWith(
    200,
    expect.objectContaining({
      'cache-control': 'public, max-age=86400, s-maxage=2592000, immutable',
      'content-length': '4',
      'x-media-content-length': '4'
    })
  );
  expect(end).toHaveBeenCalledWith(Buffer.from('blob'));
});

test('generic video proxy retains a one hour TTL', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('video', { headers: { 'content-length': '5' } }))
  );
  const writeHead = vi.fn();
  await handle(
    {
      method: 'GET',
      url: '/video?url=https://video.twimg.com/test.mp4',
      headers: {}
    } as IncomingMessage,
    { writeHead, write: () => true, end: vi.fn() } as unknown as ServerResponse
  );
  expect(writeHead).toHaveBeenCalledWith(
    200,
    expect.objectContaining({
      'cache-control': 'public, max-age=3600',
      'content-length': '5',
      'x-media-content-length': '5'
    })
  );
});
