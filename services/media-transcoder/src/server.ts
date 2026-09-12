import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPdsBlobUrl,
  buildSourceUrl,
  isAllowedPdsBlob,
  isAllowedPdsEndpoint,
  buildPdsBlobEndpoint,
  isAllowedSource,
  mosaicSourceUrls,
  outputFormat,
  isDid
} from './policy.js';

const MAX_INPUT = 32 * 1024 * 1024;
const MAX_OUTPUT = 64 * 1024 * 1024;
const MAX_DURATION = 30;
const FETCH_TIMEOUT = 10_000;
const FFMPEG_TIMEOUT = 45_000;
let active = 0;
const waiters: (() => void)[] = [];
// In-flight request coalescing only: identical concurrent requests share one
// computation, but no results are stored. Result caching lives in the Workers
// Cache API at the edge; the container is compute only.
const inflight = new Map<string, Promise<{ body: Buffer; type: string }>>();
async function limit<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 1) await new Promise<void>(resolve => waiters.push(resolve));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}
async function safeFetch(
  url: string,
  allowed: (url: string) => boolean,
  init: RequestInit = {}
): Promise<Response> {
  let current = url;
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!allowed(current)) throw new Error('upstream host is not allowed');
    const signal = AbortSignal.timeout(FETCH_TIMEOUT);
    const response = await fetch(current, { ...init, signal, redirect: 'manual' });
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
  if (!response.body) throw new Error('upstream has no body');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_INPUT) throw new Error('input too large');
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}
export function ffmpeg(input: Buffer, format: 'webp' | 'gif'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-t',
      String(MAX_DURATION),
      '-i',
      'pipe:0',
      '-an',
      '-vf',
      'fps=10,scale=960:-2:force_original_aspect_ratio=decrease'
    ];
    const outputPath = join(tmpdir(), `fxembed-${process.pid}-${Date.now()}-${Math.random()}.${format}`);
    args.push(
      ...(format === 'webp'
        ? ['-c:v', 'libwebp_anim', '-q:v', '60', '-loop', '0', '-f', 'webp']
        : ['-loop', '0', '-f', 'gif']),
      outputPath
    );
    const child = spawn('ffmpeg', args);
    const chunks: Buffer[] = [];
    let size = 0;
    let error = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, FFMPEG_TIMEOUT);
    child.stdout.on('data', (part: Buffer) => {
      size += part.length;
      if (size <= MAX_OUTPUT) chunks.push(part);
      else child.kill('SIGKILL');
    });
    child.stderr.on('data', part => {
      error += part.toString();
    });
    child.on('error', reject);
    child.stdin.on('error', () => undefined);
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        void unlink(outputPath).catch(() => undefined);
        reject(new Error(error || (timedOut ? 'ffmpeg timed out' : `ffmpeg exited ${code}`)));
        return;
      }
      void readFile(outputPath)
        .then(body => {
          if (body.length > MAX_OUTPUT) throw new Error('output too large');
          resolve(body);
        })
        .catch(reject)
        .finally(() => unlink(outputPath).catch(() => undefined));
    });
    child.stdin.end(input);
  });
}
async function runMosaic(inputs: Buffer[], format: 'jpeg' | 'webp'): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'fxembed-mosaic-'));
  try {
    const files = await Promise.all(
      inputs.map((input, i) => {
        const file = join(dir, `${i}.img`);
        return writeFile(file, input).then(() => file);
      })
    );
    return await new Promise((resolve, reject) => {
      const args = ['-hide_banner', '-loglevel', 'error'];
      for (const file of files) args.push('-i', file);
      const cols = Math.min(2, inputs.length);

      if (inputs.length === 1) {
        args.push(
          '-vf',
          'scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2',
          '-frames:v',
          '1',
          '-f',
          format === 'jpeg' ? 'mjpeg' : 'webp',
          'pipe:1'
        );
      } else {
        const refs = inputs
          .map(
            (_, i) =>
              `[${i}:v]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2[${i}v]`
          )
          .join(';');
        const layout = inputs
          .map((_, i) => `${(i % cols) * 640}_${Math.floor(i / cols) * 360}`)
          .join('|');
        args.push(
          '-filter_complex',
          `${refs};${inputs.map((_, i) => `[${i}v]`).join('')}xstack=inputs=${inputs.length}:layout=${layout}:fill=black`,
          '-frames:v',
          '1',
          '-f',
          format === 'jpeg' ? 'mjpeg' : 'webp',
          'pipe:1'
        );
      }
      const child = spawn('ffmpeg', args);
      const chunks: Buffer[] = [];
      let size = 0;
      let error = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), FFMPEG_TIMEOUT);
      child.stdout.on('data', (part: Buffer) => {
        size += part.length;
        if (size <= MAX_OUTPUT) chunks.push(part);
        else child.kill('SIGKILL');
      });
      child.stderr.on('data', p => {
        error += p.toString();
      });
      child.on('error', reject);
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) resolve(Buffer.concat(chunks));
        else reject(new Error(error || `ffmpeg exited ${code}`));
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export async function mosaic(urls: string[], format: 'jpeg' | 'webp'): Promise<Buffer> {
  const sources = mosaicSourceUrls(urls);
  return limit(async () =>
    runMosaic(
      await Promise.all(sources.map(async s => readResponse(await safeFetch(s, isAllowedSource)))),
      format
    )
  );
}
async function transcode(pathname: string, format: 'webp' | 'gif') {
  const key = `${pathname}:${format}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const source = buildSourceUrl(pathname.replace(/\.(?:webp|gif)$/i, '.mp4'));
  const work = (async () => {
    return {
      body: await limit(() =>
        safeFetch(source, isAllowedSource)
          .then(readResponse)
          .then(input => ffmpeg(input, format))
      ),
      type: format === 'webp' ? 'image/webp' : 'image/gif'
    };
  })();
  inflight.set(key, work);
  try {
    return await work;
  } finally {
    inflight.delete(key);
  }
}
async function resolvePdsBlob(did: string, cid: string): Promise<string> {
  const plc = await safeFetch(`https://plc.directory/${encodeURIComponent(did)}`, value => {
    try { return new URL(value).hostname === 'plc.directory'; } catch { return false; }
  });
  const document = (await plc.json()) as {
    service?: Array<{ id?: string; type?: string; serviceEndpoint?: string }>;
  };
  const service = document.service?.find(
    item => item.id === '#atproto_pds' && item.type === 'AtprotoPersonalDataServer'
  );
  if (!service?.serviceEndpoint || !isAllowedPdsEndpoint(service.serviceEndpoint))
    throw new Error('no approved Bluesky PDS');
  return buildPdsBlobEndpoint(service.serviceEndpoint, did, cid);
}
function mediaHeaders(type: string, length?: number) {
  return {
    'content-type': type,
    'cache-control': 'public, max-age=86400, immutable',
    ...(length === undefined ? {} : { 'content-length': String(length) })
  };
}
export async function handle(req: IncomingMessage, res: ServerResponse) {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      return res.end();
    }
    if (url.pathname.startsWith('/tweet_video/') && /\.(webp|gif)$/i.test(url.pathname)) {
      const r = await transcode(url.pathname, outputFormat(url.pathname));
      res.writeHead(200, mediaHeaders(r.type, r.body.length));
      return req.method === 'HEAD' ? res.end() : res.end(r.body);
    }
    const mosaicMatch = url.pathname.match(/^\/(jpeg|webp)\/[^/]+((?:\/[^/]+){1,4})$/);
    if (mosaicMatch) {
      const parts = mosaicMatch[2].slice(1).split('/');
      const urls = parts.map(part =>
        /^did:plc:[a-z2-7]{20,}_[A-Za-z0-9][A-Za-z0-9._~-]{10,}$/.test(part)
          ? buildPdsBlobUrl(`did:plc:${part.split('_')[0].slice(8)}`, part.split('_')[1])
          : `https://pbs.twimg.com/media/${part}?format=jpg&name=large`
      );
      const r = await mosaic(urls, mosaicMatch[1] as 'jpeg' | 'webp');
      res.writeHead(
        200,
        mediaHeaders(mosaicMatch[1] === 'webp' ? 'image/webp' : 'image/jpeg', r.length)
      );
      return req.method === 'HEAD' ? res.end() : res.end(r);
    }
    if (url.pathname === '/mosaic') {
      const format = url.searchParams.get('format') === 'webp' ? 'webp' : 'jpeg';
      const r = await mosaic(url.searchParams.getAll('url'), format);
      res.writeHead(200, mediaHeaders(format === 'webp' ? 'image/webp' : 'image/jpeg', r.length));
      return req.method === 'HEAD' ? res.end() : res.end(r);
    }
    if (url.pathname === '/video') {
      const source = url.searchParams.get('url') || '';
      if (!isAllowedSource(source)) {
        res.writeHead(400);
        return res.end('invalid source');
      }
      const headers: Record<string, string> = {};
      const range = req.headers.range;
      if (range) headers.range = range;
      const upstream = await safeFetch(source, isAllowedSource, { headers });
      if (!upstream.body) {
        res.writeHead(502);
        return res.end();
      }
      const out: Record<string, string> = {};
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const v = upstream.headers.get(h);
        if (v) out[h] = v;
      }
      out['cache-control'] = 'public, max-age=3600';
      res.writeHead(upstream.status, out);
      if (req.method === 'HEAD') return res.end();
      for await (const chunk of upstream.body as AsyncIterable<Uint8Array>)
        if (!res.write(chunk)) await new Promise<void>(resolve => res.once('drain', resolve));
      return res.end();
    }
    const directBluesky = url.pathname.match(/^\/(did%3Aplc%3A|did:plc:)([^/]+)\/([^/]+)$/i);
    if (directBluesky) {
      const did = `did:plc:${decodeURIComponent(directBluesky[2])}`;
      const cid = decodeURIComponent(directBluesky[3]);
      const source = await resolvePdsBlob(did, cid);
      const headers: Record<string, string> = {};
      if (req.headers.range) headers.range = req.headers.range;
      const upstream = await safeFetch(source, isAllowedSource, { headers });
      const body = await readResponse(upstream);
      let status = upstream.status;
      const responseHeaders: Record<string, string> = mediaHeaders(
        upstream.headers.get('content-type') || 'video/mp4',
        body.length
      );
      for (const header of ['content-range', 'accept-ranges']) {
        const value = upstream.headers.get(header);
        if (value) responseHeaders[header] = value;
      }
      if (req.headers.range && upstream.status === 200) {
        const match = req.headers.range.match(/^bytes=(\d+)-(\d*)$/);
        if (match) {
          const start = Number(match[1]);
          const end = match[2] ? Number(match[2]) : body.length - 1;
          if (start <= end && start < body.length) {
            const boundedEnd = Math.min(end, body.length - 1);
            const ranged = body.subarray(start, boundedEnd + 1);
            responseHeaders['content-range'] = `bytes ${start}-${boundedEnd}/${body.length}`;
            responseHeaders['accept-ranges'] = 'bytes';
            responseHeaders['content-length'] = String(ranged.length);
            status = 206;
            res.writeHead(status, responseHeaders);
            return req.method === 'HEAD' ? res.end() : res.end(ranged);
          }
        }
      }
      res.writeHead(status, responseHeaders);
      return req.method === 'HEAD' ? res.end() : res.end(body);
    }
    if (url.pathname === '/pds-cache') {
      let source = url.searchParams.get('url') || '';
      if (!source) {
        const did = url.searchParams.get('did') || '';
        const cid = url.searchParams.get('cid') || '';
        if (!isDid(did)) {
          res.writeHead(400);
          return res.end('invalid DID');
        }
        source = buildPdsBlobUrl(did, cid);
      }
      if (!isAllowedPdsBlob(source)) {
        res.writeHead(400);
        return res.end('invalid PDS blob');
      }
      const r = {
        body: await limit(() => safeFetch(source, isAllowedPdsBlob).then(readResponse)),
        type: 'application/octet-stream'
      };
      res.writeHead(200, mediaHeaders(r.type, r.body.length));
      return req.method === 'HEAD' ? res.end() : res.end(r.body);
    }
    res.writeHead(404);
    return res.end('not found');
  } catch (error) {
    console.error(error);
    res.writeHead(502);
    return res.end('media unavailable');
  }
}
const server = createServer(handle);
if (process.env.NODE_ENV !== 'test') server.listen(Number(process.env.PORT || 8787), '0.0.0.0');
export { server, transcode, runMosaic };
