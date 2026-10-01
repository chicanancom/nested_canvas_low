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

test('three touchscreen contacts erase at their center without moving or zooming the canvas', () => {
  const a = app();
  const erased = [];
  let finished = false;
  Object.assign(a, {
    activeTool: 'pen', eraserMode: 'segment', eraserRadius: 25,
    scene: { root: { id: 'root' } },
    hitTestBoard() { return null; },
    performErase(point, node, mode) { erased.push({ point, node, mode }); },
    finishEraseSession() { finished = true; },
    requestRender() {}, scheduleContentSave() {},
  });
  const contacts = (offset) => [
    { clientX: offset, clientY: 0 },
    { clientX: offset + 30, clientY: 0 },
    { clientX: offset + 60, clientY: 0 },
  ];
  const event = (touches) => ({ touches, cancelable: true, preventDefault() {} });
  a.onTouchStart(event(contacts(0)));
  a.onTouchMove(event(contacts(30)));
  assert.equal(a.touchGestureMode, 'erase3');
  assert.equal(erased.at(-1).point.x, 60);
  assert.equal(erased.at(-1).mode, 'eraser-segment');
  assert.equal(a.camera.zoom, 1);
  assert.equal(a.camera.pan.x, 0);
  a.onTouchEnd(event([]));
  assert.equal(finished, true);
});

test('multi-point drawing keeps a stroke session for each touch pointer', () => {
  const a = app();
  Object.assign(a, {
    activePointers: new Map(), activeSessions: new Map(),
    isMultiPointMode: true, isPinching: false, touchGestureMode: null,
    activeTool: 'pen', scene: new SceneGraph(), brushColor: '#fff', brushSize: 4, brushType: 'solid',
    canvas: { style: {} }, hitTestBoard() { return null; },
    updateHierarchyTree() {}, updateNodeProperties() {}, requestRender() {},
  });
  const pointer = (id, x, primary) => ({ pointerId: id, pointerType: 'touch', isPrimary: primary, button: 0, clientX: x, clientY: 10, pressure: 0.8 });
  a.onPointerDown(pointer(1, 10, true));
  a.onPointerDown(pointer(2, 30, false));
  a.onPointerDown(pointer(3, 50, false));
  const touches = [10, 30, 50].map(clientX => ({ target: a.canvas, clientX, clientY: 10 }));
  a.performErase = () => assert.fail('multi-point pen must not erase');
  a.onTouchStart({ target: a.canvas, touches });
  a.onTouchMove({ target: a.canvas, touches });
  a.onTouchEnd({ target: a.canvas, touches: touches.slice(0, 2) });
  assert.equal(a.activeSessions.size, 3);
  assert.equal(a.touchGestureMode, null);
  assert.equal(a.camera.zoom, 1);
  assert.ok(a.activeSessions.has(1));
  assert.ok(a.activeSessions.has(2));
  assert.ok(a.activeSessions.has(3));
});

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

for (const multi of [false]) {
  test(`three contacts erase immediately and reserve gesture until all lift (multi=${multi})`, () => {
    const a = app();
    let erased = 0;
    let finished = 0;
    Object.assign(a, {
      isMultiPointMode: multi, activeTool: 'pen', eraserRadius: 18,
      scene: { root: { id: 'root' } },
      performErase() { erased++; }, requestRender() {},
      finishEraseSession() { finished++; }, scheduleContentSave() {},
    });
    const touches = [0, 30, 60].map(clientX => ({ clientX, clientY: 10 }));
    a.onTouchStart({ touches });
    assert.equal(erased, 1);
    assert.equal(a.touchGestureMode, 'erase3');
    assert.equal(a.activeTool, 'pen');
    a.onPointerMove({ pointerType: 'touch', pointerId: 1, clientX: 40, clientY: 10 });
    a.onTouchEnd({ touches: touches.slice(0, 2) });
    a.onTouchMove({ touches: touches.slice(0, 2) });
    assert.equal(a.camera.zoom, 1);
    assert.equal(a.isPinching, false);
    assert.equal(erased, 1);
    a.onTouchEnd({ touches: [] });
    assert.equal(finished, 1);
    assert.equal(a.touchGestureMode, null);
    assert.equal(a.eraserCursor, null);
  });
}

for (const multi of [false, true]) {
  test(`toolbar and modal touches keep default click actions (multi=${multi})`, () => {
    const a = app();
    const canvas = {};
    Object.assign(a, { canvas, isMultiPointMode: multi, touchGestureMode: null });
    for (const target of [{ tagName: 'BUTTON' }, { tagName: 'INPUT' }, { tagName: 'SELECT' }]) {
      const event = {
        target, touches: [{ target, clientX: 10, clientY: 10 }], cancelable: true,
        preventDefault() { assert.fail('UI touch must not have its default click cancelled'); },
      };
      a.onTouchStart(event);
      a.onTouchMove(event);
      a.onTouchEnd({ ...event, touches: [] });
      a.onPointerUp({ target, pointerId: 42, pointerType: 'touch' });
      assert.equal(a.touchGestureMode, null);
    }
  });
}

test('touches on UI do not count toward a three-finger canvas eraser', () => {
  const a = app();
  const canvas = {};
  Object.assign(a, { canvas, isMultiPointMode: true });
  a.onTouchStart({ target: canvas, touches: [
    { target: canvas, clientX: 10, clientY: 10 },
    { target: canvas, clientX: 20, clientY: 10 },
    { target: {}, clientX: 30, clientY: 10 },
  ] });
  assert.notEqual(a.touchGestureMode, 'erase3');
});

for (const fingers of [2, 3, 5]) {
  test(`native multi-touch tracks ${fingers} independent strokes through movement and lifting`, () => {
    const a = app();
    const history = new HistoryManager();
    Object.assign(a, {
      useNativeMultiTouch: true, isMultiPointMode: true,
      activePointers: new Map(), activeSessions: new Map(),
      activeTool: 'pen', scene: new SceneGraph(), brushColor: '#fff', brushSize: 4, brushType: 'solid',
      canvas: { style: {}, releasePointerCapture() {} },
      hitTestBoard() { return { action: 'resize' }; },
      updateHierarchyTree() {}, updateNodeProperties() {}, requestRender() {},
      getSharedRootForNode() { return null; }, finishEraseSession() {},
      executeCommand(command) { history.execute(command, this.scene); },
    });
    const contacts = Array.from({ length: fingers }, (_, identifier) => ({
      identifier, target: a.canvas, clientX: identifier * 50 + 20, clientY: 20,
    }));
    const event = changedTouches => ({ target: a.canvas, changedTouches, cancelable: true, preventDefault() {} });
    for (const touch of contacts) {
      a.onPointerDown({ target: a.canvas, pointerType: 'touch', pointerId: touch.identifier, clientX: touch.clientX, clientY: touch.clientY });
      a.onTouchStart(event([touch]));
    }
    assert.equal(a.activeSessions.size, fingers);
    a.onTouchMove(event(contacts.map(touch => ({ ...touch, clientY: 50 }))));
    for (const touch of contacts) {
      const points = a.activeSessions.get(`touch:${touch.identifier}`).rawPoints;
      assert.equal(points.length, 2);
      assert.equal(points[0].x, points[1].x);
      assert.notEqual(points[0].y, points[1].y);
    }
    a.onTouchEnd(event([{ ...contacts[0], clientY: 50 }]));
    assert.equal(a.scene.root.elements.length, 1);
    assert.equal(a.activeSessions.size, fingers - 1);
    a.onTouchMove(event(contacts.slice(1).map(touch => ({ ...touch, clientY: 80 }))));
    a.onTouchEnd(event(contacts.slice(1).map(touch => ({ ...touch, clientY: 80 }))));
    assert.equal(a.scene.root.elements.length, fingers);
    assert.equal(a.activeSessions.size, 0);
    assert.equal(a.activePointers.size, 0);
    assert.equal(a.camera.zoom, 1);
    assert.equal(a.isResizing, undefined);
    assert.notEqual(a.touchGestureMode, 'erase3');
    history.undo(a.scene);
    assert.equal(a.scene.root.elements.length, fingers - 1);
  });
}
