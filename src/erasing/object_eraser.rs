use glam::Vec2;

use crate::model::canvas::{CanvasElement, CanvasNode, NodeId};
use crate::model::scene::SceneGraph;
use crate::model::stroke::StrokeId;

/// Object-level eraser engine.
///
/// Removes any stroke where Euclidean distance from eraser center $(E_x, E_y)$ with radius $R$
/// to any segment of the stroke is $\le R$.
pub struct ObjectEraser;

impl ObjectEraser {
    /// Erases intersecting strokes in a single canvas container. Returns IDs of removed strokes.
    pub fn erase_in_node(node: &mut CanvasNode, eraser_pos: Vec2, radius: f32) -> Vec<StrokeId> {
        let mut removed_ids = Vec::new();

        node.elements.retain(|elem| match elem {
            CanvasElement::Stroke(stroke) => {
                // Quick bounding box rejection test with inflated radius
                let inflated_bounds = stroke.bounds.inflate(radius);
                if !inflated_bounds.contains_point(eraser_pos) {
                    return true;
                }

                // Exact segment Euclidean distance check
                let dist = stroke.distance_to_point(eraser_pos);
                if dist <= radius {
                    removed_ids.push(stroke.id);
                    false
                } else {
                    true
                }
            }
        });

        removed_ids
    }

    /// Erases intersecting strokes across a targeted node or the entire scene graph.
    pub fn erase_in_scene(
        scene: &mut SceneGraph,
        target_node_id: NodeId,
        local_pos: Vec2,
        radius: f32,
    ) -> Vec<StrokeId> {
        if let Some(node) = scene.get_node_mut(target_node_id) {
            Self::erase_in_node(node, local_pos, radius)
        } else {
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::transform::Transform2D;
    use crate::model::point::Point2D;
    use crate::model::stroke::{BrushType, Color, Stroke};

    #[test]
    fn test_object_eraser_removes_contacted_stroke() {
        let mut node = CanvasNode::new("Test", 500.0, 500.0, Transform2D::IDENTITY);

        let stroke1 = Stroke::new(
            vec![Point2D::new(10.0, 10.0, 1.0, 0), Point2D::new(100.0, 10.0, 1.0, 10)],
            Color::BLACK,
            2.0,
            BrushType::Solid,
        );
        let id1 = stroke1.id;

        let stroke2 = Stroke::new(
            vec![Point2D::new(10.0, 100.0, 1.0, 0), Point2D::new(100.0, 100.0, 1.0, 10)],
            Color::BLACK,
            2.0,
            BrushType::Solid,
        );
        let id2 = stroke2.id;

        node.add_stroke(stroke1);
        node.add_stroke(stroke2);

        // Erase at (50, 12) with radius 5.0 (contacts stroke 1 at distance 2.0 <= 5.0)
        let removed = ObjectEraser::erase_in_node(&mut node, Vec2::new(50.0, 12.0), 5.0);
        assert_eq!(removed, vec![id1]);
        assert_eq!(node.elements.len(), 1);
        assert!(node.find_stroke(id2).is_some());
    }
}
