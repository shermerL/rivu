import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { Writable } from 'node:stream';
import test from 'node:test';
import { writeBuffer } from '../src/node/write-buffer.js';

function controlled(highWaterMark = 4) {
  const chunks: Buffer[] = [];
  let complete: (error?: Error | null) => void = () => { throw new Error('No pending write'); };
  const stream = new Writable({ highWaterMark, write(chunk, _encoding, callback) {
    chunks.push(Buffer.from(chunk));
    complete = callback;
  } });
  return { stream, chunks, release: () => complete() };
}

function assertClean(stream: Writable, signal: AbortSignal) {
  for (const event of ['drain', 'error', 'close']) assert.equal(stream.listenerCount(event), 0, event);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
}

test('a write below the threshold resolves without waiting for flush', async t => {
  const sink = controlled(16);
  t.after(() => sink.stream.destroy());
  const signal = new AbortController().signal;
  await writeBuffer(sink.stream, Buffer.from('jpeg'), signal);
  assert.deepEqual(sink.chunks, [Buffer.from('jpeg')]);
  assert.equal(sink.stream.writableLength, 4);
  assertClean(sink.stream, signal);
  sink.release();
});

test('backpressure waits for drain and never writes the accepted bytes twice', async t => {
  const sink = controlled();
  t.after(() => sink.stream.destroy());
  const signal = new AbortController().signal;
  const bytes = Buffer.from('jpeg bytes');
  let settled = false;
  const pending = writeBuffer(sink.stream, bytes, signal).then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(sink.stream.writableNeedDrain, true);
  assert.equal(settled, false);
  sink.release();
  await pending;
  assert.deepEqual(sink.chunks, [bytes]);
  assert.equal(sink.stream.writableNeedDrain, false);
  assertClean(sink.stream, signal);
});

for (const event of ['error', 'close', 'abort'] as const) {
  test(`${event} interrupts a backpressured write and removes its listeners`, async t => {
    const sink = controlled();
    t.after(() => sink.stream.destroy());
    const controller = new AbortController();
    const error = new Error('broken pipe');
    const pending = writeBuffer(sink.stream, Buffer.alloc(8), controller.signal);
    const rejected = assert.rejects(pending, event === 'error' ? error
      : event === 'abort' ? { name: 'AbortError' } : /closed before drain/);
    if (event === 'abort') controller.abort();
    else if (event === 'error') sink.stream.emit(event, error);
    else sink.stream.emit(event);
    await rejected;
    assertClean(sink.stream, controller.signal);
    sink.release();
    assert.equal(sink.chunks.length, 1);
  });
}

test('pre-abort rejects before writing', async t => {
  const sink = controlled();
  t.after(() => sink.stream.destroy());
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(writeBuffer(sink.stream, Buffer.alloc(8), controller.signal), { name: 'AbortError' });
  assert.equal(sink.chunks.length, 0);
  assertClean(sink.stream, controller.signal);
});

for (const state of ['destroyed', 'ended'] as const) {
  test(`an already ${state} stream rejects without writing`, async t => {
    const sink = controlled();
    t.after(() => sink.stream.destroy());
    if (state === 'destroyed') sink.stream.destroy();
    else sink.stream.end();
    const signal = new AbortController().signal;
    await assert.rejects(writeBuffer(sink.stream, Buffer.alloc(8), signal), /not available/);
    assert.equal(sink.chunks.length, 0);
    assertClean(sink.stream, signal);
  });
}

for (const cause of [new Error('sync failure'), 'non-Error failure']) {
  test(`synchronous write failure is normalized: ${String(cause)}`, async t => {
    const sink = controlled();
    t.after(() => sink.stream.destroy());
    sink.stream.write = () => { throw cause; };
    const signal = new AbortController().signal;
    await assert.rejects(writeBuffer(sink.stream, Buffer.alloc(8), signal),
      cause instanceof Error ? cause : { message: cause });
    assertClean(sink.stream, signal);
  });
}

test('completion preserves listeners owned by the caller', async t => {
  const sink = controlled();
  t.after(() => sink.stream.destroy());
  const controller = new AbortController();
  const listener = () => {};
  for (const event of ['drain', 'error', 'close']) sink.stream.on(event, listener);
  controller.signal.addEventListener('abort', listener);
  const pending = writeBuffer(sink.stream, Buffer.alloc(8), controller.signal);
  sink.release();
  await pending;
  for (const event of ['drain', 'error', 'close']) assert.deepEqual(sink.stream.listeners(event), [listener]);
  assert.deepEqual(getEventListeners(controller.signal, 'abort'), [listener]);
  controller.abort();
  sink.stream.emit('error', new Error('late error handled by owner'));
  assert.equal(sink.chunks.length, 1);
});
