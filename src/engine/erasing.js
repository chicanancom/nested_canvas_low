import { Stroke } from './scene.js';

export class EraserEngine {
  static eraseObjectInNode(node, localPos, radius) {
    const removedStrokes = [];
    const radiusSq = radius * radius;

    node.elements = node.elements.filter((stroke) => {
      const inflated = stroke.bounds.inflate(radius);
      if (!inflated.containsPoint(localPos)) return true;

      const dist = stroke.distanceToPoint(localPos);
      if (dist <= radius) {
        removedStrokes.push(stroke);
        return false;
      }
      return true;
    });
    return removedStrokes;
  }

  static eraseSegmentInNode(node, localPos, radius) {
    const removedStrokes = [];
    const addedStrokes = [];
    const newElements = [];
    const radiusSq = radius * radius;

    for (const stroke of node.elements) {
      const inflated = stroke.bounds.inflate(radius);
      if (!inflated.containsPoint(localPos)) {
        newElements.push(stroke);
        continue;
      }

      if (stroke.distanceToPoint(localPos) > radius) {
        newElements.push(stroke);
        continue;
      }

      // Stroke is touched by eraser -> Split into surviving segments
      removedStrokes.push(stroke);
      const subSegments = [];
      let currentRun = [];

      for (const p of stroke.points) {
        const dx = p.x - localPos.x;
        const dy = p.y - localPos.y;
        const isInside = dx * dx + dy * dy <= radiusSq;

        if (!isInside) {
          currentRun.push(p);
        } else {
          if (currentRun.length >= 2) {
            subSegments.push([...currentRun]);
          }
          currentRun = [];
        }
      }

      if (currentRun.length >= 2) {
        subSegments.push(currentRun);
      }

      for (const seg of subSegments) {
        const subStroke = new Stroke(seg, stroke.color, stroke.baseWidth, stroke.brushType);
        addedStrokes.push(subStroke);
        newElements.push(subStroke);
      }
    }

    node.elements = newElements;
    return { removedStrokes, addedStrokes };
  }
}
