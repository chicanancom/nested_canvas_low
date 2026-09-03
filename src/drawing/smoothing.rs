use glam::Vec2;

use crate::model::point::Point2D;

/// A cubic Bezier curve segment in 2D with starting and ending stroke widths.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CubicBezierSegment {
    pub p0: Vec2,
    pub p1: Vec2,
    pub p2: Vec2,
    pub p3: Vec2,
    pub start_width: f32,
    pub end_width: f32,
}

impl CubicBezierSegment {
    /// Evaluates the cubic Bezier position at parameter `t` in [0.0, 1.0].
    pub fn evaluate(&self, t: f32) -> Vec2 {
        let t = t.clamp(0.0, 1.0);
        let u = 1.0 - t;
        let tt = t * t;
        let uu = u * u;
        let uuu = uu * u;
        let ttt = tt * t;

        uuu * self.p0 + 3.0 * uu * t * self.p1 + 3.0 * u * tt * self.p2 + ttt * self.p3
    }

    /// Evaluates dynamic stroke width at parameter `t` in [0.0, 1.0].
    pub fn evaluate_width(&self, t: f32) -> f32 {
        let t = t.clamp(0.0, 1.0);
        self.start_width + (self.end_width - self.start_width) * t
    }
}

/// Converts a sequence of discrete `Point2D` samples into smooth `Point2D` samples using Catmull-Rom splines.
pub struct CatmullRomSpline;

impl CatmullRomSpline {
    /// Generates smoothed intermediate points along the path defined by control points.
    /// `subdivisions`: number of interpolated points generated between each control point pair.
    pub fn smooth(points: &[Point2D], subdivisions: usize) -> Vec<Point2D> {
        let n = points.len();
        if n < 3 {
            return points.to_vec();
        }

        let mut smoothed = Vec::with_capacity((n - 1) * subdivisions + 1);
        let alpha = 0.5; // Centripetal Catmull-Rom (prevents cusps and self-intersections)

        for i in 0..n - 1 {
            let p0 = if i == 0 { points[0] } else { points[i - 1] };
            let p1 = points[i];
            let p2 = points[i + 1];
            let p3 = if i + 2 < n { points[i + 2] } else { p2 };

            let v0 = p0.pos();
            let v1 = p1.pos();
            let v2 = p2.pos();
            let v3 = p3.pos();

            let d01 = v0.distance(v1).powf(alpha).max(1e-4);
            let d12 = v1.distance(v2).powf(alpha).max(1e-4);
            let d23 = v2.distance(v3).powf(alpha).max(1e-4);

            let t0 = 0.0;
            let t1 = t0 + d01;
            let t2 = t1 + d12;
            let t3 = t2 + d23;

            let num_steps = if i == n - 2 {
                subdivisions + 1
            } else {
                subdivisions
            };

            for step in 0..num_steps {
                let frac = step as f32 / subdivisions as f32;
                let t = t1 + frac * (t2 - t1);

                // Catmull-Rom pyramid interpolation
                let a1 = (t1 - t) / (t1 - t0) * v0 + (t - t0) / (t1 - t0) * v1;
                let a2 = (t2 - t) / (t2 - t1) * v1 + (t - t1) / (t2 - t1) * v2;
                let a3 = (t3 - t) / (t3 - t2) * v2 + (t - t2) / (t3 - t2) * v3;

                let b1 = (t2 - t) / (t2 - t0) * a1 + (t - t0) / (t2 - t0) * a2;
                let b2 = (t3 - t) / (t3 - t1) * a2 + (t - t1) / (t3 - t1) * a3;

                let c = (t2 - t) / (t2 - t1) * b1 + (t - t1) / (t2 - t1) * b2;

                let pressure = p1.pressure + (p2.pressure - p1.pressure) * frac;
                let timestamp = p1.timestamp
                    + ((p2.timestamp as f64 - p1.timestamp as f64) * frac as f64) as u64;

                smoothed.push(Point2D::new(c.x, c.y, pressure, timestamp));
            }
        }

        smoothed
    }

    /// Converts Catmull-Rom control points into a sequence of connected `CubicBezierSegment`s.
    pub fn to_cubic_beziers(
        points: &[Point2D],
        base_width: f32,
    ) -> Vec<CubicBezierSegment> {
        let n = points.len();
        if n < 2 {
            return Vec::new();
        }

        let mut segments = Vec::with_capacity(n - 1);

        for i in 0..n - 1 {
            let p0 = if i == 0 { points[0].pos() } else { points[i - 1].pos() };
            let p1 = points[i].pos();
            let p2 = points[i + 1].pos();
            let p3 = if i + 2 < n { points[i + 2].pos() } else { p2 };

            // Catmull-Rom to Cubic Bezier conversion matrix:
            // B1 = P1 + (P2 - P0) / 6
            // B2 = P2 - (P3 - P1) / 6
            let b1 = p1 + (p2 - p0) / 6.0;
            let b2 = p2 - (p3 - p1) / 6.0;

            let w1 = base_width * points[i].pressure.clamp(0.2, 2.0);
            let w2 = base_width * points[i + 1].pressure.clamp(0.2, 2.0);

            segments.push(CubicBezierSegment {
                p0: p1,
                p1: b1,
                p2: b2,
                p3: p2,
                start_width: w1,
                end_width: w2,
            });
        }

        segments
    }
}

/// Chaikin's corner-cutting algorithm for fast geometric smoothing.
pub struct ChaikinSmoother;

impl ChaikinSmoother {
    /// Applies `iterations` passes of Chaikin subdivision.
    pub fn smooth(points: &[Point2D], iterations: usize) -> Vec<Point2D> {
        if points.len() < 3 || iterations == 0 {
            return points.to_vec();
        }

        let mut current = points.to_vec();

        for _ in 0..iterations {
            let mut next = Vec::with_capacity(current.len() * 2);
            next.push(current[0]); // Preserve endpoint

            for window in current.windows(2) {
                let p0 = window[0];
                let p1 = window[1];

                // Q = 0.75 P0 + 0.25 P1
                let q = p0.lerp(&p1, 0.25);
                // R = 0.25 P0 + 0.75 P1
                let r = p0.lerp(&p1, 0.75);

                next.push(q);
                next.push(r);
            }

            next.push(*current.last().unwrap()); // Preserve endpoint
            current = next;
        }

        current
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn test_catmull_rom_smoothing_interpolates_endpoints() {
        let pts = vec![
            Point2D::new(0.0, 0.0, 1.0, 0),
            Point2D::new(50.0, 100.0, 1.0, 10),
            Point2D::new(100.0, 0.0, 1.0, 20),
            Point2D::new(150.0, 100.0, 1.0, 30),
        ];

        let smoothed = CatmullRomSpline::smooth(&pts, 4);
        assert!(smoothed.len() > pts.len());

        // First point should match start
        assert_relative_eq!(smoothed.first().unwrap().x, 0.0);
        assert_relative_eq!(smoothed.first().unwrap().y, 0.0);

        // Last point should match end
        assert_relative_eq!(smoothed.last().unwrap().x, 150.0);
        assert_relative_eq!(smoothed.last().unwrap().y, 100.0);
    }

    #[test]
    fn test_chaikin_subdivision() {
        let pts = vec![
            Point2D::new(0.0, 0.0, 1.0, 0),
            Point2D::new(50.0, 50.0, 1.0, 10),
            Point2D::new(100.0, 0.0, 1.0, 20),
        ];

        let smoothed = ChaikinSmoother::smooth(&pts, 2);
        assert_eq!(smoothed.first().unwrap().pos(), Vec2::new(0.0, 0.0));
        assert_eq!(smoothed.last().unwrap().pos(), Vec2::new(100.0, 0.0));
        assert!(smoothed.len() > pts.len());
    }
}
