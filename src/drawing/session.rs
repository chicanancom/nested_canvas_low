use crate::drawing::smoothing::{CatmullRomSpline, CubicBezierSegment};
use crate::model::canvas::NodeId;
use crate::model::point::Point2D;
use crate::model::stroke::{BrushType, Color, Stroke};

/// Real-time drawing session tracking an active stroke gesture in a canvas container.
#[derive(Debug, Clone)]
pub struct DrawingSession {
    pub target_node: NodeId,
    pub raw_points: Vec<Point2D>,
    pub color: Color,
    pub base_width: f32,
    pub brush_type: BrushType,
    pub smoothing_subdivisions: usize,
    pub min_sample_distance: f32,
}

impl DrawingSession {
    /// Begins a new drawing session targeted at a specific canvas container.
    pub fn new(
        target_node: NodeId,
        initial_point: Point2D,
        color: Color,
        base_width: f32,
        brush_type: BrushType,
    ) -> Self {
        Self {
            target_node,
            raw_points: vec![initial_point],
            color,
            base_width,
            brush_type,
            smoothing_subdivisions: 4,
            min_sample_distance: 1.5,
        }
    }

    /// Appends a new input point, applying jitter rejection if distance is too small.
    pub fn add_point(&mut self, point: Point2D) {
        if let Some(last) = self.raw_points.last() {
            if last.distance_to(&point) < self.min_sample_distance {
                return;
            }
        }
        self.raw_points.push(point);
    }

    /// Returns smoothed points computed on the fly for live rendering.
    pub fn get_smoothed_points(&self) -> Vec<Point2D> {
        CatmullRomSpline::smooth(&self.raw_points, self.smoothing_subdivisions)
    }

    /// Returns cubic Bezier segments for hardware-accelerated Bezier tessellation.
    pub fn get_bezier_segments(&self) -> Vec<CubicBezierSegment> {
        CatmullRomSpline::to_cubic_beziers(&self.raw_points, self.base_width)
    }

    /// Finalizes the drawing gesture and builds the finalized `Stroke`.
    pub fn finish(self) -> (NodeId, Stroke) {
        let smoothed = self.get_smoothed_points();
        let stroke = Stroke::new(smoothed, self.color, self.base_width, self.brush_type);
        (self.target_node, stroke)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_drawing_session_lifecycle() {
        let node_id = NodeId::new();
        let mut session = DrawingSession::new(
            node_id,
            Point2D::new(0.0, 0.0, 1.0, 0),
            Color::BLACK,
            2.0,
            BrushType::Solid,
        );

        // Add distant points
        session.add_point(Point2D::new(10.0, 10.0, 1.0, 10));
        session.add_point(Point2D::new(20.0, 5.0, 1.0, 20));
        session.add_point(Point2D::new(30.0, 20.0, 1.0, 30));

        let live_points = session.get_smoothed_points();
        assert!(live_points.len() > session.raw_points.len());

        let (target, stroke) = session.finish();
        assert_eq!(target, node_id);
        assert_eq!(stroke.color, Color::BLACK);
        assert!(stroke.bounds.width() > 25.0);
    }
}
