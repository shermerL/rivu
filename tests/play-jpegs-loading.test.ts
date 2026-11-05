import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { playImage } from '../src/cli/play-image.js';

for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
  for (const index of [0, 1]) {
    test(`JPEG loading: ${signal} during file ${index + 1} cancels without starting playback`,
      { timeout: 5000 }, async t => {
        const directory = await fs.mkdtemp(join(tmpdir(), 'rivu-loading-'));
        t.after(() => fs.rm(directory, { recursive: true, force: true }));
        const paths = [0, 1, 2].map(number => join(directory, `frame-${number}.jpg`));
        await Promise.all(paths.map(path => fs.writeFile(path, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))));

        const listeners = {
          SIGINT: process.listeners('SIGINT'),
          SIGTERM: process.listeners('SIGTERM'),
        };
        const originalReadFile = fs.readFile;
        const reads: unknown[] = [];
        let readingSignal: AbortSignal | undefined;
        let readAborted = false;
        let releaseRead = () => {};
        let entered = () => {};
        const reading = new Promise<void>(resolve => { entered = resolve; });
        const readFile = t.mock.method(fs, 'readFile', async (
          path: Parameters<typeof fs.readFile>[0], options?: unknown,
        ) => {
          reads.push(path);
          if (path !== paths[index]) return originalReadFile(path);
          assert.ok(options && typeof options === 'object' && 'signal' in options);
          assert.ok(options.signal instanceof AbortSignal);
          readingSignal = options.signal;
          assert.equal(readingSignal.aborted, false);
          return new Promise<Buffer>((resolve, reject) => {
            const onAbort = () => {
              readAborted = true;
              reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
            };
            readingSignal!.addEventListener('abort', onAbort, { once: true });
            releaseRead = () => {
              readingSignal!.removeEventListener('abort', onAbort);
              reject(new Error('Test teardown released the pending read'));
            };
            entered();
          });
        });
        const spawn = t.mock.method(childProcess, 'spawn', () => {
          throw new Error('FFplay must not start while loading is cancelled');
        });
        const logs: string[] = [];
        const log = t.mock.method(console, 'error', (line: string) => { logs.push(line); });
        syncBuiltinESMExports();

        let playback: Promise<number> | undefined;
        t.after(async () => {
          releaseRead();
          await playback;
          readFile.mock.restore();
          spawn.mock.restore();
          log.mock.restore();
          syncBuiltinESMExports();
        });
        playback = playImage(paths, 'pipe');
        // A bounded wait diagnoses a missing read without relying on sleep timing.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            reading,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Expected an in-flight file read')), 2000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        assert.equal(process.listenerCount('SIGINT'), listeners.SIGINT.length + 1);
        assert.equal(process.listenerCount('SIGTERM'), listeners.SIGTERM.length + 1);
        // Emit locally: this exercises the registered handler without signalling the test runner.
        process.emit(signal);
        assert.equal(readingSignal?.aborted, true);
        assert.equal(readAborted, true);
        assert.equal(await playback, exitCode);
        assert.deepEqual(reads, paths.slice(0, index + 1));
        assert.equal(spawn.mock.callCount(), 0);
        assert.deepEqual(process.listeners('SIGINT'), listeners.SIGINT);
        assert.deepEqual(process.listeners('SIGTERM'), listeners.SIGTERM);

        const events = logs.map(line => JSON.parse(line));
        assert.deepEqual(events.map(event => event.event), [
          ...Array.from({ length: index }, () => 'loaded'), 'cancelled',
        ]);
        assert.equal(events.at(-1).fields.signal, signal);
      });
  }
}
