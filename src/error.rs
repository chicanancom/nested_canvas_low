use thiserror::Error;

use crate::model::canvas::NodeId;
use crate::model::stroke::StrokeId;

/// Core error types for the Nested Infinite Canvas Engine.
#[derive(Debug, Error, Clone, PartialEq)]
pub enum CanvasError {
    #[error("Node with ID '{0}' was not found in the scene graph")]
    NodeNotFound(NodeId),

    #[error("Stroke with ID '{0}' was not found")]
    StrokeNotFound(StrokeId),

    #[error("Transformation error: {0}")]
    TransformationError(String),

    #[error("Matrix inversion failed (determinant near zero): singular matrix")]
    SingularMatrix,

    #[error("Invalid coordinate or dimension: {0}")]
    InvalidDimension(String),

    #[error("Hierarchy cycle detected: node {0} cannot be its own ancestor")]
    HierarchyCycle(NodeId),

    #[error("Clipping error: {0}")]
    ClippingError(String),
}

/// Convenience alias for operations returning `CanvasError`.
pub type Result<T> = std::result::Result<T, CanvasError>;
