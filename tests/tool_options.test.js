import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
function element(dataset = {}) {
  const classes = new Set();
  return {
    dataset, style: {}, hidden: false, attributes: {},
    classList: { toggle(name, on) { on ? classes.add(name) : classes.delete(name); }, contains(name) { return classes.has(name); } },
    setAttribute(name, value) { this.attributes[name] = value; },
  };
}
test('pen, both erasers and pan show the correct options in workspace and shared mobile UI', () => {
  const penOptions = [element(), element(), element()];
  const erasers = [element(), element()];
  const modes = [element({ eraserMode: 'object' }), element({ eraserMode: 'segment' })];
  const ids = Object.fromEntries(['bottom-bar', 'mobile-palette-drawer', 'mobile-tool-pen', 'mobile-tool-eraser', 'mobile-tool-pan', 'mobile-tool-brush-toggle', 'mobile-btn-palette-toggle'].map(id => [id, element()]));
  ids['bottom-bar'].querySelectorAll = () => penOptions;
  const document = {
    getElementById: id => ids[id],
    querySelectorAll: selector => selector === '.eraser-controls' ? erasers : selector === '[data-eraser-mode]' ? modes : [],
  };
  const App = vm.runInNewContext(source.slice(source.indexOf('class NestedCanvasApp'), source.indexOf('// Start Application')) + '\nNestedCanvasApp;', { document });
  const app = Object.assign(Object.create(App.prototype), { canvas: { style: {} } });
  app.setTool('eraser');
  assert.equal(app.activeTool, 'eraser-segment');
  for (const tool of ['pen', 'eraser-object', 'eraser-segment', 'pan', 'pen']) {
    app.setTool(tool);
    const pen = tool === 'pen';
    const eraser = tool.startsWith('eraser');
    assert.equal(ids['bottom-bar'].style.display, pen || eraser ? 'flex' : 'none');
    assert.equal(ids['bottom-bar'].classList.contains('hidden-bar'), !pen && !eraser);
    assert.ok(penOptions.every(el => el.hidden === !pen));
    assert.ok(erasers.every(el => el.hidden === !eraser));
    assert.equal(ids['mobile-palette-drawer'].style.display, pen ? 'flex' : 'none');
    assert.equal(ids['mobile-tool-brush-toggle'].hidden, !pen);
    for (const button of modes) assert.equal(button.attributes['aria-pressed'], String(eraser && tool === `eraser-${button.dataset.eraserMode}`));
  }
});
