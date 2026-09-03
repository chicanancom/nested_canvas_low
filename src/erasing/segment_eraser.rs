use glam::Vec2;

use crate::model::canvas::{CanvasElement, CanvasNode, NodeId};
use crate::model::point::Point2D;
use crate::model::scene::SceneGraph;
use crate::model::stroke::{Stroke, StrokeId};

/// Segment eraser engine.
///
/// Splits strokes at points of contact with the eraser circle, replacing the original
/// stroke with zero or more contiguous sub-strokes.
pub struct SegmentEraser;

impl SegmentEraser {
    /// Erases parts of a single stroke overlapping with circle `(eraser_pos, radius)`.
    /// Returns `None` if stroke was untouched, or `Some(Vec<Stroke>)` with replacement sub-strokes.
    pub fn erase_stroke(stroke: &Stroke, eraser_pos: Vec2, radius: f32) -> Option<Vec<Stroke>> {
        let inflated_bounds = stroke.bounds.inflate(radius);
        if !inflated_bounds.contains_point(eraser_pos) {
            return None;
        }

        let dist = stroke.distance_to_point(eraser_pos);
        if dist > radius {
            return None;
        }

        if stroke.points.is_empty() {
            return Some(Vec::new());
        }

        let r_sq = radius * radius;
        let mut sub_strokes = Vec::new();
        let mut current_segment: Vec<Point2D> = Vec::new();

        let first_inside = stroke.points[0].pos().distance_squared(eraser_pos) <= r_sq;
        if !first_inside {
            current_segment.push(stroke.points[0]);
        }

        for window in stroke.points.windows(2) {
            let p0 = window[0];
            let p1 = window[1];

            let p0_inside = p0.pos().distance_squared(eraser_pos) <= r_sq;
            let p1_inside = p1.pos().distance_squared(eraser_pos) <= r_sq;

            let intersections = Self::segment_circle_intersections(p0, p1, eraser_pos, radius);

            match (p0_inside, p1_inside) {
                (false, false) => {
                    if intersections.len() == 2 {
                        // Segment enters and exits the eraser circle
                        let t_entry = intersections[0];
                        let t_exit = intersections[1];

                        current_segment.push(p0.lerp(&p1, t_entry));
                        if current_segment.len() >= 2 {
                            sub_strokes.push(Stroke::new(
                                current_segment.clone(),
                                stroke.color,
                                stroke.base_width,
                                stroke.brush_type,
                            ));
                        }
                        current_segment.clear();
                        current_segment.push(p0.lerp(&p1, t_exit));
                        current_segment.push(p1);
                    } else {
                        // Segment completely outside
                        current_segment.push(p1);
                    }
                }
                (false, true) => {
                    // Segment enters circle
                    if let Some(&t_entry) = intersections.first() {
                        current_segment.push(p0.lerp(&p1, t_entry));
                    }
                    if current_segment.len() >= 2 {
                        sub_strokes.push(Stroke::new(
                            current_segment.clone(),
                            stroke.color,
                            stroke.base_width,
                            stroke.brush_type,
                        ));
                    }
                    current_segment.clear();
                }
                (true, false) => {
                    // Segment exits circle
                    current_segment.clear();
                    if let Some(&t_exit) = intersections.last() {
                        current_segment.push(p0.lerp(&p1, t_exit));
                    }
                    current_segment.push(p1);
                }
                (true, true) => {
                    // Entire segment inside circle
                    current_segment.clear();
                }
            }
        }

        if current_segment.len() >= 2 {
            sub_strokes.push(Stroke::new(
                current_segment,
                stroke.color,
                stroke.base_width,
                stroke.brush_type,
            ));
        }

        Some(sub_strokes)
    }

    /// Computes intersection parametric t values of segment `(p1, p2)` with circle `(center, radius)`.
    /// Returns sorted list of `t` in `[0.0, 1.0]`.
    fn segment_circle_intersections(
        p1: Point2D,
        p2: Point2D,
        center: Vec2,
        radius: f32,
    ) -> Vec<f32> {
        let d = p2.pos() - p1.pos();
        let f = p1.pos() - center;

        let a = d.dot(d);
        let b = 2.0 * f.dot(d);
        let c = f.dot(f) - radius * radius;

        let discriminant = b * b - 4.0 * a * c;
        if discriminant < 0.0 || a <= 1e-6 {
            return Vec::new();
        }

        let sqrt_disc = discriminant.sqrt();
        let t1 = (-b - sqrt_disc) / (2.0 * a);
        let t2 = (-b + sqrt_disc) / (2.0 * a);

        let mut out = Vec::with_capacity(2);
        if (0.0..=1.0).contains(&t1) {
            out.push(t1);
        }
        if (0.0..=1.0).contains(&t2) && (t2 - t1).abs() > 1e-5 {
            out.push(t2);
        }
        out.sort_by(|x, y| x.partial_cmp(y).unwrap());
        out
    }

    /// Executes segment erasing inside a canvas node.
    /// Replaces split strokes with resulting sub-strokes.
    pub fn erase_in_node(
        node: &mut CanvasNode,
        eraser_pos: Vec2,
        radius: f32,
    ) -> (Vec<StrokeId>, Vec<Stroke>) {
        let mut removed_ids = Vec::new();
        let mut new_strokes = Vec::new();
        let mut new_elements = Vec::new();

        for elem in node.elements.drain(..) {
            match elem {
                CanvasElement::Stroke(stroke) => {
                    if let Some(sub_paths) = Self::erase_stroke(&stroke, eraser_pos, radius) {
                        removed_ids.push(stroke.id);
                        for sub in sub_paths {
                            new_strokes.push(sub.clone());
                            new_elements.push(CanvasElement::Stroke(sub));
                        }
                    } else {
                        new_elements.push(CanvasElement::Stroke(stroke));
                    }
                }
            }
        }

        node.elements = new_elements;
        (removed_ids, new_strokes)
    }

    /// Erases in a targeted node within the scene graph.
    pub fn erase_in_scene(
        scene: &mut SceneGraph,
        target_node: NodeId,
        local_pos: Vec2,
        radius: f32,
    ) -> (Vec<StrokeId>, Vec<Stroke>) {
        if let Some(node) = scene.get_node_mut(target_node) {
            Self::erase_in_node(node, local_pos, radius)
        } else {
            (Vec::new(), Vec::new())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::transform::Transform2D;
    use crate::model::stroke::{BrushType, Color};

    #[test]
    fn test_segment_eraser_splits_horizontal_stroke() {
        let mut node = CanvasNode::new("Test", 500.0, 500.0, Transform2D::IDENTITY);

        // Horizontal stroke from x=0 to x=100 at y=50
        let stroke = Stroke::new(
            vec![
                Point2D::new(0.0, 50.0, 1.0, 0),
                Point2D::new(40.0, 50.0, 1.0, 10),
                Point2D::new(60.0, 50.0, 1.0, 20),
                Point2D::new(100.0, 50.0, 1.0, 30),
            ],
            Color::BLACK,
            2.0,
            BrushType::Solid,
        );
        let orig_id = stroke.id;
        node.add_stroke(stroke);

        // Erase at (50, 50) with radius 15.0 (covers 35 to 65)
        let (removed, added) =
            SegmentEraser::erase_in_node(&mut node, Vec2::new(50.0, 50.0), 15.0);

        assert_eq!(removed, vec![orig_id]);
        assert_eq!(added.len(), 2); // Split into 2 sub-strokes (left and right)
        assert_eq!(node.elements.len(), 2);
    }
}
