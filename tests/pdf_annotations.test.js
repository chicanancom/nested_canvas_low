import test from 'node:test';
import assert from 'node:assert/strict';
import { CanvasNode, SceneGraph, Stroke } from '../src/engine/scene.js';
import { Point2D } from '../src/engine/smoothing.js';
import { AddStrokeCommand, EraseCommand, HistoryManager } from '../src/engine/history.js';

test('PDF annotations belong to their page and survive save, undo, and redo', () => {
  const scene = new SceneGraph();
  const pdf = new CanvasNode('PDF', 650, 900);
  pdf.pdfData = { name: 'PDF', source: 'bytes', pageCount: 2, pageIndex: 0 };
  scene.root.addChild(pdf);
  const history = new HistoryManager();
  const first = new Stroke([new Point2D(20, 30)], '#000000');
  const second = new Stroke([new Point2D(40, 50)], '#000000');

  history.execute(new AddStrokeCommand(pdf.id, first, 0), scene);
  pdf.showPdfPage(1);
  assert.equal(pdf.elements.length, 0);
  history.execute(new AddStrokeCommand(pdf.id, second, 1), scene);
  pdf.showPdfPage(0);
  assert.deepEqual(pdf.elements.map(stroke => stroke.id), [first.id]);

  history.undo(scene);
  assert.deepEqual(pdf.elements.map(stroke => stroke.id), [first.id]);
  pdf.showPdfPage(1);
  assert.equal(pdf.elements.length, 0);
  history.redo(scene);
  assert.deepEqual(pdf.elements.map(stroke => stroke.id), [second.id]);

  history.execute(new EraseCommand(pdf.id, [second], [], 1), scene);
  assert.equal(pdf.elements.length, 0);
  pdf.showPdfPage(0);
  history.undo(scene);
  pdf.showPdfPage(1);
  assert.deepEqual(pdf.elements.map(stroke => stroke.id), [second.id]);

  const saved = scene.toJSON();
  const restored = new SceneGraph();
  restored.loadFromJSON(saved);
  const restoredPdf = restored.getNode(pdf.id);
  restoredPdf.showPdfPage(0);
  assert.deepEqual(restoredPdf.elements.map(stroke => stroke.id), [first.id]);
  restoredPdf.showPdfPage(1);
  assert.deepEqual(restoredPdf.elements.map(stroke => stroke.id), [second.id]);
});
