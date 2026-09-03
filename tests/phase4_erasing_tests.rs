use glam::Vec2;
use nestedcanvas::{
    BrushType, CanvasNode, Color, ObjectEraser, PathClipper, Point2D, SceneGraph, SegmentEraser,
    Stroke, Transform2D, AABB,
};

#[test]
fn test_object_eraser_in_scene() {
    let mut scene = SceneGraph::new();
    let root_id = scene.root_id();

    let mut child = CanvasNode::new("Child", 600.0, 600.0, Transform2D::IDENTITY);
    let s1 = Stroke::new(
        vec![Point2D::new(10.0, 10.0, 1.0, 0), Point2D::new(50.0, 50.0, 1.0, 10)],
        Color::BLACK,
        2.0,
        BrushType::Solid,
    );
    let id1 = s1.id;
    child.add_stroke(s1);
    scene.insert_child(root_id, child).unwrap();

    let child_id = scene.root.children[0].id;

    // Erase in child node
    let removed = ObjectEraser::erase_in_scene(&mut scene, child_id, Vec2::new(30.0, 30.0), 5.0);
    assert_eq!(removed, vec![id1]);
    assert!(scene.get_node(child_id).unwrap().elements.is_empty());
}

#[test]
fn test_segment_eraser_multicut() {
    let mut node = CanvasNode::new("Test", 1000.0, 1000.0, Transform2D::IDENTITY);

    let stroke = Stroke::new(
        vec![
            Point2D::new(0.0, 100.0, 1.0, 0),
            Point2D::new(100.0, 100.0, 1.0, 10),
            Point2D::new(200.0, 100.0, 1.0, 20),
            Point2D::new(300.0, 100.0, 1.0, 30),
        ],
        Color::BLUE,
        2.0,
        BrushType::Solid,
    );
    node.add_stroke(stroke);

    // Erase middle segment at (150, 100) with radius 20
    let (removed, added) = SegmentEraser::erase_in_node(&mut node, Vec2::new(150.0, 100.0), 20.0);
    assert_eq!(removed.len(), 1);
    assert_eq!(added.len(), 2);
    assert_eq!(node.elements.len(), 2);
}

#[test]
fn test_path_clipper_against_canvas_bounds() {
    let bounds = AABB::from_origin_size(Vec2::ZERO, 500.0, 500.0);

    let stroke = Stroke::new(
        vec![
            Point2D::new(-100.0, 250.0, 1.0, 0),
            Point2D::new(250.0, 250.0, 1.0, 10),
            Point2D::new(600.0, 250.0, 1.0, 20),
        ],
        Color::BLACK,
        2.0,
        BrushType::Solid,
    );

    let clipped = PathClipper::clip_stroke(&stroke, &bounds);
    assert_eq!(clipped.len(), 1);
    assert!(clipped[0].points.first().unwrap().x >= 0.0);
    assert!(clipped[0].points.last().unwrap().x <= 500.0);
}
