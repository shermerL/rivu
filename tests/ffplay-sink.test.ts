import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_JPEG_BYTES, playJpeg } from '../src/node/ffplay-sink.js';

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
