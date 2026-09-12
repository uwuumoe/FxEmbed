import { describe, expect, test } from 'vitest';
import { buildBlueskyVideoUrl, buildSourceUrl, isAllowedSource, outputFormat, mosaicSourceUrls } from '../services/media-transcoder/src/policy';

describe('media replacement policy', () => {
  test('maps tweet_video animation paths to the fixed Twitter CDN', () => {
    expect(buildSourceUrl('/tweet_video/1234567890.mp4')).toBe('https://video.twimg.com/tweet_video/1234567890.mp4');
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
    expect(mosaicSourceUrls(['https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:abc/bafk1@jpeg', 'https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:def/bafk2@jpeg'])).toHaveLength(2);
    expect(() => mosaicSourceUrls(Array.from({ length: 5 }, (_, i) => `https://cdn.bsky.app/${i}`))).toThrow();
  });
  test('builds the exact public Bluesky DID/CID video route', () => {
    expect(buildBlueskyVideoUrl('https://pds-cache.fxbsky.app/', 'did:plc:abcdefghijklmnopqrst', 'bafybeigdyrzt5x')).toBe(
      'https://pds-cache.fxbsky.app/did:plc:abcdefghijklmnopqrst/bafybeigdyrzt5x'
    );
    expect(() => buildBlueskyVideoUrl('http://127.0.0.1', 'did:plc:abcdefghijklmnopqrst', 'bafybeigdyrzt5x')).toThrow();
  });
});
