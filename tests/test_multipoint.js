// Test multi-point session handling and rendering logic
import { Vec2 } from '../src/engine/math.js';
import { SceneGraph, CanvasNode, Stroke } from '../src/engine/scene.js';
import { Point2D, CatmullRomSpline } from '../src/engine/smoothing.js';

console.log('Testing Multi-point Drawing Logic...');

// 1. Setup mock scene
const scene = new SceneGraph();
const root = scene.root;

// 2. Simulate activeSessions Map
const activeSessions = new Map();

// Finger 1 (e.g. pointerId: 1)
const pointer1 = 1;
const session1 = {
  pointerId: pointer1,
  targetNodeId: root.id,
  rawPoints: [new Point2D(100, 100, 0.8)],
  color: '#58a6ff',
  baseWidth: 3.0,
  brushType: 'solid',
  getSmoothedPoints() {
    return CatmullRomSpline.smooth(this.rawPoints, 4);
  }
};
activeSessions.set(pointer1, session1);

// Finger 2 (e.g. pointerId: 2) simultaneously!
const pointer2 = 2;
const session2 = {
  pointerId: pointer2,
  targetNodeId: root.id,
  rawPoints: [new Point2D(300, 100, 0.8)],
  color: '#3fb950',
  baseWidth: 5.0,
  brushType: 'neon',
  getSmoothedPoints() {
    return CatmullRomSpline.smooth(this.rawPoints, 4);
  }
};
activeSessions.set(pointer2, session2);

console.log(`Active sessions count: ${activeSessions.size} (Expected: 2)`);
if (activeSessions.size !== 2) throw new Error('Active sessions should have 2 concurrent pointers');

// 3. Move both fingers
session1.rawPoints.push(new Point2D(100, 150, 0.8), new Point2D(100, 200, 0.8));
session2.rawPoints.push(new Point2D(300, 150, 0.9), new Point2D(300, 200, 0.9));

console.log(`Pointer 1 raw points: ${session1.rawPoints.length}, smoothed: ${session1.getSmoothedPoints().length}`);
console.log(`Pointer 2 raw points: ${session2.rawPoints.length}, smoothed: ${session2.getSmoothedPoints().length}`);

// 4. Finger 1 lifts up
const smoothed1 = session1.getSmoothedPoints();
const stroke1 = new Stroke(smoothed1, session1.color, session1.baseWidth, session1.brushType);
root.addStroke(stroke1);
activeSessions.delete(pointer1);

console.log(`Pointer 1 committed. Remaining active: ${activeSessions.size} (Expected: 1)`);
if (activeSessions.size !== 1) throw new Error('Pointer 2 should still be actively drawing');
if (root.elements.length !== 1) throw new Error('Root should have 1 stroke');

// 5. Finger 2 lifts up
const smoothed2 = session2.getSmoothedPoints();
const stroke2 = new Stroke(smoothed2, session2.color, session2.baseWidth, session2.brushType);
root.addStroke(stroke2);
activeSessions.delete(pointer2);

console.log(`Pointer 2 committed. Remaining active: ${activeSessions.size} (Expected: 0)`);
console.log(`Total strokes in root: ${root.elements.length} (Expected: 2)`);
if (root.elements.length !== 2) throw new Error('Root should have 2 strokes');

console.log('✅ ALL MULTI-POINT DRAWING LOGIC TESTS PASSED!');
