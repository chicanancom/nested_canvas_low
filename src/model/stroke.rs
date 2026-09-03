use glam::Vec2;
use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

use crate::math::bbox::AABB;
use crate::model::point::Point2D;

/// Unique identifier for a vector stroke.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct StrokeId(pub Uuid);

impl StrokeId {
    /// Generates a new random unique StrokeId.
    #[inline]
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for StrokeId {
    #[inline]
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for StrokeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// RGBA Color representation with normalized f32 channels [0.0, 1.0].
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Color {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl Default for Color {
    #[inline]
    fn default() -> Self {
        Self::WHITE
    }
}

impl Color {
    pub const BLACK: Self = Self::rgba(0.0, 0.0, 0.0, 1.0);
    pub const WHITE: Self = Self::rgba(1.0, 1.0, 1.0, 1.0);
    pub const RED: Self = Self::rgba(1.0, 0.0, 0.0, 1.0);
    pub const GREEN: Self = Self::rgba(0.0, 1.0, 0.0, 1.0);
    pub const BLUE: Self = Self::rgba(0.0, 0.0, 1.0, 1.0);
    pub const TRANSPARENT: Self = Self::rgba(0.0, 0.0, 0.0, 0.0);

    #[inline]
    pub const fn rgba(r: f32, g: f32, b: f32, a: f32) -> Self {
        Self { r, g, b, a }
    }

    #[inline]
    pub fn from_u8(r: u8, g: u8, b: u8, a: u8) -> Self {
        Self {
            r: r as f32 / 255.0,
            g: g as f32 / 255.0,
            b: b as f32 / 255.0,
            a: a as f32 / 255.0,
        }
    }
}

/// Brush styling and rendering technique.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum BrushType {
    /// Opaque solid vector path with round caps/joints.
    #[default]
    Solid,
    /// Semi-transparent highlighter with multiplicative blending.
    Highlighter,
    /// Pressure and angle-sensitive calligraphy ribbon brush.
    Calligraphy,
    /// Eraser mask brush.
    Eraser,
}

/// A continuous vector-based drawing stroke on a canvas.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Stroke {
    pub id: StrokeId,
    pub points: Vec<Point2D>,
    pub color: Color,
    pub base_width: f32,
    pub brush_type: BrushType,
    /// Cached bounding box enclosing all points and stroke thickness.
    pub bounds: AABB,
}

impl Stroke {
    /// Creates a new Stroke from a sequence of points.
    pub fn new(
        points: Vec<Point2D>,
        color: Color,
        base_width: f32,
        brush_type: BrushType,
    ) -> Self {
        let mut stroke = Self {
            id: StrokeId::new(),
            points,
            color,
            base_width: base_width.max(0.1),
            brush_type,
            bounds: AABB::empty(),
        };
        stroke.recalculate_bounds();
        stroke
    }

    /// Computes dynamic effective width at a specific pressure value.
    /// Invariant: `effective_width = base_width * clamp(pressure, min_factor, max_factor)`.
    #[inline]
    pub fn effective_width_at_pressure(&self, pressure: f32) -> f32 {
        let factor = pressure.clamp(0.2, 2.0);
        self.base_width * factor
    }

    /// Appends a new point to the stroke and expands cached bounding box.
    pub fn push_point(&mut self, point: Point2D) {
        let max_half_width = self.effective_width_at_pressure(point.pressure) * 0.5;
        let p_min = Vec2::new(point.x - max_half_width, point.y - max_half_width);
        let p_max = Vec2::new(point.x + max_half_width, point.y + max_half_width);

        if self.points.is_empty() {
            self.bounds = AABB::new(p_min, p_max);
        } else {
            self.bounds.include_point(p_min);
            self.bounds.include_point(p_max);
        }
        self.points.push(point);
    }

    /// Recalculates the exact bounding box enclosing all points plus max stroke radius.
    pub fn recalculate_bounds(&mut self) {
        if self.points.is_empty() {
            self.bounds = AABB::empty();
            return;
        }

        let mut min = Vec2::splat(f32::INFINITY);
        let mut max = Vec2::splat(f32::NEG_INFINITY);

        for p in &self.points {
            let half_w = self.effective_width_at_pressure(p.pressure) * 0.5;
            min.x = min.x.min(p.x - half_w);
            min.y = min.y.min(p.y - half_w);
            max.x = max.x.max(p.x + half_w);
            max.y = max.y.max(p.y + half_w);
        }

        self.bounds = AABB { min, max };
    }

    /// Computes the minimum Euclidean distance from a test point `p` to any line segment of this stroke.
    ///
    /// Used for precise object-level erasing and selection hit-testing.
    pub fn distance_to_point(&self, p: Vec2) -> f32 {
        if self.points.is_empty() {
            return f32::INFINITY;
        }
        if self.points.len() == 1 {
            return self.points[0].pos().distance(p);
        }

        let mut min_dist_sq = f32::INFINITY;

        for window in self.points.windows(2) {
            let a = window[0].pos();
            let b = window[1].pos();

            let ab = b - a;
            let ap = p - a;
            let ab_len_sq = ab.length_squared();

            let t = if ab_len_sq > 0.0 {
                (ap.dot(ab) / ab_len_sq).clamp(0.0, 1.0)
            } else {
                0.0
            };

            let closest = a + ab * t;
            let dist_sq = p.distance_squared(closest);
            if dist_sq < min_dist_sq {
                min_dist_sq = dist_sq;
            }
        }

        min_dist_sq.sqrt()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn test_stroke_bounds_and_points() {
        let points = vec![
            Point2D::new(10.0, 10.0, 1.0, 0),
            Point2D::new(100.0, 50.0, 1.0, 10),
        ];
        let stroke = Stroke::new(points, Color::BLACK, 4.0, BrushType::Solid);

        // base width = 4.0, half_width = 2.0 (pressure 1.0 -> factor 1.0)
        assert_relative_eq!(stroke.bounds.min.x, 8.0);
        assert_relative_eq!(stroke.bounds.min.y, 8.0);
        assert_relative_eq!(stroke.bounds.max.x, 102.0);
        assert_relative_eq!(stroke.bounds.max.y, 52.0);
    }

    #[test]
    fn test_stroke_distance_to_point() {
        let points = vec![
            Point2D::new(0.0, 0.0, 1.0, 0),
            Point2D::new(100.0, 0.0, 1.0, 10),
        ];
        let stroke = Stroke::new(points, Color::BLACK, 2.0, BrushType::Solid);

        // Point directly above middle of segment at (50, 10)
        let dist = stroke.distance_to_point(Vec2::new(50.0, 10.0));
        assert_relative_eq!(dist, 10.0);

        // Point off the end at (120, 0)
        let dist_end = stroke.distance_to_point(Vec2::new(120.0, 0.0));
        assert_relative_eq!(dist_end, 20.0);
    }
}
