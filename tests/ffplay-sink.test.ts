import assert from 'node:assert/strict';
import childProcess, { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { MAX_JPEG_BYTES, MAX_JPEG_FRAMES, playJpeg, playJpegSequence } from '../src/node/ffplay-sink.js';

for (const [label, bytes] of [
  ['empty', Buffer.alloc(0)],
  ['truncated header', Buffer.from([0xff])],
  ['wrong marker', Buffer.from([0xff, 0xd9])],
  ['non-JPEG data', Buffer.from('not an image')],
  ['oversize JPEG', Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(MAX_JPEG_BYTES - 1)])],
] as const) {
  test(`JPEG sink rejects ${label}`, async () => {
    const result = await playJpeg(bytes, new AbortController().signal);
    assert.equal(result.kind, 'failed');
    if (result.kind !== 'failed') throw new Error('Expected failed result');
    assert.match(result.error.message, /Expected JPEG bytes, at most 512 KiB/);
    assert.equal(result.diagnostic, '');
  });
}

test('JPEG sink honors an already aborted signal before validating input', async () => {
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await playJpeg(Buffer.alloc(0), controller.signal), { kind: 'cancelled' });
});

function playerStub(t: TestContext) {
  const chunks: Buffer[] = [];
  const stdin = new PassThrough();
  const emitter = Object.assign(new EventEmitter(), {
    pid: 123456, exitCode: null as number | null, signalCode: null,
    stdin, stderr: new PassThrough(), kill: () => true,
  });
  stdin.on('data', chunk => chunks.push(Buffer.from(chunk)));
  stdin.on('finish', () => {
    emitter.exitCode = 0;
    emitter.emit('close', 0, null);
  });
  const spawn = t.mock.method(childProcess, 'spawn', () => {
    queueMicrotask(() => emitter.emit('spawn'));
    return emitter as unknown as ChildProcess;
  });
  syncBuiltinESMExports();
  t.after(() => {
    spawn.mock.restore();
    syncBuiltinESMExports();
    stdin.destroy();
    emitter.stderr.destroy();
  });
  return { chunks, spawn };
}

const jpeg = Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]);

for (const count of [0, 31]) {
  test(`JPEG sequence rejects ${count} frames before spawning`, async t => {
    const player = playerStub(t);
    const result = await playJpegSequence(Array.from({ length: count }, () => jpeg), new AbortController().signal);
    assert.equal(result.kind, 'failed');
    if (result.kind === 'failed') {
      assert.equal(result.error.message, 'Expected 1 to 30 JPEG frames');
      assert.equal(result.diagnostic, '');
    }
    assert.equal(player.spawn.mock.callCount(), 0);
  });
}

for (const [label, bytes] of [
  ['empty', Buffer.alloc(0)],
  ['truncated header', Buffer.from([0xff])],
  ['wrong first byte', Buffer.from([0, 0xd8])],
  ['wrong second byte', Buffer.from([0xff, 0xd9])],
  ['oversize', Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(MAX_JPEG_BYTES - 1)])],
] as const) {
  test(`JPEG sequence checks a later ${label} frame before playing the valid prefix`, async t => {
    const player = playerStub(t);
    const result = await playJpegSequence([jpeg, bytes], new AbortController().signal);
    assert.equal(result.kind, 'failed');
    if (result.kind === 'failed') assert.equal(result.error.message, 'Expected JPEG bytes, at most 512 KiB');
    assert.equal(player.spawn.mock.callCount(), 0);
    assert.deepEqual(player.chunks, []);
  });
}

for (const index of [0, 1, 2]) {
  test(`JPEG sequence rejects an invalid frame at index ${index}`, async t => {
    const player = playerStub(t);
    const frames = [jpeg, jpeg, jpeg];
    frames[index] = Buffer.from('invalid');
    assert.equal((await playJpegSequence(frames, new AbortController().signal)).kind, 'failed');
    assert.equal(player.spawn.mock.callCount(), 0);
  });
}

for (const [label, frames] of [
  ['valid', [jpeg]], ['empty', []], ['invalid frame', [Buffer.alloc(0)]],
] as const) {
  test(`JPEG sequence pre-abort takes priority over ${label} input`, async t => {
    const player = playerStub(t);
    const controller = new AbortController(); controller.abort();
    assert.deepEqual(await playJpegSequence(frames, controller.signal), { kind: 'cancelled' });
    assert.equal(player.spawn.mock.callCount(), 0);
  });
}

for (const count of [1, 30]) {
  test(`JPEG sequence accepts ${count} frames and preserves their order`, { timeout: 3000 }, async t => {
    const player = playerStub(t);
    assert.equal(MAX_JPEG_FRAMES, 30);
    const frames = Object.freeze(Array.from({ length: count }, (_, index) =>
      Buffer.from([0xff, 0xd8, index, 0xff, 0xd9])));
    const result = await playJpegSequence(frames, new AbortController().signal);
    assert.deepEqual(result, { kind: 'closed', code: 0, signal: null });
    assert.equal(player.spawn.mock.callCount(), 1);
    assert.deepEqual(player.chunks, frames);
  });
}

test('JPEG sequence accepts the exact 512 KiB per-frame boundary', { timeout: 3000 }, async t => {
  const player = playerStub(t);
  const bytes = Buffer.alloc(512 * 1024);
  bytes[0] = 0xff; bytes[1] = 0xd8;
  assert.equal((await playJpegSequence([bytes], new AbortController().signal)).kind, 'closed');
  assert.equal(player.spawn.mock.callCount(), 1);
  assert.deepEqual(Buffer.concat(player.chunks), bytes);
});

test('single JPEG wrapper still sends exactly one frame', { timeout: 3000 }, async t => {
  const player = playerStub(t);
  assert.equal((await playJpeg(jpeg, new AbortController().signal)).kind, 'closed');
  assert.equal(player.spawn.mock.callCount(), 1);
  assert.deepEqual(player.chunks, [jpeg]);
});
