use glam::Vec2;
use nestedcanvas::{
    AddStrokeCommand, BatchCommand, BrushType, CanvasNode, Color, HistoryManager, Point2D,
    ReplaceStrokesCommand, SceneGraph, Stroke, Transform2D, TransformNodeCommand,
};

#[test]
fn test_history_batch_command_atomic_undo() {
    let mut history = HistoryManager::new(20);
    let mut scene = SceneGraph::new();
    let root_id = scene.root_id();

    let stroke1 = Stroke::new(
        vec![Point2D::new(0.0, 0.0, 1.0, 0), Point2D::new(10.0, 10.0, 1.0, 10)],
        Color::BLACK,
        2.0,
        BrushType::Solid,
    );
    let stroke2 = Stroke::new(
        vec![Point2D::new(20.0, 20.0, 1.0, 0), Point2D::new(30.0, 30.0, 1.0, 10)],
        Color::RED,
        2.0,
        BrushType::Solid,
    );

    let batch = Box::new(BatchCommand::new(
        "Draw Multiple",
        vec![
            Box::new(AddStrokeCommand::new(root_id, stroke1)),
            Box::new(AddStrokeCommand::new(root_id, stroke2)),
        ],
    ));

    history.execute(batch, &mut scene).unwrap();
    assert_eq!(scene.root.elements.len(), 2);

    // Undo batch
    history.undo(&mut scene).unwrap();
    assert_eq!(scene.root.elements.len(), 0);

    // Redo batch
    history.redo(&mut scene).unwrap();
    assert_eq!(scene.root.elements.len(), 2);
}

#[test]
fn test_history_replace_strokes_segment_erase() {
    let mut history = HistoryManager::new(20);
    let mut scene = SceneGraph::new();
    let root_id = scene.root_id();

    let orig_stroke = Stroke::new(
        vec![
            Point2D::new(0.0, 0.0, 1.0, 0),
            Point2D::new(100.0, 0.0, 1.0, 10),
        ],
        Color::BLACK,
        2.0,
        BrushType::Solid,
    );
    let orig_id = orig_stroke.id;
    scene.add_stroke_to_node(root_id, orig_stroke.clone()).unwrap();

    let sub1 = Stroke::new(
        vec![Point2D::new(0.0, 0.0, 1.0, 0), Point2D::new(40.0, 0.0, 1.0, 5)],
        Color::BLACK,
        2.0,
        BrushType::Solid,
    );
    let sub2 = Stroke::new(
        vec![
            Point2D::new(60.0, 0.0, 1.0, 6),
            Point2D::new(100.0, 0.0, 1.0, 10),
        ],
        Color::BLACK,
        2.0,
        BrushType::Solid,
    );

    let replace_cmd = Box::new(ReplaceStrokesCommand::new(
        root_id,
        vec![orig_stroke],
        vec![sub1, sub2],
    ));

    history.execute(replace_cmd, &mut scene).unwrap();
    assert_eq!(scene.root.elements.len(), 2);
    assert!(scene.root.find_stroke(orig_id).is_none());

    // Undo replace
    history.undo(&mut scene).unwrap();
    assert_eq!(scene.root.elements.len(), 1);
    assert!(scene.root.find_stroke(orig_id).is_some());
}

#[test]
fn test_history_transform_node() {
    let mut history = HistoryManager::new(20);
    let mut scene = SceneGraph::new();
    let root_id = scene.root_id();

    let child = CanvasNode::new("Child", 200.0, 200.0, Transform2D::IDENTITY);
    let child_id = child.id;
    scene.insert_child(root_id, child).unwrap();

    let t1 = Transform2D::IDENTITY;
    let t2 = Transform2D::from_translation(Vec2::new(150.0, 250.0));

    let cmd = Box::new(TransformNodeCommand::new(child_id, t1, t2));
    history.execute(cmd, &mut scene).unwrap();

    assert_eq!(scene.get_node(child_id).unwrap().transform, t2);

    history.undo(&mut scene).unwrap();
    assert_eq!(scene.get_node(child_id).unwrap().transform, t1);
}
