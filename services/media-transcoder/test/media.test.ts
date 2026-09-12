import { describe, expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { runMosaic } from '../src/server.js';
import { buildSourceUrl, isAllowedSource, outputFormat, mosaicSourceUrls } from '../src/policy.js';

const image = (color: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=8x8`,
      '-frames:v',
      '1',
      '-f',
      'mjpeg',
      'pipe:1'
    ]);
    const chunks: Buffer[] = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exited ${code}`)));
  });

describe('media replacement policy', () => {
  test('maps tweet_video animation paths to the fixed Twitter CDN', () => {
    expect(buildSourceUrl('/tweet_video/1234567890.mp4')).toBe(
      'https://video.twimg.com/tweet_video/1234567890.mp4'
    );
  });

  test('preserves the requested animated output extension', () => {
    expect(outputFormat('/tweet_video/123.webp')).toBe('webp');
    expect(outputFormat('/tweet_video/123.gif')).toBe('gif');
  });

  test('rejects unrestricted URL input and private hosts', () => {
    expect(isAllowedSource('https://video.twimg.com/tweet_video/a.mp4')).toBe(true);
    expect(isAllowedSource('https://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isAllowedSource('https://evil.example/a.mp4')).toBe(false);
    expect(isAllowedSource('file:///etc/passwd')).toBe(false);
  });

  test('builds bounded Bluesky mosaic sources only from blob URLs', () => {
    expect(
      mosaicSourceUrls([
        'https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:abc/bafk1@jpeg',
        'https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:def/bafk2@jpeg'
      ])
    ).toHaveLength(2);
    expect(() =>
      mosaicSourceUrls(Array.from({ length: 5 }, (_, i) => `https://cdn.bsky.app/${i}`))
    ).toThrow();
  });

  test('renders a single-image Bluesky mosaic', async () => {
    const output = await runMosaic([await image('red')], 'jpeg');
    expect(output.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(output.length).toBeGreaterThan(100);
  });

  test('renders every input in a multi-image Bluesky mosaic', async () => {
    const output = await runMosaic([await image('red'), await image('blue')], 'jpeg');
    expect(output.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(output.length).toBeGreaterThan(500);
  });
});
