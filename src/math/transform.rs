use glam::{Affine2, Mat3, Vec2};
use serde::{Deserialize, Serialize};

use crate::error::{CanvasError, Result};

/// Strong 2D Affine Transformation wrapper based on `glam::Affine2`.
///
/// Encapsulates translation, non-uniform scaling, and rotation.
/// Transforms 2D points: `P' = M * P + Translation`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Transform2D {
    pub matrix: Affine2,
}

impl Default for Transform2D {
    #[inline]
    fn default() -> Self {
        Self::IDENTITY
    }
}

impl Transform2D {
    /// The identity transformation (no change in position, scale, or rotation).
    pub const IDENTITY: Self = Self {
        matrix: Affine2::IDENTITY,
    };

    /// Creates a transformation from an existing `Affine2`.
    #[inline]
    pub const fn from_affine(matrix: Affine2) -> Self {
        Self { matrix }
    }

    /// Creates a pure translation transformation.
    #[inline]
    pub fn from_translation(translation: Vec2) -> Self {
        Self {
            matrix: Affine2::from_translation(translation),
        }
    }

    /// Creates a pure uniform or non-uniform scaling transformation.
    #[inline]
    pub fn from_scale(scale: Vec2) -> Self {
        Self {
            matrix: Affine2::from_scale(scale),
        }
    }

    /// Creates a uniform scale transformation.
    #[inline]
    pub fn from_uniform_scale(scale: f32) -> Self {
        Self::from_scale(Vec2::splat(scale))
    }

    /// Creates a pure rotation transformation (angle in radians).
    #[inline]
    pub fn from_angle(angle_rad: f32) -> Self {
        Self {
            matrix: Affine2::from_angle(angle_rad),
        }
    }

    /// Creates a transformation with scale, rotation (radians), and translation.
    #[inline]
    pub fn from_scale_angle_translation(scale: Vec2, angle_rad: f32, translation: Vec2) -> Self {
        Self {
            matrix: Affine2::from_scale_angle_translation(scale, angle_rad, translation),
        }
    }

    /// Combines this transformation with another transformation applied *after* this one.
    ///
    /// Evaluates `other * self`.
    #[inline]
    pub fn then(&self, other: &Self) -> Self {
        Self {
            matrix: other.matrix * self.matrix,
        }
    }

    /// Combines this transformation with another transformation applied *before* this one.
    ///
    /// Evaluates `self * other`.
    #[inline]
    pub fn pre_transform(&self, other: &Self) -> Self {
        Self {
            matrix: self.matrix * other.matrix,
        }
    }

    /// Transforms a 2D point `(x, y)` through the affine transformation.
    #[inline]
    pub fn transform_point(&self, point: Vec2) -> Vec2 {
        self.matrix.transform_point2(point)
    }

    /// Transforms a 2D direction vector (ignores translation component).
    #[inline]
    pub fn transform_vector(&self, vector: Vec2) -> Vec2 {
        self.matrix.transform_vector2(vector)
    }

    /// Computes the inverse transformation.
    /// Returns `Err(CanvasError::SingularMatrix)` if the matrix is singular / non-invertible.
    pub fn inverse(&self) -> Result<Self> {
        let det = self.matrix.matrix2.determinant();
        if det.abs() < 1e-8 || !det.is_finite() {
            return Err(CanvasError::SingularMatrix);
        }
        Ok(Self {
            matrix: self.matrix.inverse(),
        })
    }

    /// Extracts the translation component.
    #[inline]
    pub fn translation(&self) -> Vec2 {
        self.matrix.translation
    }

    /// Converts to standard 3x3 homogeneous matrix format.
    #[inline]
    pub fn to_mat3(&self) -> Mat3 {
        Mat3::from(self.matrix)
    }
}

/// Represents the viewport/screen camera state on the infinite world canvas.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Camera {
    /// World position that corresponds to the viewport center.
    pub pan: Vec2,
    /// Zoom magnification factor (1.0 = 100%, 2.0 = 200%, etc.).
    pub zoom: f32,
    /// Viewport width in physical/logical screen pixels.
    pub viewport_width: f32,
    /// Viewport height in physical/logical screen pixels.
    pub viewport_height: f32,
}

impl Default for Camera {
    fn default() -> Self {
        Self {
            pan: Vec2::ZERO,
            zoom: 1.0,
            viewport_width: 1920.0,
            viewport_height: 1080.0,
        }
    }
}

impl Camera {
    /// Creates a new Camera.
    pub fn new(pan: Vec2, zoom: f32, viewport_width: f32, viewport_height: f32) -> Self {
        Self {
            pan,
            zoom: zoom.max(0.001),
            viewport_width: viewport_width.max(1.0),
            viewport_height: viewport_height.max(1.0),
        }
    }

    /// Returns the Viewport-to-World transformation.
    ///
    /// Translates screen center to camera pan position, scaled by inverse zoom.
    pub fn screen_to_world_transform(&self) -> Transform2D {
        let screen_center = Vec2::new(self.viewport_width * 0.5, self.viewport_height * 0.5);
        // Step 1: Shift screen coordinate relative to screen center
        // Step 2: Scale by 1.0 / zoom
        // Step 3: Shift by world pan
        Transform2D::from_translation(-screen_center)
            .then(&Transform2D::from_uniform_scale(1.0 / self.zoom))
            .then(&Transform2D::from_translation(self.pan))
    }

    /// Returns the World-to-Viewport transformation.
    pub fn world_to_screen_transform(&self) -> Transform2D {
        let screen_center = Vec2::new(self.viewport_width * 0.5, self.viewport_height * 0.5);
        // Step 1: Shift by -world pan
        // Step 2: Scale by zoom
        // Step 3: Shift to screen center
        Transform2D::from_translation(-self.pan)
            .then(&Transform2D::from_uniform_scale(self.zoom))
            .then(&Transform2D::from_translation(screen_center))
    }

    /// Converts a screen pixel coordinate `(x_screen, y_screen)` to infinite world space `(x_world, y_world)`.
    #[inline]
    pub fn screen_to_world(&self, screen_pt: Vec2) -> Vec2 {
        self.screen_to_world_transform().transform_point(screen_pt)
    }

    /// Converts an infinite world space coordinate `(x_world, y_world)` to screen pixels `(x_screen, y_screen)`.
    #[inline]
    pub fn world_to_screen(&self, world_pt: Vec2) -> Vec2 {
        self.world_to_screen_transform().transform_point(world_pt)
    }

    /// Transforms a point from Screen Space directly into a Child Canvas local coordinate space:
    /// `P_local = Inv(Transform_Child) * Inv(Transform_Camera) * P_screen`
    pub fn screen_to_child_local(
        &self,
        screen_pt: Vec2,
        child_world_transform: &Transform2D,
    ) -> Result<Vec2> {
        let world_pt = self.screen_to_world(screen_pt);
        let inv_child = child_world_transform.inverse()?;
        Ok(inv_child.transform_point(world_pt))
    }

    /// Transforms a local child point to screen space:
    /// `P_screen = Transform_Camera * Transform_Child * P_local`
    pub fn child_local_to_screen(
        &self,
        local_pt: Vec2,
        child_world_transform: &Transform2D,
    ) -> Vec2 {
        let world_pt = child_world_transform.transform_point(local_pt);
        self.world_to_screen(world_pt)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn test_transform_composition_and_inverse() {
        let t1 = Transform2D::from_translation(Vec2::new(100.0, 200.0));
        let t2 = Transform2D::from_uniform_scale(2.0);
        let combined = t1.then(&t2);

        let pt = Vec2::new(10.0, 20.0);
        // (pt + (100, 200)) * 2 = (110, 220) * 2 = (220, 440)
        let transformed = combined.transform_point(pt);
        assert_relative_eq!(transformed.x, 220.0);
        assert_relative_eq!(transformed.y, 440.0);

        let inv = combined.inverse().expect("valid invertible matrix");
        let restored = inv.transform_point(transformed);
        assert_relative_eq!(restored.x, pt.x, epsilon = 1e-5);
        assert_relative_eq!(restored.y, pt.y, epsilon = 1e-5);
    }

    #[test]
    fn test_camera_screen_world_roundtrip() {
        let camera = Camera::new(Vec2::new(500.0, 300.0), 1.5, 1920.0, 1080.0);

        let screen_pt = Vec2::new(960.0, 540.0); // Center of viewport
        let world_pt = camera.screen_to_world(screen_pt);

        // Center of screen should map exactly to pan position
        assert_relative_eq!(world_pt.x, 500.0, epsilon = 1e-4);
        assert_relative_eq!(world_pt.y, 300.0, epsilon = 1e-4);

        let back_to_screen = camera.world_to_screen(world_pt);
        assert_relative_eq!(back_to_screen.x, screen_pt.x, epsilon = 1e-4);
        assert_relative_eq!(back_to_screen.y, screen_pt.y, epsilon = 1e-4);
    }

    #[test]
    fn test_screen_to_child_local_pipeline() {
        // Child canvas placed at world (200, 100) scaled by 2x (local -> scale 2x -> translate (200, 100))
        let child_transform = Transform2D::from_uniform_scale(2.0)
            .then(&Transform2D::from_translation(Vec2::new(200.0, 100.0)));

        let camera = Camera::new(Vec2::new(0.0, 0.0), 1.0, 1000.0, 1000.0);

        // Screen center (500, 500) corresponds to World (0, 0)
        let local_pt = camera
            .screen_to_child_local(Vec2::new(500.0, 500.0), &child_transform)
            .expect("should invert");

        // World (0, 0): (0 - 200) / 2 = -100
        // (0 - 100) / 2 = -50
        assert_relative_eq!(local_pt.x, -100.0, epsilon = 1e-4);
        assert_relative_eq!(local_pt.y, -50.0, epsilon = 1e-4);

        // Roundtrip back to screen
        let screen_roundtrip = camera.child_local_to_screen(local_pt, &child_transform);
        assert_relative_eq!(screen_roundtrip.x, 500.0, epsilon = 1e-4);
        assert_relative_eq!(screen_roundtrip.y, 500.0, epsilon = 1e-4);
    }
}
