# FxEmbed media replacement service

This container provides the media URLs configured by `GIF_TRANSCODE_DOMAIN_LIST`,
`VIDEO_TRANSCODE_DOMAIN_LIST`, and `VIDEO_TRANSCODE_BSKY_DOMAIN_LIST`.

- `GET /tweet_video/<id>.webp` or `.gif` fetches only the matching fixed
  `video.twimg.com/tweet_video/<id>.mp4` path and returns an animated output.
- `GET /mosaic?url=...&url=...` combines one to four allowlisted Twitter/Bluesky
  image URLs (`format=jpeg|webp`).
- `GET /video?url=...` streams allowlisted upstream media without buffering.
- `GET /pds-cache?url=...` fetches and caches successful Bluesky PDS blobs.

All URL fetches require HTTPS and a public, provider allowlist host. Inputs,
outputs, mosaic count, and cache entries are bounded; failures are never cached.
The image/video work is performed by FFmpeg (`libwebp_anim` for animated WebP).

Local verification:

```sh
NODE_ENV=test npx tsx integration-test.ts
npx tsc -p tsconfig.json --noEmit
```
