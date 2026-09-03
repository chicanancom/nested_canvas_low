use glam::Vec2;
use nestedcanvas::{
    BrushType, Camera, CanvasController, CanvasNode, Color, ControllerAction, InputEvent,
    Modifiers, PointerButton, PointerDevice, SceneGraph, Tool, Transform2D,
};

#[test]
fn test_phase2_zoom_invariance_and_wheel() {
    let mut controller = CanvasController::new(
        Camera::new(Vec2::new(0.0, 0.0), 1.0, 800.0, 600.0),
        Tool::default(),
    );
    let scene = SceneGraph::new();

    let cursor = Vec2::new(200.0, 150.0);
    let world_before = controller.camera.screen_to_world(cursor);

    // Zoom in via Ctrl + Wheel
    let wheel_event = InputEvent::Wheel {
        screen_pos: cursor,
        delta_x: 0.0,
        delta_y: -100.0,
        modifiers: Modifiers {
            ctrl: true,
            ..Default::default()
        },
    };

    let action = controller.handle_event(&scene, &wheel_event);
    assert_eq!(action, ControllerAction::RedrawRequired);
    assert!(controller.camera.zoom > 1.0);

    let world_after = controller.camera.screen_to_world(cursor);
    assert!((world_before.x - world_after.x).abs() < 1e-3);
    assert!((world_before.y - world_after.y).abs() < 1e-3);
}

#[test]
fn test_phase2_pointer_stroke_lifecycle() {
    let mut scene = SceneGraph::new();
    let root_id = scene.root_id();

    let child = CanvasNode::new(
        "Canvas 1",
        500.0,
        500.0,
        Transform2D::from_translation(Vec2::new(100.0, 100.0)),
    );
    let child_id = child.id;
    scene.insert_child(root_id, child).unwrap();

    let mut controller = CanvasController::new(
        Camera::new(Vec2::new(100.0, 100.0), 1.0, 1000.0, 1000.0),
        Tool::Draw {
            brush_type: BrushType::Solid,
            color: Color::RED,
            width: 4.0,
        },
    );

    // Screen center (500, 500) -> World (100, 100) -> Local (0, 0) of child
    let down = InputEvent::PointerDown {
        screen_pos: Vec2::new(520.0, 530.0), // Local (20, 30)
        button: PointerButton::Primary,
        pressure: 0.6,
        device: PointerDevice::Stylus,
        modifiers: Default::default(),
        timestamp: 1000,
    };

    let a1 = controller.handle_event(&scene, &down);
    match a1 {
        ControllerAction::StrokeStarted {
            target_node, point, ..
        } => {
            assert_eq!(target_node, child_id);
            assert_eq!(point.x, 20.0);
            assert_eq!(point.y, 30.0);
            assert_eq!(point.pressure, 0.6);
        }
        _ => panic!("Expected StrokeStarted"),
    }

    // Pointer move
    let mv = InputEvent::PointerMove {
        screen_pos: Vec2::new(540.0, 560.0), // Local (40, 60)
        pressure: 0.8,
        device: PointerDevice::Stylus,
        modifiers: Default::default(),
        timestamp: 1010,
    };
    let a2 = controller.handle_event(&scene, &mv);
    match a2 {
        ControllerAction::StrokeAppended {
            target_node, point,
        } => {
            assert_eq!(target_node, child_id);
            assert_eq!(point.x, 40.0);
            assert_eq!(point.y, 60.0);
            assert_eq!(point.pressure, 0.8);
        }
        _ => panic!("Expected StrokeAppended"),
    }

    // Pointer up
    let up = InputEvent::PointerUp {
        screen_pos: Vec2::new(540.0, 560.0),
        button: PointerButton::Primary,
        device: PointerDevice::Stylus,
        timestamp: 1020,
    };
    let a3 = controller.handle_event(&scene, &up);
    assert_eq!(
        a3,
        ControllerAction::StrokeFinished {
            target_node: child_id
        }
    );
}
