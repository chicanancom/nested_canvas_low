use glam::Vec2;
use nestedcanvas::{
    AddBoardStrokeCommand, BoardLayoutManager, BoardLayoutMode, BoardStyle, BrushType,
    CanvasCommand, Color, EventDispatcher, FsmAction, MouseButton, MoveBoardCommand, Point2D,
    PointerEvent, PointerPhase, StageState, Stroke, StrokeTessellator, SubBoard, Transform2D,
};

#[test]
fn test_multiboard_layout_modes() {
    let mut stage = StageState::new();
    let b1 = stage.add_board(SubBoard::new("Board 1", 600.0, 400.0, BoardStyle::ChalkGreen));
    let b2 = stage.add_board(SubBoard::new("Board 2", 600.0, 400.0, BoardStyle::SlateBlack));
    let b3 = stage.add_board(SubBoard::new("Board 3", 600.0, 400.0, BoardStyle::DryEraseWhite));

    // 1. Test AutoTiling (3 boards -> 3 columns, 1 row)
    BoardLayoutManager::apply_layout(
        &mut stage,
        BoardLayoutMode::AutoTiling,
        1800.0,
        900.0,
        0.0,
    );

    assert_eq!(stage.get_board(b1).unwrap().width, 600.0);
    assert_eq!(stage.get_board(b2).unwrap().width, 600.0);
    assert_eq!(stage.get_board(b3).unwrap().width, 600.0);
    assert_eq!(stage.get_board(b1).unwrap().transform.translation().x, 0.0);
    assert_eq!(stage.get_board(b2).unwrap().transform.translation().x, 600.0);
    assert_eq!(stage.get_board(b3).unwrap().transform.translation().x, 1200.0);

    // 2. Test Sliding Blackboard (fixed size, horizontal sequence)
    BoardLayoutManager::apply_layout(
        &mut stage,
        BoardLayoutMode::SlidingBlackboard,
        1000.0,
        700.0,
        50.0,
    );

    assert_eq!(stage.get_board(b1).unwrap().transform.translation().x, 0.0);
    assert_eq!(stage.get_board(b2).unwrap().transform.translation().x, 1050.0); // 1000 + 50
    assert_eq!(stage.get_board(b3).unwrap().transform.translation().x, 2100.0); // 2 * 1050
}

#[test]
fn test_interaction_fsm_target_locking() {
    let mut stage = StageState::new();
    let mut board1 = SubBoard::new("Board 1", 500.0, 500.0, BoardStyle::ChalkGreen);
    board1.transform = Transform2D::from_translation(Vec2::new(100.0, 100.0));
    let b1_id = stage.add_board(board1);

    let mut dispatcher = EventDispatcher::new();
    dispatcher.current_brush_color = Color::WHITE;
    dispatcher.current_brush_width = 3.0;

    // Stage camera centered at (0, 0), viewport 1000x1000
    stage.camera.viewport_width = 1000.0;
    stage.camera.viewport_height = 1000.0;
    stage.camera.pan = Vec2::new(0.0, 0.0);

    // Screen (500, 500) corresponds to World (0, 0).
    // Board 1 is at World (100, 100).
    // Screen (650, 650) -> World (150, 150) -> Board 1 local (50, 50).
    let down_event = PointerEvent {
        id: 1,
        phase: PointerPhase::Down,
        screen_pos: Vec2::new(650.0, 650.0),
        pressure: 0.8,
        timestamp_ms: 1000,
        button: MouseButton::Primary,
    };

    let a1 = dispatcher.handle_pointer_event(&mut stage, &down_event);
    assert_eq!(a1, FsmAction::RedrawRequired);

    // TARGET LOCKING TEST:
    // Move cursor far outside Board 1 to Screen (100, 100) -> World (-400, -400)
    let move_event = PointerEvent {
        id: 1,
        phase: PointerPhase::Move,
        screen_pos: Vec2::new(100.0, 100.0),
        pressure: 0.9,
        timestamp_ms: 1020,
        button: MouseButton::None,
    };

    let a2 = dispatcher.handle_pointer_event(&mut stage, &move_event);
    assert_eq!(a2, FsmAction::RedrawRequired);

    // Pointer Up: stroke is finalized and committed to locked target Board 1
    let up_event = PointerEvent {
        id: 1,
        phase: PointerPhase::Up,
        screen_pos: Vec2::new(100.0, 100.0),
        pressure: 0.0,
        timestamp_ms: 1040,
        button: MouseButton::Primary,
    };

    let a3 = dispatcher.handle_pointer_event(&mut stage, &up_event);
    match a3 {
        FsmAction::StrokeFinished {
            target_board_id,
            stroke,
        } => {
            assert_eq!(target_board_id, b1_id);
            assert_eq!(stroke.points.len(), 2);
            assert_eq!(stroke.points[0].x, 50.0);
            assert_eq!(stroke.points[0].y, 50.0);
        }
        _ => panic!("Expected StrokeFinished on locked target board"),
    }
}

#[test]
fn test_stroke_gpu_mesh_tessellation() {
    let pts = vec![
        Point2D::new(0.0, 0.0, 1.0, 0),
        Point2D::new(100.0, 0.0, 1.0, 10),
        Point2D::new(100.0, 100.0, 1.0, 20),
    ];
    let stroke = Stroke::new(pts, Color::WHITE, 4.0, BrushType::Solid);

    let mesh = StrokeTessellator::tessellate_stroke(&stroke);

    assert_eq!(mesh.vertices.len(), 6);
    assert_eq!(mesh.indices.len(), 12);
}

#[test]
fn test_canvas_command_undo_redo_on_stage() {
    let mut stage = StageState::new();
    let board_id = stage.add_board(SubBoard::new("Main", 800.0, 600.0, BoardStyle::ChalkGreen));

    let stroke = Stroke::new(
        vec![Point2D::new(10.0, 10.0, 1.0, 0), Point2D::new(50.0, 50.0, 1.0, 10)],
        Color::WHITE,
        2.0,
        BrushType::Solid,
    );
    let _stroke_id = stroke.id;

    let mut add_cmd = AddBoardStrokeCommand::new(board_id, stroke);

    // 1. Execute
    add_cmd.execute(&mut stage).unwrap();
    assert_eq!(stage.get_board(board_id).unwrap().strokes.len(), 1);

    // 2. Undo
    add_cmd.undo(&mut stage).unwrap();
    assert_eq!(stage.get_board(board_id).unwrap().strokes.len(), 0);

    // 3. MoveBoardCommand
    let mut move_cmd = MoveBoardCommand::new(board_id, Vec2::ZERO, Vec2::new(200.0, 150.0));
    move_cmd.execute(&mut stage).unwrap();
    assert_eq!(
        stage.get_board(board_id).unwrap().transform.translation(),
        Vec2::new(200.0, 150.0)
    );

    move_cmd.undo(&mut stage).unwrap();
    assert_eq!(
        stage.get_board(board_id).unwrap().transform.translation(),
        Vec2::ZERO
    );
}
