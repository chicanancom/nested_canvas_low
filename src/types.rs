use glam::Vec2;
use serde::{Deserialize, Serialize};

/// Strongly-typed 2D point in Screen/Viewport Space (physical/logical pixels on window).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ScreenPoint(pub Vec2);

/// Strongly-typed 2D point in Infinite World Space (unbounded plane before camera pan/zoom).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct WorldPoint(pub Vec2);

/// Strongly-typed 2D point in Child Canvas Space (local container coordinates [0, 0] to [width, height]).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LocalPoint(pub Vec2);
