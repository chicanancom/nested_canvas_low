# ARCHITECTURAL IMPLEMENTATION PLAN: MULTI-BOARD LECTURE STUDIO (RUST CORE)

## 1. SYSTEM IDENTITY & TARGET USE CASE
- **Product Model:** Multi-Board Lecture Blackboard System on Large Screens / Ultrawide Displays.
- **Topology:** Root Viewport Stage containing $N$ independent, isolated Sub-Boards (Artboards) with freehand vector drawing, object/segment erasing, independent backgrounds (Chalk, Whiteboard, Grid), and Tiling/Sliding window layouts.
- **Core Constraints:** Zero cross-board visual bleeding (strict AABB scissor clipping), $O(\log N)$ or fast bounding-box hit tests, deterministic 2D affine transforms, zero heap allocations in per-pointer event loops.

---

## 2. SYSTEM ARCHITECTURE & DOMAIN LAYOUT

                +------------------------------------+
                |        CanvasEngine (Root)         |
                |  - Camera (Pan, Zoom)              |
                |  - BoardLayoutManager (Tiling/Slide)|
                |  - EventDispatcher (FSM)           |
                +-----------------+------------------+
                                  |
          +-----------------------+-----------------------+
          |                                               |
+-------------v---------------+               +---------------v-------------+
|    SubBoard Node #1         |               |     SubBoard Node #2        |
| - ID: BoardId               |               | - ID: BoardId               |
| - Bounds: AABB (Local/World)|               | - Bounds: AABB (Local/World)|
| - Style: ChalkGreen / Grid  |               | - Style: Whiteboard / Lines |
| - ClipRect: Strict Scissor  |               | - ClipRect: Strict Scissor  |
| - Strokes: Vec      |               | - Strokes: Vec      |
+-----------------------------+               +-----------------------------+


---

## 3. IMPLEMENTATION PHASES

### PHASE 2: EVENT DISPATCHER & INTERACTION FINITE STATE MACHINE (FSM)
**Objective:** Capture raw input pointer events, resolve board target locks, compute local coordinates, and update active strokes.

1. **Input Representation:**
   - Define `PointerEvent`: `{ id: u32, phase: PointerPhase (Down, Move, Up, Cancel), screen_pos: Vec2, pressure: f32, timestamp_ms: u64, button: MouseButton }`.
2. **Interaction State Machine (`InteractionState`):**
   - `Idle`: Hovering or waiting.
   - `Drawing { target_board_id: BoardId, active_stroke: Stroke }`: Pointer locked to a specific sub-board.
   - `Erasing { target_board_id: BoardId, eraser_radius: f32 }`: Continuous stroke intersection check.
   - `BoardTransforming { board_id: BoardId, mode: TransformMode (Move, Resize) }`: Window manipulation.
   - `StagePanning { start_screen: Vec2, initial_camera_pan: Vec2 }`: Translating world viewport.
3. **Dispatch Invariants:**
   - **Target Locking:** PointerDown locks `target_board_id` via `hit_test_board`. Subsequent PointerMove events MUST stay bound to this target even if the cursor physically leaves the sub-board AABB during rapid motion.
   - **Local Coordinate Resolution:** All captured points must be immediately transformed into sub-board local space:
     $$P_{\text{local}} = T_{\text{board}}^{-1} \times T_{\text{camera}}^{-1} \times P_{\text{screen}}$$

---

### PHASE 3: VECTOR DRAWING ENGINE & SPLINE SMOOTHING
**Objective:** Convert discrete raw `Point2D` stream into continuous, pressure-sensitive Bézier/Catmull-Rom vector paths.

1. **Spline Interpolation Algorithms:**
   - Implement **Catmull-Rom to Cubic Bézier conversion** for real-time stroke smoothing without lag.
   - Implement **Chaikin's Corner Cutting Algorithm** for low-latency intermediate point smoothing.
2. **Dynamic Stroke Tessellation:**
   - Normal Vector Calculation: Compute perpendicular normal $N_i$ for each segment $P_i \to P_{i+1}$.
   - Width Function: $W(p, v) = W_{\text{base}} \times \text{clamp}(p, 0.2, 2.0)$ where $p$ is pressure and $v$ is velocity.
   - Mesh Output: Generate triangle strip vertices $[V_{\text{left}}, V_{\text{right}}]$ for direct GPU rasterization.
3. **Scissor Mask Invariant:**
   - Points lying outside $[0, 0] \times [\text{width}, \text{height}]$ of the sub-board must either be clamped or culled at render/tessellation boundaries.

---

### PHASE 4: ERASING ENGINE & SPATIAL QUERIES
**Objective:** High-performance stroke elimination and stroke segmentation.

1. **Object Eraser (Whole-Stroke Elimination):**
   - Given Eraser Circle $C(E_{\text{local}}, R_{\text{eraser}})$:
   - Fast Rejection: Test $C \cap \text{AABB}(\text{Stroke}) = \emptyset$.
   - Narrow Phase: Iterate stroke line segments $S(P_k, P_{k+1})$. Compute Euclidean distance:
     $$\text{dist}(E, S) \le R_{\text{eraser}} + \frac{W_{\text{stroke}}}{2}$$
   - Retain policy: Vectorized removal with index tracking for Undo stack.
2. **Segment Eraser (Stroke Splitting - Optional Phase Extension):**
   - Split existing Stroke into $K$ sub-strokes when intersected by the eraser circle.

---

### PHASE 5: BOARD LAYOUT & MULTI-BOARD WINDOW MANAGER
**Objective:** Ergonomic window arrangements for large displays.

1. **Layout Modes (`BoardLayoutMode`):**
   - `SlidingBlackboard`: Linear horizontal row of boards with fixed widths. Viewport shifts left/right to reveal boards (e.g., Board 1, Board 2, Board 3).
   - `AutoTiling`: Split layouts based on active board count:
     - 1 Board: Fullscreen ($1 \times 1$).
     - 2 Boards: Dual Vertical Split ($50\% / 50\%$).
     - 3 Boards: Triple Vertical ($33.3\% \times 3$).
     - 4 Boards: $2 \times 2$ Grid Matrix.
   - `Freeform`: User-defined floating windows with customizable $X, Y, W, H$.
2. **Board Metadata:**
   - Title header, background preset (`ChalkGreen`, `SlateBlack`, `DryEraseWhite`, `DottedGrid`), and pinned status.

---

### PHASE 6: TRANSACTIONAL STATE & UNDO/REDO ENGINE
**Objective:** Command-pattern based undo/redo tracking per sub-board or globally across the stage.

1. **Command Traits:**
   ```rust
   pub trait CanvasCommand: Send + Sync {
       fn execute(&mut self, stage: &mut StageState) -> Result<(), CanvasError>;
       fn undo(&mut self, stage: &mut StageState) -> Result<(), CanvasError>;
       fn board_id(&self) -> Option<BoardId>;
   }
Commands Defined:

AddStrokeCommand { board_id, stroke }

EraseStrokesCommand { board_id, removed_strokes: Vec<(usize, Stroke)> }

MoveBoardCommand { board_id, old_pos, new_pos }

BatchLayoutCommand { old_transforms, new_transforms }

4. CODE INVARIANTS & CONSTRAINTS FOR AI GENERATION
Memory & Performance:

No dynamic allocations inside pointer_move processing. Point buffers must be pre-allocated or mutated in-place.

Spatial math must use glam::{Vec2, Affine2, Mat3}.

Concurrency & Safety:

Data structures must implement Send + Sync where appropriate.

Zero unsafe code allowed in domain logic.

Module Structure:

src/event/: Event dispatch, pointer inputs, FSM.

src/spline/: Catmull-Rom, Chaikin, tessellation algorithms.

src/eraser/: Geometric collision tests and stroke splitting.

src/layout/: Tiling engine, sliding blackboard transitions.

src/history/: Command-based undo/redo ring buffers.