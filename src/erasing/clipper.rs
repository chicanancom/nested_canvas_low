use crate::math::bbox::AABB;
use crate::model::point::Point2D;
use crate::model::stroke::Stroke;

/// Vector path clipper against Axis-Aligned Bounding Box (AABB) boundaries.
pub struct PathClipper;

impl PathClipper {
    /// Clips a sequence of stroke points against a rectangular bounding box `bounds`
    /// using Liang-Barsky parametric segment clipping.
    /// Returns one or more contiguous sub-paths strictly inside the bounds.
    pub fn clip_stroke(stroke: &Stroke, bounds: &AABB) -> Vec<Stroke> {
        if stroke.points.len() < 2 {
            return Vec::new();
        }

        // If entire stroke bounds is inside clip bounds, return as-is
        if bounds.contains_box(&stroke.bounds) {
            return vec![stroke.clone()];
        }

        // If stroke bounds is completely outside clip bounds, return empty
        if !bounds.intersects(&stroke.bounds) {
            return Vec::new();
        }

        let mut sub_paths = Vec::new();
        let mut current_sub: Vec<Point2D> = Vec::new();

        for window in stroke.points.windows(2) {
            let p0 = window[0];
            let p1 = window[1];

            if let Some((cp0, cp1)) = Self::clip_segment(p0, p1, bounds) {
                if current_sub.is_empty() {
                    current_sub.push(cp0);
                } else if current_sub.last().unwrap().distance_to(&cp0) > 1e-4 {
                    // Segment discontinuity, start new subpath
                    if current_sub.len() >= 2 {
                        sub_paths.push(Stroke::new(
                            current_sub.clone(),
                            stroke.color,
                            stroke.base_width,
                            stroke.brush_type,
                        ));
                    }
                    current_sub.clear();
                    current_sub.push(cp0);
                }
                current_sub.push(cp1);
            } else if current_sub.len() >= 2 {
                sub_paths.push(Stroke::new(
                    current_sub.clone(),
                    stroke.color,
                    stroke.base_width,
                    stroke.brush_type,
                ));
                current_sub.clear();
            }
        }

        if current_sub.len() >= 2 {
            sub_paths.push(Stroke::new(
                current_sub,
                stroke.color,
                stroke.base_width,
                stroke.brush_type,
            ));
        }

        sub_paths
    }

    /// Liang-Barsky parametric 2D line clipping against an AABB.
    fn clip_segment(p0: Point2D, p1: Point2D, bounds: &AABB) -> Option<(Point2D, Point2D)> {
        let dx = p1.x - p0.x;
        let dy = p1.y - p0.y;

        let mut t0 = 0.0f32;
        let mut t1 = 1.0f32;

        let p = [-dx, dx, -dy, dy];
        let q = [
            p0.x - bounds.min.x,
            bounds.max.x - p0.x,
            p0.y - bounds.min.y,
            bounds.max.y - p0.y,
        ];

        for i in 0..4 {
            let pi = p[i];
            let qi = q[i];

            if pi == 0.0 {
                if qi < 0.0 {
                    return None; // Parallel and outside
                }
            } else {
                let t = qi / pi;
                if pi < 0.0 {
                    if t > t1 {
                        return None;
                    }
                    if t > t0 {
                        t0 = t;
                    }
                } else {
                    if t < t0 {
                        return None;
                    }
                    if t < t1 {
                        t1 = t;
                    }
                }
            }
        }

        if t0 <= t1 {
            let cp0 = p0.lerp(&p1, t0);
            let cp1 = p0.lerp(&p1, t1);
            Some((cp0, cp1))
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::stroke::{BrushType, Color};
    use approx::assert_relative_eq;
    use glam::Vec2;

    #[test]
    fn test_clip_segment_crossing_boundary() {
        let clip_box = AABB::from_origin_size(Vec2::ZERO, 100.0, 100.0);

        // Segment from (-50, 50) to (150, 50)
        let stroke = Stroke::new(
            vec![Point2D::new(-50.0, 50.0, 1.0, 0), Point2D::new(150.0, 50.0, 1.0, 10)],
            Color::BLACK,
            2.0,
            BrushType::Solid,
        );

        let clipped = PathClipper::clip_stroke(&stroke, &clip_box);
        assert_eq!(clipped.len(), 1);

        let pts = &clipped[0].points;
        assert_relative_eq!(pts[0].x, 0.0, epsilon = 1e-4);
        assert_relative_eq!(pts[0].y, 50.0, epsilon = 1e-4);
        assert_relative_eq!(pts[1].x, 100.0, epsilon = 1e-4);
        assert_relative_eq!(pts[1].y, 50.0, epsilon = 1e-4);
    }
}
