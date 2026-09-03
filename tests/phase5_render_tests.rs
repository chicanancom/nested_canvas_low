use glam::Vec2;
use nestedcanvas::{
    BrushType, Camera, CanvasNode, Color, DrawingSession, Point2D, RenderCommand,
    RenderPipeline, SceneGraph, Transform2D,
};

#[test]
fn test_render_queue_hierarchical_scissor_stack() {
    let mut scene = SceneGraph::new();
    let root_id = scene.root_id();

    // Parent sub-canvas
    let mut parent = CanvasNode::new(
        "Parent",
        400.0,
        400.0,
        Transform2D::from_translation(Vec2::new(100.0, 100.0)),
    );
    // Child sub-canvas nested inside parent
    let child = CanvasNode::new(
        "Child",
        200.0,
        200.0,
        Transform2D::from_translation(Vec2::new(50.0, 50.0)),
    );
    parent.add_child(child);
    scene.insert_child(root_id, parent).unwrap();

    let camera = Camera::new(Vec2::new(200.0, 200.0), 1.0, 1000.0, 1000.0);
    let queue = RenderPipeline::render_scene(&scene, &camera, None);

    // Verify paired PushScissor and PopScissor commands
    let push_count = queue
        .commands
        .iter()
        .filter(|c| matches!(c, RenderCommand::PushScissor { .. }))
        .count();
    let pop_count = queue
        .commands
        .iter()
        .filter(|c| matches!(c, RenderCommand::PopScissor))
        .count();

    assert_eq!(push_count, 2); // 1 for parent, 1 for child
    assert_eq!(pop_count, 2);
    assert_eq!(queue.stats.rendered_nodes, 3); // root + parent + child
}

#[test]
fn test_live_drawing_stroke_in_render_queue() {
    let scene = SceneGraph::new();
    let root_id = scene.root_id();

    let session = DrawingSession::new(
        root_id,
        Point2D::new(10.0, 10.0, 1.0, 0),
        Color::BLUE,
        3.0,
        BrushType::Solid,
    );

    let camera = Camera::new(Vec2::ZERO, 1.0, 800.0, 600.0);
    let queue = RenderPipeline::render_scene(&scene, &camera, Some(&session));

    // Session has only 1 point, so not enough for stroke
    let stroke_commands = queue
        .commands
        .iter()
        .filter(|c| matches!(c, RenderCommand::DrawStroke { .. }))
        .count();
    assert_eq!(stroke_commands, 0);

    // Add another point
    let mut active_session = session.clone();
    active_session.add_point(Point2D::new(50.0, 50.0, 1.0, 10));

    let queue2 = RenderPipeline::render_scene(&scene, &camera, Some(&active_session));
    let stroke_commands2 = queue2
        .commands
        .iter()
        .filter(|c| matches!(c, RenderCommand::DrawStroke { .. }))
        .count();
    assert_eq!(stroke_commands2, 1);
}
