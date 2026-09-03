use glam::Vec2;
use serde::{Deserialize, Serialize};

/// Type of input device generating pointer events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PointerDevice {
    Mouse,
    Stylus,
    Touch,
}

/// Pointer buttons.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PointerButton {
    None,
    Primary,
    Secondary,
    Middle,
    Other(u16),
}

/// Keyboard modifier keys held during an event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Modifiers {
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub meta: bool,
    pub space: bool,
}

/// Raw input events captured from window/viewport.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum InputEvent {
    PointerDown {
        screen_pos: Vec2,
        button: PointerButton,
        pressure: f32,
        device: PointerDevice,
        modifiers: Modifiers,
        timestamp: u64,
    },
    PointerMove {
        screen_pos: Vec2,
        pressure: f32,
        device: PointerDevice,
        modifiers: Modifiers,
        timestamp: u64,
    },
    PointerUp {
        screen_pos: Vec2,
        button: PointerButton,
        device: PointerDevice,
        timestamp: u64,
    },
    PointerLeave,
    Wheel {
        screen_pos: Vec2,
        delta_x: f32,
        delta_y: f32,
        modifiers: Modifiers,
    },
    PinchGesture {
        screen_anchor: Vec2,
        scale_delta: f32,
    },
    Resize {
        width: f32,
        height: f32,
    },
}
