use glam::Vec2;
use serde::{Deserialize, Serialize};
use std::fmt;
use uuid::Uuid;

use crate::math::bbox::AABB;
use crate::math::transform::Transform2D;
use crate::model::stroke::{Stroke, StrokeId};

/// Strong identifier for an independent sub-board in the lecture studio.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct BoardId(pub Uuid);

impl BoardId {
    #[inline]
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for BoardId {
    #[inline]
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for BoardId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Visual style and background pattern preset of a sub-board.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BoardStyle {
    /// Classic dark-green blackboard for chalk drawing.
    ChalkGreen,
    /// Modern dark slate blackboard.
    SlateBlack,
    /// High-contrast white whiteboard for dry-erase markers.
    DryEraseWhite,
    /// Grid-patterned blackboard with dotted alignment guides.
    DottedGrid,
    /// Ruled lines notebook/blackboard style.
    RuledLines,
}

impl Default for BoardStyle {
    fn default() -> Self {
        Self::ChalkGreen
    }
}

/// An independent, isolated Sub-Board (Artboard) in the Multi-Board Lecture Studio.
///
/// Invariants:
/// - Coordinate system is local `[0, 0]` to `[width, height]`.
/// - Strict AABB scissor clipping is enforced: strokes are isolated to their board.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubBoard {
    pub id: BoardId,
    pub title: String,
    /// Local transformation relative to the stage.
    pub transform: Transform2D,
    pub width: f32,
    pub height: f32,
    pub style: BoardStyle,
    /// Pinned status prevents accidental layout shifting or auto-tiling rearrangement.
    pub is_pinned: bool,
    /// Vector strokes drawn on this board.
    pub strokes: Vec<Stroke>,
}

impl SubBoard {
    pub fn new(title: impl Into<String>, width: f32, height: f32, style: BoardStyle) -> Self {
        let w = width.max(100.0);
        let h = height.max(100.0);
        Self {
            id: BoardId::new(),
            title: title.into(),
            transform: Transform2D::IDENTITY,
            width: w,
            height: h,
            style,
            is_pinned: false,
            strokes: Vec::new(),
        }
    }

    /// Local Axis-Aligned Bounding Box: `[0, 0, width, height]`.
    #[inline]
    pub fn local_bounds(&self) -> AABB {
        AABB::from_origin_size(Vec2::ZERO, self.width, self.height)
    }

    /// World Axis-Aligned Bounding Box transformed into stage coordinate space.
    #[inline]
    pub fn world_bounds(&self) -> AABB {
        self.local_bounds().transform(&self.transform)
    }

    /// Adds a stroke to this board.
    #[inline]
    pub fn add_stroke(&mut self, stroke: Stroke) {
        self.strokes.push(stroke);
    }

    /// Removes a stroke by its `StrokeId`. Returns `true` if found and removed.
    pub fn remove_stroke(&mut self, stroke_id: StrokeId) -> bool {
        let len_before = self.strokes.len();
        self.strokes.retain(|s| s.id != stroke_id);
        self.strokes.len() != len_before
    }

    /// Finds a stroke by its `StrokeId`.
    pub fn find_stroke(&self, stroke_id: StrokeId) -> Option<&Stroke> {
        self.strokes.iter().find(|s| s.id == stroke_id)
    }

    /// Tests if a local point `(local_x, local_y)` lies inside the board bounds.
    #[inline]
    pub fn contains_local_point(&self, local_pt: Vec2) -> bool {
        self.local_bounds().contains_point(local_pt)
    }
}
