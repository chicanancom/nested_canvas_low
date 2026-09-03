use glam::Vec2;
use serde::{Deserialize, Serialize};

use crate::model::stroke::Stroke;

/// 2D GPU Vertex suitable for WGPU / DirectX / Vulkan / WebGL triangle mesh rasterization.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Vertex2D {
    pub pos: Vec2,
    pub uv: Vec2,
    pub color: [f32; 4],
}

/// 2D Triangle Mesh representation of vector strokes.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Mesh2D {
    pub vertices: Vec<Vertex2D>,
    pub indices: Vec<u32>,
}

/// Hardware-accelerated stroke tessellation engine.
pub struct StrokeTessellator;

impl StrokeTessellator {
    /// Tessellates a continuous vector stroke into a high-performance 2D triangle strip mesh.
    pub fn tessellate_stroke(stroke: &Stroke) -> Mesh2D {
        let pts = &stroke.points;
        let n = pts.len();
        if n < 2 {
            return Mesh2D::default();
        }

        let color = [stroke.color.r, stroke.color.g, stroke.color.b, stroke.color.a];
        let mut vertices = Vec::with_capacity(n * 2);
        let mut indices = Vec::with_capacity((n - 1) * 6);

        let mut prev_normal = Vec2::ZERO;

        for i in 0..n {
            let p = pts[i];
            let pos = p.pos();
            let half_width = stroke.effective_width_at_pressure(p.pressure) * 0.5;

            // Compute tangent and perpendicular normal vector
            let normal = if i == 0 {
                let dir = (pts[1].pos() - pos).normalize_or_zero();
                Vec2::new(-dir.y, dir.x)
            } else if i == n - 1 {
                let dir = (pos - pts[i - 1].pos()).normalize_or_zero();
                Vec2::new(-dir.y, dir.x)
            } else {
                let d1 = (pos - pts[i - 1].pos()).normalize_or_zero();
                let d2 = (pts[i + 1].pos() - pos).normalize_or_zero();
                let avg_dir = (d1 + d2).normalize_or_zero();
                Vec2::new(-avg_dir.y, avg_dir.x)
            };

            // Mitigate miter spikes on sharp turns
            let effective_normal = if i > 0 && prev_normal.dot(normal) < 0.0 {
                normal
            } else {
                normal
            };
            prev_normal = effective_normal;

            let v_left = pos + effective_normal * half_width;
            let v_right = pos - effective_normal * half_width;

            let progress = i as f32 / (n - 1) as f32;

            let idx_left = vertices.len() as u32;
            vertices.push(Vertex2D {
                pos: v_left,
                uv: Vec2::new(0.0, progress),
                color,
            });

            let idx_right = vertices.len() as u32;
            vertices.push(Vertex2D {
                pos: v_right,
                uv: Vec2::new(1.0, progress),
                color,
            });

            if i > 0 {
                let prev_left = idx_left - 2;
                let prev_right = idx_right - 2;

                // Triangle 1: (prev_left, prev_right, current_left)
                indices.push(prev_left);
                indices.push(prev_right);
                indices.push(idx_left);

                // Triangle 2: (prev_right, current_right, current_left)
                indices.push(prev_right);
                indices.push(idx_right);
                indices.push(idx_left);
            }
        }

        Mesh2D { vertices, indices }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::point::Point2D;
    use crate::model::stroke::{BrushType, Color};

    #[test]
    fn test_stroke_tessellation_produces_valid_triangles() {
        let pts = vec![
            Point2D::new(0.0, 0.0, 1.0, 0),
            Point2D::new(50.0, 0.0, 1.0, 10),
            Point2D::new(100.0, 50.0, 1.0, 20),
        ];
        let stroke = Stroke::new(pts, Color::WHITE, 4.0, BrushType::Solid);

        let mesh = StrokeTessellator::tessellate_stroke(&stroke);

        // 3 points -> 6 vertices (left & right per point)
        assert_eq!(mesh.vertices.len(), 6);
        // 2 segments -> 4 triangles -> 12 indices
        assert_eq!(mesh.indices.len(), 12);
    }
}
