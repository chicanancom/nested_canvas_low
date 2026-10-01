import test from 'node:test';
import assert from 'node:assert/strict';
import { changePdfPage } from '../src/engine/pdfBoards.js';
import { CanvasNode } from '../src/engine/scene.js';
import { encodePdfSource, decodePdfSource } from '../src/storage/pdfSource.js';
import { renderNativePdfPage } from '../src/storage/nativePdfImporter.js';

class TestImage {
  set src(value) { this._src = value; queueMicrotask(() => this.onload?.()); }
  get src() { return this._src; }
}
function fixture() {
  const node = { id: 'pdf', width: 650, height: 900, image: 'first-page', pdfData: { name: 'Tài liệu', source: 'pdf-bytes', pageIndex: 0, pageCount: 200 }, showPdfPage(index) { this.pdfData.pageIndex = index; } };
  let saves = 0;
  const app = {
    scene: { getNode: id => id === node.id ? node : null },
    scheduleContentSave() { saves++; }, updateUI() {}, requestRender() {}, broadcastCanvasMirror() {},
  };
  return { node, app, saves: () => saves };
}
test('PDF navigation renders only the requested page in the same board', async () => {
  const previous = globalThis.Image;
  globalThis.Image = TestImage;
  try {
    const { app, node, saves } = fixture();
    const calls = [];
    await changePdfPage(app, node.id, 1, async (source, index) => {
      calls.push([source, index]);
      return { src: 'second-page', width: 1000, height: 1500 };
    });
    assert.deepEqual(calls, [['pdf-bytes', 1]]);
    assert.equal(node.pdfData.pageIndex, 1);
    assert.equal(node.image.src, 'second-page');
    assert.equal(node.height, 975);
    assert.equal(node.name, '📄 Tài liệu · 2/200');
    assert.equal(saves(), 1);
    await changePdfPage(app, node.id, -1, () => assert.fail('out of range must not render'));
    await changePdfPage(app, node.id, 200, () => assert.fail('out of range must not render'));
    assert.equal(node.pdfLoading, false);
  } finally { globalThis.Image = previous; }
});
test('render failure preserves the current page and allows retry', async () => {
  const { app, node, saves } = fixture();
  await assert.rejects(changePdfPage(app, node.id, 1, async () => { throw new Error('bad page'); }), /bad page/);
  assert.equal(node.pdfData.pageIndex, 0);
  assert.equal(node.image, 'first-page');
  assert.equal(node.pdfLoading, false);
  assert.equal(saves(), 0);
});
test('saved PDF source and current page survive scene serialization', () => {
  const previousImage = globalThis.Image;
  const previousElement = globalThis.HTMLImageElement;
  globalThis.Image = globalThis.HTMLImageElement = TestImage;
  try {
    const bytes = new Uint8Array([0, 255, 37, 80, 68, 70]);
    const node = new CanvasNode('PDF', 650, 900);
    node.pdfData = { name: 'PDF', source: encodePdfSource(bytes), pageIndex: 3, pageCount: 200 };
    const restored = CanvasNode.fromJSON(JSON.parse(JSON.stringify(node.toJSON())));
    assert.deepEqual(restored.pdfData, node.pdfData);
    assert.deepEqual(decodePdfSource(restored.pdfData.source), bytes);
  } finally {
    globalThis.Image = previousImage;
    globalThis.HTMLImageElement = previousElement;
  }
});
test('Android can render another page from persisted PDF bytes after picker cleanup', async () => {
  const result = await renderNativePdfPage('saved-pdf', 12, {
    async renderPage(options) {
      assert.deepEqual(options, { source: 'saved-pdf', pageIndex: 12 });
      return { src: 'page-13' };
    },
  });
  assert.equal(result.src, 'page-13');
});
