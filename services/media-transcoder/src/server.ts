import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSourceUrl, isAllowedPdsBlob, isAllowedSource, mosaicSourceUrls, outputFormat } from './policy.js';

const MAX_INPUT = 32 * 1024 * 1024;
const MAX_OUTPUT = 64 * 1024 * 1024;
const cache = new Map<string, { body: Buffer; type: string }>();

async function safeFetch(url: string, allowed: (url: string) => boolean): Promise<Response> {
  let current = url;
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!allowed(current)) throw new Error('upstream host is not allowed');
    const response = await fetch(current, { redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    if (!location) throw new Error('redirect without location');
    current = new URL(location, current).toString();
  }
  throw new Error('too many redirects');
}

async function readResponse(response: Response): Promise<Buffer> {
  if (!response.ok) throw new Error(`upstream returned ${response.status}`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_INPUT) throw new Error('input too large');
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_INPUT) throw new Error('input too large');
  return body;
}

function ffmpeg(input: Buffer, format: 'webp' | 'gif'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-an', '-vf', 'fps=15,scale=1280:-2:force_original_aspect_ratio=decrease'];
    if (format === 'webp') args.push('-c:v', 'libwebp_anim', '-loop', '0', '-f', 'webp');
    else args.push('-loop', '0', '-f', 'gif');
    args.push('pipe:1');
    const child = spawn('ffmpeg', args);
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on('data', (part: Buffer) => { size += part.length; if (size <= MAX_OUTPUT) chunks.push(part); else child.kill('SIGKILL'); });
    let error = '';
    child.stderr.on('data', part => { error += part.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(error || `ffmpeg exited ${code}`)));
    child.stdin.end(input);
  });
}

async function mosaic(urls: string[], format: 'jpeg' | 'webp'): Promise<Buffer> {
  const inputs = await Promise.all(mosaicSourceUrls(urls).map(async (source: string) => readResponse(await safeFetch(source, isAllowedSource))));
  const dir = await mkdtemp(join(tmpdir(), 'fxembed-mosaic-'));
  try {
    const files = await Promise.all(inputs.map((input: Buffer, index: number) => { const file = join(dir, `${index}.img`); return writeFile(file, input).then(() => file); }));
    return await new Promise((resolve, reject) => {
      const args = ['-hide_banner', '-loglevel', 'error'];
      for (const file of files) args.push('-i', file);
      args.push('-filter_complex', `tile=${Math.min(2, inputs.length)}x${Math.ceil(inputs.length / 2)}:padding=8:margin=8`, '-frames:v', '1', '-f', format === 'jpeg' ? 'mjpeg' : 'webp', 'pipe:1');
      const child = spawn('ffmpeg', args); const chunks: Buffer[] = []; let size = 0;
      child.stdout.on('data', (part: Buffer) => { size += part.length; if (size <= MAX_OUTPUT) chunks.push(part); else child.kill('SIGKILL'); });
      let error = ''; child.stderr.on('data', part => { error += part.toString(); });
      child.on('error', reject); child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(error || `ffmpeg exited ${code}`)));
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function transcode(pathname: string, format: 'webp' | 'gif') {
  const key = `${pathname}:${format}`;
  const cached = cache.get(key); if (cached) return cached;
  const source = buildSourceUrl(pathname.replace(/\.(?:webp|gif)$/i, '.mp4'));
  const result = { body: await ffmpeg(await readResponse(await safeFetch(source, isAllowedSource)), format), type: format === 'webp' ? 'image/webp' : 'image/gif' };
  if (result.body.length <= MAX_OUTPUT) cache.set(key, result);
  return result;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname.startsWith('/tweet_video/') && /\.(webp|gif)$/i.test(url.pathname)) {
      const result = await transcode(url.pathname, outputFormat(url.pathname));
      res.writeHead(200, { 'content-type': result.type, 'content-length': result.body.length, 'cache-control': 'public, max-age=86400, immutable' }); res.end(result.body); return;
    }
    if (url.pathname === '/mosaic') {
      const format = url.searchParams.get('format') === 'webp' ? 'webp' : 'jpeg';
      const result = await mosaic(url.searchParams.getAll('url'), format);
      res.writeHead(200, { 'content-type': format === 'webp' ? 'image/webp' : 'image/jpeg', 'content-length': result.length, 'cache-control': 'public, max-age=86400' }); res.end(result); return;
    }
    if (url.pathname === '/video') {
      const source = url.searchParams.get('url') || '';
      if (!isAllowedSource(source)) { res.writeHead(400); res.end('invalid source'); return; }
      const upstream = await safeFetch(source, isAllowedSource); if (!upstream.ok || !upstream.body) { res.writeHead(upstream.status || 502); res.end(); return; }
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'video/mp4', 'cache-control': 'public, max-age=3600', ...(upstream.headers.get('content-length') ? { 'content-length': upstream.headers.get('content-length')! } : {}) });
      for await (const chunk of upstream.body as AsyncIterable<Uint8Array>) res.write(chunk); res.end(); return;
    }
    if (url.pathname === '/pds-cache') {
      const source = url.searchParams.get('url') || '';
      if (!isAllowedPdsBlob(source)) { res.writeHead(400); res.end('invalid PDS blob'); return; }
      const key = `pds:${source}`; const cached = cache.get(key);
      const result = cached || { body: await readResponse(await safeFetch(source, isAllowedSource)), type: 'application/octet-stream' };
      if (!cached) cache.set(key, result);
      res.writeHead(200, { 'content-type': result.type, 'content-length': result.body.length, 'cache-control': 'public, max-age=86400' }); res.end(result.body); return;
    }
    res.writeHead(404); res.end('not found');
  } catch (error) { console.error(error); res.writeHead(502); res.end('media unavailable'); }
});

if (process.env.NODE_ENV !== 'test') server.listen(Number(process.env.PORT || 8787), '0.0.0.0');
export { server, ffmpeg, transcode, mosaic };
