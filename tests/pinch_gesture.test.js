import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { Camera, Vec2 } from '../src/engine/math.js';
import { SceneGraph, Stroke } from '../src/engine/scene.js';
import { Point2D, CatmullRomSpline } from '../src/engine/smoothing.js';
import { AddStrokeCommand, HistoryManager } from '../src/engine/history.js';
import { CanvasRenderer } from '../src/engine/renderer.js';

const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const App = vm.runInNewContext(
  source.slice(source.indexOf('class NestedCanvasApp'), source.indexOf('// Start Application')) + '\nNestedCanvasApp;',
  { Vec2, Camera, Stroke, Point2D, CatmullRomSpline, AddStrokeCommand },
);
function app() {
  return Object.assign(Object.create(App.prototype), {
    activePointers: new Map([[1, new Vec2(0, 0)]]), activeSessions: new Map(),
    camera: new Camera(), lastPointerScreen: new Vec2(), isMultiPointMode: false,
    updateZoomHUD() {}, broadcastCurrentCameraSync() {},
  });
}
test('second pointer begins pinch and moving it doubles zoom without TypeError', () => {
  const a = app();
  a.onPointerDown({ pointerId: 2, clientX: 100, clientY: 0, pointerType: 'touch', isPrimary: true });
  assert.equal(a.initialPinchDistance, 100);
  assert.equal(a.isPinching, true);
  a.onPointerMove({ pointerId: 2, clientX: 200, clientY: 0 });
  assert.equal(a.camera.zoom, 2);
  assert.ok(Number.isFinite(a.camera.pan.x));
});
for (const isPinching of [true, false]) {
  test(`pinch initializes from two Vec2 positions (isPinching=${isPinching})`, () => {
    const a = app();
    a.isPinching = isPinching;
    a.activePointers.set(2, new Vec2(100, 0));
    a.onPointerMove({ pointerId: 2, clientX: 100, clientY: 0 });
    a.onPointerMove({ pointerId: 2, clientX: 150, clientY: 0 });
    assert.equal(a.camera.zoom, 1.5);
  });
}

test('tap without movement previews, commits, syncs and supports undo/redo', () => {
  const a = app();
  const packets = [];
  const history = new HistoryManager();
  Object.assign(a, {
    activePointers: new Map(), scene: new SceneGraph(), activeTool: 'pen',
    brushColor: '#fff', brushSize: 4, brushType: 'solid',
    canvas: { style: {}, releasePointerCapture() {} },
    clientId: 'test', currentPageIndex: 0,
    hitTestBoard() { return null; }, updateHierarchyTree() {}, updateNodeProperties() {},
    getSharedRootForNode() { return null; },
    requestRender() { assert.equal(this.activeSessions.get(1).rawPoints.length, 1); },
    executeCommand(cmd) { history.execute(cmd, this.scene); },
    syncClient: { isConnected: true, send(type, data) { packets.push({ type, data }); } },
  });
  const event = { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, clientX: 100, clientY: 100, pressure: 0.8 };
  a.onPointerDown(event);
  assert.equal(packets[0].type, 'CANVAS_STROKE_LIVE');
  a.onPointerUp(event);
  assert.equal(a.scene.root.elements.length, 1);
  assert.equal(a.scene.root.elements[0].points.length, 1);
  assert.equal(packets.find(p => p.type === 'CANVAS_STROKE_ADD').data.stroke.points.length, 1);
  history.undo(a.scene);
  assert.equal(a.scene.root.elements.length, 0);
  history.redo(a.scene);
  assert.equal(a.scene.root.elements.length, 1);
});

test('single-point stroke draws a filled dot at transformed coordinates', () => {
  let circle, filled = false;
  const ctx = { save() {}, restore() {}, beginPath() {}, arc(...args) { circle = args; }, fill() { filled = true; } };
  CanvasRenderer.prototype.drawStroke(ctx, { points: [{ x: 10, y: 20 }], color: '#fff', baseWidth: 4 },
    { a: 2, b: 0, c: 0, d: 2, tx: 3, ty: 4 });
  assert.deepEqual(circle.slice(0, 3), [23, 44, 4]);
  assert.equal(filled, true);
});
