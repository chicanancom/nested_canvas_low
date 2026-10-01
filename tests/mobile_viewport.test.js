import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
test('application height follows visible phone viewport when browser chrome changes', () => {
  const window = { innerHeight: 844, visualViewport: { height: 650 } };
  let appHeight;
  const document = { documentElement: { style: { setProperty(name, value) {
    assert.equal(name, '--app-viewport-height');
    appHeight = value;
  } } } };
  const App = vm.runInNewContext(source.slice(source.indexOf('class NestedCanvasApp'), source.indexOf('// Start Application')) + '\nNestedCanvasApp;', { window, document });
  const app = Object.assign(Object.create(App.prototype), { renderer: { resize() {} }, requestRender() {} });
  app.syncViewportHeight();
  assert.equal(appHeight, '650px');
  window.visualViewport.height = 780;
  app.syncViewportHeight();
  assert.equal(appHeight, '780px');
  delete window.visualViewport;
  app.syncViewportHeight();
  assert.equal(appHeight, '844px');
});
