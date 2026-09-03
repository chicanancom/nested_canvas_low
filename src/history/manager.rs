use crate::error::Result;
use crate::history::command::Command;
use crate::model::scene::SceneGraph;

/// Undo/Redo transaction manager maintaining history stacks and execution state.
#[derive(Default)]
pub struct HistoryManager {
    pub undo_stack: Vec<Box<dyn Command>>,
    pub redo_stack: Vec<Box<dyn Command>>,
    pub max_capacity: usize,
}

impl std::fmt::Debug for HistoryManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HistoryManager")
            .field("undo_count", &self.undo_stack.len())
            .field("redo_count", &self.redo_stack.len())
            .field("max_capacity", &self.max_capacity)
            .finish()
    }
}

impl HistoryManager {
    /// Creates a new HistoryManager with the specified capacity limit.
    pub fn new(max_capacity: usize) -> Self {
        Self {
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            max_capacity: max_capacity.max(1),
        }
    }

    /// Executes a command on the scene graph, clears the redo stack, and pushes to undo stack.
    pub fn execute(&mut self, mut command: Box<dyn Command>, scene: &mut SceneGraph) -> Result<()> {
        command.execute(scene)?;
        self.undo_stack.push(command);
        self.redo_stack.clear();

        if self.undo_stack.len() > self.max_capacity {
            self.undo_stack.remove(0);
        }

        Ok(())
    }

    /// Reverts the most recent command on the undo stack. Returns `true` if a command was undone.
    pub fn undo(&mut self, scene: &mut SceneGraph) -> Result<bool> {
        if let Some(mut command) = self.undo_stack.pop() {
            command.undo(scene)?;
            self.redo_stack.push(command);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Re-applies the most recently undone command on the redo stack. Returns `true` if a command was redone.
    pub fn redo(&mut self, scene: &mut SceneGraph) -> Result<bool> {
        if let Some(mut command) = self.redo_stack.pop() {
            command.execute(scene)?;
            self.undo_stack.push(command);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Checks if there are actions that can be undone.
    #[inline]
    pub fn can_undo(&self) -> bool {
        !self.undo_stack.is_empty()
    }

    /// Checks if there are actions that can be redone.
    #[inline]
    pub fn can_redo(&self) -> bool {
        !self.redo_stack.is_empty()
    }

    /// Returns human-readable description of next undo action if available.
    pub fn next_undo_description(&self) -> Option<&str> {
        self.undo_stack.last().map(|c| c.description())
    }

    /// Returns human-readable description of next redo action if available.
    pub fn next_redo_description(&self) -> Option<&str> {
        self.redo_stack.last().map(|c| c.description())
    }

    /// Clears all undo and redo history.
    pub fn clear(&mut self) {
        self.undo_stack.clear();
        self.redo_stack.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::command::AddStrokeCommand;
    use crate::model::point::Point2D;
    use crate::model::stroke::{BrushType, Color, Stroke};

    #[test]
    fn test_history_manager_undo_redo_lifecycle() {
        let mut history = HistoryManager::new(50);
        let mut scene = SceneGraph::new();
        let root_id = scene.root_id();

        let stroke = Stroke::new(
            vec![Point2D::new(0.0, 0.0, 1.0, 0), Point2D::new(10.0, 10.0, 1.0, 10)],
            Color::BLACK,
            2.0,
            BrushType::Solid,
        );
        let stroke_id = stroke.id;

        // 1. Execute AddStroke
        let cmd = Box::new(AddStrokeCommand::new(root_id, stroke));
        history.execute(cmd, &mut scene).unwrap();

        assert_eq!(scene.root.elements.len(), 1);
        assert!(history.can_undo());
        assert!(!history.can_redo());

        // 2. Undo
        let undone = history.undo(&mut scene).unwrap();
        assert!(undone);
        assert_eq!(scene.root.elements.len(), 0);
        assert!(!history.can_undo());
        assert!(history.can_redo());

        // 3. Redo
        let redone = history.redo(&mut scene).unwrap();
        assert!(redone);
        assert_eq!(scene.root.elements.len(), 1);
        assert!(scene.root.find_stroke(stroke_id).is_some());
    }
}
