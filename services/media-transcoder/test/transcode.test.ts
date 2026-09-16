import { afterEach, expect, test, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpeg } from '../src/server.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
afterEach(() => {
  vi.mocked(spawn).mockReset();
  vi.useRealTimers();
});

const input = () =>
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=64x48:rate=20:duration=1',
    '-f',
    'matroska',
    '-c:v',
    'ffv1',
    'pipe:1'
  ]);

test.each(['webp', 'gif'] as const)(
  '%s uses encoder defaults without conversion tuning',
  async format => {
    const dir = await mkdtemp(join(tmpdir(), 'fxembed-test-'));
    try {
      const output = await ffmpeg(input(), format);
      const file = join(dir, `out.${format}`);
      await writeFile(file, output);
      const decoded = JSON.parse(
        execFileSync('python3', [
          '-c',
          'from PIL import Image; import sys,json; im=Image.open(sys.argv[1]); print(json.dumps({"size":im.size,"frames":im.n_frames,"duration":im.info.get("duration")}))',
          file
        ]).toString()
      );
      expect(decoded.size).toEqual([64, 48]);
      expect(decoded.frames).toBe(20);
      const calls = vi.mocked(spawn).mock.calls;
      if (format === 'gif') {
        expect(calls.map(c => c[0])).toEqual(['ffmpeg', 'gifski']);
        expect(calls[0][1]).toEqual([
          '-i',
          'pipe:0',
          '-pix_fmt',
          'yuv444p',
          '-f',
          'yuv4mpegpipe',
          'pipe:1'
        ]);
        expect(calls[1][1]).toEqual(['-o', '-', '-']);
      } else {
        expect(calls).toHaveLength(1);
        expect(calls[0][1]).toEqual([
          '-i',
          'pipe:0',
          '-c:v',
          'libwebp_anim',
          '-f',
          'webp',
          expect.any(String)
        ]);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  30_000
);

test.each(['webp', 'gif'] as const)(
  '%s rejects invalid media without hanging',
  async format => {
    await expect(ffmpeg(Buffer.from('invalid media'), format)).rejects.toThrow();
  },
  10_000
);

test('missing gifski stops the decoder and rejects', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  vi.mocked(spawn).mockImplementation((command, args, options) =>
    actual.spawn(
      command === 'gifski' ? '/nonexistent-fxembed-gifski' : command,
      args as string[],
      options
    )
  );
  await expect(ffmpeg(input(), 'gif')).rejects.toThrow(/ENOENT/);
  const decoder = vi.mocked(spawn).mock.results[0].value;
  expect(decoder.exitCode !== null || decoder.signalCode !== null).toBe(true);
});

test('timeout kills and reaps both GIF pipeline processes', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  vi.mocked(spawn).mockImplementation(() =>
    actual.spawn(process.execPath, ['-e', 'process.stdin.resume(); setInterval(() => {}, 1000)'])
  );
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const work = ffmpeg(Buffer.from('input'), 'gif');
  const rejected = expect(work).rejects.toThrow('transcode timed out');
  // Let real filesystem/process work complete without advancing the fake timer.
  while (vi.mocked(spawn).mock.calls.length < 2) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  await vi.advanceTimersByTimeAsync(45_000);
  await rejected;
  for (const result of vi.mocked(spawn).mock.results)
    expect(result.value.signalCode).toBe('SIGKILL');
});

test('oversized GIF output stops and reaps the pipeline', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  vi.mocked(spawn).mockImplementation(command =>
    actual.spawn(process.execPath, [
      '-e',
      command === 'gifski'
        ? 'process.stdin.resume(); process.stdout.write(Buffer.alloc(65 * 1024 * 1024)); setInterval(() => {}, 1000)'
        : 'process.stdin.resume(); setInterval(() => {}, 1000)'
    ])
  );
  await expect(ffmpeg(Buffer.from('input'), 'gif')).rejects.toThrow('output too large');
  for (const result of vi.mocked(spawn).mock.results)
    expect(result.value.signalCode).toBe('SIGKILL');
});
