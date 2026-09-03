import { Vec2 } from './math.js';

export class Point2D {
  constructor(x, y, pressure = 1.0, timestamp = performance.now()) {
    this.x = x;
    this.y = y;
    this.pressure = Math.max(0.1, Math.min(1.0, pressure));
    this.timestamp = timestamp;
  }

  get pos() {
    return new Vec2(this.x, this.y);
  }

  distanceTo(other) {
    return Math.hypot(this.x - other.x, this.y - other.y);
  }

  lerp(other, t) {
    const clampedT = Math.max(0, Math.min(1, t));
    return new Point2D(
      this.x + (other.x - this.x) * clampedT,
      this.y + (other.y - this.y) * clampedT,
      this.pressure + (other.pressure - this.pressure) * clampedT,
      this.timestamp + (other.timestamp - this.timestamp) * clampedT
    );
  }
}

export class CatmullRomSpline {
  static smooth(points, subdivisions = 4) {
    const n = points.len ?? points.length;
    if (n < 3) return [...points];

    const smoothed = [];
    const alpha = 0.5; // Centripetal

    for (let i = 0; i < n - 1; i++) {
      const p0 = i === 0 ? points[0] : points[i - 1];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = i + 2 < n ? points[i + 2] : p2;

      const v0 = p0.pos;
      const v1 = p1.pos;
      const v2 = p2.pos;
      const v3 = p3.pos;

      const d01 = Math.max(1e-4, Math.pow(v0.distance(v1), alpha));
      const d12 = Math.max(1e-4, Math.pow(v1.distance(v2), alpha));
      const d23 = Math.max(1e-4, Math.pow(v2.distance(v3), alpha));

      const t0 = 0.0;
      const t1 = t0 + d01;
      const t2 = t1 + d12;
      const t3 = t2 + d23;

      const numSteps = i === n - 2 ? subdivisions + 1 : subdivisions;

      for (let step = 0; step < numSteps; step++) {
        const frac = step / subdivisions;
        const t = t1 + frac * (t2 - t1);

        const a1 = v0.scale((t1 - t) / (t1 - t0)).add(v1.scale((t - t0) / (t1 - t0)));
        const a2 = v1.scale((t2 - t) / (t2 - t1)).add(v2.scale((t - t1) / (t2 - t1)));
        const a3 = v2.scale((t3 - t) / (t3 - t2)).add(v3.scale((t - t2) / (t3 - t2)));

        const b1 = a1.scale((t2 - t) / (t2 - t0)).add(a2.scale((t - t0) / (t2 - t0)));
        const b2 = a2.scale((t3 - t) / (t3 - t1)).add(a3.scale((t - t1) / (t3 - t1)));

        const c = b1.scale((t2 - t) / (t2 - t1)).add(b2.scale((t - t1) / (t2 - t1)));

        const pressure = p1.pressure + (p2.pressure - p1.pressure) * frac;
        const timestamp = p1.timestamp + (p2.timestamp - p1.timestamp) * frac;

        smoothed.push(new Point2D(c.x, c.y, pressure, timestamp));
      }
    }

    return smoothed;
  }
}
