import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, realpathSync, mkdtempSync, writeFileSync, readFileSync, chmodSync, unlinkSync, rmSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const entries: [string, string][] = process.env['RIVU_TEST_BUILT'] === '1'
  ? [['built', join(root, 'dist/cli/main.js')]]
  : [['TS', join(root, 'src/cli/main.ts')]];
const loader = import.meta.resolve('tsx');
const supported = process.platform === 'linux' || process.platform === 'darwin';
async function bounded<T>(promise: Promise<T>, ms = 7000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out')), ms);
    })]);
  } finally { clearTimeout(timer); }
}
function gone(pid: number) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; }
}
const bootstrap = `
import assert from 'node:assert/strict';
const before = ['SIGINT', 'SIGTERM'].map(signal => process.listeners(signal));
await import(process.env.TEST_ENTRY);
['SIGINT', 'SIGTERM'].forEach((signal, index) => assert.deepEqual(process.listeners(signal), before[index]));
`;
const shim = `
const fs = require('node:fs');
const mode = process.env.TEST_MODE;
process.on('SIGTERM', () => { if (mode !== 'ignore') process.exit(0); });
process.on('SIGINT', () => process.exit(0));
const record = JSON.stringify({ pid: process.pid, args: process.argv.slice(2) });
fs.appendFileSync(process.env.TEST_READY + '.starts', process.pid + '\\n');
fs.writeFileSync(process.env.TEST_READY + '.tmp', record);
fs.renameSync(process.env.TEST_READY + '.tmp', process.env.TEST_READY);
function finish() {
  if (mode === 'normal') process.exit(0);
  else if (mode === 'diagnostic') process.stderr.write('[error] decode failed\\n', () => process.exit(0));
  else if (mode === 'nonzero') process.exit(7);
  else setInterval(() => {}, 1000);
}
if (process.argv.includes('image2pipe')) {
  const chunks = [];
  process.stdin.on('data', chunk => chunks.push(chunk));
  process.stdin.on('end', () => {
    fs.writeFileSync(process.env.TEST_RECEIVED, Buffer.concat(chunks));
    finish();
  });
} else finish();
`;
type Ready = { pid: number; args: string[] };
function fixture(t: TestContext, entry: string, mode = 'normal', command = 'play-image') {
  const dir = mkdtempSync(join(tmpdir(), 'play image '));
  const image = join(dir, '- image with spaces.png');
  writeFileSync(image, command !== 'play-image' ? readFileSync(join(root, 'fixtures/frame.jpg')) : 'fixture');
  const received = join(dir, 'received.bin');
  const executable = join(dir, 'ffplay');
  writeFileSync(executable, `#!${process.execPath}\n${shim}`, { mode: 0o755 });
  const runner = join(dir, 'runner.mjs'); writeFileSync(runner, bootstrap);
  const readyPath = join(dir, 'ready.json');
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let output = ''; let errors = '';
  const ready = new Promise<Ready>((resolveReady, reject) => {
    const watcher = watch(dir, () => {
      if (existsSync(readyPath)) {
        try { resolveReady(JSON.parse(readFileSync(readyPath, 'utf8')) as Ready); }
        catch (error) { reject(error); }
      }
    });
    watcher.on('error', reject);
    t.after(() => watcher.close());
  });
  t.after(async () => {
    try {
      if (existsSync(readyPath)) {
        const record = JSON.parse(readFileSync(readyPath, 'utf8')) as Ready;
        if (!gone(record.pid)) process.kill(record.pid, 'SIGKILL');
      }
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (closed) await bounded(closed);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  return {
    dir, image, executable, ready, received,
    start(input: string | readonly string[]) {
      const inputs = typeof input === 'string' ? [input] : input;
      child = spawn(process.execPath, ['--import', loader, runner, command, ...inputs], {
        cwd: dir, env: { ...process.env, PATH: dir, TEST_ENTRY: entry, TEST_MODE: mode, TEST_READY: readyPath, TEST_RECEIVED: received },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout!.on('data', chunk => { output += String(chunk); });
      child.stderr!.on('data', chunk => { errors += String(chunk); });
      closed = new Promise((resolveClose, reject) => {
        child!.once('error', reject);
        child!.once('close', (code, signal) => resolveClose({ code, signal }));
      });
      return child;
    },
    async finish() {
      assert.ok(closed, 'start first');
      const result = await bounded(closed);
      assert.equal(output, '', 'player diagnostics must not use stdout');
      const records = errors.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      assert.ok(records.length >= 1);
      assert.equal(records.filter(record => ['closed', 'failed', 'cancelled'].includes(record.event)).length, 1, 'exactly one terminal diagnostic');
      return { ...result, output, errors };
    },
  };
}

for (const [label, entry] of entries) {
  for (const count of [3, 30]) {
    test(`${label}: JPEG sequence sends ${count} ordered frames through one player and EOF`, { skip: !supported, timeout: 12000 }, async t => {
      const f = fixture(t, entry, 'normal', 'play-jpegs');
      const other = join(f.dir, 'second frame.jpg');
      const otherBytes = Buffer.from([0xff, 0xd8, 0x12, 0x34, 0xff, 0xd9]);
      writeFileSync(other, otherBytes);
      const paths = Array.from({ length: count }, (_, index) => index % 2 === 0 ? '- image with spaces.png' : 'second frame.jpg');
      f.start(paths);
      const record = await bounded(f.ready); const result = await f.finish();
      assert.equal(result.code, 0, result.errors);
      assert.equal(result.signal, null);
      const expected = paths.map(path => readFileSync(join(f.dir, path)));
      assert.deepEqual(readFileSync(f.received), Buffer.concat(expected));
      const loaded = result.errors.trim().split('\n').map(line => JSON.parse(line)).filter(record => record.event === 'loaded');
      assert.deepEqual(loaded.map(record => record.fields.path), paths.map(path => join(realpathSync(f.dir), path)));
      assert.deepEqual(loaded.map(record => record.fields.bytes), expected.map(bytes => bytes.length));
      assert.equal(readFileSync(join(f.dir, 'ready.json.starts'), 'utf8').trim().split('\n').length, 1);
      assert.equal(gone(record.pid), true);
    });
  }
  for (const mode of ['missing', 'directory', 'empty', 'bad-header', 'oversize']) {
    test(`${label}: JPEG sequence rejects later ${mode} input before starting playback`, { skip: !supported, timeout: 12000 }, async t => {
      const f = fixture(t, entry, 'normal', 'play-jpegs');
      let later = join(f.dir, 'later.jpg');
      if (mode === 'directory') later = f.dir;
      if (mode === 'empty') writeFileSync(later, Buffer.alloc(0));
      if (mode === 'bad-header') writeFileSync(later, 'invalid');
      if (mode === 'oversize') writeFileSync(later, Buffer.alloc(512 * 1024 + 1));
      f.start([f.image, later]);
      const result = await f.finish();
      assert.equal(result.code, 1, result.errors);
      assert.equal(result.signal, null);
      assert.equal(existsSync(join(f.dir, 'ready.json.starts')), false);
      if (mode === 'missing') assert.match(result.errors, /ENOENT/);
    });
  }
  test(`${label}: JPEG sequence rejects 31 paths before reading a missing first file`, { skip: !supported, timeout: 12000 }, async t => {
    const f = fixture(t, entry, 'normal', 'play-jpegs');
    f.start(Array.from({ length: 31 }, () => join(f.dir, 'missing.jpg')));
    const result = await f.finish();
    assert.equal(result.code, 1, result.errors);
    assert.match(result.errors, /Expected 1 to 30 JPEG paths/);
    assert.doesNotMatch(result.errors, /ENOENT|"event":"loaded"/);
    assert.equal(existsSync(join(f.dir, 'ready.json.starts')), false);
  });
  for (const mode of ['spawn-failure', 'diagnostic', 'nonzero']) {
    test(`${label}: JPEG sequence reports player ${mode}`, { skip: !supported, timeout: 12000 }, async t => {
      const f = fixture(t, entry, mode, 'play-jpegs');
      if (mode === 'spawn-failure') unlinkSync(f.executable);
      f.start([f.image, f.image]);
      const result = await f.finish();
      assert.equal(result.code, 1, result.errors);
      assert.equal(result.signal, null);
      if (mode === 'spawn-failure') assert.match(result.errors, /ENOENT/);
      else {
        const record = await bounded(f.ready);
        assert.equal(gone(record.pid), true);
        if (mode === 'diagnostic') assert.match(result.errors, /decode failed/);
      }
    });
  }
  for (const [signal, mode] of [['SIGINT', 'ignore'], ['SIGTERM', 'hold']] as const) {
    test(`${label}: JPEG sequence ${signal} cleans up player ${mode}`, { skip: !supported, timeout: 12000 }, async t => {
      const f = fixture(t, entry, mode, 'play-jpegs');
      const cli = f.start([f.image, f.image]);
      const record = await bounded(f.ready);
      assert.equal(cli.kill(signal), true);
      const result = await f.finish();
      assert.equal(result.code, signal === 'SIGINT' ? 130 : 143, result.errors);
      assert.equal(result.signal, null);
      assert.equal(gone(record.pid), true);
    });
  }
  for (const size of ['fixture', 'limit'] as const) {
    test(`${label}: JPEG pipe preserves ${size} bytes and signals EOF`, { skip: !supported, timeout: 12000 }, async t => {
      const f = fixture(t, entry, 'normal', 'play-jpeg');
      if (size === 'limit') {
        const bytes = Buffer.alloc(512 * 1024); bytes[0] = 0xff; bytes[1] = 0xd8;
        writeFileSync(f.image, bytes);
      }
      f.start('- image with spaces.png');
      const record = await bounded(f.ready); const result = await f.finish();
      assert.equal(result.code, 0, result.errors); assert.equal(result.signal, null);
      assert.equal(record.args[record.args.indexOf('-i') + 1], 'pipe:0');
      assert.equal(record.args[record.args.indexOf('-f') + 1], 'image2pipe');
      assert.deepEqual(readFileSync(f.received), readFileSync(f.image));
      assert.match(result.errors, /"event":"loaded"/);
      assert.equal(gone(record.pid), true);
    });
  }
  for (const mode of ['missing', 'directory', 'empty', 'bad-header', 'oversize', 'spawn-failure', 'diagnostic', 'nonzero']) {
    test(`${label}: JPEG pipe rejects ${mode}`, { skip: !supported, timeout: 12000 }, async t => {
      const f = fixture(t, entry, mode, 'play-jpeg');
      let input = f.image;
      if (mode === 'missing') input = join(f.dir, 'missing.jpg');
      if (mode === 'directory') input = f.dir;
      if (mode === 'empty') writeFileSync(input, Buffer.alloc(0));
      if (mode === 'bad-header') writeFileSync(input, 'bad JPEG');
      if (mode === 'oversize') {
        const bytes = Buffer.alloc(512 * 1024 + 1); bytes[0] = 0xff; bytes[1] = 0xd8;
        writeFileSync(input, bytes);
      }
      if (mode === 'spawn-failure') unlinkSync(f.executable);
      f.start(input);
      const result = await f.finish();
      assert.equal(result.code, 1, result.errors); assert.equal(result.signal, null);
      if (!['diagnostic', 'nonzero'].includes(mode)) {
        assert.equal(existsSync(join(f.dir, 'ready.json')), false, 'invalid input must not launch player');
      }
      if (mode === 'missing' || mode === 'spawn-failure') assert.match(result.errors, /ENOENT/);
      if (mode === 'diagnostic') assert.match(result.errors, /decode failed/);
    });
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    for (const mode of ['hold', 'ignore']) {
      test(`${label}: JPEG pipe ${signal}, player ${mode}`, { skip: !supported, timeout: 12000 }, async t => {
        const f = fixture(t, entry, mode, 'play-jpeg'); const cli = f.start(f.image);
        const record = await bounded(f.ready);
        assert.equal(cli.kill(signal), true);
        const result = await f.finish();
        assert.equal(result.code, signal === 'SIGINT' ? 130 : 143, result.errors);
        assert.equal(result.signal, null);
        assert.equal(gone(record.pid), true);
      });
    }
  }
  test(`${label}: local paths, spaces and leading dash; ordinary close succeeds`, { skip: !supported, timeout: 12000 }, async t => {
    const f = fixture(t, entry); f.start('- image with spaces.png');
    const record = await bounded(f.ready); const result = await f.finish();
    assert.equal(result.code, 0, result.errors); assert.equal(result.signal, null);
    const index = record.args.indexOf('-i'); assert.ok(index >= 0);
    assert.equal(record.args[index + 1], realpathSync(f.image));
    assert.equal(gone(record.pid), true);
  });
  for (const mode of ['diagnostic', 'nonzero', 'spawn-failure', 'missing', 'directory', 'url', 'unreadable']) {
    test(`${label}: rejects ${mode}`, { skip: !supported, timeout: 12000 }, async t => {
      if (mode === 'unreadable' && process.getuid?.() === 0) { t.skip('root bypasses file read permissions'); return; }
      const f = fixture(t, entry, mode);
      let input = f.image;
      if (mode === 'missing') input = join(f.dir, 'absent.png');
      if (mode === 'directory') input = f.dir;
      if (mode === 'url') input = 'https://example.invalid/image.png';
      if (mode === 'unreadable') chmodSync(input, 0);
      if (mode === 'spawn-failure') unlinkSync(f.executable);
      f.start(input); const result = await f.finish();
      assert.equal(result.code, 1, result.errors); assert.equal(result.signal, null);
      if (['missing', 'directory', 'url', 'unreadable', 'spawn-failure'].includes(mode)) {
        assert.equal(existsSync(join(f.dir, 'ready.json')), false, 'invalid input must not launch player');
      }
      if (mode === 'diagnostic') assert.match(result.errors, /decode failed/);
    });
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    for (const mode of ['hold', 'ignore']) {
      test(`${label}: ${signal}, player ${mode}`, { skip: !supported, timeout: 12000 }, async t => {
        const f = fixture(t, entry, mode); const cli = f.start(f.image);
        const record = await bounded(f.ready); // Shim handlers are installed before this notification.
        assert.equal(cli.kill(signal), true);
        const result = await f.finish();
        assert.equal(result.signal, null, result.errors);
        assert.equal(result.code, signal === 'SIGINT' ? 130 : 143, result.errors);
        assert.equal(gone(record.pid), true, 'CLI must wait until its player is gone');
      });
    }
  }
}
