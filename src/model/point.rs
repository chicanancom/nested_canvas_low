use glam::Vec2;
use serde::{Deserialize, Serialize};

/// High-precision 2D sample point along a vector stroke.
///
/// Contains spatial position, stylus/pen pressure, and sample timestamp.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Point2D {
    /// X coordinate in local or world canvas space.
    pub x: f32,
    /// Y coordinate in local or world canvas space.
    pub y: f32,
    /// Stylus pressure normalized between [0.0, 1.0] (defaults to 1.0 for mouse).
    pub pressure: f32,
    /// Monotonic timestamp in milliseconds since epoch or gesture start.
    pub timestamp: u64,
}

impl Point2D {
    /// Creates a new `Point2D` with specified coordinates, pressure, and timestamp.
    #[inline]
    pub fn new(x: f32, y: f32, pressure: f32, timestamp: u64) -> Self {
        Self {
            x,
            y,
            pressure: pressure.clamp(0.0, 1.0),
            timestamp,
        }
    }

    /// Creates a `Point2D` from a `glam::Vec2` with full pressure and zero timestamp.
    #[inline]
    pub fn from_vec2(pos: Vec2) -> Self {
        Self {
            x: pos.x,
            y: pos.y,
            pressure: 1.0,
            timestamp: 0,
        }
    }

    /// Extracts position as a `glam::Vec2`.
    #[inline]
    pub fn pos(&self) -> Vec2 {
        Vec2::new(self.x, self.y)
    }

    /// Computes the Euclidean distance to another point.
    #[inline]
    pub fn distance_to(&self, other: &Point2D) -> f32 {
        self.pos().distance(other.pos())
    }

    /// Computes the squared Euclidean distance to another point (avoids square root).
    #[inline]
    pub fn distance_squared_to(&self, other: &Point2D) -> f32 {
        self.pos().distance_squared(other.pos())
    }

    /// Linearly interpolates between this point and another point at parameter `t` in [0.0, 1.0].
    pub fn lerp(&self, other: &Point2D, t: f32) -> Point2D {
        let t_clamped = t.clamp(0.0, 1.0);
        let pos = self.pos().lerp(other.pos(), t_clamped);
        let pressure = self.pressure + (other.pressure - self.pressure) * t_clamped;
        let timestamp = self.timestamp
            + ((other.timestamp as f64 - self.timestamp as f64) * t_clamped as f64) as u64;

        Point2D {
            x: pos.x,
            y: pos.y,
            pressure,
            timestamp,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn test_point2d_lerp() {
        let p1 = Point2D::new(0.0, 0.0, 0.2, 100);
        let p2 = Point2D::new(10.0, 20.0, 0.8, 200);

        let mid = p1.lerp(&p2, 0.5);
        assert_relative_eq!(mid.x, 5.0);
        assert_relative_eq!(mid.y, 10.0);
        assert_relative_eq!(mid.pressure, 0.5);
        assert_eq!(mid.timestamp, 150);
    }

    #[test]
    fn test_point2d_distance() {
        let p1 = Point2D::new(3.0, 0.0, 1.0, 0);
        let p2 = Point2D::new(0.0, 4.0, 1.0, 0);
        assert_relative_eq!(p1.distance_to(&p2), 5.0);
        assert_relative_eq!(p1.distance_squared_to(&p2), 25.0);
    }
}
