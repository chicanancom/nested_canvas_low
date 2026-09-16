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
    const n = points.length;
    if (n < 3) return [...points];

    const smoothed = [];

    for (let i = 0; i < n - 1; i++) {
      const p0 = i === 0 ? points[0] : points[i - 1];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = i + 2 < n ? points[i + 2] : p2;

      const x0 = p0.x, y0 = p0.y;
      const x1 = p1.x, y1 = p1.y;
      const x2 = p2.x, y2 = p2.y;
      const x3 = p3.x, y3 = p3.y;

      const dx01 = x1 - x0, dy01 = y1 - y0;
      const dx12 = x2 - x1, dy12 = y2 - y1;
      const dx23 = x3 - x2, dy23 = y3 - y2;

      const d01 = Math.max(1e-4, Math.pow(dx01 * dx01 + dy01 * dy01, 0.25));
      const d12 = Math.max(1e-4, Math.pow(dx12 * dx12 + dy12 * dy12, 0.25));
      const d23 = Math.max(1e-4, Math.pow(dx23 * dx23 + dy23 * dy23, 0.25));

      const t0 = 0.0;
      const t1 = t0 + d01;
      const t2 = t1 + d12;
      const t3 = t2 + d23;

      const invT1T0 = 1 / (t1 - t0);
      const invT2T1 = 1 / (t2 - t1);
      const invT3T2 = 1 / (t3 - t2);
      const invT2T0 = 1 / (t2 - t0);
      const invT3T1 = 1 / (t3 - t1);

      const numSteps = i === n - 2 ? subdivisions + 1 : subdivisions;
      const p1Press = p1.pressure ?? 0.8;
      const dPress = (p2.pressure ?? 0.8) - p1Press;
      const p1Time = p1.timestamp ?? 0;
      const dTime = (p2.timestamp ?? 0) - p1Time;

      for (let step = 0; step < numSteps; step++) {
        const frac = step / subdivisions;
        const t = t1 + frac * (t2 - t1);

        const a1x = (x0 * (t1 - t) + x1 * (t - t0)) * invT1T0;
        const a1y = (y0 * (t1 - t) + y1 * (t - t0)) * invT1T0;

        const a2x = (x1 * (t2 - t) + x2 * (t - t1)) * invT2T1;
        const a2y = (y1 * (t2 - t) + y2 * (t - t1)) * invT2T1;

        const a3x = (x2 * (t3 - t) + x3 * (t - t2)) * invT3T2;
        const a3y = (y2 * (t3 - t) + y3 * (t - t2)) * invT3T2;

        const b1x = (a1x * (t2 - t) + a2x * (t - t0)) * invT2T0;
        const b1y = (a1y * (t2 - t) + a2y * (t - t0)) * invT2T0;

        const b2x = (a2x * (t3 - t) + a3x * (t - t1)) * invT3T1;
        const b2y = (a2y * (t3 - t) + a3y * (t - t1)) * invT3T1;

        const cx = (b1x * (t2 - t) + b2x * (t - t1)) * invT2T1;
        const cy = (b1y * (t2 - t) + b2y * (t - t1)) * invT2T1;

        const pressure = p1Press + dPress * frac;
        const timestamp = p1Time + dTime * frac;

        smoothed.push(new Point2D(cx, cy, pressure, timestamp));
      }
    }

    return smoothed;
  }
}
