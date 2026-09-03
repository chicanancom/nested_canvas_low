//! # Nested Infinite Canvas & Multi-Board Lecture Studio Engine
//!
//! A high-performance graphics and interaction engine in Rust for multi-board lecturing and nested infinite canvases.
//!
//! ## Core Coordinate Systems
//! 1. **Screen / Viewport Space**: Physical pixels on window `(x_screen, y_screen)`.
//! 2. **World / Infinite Canvas Space**: Unbounded canvas plane transformed by camera pan `(cam_x, cam_y)` and zoom `(zoom_scale)`.
//! 3. **Sub-Board / Child Canvas Space**: Local coordinate system relative to board origin `(local_x, local_y)`.
//!
//! Transformation formula:
//! `P_local = Inv(Transform_Board) * Inv(Transform_Camera) * P_screen`

pub mod drawing;
pub mod erasing;
pub mod error;
pub mod event;
pub mod history;
pub mod layout;
pub mod math;
pub mod model;
pub mod render;
pub mod types;

pub use drawing::{
    CatmullRomSpline, ChaikinSmoother, CubicBezierSegment, DrawingSession, Mesh2D,
    StrokeTessellator, Vertex2D,
};
pub use erasing::{ObjectEraser, PathClipper, SegmentEraser};
pub use error::{CanvasError, Result};
pub use event::{
    CanvasController, ControllerAction, EraserMode, EventDispatcher, FsmAction, InputEvent,
    InteractionState, Modifiers, MouseButton, PointerButton, PointerDevice, PointerEvent,
    PointerPhase, Tool, TransformMode,
};
pub use history::{
    AddBoardStrokeCommand, AddStrokeCommand, BatchCommand, CanvasCommand, Command,
    EraseBoardStrokesCommand, HistoryManager, MoveBoardCommand, RemoveStrokeCommand,
    ReplaceStrokesCommand, TransformNodeCommand,
};
pub use layout::{BoardLayoutManager, BoardLayoutMode};
pub use math::bbox::AABB;
pub use math::transform::{Camera, Transform2D};
pub use model::board::{BoardId, BoardStyle, SubBoard};
pub use model::canvas::{CanvasElement, CanvasNode, NodeId};
pub use model::point::Point2D;
pub use model::scene::SceneGraph;
pub use model::stage::StageState;
pub use model::stroke::{BrushType, Color, Stroke, StrokeId};
pub use render::{RenderCommand, RenderPipeline, RenderQueue, RenderStats};
pub use types::{LocalPoint, ScreenPoint, WorldPoint};
