/**
 * High-performance 2D vector and affine transformation math module
 * Matching the exact coordinate pipeline of the Rust NestedCanvas engine.
 */

export class Vec2 {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  add(v) {
    return new Vec2(this.x + v.x, this.y + v.y);
  }

  sub(v) {
    return new Vec2(this.x - v.x, this.y - v.y);
  }

  scale(s) {
    return new Vec2(this.x * s, this.y * s);
  }

  length() {
    return Math.hypot(this.x, this.y);
  }

  lengthSq() {
    return this.x * this.x + this.y * this.y;
  }

  distance(v) {
    return Math.hypot(this.x - v.x, this.y - v.y);
  }

  distanceSq(v) {
    const dx = this.x - v.x;
    const dy = this.y - v.y;
    return dx * dx + dy * dy;
  }

  dot(v) {
    return this.x * v.x + this.y * v.y;
  }

  lerp(v, t) {
    const clampedT = Math.max(0, Math.min(1, t));
    return new Vec2(
      this.x + (v.x - this.x) * clampedT,
      this.y + (v.y - this.y) * clampedT
    );
  }

  clone() {
    return new Vec2(this.x, this.y);
  }
}

export class AABB {
  constructor(minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity) {
    this.minX = minX;
    this.minY = minY;
    this.maxX = maxX;
    this.maxY = maxY;
  }

  static fromOriginSize(x, y, w, h) {
    const absW = Math.abs(w);
    const absH = Math.abs(h);
    return new AABB(x, y, x + absW, y + absH);
  }

  static empty() {
    return new AABB(Infinity, Infinity, -Infinity, -Infinity);
  }

  get width() {
    return this.isValid() ? Math.max(0, this.maxX - this.minX) : 0;
  }

  get height() {
    return this.isValid() ? Math.max(0, this.maxY - this.minY) : 0;
  }

  get centerX() {
    return (this.minX + this.maxX) * 0.5;
  }

  get centerY() {
    return (this.minY + this.maxY) * 0.5;
  }

  isValid() {
    return this.minX <= this.maxX && this.minY <= this.maxY && isFinite(this.minX) && isFinite(this.maxX);
  }

  includePoint(p) {
    if (!isFinite(p.x) || !isFinite(p.y)) return;
    this.minX = Math.min(this.minX, p.x);
    this.minY = Math.min(this.minY, p.y);
    this.maxX = Math.max(this.maxX, p.x);
    this.maxY = Math.max(this.maxY, p.y);
  }

  union(other) {
    if (!this.isValid()) return other.clone();
    if (!other.isValid()) return this.clone();
    return new AABB(
      Math.min(this.minX, other.minX),
      Math.min(this.minY, other.minY),
      Math.max(this.maxX, other.maxX),
      Math.max(this.maxY, other.maxY)
    );
  }

  intersection(other) {
    const minX = Math.max(this.minX, other.minX);
    const minY = Math.max(this.minY, other.minY);
    const maxX = Math.min(this.maxX, other.maxX);
    const maxY = Math.min(this.maxY, other.maxY);

    if (minX <= maxX && minY <= maxY) {
      return new AABB(minX, minY, maxX, maxY);
    }
    return null;
  }

  containsPoint(p) {
    return p.x >= this.minX && p.x <= this.maxX && p.y >= this.minY && p.y <= this.maxY;
  }

  intersects(other) {
    return (
      this.minX <= other.maxX &&
      this.maxX >= other.minX &&
      this.minY <= other.maxY &&
      this.maxY >= other.minY
    );
  }

  inflate(margin) {
    return new AABB(
      this.minX - margin,
      this.minY - margin,
      this.maxX + margin,
      this.maxY + margin
    );
  }

  transform(transform) {
    const corners = [
      transform.transformPoint(new Vec2(this.minX, this.minY)),
      transform.transformPoint(new Vec2(this.maxX, this.minY)),
      transform.transformPoint(new Vec2(this.minX, this.maxY)),
      transform.transformPoint(new Vec2(this.maxX, this.maxY)),
    ];

    const out = AABB.empty();
    for (const c of corners) {
      out.includePoint(c);
    }
    return out;
  }

  clone() {
    return new AABB(this.minX, this.minY, this.maxX, this.maxY);
  }
}

/**
 * Affine 2D transformation matrix:
 * [ a  c  tx ]
 * [ b  d  ty ]
 * [ 0  0  1  ]
 */
export class Transform2D {
  constructor(a = 1, b = 0, c = 0, d = 1, tx = 0, ty = 0) {
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
    this.tx = tx;
    this.ty = ty;
  }

  static identity() {
    return new Transform2D(1, 0, 0, 1, 0, 0);
  }

  static fromTranslation(tx, ty) {
    return new Transform2D(1, 0, 0, 1, tx, ty);
  }

  static fromScale(sx, sy = sx) {
    return new Transform2D(sx, 0, 0, sy, 0, 0);
  }

  static fromAngle(rad) {
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return new Transform2D(cos, sin, -sin, cos, 0, 0);
  }

  then(other) {
    // other * this
    return new Transform2D(
      other.a * this.a + other.c * this.b,
      other.b * this.a + other.d * this.b,
      other.a * this.c + other.c * this.d,
      other.b * this.c + other.d * this.d,
      other.a * this.tx + other.c * this.ty + other.tx,
      other.b * this.tx + other.d * this.ty + other.ty
    );
  }

  transformPoint(p) {
    return new Vec2(
      this.a * p.x + this.c * p.y + this.tx,
      this.b * p.x + this.d * p.y + this.ty
    );
  }

  inverse() {
    const det = this.a * this.d - this.b * this.c;
    if (Math.abs(det) < 1e-8) {
      return null;
    }
    const invDet = 1.0 / det;
    return new Transform2D(
      this.d * invDet,
      -this.b * invDet,
      -this.c * invDet,
      this.a * invDet,
      (this.c * this.ty - this.d * this.tx) * invDet,
      (this.b * this.tx - this.a * this.ty) * invDet
    );
  }

  clone() {
    return new Transform2D(this.a, this.b, this.c, this.d, this.tx, this.ty);
  }
}

export class Camera {
  constructor(panX = 0, panY = 0, zoom = 1, width = 1920, height = 1080) {
    this.pan = new Vec2(panX, panY);
    this.zoom = zoom;
    this.viewportWidth = width;
    this.viewportHeight = height;
  }

  screenToWorldTransform() {
    const screenCenter = new Vec2(this.viewportWidth * 0.5, this.viewportHeight * 0.5);
    return Transform2D.fromTranslation(-screenCenter.x, -screenCenter.y)
      .then(Transform2D.fromScale(1.0 / this.zoom))
      .then(Transform2D.fromTranslation(this.pan.x, this.pan.y));
  }

  worldToScreenTransform() {
    const screenCenter = new Vec2(this.viewportWidth * 0.5, this.viewportHeight * 0.5);
    return Transform2D.fromTranslation(-this.pan.x, -this.pan.y)
      .then(Transform2D.fromScale(this.zoom))
      .then(Transform2D.fromTranslation(screenCenter.x, screenCenter.y));
  }

  screenToWorld(p) {
    return this.screenToWorldTransform().transformPoint(p);
  }

  worldToScreen(p) {
    return this.worldToScreenTransform().transformPoint(p);
  }

  screenToChildLocal(screenPt, childWorldTransform) {
    const worldPt = this.screenToWorld(screenPt);
    const inv = childWorldTransform.inverse();
    return inv ? inv.transformPoint(worldPt) : worldPt;
  }
}

/**
 * Universal UUID generator that works in both Secure Contexts (HTTPS, localhost)
 * and Non-Secure Contexts (LAN HTTP, e.g. http://192.168.x.x:3000)
 */
export function generateUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

