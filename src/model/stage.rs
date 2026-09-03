use glam::Vec2;
use serde::{Deserialize, Serialize};

use crate::error::{CanvasError, Result};
use crate::math::bbox::AABB;
use crate::math::transform::{Camera, Transform2D};
use crate::model::board::{BoardId, SubBoard};
use crate::model::stroke::Stroke;

/// Complete State of the Multi-Board Lecture Studio stage.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StageState {
    pub camera: Camera,
    pub boards: Vec<SubBoard>,
    pub active_board_id: Option<BoardId>,
}

impl Default for StageState {
    fn default() -> Self {
        Self::new()
    }
}

impl StageState {
    pub fn new() -> Self {
        Self {
            camera: Camera::default(),
            boards: Vec::new(),
            active_board_id: None,
        }
    }

    /// Adds a new sub-board to the stage.
    pub fn add_board(&mut self, board: SubBoard) -> BoardId {
        let id = board.id;
        self.boards.push(board);
        if self.active_board_id.is_none() {
            self.active_board_id = Some(id);
        }
        id
    }

    /// Finds an immutable reference to a board by ID.
    pub fn get_board(&self, id: BoardId) -> Option<&SubBoard> {
        self.boards.iter().find(|b| b.id == id)
    }

    /// Finds a mutable reference to a board by ID.
    pub fn get_board_mut(&mut self, id: BoardId) -> Option<&mut SubBoard> {
        self.boards.iter_mut().find(|b| b.id == id)
    }

    /// Removes a board by ID.
    pub fn remove_board(&mut self, id: BoardId) -> Option<SubBoard> {
        let idx = self.boards.iter().position(|b| b.id == id)?;
        let removed = self.boards.remove(idx);
        if self.active_board_id == Some(id) {
            self.active_board_id = self.boards.first().map(|b| b.id);
        }
        Some(removed)
    }

    /// Hit-tests for the topmost sub-board containing a World Space coordinate `(world_x, world_y)`.
    /// Returns `(BoardId, local_point)` if hit, or `None` if clicking empty stage.
    pub fn hit_test_board(&self, world_pt: Vec2) -> Option<(BoardId, Vec2)> {
        // Iterate in reverse (topmost rendered board on top)
        for board in self.boards.iter().rev() {
            if let Ok(inv) = board.transform.inverse() {
                let local_pt = inv.transform_point(world_pt);
                if board.contains_local_point(local_pt) {
                    return Some((board.id, local_pt));
                }
            }
        }
        None
    }

    /// Hit-tests directly from screen coordinates using the stage camera.
    pub fn hit_test_screen(&self, screen_pt: Vec2) -> Option<(BoardId, Vec2)> {
        let world_pt = self.camera.screen_to_world(screen_pt);
        self.hit_test_board(world_pt)
    }

    /// Appends a stroke to a specific target sub-board.
    pub fn add_stroke_to_board(&mut self, board_id: BoardId, stroke: Stroke) -> Result<()> {
        let board = self
            .get_board_mut(board_id)
            .ok_or(CanvasError::NodeNotFound(crate::model::canvas::NodeId(board_id.0)))?;
        board.add_stroke(stroke);
        Ok(())
    }

    /// Queries all boards whose bounding box intersects the given Viewport AABB.
    pub fn query_visible_boards(&self, visible_world_bounds: &AABB) -> Vec<(BoardId, Transform2D, AABB)> {
        self.boards
            .iter()
            .filter_map(|board| {
                let world_box = board.world_bounds();
                if world_box.intersects(visible_world_bounds) {
                    Some((board.id, board.transform, world_box))
                } else {
                    None
                }
            })
            .collect()
    }
}
