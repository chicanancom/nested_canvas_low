import test from 'node:test';
import assert from 'node:assert/strict';
import { pickNativePdf } from '../src/storage/nativePdfImporter.js';

test('Android PDF import renders only the first page and releases the temporary document', async () => {
  const calls = [];
  const progress = [];
  const plugin = {
    async pick() { return { token: 'document', name: 'Bài học.pdf', pageCount: 200, source: 'pdf-bytes' }; },
    async renderPage(options) {
      calls.push(options);
      return { src: `data:image/jpeg;base64,page${options.pageIndex}`, width: 800, height: 1200 };
    },
    async release(options) { calls.push({ release: options.token }); },
  };
  const result = await pickNativePdf((current, total) => progress.push([current, total]), plugin);
  assert.equal(result.name, 'Bài học.pdf');
  assert.equal(result.pageCount, 200);
  assert.equal(result.source, 'pdf-bytes');
  assert.equal(result.page.width, 800);
  assert.deepEqual(calls, [{ token: 'document', pageIndex: 0 }, { release: 'document' }]);
  assert.deepEqual(progress, [[1, 200]]);
});
test('cancelling the Android picker adds no pages', async () => {
  assert.equal(await pickNativePdf(() => {}, {
    async pick() { return { cancelled: true }; },
    async renderPage() { assert.fail('cancel must not render'); },
    async release() { assert.fail('cancel has no temporary document'); },
  }), null);
});
test('render failure still releases native PDF and does not return a partial import', async () => {
  let released = false;
  await assert.rejects(pickNativePdf(() => {}, {
    async pick() { return { token: 'document', pageCount: 2 }; },
    async renderPage() { throw new Error('Invalid PDF page'); },
    async release() { released = true; },
  }), /Invalid PDF page/);
  assert.equal(released, true);
});
