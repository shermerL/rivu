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
fs.writeFileSync(process.env.TEST_READY + '.tmp', record);
fs.renameSync(process.env.TEST_READY + '.tmp', process.env.TEST_READY);
if (mode === 'normal') process.exit(0);
else if (mode === 'diagnostic') process.stderr.write('[error] decode failed\\n', () => process.exit(0));
else if (mode === 'nonzero') process.exit(7);
else setInterval(() => {}, 1000);
`;
type Ready = { pid: number; args: string[] };
function fixture(t: TestContext, entry: string, mode = 'normal') {
  const dir = mkdtempSync(join(tmpdir(), 'play image '));
  const image = join(dir, '- image with spaces.png'); writeFileSync(image, 'fixture');
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
    dir, image, executable, ready,
    start(input: string) {
      child = spawn(process.execPath, ['--import', loader, runner, 'play-image', input], {
        cwd: dir, env: { ...process.env, PATH: dir, TEST_ENTRY: entry, TEST_MODE: mode, TEST_READY: readyPath },
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
