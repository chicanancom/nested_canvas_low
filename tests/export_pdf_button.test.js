import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const button = { disabled: false };
const App = vm.runInNewContext(
  source.slice(source.indexOf('class NestedCanvasApp'), source.indexOf('// Start Application')) + '\nNestedCanvasApp;',
  { document: { getElementById: () => button }, console }
);

test('PDF button exports all pages with the latest drawing on the current page', async () => {
  const calls = [];
  const app = Object.assign(Object.create(App.prototype), {
    sessionStorageReady: Promise.resolve(),
    pages: [
      { name: 'Trang 1', scene: { root: { old: true } } },
      { name: 'Trang 2', scene: { root: { old: true } } },
    ],
    currentPageIndex: 1,
    scene: { root: { style: 'chalkboard', gridType: 'grid' }, toJSON: () => ({ root: { latest: true } }) },
    camera: { zoom: 2, pan: { x: 12, y: 30 } },
    sessionManager: {
      getCurrentSessionId: () => 'current',
      getCurrentSessionMeta: () => ({ name: 'Bài giảng' }),
      exportSessionPDF: async (...args) => { calls.push(args); return true; },
    },
    showToast() {},
  });

  await app.exportPDF();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'current');
  assert.equal(calls[0][3], 'Bài giảng');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][2].pages.map(page => page.scene.root))), [
    { old: true }, { latest: true },
  ]);
  assert.equal(button.disabled, false);
});
