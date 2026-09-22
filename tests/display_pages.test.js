import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { CanvasNode, SceneGraph, Stroke } from '../src/engine/scene.js';
import { Camera, Vec2 } from '../src/engine/math.js';

// Exercise the real display handlers without starting a browser or LAN server.
let overlayHost = null;
const source = readFileSync(new URL('../src/display.js', import.meta.url), 'utf8');
const Display = vm.runInNewContext(
  source.slice(source.indexOf('class PCDisplayApp'), source.indexOf('function initDisplay')) + '\nPCDisplayApp;',
  {
    SceneGraph, Stroke, Camera, Vec2, console,
    document: {
      getElementById() { return overlayHost; },
      createElement() { return { dataset: {}, style: {}, remove() {
        overlayHost.frames = overlayHost.frames.filter(frame => frame !== this);
      } }; },
    },
    window: { innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 2, location: { origin: "http://localhost" } },
    SyncClient: class {
      handlers = new Map();
      on(type, callback) { this.handlers.set(type, callback); }
      connect() {}
    },
  },
);
function stroke(id) {
  return { id, points: [{ x: 0, y: 0, pressure: 1 }, { x: 20, y: 20, pressure: 1 }], color: '#fff', baseWidth: 3 };
}
function scene(...ids) {
  const graph = new SceneGraph();
  graph.root.elements = ids.map(id => Stroke.fromJSON(stroke(id)));
  return graph.toJSON();
}
function display() {
  const app = Object.create(Display.prototype);
  Object.assign(app, {
    scene: new SceneGraph(), camera: new Camera(), currentPageIndex: 0,
    pages: [{ scene: scene('page-one') }, { scene: scene() }],
    remoteActiveSessions: new Map(),
  });
  for (const name of ['requestRender', 'scheduleRender', 'saveDisplayState', 'hideIdleOverlay',
    'updatePageUI', 'showPageTransitionBanner', 'fitSceneContent']) app[name] = () => {};
  app.initSync();
  return app;
}
test('switching to a blank page clears old live strokes and never restores cached ink', () => {
  const app = display();
  app.pages[1].scene = scene('stale-ink');
  app.applyStrokeLive({ clientId: 'pen', pageIndex: 0, session: { points: stroke('a').points } });
  app.syncClient.handlers.get('PAGE_SWITCH')({ currentPageIndex: 1, scene: scene() });
  assert.equal(app.currentPageIndex, 1);
  assert.equal(app.scene.root.elements.length, 0);
  assert.equal(app.remoteActiveSessions.size, 0);
  app.applyStrokeLive({ clientId: 'pen', pageIndex: 0, session: { points: stroke('a').points, isDelta: true } });
  assert.equal(app.remoteActiveSessions.size, 0);
});
test('late completed stroke updates its own page, never the selected page', () => {
  const app = display();
  app.syncClient.handlers.get('PAGE_SWITCH')({ currentPageIndex: 1, scene: scene() });
  app.applyStrokeAdd({ clientId: 'pen', pageIndex: 0, stroke: stroke('late') });
  assert.equal(app.scene.root.elements.length, 0);
  assert.deepEqual(app.getPageScene(app.pages[0]).root.elements.map(s => s.id), ['page-one', 'late']);
});
test('page-only switch loads the selected page rather than retaining previous scene', () => {
  const app = display();
  app.scene.loadFromJSON(scene('old'));
  app.syncClient.handlers.get('PAGE_SWITCH')({ currentPageIndex: 1 });
  assert.equal(app.scene.root.elements.length, 0);
});
test('adding a stroke invalidates the current page cache', () => {
  const app = display();
  app.scene.loadFromJSON(scene('latest'));
  app.getPageScene(app.pages[0]);
  app.applyStrokeAdd({ pageIndex: 0, stroke: stroke('new') });
  assert.deepEqual(app.getPageScene(app.pages[0]).root.elements.map(s => s.id), ['latest', 'new']);
});
test('server routes delayed strokes without polluting the active scene', () => {
  const server = readFileSync(new URL('../server/sync_server.js', import.meta.url), 'utf8');
  const start = server.indexOf("if (type === 'CANVAS_STROKE_ADD')");
  const end = server.indexOf("if (type === 'CANVAS_STROKE_ERASE')", start);
  const context = {
    type: 'CANVAS_STROKE_ADD', data: { pageIndex: 0, stroke: stroke('late') },
    lastCanvasPageIndex: 1, lastCanvasScene: scene(),
    lastCanvasPages: [{ scene: scene() }, { scene: scene() }],
    currentActiveSessionContent: { currentPageIndex: 1, scene: scene(), pages: [{ scene: scene() }, { scene: scene() }] },
    clientIp: 'test', ws: {}, console, scheduleSaveState() {}, broadcastToAll() {},
  };
  vm.runInNewContext('(function () {' + server.slice(start, end) + '})()', context);
  assert.equal(context.lastCanvasScene.root.elements.length, 0);
  assert.equal(context.currentActiveSessionContent.scene.root.elements.length, 0);
  assert.equal(context.lastCanvasPages[0].scene.root.elements[0].id, 'late');
  assert.equal(context.currentActiveSessionContent.pages[0].scene.root.elements[0].id, 'late');
});

test('add page sends PAGE_SWITCH immediately and display selects the blank page', () => {
  const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const App = vm.runInNewContext(
    appSource.slice(appSource.indexOf('class NestedCanvasApp'), appSource.indexOf('// Start Application')) + '\nNestedCanvasApp;',
    { SceneGraph, Camera, Vec2, console },
  );
  const screen = display();
  const app = Object.create(App.prototype);
  Object.assign(app, {
    scene: new SceneGraph(), camera: new Camera(), pages: [], currentPageIndex: 0,
    activeSessions: new Map([['pointer', {}]]), remoteActiveSessions: new Map(),
    history: { clear() {} }, renderer: { render() {} },
    syncClient: {
      isConnected: true,
      send(type, data) { screen.syncClient.handlers.get(type)?.(data); },
    },
  });
  for (const name of ['requestRender', 'updateZoomHUD', 'updatePageIndicator', 'updateHierarchyTree', 'updateUI',
    'updateOcrPillPosition', 'broadcastCurrentCameraSync', 'scheduleContentSave', 'showToast']) app[name] = () => {};
  app.scene.loadFromJSON(scene('original'));
  app.addNewPage();
  assert.equal(app.currentPageIndex, 1);
  assert.equal(screen.currentPageIndex, 1);
  assert.equal(screen.scene.root.elements.length, 0);
  assert.equal(app.activeSessions.size, 0);
  app.switchToPage(0);
  assert.equal(screen.currentPageIndex, 0);
  assert.deepEqual(screen.scene.root.elements.map(s => s.id), ['original']);
  app.switchToPage(1);
  assert.equal(screen.currentPageIndex, 1);
  assert.equal(screen.scene.root.elements.length, 0);
});

test('fixed selection stays on selected page IDs after navigation and reordering', () => {
  const app = display();
  app.pages[0].id = 'a';
  app.pages[1].id = 'b';
  app.displayMode = 'grid';
  app.applyDisplaySelection({ mode: 'fixed', pageIds: ['a'] });
  let rendered;
  app.renderPageTiles = indices => { rendered = [...indices]; };
  app.syncClient.handlers.get('PAGE_SWITCH')({ currentPageIndex: 1, scene: scene() });
  app._doRender();
  assert.deepEqual(rendered, [0]);
  app.pages.reverse();
  app._doRender();
  assert.deepEqual(rendered, [1]);
  app.applyDisplaySelection({ mode: 'fixed', pageIds: [] });
  app._doRender();
  assert.deepEqual(rendered, []);
});

test('tile layout fills screen height and leaves only narrow gutters', () => {
  const app = display();
  const viewports = [];
  app.renderer = {
    ctx: new Proxy({}, { get: (target, key) => target[key] ?? (() => {}) }),
    render(...args) { viewports.push(args[8].viewport); },
  };
  app.drawViewportBadge = () => {};
  app.renderPageTiles([0, 1], 2);
  assert.equal(viewports.length, 2);
  assert.equal(viewports[0].x, 5);
  assert.equal(viewports[1].x - (viewports[0].x + viewports[0].width), 8);
  assert.equal(viewports[1].x + viewports[1].width, 1915);
  assert.equal(viewports[0].y + viewports[0].height, 1075);
});

test('quad layout fills screen with 2x2 grid (4 viewports)', () => {
  const app = display();
  const viewports = [];
  app.renderer = {
    ctx: new Proxy({}, { get: (target, key) => target[key] ?? (() => {}) }),
    render(...args) { viewports.push(args[8].viewport); },
  };
  app.drawViewportBadge = () => {};
  app.displayMode = 'quad';
  app._renderQuadMode();
  assert.equal(viewports.length, 4);
  assert.equal(viewports[0].x, viewports[2].x);
  assert.equal(viewports[1].x, viewports[3].x);
  assert.ok(viewports[2].y > viewports[0].y);
});

for (const mode of ['dual', 'quad', 'grid']) {
  test(`${mode}: navigating retains visible YouTube players on other displayed pages`, () => {
    const app = display();
    const video = new CanvasNode('Video', 640, 360);
    video.youtubeData = { videoId: 'abcdefghijk' };
    app.scene.root.addChild(video);
    app.pages[0] = { id: 'video-page', scene: app.scene.toJSON() };
    app.pages[1].id = 'blank-page';
    app.displayMode = mode;
    app.camera = new Camera(0, 0, 1, 1920, 1080);
    app.renderer = {
      ctx: new Proxy({}, { get: (target, key) => target[key] ?? (() => {}) }),
      render() {},
    };
    app.drawViewportBadge = () => {};
    overlayHost = {
      frames: [],
      appendChild(frame) { this.frames.push(frame); },
      querySelector(selector) { return this.frames.find(frame => selector.includes(frame.dataset.nodeId)); },
      querySelectorAll() { return this.frames; },
    };
    try {
      app._doRender();
      const frame = overlayHost.frames[0];
      assert.ok(frame);
      const src = frame.src;
      app.syncClient.handlers.get('PAGE_SWITCH')({ currentPageIndex: 1, scene: scene() });
      app._doRender();
      assert.equal(overlayHost.frames[0], frame);
      assert.equal(frame.src, src);
      assert.equal(frame.style.visibility, 'visible');
      // The inactive page uses its fitted tile camera, just like the canvas.
      const view = app.youtubeViews[0];
      const point = view.camera.worldToScreen(new Vec2(0, 0));
      assert.equal(parseFloat(frame.style.left), point.x + view.viewport.x);
      assert.equal(parseFloat(frame.style.top), point.y + view.viewport.y);
      for (const fixedMode of ['single', 'dual', 'quad', 'grid']) {
        app.displayMode = fixedMode;
        app.applyDisplaySelection({ mode: 'fixed', pageIds: ['video-page'] });
        app._doRender();
        assert.equal(overlayHost.frames[0], frame);
        assert.equal(frame.style.visibility, 'visible');
      }
      app.applyDisplaySelection({ mode: 'fixed', pageIds: ['blank-page'] });
      app._doRender();
      assert.equal(frame.style.visibility, 'hidden');
      app.applyDisplaySelection({ mode: 'fixed', pageIds: ['video-page'] });
      app._doRender();
      assert.equal(overlayHost.frames[0], frame);
      assert.equal(frame.style.visibility, 'visible');
      app.pages[0].scene = scene();
      app._doRender();
      assert.equal(overlayHost.frames.length, 0);
    } finally {
      overlayHost = null;
    }
  });
}
