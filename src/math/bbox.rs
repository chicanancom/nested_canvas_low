use glam::Vec2;
use serde::{Deserialize, Serialize};

use crate::math::transform::Transform2D;

/// Axis-Aligned Bounding Box (AABB) in 2D space.
///
/// Invariants:
/// - `min.x <= max.x` and `min.y <= max.y` for valid non-empty bounds.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct AABB {
    pub min: Vec2,
    pub max: Vec2,
}

impl AABB {
    /// Creates a new AABB from min and max points.
    ///
    /// Automatically orders min and max components so invariant `min <= max` holds.
    #[inline]
    pub fn new(p1: Vec2, p2: Vec2) -> Self {
        Self {
            min: Vec2::new(p1.x.min(p2.x), p1.y.min(p2.y)),
            max: Vec2::new(p1.x.max(p2.x), p1.y.max(p2.y)),
        }
    }

    /// Creates an AABB from origin and positive dimensions (width, height).
    #[inline]
    pub fn from_origin_size(origin: Vec2, width: f32, height: f32) -> Self {
        let size = Vec2::new(width.abs(), height.abs());
        Self {
            min: origin,
            max: origin + size,
        }
    }

    /// Creates an inverted "empty" AABB suitable as an accumulator in fold/reduction.
    #[inline]
    pub fn empty() -> Self {
        Self {
            min: Vec2::new(f32::INFINITY, f32::INFINITY),
            max: Vec2::new(f32::NEG_INFINITY, f32::NEG_INFINITY),
        }
    }

    /// Returns `true` if the bounding box has valid finite coordinates and non-inverted bounds.
    #[inline]
    pub fn is_valid(&self) -> bool {
        self.min.x <= self.max.x
            && self.min.y <= self.max.y
            && self.min.is_finite()
            && self.max.is_finite()
    }

    /// Width of the bounding box.
    #[inline]
    pub fn width(&self) -> f32 {
        (self.max.x - self.min.x).max(0.0)
    }

    /// Height of the bounding box.
    #[inline]
    pub fn height(&self) -> f32 {
        (self.max.y - self.min.y).max(0.0)
    }

    /// Extents/Size as a `Vec2(width, height)`.
    #[inline]
    pub fn size(&self) -> Vec2 {
        Vec2::new(self.width(), self.height())
    }

    /// Center point of the bounding box.
    #[inline]
    pub fn center(&self) -> Vec2 {
        (self.min + self.max) * 0.5
    }

    /// Expands the bounding box to include a given point `p`.
    #[inline]
    pub fn include_point(&mut self, p: Vec2) {
        self.min = self.min.min(p);
        self.max = self.max.max(p);
    }

    /// Expands the bounding box to enclose another bounding box `other`.
    #[inline]
    pub fn union(&self, other: &Self) -> Self {
        if !self.is_valid() {
            return *other;
        }
        if !other.is_valid() {
            return *self;
        }
        Self {
            min: self.min.min(other.min),
            max: self.max.max(other.max),
        }
    }

    /// Computes the intersection of two bounding boxes.
    /// Returns `None` if they do not overlap.
    #[inline]
    pub fn intersection(&self, other: &Self) -> Option<Self> {
        let min = self.min.max(other.min);
        let max = self.max.min(other.max);

        if min.x <= max.x && min.y <= max.y {
            Some(Self { min, max })
        } else {
            None
        }
    }

    /// Tests if a point `p` is contained inside the bounding box (inclusive bounds).
    #[inline]
    pub fn contains_point(&self, p: Vec2) -> bool {
        p.x >= self.min.x && p.x <= self.max.x && p.y >= self.min.y && p.y <= self.max.y
    }

    /// Tests if another bounding box is fully contained within this bounding box.
    #[inline]
    pub fn contains_box(&self, other: &Self) -> bool {
        other.min.x >= self.min.x
            && other.max.x <= self.max.x
            && other.min.y >= self.min.y
            && other.max.y <= self.max.y
    }

    /// Tests if two bounding boxes intersect/overlap.
    #[inline]
    pub fn intersects(&self, other: &Self) -> bool {
        self.min.x <= other.max.x
            && self.max.x >= other.min.x
            && self.min.y <= other.max.y
            && self.max.y >= other.min.y
    }

    /// Expands all boundaries outward by `margin`.
    #[inline]
    pub fn inflate(&self, margin: f32) -> Self {
        let pad = Vec2::splat(margin);
        Self {
            min: self.min - pad,
            max: self.max + pad,
        }
    }

    /// Transforms the 4 corners of the AABB by an affine transformation `Transform2D`
    /// and returns the new tight Axis-Aligned Bounding Box enclosing the transformed corners.
    pub fn transform(&self, transform: &Transform2D) -> Self {
        let corners = [
            transform.transform_point(self.min),
            transform.transform_point(Vec2::new(self.max.x, self.min.y)),
            transform.transform_point(Vec2::new(self.min.x, self.max.y)),
            transform.transform_point(self.max),
        ];

        let mut out = Self::empty();
        for pt in corners {
            out.include_point(pt);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn test_aabb_creation_and_dimensions() {
        let bbox = AABB::new(Vec2::new(10.0, 20.0), Vec2::new(50.0, 70.0));
        assert_relative_eq!(bbox.width(), 40.0);
        assert_relative_eq!(bbox.height(), 50.0);
        assert_relative_eq!(bbox.center().x, 30.0);
        assert_relative_eq!(bbox.center().y, 45.0);
    }

    #[test]
    fn test_aabb_contains_point() {
        let bbox = AABB::from_origin_size(Vec2::new(0.0, 0.0), 100.0, 100.0);
        assert!(bbox.contains_point(Vec2::new(50.0, 50.0)));
        assert!(bbox.contains_point(Vec2::new(0.0, 0.0)));
        assert!(bbox.contains_point(Vec2::new(100.0, 100.0)));
        assert!(!bbox.contains_point(Vec2::new(-1.0, 50.0)));
        assert!(!bbox.contains_point(Vec2::new(101.0, 50.0)));
    }

    #[test]
    fn test_aabb_intersection_and_union() {
        let a = AABB::from_origin_size(Vec2::new(0.0, 0.0), 50.0, 50.0);
        let b = AABB::from_origin_size(Vec2::new(25.0, 25.0), 50.0, 50.0);
        let c = AABB::from_origin_size(Vec2::new(100.0, 100.0), 20.0, 20.0);

        assert!(a.intersects(&b));
        assert!(!a.intersects(&c));

        let inter = a.intersection(&b).expect("should intersect");
        assert_relative_eq!(inter.min.x, 25.0);
        assert_relative_eq!(inter.min.y, 25.0);
        assert_relative_eq!(inter.max.x, 50.0);
        assert_relative_eq!(inter.max.y, 50.0);

        assert!(a.intersection(&c).is_none());

        let u = a.union(&b);
        assert_relative_eq!(u.min.x, 0.0);
        assert_relative_eq!(u.min.y, 0.0);
        assert_relative_eq!(u.max.x, 75.0);
        assert_relative_eq!(u.max.y, 75.0);
    }

    #[test]
    fn test_aabb_transform() {
        let bbox = AABB::from_origin_size(Vec2::new(0.0, 0.0), 10.0, 10.0);
        let transform = Transform2D::from_translation(Vec2::new(5.0, 5.0))
            .then(&Transform2D::from_scale(Vec2::new(2.0, 2.0)));
        let transformed = bbox.transform(&transform);

        assert_relative_eq!(transformed.min.x, 10.0);
        assert_relative_eq!(transformed.min.y, 10.0);
        assert_relative_eq!(transformed.max.x, 30.0);
        assert_relative_eq!(transformed.max.y, 30.0);
    }
}
