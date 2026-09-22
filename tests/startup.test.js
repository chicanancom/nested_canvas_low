import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { SceneGraph } from '../src/engine/scene.js';
import { Camera } from '../src/engine/math.js';

const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
let created;
const elements = new Map();
const document = { getElementById(id) {
  if (!elements.has(id)) elements.set(id, { style: {}, hidden: false, textContent: '' });
  return elements.get(id);
} };
const App = vm.runInNewContext(
  source.slice(source.indexOf('class NestedCanvasApp'), source.indexOf('// Start Application')) + '\nNestedCanvasApp;',
  {
    generateUUID: () => 'fresh-page', console, document,
    db: { async init() {} },
    SessionManager: class {
      async createSession(name, content) {
        created = { name, content };
        return { meta: { id: 'new-session', name } };
      }
    },
  },
);

test('startup shows session choices without creating or restoring a saved session', async () => {
  const app = Object.assign(Object.create(App.prototype), {
    scene: new SceneGraph(), camera: new Camera(), pages: [],
    currentPageIndex: 4, selectedNodeId: 'old-selection',
    loadState() { throw new Error('Must not restore old workspace'); },
    updateActiveSessionUI() {}, updatePageIndicator() {}, renderSessionsGrid() {},
  });
  app.initDefaultScene();
  assert.equal(app.pages.length, 1);
  assert.equal(app.currentPageIndex, 0);
  assert.equal(app.selectedNodeId, null);
  await app.initSessionStorage();
  assert.equal(created, undefined);
  assert.equal(app.awaitingSessionChoice, true);
  assert.equal(document.getElementById('modal-sessions').style.display, 'flex');
  assert.equal(document.getElementById('btn-close-sessions-modal').hidden, true);
  // A second startup still adds no empty entries to the library.
  await app.initSessionStorage();
  assert.equal(created, undefined);
  app.setDisplayMode = mode => assert.equal(mode, 'single');
  app.completeSessionChoice();
  assert.equal(app.awaitingSessionChoice, false);
  assert.equal(document.getElementById('modal-sessions').style.display, 'none');
});

test('explicit shared-board link still restores its own board', () => {
  let restored = false;
  const app = Object.assign(Object.create(App.prototype), {
    isSingleBoardMode: true,
    loadState() { restored = true; return true; },
  });
  app.initDefaultScene();
  assert.equal(restored, true);
});
