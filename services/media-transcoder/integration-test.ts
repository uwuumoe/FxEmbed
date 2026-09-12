import { execFileSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ffmpeg, mosaic, server } from './src/server.ts';

const input = execFileSync('ffmpeg', [
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'testsrc=size=32x32:rate=5:duration=1',
  '-f',
  'gif',
  'pipe:1'
]);
const dir = await mkdtemp('/tmp/fxembed-media-');
try {
  const count = (file: string) =>
    Number(
      execFileSync('python', [
        '-c',
        'from PIL import Image; import sys; im=Image.open(sys.argv[1]); n=0\ntry:\n\n while True: im.seek(n); n+=1\nexcept EOFError: pass\nprint(n)',
        file
      ])
        .toString()
        .trim()
    );
  const webp = await ffmpeg(input, 'webp');
  const gif = await ffmpeg(input, 'gif');
  const webpPath = join(dir, 'out.webp');
  const gifPath = join(dir, 'out.gif');
  await writeFile(webpPath, webp);
  await writeFile(gifPath, gif);
  assert(count(webpPath) > 1);
  assert(count(gifPath) > 1);
  console.log(
    `decoded animated outputs: webp=${count(webpPath)} frames, gif=${count(gifPath)} frames`
  );
  const red = execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=32x24',
    '-frames:v',
    '1',
    '-f',
    'image2',
    'pipe:1'
  ]);
  const blue = execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=32x24',
    '-frames:v',
    '1',
    '-f',
    'image2',
    'pipe:1'
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) =>
    new Response(String(url).includes('red') ? red : blue, { status: 200 })) as typeof fetch;
  const mosaicOutput = await mosaic(
    ['https://cdn.bsky.app/red', 'https://cdn.bsky.app/blue'],
    'jpeg'
  );
  const mosaicPath = join(dir, 'mosaic.jpg');
  await writeFile(mosaicPath, mosaicOutput);
  const dimensions = execFileSync('python', [
    '-c',
    'from PIL import Image; import sys; print(Image.open(sys.argv[1]).size)',
    mosaicPath
  ])
    .toString()
    .trim();
  console.log(`decoded mosaic output: ${dimensions}`);
  assert.equal(dimensions, '(1280, 360)');
  const colors = execFileSync('python', [
    '-c',
    "from PIL import Image; import sys; im=Image.open(sys.argv[1]).convert('RGB'); print(im.getpixel((320,180)), im.getpixel((960,180)))",
    mosaicPath
  ])
    .toString()
    .trim();
  console.log(`mosaic content samples: ${colors}`);
  assert.match(colors, /\(25[0-5], 0, 0\).+\((?:0|1), 0, 25[0-5]\)/);

  const port = await new Promise<number>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
  globalThis.fetch = ((url: string | URL, init?: RequestInit) =>
    String(url).startsWith('http://127.0.0.1')
      ? originalFetch(url, init)
      : Promise.resolve(
          new Response(String(url).includes('red') ? red : blue, { status: 200 })
        )) as typeof fetch;
  const httpResponse = await originalFetch(
    `http://127.0.0.1:${port}/mosaic?format=jpeg&url=https%3A%2F%2Fcdn.bsky.app%2Fred&url=https%3A%2F%2Fcdn.bsky.app%2Fblue`
  );
  assert.equal(httpResponse.status, 200);
  assert.equal(httpResponse.headers.get('content-type'), 'image/jpeg');
  assert((await httpResponse.arrayBuffer()).byteLength > 1000);
  await new Promise<void>(resolve => server.close(() => resolve()));
  globalThis.fetch = originalFetch;
  console.log('HTTP integration: /mosaic returned a real JPEG');
} finally {
  await rm(dir, { recursive: true, force: true });
}
