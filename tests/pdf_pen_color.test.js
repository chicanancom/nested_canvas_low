import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Vec2 } from '../src/engine/math.js';
import { Point2D, CatmullRomSpline } from '../src/engine/smoothing.js';

const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const App = vm.runInNewContext(
  source.slice(source.indexOf('class NestedCanvasApp'), source.indexOf('// Start Application')) + '\nNestedCanvasApp;',
  { Vec2, Point2D, CatmullRomSpline }
);

for (const color of ['#58a6ff', '#ffffff']) {
  test(`pen on PDF keeps the selected color ${color}`, () => {
    const pdf = { id: 'pdf', width: 650, height: 900, pdfData: { pageIndex: 2 } };
    const app = Object.assign(Object.create(App.prototype), {
      activeTool: 'pen', brushColor: color, brushSize: 3, brushType: 'solid',
      activePointers: new Map(), activeSessions: new Map(),
      canvas: { setPointerCapture() {} },
      camera: { zoom: 1.4, pan: { x: 30, y: 40 } },
      scene: { root: { id: 'root' }, screenToLocal: point => point },
      hitTestBoard: () => ({ node: pdf, action: 'resize', localPt: { x: 15, y: 20 } }),
      updateHierarchyTree() {}, updateNodeProperties() {}, requestRender() {},
    });
    app.onPointerDown({ pointerId: 1, pointerType: 'mouse', button: 0, clientX: 15, clientY: 20, pressure: 0.8 });
    assert.equal(app.selectedNodeId, 'pdf');
    assert.equal(app.activeTool, 'pen');
    assert.equal(app.isFocusMode, undefined);
    assert.equal(app.camera.zoom, 1.4);
    assert.deepEqual(app.camera.pan, { x: 30, y: 40 });
    const session = app.activeSessions.get(1);
    assert.equal(session.targetNodeId, 'pdf');
    assert.equal(session.pdfPageIndex, 2);
    assert.equal(session.color, color);
  });
}
