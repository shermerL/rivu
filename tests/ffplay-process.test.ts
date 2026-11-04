import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter, getEventListeners, once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { runFFplay } from '../src/node/ffplay-process.js';

async function bounded<T>(promise: Promise<T>, ms = 6000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out')), ms);
    })]);
  } finally { clearTimeout(timer); }
}
function fake() {
  const kills: unknown[] = [];
  const emitter = Object.assign(new EventEmitter(), {
    pid: 123456, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(), stderr: new PassThrough(),
    kill: (signal: unknown) => { kills.push(signal); return true; },
  });
  return { child: emitter as unknown as ChildProcess, emitter, kills };
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
const script = `
process.on('SIGTERM', () => { if (!process.env.IGNORE_TERM) process.exit(0); });
process.on('message', message => {
  if (message === 'close') process.exit(0);
  if (message === 'diagnostic') process.stderr.write('[error] invalid image', () => process.exit(0));
});
process.send('ready');
`;
function actual(t: TestContext, ignore = false) {
  const child = spawn(process.execPath, ['-e', script], {
    env: { ...process.env, IGNORE_TERM: ignore ? '1' : '' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const ready = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('message', message => message === 'ready' ? resolve() : reject(new Error('Bad readiness')));
    child.once('close', () => reject(new Error('Closed before readiness')));
  });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await bounded(closed); });
  return { child, ready, closed };
}

test('spawn contract preserves a hostile-looking filename without a shell', async () => {
  const f = fake();
  const controller = new AbortController();
  let spawned = 0;
  const path = '-photo with spaces; $(touch nope).png';
  const result = runFFplay(path, { signal: controller.signal, onSpawn: () => spawned++,
    spawnPlayer(command, args, options) {
      assert.equal(command, 'ffplay');
      assert.equal(options.shell, false);
      assert.deepEqual(options.stdio, ['ignore', 'ignore', 'pipe']);
      assert.equal(args[args.indexOf('-i') + 1], path);
      assert.equal(args.filter(arg => arg === path).length, 1);
      assert.equal(args[args.indexOf('-pattern_type') + 1], 'none');
      assert.equal(args[args.indexOf('-loglevel') + 1], 'level+error');
      return f.child;
    } });
  f.emitter.emit('spawn');
  f.emitter.emit('close', 0, null);
  assert.deepEqual(await result, { kind: 'closed', code: 0, signal: null });
  assert.equal(spawned, 1);
  assert.deepEqual(getEventListeners(controller.signal, 'abort'), []);
});

test('pre-abort avoids spawning; synchronous spawn exceptions fail', async () => {
  const c = new AbortController(); c.abort();
  assert.deepEqual(await runFFplay('x', { signal: c.signal, spawnPlayer() { throw new Error('must not spawn'); } }), { kind: 'cancelled' });
  const error = new Error('spawn unavailable');
  const signal = new AbortController().signal;
  assert.deepEqual(await runFFplay('x', { signal, spawnPlayer() { throw error; } }), { kind: 'failed', error, diagnostic: '' });
  assert.deepEqual(getEventListeners(signal, 'abort'), []);
});

test('asynchronous spawn error waits for close and removes abort listener', async () => {
  const f = fake(); const c = new AbortController(); const error = new Error('ENOENT');
  const result = runFFplay('x', { signal: c.signal, spawnPlayer: () => f.child });
  let settled = false; void result.then(() => { settled = true; });
  f.emitter.emit('error', error);
  await Promise.resolve(); assert.equal(settled, false);
  f.emitter.emit('close', -2, null);
  assert.deepEqual(await result, { kind: 'failed', error, diagnostic: '' });
  assert.deepEqual(getEventListeners(c.signal, 'abort'), []);
});

test('error-level stderr overrides exit zero and retains only the last 8192 bytes', async () => {
  const f = fake(); const c = new AbortController();
  const result = runFFplay('x', { signal: c.signal, spawnPlayer: () => f.child });
  f.emitter.stderr.write(Buffer.from('[error] ' + 'a'.repeat(16000)));
  f.emitter.stderr.write(Buffer.from('END'));
  f.emitter.emit('close', 0, null);
  const value = await result; assert.equal(value.kind, 'failed');
  if (value.kind !== 'failed') throw new Error('Expected failure');
  assert.equal(value.diagnostic, 'a'.repeat(8189) + 'END');
  assert.equal(Buffer.byteLength(value.diagnostic), 8192);
  assert.deepEqual(f.kills, ['SIGTERM']);
  assert.deepEqual(getEventListeners(c.signal, 'abort'), []);
});

test('abort waits for close, escalates once, and clears escalation on close', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const escalate of [false, true]) {
    const f = fake(); const c = new AbortController();
    const result = runFFplay('x', { signal: c.signal, spawnPlayer: () => f.child });
    let settled = false; void result.then(() => { settled = true; });
    c.abort(); await Promise.resolve(); assert.equal(settled, false);
    t.mock.timers.tick(999); assert.deepEqual(f.kills, ['SIGTERM']);
    if (escalate) { t.mock.timers.tick(1); assert.deepEqual(f.kills, ['SIGTERM', 'SIGKILL']); }
    f.emitter.emit('close', null, escalate ? 'SIGKILL' : 'SIGTERM');
    assert.deepEqual(await result, { kind: 'cancelled' });
    t.mock.timers.tick(2000);
    assert.equal(f.kills.length, escalate ? 2 : 1);
    assert.deepEqual(getEventListeners(c.signal, 'abort'), []);
  }
});

test('abort between exit and close does not kill an already exited child', async () => {
  const f = fake(); const c = new AbortController();
  const result = runFFplay('x', { signal: c.signal, spawnPlayer: () => f.child });
  f.emitter.exitCode = 0; c.abort();
  assert.deepEqual(f.kills, []);
  f.emitter.emit('close', 0, null);
  assert.deepEqual(await result, { kind: 'cancelled' });
});

for (const mode of ['close', 'diagnostic', 'cancel', 'ignore-term']) {
  test(`real owned Node child: ${mode}`, { timeout: 12000 }, async t => {
    const unrelated = actual(t); await bounded(unrelated.ready);
    const owned = actual(t, mode === 'ignore-term');
    const signals: unknown[] = []; const kill = owned.child.kill.bind(owned.child);
    owned.child.kill = signal => { signals.push(signal); return kill(signal); };
    const c = new AbortController();
    const result = runFFplay('unused', { signal: c.signal, spawnPlayer: () => owned.child });
    await bounded(owned.ready);
    if (mode === 'cancel' || mode === 'ignore-term') c.abort();
    else owned.child.send(mode);
    const value = await bounded(result);
    assert.equal(value.kind, mode === 'close' ? 'closed' : mode === 'diagnostic' ? 'failed' : 'cancelled');
    if (value.kind === 'closed') assert.deepEqual(value, { kind: 'closed', code: 0, signal: null });
    if (value.kind === 'failed') assert.match(value.diagnostic, /invalid image/);
    assert.equal(alive(owned.child.pid!), false, 'result must follow actual child termination');
    assert.equal(alive(unrelated.child.pid!), true, 'must not signal unrelated children');
    if (mode === 'ignore-term') assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    assert.deepEqual(getEventListeners(c.signal, 'abort'), []);
  });
}


test('native stderr diagnostics do not imply an FFmpeg failure', async () => {
  const f = fake(); const c = new AbortController();
  const result = runFFplay('x', { signal: c.signal, spawnPlayer: () => f.child });
  f.emitter.stderr.write('macOS application notification: error while scheduling\n');
  f.emitter.emit('close', 0, null);
  assert.deepEqual(await result, { kind: 'closed', code: 0, signal: null });
  assert.deepEqual(f.kills, []);
});

test('FFmpeg error marker split between chunks still fails', async () => {
  const f = fake(); const c = new AbortController();
  const result = runFFplay('x', { signal: c.signal, spawnPlayer: () => f.child });
  f.emitter.stderr.write('[mjpeg @ 0x1234] [er');
  assert.deepEqual(f.kills, []);
  f.emitter.stderr.write('ror] invalid JPEG\n');
  assert.deepEqual(f.kills, ['SIGTERM']);
  f.emitter.emit('close', 0, null);
  assert.equal((await result).kind, 'failed');
});

test('JPEG pipe sends exact bytes and EOF, then waits for player close', async () => {
  const f = fake(); const controller = new AbortController();
  const bytes = Buffer.from([0xff, 0xd8, 0, 0x80, 0xff, 0xd9]);
  const chunks: Buffer[] = [];
  f.emitter.stdin.on('data', chunk => chunks.push(Buffer.from(chunk)));
  const finished = once(f.emitter.stdin, 'finish');
  const result = runFFplay(bytes, { signal: controller.signal,
    spawnPlayer(command, args, options) {
      assert.equal(command, 'ffplay');
      assert.equal(options.shell, false);
      assert.deepEqual(options.stdio, ['pipe', 'ignore', 'pipe']);
      for (const [flag, value] of [['-f', 'image2pipe'], ['-vcodec', 'mjpeg'], ['-i', 'pipe:0']]) {
        assert.equal(args[args.indexOf(flag!) + 1], value);
      }
      return f.child;
    } });
  let settled = false; void result.then(() => { settled = true; });
  f.emitter.emit('spawn');
  await bounded(finished);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  assert.equal(f.emitter.stdin.writableEnded, true);
  assert.equal(settled, false, 'finishing stdin must not finish playback');
  f.emitter.emit('close', 0, null);
  assert.deepEqual(await result, { kind: 'closed', code: 0, signal: null });
  assert.deepEqual(getEventListeners(controller.signal, 'abort'), []);
});

test('JPEG pipe write failure stops the child and waits for close', async () => {
  const f = fake(); const c = new AbortController();
  const error = Object.assign(new Error('Broken pipe'), { code: 'EPIPE' });
  const result = runFFplay(Buffer.from([0xff, 0xd8]), { signal: c.signal, spawnPlayer: () => f.child });
  let settled = false; void result.then(() => { settled = true; });
  f.emitter.stdin.emit('error', error);
  await Promise.resolve();
  assert.equal(f.emitter.stdin.destroyed, true);
  assert.equal(settled, false);
  assert.deepEqual(f.kills, ['SIGTERM']);
  f.emitter.emit('close', 0, null);
  assert.deepEqual(await result, { kind: 'failed', error, diagnostic: '' });
  assert.deepEqual(getEventListeners(c.signal, 'abort'), []);
});

test('JPEG cancellation before spawn destroys stdin without writing bytes', async () => {
  const f = fake(); const c = new AbortController();
  const result = runFFplay(Buffer.from([0xff, 0xd8]), { signal: c.signal, spawnPlayer() {
    c.abort(); return f.child;
  } });
  assert.equal(f.emitter.stdin.destroyed, true);
  f.emitter.emit('spawn');
  assert.equal(f.emitter.stdin.writableLength, 0);
  f.emitter.emit('close', null, 'SIGTERM');
  assert.deepEqual(await result, { kind: 'cancelled' });
  assert.deepEqual(f.kills, ['SIGTERM']);
});

test('JPEG pipe waits for drain before EOF and preserves the exact bytes', async () => {
  const f = fake();
  const c = new AbortController();
  const bytes = Buffer.from([0xff, 0xd8, 1, 2, 3, 4, 0xff, 0xd9]);
  const chunks: Buffer[] = [];
  let release: () => void = () => { throw new Error('No write'); };
  const stdin = new Writable({ highWaterMark: 4, write(chunk, _encoding, callback) {
    chunks.push(Buffer.from(chunk)); release = callback;
  } });
  Object.assign(f.emitter, { stdin });
  const result = runFFplay(bytes, { signal: c.signal, spawnPlayer: () => f.child });
  const finished = once(stdin, 'finish');
  f.emitter.emit('spawn');
  await Promise.resolve();
  assert.equal(stdin.writableNeedDrain, true);
  assert.equal(stdin.writableEnded, false);
  release();
  await bounded(finished);
  assert.deepEqual(chunks, [bytes]);
  assert.equal(stdin.writableEnded, true);
  f.emitter.emit('close', 0, null);
  assert.deepEqual(await result, { kind: 'closed', code: 0, signal: null });
  assert.deepEqual(getEventListeners(c.signal, 'abort'), []);
});

function sequencePlayer(t: TestContext) {
  const f = fake();
  const chunks: Buffer[] = [];
  const callbacks: Array<(error?: Error | null) => void> = [];
  let finalCalls = 0;
  const stdin = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callbacks.push(callback);
    },
    final(callback) { finalCalls++; callback(); },
  });
  Object.assign(f.emitter, { stdin });
  t.after(() => {
    stdin.destroy();
    f.emitter.exitCode = 0;
    f.emitter.emit('close', 0, null);
  });
  return { ...f, stdin, chunks,
    get finalCalls() { return finalCalls; },
    release(error?: Error) {
      const callback = callbacks.shift();
      assert.ok(callback, 'expected a pending write');
      callback(error);
    },
  };
}

const sequence = Object.freeze([
  Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]),
  Buffer.from([0xff, 0xd8, 2, 3, 0xff, 0xd9]),
  Buffer.from([0xff, 0xd8, 4, 5, 6, 0xff, 0xd9]),
]);
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

test('JPEG sequence uses one player and waits for each drain before the next frame', async t => {
  const f = sequencePlayer(t);
  const c = new AbortController();
  let spawns = 0;
  const result = runFFplay(sequence, { signal: c.signal, spawnPlayer(_command, args, options) {
    spawns++;
    assert.deepEqual(options.stdio, ['pipe', 'ignore', 'pipe']);
    assert.equal(args[args.indexOf('-f') + 1], 'image2pipe');
    assert.equal(args[args.indexOf('-framerate') + 1], '10');
    assert.equal(args[args.indexOf('-i') + 1], 'pipe:0');
    return f.child;
  } });
  let settled = false;
  void result.then(() => { settled = true; });
  f.emitter.emit('spawn');
  for (let index = 0; index < sequence.length; index++) {
    await nextTurn();
    assert.deepEqual(f.chunks, sequence.slice(0, index + 1));
    assert.equal(f.stdin.writableNeedDrain, true);
    assert.equal(f.stdin.writableEnded, false);
    assert.equal(f.finalCalls, 0);
    f.release();
  }
  await nextTurn();
  assert.deepEqual(f.chunks, sequence);
  assert.equal(f.finalCalls, 1);
  assert.equal(f.stdin.writableEnded, true);
  assert.equal(spawns, 1);
  assert.equal(settled, false, 'EOF does not mean the player has closed');
  f.emitter.exitCode = 0;
  f.emitter.emit('close', 0, null);
  assert.deepEqual(await bounded(result), { kind: 'closed', code: 0, signal: null });
  assert.deepEqual(getEventListeners(c.signal, 'abort'), []);
});

test('JPEG sequence without backpressure preserves frame order and ends once', async () => {
  const f = fake(); const c = new AbortController();
  const chunks: Buffer[] = [];
  let finishes = 0;
  f.emitter.stdin.on('data', chunk => chunks.push(Buffer.from(chunk)));
  f.emitter.stdin.on('finish', () => finishes++);
  const finished = once(f.emitter.stdin, 'finish');
  const result = runFFplay(sequence, { signal: c.signal, spawnPlayer: () => f.child });
  f.emitter.emit('spawn');
  await bounded(finished);
  assert.deepEqual(chunks, sequence);
  assert.equal(finishes, 1);
  f.emitter.emit('close', 0, null);
  assert.equal((await bounded(result)).kind, 'closed');
});

for (const timing of ['waiting for drain', 'after drain before continuation'] as const) {
  test(`JPEG sequence cancellation ${timing} skips remaining frames`, async t => {
    const f = sequencePlayer(t); const c = new AbortController();
    const result = runFFplay(sequence, { signal: c.signal, spawnPlayer: () => f.child });
    let settled = false; void result.then(() => { settled = true; });
    f.emitter.emit('spawn');
    assert.deepEqual(f.chunks, sequence.slice(0, 1));
    if (timing === 'after drain before continuation') f.release();
    c.abort();
    await nextTurn();
    assert.deepEqual(f.chunks, sequence.slice(0, 1));
    assert.equal(f.stdin.destroyed, true);
    assert.equal(f.finalCalls, 0);
    assert.equal(settled, false);
    assert.deepEqual(f.kills, ['SIGTERM']);
    assert.equal(f.stdin.listenerCount('drain'), 0);
    f.emitter.signalCode = 'SIGTERM';
    f.emitter.emit('close', null, 'SIGTERM');
    assert.deepEqual(await bounded(result), { kind: 'cancelled' });
    assert.deepEqual(getEventListeners(c.signal, 'abort'), []);
  });
}

test('JPEG sequence EPIPE stops subsequent frames and waits for child close', async t => {
  const f = sequencePlayer(t); const c = new AbortController();
  const error = Object.assign(new Error('Broken pipe'), { code: 'EPIPE' });
  const result = runFFplay(sequence, { signal: c.signal, spawnPlayer: () => f.child });
  let settled = false; void result.then(() => { settled = true; });
  f.emitter.emit('spawn');
  f.release(error);
  await nextTurn();
  assert.deepEqual(f.chunks, sequence.slice(0, 1));
  assert.equal(f.finalCalls, 0);
  assert.equal(settled, false);
  assert.deepEqual(f.kills, ['SIGTERM']);
  assert.equal(f.stdin.listenerCount('drain'), 0);
  f.emitter.signalCode = 'SIGTERM';
  f.emitter.emit('close', null, 'SIGTERM');
  assert.deepEqual(await bounded(result), { kind: 'failed', error, diagnostic: '' });
  assert.deepEqual(getEventListeners(c.signal, 'abort'), []);
});

test('JPEG sequence stdin close during drain cannot hang or write another frame', async t => {
  const f = sequencePlayer(t); const c = new AbortController();
  const result = runFFplay(sequence, { signal: c.signal, spawnPlayer: () => f.child });
  f.emitter.emit('spawn');
  f.emitter.exitCode = 0;
  f.stdin.destroy();
  await nextTurn();
  assert.deepEqual(f.chunks, sequence.slice(0, 1));
  assert.equal(f.finalCalls, 0);
  assert.equal(f.stdin.listenerCount('drain'), 0);
  f.emitter.emit('close', 0, null);
  const outcome = await bounded(result);
  assert.equal(outcome.kind, 'failed');
  if (outcome.kind === 'failed') assert.match(outcome.error.message, /closed before drain/);
  assert.deepEqual(getEventListeners(c.signal, 'abort'), []);
});

test('a pre-aborted JPEG sequence never starts a player', async () => {
  const c = new AbortController(); c.abort();
  const result = await runFFplay(sequence, { signal: c.signal,
    spawnPlayer() { throw new Error('must not spawn'); } });
  assert.deepEqual(result, { kind: 'cancelled' });
});
