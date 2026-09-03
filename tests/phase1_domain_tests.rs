use glam::Vec2;
use nestedcanvas::{
    BrushType, Camera, CanvasNode, Color, Point2D, SceneGraph, Stroke, Transform2D, AABB,
};

#[test]
fn test_end_to_end_phase1_pipeline() {
    // 1. Create a scene with root canvas
    let mut scene = SceneGraph::new();
    let root_id = scene.root_id();

    // 2. Add Child Canvas A at world position (100, 200) with size 500x400
    let child_a_transform = Transform2D::from_translation(Vec2::new(100.0, 200.0));
    let mut child_a = CanvasNode::new("SubCanvas A", 500.0, 400.0, child_a_transform);
    let child_a_id = child_a.id;

    // 3. Add Nested Child B inside Child A at local position (50, 50) with size 200x200
    let child_b_transform = Transform2D::from_translation(Vec2::new(50.0, 50.0));
    let mut child_b = CanvasNode::new("SubCanvas B", 200.0, 200.0, child_b_transform);
    let child_b_id = child_b.id;

    // 4. Draw a stroke inside Child B
    let stroke_pts = vec![
        Point2D::new(10.0, 10.0, 1.0, 100),
        Point2D::new(50.0, 50.0, 0.8, 110),
        Point2D::new(90.0, 10.0, 0.6, 120),
    ];
    let stroke = Stroke::new(stroke_pts, Color::BLUE, 3.0, BrushType::Solid);
    let stroke_id = stroke.id;
    child_b.add_stroke(stroke);

    // Build hierarchy
    child_a.add_child(child_b);
    scene.insert_child(root_id, child_a).unwrap();

    // 5. Test Stroke retrieval
    let retrieved_stroke = scene.get_node(child_b_id).unwrap().find_stroke(stroke_id);
    assert!(retrieved_stroke.is_some());
    assert_eq!(retrieved_stroke.unwrap().points.len(), 3);

    // 6. Test World Transform resolution
    // Child B world transform = (100 + 50, 200 + 50) = (150, 250)
    let b_world_t = scene.compute_world_transform(child_b_id).unwrap();
    assert_eq!(b_world_t.translation(), Vec2::new(150.0, 250.0));

    // 7. Test Camera Viewport hit-test & projection
    // Camera centered at world (150, 250), zoom 1.0, viewport 1000x1000
    let camera = Camera::new(Vec2::new(150.0, 250.0), 1.0, 1000.0, 1000.0);
    // Screen center (500, 500) corresponds to world (150, 250), which is local (0, 0) of Child B
    let (hit_id, local_coord) = scene.hit_test_screen(&camera, Vec2::new(500.0, 500.0));
    assert_eq!(hit_id, child_b_id);
    assert_eq!(local_coord, Vec2::new(0.0, 0.0));

    // Screen (520, 530) -> World (170, 280) -> Child B local (20, 30)
    let (hit_id2, local_coord2) = scene.hit_test_screen(&camera, Vec2::new(520.0, 530.0));
    assert_eq!(hit_id2, child_b_id);
    assert_eq!(local_coord2, Vec2::new(20.0, 30.0));

    // 8. Test Frustum Culling
    let frustum = AABB::from_origin_size(Vec2::new(100.0, 200.0), 300.0, 300.0);
    let visible = scene.query_visible_nodes(&frustum);
    let visible_ids: Vec<_> = visible.iter().map(|(id, _, _)| *id).collect();
    assert!(visible_ids.contains(&root_id));
    assert!(visible_ids.contains(&child_a_id));
    assert!(visible_ids.contains(&child_b_id));
}
