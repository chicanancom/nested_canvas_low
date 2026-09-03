use glam::Vec2;

use crate::drawing::session::DrawingSession;
use crate::math::bbox::AABB;
use crate::math::transform::{Camera, Transform2D};
use crate::model::canvas::{CanvasElement, CanvasNode};
use crate::model::scene::SceneGraph;
use crate::model::stroke::Color;
use crate::render::command::{RenderCommand, RenderQueue};

/// High-performance hierarchical rendering engine with frustum and scissor culling.
pub struct RenderPipeline;

impl RenderPipeline {
    /// Traverses the scene graph and generates an optimized `RenderQueue` for the given camera view.
    pub fn render_scene(
        scene: &SceneGraph,
        camera: &Camera,
        active_session: Option<&DrawingSession>,
    ) -> RenderQueue {
        let mut queue = RenderQueue::new();

        let screen_frustum =
            AABB::from_origin_size(Vec2::ZERO, camera.viewport_width, camera.viewport_height);
        let world_to_screen = camera.world_to_screen_transform();

        Self::render_node(
            &scene.root,
            Transform2D::IDENTITY,
            &world_to_screen,
            &screen_frustum,
            screen_frustum,
            true, // is_root
            active_session,
            &mut queue,
        );

        queue
    }

    #[allow(clippy::too_many_arguments)]
    fn render_node(
        node: &CanvasNode,
        parent_world_transform: Transform2D,
        world_to_screen: &Transform2D,
        viewport_frustum: &AABB,
        current_scissor: AABB,
        is_root: bool,
        active_session: Option<&DrawingSession>,
        queue: &mut RenderQueue,
    ) {
        queue.stats.total_nodes += 1;

        let node_world_transform = parent_world_transform.then(&node.transform);
        let node_screen_transform = node_world_transform.then(world_to_screen);
        let node_screen_bounds = node.local_bounds().transform(&node_screen_transform);

        // Frustum / Scissor culling test
        let effective_scissor = if is_root {
            *viewport_frustum
        } else {
            if let Some(clipped) = current_scissor.intersection(&node_screen_bounds) {
                clipped
            } else {
                // Node is entirely outside current scissor or viewport
                queue.stats.culled_nodes += 1;
                Self::count_culled_elements(node, queue);
                return;
            }
        };

        queue.stats.rendered_nodes += 1;

        // Apply scissor and container background for child canvases
        if !is_root {
            queue.push(RenderCommand::PushScissor {
                screen_rect: effective_scissor,
            });

            queue.push(RenderCommand::DrawCanvasBackground {
                node_id: node.id,
                screen_rect: node_screen_bounds,
                fill_color: Color::rgba(0.98, 0.98, 0.98, 1.0),
                border_color: Color::rgba(0.75, 0.75, 0.75, 1.0),
                border_width: 1.5,
            });
        }

        // Render strokes
        for elem in &node.elements {
            match elem {
                CanvasElement::Stroke(stroke) => {
                    queue.stats.total_strokes += 1;

                    let stroke_screen_bounds = stroke.bounds.transform(&node_screen_transform);
                    if effective_scissor.intersects(&stroke_screen_bounds) {
                        queue.stats.rendered_strokes += 1;
                        queue.push(RenderCommand::DrawStroke {
                            stroke: stroke.clone(),
                            transform: node_screen_transform,
                        });
                    } else {
                        queue.stats.culled_strokes += 1;
                    }
                }
            }
        }

        // Render in-flight live drawing stroke if targeted at this node
        if let Some(session) = active_session {
            if session.target_node == node.id {
                let live_smoothed = session.get_smoothed_points();
                if live_smoothed.len() >= 2 {
                    let live_stroke = crate::model::stroke::Stroke::new(
                        live_smoothed,
                        session.color,
                        session.base_width,
                        session.brush_type,
                    );
                    queue.push(RenderCommand::DrawStroke {
                        stroke: live_stroke,
                        transform: node_screen_transform,
                    });
                }
            }
        }

        // Recursively render child canvases
        for child in &node.children {
            Self::render_node(
                child,
                node_world_transform,
                world_to_screen,
                viewport_frustum,
                effective_scissor,
                false,
                active_session,
                queue,
            );
        }

        if !is_root {
            queue.push(RenderCommand::PopScissor);
        }
    }

    fn count_culled_elements(node: &CanvasNode, queue: &mut RenderQueue) {
        queue.stats.total_strokes += node.elements.len();
        queue.stats.culled_strokes += node.elements.len();
        for child in &node.children {
            queue.stats.total_nodes += 1;
            queue.stats.culled_nodes += 1;
            Self::count_culled_elements(child, queue);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::point::Point2D;
    use crate::model::stroke::{BrushType, Color, Stroke};

    #[test]
    fn test_render_pipeline_culls_offscreen_node() {
        let mut scene = SceneGraph::new();
        let root_id = scene.root_id();

        // Visible canvas
        let mut visible = CanvasNode::new(
            "Visible",
            200.0,
            200.0,
            Transform2D::from_translation(Vec2::new(50.0, 50.0)),
        );
        visible.add_stroke(Stroke::new(
            vec![Point2D::new(10.0, 10.0, 1.0, 0), Point2D::new(50.0, 50.0, 1.0, 10)],
            Color::BLACK,
            2.0,
            BrushType::Solid,
        ));
        scene.insert_child(root_id, visible).unwrap();

        // Far off-screen canvas
        let mut offscreen = CanvasNode::new(
            "Offscreen",
            200.0,
            200.0,
            Transform2D::from_translation(Vec2::new(10000.0, 10000.0)),
        );
        offscreen.add_stroke(Stroke::new(
            vec![Point2D::new(10.0, 10.0, 1.0, 0), Point2D::new(50.0, 50.0, 1.0, 10)],
            Color::BLACK,
            2.0,
            BrushType::Solid,
        ));
        scene.insert_child(root_id, offscreen).unwrap();

        let camera = Camera::new(Vec2::ZERO, 1.0, 800.0, 600.0);
        let queue = RenderPipeline::render_scene(&scene, &camera, None);

        assert_eq!(queue.stats.rendered_nodes, 2); // root + visible
        assert_eq!(queue.stats.culled_nodes, 1); // offscreen
        assert_eq!(queue.stats.rendered_strokes, 1);
        assert_eq!(queue.stats.culled_strokes, 1);
    }
}
