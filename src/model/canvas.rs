use glam::Vec2;
use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

use crate::math::bbox::AABB;
use crate::math::transform::Transform2D;
use crate::model::stroke::{Stroke, StrokeId};

/// Unique identifier for a canvas container node.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct NodeId(pub Uuid);

impl NodeId {
    /// Generates a new random unique NodeId.
    #[inline]
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for NodeId {
    #[inline]
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for NodeId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Elements that can reside inside a canvas container.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum CanvasElement {
    Stroke(Stroke),
}

impl CanvasElement {
    /// Returns the local Axis-Aligned Bounding Box of this element.
    #[inline]
    pub fn bounds(&self) -> AABB {
        match self {
            CanvasElement::Stroke(s) => s.bounds,
        }
    }
}

/// Represents a nested sub-canvas container in the Scene Graph.
///
/// Invariants:
/// - Coordinate system is local to `(0, 0)` at top-left up to `(width, height)`.
/// - Local clipping bounds are enforced: elements rendered within this node are restricted to `clip_bounds`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CanvasNode {
    pub id: NodeId,
    pub name: String,
    /// Local transformation relative to its parent container.
    pub transform: Transform2D,
    /// Canvas width in local units.
    pub width: f32,
    /// Canvas height in local units.
    pub height: f32,
    /// Local clipping boundaries for scissors/stencil culling.
    pub clip_bounds: AABB,
    /// Vector strokes and elements placed directly on this canvas.
    pub elements: Vec<CanvasElement>,
    /// Hierarchical nested child canvases.
    pub children: Vec<CanvasNode>,
}

impl CanvasNode {
    /// Creates a new CanvasNode with specified dimensions and local transformation.
    pub fn new(name: impl Into<String>, width: f32, height: f32, transform: Transform2D) -> Self {
        let w = width.max(1.0);
        let h = height.max(1.0);
        Self {
            id: NodeId::new(),
            name: name.into(),
            transform,
            width: w,
            height: h,
            clip_bounds: AABB::from_origin_size(Vec2::ZERO, w, h),
            elements: Vec::new(),
            children: Vec::new(),
        }
    }

    /// Returns local bounding box `[0, 0, width, height]`.
    #[inline]
    pub fn local_bounds(&self) -> AABB {
        AABB::from_origin_size(Vec2::ZERO, self.width, self.height)
    }

    /// Computes the bounding box of this canvas transformed into its parent's coordinate space.
    #[inline]
    pub fn bounds_in_parent(&self) -> AABB {
        self.local_bounds().transform(&self.transform)
    }

    /// Adds a stroke element to this canvas container.
    pub fn add_stroke(&mut self, stroke: Stroke) {
        self.elements.push(CanvasElement::Stroke(stroke));
    }

    /// Adds a nested child canvas.
    pub fn add_child(&mut self, child: CanvasNode) {
        self.children.push(child);
    }

    /// Tests if a local point `(local_x, local_y)` is within the canvas boundary.
    #[inline]
    pub fn contains_local_point(&self, local_pt: Vec2) -> bool {
        self.local_bounds().contains_point(local_pt)
    }

    /// Finds a stroke by its `StrokeId` in this node or any child nodes recursively.
    pub fn find_stroke(&self, id: StrokeId) -> Option<&Stroke> {
        for elem in &self.elements {
            match elem {
                CanvasElement::Stroke(s) if s.id == id => return Some(s),
                _ => {}
            }
        }
        for child in &self.children {
            if let Some(s) = child.find_stroke(id) {
                return Some(s);
            }
        }
        None
    }

    /// Finds a mutable reference to a stroke by its `StrokeId`.
    pub fn find_stroke_mut(&mut self, id: StrokeId) -> Option<&mut Stroke> {
        for elem in &mut self.elements {
            match elem {
                CanvasElement::Stroke(s) if s.id == id => return Some(s),
                _ => {}
            }
        }
        for child in &mut self.children {
            if let Some(s) = child.find_stroke_mut(id) {
                return Some(s);
            }
        }
        None
    }

    /// Finds a node by its `NodeId` recursively.
    pub fn find_node(&self, id: NodeId) -> Option<&CanvasNode> {
        if self.id == id {
            return Some(self);
        }
        for child in &self.children {
            if let Some(n) = child.find_node(id) {
                return Some(n);
            }
        }
        None
    }

    /// Finds a mutable node by its `NodeId` recursively.
    pub fn find_node_mut(&mut self, id: NodeId) -> Option<&mut CanvasNode> {
        if self.id == id {
            return Some(self);
        }
        for child in &mut self.children {
            if let Some(n) = child.find_node_mut(id) {
                return Some(n);
            }
        }
        None
    }

    /// Removes a stroke by ID from this node or its children. Returns `true` if removed.
    pub fn remove_stroke(&mut self, id: StrokeId) -> bool {
        let initial_len = self.elements.len();
        self.elements.retain(|elem| match elem {
            CanvasElement::Stroke(s) => s.id != id,
        });
        if self.elements.len() != initial_len {
            return true;
        }
        for child in &mut self.children {
            if child.remove_stroke(id) {
                return true;
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::point::Point2D;
    use crate::model::stroke::{BrushType, Color};
    use approx::assert_relative_eq;

    #[test]
    fn test_canvas_node_hierarchy_and_bounds() {
        let mut parent = CanvasNode::new(
            "Parent Canvas",
            1000.0,
            1000.0,
            Transform2D::from_translation(Vec2::ZERO),
        );

        let child = CanvasNode::new(
            "Child Canvas",
            200.0,
            200.0,
            Transform2D::from_translation(Vec2::new(100.0, 150.0)),
        );
        let child_id = child.id;

        parent.add_child(child);

        assert!(parent.find_node(child_id).is_some());
        let child_in_parent_bounds = parent.find_node(child_id).unwrap().bounds_in_parent();
        assert_relative_eq!(child_in_parent_bounds.min.x, 100.0);
        assert_relative_eq!(child_in_parent_bounds.min.y, 150.0);
        assert_relative_eq!(child_in_parent_bounds.max.x, 300.0);
        assert_relative_eq!(child_in_parent_bounds.max.y, 350.0);
    }

    #[test]
    fn test_canvas_stroke_management() {
        let mut canvas =
            CanvasNode::new("Main", 800.0, 600.0, Transform2D::IDENTITY);
        let stroke = Stroke::new(
            vec![Point2D::new(10.0, 10.0, 1.0, 0)],
            Color::BLACK,
            2.0,
            BrushType::Solid,
        );
        let stroke_id = stroke.id;

        canvas.add_stroke(stroke);
        assert!(canvas.find_stroke(stroke_id).is_some());

        let removed = canvas.remove_stroke(stroke_id);
        assert!(removed);
        assert!(canvas.find_stroke(stroke_id).is_none());
    }
}
