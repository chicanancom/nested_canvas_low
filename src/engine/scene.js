import { AABB, Transform2D, Vec2, generateUUID } from './math.js';
import { Point2D } from './smoothing.js';

export class Stroke {
  constructor(points = [], color = '#388bfd', baseWidth = 3.0, brushType = 'solid') {
    this.id = generateUUID();
    this.points = points;
    this.color = color;
    this.baseWidth = baseWidth;
    this.brushType = brushType;
    this.bounds = AABB.empty();
    this.recalculateBounds();
  }

  effectiveWidthAt(pressure) {
    const factor = Math.max(0.2, Math.min(2.0, pressure));
    return this.baseWidth * factor;
  }

  recalculateBounds() {
    if (this.points.length === 0) {
      this.bounds = AABB.empty();
      return;
    }
    const bounds = AABB.empty();
    for (const p of this.points) {
      const halfW = this.effectiveWidthAt(p.pressure) * 0.5;
      bounds.includePoint(new Vec2(p.x - halfW, p.y - halfW));
      bounds.includePoint(new Vec2(p.x + halfW, p.y + halfW));
    }
    this.bounds = bounds;
  }

  distanceToPoint(p) {
    if (this.points.length === 0) return Infinity;
    if (this.points.length === 1) return Math.hypot(this.points[0].x - p.x, this.points[0].y - p.y);

    let minDistSq = Infinity;
    for (let i = 0; i < this.points.length - 1; i++) {
      const ax = this.points[i].x;
      const ay = this.points[i].y;
      const bx = this.points[i + 1].x;
      const by = this.points[i + 1].y;

      const abx = bx - ax;
      const aby = by - ay;
      const apx = p.x - ax;
      const apy = p.y - ay;
      const abLenSq = abx * abx + aby * aby;

      const t = abLenSq > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby) / abLenSq)) : 0;
      const closestX = ax + abx * t;
      const closestY = ay + aby * t;
      const distSq = (p.x - closestX) * (p.x - closestX) + (p.y - closestY) * (p.y - closestY);
      if (distSq < minDistSq) {
        minDistSq = distSq;
      }
    }
    return Math.sqrt(minDistSq);
  }

  clone() {
    const s = new Stroke(
      this.points.map((p) => new Point2D(p.x, p.y, p.pressure)),
      this.color,
      this.baseWidth,
      this.brushType
    );
    s.id = this.id;
    return s;
  }

  toJSON() {
    return {
      id: this.id,
      points: this.points.map((p) => ({ x: p.x, y: p.y, pressure: p.pressure })),
      color: this.color,
      baseWidth: this.baseWidth,
      brushType: this.brushType,
    };
  }

  static fromJSON(data) {
    const stroke = new Stroke(
      (data.points || []).map((p) => new Point2D(p.x, p.y, p.pressure)),
      data.color,
      data.baseWidth,
      data.brushType
    );
    if (data.id) stroke.id = data.id;
    return stroke;
  }
}

import { HistoryManager } from './history.js';

export class ImageElement {
  constructor(img, x, y, width, height) {
    this.id = generateUUID();
    this.img = img;
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.recalculateBounds();
  }

  recalculateBounds() {
    this.bounds = AABB.fromOriginSize(this.x, this.y, this.width, this.height);
  }
}

export class CanvasNode {
  constructor(name = 'Sub Canvas', width = 600, height = 450, transform = Transform2D.identity(), image = null, graphData = null, style = 'chalkboard', gridType = 'grid') {
    this.id = generateUUID();
    this.name = name;
    this.width = Math.max(100, width);
    this.height = Math.max(100, height);
    this.transform = transform;
    this.image = image; // HTMLImageElement nếu canvas này là một bảng ảnh lồng nhau
    this.graphData = graphData; // Dữ liệu toán học nếu canvas này là bảng đồ thị hàm số
    this.style = style || 'chalkboard'; // Phong cách màu (chalkboard, whiteboard, blueprint, midnight, warmpaper, dark)
    this.gridType = gridType || 'grid'; // Kiểu lưới (grid, dots, lines, none)
    this.contentPan = new Vec2(0, 0); // Vị trí cuộn/di chuyển vô tận bên trong bảng con
    this.contentZoom = 1.0; // Tỉ lệ thu/phóng riêng bên trong bảng con
    this.elements = []; // Stroke instances
    this.images = []; // ImageElement instances
    this.children = []; // Nested CanvasNode instances
    this.textContent = null; // Chuỗi văn bản nếu canvas này là bảng văn bản OCR/Note
    this.textConfig = { fontSize: 16, color: '#f0f6fc', font: 'Inter, sans-serif' };
    this.history = new HistoryManager(50); // Lịch sử Undo/Redo riêng biệt cho từng bảng
    this.isShared = false; // Trạng thái chia sẻ qua socket LAN của bảng con này
  }

  localContentTransform() {
    const zoom = this.contentZoom || 1.0;
    const panX = this.contentPan ? this.contentPan.x : 0;
    const panY = this.contentPan ? this.contentPan.y : 0;

    if (this.graphData) {
      const headerH = 28;
      const bodyH = Math.max(1, this.height - headerH);
      const cx = this.width * 0.5;
      const cy = headerH + bodyH * 0.5;
      return Transform2D.fromTranslation(-cx, -cy)
        .then(Transform2D.fromScale(zoom))
        .then(Transform2D.fromTranslation(cx - panX * zoom, cy - panY * zoom));
    }

    return Transform2D.fromScale(zoom)
      .then(Transform2D.fromTranslation(-panX, -panY));
  }

  localBounds() {
    return AABB.fromOriginSize(0, 0, this.width, this.height);
  }

  boundsInParent() {
    return this.localBounds().transform(this.transform);
  }

  addStroke(stroke) {
    this.elements.push(stroke);
  }

  removeStroke(strokeId) {
    this.elements = this.elements.filter((s) => s.id !== strokeId);
  }

  addImage(imageElement) {
    this.images.push(imageElement);
  }

  removeImage(imageId) {
    this.images = this.images.filter((img) => img.id !== imageId);
  }

  addChild(child) {
    this.children.push(child);
  }

  removeChild(childId) {
    this.children = this.children.filter((c) => c.id !== childId);
  }

  containsLocalPoint(p) {
    return this.localBounds().containsPoint(p);
  }

  findNode(id) {
    if (this.id === id) return this;
    for (const child of this.children) {
      const found = child.findNode(id);
      if (found) return found;
    }
    return null;
  }

  findParentNode(childId) {
    for (const child of this.children) {
      if (child.id === childId) return this;
      const found = child.findParentNode(childId);
      if (found) return found;
    }
    return null;
  }

  removeStroke(id) {
    const idx = this.elements.findIndex((e) => e.id === id);
    if (idx !== -1) {
      this.elements.splice(idx, 1);
      return true;
    }
    for (const child of this.children) {
      if (child.removeStroke(id)) return true;
    }
    return false;
  }

  removeChild(id) {
    const idx = this.children.findIndex((c) => c.id === id);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      return true;
    }
    for (const child of this.children) {
      if (child.removeChild(id)) return true;
    }
    return false;
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      width: this.width,
      height: this.height,
      style: this.style,
      gridType: this.gridType,
      transform: {
        a: this.transform?.a ?? 1,
        b: this.transform?.b ?? 0,
        c: this.transform?.c ?? 0,
        d: this.transform?.d ?? 1,
        tx: this.transform?.tx ?? 0,
        ty: this.transform?.ty ?? 0,
      },
      contentPan: { x: this.contentPan?.x || 0, y: this.contentPan?.y || 0 },
      contentZoom: this.contentZoom || 1.0,
      graphData: this.graphData
        ? {
            expressions: (this.graphData.expressions || []).map((e) => ({
              id: e.id,
              expr: e.expr,
              color: e.color,
              visible: e.visible !== false,
            })),
            bounds: this.graphData.bounds,
          }
        : null,
      elements: (this.elements || []).map((s) => (typeof s?.toJSON === 'function' ? s.toJSON() : s)),
      children: (this.children || []).map((c) => (typeof c?.toJSON === 'function' ? c.toJSON() : c)),
      textContent: this.textContent,
      isShared: !!this.isShared,
    };
  }

  static fromJSON(data) {
    const tr = data.transform || {};
    const t = new Transform2D(
      tr.a ?? 1,
      tr.b ?? 0,
      tr.c ?? 0,
      tr.d ?? 1,
      tr.tx ?? (tr.x ?? 0),
      tr.ty ?? (tr.y ?? 0)
    );
    const node = new CanvasNode(
      data.name,
      data.width,
      data.height,
      t,
      null,
      data.graphData,
      data.style,
      data.gridType
    );
    if (data.id) node.id = data.id;
    if (data.isShared !== undefined) node.isShared = !!data.isShared;
    if (data.contentPan) node.contentPan = new Vec2(data.contentPan.x, data.contentPan.y);
    if (data.contentZoom) node.contentZoom = data.contentZoom;
    if (data.textContent) node.textContent = data.textContent;
    if (data.elements) {
      node.elements = data.elements.map((s) => Stroke.fromJSON(s));
    }
    if (data.children) {
      node.children = data.children.map((c) => CanvasNode.fromJSON(c));
    }
    return node;
  }
}

export class SceneGraph {
  constructor() {
    this.root = new CanvasNode('World Canvas', 1000000, 1000000, Transform2D.identity());
  }

  toJSON() {
    return {
      root: this.root.toJSON(),
    };
  }

  loadFromJSON(json) {
    if (!json || !json.root) return;
    this.root = CanvasNode.fromJSON(json.root);
    this.root.width = 1000000;
    this.root.height = 1000000;
  }

  get rootId() {
    return this.root.id;
  }

  getNode(id) {
    return this.root.findNode(id);
  }

  findParentNode(childId) {
    return this.root.findParentNode(childId);
  }

  computeWorldTransform(targetId) {
    const traverse = (node, parentContentWorld) => {
      const nodeWorld = (node.id === this.root.id)
        ? Transform2D.identity()
        : node.transform.then(parentContentWorld);

      if (node.id === targetId) return nodeWorld;

      const innerTransform = (node.localContentTransform && node.id !== this.root.id)
        ? node.localContentTransform()
        : Transform2D.identity();
      const nodeContentWorld = (node.id === this.root.id)
        ? Transform2D.identity()
        : innerTransform.then(nodeWorld);

      for (const child of node.children) {
        const res = traverse(child, nodeContentWorld);
        if (res) return res;
      }
      return null;
    };

    return traverse(this.root, Transform2D.identity()) || Transform2D.identity();
  }

  computeScreenTransform(targetId, camera) {
    const worldT = this.computeWorldTransform(targetId);
    return worldT.then(camera.worldToScreenTransform());
  }

  computeContentScreenTransform(targetId, camera) {
    const node = this.getNode(targetId);
    const nodeScreenT = this.computeScreenTransform(targetId, camera);
    if (!node || node.id === this.root.id || !node.localContentTransform) {
      return nodeScreenT;
    }
    return node.localContentTransform().then(nodeScreenT);
  }

  screenToLocal(screenPt, targetId, camera) {
    if (!targetId || targetId === this.root.id) {
      return camera.screenToWorld(screenPt);
    }
    const contentScreenT = this.computeContentScreenTransform(targetId, camera);
    const inv = contentScreenT.inverse();
    return inv ? inv.transformPoint(screenPt) : screenPt;
  }

  localToScreen(localPt, targetId, camera) {
    if (!targetId || targetId === this.root.id) {
      return camera.worldToScreen(localPt);
    }
    const contentScreenT = this.computeContentScreenTransform(targetId, camera);
    return contentScreenT.transformPoint(localPt);
  }

  hitTestCanvas(worldPt) {
    const traverse = (node, parentContentWorld) => {
      const nodeWorld = (node.id === this.root.id)
        ? Transform2D.identity()
        : node.transform.then(parentContentWorld);

      const inv = nodeWorld.inverse();
      if (!inv) return null;

      const localPt = inv.transformPoint(worldPt);
      if (!node.containsLocalPoint(localPt)) return null;

      const innerTransform = (node.localContentTransform && node.id !== this.root.id)
        ? node.localContentTransform()
        : Transform2D.identity();
      const nodeContentWorld = (node.id === this.root.id)
        ? Transform2D.identity()
        : innerTransform.then(nodeWorld);

      // Children first (topmost drawn on top)
      for (let i = node.children.length - 1; i >= 0; i--) {
        const hit = traverse(node.children[i], nodeContentWorld);
        if (hit) return hit;
      }

      return { nodeId: node.id, localPt };
    };

    const hit = traverse(this.root, Transform2D.identity());
    return hit || { nodeId: this.root.id, localPt: worldPt };
  }

  hitTestScreen(camera, screenPt) {
    const worldPt = camera.screenToWorld(screenPt);
    return this.hitTestCanvas(worldPt);
  }
}
