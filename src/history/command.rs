use glam::Vec2;
use std::fmt::Debug;

use crate::error::{CanvasError, Result};
use crate::math::transform::Transform2D;
use crate::model::board::BoardId;
use crate::model::canvas::{CanvasElement, NodeId};
use crate::model::scene::SceneGraph;
use crate::model::stage::StageState;
use crate::model::stroke::{Stroke, StrokeId};

/// Command Pattern trait for reversible modifications to the SceneGraph.
pub trait Command: Debug + Send + Sync {
    fn execute(&mut self, scene: &mut SceneGraph) -> Result<()>;
    fn undo(&mut self, scene: &mut SceneGraph) -> Result<()>;
    fn description(&self) -> &str;
}

/// Command Pattern trait specialized for the Multi-Board StageState (as in implementation2.md).
pub trait CanvasCommand: Debug + Send + Sync {
    fn execute(&mut self, stage: &mut StageState) -> Result<()>;
    fn undo(&mut self, stage: &mut StageState) -> Result<()>;
    fn board_id(&self) -> Option<BoardId>;
    fn description(&self) -> &str;
}

/// Command to add a new stroke to a target canvas node in SceneGraph.
#[derive(Debug, Clone)]
pub struct AddStrokeCommand {
    pub target_node: NodeId,
    pub stroke: Stroke,
}

impl AddStrokeCommand {
    pub fn new(target_node: NodeId, stroke: Stroke) -> Self {
        Self {
            target_node,
            stroke,
        }
    }
}

impl Command for AddStrokeCommand {
    fn execute(&mut self, scene: &mut SceneGraph) -> Result<()> {
        scene.add_stroke_to_node(self.target_node, self.stroke.clone())
    }

    fn undo(&mut self, scene: &mut SceneGraph) -> Result<()> {
        let node = scene
            .get_node_mut(self.target_node)
            .ok_or(CanvasError::NodeNotFound(self.target_node))?;
        if node.remove_stroke(self.stroke.id) {
            Ok(())
        } else {
            Err(CanvasError::StrokeNotFound(self.stroke.id))
        }
    }

    fn description(&self) -> &str {
        "Add Stroke"
    }
}

/// Command to add a stroke to a SubBoard in StageState.
#[derive(Debug, Clone)]
pub struct AddBoardStrokeCommand {
    pub board_id: BoardId,
    pub stroke: Stroke,
}

impl AddBoardStrokeCommand {
    pub fn new(board_id: BoardId, stroke: Stroke) -> Self {
        Self { board_id, stroke }
    }
}

impl CanvasCommand for AddBoardStrokeCommand {
    fn execute(&mut self, stage: &mut StageState) -> Result<()> {
        stage.add_stroke_to_board(self.board_id, self.stroke.clone())
    }

    fn undo(&mut self, stage: &mut StageState) -> Result<()> {
        let board = stage
            .get_board_mut(self.board_id)
            .ok_or(CanvasError::NodeNotFound(NodeId(self.board_id.0)))?;
        if board.remove_stroke(self.stroke.id) {
            Ok(())
        } else {
            Err(CanvasError::StrokeNotFound(self.stroke.id))
        }
    }

    fn board_id(&self) -> Option<BoardId> {
        Some(self.board_id)
    }

    fn description(&self) -> &str {
        "Add Board Stroke"
    }
}

/// Command to erase/replace strokes in a SubBoard.
#[derive(Debug, Clone)]
pub struct EraseBoardStrokesCommand {
    pub board_id: BoardId,
    pub removed_strokes: Vec<Stroke>,
    pub added_strokes: Vec<Stroke>,
}

impl EraseBoardStrokesCommand {
    pub fn new(
        board_id: BoardId,
        removed_strokes: Vec<Stroke>,
        added_strokes: Vec<Stroke>,
    ) -> Self {
        Self {
            board_id,
            removed_strokes,
            added_strokes,
        }
    }
}

impl CanvasCommand for EraseBoardStrokesCommand {
    fn execute(&mut self, stage: &mut StageState) -> Result<()> {
        let board = stage
            .get_board_mut(self.board_id)
            .ok_or(CanvasError::NodeNotFound(NodeId(self.board_id.0)))?;

        let removed_set: std::collections::HashSet<StrokeId> =
            self.removed_strokes.iter().map(|s| s.id).collect();
        board.strokes.retain(|s| !removed_set.contains(&s.id));

        for sub in &self.added_strokes {
            board.add_stroke(sub.clone());
        }
        Ok(())
    }

    fn undo(&mut self, stage: &mut StageState) -> Result<()> {
        let board = stage
            .get_board_mut(self.board_id)
            .ok_or(CanvasError::NodeNotFound(NodeId(self.board_id.0)))?;

        let added_set: std::collections::HashSet<StrokeId> =
            self.added_strokes.iter().map(|s| s.id).collect();
        board.strokes.retain(|s| !added_set.contains(&s.id));

        for orig in &self.removed_strokes {
            board.add_stroke(orig.clone());
        }
        Ok(())
    }

    fn board_id(&self) -> Option<BoardId> {
        Some(self.board_id)
    }

    fn description(&self) -> &str {
        "Erase Board Strokes"
    }
}

/// Command to move/translate a SubBoard.
#[derive(Debug, Clone)]
pub struct MoveBoardCommand {
    pub board_id: BoardId,
    pub old_pos: Vec2,
    pub new_pos: Vec2,
}

impl MoveBoardCommand {
    pub fn new(board_id: BoardId, old_pos: Vec2, new_pos: Vec2) -> Self {
        Self {
            board_id,
            old_pos,
            new_pos,
        }
    }
}

impl CanvasCommand for MoveBoardCommand {
    fn execute(&mut self, stage: &mut StageState) -> Result<()> {
        let board = stage
            .get_board_mut(self.board_id)
            .ok_or(CanvasError::NodeNotFound(NodeId(self.board_id.0)))?;
        board.transform = Transform2D::from_translation(self.new_pos);
        Ok(())
    }

    fn undo(&mut self, stage: &mut StageState) -> Result<()> {
        let board = stage
            .get_board_mut(self.board_id)
            .ok_or(CanvasError::NodeNotFound(NodeId(self.board_id.0)))?;
        board.transform = Transform2D::from_translation(self.old_pos);
        Ok(())
    }

    fn board_id(&self) -> Option<BoardId> {
        Some(self.board_id)
    }

    fn description(&self) -> &str {
        "Move Board"
    }
}

/// Command to remove a stroke from a target canvas node.
#[derive(Debug, Clone)]
pub struct RemoveStrokeCommand {
    pub target_node: NodeId,
    pub stroke: Stroke,
}

impl RemoveStrokeCommand {
    pub fn new(target_node: NodeId, stroke: Stroke) -> Self {
        Self {
            target_node,
            stroke,
        }
    }
}

impl Command for RemoveStrokeCommand {
    fn execute(&mut self, scene: &mut SceneGraph) -> Result<()> {
        let node = scene
            .get_node_mut(self.target_node)
            .ok_or(CanvasError::NodeNotFound(self.target_node))?;
        if node.remove_stroke(self.stroke.id) {
            Ok(())
        } else {
            Err(CanvasError::StrokeNotFound(self.stroke.id))
        }
    }

    fn undo(&mut self, scene: &mut SceneGraph) -> Result<()> {
        scene.add_stroke_to_node(self.target_node, self.stroke.clone())
    }

    fn description(&self) -> &str {
        "Delete Stroke"
    }
}

/// Command to replace one or more strokes with replacement sub-strokes.
#[derive(Debug, Clone)]
pub struct ReplaceStrokesCommand {
    pub target_node: NodeId,
    pub removed_strokes: Vec<Stroke>,
    pub added_strokes: Vec<Stroke>,
}

impl ReplaceStrokesCommand {
    pub fn new(
        target_node: NodeId,
        removed_strokes: Vec<Stroke>,
        added_strokes: Vec<Stroke>,
    ) -> Self {
        Self {
            target_node,
            removed_strokes,
            added_strokes,
        }
    }
}

impl Command for ReplaceStrokesCommand {
    fn execute(&mut self, scene: &mut SceneGraph) -> Result<()> {
        let node = scene
            .get_node_mut(self.target_node)
            .ok_or(CanvasError::NodeNotFound(self.target_node))?;

        let removed_set: std::collections::HashSet<StrokeId> =
            self.removed_strokes.iter().map(|s| s.id).collect();
        node.elements.retain(|elem| match elem {
            CanvasElement::Stroke(s) => !removed_set.contains(&s.id),
        });

        for sub in &self.added_strokes {
            node.add_stroke(sub.clone());
        }

        Ok(())
    }

    fn undo(&mut self, scene: &mut SceneGraph) -> Result<()> {
        let node = scene
            .get_node_mut(self.target_node)
            .ok_or(CanvasError::NodeNotFound(self.target_node))?;

        let added_set: std::collections::HashSet<StrokeId> =
            self.added_strokes.iter().map(|s| s.id).collect();
        node.elements.retain(|elem| match elem {
            CanvasElement::Stroke(s) => !added_set.contains(&s.id),
        });

        for orig in &self.removed_strokes {
            node.add_stroke(orig.clone());
        }

        Ok(())
    }

    fn description(&self) -> &str {
        "Erase Segment"
    }
}

/// Command to update the transformation of a canvas container.
#[derive(Debug, Clone)]
pub struct TransformNodeCommand {
    pub target_node: NodeId,
    pub old_transform: Transform2D,
    pub new_transform: Transform2D,
}

impl TransformNodeCommand {
    pub fn new(
        target_node: NodeId,
        old_transform: Transform2D,
        new_transform: Transform2D,
    ) -> Self {
        Self {
            target_node,
            old_transform,
            new_transform,
        }
    }
}

impl Command for TransformNodeCommand {
    fn execute(&mut self, scene: &mut SceneGraph) -> Result<()> {
        let node = scene
            .get_node_mut(self.target_node)
            .ok_or(CanvasError::NodeNotFound(self.target_node))?;
        node.transform = self.new_transform;
        Ok(())
    }

    fn undo(&mut self, scene: &mut SceneGraph) -> Result<()> {
        let node = scene
            .get_node_mut(self.target_node)
            .ok_or(CanvasError::NodeNotFound(self.target_node))?;
        node.transform = self.old_transform;
        Ok(())
    }

    fn description(&self) -> &str {
        "Transform Canvas"
    }
}

/// Atomic batch command combining multiple child commands into a single undoable transaction.
#[derive(Debug)]
pub struct BatchCommand {
    pub name: String,
    pub commands: Vec<Box<dyn Command>>,
}

impl BatchCommand {
    pub fn new(name: impl Into<String>, commands: Vec<Box<dyn Command>>) -> Self {
        Self {
            name: name.into(),
            commands,
        }
    }
}

impl Command for BatchCommand {
    fn execute(&mut self, scene: &mut SceneGraph) -> Result<()> {
        for cmd in &mut self.commands {
            cmd.execute(scene)?;
        }
        Ok(())
    }

    fn undo(&mut self, scene: &mut SceneGraph) -> Result<()> {
        for cmd in self.commands.iter_mut().rev() {
            cmd.undo(scene)?;
        }
        Ok(())
    }

    fn description(&self) -> &str {
        &self.name
    }
}
