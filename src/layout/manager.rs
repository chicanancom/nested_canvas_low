use glam::Vec2;
use serde::{Deserialize, Serialize};

use crate::math::transform::Transform2D;
use crate::model::stage::StageState;

/// Layout arrangement mode for multi-board lecture studio.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BoardLayoutMode {
    /// Linear horizontal row of boards with sliding blackboard transitions.
    SlidingBlackboard,
    /// Automatic screen-filling tiling layout according to board count (1x1, 1x2, 1x3, 2x2).
    AutoTiling,
    /// Freeform floating windows with manual dragging and positioning.
    Freeform,
}

impl Default for BoardLayoutMode {
    fn default() -> Self {
        Self::AutoTiling
    }
}

/// Multi-board window manager and layout calculator.
pub struct BoardLayoutManager;

impl BoardLayoutManager {
    /// Applies the selected layout mode to all non-pinned sub-boards in the stage.
    pub fn apply_layout(
        stage: &mut StageState,
        mode: BoardLayoutMode,
        stage_width: f32,
        stage_height: f32,
        gap: f32,
    ) {
        if stage.boards.is_empty() {
            return;
        }

        match mode {
            BoardLayoutMode::SlidingBlackboard => {
                Self::apply_sliding_blackboard(stage, stage_width, stage_height, gap);
            }
            BoardLayoutMode::AutoTiling => {
                Self::apply_auto_tiling(stage, stage_width, stage_height, gap);
            }
            BoardLayoutMode::Freeform => {
                // Preserves existing transforms
            }
        }
    }

    /// Arranges boards horizontally side-by-side with fixed spacing.
    fn apply_sliding_blackboard(
        stage: &mut StageState,
        board_width: f32,
        board_height: f32,
        gap: f32,
    ) {
        let mut current_x = 0.0f32;

        for board in &mut stage.boards {
            if board.is_pinned {
                continue;
            }

            board.width = board_width;
            board.height = board_height;
            board.transform = Transform2D::from_translation(Vec2::new(current_x, 0.0));

            current_x += board_width + gap;
        }
    }

    /// Computes automatic tiling layout filling the stage viewport cleanly:
    /// - 1 Board: 1x1 full viewport
    /// - 2 Boards: Dual Vertical Split (50% / 50%)
    /// - 3 Boards: Triple Vertical Split (33.3% / 33.3% / 33.3%)
    /// - 4 Boards: 2x2 Grid Matrix
    /// - 5+ Boards: Multi-row grid matrix
    fn apply_auto_tiling(
        stage: &mut StageState,
        viewport_w: f32,
        viewport_h: f32,
        gap: f32,
    ) {
        let unpinned_count = stage.boards.iter().filter(|b| !b.is_pinned).count();
        if unpinned_count == 0 {
            return;
        }

        let (cols, rows) = match unpinned_count {
            1 => (1, 1),
            2 => (2, 1),
            3 => (3, 1),
            4 => (2, 2),
            5..=6 => (3, 2),
            7..=8 => (4, 2),
            _ => (4, (unpinned_count as f32 / 4.0).ceil() as usize),
        };

        let total_gap_x = gap * (cols as f32 - 1.0).max(0.0);
        let total_gap_y = gap * (rows as f32 - 1.0).max(0.0);

        let cell_w = ((viewport_w - total_gap_x) / cols as f32).max(100.0);
        let cell_h = ((viewport_h - total_gap_y) / rows as f32).max(100.0);

        let mut idx = 0;
        for board in &mut stage.boards {
            if board.is_pinned {
                continue;
            }

            let col = idx % cols;
            let row = idx / cols;

            let x = col as f32 * (cell_w + gap);
            let y = row as f32 * (cell_h + gap);

            board.width = cell_w;
            board.height = cell_h;
            board.transform = Transform2D::from_translation(Vec2::new(x, y));

            idx += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::board::{BoardStyle, SubBoard};
    use approx::assert_relative_eq;

    #[test]
    fn test_auto_tiling_dual_split() {
        let mut stage = StageState::new();
        stage.add_board(SubBoard::new("Board 1", 500.0, 400.0, BoardStyle::ChalkGreen));
        stage.add_board(SubBoard::new("Board 2", 500.0, 400.0, BoardStyle::ChalkGreen));

        BoardLayoutManager::apply_layout(
            &mut stage,
            BoardLayoutMode::AutoTiling,
            1920.0,
            1080.0,
            20.0,
        );

        // 2 boards: dual split -> cell_w = (1920 - 20) / 2 = 950.0
        assert_relative_eq!(stage.boards[0].width, 950.0);
        assert_relative_eq!(stage.boards[1].width, 950.0);
        assert_relative_eq!(stage.boards[0].transform.translation().x, 0.0);
        assert_relative_eq!(stage.boards[1].transform.translation().x, 970.0); // 950 + 20
    }

    #[test]
    fn test_sliding_blackboard_layout() {
        let mut stage = StageState::new();
        stage.add_board(SubBoard::new("Board 1", 800.0, 600.0, BoardStyle::SlateBlack));
        stage.add_board(SubBoard::new("Board 2", 800.0, 600.0, BoardStyle::SlateBlack));

        BoardLayoutManager::apply_layout(
            &mut stage,
            BoardLayoutMode::SlidingBlackboard,
            1200.0,
            800.0,
            30.0,
        );

        assert_relative_eq!(stage.boards[0].transform.translation().x, 0.0);
        assert_relative_eq!(stage.boards[1].transform.translation().x, 1230.0); // 1200 + 30
    }
}
