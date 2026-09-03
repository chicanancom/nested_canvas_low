use nestedcanvas::{
    BrushType, CatmullRomSpline, ChaikinSmoother, Color, DrawingSession, NodeId, Point2D,
};

#[test]
fn test_catmull_rom_spline_smoothing_smoothness() {
    let raw = vec![
        Point2D::new(0.0, 0.0, 0.5, 0),
        Point2D::new(10.0, 30.0, 0.7, 10),
        Point2D::new(30.0, 20.0, 0.9, 20),
        Point2D::new(60.0, 60.0, 1.0, 30),
    ];

    let smoothed = CatmullRomSpline::smooth(&raw, 5);
    assert_eq!(smoothed.len(), (raw.len() - 1) * 5 + 1);

    // Verify pressure is smoothly interpolated
    assert!((smoothed[0].pressure - 0.5).abs() < 1e-4);
    assert!((smoothed.last().unwrap().pressure - 1.0).abs() < 1e-4);
}

#[test]
fn test_drawing_session_with_jitter_filtering() {
    let node_id = NodeId::new();
    let mut session = DrawingSession::new(
        node_id,
        Point2D::new(0.0, 0.0, 0.5, 0),
        Color::GREEN,
        5.0,
        BrushType::Calligraphy,
    );

    // Add redundant/jitter point (< 1.5 distance)
    session.add_point(Point2D::new(0.2, 0.1, 0.5, 1));
    assert_eq!(session.raw_points.len(), 1);

    // Add real distant point
    session.add_point(Point2D::new(10.0, 10.0, 0.8, 10));
    assert_eq!(session.raw_points.len(), 2);

    let (_, stroke) = session.finish();
    assert_eq!(stroke.brush_type, BrushType::Calligraphy);
    assert_eq!(stroke.color, Color::GREEN);
}

#[test]
fn test_chaikin_smoother() {
    let raw = vec![
        Point2D::new(0.0, 0.0, 1.0, 0),
        Point2D::new(10.0, 20.0, 1.0, 10),
        Point2D::new(20.0, 0.0, 1.0, 20),
    ];

    let smoothed = ChaikinSmoother::smooth(&raw, 1);
    assert!(smoothed.len() > raw.len());
}
