import { execFileSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ffmpeg, mosaic } from './src/server.ts';

const input = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=32x32:rate=5:duration=1', '-f', 'gif', 'pipe:1']);
const dir = await mkdtemp('/tmp/fxembed-media-');
try {
  const count = (file: string) => Number(execFileSync('python', ['-c', "from PIL import Image; import sys; im=Image.open(sys.argv[1]); n=0\ntry:\n\n while True: im.seek(n); n+=1\nexcept EOFError: pass\nprint(n)", file]).toString().trim());
  const webp = await ffmpeg(input, 'webp');
  const gif = await ffmpeg(input, 'gif');
  const webpPath = join(dir, 'out.webp'); const gifPath = join(dir, 'out.gif');
  await writeFile(webpPath, webp); await writeFile(gifPath, gif);
  assert(count(webpPath) > 1); assert(count(gifPath) > 1);
  console.log(`decoded animated outputs: webp=${count(webpPath)} frames, gif=${count(gifPath)} frames`);
  const red = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x24', '-frames:v', '1', '-f', 'image2', 'pipe:1']);
  const blue = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x24', '-frames:v', '1', '-f', 'image2', 'pipe:1']);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => new Response(String(url).includes('red') ? red : blue, { status: 200 })) as typeof fetch;
  const mosaicOutput = await mosaic(['https://cdn.bsky.app/red', 'https://cdn.bsky.app/blue'], 'jpeg');
  globalThis.fetch = originalFetch;
  const mosaicPath = join(dir, 'mosaic.jpg'); await writeFile(mosaicPath, mosaicOutput);
  const dimensions = execFileSync('python', ['-c', "from PIL import Image; import sys; print(Image.open(sys.argv[1]).size)", mosaicPath]).toString().trim();
  console.log(`decoded mosaic output: ${dimensions}`);
  assert(dimensions !== '(32, 24)');
} finally { await rm(dir, { recursive: true, force: true }); }
