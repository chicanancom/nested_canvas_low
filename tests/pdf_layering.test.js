import test from 'node:test';
import assert from 'node:assert/strict';
import { AABB, Transform2D } from '../src/engine/math.js';
import { CanvasRenderer } from '../src/engine/renderer.js';

test('PDF pages cover every mother-canvas stroke, including strokes added later', () => {
  const order = [];
  const renderer = Object.assign(Object.create(CanvasRenderer.prototype), {
    stats: { renderedNodes: 0, culledNodes: 0, renderedStrokes: 0, culledStrokes: 0 },
    drawImageNode(_ctx, node) { order.push(node.id); },
    drawStroke(_ctx, stroke) { order.push(stroke.id); },
  });
  const stroke = id => ({ id, bounds: new AABB(1, 1, 2, 2) });
  const pdf = (id, below) => ({
    id, image: {}, pdfData: { strokeIdsBelow: below }, elements: [],
    transform: Transform2D.identity(), localBounds: () => new AABB(0, 0, 100, 100),
  });
  const scene = {
    elements: [stroke('old'), stroke('annotation'), stroke('latest')],
    children: [pdf('first-pdf', ['old']), pdf('second-pdf', ['old', 'annotation'])],
  };
  renderer.renderNode({}, scene, { zoom: 1 }, Transform2D.identity(),
    new AABB(0, 0, 200, 200), null, true, null, null);
  assert.deepEqual(order, ['old', 'annotation', 'latest', 'first-pdf', 'second-pdf']);
});

test('PDF page strokes and live pen use PDF coordinates and are clipped to the page', () => {
  const calls = [];
  const ctx = {
    save() { calls.push('save'); }, beginPath() {},
    rect(x, y, width, height) { calls.push(['rect', x, y, width, height]); },
    clip() { calls.push('clip'); }, restore() { calls.push('restore'); },
  };
  const renderer = Object.assign(Object.create(CanvasRenderer.prototype), {
    stats: { renderedNodes: 0, culledNodes: 0, renderedStrokes: 0, culledStrokes: 0 },
    drawImageNode() { calls.push('image'); },
    drawStroke(_ctx, stroke, transform) { calls.push(['stroke', stroke.id, transform.tx, transform.ty]); },
  });
  const pdf = {
    id: 'pdf', image: {}, pdfData: { pageIndex: 0, strokeIdsBelow: [] },
    elements: [{ id: 'saved' }],
    transform: Transform2D.fromTranslation(20, 30),
    localBounds: () => new AABB(0, 0, 100, 80),
  };
  renderer.renderNode(ctx, { elements: [], children: [pdf] }, { zoom: 1 },
    Transform2D.identity(), new AABB(0, 0, 200, 200), null, true, null,
    [{ targetNodeId: 'pdf', pdfPageIndex: 0, rawPoints: [{ x: 5, y: 6 }], color: '#000', baseWidth: 3 }]);
  assert.deepEqual(calls.filter(call => Array.isArray(call) && call[0] === 'stroke'), [
    ['stroke', 'saved', 20, 30], ['stroke', undefined, 20, 30],
  ]);
  assert.equal(calls.filter(call => call === 'clip').length, 2);
});
