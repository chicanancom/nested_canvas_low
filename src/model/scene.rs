use glam::Vec2;
use serde::{Deserialize, Serialize};

use crate::error::{CanvasError, Result};
use crate::math::bbox::AABB;
use crate::math::transform::{Camera, Transform2D};
use crate::model::canvas::{CanvasNode, NodeId};
use crate::model::stroke::{Stroke, StrokeId};

/// Complete hierarchical Scene Graph managing nested canvases and elements.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SceneGraph {
    /// The root infinite world canvas.
    pub root: CanvasNode,
}

impl Default for SceneGraph {
    fn default() -> Self {
        Self::new()
    }
}

impl SceneGraph {
    /// Creates a new SceneGraph with a default infinite root canvas.
    pub fn new() -> Self {
        let root = CanvasNode::new(
            "Root World Canvas",
            100_000.0,
            100_000.0,
            Transform2D::IDENTITY,
        );
        Self { root }
    }

    /// Returns the ID of the root node.
    #[inline]
    pub fn root_id(&self) -> NodeId {
        self.root.id
    }

    /// Finds a node by ID.
    #[inline]
    pub fn get_node(&self, id: NodeId) -> Option<&CanvasNode> {
        self.root.find_node(id)
    }

    /// Finds a mutable node by ID.
    #[inline]
    pub fn get_node_mut(&mut self, id: NodeId) -> Option<&mut CanvasNode> {
        self.root.find_node_mut(id)
    }

    /// Inserts a child canvas under a specific parent node ID.
    pub fn insert_child(&mut self, parent_id: NodeId, child: CanvasNode) -> Result<()> {
        let parent = self
            .get_node_mut(parent_id)
            .ok_or(CanvasError::NodeNotFound(parent_id))?;
        parent.add_child(child);
        Ok(())
    }

    /// Adds a stroke to a specific canvas node ID.
    pub fn add_stroke_to_node(&mut self, node_id: NodeId, stroke: Stroke) -> Result<()> {
        let node = self
            .get_node_mut(node_id)
            .ok_or(CanvasError::NodeNotFound(node_id))?;
        node.add_stroke(stroke);
        Ok(())
    }

    /// Computes the accumulated World Transform of a given node by traversing down the tree.
    pub fn compute_world_transform(&self, target_id: NodeId) -> Result<Transform2D> {
        fn find_accumulated(
            current: &CanvasNode,
            target_id: NodeId,
            current_accum: Transform2D,
        ) -> Option<Transform2D> {
            let next_accum = current_accum.then(&current.transform);
            if current.id == target_id {
                return Some(next_accum);
            }
            for child in &current.children {
                if let Some(t) = find_accumulated(child, target_id, next_accum) {
                    return Some(t);
                }
            }
            None
        }

        find_accumulated(&self.root, target_id, Transform2D::IDENTITY)
            .ok_or(CanvasError::NodeNotFound(target_id))
    }

    /// Hit-tests for the deepest nested `CanvasNode` containing the given World Space position `(world_x, world_y)`.
    /// Returns the `NodeId` and the local point within that child's coordinate space.
    pub fn hit_test_canvas(&self, world_pt: Vec2) -> (NodeId, Vec2) {
        fn hit_test_recursive(
            node: &CanvasNode,
            world_pt: Vec2,
            parent_world_transform: Transform2D,
        ) -> Option<(NodeId, Vec2)> {
            let node_world_transform = parent_world_transform.then(&node.transform);
            let inv_transform = node_world_transform.inverse().ok()?;
            let local_pt = inv_transform.transform_point(world_pt);

            if !node.contains_local_point(local_pt) {
                return None;
            }

            // Check children in reverse order (topmost rendered child first)
            for child in node.children.iter().rev() {
                if let Some(hit) = hit_test_recursive(child, world_pt, node_world_transform) {
                    return Some(hit);
                }
            }

            Some((node.id, local_pt))
        }

        hit_test_recursive(&self.root, world_pt, Transform2D::IDENTITY)
            .unwrap_or((self.root.id, world_pt))
    }

    /// Hit-tests directly from screen coordinates using the camera state.
    pub fn hit_test_screen(&self, camera: &Camera, screen_pt: Vec2) -> (NodeId, Vec2) {
        let world_pt = camera.screen_to_world(screen_pt);
        self.hit_test_canvas(world_pt)
    }

    /// Finds all Canvas nodes whose world bounding box intersects with the given Viewport/Frustum AABB.
    /// Used for spatial culling in the render loop.
    pub fn query_visible_nodes(
        &self,
        visible_world_bounds: &AABB,
    ) -> Vec<(NodeId, Transform2D, AABB)> {
        let mut visible = Vec::new();

        fn traverse(
            node: &CanvasNode,
            parent_transform: Transform2D,
            frustum: &AABB,
            out: &mut Vec<(NodeId, Transform2D, AABB)>,
        ) {
            let world_transform = parent_transform.then(&node.transform);
            let world_bounds = node.local_bounds().transform(&world_transform);

            if world_bounds.intersects(frustum) {
                out.push((node.id, world_transform, world_bounds));
                for child in &node.children {
                    traverse(child, world_transform, frustum, out);
                }
            }
        }

        traverse(
            &self.root,
            Transform2D::IDENTITY,
            visible_world_bounds,
            &mut visible,
        );
        visible
    }

    /// Removes a stroke by ID anywhere in the scene graph.
    pub fn remove_stroke(&mut self, stroke_id: StrokeId) -> bool {
        self.root.remove_stroke(stroke_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn test_nested_scene_graph_hit_testing_and_transforms() {
        let mut scene = SceneGraph::new();
        let root_id = scene.root_id();

        // Sub-canvas 1 at world (100, 100), size (400, 400)
        let mut sub_canvas = CanvasNode::new(
            "SubCanvas 1",
            400.0,
            400.0,
            Transform2D::from_translation(Vec2::new(100.0, 100.0)),
        );
        let sub_id = sub_canvas.id;

        // Nested sub-child at local (50, 50) within SubCanvas 1, size (100, 100)
        let nested_child = CanvasNode::new(
            "Nested Child",
            100.0,
            100.0,
            Transform2D::from_translation(Vec2::new(50.0, 50.0)),
        );
        let nested_id = nested_child.id;

        sub_canvas.add_child(nested_child);
        scene.insert_child(root_id, sub_canvas).unwrap();

        // 1. World Transform of nested child should be translation (100 + 50, 100 + 50) = (150, 150)
        let world_t = scene.compute_world_transform(nested_id).unwrap();
        assert_relative_eq!(world_t.translation().x, 150.0);
        assert_relative_eq!(world_t.translation().y, 150.0);

        // 2. Hit-testing inside nested child at world (160, 170)
        let (hit_node, local_pt) = scene.hit_test_canvas(Vec2::new(160.0, 170.0));
        assert_eq!(hit_node, nested_id);
        assert_relative_eq!(local_pt.x, 10.0); // 160 - 150
        assert_relative_eq!(local_pt.y, 20.0); // 170 - 150

        // 3. Hit-testing inside SubCanvas 1 outside nested child at world (300, 300)
        let (hit_node2, local_pt2) = scene.hit_test_canvas(Vec2::new(300.0, 300.0));
        assert_eq!(hit_node2, sub_id);
        assert_relative_eq!(local_pt2.x, 200.0); // 300 - 100
        assert_relative_eq!(local_pt2.y, 200.0); // 300 - 100
    }

    #[test]
    fn test_frustum_culling_query() {
        let mut scene = SceneGraph::new();
        let root_id = scene.root_id();

        let visible_sub = CanvasNode::new(
            "Visible",
            100.0,
            100.0,
            Transform2D::from_translation(Vec2::new(10.0, 10.0)),
        );
        let visible_id = visible_sub.id;

        let faraway_sub = CanvasNode::new(
            "Faraway",
            100.0,
            100.0,
            Transform2D::from_translation(Vec2::new(5000.0, 5000.0)),
        );
        let faraway_id = faraway_sub.id;

        scene.insert_child(root_id, visible_sub).unwrap();
        scene.insert_child(root_id, faraway_sub).unwrap();

        let frustum = AABB::from_origin_size(Vec2::ZERO, 200.0, 200.0);
        let visible_nodes = scene.query_visible_nodes(&frustum);

        let ids: Vec<NodeId> = visible_nodes.iter().map(|(id, _, _)| *id).collect();
        assert!(ids.contains(&root_id));
        assert!(ids.contains(&visible_id));
        assert!(!ids.contains(&faraway_id));
    }
}
