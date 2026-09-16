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
GIF conversion streams FFmpeg's Y4M output to gifski 1.34.0. Animated WebP uses
FFmpeg's `libwebp_anim`. Both use encoder defaults: no FPS, scale, duration,
or quality overrides. WebP explicitly uses `-loop 0` for infinite looping; GIF
loops indefinitely by default. gifski may resize large inputs under its own defaults.
The only GIF decoder pixel-format flag selects `yuv444p`, required for Y4M to
accept RGB/paletted inputs without chroma subsampling. Commands are equivalent to:

```sh
ffmpeg -i input.mp4 -pix_fmt yuv444p -f yuv4mpegpipe - | gifski -o - -
ffmpeg -i input.mp4 -c:v libwebp_anim -loop 0 -f webp output.webp
```

The 32 MiB input / 64 MiB output limits, 45-second processing timeout, and
single-job concurrency remain. GIF output is bounded while streaming; WebP size
is checked after encoding (as before). Errors/timeouts stop both GIF processes.
The Dockerfile builds gifski from its pinned crate with locked dependencies for
the target architecture; its Rust build tools are not included in the final image.

gifski is AGPL-3.0-or-later; source and license are available at
https://github.com/ImageOptim/gifski/tree/1.34.0. It runs as a separate CLI process.

Local verification requires FFmpeg, gifski 1.34.0, Node, and Python with Pillow:

```sh
NODE_ENV=test npm test
NODE_ENV=test npx tsx integration-test.ts
npx tsc -p tsconfig.json --noEmit
```
