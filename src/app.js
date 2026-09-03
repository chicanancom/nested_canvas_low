import { Camera, Transform2D, Vec2 } from './engine/math.js';
import { Point2D, CatmullRomSpline } from './engine/smoothing.js';
import { CanvasNode, SceneGraph, Stroke, ImageElement } from './engine/scene.js';
import { EraserEngine } from './engine/erasing.js';
import { MathOCREngine } from './engine/math_ocr.js';
import { TextOCREngine } from './engine/text_ocr.js';
import { LatexEngine } from './engine/latex_engine.js';
import {
  AddStrokeCommand,
  AddImageCommand,
  CreateNodeCommand,
  EraseCommand,
  HistoryManager,
  TransformNodeCommand,
} from './engine/history.js';
import { CanvasRenderer, BOARD_THEMES } from './engine/renderer.js';
import { SyncClient } from './sync/client.js';

class NestedCanvasApp {
  constructor() {
    this.clientId = crypto.randomUUID();
    this.isApplyingRemoteSync = false;
    this.remoteActiveSessions = new Map();
    this.syncClient = null;

    this.canvas = document.getElementById('canvas');
    this.renderer = new CanvasRenderer(this.canvas);
    this.scene = new SceneGraph();
    this.history = new HistoryManager(100);
    this.camera = new Camera(0, 0, 1.0, window.innerWidth, window.innerHeight);

    // Handwriting Math OCR State
    this.ocrStrokes = [];
    this.ocrHistory = [];
    this.ocrCurrentStroke = null;
    this.ocrTool = 'pen';
    this.ocrCallback = null;

    // Marquee / Lasso Area OCR State (Cách 3)
    this.ocrSelectionBox = null;
    this.ocrHighlightBoxes = [];
    this.activeOcrTarget = null;
    this.isOcrProcessing = false;

    // Interaction State
    this.activeTool = 'pen'; // 'select', 'pan', 'pen', 'eraser-object', 'eraser-segment', 'ocr'
    this.brushType = 'solid'; // 'solid', 'highlighter'
    this.brushColor = '#ffffff'; // Default: white chalk
    this.brushSize = 3.0;
    this.eraserRadius = 18.0;

    this.selectedNodeId = null;
    this.isDragging = false;
    this.isResizing = false;
    this.resizeHandle = null;
    this.isPanning = false;
    this.lastPointerScreen = new Vec2(0, 0);

    // Active in-flight drawing gesture
    this.activeSession = null;
    this.eraserCursor = null;

    // Canvas Node Dragging / Resizing initial cache
    this.nodeDragInitialPos = null;
    this.nodeDragCurrentTransform = null;
    this.resizeInitialPos = null;
    this.resizeInitialDims = null;

    this.boardCounter = 0;
    this.desmosCounter = 0;

    this.initDefaultScene();
    this.bindEvents();
    this.initLANSync();
    this.updateUI();
    this.startRenderLoop();
  }

  initDefaultScene() {
    // Khởi đầu sạch hoàn toàn, không có bảng mẫu
    this.scene.root.children = [];
    this.selectedNodeId = null;
  }

  bindEvents() {
    window.addEventListener('resize', () => this.renderer.resize());

    // Prevent browser autoscroll on middle click
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault();
    });
    this.canvas.addEventListener('auxclick', (e) => {
      if (e.button === 1 || e.button === 2) e.preventDefault();
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Pointer Events
    this.canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

    // Keyboard Shortcuts & Spacebar Panning
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.repeat && document.activeElement?.tagName !== 'INPUT') {
        this.isSpacePressed = true;
        this.canvas.style.cursor = 'grab';
      }
      this.onKeyDown(e);
    });

    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.isSpacePressed = false;
        this.canvas.style.cursor = this.activeTool === 'pen' ? 'crosshair' : 'default';
      }
    });

    // Tool buttons
    document.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.setTool(btn.dataset.tool);
      });
    });

    // Brush type tabs
    document.querySelectorAll('.brush-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.brush-tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        this.brushType = tab.dataset.brush;
      });
    });

    // Color palette
    document.querySelectorAll('.color-dot').forEach((dot) => {
      dot.addEventListener('click', () => {
        document.querySelectorAll('.color-dot').forEach((d) => d.classList.remove('active'));
        dot.classList.add('active');
        this.brushColor = dot.dataset.color;
        document.getElementById('custom-color').value = this.brushColor;
      });
    });

    document.getElementById('custom-color').addEventListener('input', (e) => {
      this.brushColor = e.target.value;
      document.querySelectorAll('.color-dot').forEach((d) => d.classList.remove('active'));
    });

    // Brush size slider
    const sizeSlider = document.getElementById('brush-size');
    const sizeLabel = document.getElementById('brush-size-label');
    sizeSlider.addEventListener('input', (e) => {
      this.brushSize = parseFloat(e.target.value);
      sizeLabel.textContent = `${this.brushSize.toFixed(1)} px`;
    });

    // Zoom buttons
    document.getElementById('btn-zoom-in').addEventListener('click', () => {
      this.zoomAroundScreenCenter(1.2);
    });
    document.getElementById('btn-zoom-out').addEventListener('click', () => {
      this.zoomAroundScreenCenter(1.0 / 1.2);
    });
    document.getElementById('zoom-value').addEventListener('click', () => {
      this.camera.zoom = 1.0;
      this.updateZoomHUD();
    });
    document.getElementById('btn-zoom-fit').addEventListener('click', () => {
      this.fitAllContent();
    });

    // Undo / Redo
    document.getElementById('btn-undo').addEventListener('click', () => this.undo());
    document.getElementById('btn-redo').addEventListener('click', () => this.redo());

    // Nút "Sắp Xếp Bảng" (Compact Arrange Boards)
    document.getElementById('btn-arrange').addEventListener('click', () => {
      this.arrangeAllBoardsCompact();
    });

    // Thêm bảng mới
    document.getElementById('btn-add-sample').addEventListener('click', () => {
      this.createNewBoard();
    });
    document.getElementById('btn-new-child-canvas').addEventListener('click', () => {
      this.createNewBoard();
    });

    // Thêm Bảng Đồ Thị Toán Học Desmos
    const desmosBtn = document.getElementById('btn-add-desmos');
    if (desmosBtn) {
      desmosBtn.addEventListener('click', () => {
        this.createDesmosBoard();
      });
    }

    // Chèn ảnh (Insert Image)
    const imgBtn = document.getElementById('btn-insert-image');
    if (imgBtn) {
      imgBtn.addEventListener('click', () => this.promptInsertImage(null));
    }
    const imgInput = document.getElementById('image-file-input');
    if (imgInput) {
      imgInput.addEventListener('change', (e) => {
        if (e.target.files?.length > 0) {
          this.insertImageFile(e.target.files[0], this.targetImageNode);
        }
      });
    }

    // Dán ảnh từ Clipboard (Ctrl+V)
    window.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            const activeNode = this.selectedNodeId ? this.scene.getNode(this.selectedNodeId) : this.scene.root;
            this.insertImageFile(file, activeNode, this.lastPointerScreen);
          }
        }
      }
    });

    // Kéo thả file ảnh vào màn hình (Drag & Drop Image)
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer?.files?.length > 0) {
        const file = e.dataTransfer.files[0];
        const screenPos = new Vec2(e.clientX, e.clientY);
        const hit = this.hitTestBoard(screenPos);
        const targetNode = hit && hit.action === 'body' ? hit.node : this.scene.root;
        this.insertImageFile(file, targetNode, screenPos);
      }
    });

    // Xuất ảnh PNG
    document.getElementById('btn-export-png').addEventListener('click', () => {
      this.exportPNG();
    });

    // Khởi tạo Modal Canvas Viết Tay Nhận Dạng Toán Học (Math OCR)
    this.initMathOCRModal();

    // Khởi tạo Floating OCR Action Pill (Lasso / Marquee Selection OCR)
    this.initFloatingOcrPill();

    // Khởi tạo Menu Popover Giao Diện & Màn Chiếu
    this.initThemeMenu();

    // Toggle Dropdown cho mục Canvas Properties
    this.isPropertiesExpanded = false;
    const headerCanvasProp = document.getElementById('header-canvas-properties');
    const nodeProp = document.getElementById('node-properties');
    const arrowProp = document.getElementById('arrow-canvas-properties');
    if (headerCanvasProp && nodeProp) {
      headerCanvasProp.addEventListener('click', () => {
        this.isPropertiesExpanded = !this.isPropertiesExpanded;
        nodeProp.style.display = this.isPropertiesExpanded ? 'block' : 'none';
        if (arrowProp) {
          arrowProp.style.transform = this.isPropertiesExpanded ? 'rotate(0deg)' : 'rotate(-90deg)';
        }
      });
    }
  }

  setTool(tool) {
    this.activeTool = tool;
    document.querySelectorAll('.tool-btn[data-tool]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tool === tool);
    });

    const bottomBar = document.getElementById('bottom-bar');
    if (tool.startsWith('eraser') || tool === 'pan' || tool === 'select' || tool === 'ocr') {
      bottomBar.style.opacity = '0.4';
      bottomBar.style.pointerEvents = 'none';
    } else {
      bottomBar.style.opacity = '1';
      bottomBar.style.pointerEvents = 'auto';
    }

    if (tool === 'ocr') {
      this.canvas.style.cursor = 'crosshair';
    }
  }

  screenToChildContent(screenPos, node) {
    if (!node || node.id === this.scene.root.id) {
      return this.camera.screenToWorld(screenPos);
    }
    return this.scene.screenToLocal(screenPos, node.id, this.camera);
  }

  executeCommand(command, targetNodeId) {
    command.execute(this.scene);
    const node = targetNodeId ? this.scene.getNode(targetNodeId) : null;
    if (node && node.history) {
      node.history.undoStack.push(command);
      node.history.redoStack = [];
      if (node.history.undoStack.length > node.history.maxCapacity) {
        node.history.undoStack.shift();
      }
    }
    this.history.undoStack.push(command);
    this.history.redoStack = [];
    if (this.history.undoStack.length > this.history.maxCapacity) {
      this.history.undoStack.shift();
    }
  }

  promptInsertImage(targetNode) {
    this.targetImageNode = targetNode || (this.selectedNodeId ? this.scene.getNode(this.selectedNodeId) : this.scene.root);
    const input = document.getElementById('image-file-input');
    if (input) {
      input.value = '';
      input.click();
    }
  }

  insertImageFile(file, targetNode, screenPos) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const parentNode = targetNode || (this.selectedNodeId ? this.scene.getNode(this.selectedNodeId) : this.scene.root);
        const headerH = 28;
        const maxDim = parentNode.id !== this.scene.root.id ? Math.min(parentNode.width * 0.75, parentNode.height * 0.75) : 500;
        let w = img.width;
        let h = img.height;
        if (w > maxDim || h > maxDim) {
          const ratio = Math.min(maxDim / w, maxDim / h);
          w *= ratio;
          h *= ratio;
        }

        let localX = 40;
        let localY = 40;

        if (screenPos) {
          const localPt = this.scene.screenToLocal(screenPos, parentNode.id, this.camera);
          localX = Math.max(10, localPt.x - w * 0.5);
          localY = Math.max(headerH + 5, localPt.y - (h + headerH) * 0.5);
        } else if (parentNode.id !== this.scene.root.id) {
          localX = Math.max(10, (parentNode.width - w) * 0.5);
          localY = Math.max(headerH + 5, (parentNode.height - (h + headerH)) * 0.5);
        } else {
          const center = this.camera.screenToWorld(new Vec2(window.innerWidth * 0.5, window.innerHeight * 0.5));
          localX = center.x - w * 0.5;
          localY = center.y - (h + headerH) * 0.5;
        }

        const fileName = file.name ? file.name.replace(/\.[^/.]+$/, '') : 'Ảnh Mới';
        const imageCanvasNode = new CanvasNode(
          `🖼️ ${fileName}`,
          w,
          h + headerH,
          Transform2D.fromTranslation(localX, localY),
          img
        );

        const cmd = new CreateNodeCommand(parentNode.id, imageCanvasNode);
        this.executeCommand(cmd, parentNode.id);
        this.selectedNodeId = imageCanvasNode.id;
        this.updateHierarchyTree();
        this.updateNodeProperties();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  onPointerDown(e) {
    const screenPos = new Vec2(e.clientX, e.clientY);
    this.lastPointerScreen = screenPos;

    // Giữ chuột giữa (button 1), chuột phải (button 2), phím Space, hoặc công cụ Pan
    if (e.button === 1 || e.button === 2 || e.spaceKey || this.isSpacePressed || this.activeTool === 'pan') {
      e.preventDefault();
      const hit = this.hitTestBoard(screenPos);

      // CHỈ DI CHUYỂN NỘI DUNG BÊN TRONG NẾU BẢNG ĐÓ ĐÃ ĐƯỢC NHẤP CHỌN (FOCUS) HOẶC LÀ BẢNG ĐỒ THỊ DESMOS
      if (hit && hit.action === 'body' && (this.selectedNodeId === hit.node.id || hit.node.graphData) && !hit.node.image) {
        this.selectedNodeId = hit.node.id;
        this.bringToFront(hit.node.id);
        this.isPanningChild = true;
        this.panningNode = hit.node;
        this.canvas.style.cursor = 'grabbing';
        this.updateHierarchyTree();
        this.updateNodeProperties();
        return;
      }

      // Mặc định: Di chuyển camera canvas mẹ
      this.isPanning = true;
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    if (e.button === 0) {
      const hit = this.hitTestBoard(screenPos);

      // 1. Xử lý các nút trên thanh công cụ của bảng con (Header Toolbar)
      if (hit && hit.action === 'insert-image') {
        this.promptInsertImage(hit.node);
        return;
      }
      if (hit && hit.action === 'undo') {
        this.undoNode(hit.node);
        return;
      }
      if (hit && hit.action === 'redo') {
        this.redoNode(hit.node);
        return;
      }
      if (hit && hit.action === 'maximize') {
        this.focusBoardFullscreen(hit.node);
        return;
      }
      if (hit && hit.action === 'clear') {
        this.clearBoard(hit.node);
        return;
      }
      if (hit && hit.action === 'close') {
        this.deleteBoard(hit.node.id);
        return;
      }

      // 2. Xử lý 8 điểm neo co giãn kích thước (Resize Handles)
      if (hit && hit.action === 'resize') {
        this.selectedNodeId = hit.node.id;
        this.bringToFront(hit.node.id);
        this.updateHierarchyTree();
        this.updateNodeProperties();

        this.isResizing = true;
        this.resizingNode = hit.node;
        this.resizeHandle = hit.handle;
        this.resizeInitialScreenPos = screenPos.clone();
        this.resizeInitialDims = {
          width: hit.node.width,
          height: hit.node.height,
          tx: hit.node.transform.tx,
          ty: hit.node.transform.ty,
        };
        this.resizeInitialStrokes = hit.node.elements ? hit.node.elements.map((s) => s.clone()) : [];
        this.canvas.style.cursor = `${hit.handle}-resize`;
        return;
      }

      // 3. Xử lý Kéo Di Chuyển Cửa Sổ qua Thanh Tiêu Đề (Titlebar Window Dragging)
      // TUYỆT ĐỐI KHÔNG VẼ VÀO THANH TIÊU ĐỀ, BẤM VÀO LÀ DI CHUYỂN CỬA SỔ
      if (hit && hit.action === 'titlebar') {
        const now = performance.now();
        // Hỗ trợ nhấp đúp vào thanh tiêu đề để phóng to/thu nhỏ như Windows
        if (this.lastTitlebarClickNodeId === hit.node.id && now - this.lastTitlebarClickTime < 320) {
          this.focusBoardFullscreen(hit.node);
          this.lastTitlebarClickTime = 0;
          return;
        }
        this.lastTitlebarClickTime = now;
        this.lastTitlebarClickNodeId = hit.node.id;

        this.selectedNodeId = hit.node.id;
        this.bringToFront(hit.node.id);
        this.isDragging = true;
        this.draggingNode = hit.node;
        this.dragInitialScreenPos = screenPos.clone();
        this.dragInitialTransform = hit.node.transform.clone();
        this.canvas.style.cursor = 'grabbing';
        this.updateHierarchyTree();
        this.updateNodeProperties();
        return;
      }

      // 4. CÔNG CỤ BÚT VẼ (PEN TOOL) - Gán chính xác vào node mục tiêu
      if (this.activeTool === 'pen') {
        const targetNode = hit && hit.action === 'body' ? hit.node : this.scene.root;
        const localPt = this.scene.screenToLocal(screenPos, targetNode.id, this.camera);

        this.selectedNodeId = hit ? hit.node.id : null;
        if (hit) this.bringToFront(hit.node.id);
        this.updateHierarchyTree();
        this.updateNodeProperties();

        this.activeSession = {
          targetNodeId: targetNode.id,
          rawPoints: [new Point2D(localPt.x, localPt.y, e.pressure || 0.8)],
          color: this.brushColor,
          baseWidth: this.brushSize,
          brushType: this.brushType,
          getSmoothedPoints() {
            return CatmullRomSpline.smooth(this.rawPoints, 4);
          },
        };
        return;
      }

      // 5. CÔNG CỤ TẨY (ERASER TOOL - OBJECT & SEGMENT)
      if (this.activeTool.startsWith('eraser')) {
        this.isErasing = true;
        const targetNode = hit && hit.action === 'body' ? hit.node : (hit ? hit.node : this.scene.root);
        this.selectedNodeId = hit ? hit.node.id : null;
        this.performErase(screenPos, targetNode);
        return;
      }

      // 6. CÔNG CỤ CHỌN (SELECT TOOL)
      if (this.activeTool === 'select') {
        if (hit) {
          this.selectedNodeId = hit.node.id;
          this.bringToFront(hit.node.id);
          this.isDragging = true;
          this.draggingNode = hit.node;
          this.dragInitialScreenPos = screenPos.clone();
          this.dragInitialTransform = hit.node.transform.clone();
          this.canvas.style.cursor = 'grabbing';
        } else {
          this.selectedNodeId = null;
          this.isPanning = true;
        }
        this.updateHierarchyTree();
        this.updateNodeProperties();
      }

      // 7. CÔNG CỤ KHOANH VÙNG OCR (MARQUEE OCR TOOL - CÁCH 3)
      if (this.activeTool === 'ocr') {
        this.ocrSelectionBox = {
          startX: screenPos.x,
          startY: screenPos.y,
          currentX: screenPos.x,
          currentY: screenPos.y,
        };
        this.hideOcrPill();
        this.ocrHighlightBoxes = [];
        return;
      }
    }
  }

  onPointerMove(e) {
    const screenPos = new Vec2(e.clientX, e.clientY);
    const delta = screenPos.sub(this.lastPointerScreen);
    this.lastPointerScreen = screenPos;

    // 0. Cập nhật hộp khoanh vùng OCR
    if (this.activeTool === 'ocr' && this.ocrSelectionBox) {
      this.ocrSelectionBox.currentX = screenPos.x;
      this.ocrSelectionBox.currentY = screenPos.y;
      return;
    }

    // 1. Di chuyển nội dung vô tận bên trong bảng con (Child Board Content Pan)
    if (this.isPanningChild && this.panningNode) {
      const worldDelta = delta.scale(1.0 / this.camera.zoom);
      this.panningNode.contentPan.x -= worldDelta.x;
      this.panningNode.contentPan.y -= worldDelta.y;
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    // 2. Di chuyển camera sân khấu canvas mẹ (Mother Canvas Pan)
    if (this.isPanning || (e.buttons & 4) !== 0) {
      this.camera.pan = this.camera.pan.sub(delta.scale(1.0 / this.camera.zoom));
      this.updateZoomHUD();
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    // 3. Co giãn kích thước bảng (Resizing)
    if (this.isResizing && this.resizingNode && this.resizeInitialDims) {
      const node = this.resizingNode;
      const parentNode = this.scene.root.findParentNode(node.id) || this.scene.root;
      const p0 = this.scene.screenToLocal(this.resizeInitialScreenPos, parentNode.id, this.camera);
      const p1 = this.scene.screenToLocal(screenPos, parentNode.id, this.camera);
      const localDelta = p1.sub(p0);
      const { width, height, tx, ty } = this.resizeInitialDims;

      if (this.resizeHandle === 'se') {
        node.width = Math.max(100, width + localDelta.x);
        node.height = Math.max(100, height + localDelta.y);
      } else if (this.resizeHandle === 'e') {
        node.width = Math.max(100, width + localDelta.x);
      } else if (this.resizeHandle === 's') {
        node.height = Math.max(100, height + localDelta.y);
      } else if (this.resizeHandle === 'sw') {
        const newW = Math.max(100, width - localDelta.x);
        node.transform.tx = tx + (width - newW);
        node.width = newW;
        node.height = Math.max(100, height + localDelta.y);
      } else if (this.resizeHandle === 'ne') {
        node.width = Math.max(100, width + localDelta.x);
        const newH = Math.max(100, height - localDelta.y);
        node.transform.ty = ty + (height - newH);
        node.height = newH;
      } else if (this.resizeHandle === 'nw') {
        const newW = Math.max(100, width - localDelta.x);
        const newH = Math.max(100, height - localDelta.y);
        node.transform.tx = tx + (width - newW);
        node.transform.ty = ty + (height - newH);
        node.width = newW;
        node.height = newH;
      }

      // Tự động co giãn tỉ lệ các nét vẽ trên ảnh khi phóng to/thu nhỏ bảng ảnh
      if (node.image && this.resizeInitialStrokes && this.resizeInitialStrokes.length > 0) {
        const headerH = 28;
        const initBodyH = Math.max(1, height - headerH);
        const newBodyH = Math.max(1, node.height - headerH);
        const scaleX = node.width / width;
        const scaleY = newBodyH / initBodyH;

        node.elements = this.resizeInitialStrokes.map((origStroke) => {
          const scaledPoints = origStroke.points.map((pt) => {
            return new Point2D(
              pt.x * scaleX,
              headerH + (pt.y - headerH) * scaleY,
              pt.pressure
            );
          });
          const scaledStroke = new Stroke(
            scaledPoints,
            origStroke.color,
            origStroke.baseWidth * ((scaleX + scaleY) * 0.5),
            origStroke.brushType
          );
          scaledStroke.id = origStroke.id;
          return scaledStroke;
        });
      }

      const wInput = document.getElementById('prop-w');
      const hInput = document.getElementById('prop-h');
      if (wInput) wInput.value = Math.round(node.width);
      if (hInput) hInput.value = Math.round(node.height);
      return;
    }

    // 4. Kéo di chuyển bảng (Dragging)
    if (this.isDragging && this.draggingNode && this.dragInitialTransform) {
      const parentNode = this.scene.root.findParentNode(this.draggingNode.id) || this.scene.root;
      const p0 = this.scene.screenToLocal(this.dragInitialScreenPos, parentNode.id, this.camera);
      const p1 = this.scene.screenToLocal(screenPos, parentNode.id, this.camera);
      const deltaInParent = p1.sub(p0);

      this.draggingNode.transform.tx = this.dragInitialTransform.tx + deltaInParent.x;
      this.draggingNode.transform.ty = this.dragInitialTransform.ty + deltaInParent.y;
      return;
    }

    // 5. Thêm điểm vẽ của cái bút đang thao tác
    if (this.activeSession) {
      const localPt = this.scene.screenToLocal(screenPos, this.activeSession.targetNodeId, this.camera);
      const lastPt = this.activeSession.rawPoints[this.activeSession.rawPoints.length - 1];

      if (lastPt.distanceTo(localPt) > 1.5) {
        this.activeSession.rawPoints.push(
          new Point2D(localPt.x, localPt.y, e.pressure || 0.8)
        );

        // Phát sóng nét vẽ đang vẽ trực tiếp qua mạng LAN (Live Streaming)
        if (this.syncClient && this.syncClient.isConnected) {
          const smoothed = this.activeSession.getSmoothedPoints ? this.activeSession.getSmoothedPoints() : this.activeSession.rawPoints;
          this.syncClient.send('STROKE_LIVE', {
            clientId: this.clientId,
            session: {
              targetNodeId: this.activeSession.targetNodeId,
              points: smoothed.map((p) => ({ x: p.x, y: p.y, pressure: p.pressure })),
              color: this.activeSession.color,
              baseWidth: this.activeSession.baseWidth,
              brushType: this.activeSession.brushType,
            },
          });
        }
      }
    }

    // 6. Xử lý di chuột xóa liên tục (Continuous Drag Erasing)
    if (this.activeTool.startsWith('eraser')) {
      this.eraserCursor = {
        x: screenPos.x,
        y: screenPos.y,
        radius: this.eraserRadius,
      };
      if (e.buttons === 1 || this.isErasing) {
        const hit = this.hitTestBoard(screenPos);
        const targetNode = hit && hit.action === 'body' ? hit.node : (hit ? hit.node : this.scene.root);
        if (targetNode) {
          this.performErase(screenPos, targetNode);
        }
      }
    } else {
      this.eraserCursor = null;
    }

    // Cập nhật con trỏ chuột linh hoạt khi di chuyển tự do (Hover Cursor)
    if (!this.isDragging && !this.isResizing && !this.isPanning && !this.isPanningChild && !this.activeSession) {
      const hoverHit = this.hitTestBoard(screenPos);
      if (hoverHit) {
        if (hoverHit.action === 'resize') {
          this.canvas.style.cursor = `${hoverHit.handle}-resize`;
        } else if (hoverHit.action === 'maximize' || hoverHit.action === 'clear' || hoverHit.action === 'close' || hoverHit.action === 'undo' || hoverHit.action === 'redo' || hoverHit.action === 'insert-image') {
          this.canvas.style.cursor = 'pointer';
        } else if (hoverHit.action === 'titlebar') {
          this.canvas.style.cursor = 'grab';
        } else if (hoverHit.action === 'body') {
          if (hoverHit.node.graphData && (this.activeTool === 'pan' || this.isSpacePressed)) {
            this.canvas.style.cursor = 'grab';
          } else {
            this.canvas.style.cursor = this.activeTool === 'pen' ? 'crosshair' : (this.activeTool.startsWith('eraser') ? 'none' : 'default');
          }
        }
      } else {
        this.canvas.style.cursor = this.activeTool === 'pan' ? 'grab' : (this.activeTool.startsWith('eraser') ? 'none' : 'crosshair');
      }
    }
  }

  onPointerUp(e) {
    if (this.isPanning) {
      this.isPanning = false;
    }

    if (this.isPanningChild) {
      this.isPanningChild = false;
      this.panningNode = null;
    }

    if (this.isResizing) {
      if (this.syncClient && this.syncClient.isConnected && this.resizingNode) {
        this.syncClient.send('NODE_TRANSFORM', {
          nodeId: this.resizingNode.id,
          x: this.resizingNode.transform.tx,
          y: this.resizingNode.transform.ty,
          w: this.resizingNode.width,
          h: this.resizingNode.height,
        });
      }
      this.isResizing = false;
      this.resizingNode = null;
      this.resizeHandle = null;
      this.resizeInitialStrokes = null;
    }

    if (this.isErasing) {
      this.isErasing = false;
    }

    if (this.activeEraseSession) {
      const { nodeId, initialStrokes } = this.activeEraseSession;
      const node = this.scene.getNode(nodeId);
      if (node) {
        const finalStrokes = [...node.elements];
        this.history.execute(
          new EraseCommand(nodeId, initialStrokes, finalStrokes),
          this.scene
        );
        if (this.syncClient && this.syncClient.isConnected) {
          const remainingIds = new Set(finalStrokes.map((s) => s.id));
          const removedIds = initialStrokes.filter((s) => !remainingIds.has(s.id)).map((s) => s.id);
          if (removedIds.length > 0) {
            this.syncClient.send('STROKE_ERASE', {
              nodeId,
              removedStrokeIds: removedIds,
            });
          }
        }
      }
      this.activeEraseSession = null;
      this.updateHierarchyTree();
    }

    if (this.isDragging && this.draggingNode) {
      this.isDragging = false;
      if (this.dragInitialTransform) {
        this.history.execute(
          new TransformNodeCommand(this.draggingNode.id, this.dragInitialTransform, this.draggingNode.transform.clone()),
          this.scene
        );
        if (this.syncClient && this.syncClient.isConnected) {
          this.syncClient.send('NODE_TRANSFORM', {
            nodeId: this.draggingNode.id,
            x: this.draggingNode.transform.tx,
            y: this.draggingNode.transform.ty,
            w: this.draggingNode.width,
            h: this.draggingNode.height,
          });
        }
      }
      this.draggingNode = null;
    }

    const hoverHit = this.hitTestBoard(new Vec2(e.clientX, e.clientY));
    if (hoverHit && hoverHit.action === 'titlebar') {
      this.canvas.style.cursor = 'grab';
    } else {
      this.canvas.style.cursor = this.activeTool === 'pen' ? 'crosshair' : (this.activeTool.startsWith('eraser') ? 'none' : 'default');
    }

    if (this.activeTool === 'ocr' && this.ocrSelectionBox) {
      const box = this.ocrSelectionBox;
      const w = Math.abs(box.currentX - box.startX);
      const h = Math.abs(box.currentY - box.startY);
      this.ocrSelectionBox = null;

      if (w >= 16 && h >= 16) {
        this.executeMarqueeOCR(box);
      }
      return;
    }

    if (this.activeSession) {
      const smoothed = this.activeSession.getSmoothedPoints();
      if (smoothed.length >= 2) {
        const stroke = new Stroke(
          smoothed,
          this.activeSession.color,
          this.activeSession.baseWidth,
          this.activeSession.brushType
        );
        const cmd = new AddStrokeCommand(this.activeSession.targetNodeId, stroke);
        this.executeCommand(cmd, this.activeSession.targetNodeId);

        if (this.syncClient && this.syncClient.isConnected) {
          this.syncClient.send('STROKE_ADD', {
            clientId: this.clientId,
            nodeId: this.activeSession.targetNodeId,
            stroke: stroke.toJSON(),
          });
        }
      }
      this.activeSession = null;
      this.updateHierarchyTree();
    }
  }

  hitTestBoard(screenPos) {
    const testNode = (node) => {
      // Test children first (deepest/topmost drawn on top)
      for (let i = node.children.length - 1; i >= 0; i--) {
        const hit = testNode(node.children[i]);
        if (hit) return hit;
      }

      if (node.id === this.scene.root.id) return null;

      const screenTransform = this.scene.computeScreenTransform(node.id, this.camera);
      const screenBounds = node.localBounds().transform(screenTransform);
      const headerH = Math.max(24, Math.min(32, 28 * Math.min(this.camera.zoom, 1.2)));

      // 1. Kiểm tra 8 điểm neo Resize (hỗ trợ cả khi chưa chọn mà nhấp góc bảng)
      const handleHitRadius = 14;
      const isSelected = this.selectedNodeId === node.id;
      const handles = isSelected
        ? [
            { name: 'nw', x: screenBounds.minX, y: screenBounds.minY },
            { name: 'ne', x: screenBounds.maxX, y: screenBounds.minY },
            { name: 'se', x: screenBounds.maxX, y: screenBounds.maxY },
            { name: 'sw', x: screenBounds.minX, y: screenBounds.maxY },
            { name: 'n', x: (screenBounds.minX + screenBounds.maxX) * 0.5, y: screenBounds.minY },
            { name: 's', x: (screenBounds.minX + screenBounds.maxX) * 0.5, y: screenBounds.maxY },
            { name: 'e', x: screenBounds.maxX, y: (screenBounds.minY + screenBounds.maxY) * 0.5 },
            { name: 'w', x: screenBounds.minX, y: (screenBounds.minY + screenBounds.maxY) * 0.5 },
          ]
        : [
            { name: 'se', x: screenBounds.maxX, y: screenBounds.maxY },
            { name: 'sw', x: screenBounds.minX, y: screenBounds.maxY },
            { name: 'ne', x: screenBounds.maxX, y: screenBounds.minY },
            { name: 'nw', x: screenBounds.minX, y: screenBounds.minY },
          ];

      for (const handle of handles) {
        if (Math.hypot(screenPos.x - handle.x, screenPos.y - handle.y) <= handleHitRadius) {
          const localPt = this.scene.screenToLocal(screenPos, node.id, this.camera);
          return { node, action: 'resize', handle: handle.name, localPt };
        }
      }

      // 2. Kiểm tra bên trong hình chữ nhật trên màn hình
      if (
        screenPos.x >= screenBounds.minX &&
        screenPos.x <= screenBounds.maxX &&
        screenPos.y >= screenBounds.minY &&
        screenPos.y <= screenBounds.maxY
      ) {
        const localPt = this.scene.screenToLocal(screenPos, node.id, this.camera);

        // Vùng thanh tiêu đề Header (y từ minY đến minY + headerH)
        if (screenPos.y <= screenBounds.minY + headerH) {
          const centerY = screenBounds.minY + headerH * 0.5;
          const w = screenBounds.width;
          const btnRadius = 12;

          // 1. Nút Đóng / Xóa bảng (✕)
          const delX = screenBounds.maxX - 12;
          if (Math.hypot(screenPos.x - delX, screenPos.y - centerY) <= btnRadius) {
            return { node, action: 'close', localPt };
          }
          // 2. Nút Phóng to Focus (⛶)
          if (w >= 56) {
            const maxX = screenBounds.maxX - 34;
            if (Math.hypot(screenPos.x - maxX, screenPos.y - centerY) <= btnRadius) {
              return { node, action: 'maximize', localPt };
            }
          }
          // 3. Nút Xóa sạch nét (🗑️)
          if (w >= 80) {
            const clrX = screenBounds.maxX - 56;
            if (Math.hypot(screenPos.x - clrX, screenPos.y - centerY) <= btnRadius) {
              return { node, action: 'clear', localPt };
            }
          }
          // 4. Nút Redo (↷)
          if (w >= 104) {
            const redoX = screenBounds.maxX - 78;
            if (Math.hypot(screenPos.x - redoX, screenPos.y - centerY) <= btnRadius) {
              return { node, action: 'redo', localPt };
            }
          }
          // 5. Nút Undo (↶)
          if (w >= 128) {
            const undoX = screenBounds.maxX - 100;
            if (Math.hypot(screenPos.x - undoX, screenPos.y - centerY) <= btnRadius) {
              return { node, action: 'undo', localPt };
            }
          }
          // 6. Nút Chèn Ảnh (🖼️)
          if (w >= 152) {
            const imgX = screenBounds.maxX - 122;
            if (Math.hypot(screenPos.x - imgX, screenPos.y - centerY) <= btnRadius) {
              return { node, action: 'insert-image', localPt };
            }
          }

          return { node, action: 'titlebar', localPt };
        }

        // Vùng thân bảng Body
        return { node, action: 'body', localPt };
      }

      return null;
    };

    return testNode(this.scene.root);
  }

  focusBoardFullscreen(node) {
    // Nếu bảng này đang được phóng to toàn màn hình, bấm lần nữa để thu nhỏ phục hồi góc nhìn cũ
    if (this.savedFullscreenCamera && this.fullscreenTargetNodeId === node.id) {
      this.camera.zoom = this.savedFullscreenCamera.zoom;
      this.camera.pan = this.savedFullscreenCamera.pan.clone();
      this.savedFullscreenCamera = null;
      this.fullscreenTargetNodeId = null;
      this.updateZoomHUD();
      return;
    }

    this.savedFullscreenCamera = {
      zoom: this.camera.zoom,
      pan: this.camera.pan.clone(),
    };
    this.fullscreenTargetNodeId = node.id;

    const padding = 64;
    const availW = Math.max(200, window.innerWidth - padding * 2);
    const availH = Math.max(200, window.innerHeight - padding * 2);

    const worldTransform = this.scene.computeWorldTransform(node.id);
    const worldScale = Math.hypot(worldTransform.a, worldTransform.b) || 1.0;
    const worldW = node.width * worldScale;
    const worldH = node.height * worldScale;

    const zoomW = availW / worldW;
    const zoomH = availH / worldH;
    const targetZoom = Math.max(0.1, Math.min(8.0, Math.min(zoomW, zoomH)));

    const worldCenter = worldTransform.transformPoint(new Vec2(node.width * 0.5, node.height * 0.5));

    this.camera.zoom = targetZoom;
    this.camera.pan = worldCenter;

    this.selectedNodeId = node.id;
    this.bringToFront(node.id);
    this.updateZoomHUD();
    this.updateHierarchyTree();
    this.updateNodeProperties();
  }

  clearBoard(node) {
    if (node.elements.length === 0 && (!node.images || node.images.length === 0)) return;
    const cmd = new EraseCommand(node.id, [...node.elements], []);
    this.executeCommand(cmd, node.id);
    this.updateHierarchyTree();
    this.updateNodeProperties();
  }

  bringToFront(nodeId) {
    const parentNode = this.scene.root.findParentNode(nodeId) || this.scene.root;
    const idx = parentNode.children.findIndex((c) => c.id === nodeId);
    if (idx !== -1 && idx !== parentNode.children.length - 1) {
      const [node] = parentNode.children.splice(idx, 1);
      parentNode.children.push(node);
      this.updateHierarchyTree();
    }
  }

  deleteBoard(nodeId) {
    const parentNode = this.scene.root.findParentNode(nodeId) || this.scene.root;
    parentNode.removeChild(nodeId);
    if (this.selectedNodeId === nodeId) {
      this.selectedNodeId = parentNode.id !== this.scene.root.id ? parentNode.id : (this.scene.root.children.length > 0 ? this.scene.root.children[0].id : null);
    }
    if (this.syncClient && this.syncClient.isConnected && !this.isApplyingRemoteSync) {
      this.syncClient.send('NODE_DELETE', { nodeId });
    }
    this.updateHierarchyTree();
    this.updateNodeProperties();
    this.updateUI();
  }

  performErase(screenPos, node) {
    if (!node) return;
    const localPt = this.scene.screenToLocal(screenPos, node.id, this.camera);
    const screenT = this.scene.computeContentScreenTransform(node.id, this.camera);
    const screenScale = Math.hypot(screenT.a, screenT.b) || 1.0;
    const localRadius = this.eraserRadius / screenScale;

    if (!this.activeEraseSession) {
      this.activeEraseSession = {
        nodeId: node.id,
        initialStrokes: [...node.elements],
      };
    }

    if (this.activeTool === 'eraser-object') {
      EraserEngine.eraseObjectInNode(node, localPt, localRadius);
    } else if (this.activeTool === 'eraser-segment') {
      EraserEngine.eraseSegmentInNode(node, localPt, localRadius);
    }
  }

  onWheel(e) {
    e.preventDefault();
    const screenPos = new Vec2(e.clientX, e.clientY);
    const factor = e.deltaY < 0 ? 1.12 : 1.0 / 1.12;

    const hit = this.hitTestBoard(screenPos);

    // CHỈ THU PHÓNG BÊN TRONG BẢNG CON NẾU BẢNG ĐÓ ĐANG ĐƯỢC CHỌN (FOCUS) HOẶC LÀ BẢNG ĐỒ THỊ DESMOS
    if (hit && hit.action === 'body' && (this.selectedNodeId === hit.node.id || hit.node.graphData) && !hit.node.image) {
      const node = hit.node;
      const worldTransform = this.scene.computeWorldTransform(node.id);
      const localWindowPt = this.camera.screenToChildLocal(screenPos, worldTransform);

      const currentZoom = node.contentZoom || 1.0;
      const panX = node.contentPan ? node.contentPan.x : 0;
      const panY = node.contentPan ? node.contentPan.y : 0;

      // Điểm nội dung dưới con trỏ trước khi zoom
      const contentX = (localWindowPt.x + panX) / currentZoom;
      const contentY = (localWindowPt.y + panY) / currentZoom;

      const newZoom = Math.max(0.15, Math.min(8.0, currentZoom * factor));
      node.contentZoom = newZoom;
      node.contentPan = new Vec2(
        contentX * newZoom - localWindowPt.x,
        contentY * newZoom - localWindowPt.y
      );
      return;
    }

    // Nếu chưa chọn bảng hoặc rê chuột ra ngoài -> THU PHÓNG TOÀN BỘ CAMERA SÂN KHẤU MẸ
    this.zoomAtAnchor(screenPos, factor);
  }

  zoomAtAnchor(anchorScreen, factor) {
    const worldAnchor = this.camera.screenToWorld(anchorScreen);
    const newZoom = Math.max(0.05, Math.min(32.0, this.camera.zoom * factor));
    this.camera.zoom = newZoom;

    const screenCenter = new Vec2(
      this.camera.viewportWidth * 0.5,
      this.camera.viewportHeight * 0.5
    );
    const offset = anchorScreen.sub(screenCenter);
    this.camera.pan = worldAnchor.sub(offset.scale(1.0 / newZoom));
    this.updateZoomHUD();
  }

  zoomAroundScreenCenter(factor) {
    const center = new Vec2(window.innerWidth * 0.5, window.innerHeight * 0.5);
    this.zoomAtAnchor(center, factor);
  }

  onKeyDown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      if (e.shiftKey) {
        this.redo();
      } else {
        this.undo();
      }
      e.preventDefault();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      this.redo();
      e.preventDefault();
    } else if (e.key.toLowerCase() === 'v') {
      this.setTool('select');
    } else if (e.key.toLowerCase() === 'h') {
      this.setTool('pan');
    } else if (e.key.toLowerCase() === 'p') {
      this.setTool('pen');
    } else if (e.key.toLowerCase() === 'o') {
      this.setTool('ocr');
    } else if (e.key.toLowerCase() === 'e') {
      this.setTool(e.shiftKey ? 'eraser-segment' : 'eraser-object');
    } else if (e.key.toLowerCase() === 'f') {
      this.fitAllContent();
    } else if (e.key === '0') {
      this.fitAllContent();
    }
  }

  undoNode(node) {
    if (node && node.history && node.history.canUndo()) {
      node.history.undo(this.scene);
      this.updateHierarchyTree();
      this.updateNodeProperties();
      return;
    }
    if (this.history.canUndo()) {
      this.history.undo(this.scene);
      this.updateHierarchyTree();
      this.updateNodeProperties();
    }
  }

  redoNode(node) {
    if (node && node.history && node.history.canRedo()) {
      node.history.redo(this.scene);
      this.updateHierarchyTree();
      this.updateNodeProperties();
      return;
    }
    if (this.history.canRedo()) {
      this.history.redo(this.scene);
      this.updateHierarchyTree();
      this.updateNodeProperties();
    }
  }

  undo() {
    const activeNode = this.selectedNodeId ? this.scene.getNode(this.selectedNodeId) : null;
    this.undoNode(activeNode);
  }

  redo() {
    const activeNode = this.selectedNodeId ? this.scene.getNode(this.selectedNodeId) : null;
    this.redoNode(activeNode);
  }

  createNewBoard() {
    this.boardCounter = (this.boardCounter || 0) + 1;
    const count = this.boardCounter;
    const screenCenter = new Vec2(window.innerWidth * 0.5, window.innerHeight * 0.5);
    const worldPos = this.camera.screenToWorld(screenCenter);

    const newBoard = new CanvasNode(
      `Bảng ${count}`,
      680,
      460,
      Transform2D.fromTranslation(worldPos.x - 340, worldPos.y - 230)
    );
    newBoard.style = this.globalTheme || this.scene.root.style || 'chalkboard';
    newBoard.gridType = this.globalGrid || this.scene.root.gridType || 'grid';

    this.history.execute(new CreateNodeCommand(this.scene.root.id, newBoard), this.scene);
    this.selectedNodeId = newBoard.id;
    if (this.syncClient && this.syncClient.isConnected && !this.isApplyingRemoteSync) {
      this.syncClient.send('NODE_CREATE', {
        node: newBoard.toJSON(),
      });
    }
    this.updateHierarchyTree();
    this.updateNodeProperties();
    this.updateUI();
  }

  /**
   * Sắp xếp gom gọn toàn bộ các bảng con vào lưới tối ưu cạnh nhau,
   * sử dụng thuật toán Dynamic Flow Packing để khoảng cách giữa các bảng
   * luôn đều nhau chuẩn xác (gap = 32px), bất kể bảng to hay nhỏ.
   */
  arrangeAllBoardsCompact(targetParentNode) {
    const parent = targetParentNode || (this.selectedNodeId ? (this.scene.getNode(this.selectedNodeId).children.length > 1 ? this.scene.getNode(this.selectedNodeId) : this.scene.root) : this.scene.root);
    const boards = parent.children;
    const n = boards.length;
    if (n === 0) return;

    const gap = 32; // Khoảng cách cố định hoàn hảo giữa các bảng
    const isRoot = parent.id === this.scene.root.id;

    if (n === 1) {
      if (isRoot) {
        boards[0].transform = Transform2D.fromTranslation(100, 100);
      } else {
        boards[0].transform = Transform2D.fromTranslation(
          Math.max(20, (parent.width - boards[0].width) * 0.5),
          Math.max(35, (parent.height - boards[0].height) * 0.5)
        );
      }
      this.fitAllContent();
      this.updateHierarchyTree();
      this.updateNodeProperties();
      return;
    }

    // Tính toán độ rộng mục tiêu để bố cục cụm bảng cân đối theo tỉ lệ 16:9
    const totalArea = boards.reduce((sum, b) => sum + (b.width + gap) * (b.height + gap), 0);
    const targetWidth = Math.max(800, Math.sqrt(totalArea * 1.77));

    let startX = isRoot ? 100 : 24;
    let startY = isRoot ? 100 : 36;

    let curX = startX;
    let curY = startY;
    let rowHeight = 0;
    let boardsInRow = 0;

    for (let i = 0; i < n; i++) {
      const b = boards[i];

      // Nếu cộng thêm bảng này vượt quá độ rộng hàng mục tiêu -> Xuống dòng mới
      if (boardsInRow > 0 && curX + b.width > startX + targetWidth) {
        curX = startX;
        curY += rowHeight + gap;
        rowHeight = 0;
        boardsInRow = 0;
      }

      b.transform = Transform2D.fromTranslation(curX, curY);
      curX += b.width + gap;
      rowHeight = Math.max(rowHeight, b.height);
      boardsInRow++;
    }

    // Tự động căn máy quay (Camera Frame) bao quát toàn bộ cụm bảng vừa sắp xếp
    this.fitAllContent();
    this.updateHierarchyTree();
    this.updateNodeProperties();
  }

  fitAllContent() {
    const boards = this.scene.root.children;
    if (boards.length === 0) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const b of boards) {
      minX = Math.min(minX, b.transform.tx);
      minY = Math.min(minY, b.transform.ty);
      maxX = Math.max(maxX, b.transform.tx + b.width);
      maxY = Math.max(maxY, b.transform.ty + b.height);
    }

    const totalW = maxX - minX;
    const totalH = maxY - minY;

    const padding = 80;
    const availW = window.innerWidth - padding * 2;
    const availH = window.innerHeight - padding * 2;

    const zoomW = availW / totalW;
    const zoomH = availH / totalH;
    const targetZoom = Math.max(0.15, Math.min(1.2, Math.min(zoomW, zoomH)));

    this.camera.zoom = targetZoom;
    this.camera.pan = new Vec2(
      (minX + maxX) * 0.5,
      (minY + maxY) * 0.5
    );

    this.updateZoomHUD();
  }

  exportPNG() {
    const link = document.createElement('a');
    link.download = `lecture-boards-${Date.now()}.png`;
    link.href = this.canvas.toDataURL('image/png');
    link.click();
  }

  updateUI() {
    this.updateZoomHUD();
    this.updateHierarchyTree();
    this.updateNodeProperties();
  }

  updateZoomHUD() {
    const val = document.getElementById('zoom-value');
    if (val) val.textContent = `${Math.round(this.camera.zoom * 100)}%`;
  }

  updateHierarchyTree() {
    const container = document.getElementById('tree-list');
    if (!container) return;
    container.innerHTML = '';

    const boards = this.scene.root.children;

    for (const node of boards) {
      const item = document.createElement('div');
      item.className = `tree-item ${node.id === this.selectedNodeId ? 'selected' : ''}`;
      item.innerHTML = `
        <span>📋 ${node.name}</span>
        <span style="font-size:10px; opacity:0.6">${node.elements.length} nét</span>
      `;
      item.addEventListener('click', () => {
        this.selectedNodeId = node.id;
        this.bringToFront(node.id);
        this.updateHierarchyTree();
        this.updateNodeProperties();
      });
      container.appendChild(item);
    }

    const activeNode = this.scene.getNode(this.selectedNodeId);
    const activeBadge = document.getElementById('stat-active-board');
    if (activeBadge) {
      activeBadge.textContent = activeNode ? `Đang chọn: ${activeNode.name.split(':')[0]}` : 'Chưa chọn bảng';
    }

    const totalStrokes = this.countTotalStrokes(this.scene.root);
    document.getElementById('stat-nodes').textContent = boards.length;
    document.getElementById('stat-strokes').textContent = totalStrokes;
  }

  countTotalStrokes(node) {
    let sum = node.elements.length;
    for (const c of node.children) sum += this.countTotalStrokes(c);
    return sum;
  }

  updateColorPaletteActive() {
    document.querySelectorAll('.color-dot').forEach((dot) => {
      dot.classList.toggle('active', dot.dataset.color === this.brushColor);
    });
  }

  createDesmosBoard(targetParent) {
    const parent = targetParent || this.scene.root;
    this.graphCounter = (this.graphCounter || 0) + 1;
    const count = this.graphCounter;
    const isRoot = parent.id === this.scene.root.id;

    let posX = 100;
    let posY = 100;
    if (isRoot) {
      const screenCenter = new Vec2(window.innerWidth * 0.5, window.innerHeight * 0.5);
      const worldPos = this.camera.screenToWorld(screenCenter);
      posX = worldPos.x - 360;
      posY = worldPos.y - 250;
    } else {
      posX = Math.max(20, (parent.width - 720) * 0.5);
      posY = Math.max(35, (parent.height - 500) * 0.5);
    }

    const defaultGraphData = {
      xSpan: 20,
      expressions: [
        { id: 'exp_1', expr: 'sin(x)', color: '#58a6ff', visible: true },
        { id: 'exp_2', expr: '0.2 * x^2 - 3', color: '#f85149', visible: true },
      ],
      params: { a: 1.0, b: 1.0 },
    };

    const desmosNode = new CanvasNode(
      `📈 Đồ Thị ${count}`,
      720,
      500,
      Transform2D.fromTranslation(posX, posY),
      null,
      defaultGraphData,
      this.globalTheme || this.scene.root.style || 'chalkboard',
      this.globalGrid || this.scene.root.gridType || 'grid'
    );

    const cmd = new CreateNodeCommand(parent.id, desmosNode);
    this.executeCommand(cmd, parent.id);
    this.selectedNodeId = desmosNode.id;
    if (this.syncClient && this.syncClient.isConnected && !this.isApplyingRemoteSync) {
      this.syncClient.send('NODE_CREATE', {
        node: desmosNode.toJSON(),
      });
    }
    this.updateHierarchyTree();
    this.updateNodeProperties();
    this.updateUI();
  }

  updateNodeProperties() {
    const propPanel = document.getElementById('node-properties');
    if (!propPanel) return;

    propPanel.style.display = this.isPropertiesExpanded ? 'block' : 'none';
    const badge = document.getElementById('badge-canvas-properties');

    const themes = [
      { id: 'chalkboard', name: 'Bảng Phấn', icon: '🏫', bg: '#142c22', desc: 'Giảng đường' },
      { id: 'whiteboard', name: 'Bảng Trắng', icon: '🏢', bg: '#f8fafc', desc: 'Máy chiếu sáng' },
      { id: 'blueprint', name: 'Kỹ Thuật', icon: '📐', bg: '#0a192f', desc: 'Xanh Blueprint' },
      { id: 'midnight', name: 'Đen OLED', icon: '🌌', bg: '#06080c', desc: 'Tương phản cao' },
      { id: 'warmpaper', name: 'Giấy Vàng', icon: '📜', bg: '#fcf8ec', desc: 'Chống mỏi mắt' },
      { id: 'dark', name: 'Hiện Đại', icon: '💻', bg: '#161f2e', desc: 'Xanh đen chuẩn' },
    ];

    const grids = [
      { id: 'grid', name: 'Ô Caro', icon: '▦' },
      { id: 'dots', name: 'Chấm Bi', icon: '⁝⁝' },
      { id: 'lines', name: 'Kẻ Ngang', icon: '☰' },
      { id: 'none', name: 'Trơn', icon: '◻' },
    ];

    if (!this.selectedNodeId || this.selectedNodeId === this.scene.root.id) {
      if (badge) badge.textContent = '(Màn Chiếu)';
      const currentThemeId = this.globalTheme || this.scene.root.style || 'dark';
      const currentGridId = this.globalGrid || this.scene.root.gridType || 'dots';

      propPanel.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:10px;">
          <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--border-subtle); padding-bottom:8px;">
            <span style="font-weight:600; font-size:12px; color:#58a6ff;">🌟 Bảng Chính (Toàn Màn Hình)</span>
            <span style="font-size:10px; color:var(--text-muted);">Màn Chiếu</span>
          </div>

          <label style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:11px; color:var(--text-muted);">Màu màn chiếu:</span>
            <select id="prop-global-theme" style="background:#21262d; border:1px solid var(--border-subtle); color:#f0f6fc; border-radius:4px; padding:3px 6px; width:130px; font-size:11px; cursor:pointer;">
              ${themes.map((t) => `<option value="${t.id}" ${currentThemeId === t.id ? 'selected' : ''}>${t.icon} ${t.name}</option>`).join('')}
            </select>
          </label>

          <label style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:11px; color:var(--text-muted);">Lưới nền:</span>
            <select id="prop-global-grid" style="background:#21262d; border:1px solid var(--border-subtle); color:#f0f6fc; border-radius:4px; padding:3px 6px; width:130px; font-size:11px; cursor:pointer;">
              ${grids.map((g) => `<option value="${g.id}" ${currentGridId === g.id ? 'selected' : ''}>${g.icon} ${g.name}</option>`).join('')}
            </select>
          </label>
        </div>
      `;

      const globalThemeSelect = document.getElementById('prop-global-theme');
      if (globalThemeSelect) {
        globalThemeSelect.addEventListener('change', (e) => {
          this.applyGlobalTheme(e.target.value);
        });
      }

      const globalGridSelect = document.getElementById('prop-global-grid');
      if (globalGridSelect) {
        globalGridSelect.addEventListener('change', (e) => {
          this.applyGlobalGrid(e.target.value);
        });
      }

      this.updateGraphExpressions(null);
      return;
    }

    const node = this.scene.getNode(this.selectedNodeId);
    if (!node) {
      this.updateGraphExpressions(null);
      return;
    }
    if (badge) badge.textContent = `(${node.name})`;

    let html = `
      <div style="display:flex; flex-direction:column; gap:10px;">
        <label style="display:flex; justify-content:space-between; align-items:center;">
          <span style="font-size:12px;">Tên bảng:</span>
          <input type="text" id="prop-name" value="${node.name}" style="background:#21262d; border:1px solid var(--border-subtle); color:#fff; border-radius:4px; padding:4px 6px; width:130px; font-size:11px;" />
        </label>
        <div style="display:flex; gap:8px;">
          <label style="flex:1; display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:11px; color:var(--text-muted);">Rộng:</span>
            <input type="number" id="prop-w" value="${Math.round(node.width)}" step="20" style="background:#21262d; border:1px solid var(--border-subtle); color:#fff; border-radius:4px; padding:3px 4px; width:56px; font-size:11px;" />
          </label>
          <label style="flex:1; display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:11px; color:var(--text-muted);">Cao:</span>
            <input type="number" id="prop-h" value="${Math.round(node.height)}" step="20" style="background:#21262d; border:1px solid var(--border-subtle); color:#fff; border-radius:4px; padding:3px 4px; width:56px; font-size:11px;" />
          </label>
        </div>

        <!-- Cài Đặt Phong Cách Riêng Cho Bảng Đang Chọn (Dropdown) -->
        <label style="display:flex; justify-content:space-between; align-items:center;">
          <span style="font-size:11px; color:var(--text-muted);">Màu bảng:</span>
          <select id="prop-node-theme" style="background:#21262d; border:1px solid var(--border-subtle); color:#f0f6fc; border-radius:4px; padding:3px 6px; width:130px; font-size:11px; cursor:pointer;">
            ${themes.map((t) => `<option value="${t.id}" ${(node.style || 'chalkboard') === t.id ? 'selected' : ''}>${t.icon} ${t.name}</option>`).join('')}
          </select>
        </label>

        <label style="display:flex; justify-content:space-between; align-items:center;">
          <span style="font-size:11px; color:var(--text-muted);">Lưới nền:</span>
          <select id="prop-node-grid" style="background:#21262d; border:1px solid var(--border-subtle); color:#f0f6fc; border-radius:4px; padding:3px 6px; width:130px; font-size:11px; cursor:pointer;">
            ${grids.map((g) => `<option value="${g.id}" ${(node.gridType || 'grid') === g.id ? 'selected' : ''}>${g.icon} ${g.name}</option>`).join('')}
          </select>
        </label>
    `;

    html += `</div>`;
    propPanel.innerHTML = html;

    // Event listeners
    document.getElementById('prop-name').addEventListener('input', (e) => {
      node.name = e.target.value;
      this.updateHierarchyTree();
    });
    document.getElementById('prop-w').addEventListener('input', (e) => {
      node.width = Math.max(200, parseFloat(e.target.value) || 200);
    });
    document.getElementById('prop-h').addEventListener('input', (e) => {
      node.height = Math.max(150, parseFloat(e.target.value) || 150);
    });

    const themeSelect = document.getElementById('prop-node-theme');
    if (themeSelect) {
      themeSelect.addEventListener('change', (e) => {
        const newTheme = e.target.value;
        node.style = newTheme;
        if ((newTheme === 'whiteboard' || newTheme === 'warmpaper') && this.brushColor === '#ffffff') {
          this.brushColor = '#0f172a';
          this.updateColorPaletteActive();
        } else if ((newTheme === 'chalkboard' || newTheme === 'midnight' || newTheme === 'dark') && this.brushColor === '#0f172a') {
          this.brushColor = '#ffffff';
          this.updateColorPaletteActive();
        }
      });
    }

    const gridSelect = document.getElementById('prop-node-grid');
    if (gridSelect) {
      gridSelect.addEventListener('change', (e) => {
        node.gridType = e.target.value;
      });
    }

    // Luôn hiển thị và cập nhật phần Hàm Số Đồ Thị độc lập
    this.updateGraphExpressions(node);
  }

  /* =========================================================================
   * BẢNG HÀM SỐ ĐỒ THỊ (TÁCH BIỆT KHỎI CANVAS PROPERTIES, HIỆN NGAY KHI CHỌN)
   * ========================================================================= */

  updateGraphExpressions(node) {
    const section = document.getElementById('graph-expressions-section');
    const listContainer = document.getElementById('graph-expr-list');
    if (!section || !listContainer) return;

    if (!node || !node.graphData) {
      section.style.display = 'none';
      return;
    }

    section.style.display = 'flex';
    const gd = node.graphData;

    let html = '';
    gd.expressions.forEach((exp, idx) => {
      html += `
        <div style="display:flex; align-items:center; gap:5px; background:#161b22; padding:4px 6px; border-radius:4px; border:1px solid rgba(255,255,255,0.06);">
          <input type="color" class="expr-color" data-idx="${idx}" value="${exp.color || '#58a6ff'}" style="width:18px; height:18px; border:none; border-radius:50%; cursor:pointer; padding:0; background:transparent;" />
          <span style="font-size:11px; color:var(--text-muted);">y =</span>
          <input type="text" class="expr-input" data-idx="${idx}" value="${exp.expr}" style="flex:1; min-width:0; background:#0d1117; border:1px solid var(--border-subtle); color:#f0f6fc; border-radius:4px; padding:3px 6px; font-size:12px; font-family:monospace;" />
          <button class="expr-ocr-btn" data-idx="${idx}" title="Mở bảng viết tay nhận dạng công thức này" style="background:rgba(88,166,255,0.15); border:1px solid rgba(88,166,255,0.3); color:#58a6ff; border-radius:4px; padding:2px 5px; font-size:11px; cursor:pointer;">✍️</button>
          <button class="expr-del" data-idx="${idx}" style="background:transparent; border:none; color:#f85149; cursor:pointer; font-size:12px; padding:0 3px;">✕</button>
        </div>
      `;
    });
    listContainer.innerHTML = html;

    const addBtn = document.getElementById('btn-add-expr');
    if (addBtn) {
      addBtn.onclick = (e) => {
        e.stopPropagation();
        const colors = ['#3fb950', '#bc8cff', '#f0883e', '#58a6ff', '#f85149'];
        const color = colors[gd.expressions.length % colors.length];
        gd.expressions.push({ id: `exp_${Date.now()}`, expr: 'cos(x)', color, visible: true });
        this.updateGraphExpressions(node);
      };
    }

    const addOcrBtn = document.getElementById('btn-add-ocr-expr');
    if (addOcrBtn) {
      addOcrBtn.onclick = (e) => {
        e.stopPropagation();
        this.openMathOCRModal((recognizedFormula) => {
          const colors = ['#3fb950', '#bc8cff', '#f0883e', '#58a6ff', '#f85149'];
          const color = colors[gd.expressions.length % colors.length];
          gd.expressions.push({ id: `exp_${Date.now()}`, expr: recognizedFormula, color, visible: true });
          this.updateGraphExpressions(node);
        });
      };
    }

    listContainer.querySelectorAll('.expr-ocr-btn').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx, 10);
        if (gd.expressions[idx]) {
          this.openMathOCRModal((recognizedFormula) => {
            gd.expressions[idx].expr = recognizedFormula;
            gd.expressions[idx]._compiledExpr = null;
            this.updateGraphExpressions(node);
          }, gd.expressions[idx].expr);
        }
      };
    });

    listContainer.querySelectorAll('.expr-input').forEach((input) => {
      input.oninput = (e) => {
        const idx = parseInt(input.dataset.idx, 10);
        if (gd.expressions[idx]) {
          gd.expressions[idx].expr = e.target.value;
          gd.expressions[idx]._compiledExpr = null;
        }
      };
    });

    listContainer.querySelectorAll('.expr-color').forEach((input) => {
      input.oninput = (e) => {
        const idx = parseInt(input.dataset.idx, 10);
        if (gd.expressions[idx]) {
          gd.expressions[idx].color = e.target.value;
        }
      };
    });

    listContainer.querySelectorAll('.expr-del').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx, 10);
        gd.expressions.splice(idx, 1);
        this.updateGraphExpressions(node);
        this.broadcastGraphExpr(node);
      };
    });

    const presetsContainer = document.getElementById('graph-presets-container');
    if (presetsContainer) {
      presetsContainer.querySelectorAll('.preset-btn').forEach((btn) => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const colors = ['#58a6ff', '#f85149', '#3fb950', '#bc8cff', '#f0883e'];
          const color = colors[gd.expressions.length % colors.length];
          gd.expressions.push({ id: `exp_${Date.now()}`, expr: btn.dataset.expr, color, visible: true });
          this.updateGraphExpressions(node);
          this.broadcastGraphExpr(node);
        };
      });
    }

    this.broadcastGraphExpr(node);
  }

  broadcastGraphExpr(node) {
    if (this.syncClient && this.syncClient.isConnected && !this.isApplyingRemoteSync && node && node.graphData) {
      this.syncClient.send('GRAPH_EXPR', {
        nodeId: node.id,
        expressions: (node.graphData.expressions || []).map((e) => ({
          id: e.id,
          expr: e.expr,
          color: e.color,
          visible: e.visible !== false,
        })),
      });
    }
  }

  /* =========================================================================
   * MENU GIAO DIỆN & PHONG CÁCH MÀN CHIẾU (TOPBAR THEME POPOVER)
   * ========================================================================= */

  initThemeMenu() {
    const btn = document.getElementById('btn-theme-dropdown');
    const popover = document.getElementById('popover-theme-menu');
    const themeContainer = document.getElementById('theme-swatches');
    const gridContainer = document.getElementById('grid-swatches');
    const label = document.getElementById('label-current-theme');
    if (!btn || !popover || !themeContainer || !gridContainer) return;

    this.globalTheme = this.globalTheme || this.scene.root.style || 'dark';
    this.globalGrid = this.globalGrid || this.scene.root.gridType || 'dots';

    const themes = [
      { id: 'chalkboard', name: 'Bảng Phấn', icon: '🏫', bg: '#142c22', border: '#84bba0', desc: 'Giảng đường' },
      { id: 'whiteboard', name: 'Bảng Trắng', icon: '🏢', bg: '#f8fafc', border: '#64748b', desc: 'Máy chiếu sáng' },
      { id: 'blueprint', name: 'Kỹ Thuật', icon: '📐', bg: '#0a192f', border: '#64ffda', desc: 'Xanh Blueprint' },
      { id: 'midnight', name: 'Đen OLED', icon: '🌌', bg: '#06080c', border: '#58a6ff', desc: 'Tương phản cao' },
      { id: 'warmpaper', name: 'Giấy Vàng', icon: '📜', bg: '#fcf8ec', border: '#c49a6c', desc: 'Chống mỏi mắt' },
      { id: 'dark', name: 'Hiện Đại', icon: '💻', bg: '#161f2e', border: '#58a6ff', desc: 'Xanh đen chuẩn' },
    ];

    const grids = [
      { id: 'grid', name: 'Ô Caro', icon: '▦' },
      { id: 'dots', name: 'Chấm Bi', icon: '⁝⁝' },
      { id: 'lines', name: 'Kẻ Ngang', icon: '☰' },
      { id: 'none', name: 'Trơn', icon: '◻' },
    ];

    const renderMenu = () => {
      const currentThemeId = this.globalTheme || 'dark';
      const currentGridId = this.globalGrid || 'dots';
      const currentThemeObj = themes.find((t) => t.id === currentThemeId) || themes[0];
      if (label) label.textContent = currentThemeObj.name;

      themeContainer.innerHTML = themes
        .map((t) => {
          const isActive = t.id === currentThemeId;
          const textCol = t.id === 'whiteboard' || t.id === 'warmpaper' ? '#0f172a' : '#f0f6fc';
          const activeBorder = isActive ? '2px solid #58a6ff' : '1px solid rgba(255,255,255,0.14)';
          return `
            <button class="pop-theme-btn" data-theme="${t.id}" style="display:flex; align-items:center; gap:6px; background:${t.bg}; border:${activeBorder}; border-radius:6px; padding:6px 8px; cursor:pointer; text-align:left; box-shadow:${isActive ? '0 0 10px rgba(88,166,255,0.5)' : 'none'};">
              <span style="font-size:14px;">${t.icon}</span>
              <div style="display:flex; flex-direction:column; overflow:hidden;">
                <span style="font-size:11px; font-weight:${isActive ? '700' : '600'}; color:${textCol}; white-space:nowrap;">${t.name}</span>
                <span style="font-size:8.5px; color:${t.id === 'whiteboard' || t.id === 'warmpaper' ? '#475569' : '#8b949e'};">${t.desc}</span>
              </div>
            </button>
          `;
        })
        .join('');

      gridContainer.innerHTML = grids
        .map((g) => {
          const isActive = g.id === currentGridId;
          return `
            <button class="pop-grid-btn" data-grid="${g.id}" style="background:${isActive ? 'rgba(88,166,255,0.25)' : '#21262d'}; border:${isActive ? '1px solid #58a6ff' : '1px solid var(--border-subtle)'}; color:${isActive ? '#58a6ff' : '#c9d1d9'}; border-radius:4px; padding:5px 2px; font-size:10px; cursor:pointer; display:flex; flex-direction:column; align-items:center; gap:2px; font-weight:${isActive ? '600' : 'normal'};">
              <span style="font-size:13px;">${g.icon}</span>
              <span>${g.name}</span>
            </button>
          `;
        })
        .join('');

      themeContainer.querySelectorAll('.pop-theme-btn').forEach((b) => {
        b.addEventListener('click', () => {
          this.applyGlobalTheme(b.getAttribute('data-theme'));
          renderMenu();
        });
      });

      gridContainer.querySelectorAll('.pop-grid-btn').forEach((b) => {
        b.addEventListener('click', () => {
          this.applyGlobalGrid(b.getAttribute('data-grid'));
          renderMenu();
        });
      });
    };

    this.renderThemeMenu = renderMenu;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleThemeMenu();
    });

    popover.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    window.addEventListener('click', (e) => {
      if (!popover.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
        popover.style.display = 'none';
      }
    });

    renderMenu();
  }

  toggleThemeMenu(forceState = null) {
    const popover = document.getElementById('popover-theme-menu');
    if (!popover) return;
    const willOpen = forceState !== null ? forceState : popover.style.display !== 'block';
    popover.style.display = willOpen ? 'block' : 'none';
    if (willOpen && this.renderThemeMenu) {
      this.renderThemeMenu();
    }
  }

  applyGlobalTheme(themeId) {
    this.globalTheme = themeId;
    // 1. Áp dụng cho Canvas Mẹ
    this.scene.root.style = themeId;

    // 2. Tự động áp dụng cho tất cả các bảng con hiện có (Global Sync)
    const updateNodeRecursive = (node) => {
      node.style = themeId;
      for (const child of node.children) updateNodeRecursive(child);
    };
    for (const child of this.scene.root.children) {
      updateNodeRecursive(child);
    }

    // 3. Tự động chuyển đổi màu bút tương thích tương phản cao
    if ((themeId === 'whiteboard' || themeId === 'warmpaper') && this.brushColor === '#ffffff') {
      this.brushColor = '#0f172a';
      this.updateColorPaletteActive();
    } else if ((themeId === 'chalkboard' || themeId === 'midnight' || themeId === 'dark') && this.brushColor === '#0f172a') {
      this.brushColor = '#ffffff';
      this.updateColorPaletteActive();
    }

    if (this.renderThemeMenu) this.renderThemeMenu();
    this.updateNodeProperties();

    if (this.syncClient && this.syncClient.isConnected && !this.isApplyingRemoteSync) {
      this.syncClient.send('NODE_STYLE', {
        style: themeId,
        isGlobal: true,
      });
    }
  }

  applyGlobalGrid(gridId) {
    this.globalGrid = gridId;
    this.scene.root.gridType = gridId;
    const updateNodeRecursive = (node) => {
      node.gridType = gridId;
      for (const child of node.children) updateNodeRecursive(child);
    };
    for (const child of this.scene.root.children) {
      updateNodeRecursive(child);
    }
    if (this.renderThemeMenu) this.renderThemeMenu();
    this.updateNodeProperties();

    if (this.syncClient && this.syncClient.isConnected && !this.isApplyingRemoteSync) {
      this.syncClient.send('NODE_STYLE', {
        gridType: gridId,
        isGlobal: true,
      });
    }
  }

  /* =========================================================================
   * BẢNG VIẾT TAY NHẬN DẠNG TOÁN HỌC (MATH HANDWRITING OCR MODAL)
   * ========================================================================= */

  initMathOCRModal() {
    this.ocrModalEl = document.getElementById('math-ocr-modal');
    this.ocrCanvas = document.getElementById('math-ocr-canvas');
    if (!this.ocrCanvas) return;

    this.ocrCtx = this.ocrCanvas.getContext('2d');
    this.ocrIsDrawing = false;

    // Thiết lập độ phân giải cao cho OCR Canvas
    const dpr = window.devicePixelRatio || 1;
    const w = 600;
    const h = 240;
    this.ocrCanvas.width = w * dpr;
    this.ocrCanvas.height = h * dpr;
    this.ocrCtx.scale(dpr, dpr);

    // Event listeners cho OCR Canvas
    const getPos = (e) => {
      const rect = this.ocrCanvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) * (w / rect.width),
        y: (e.clientY - rect.top) * (h / rect.height),
      };
    };

    const startDraw = (pos) => {
      this.ocrIsDrawing = true;
      if (this.ocrTool === 'pen') {
        this.ocrCurrentStroke = [pos];
        this.ocrStrokes.push(this.ocrCurrentStroke);
        this.redrawOCRCanvas();
      } else if (this.ocrTool === 'eraser') {
        this.eraseOCRStrokeAt(pos);
      }
    };

    const moveDraw = (pos) => {
      if (!this.ocrIsDrawing) return;
      if (this.ocrTool === 'pen' && this.ocrCurrentStroke) {
        this.ocrCurrentStroke.push(pos);
        this.redrawOCRCanvas();
      } else if (this.ocrTool === 'eraser') {
        this.eraseOCRStrokeAt(pos);
      }
    };

    const endDraw = () => {
      if (this.ocrIsDrawing) {
        this.ocrIsDrawing = false;
        this.ocrCurrentStroke = null;
      }
    };

    this.ocrCanvas.addEventListener('mousedown', (e) => startDraw(getPos(e)));
    window.addEventListener('mousemove', (e) => moveDraw(getPos(e)));
    window.addEventListener('mouseup', endDraw);

    // Touch events for iPad / Pen stylus
    this.ocrCanvas.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (e.touches.length > 0) startDraw(getPos(e.touches[0]));
    });
    this.ocrCanvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (e.touches.length > 0) moveDraw(getPos(e.touches[0]));
    });
    this.ocrCanvas.addEventListener('touchend', (e) => {
      e.preventDefault();
      endDraw();
    });

    // Toolbar buttons
    document.getElementById('btn-ocr-close').addEventListener('click', () => this.closeMathOCRModal());
    document.getElementById('btn-ocr-clear').addEventListener('click', () => {
      this.ocrStrokes = [];
      this.redrawOCRCanvas();
      document.getElementById('ocr-result-input').value = '';
    });
    document.getElementById('btn-ocr-undo').addEventListener('click', () => {
      if (this.ocrStrokes.length > 0) {
        this.ocrStrokes.pop();
        this.redrawOCRCanvas();
      }
    });

    // Nút kích hoạt nhận diện thủ công
    const recognizeBtn = document.getElementById('btn-ocr-recognize');
    if (recognizeBtn) {
      recognizeBtn.addEventListener('click', () => {
        this.performOCRRecognition();
      });
    }

    const penBtn = document.getElementById('btn-ocr-pen');
    const eraserBtn = document.getElementById('btn-ocr-eraser');

    penBtn.addEventListener('click', () => {
      this.ocrTool = 'pen';
      penBtn.classList.add('active');
      eraserBtn.classList.remove('active');
    });

    eraserBtn.addEventListener('click', () => {
      this.ocrTool = 'eraser';
      eraserBtn.classList.add('active');
      penBtn.classList.remove('active');
    });

    // Preset buttons trong OCR modal
    const setPreset = (expr) => {
      document.getElementById('ocr-result-input').value = expr;
      this.updateKaTeXPreview(expr);
      if (this.ocrCallback) {
        this.ocrCallback(expr);
      }
    };
    document.getElementById('btn-ocr-preset-sin').addEventListener('click', () => setPreset('sin(x)'));
    document.getElementById('btn-ocr-preset-parabol').addEventListener('click', () => setPreset('x^2 - 4'));
    document.getElementById('btn-ocr-preset-frac').addEventListener('click', () => setPreset('1/x'));
    document.getElementById('btn-ocr-preset-sqrt').addEventListener('click', () => setPreset('sqrt(x)'));

    // Copy mã LaTeX
    const copyLatexBtn = document.getElementById('btn-copy-latex');
    if (copyLatexBtn) {
      copyLatexBtn.addEventListener('click', () => {
        const val = document.getElementById('ocr-result-input').value.trim();
        const latex = val.includes('\\') ? val : LatexEngine.desmosToLatex(val);
        navigator.clipboard?.writeText(latex);
        copyLatexBtn.textContent = '✓ Đã copy!';
        setTimeout(() => {
          copyLatexBtn.textContent = '📋 Copy LaTeX';
        }, 1500);
      });
    }

    // Nút "Thử Ngay" (Live Test Expression on Graph)
    const testLiveBtn = document.getElementById('btn-ocr-test-live');
    if (testLiveBtn) {
      testLiveBtn.addEventListener('click', () => {
        const raw = document.getElementById('ocr-result-input').value.trim();
        const val = raw.includes('\\') ? LatexEngine.latexToDesmos(raw) : raw;
        this.updateKaTeXPreview(raw);
        if (val && this.ocrCallback) {
          this.ocrCallback(val);
        }
      });
    }

    // Chỉnh sửa trực tiếp ô kết quả nhận dạng cũng cập nhật KaTeX preview
    document.getElementById('ocr-result-input').addEventListener('input', (e) => {
      const raw = e.target.value.trim();
      this.updateKaTeXPreview(raw);
    });

    // Nút Apply (Chèn toàn bộ vào Ô Nhập & Đóng)
    document.getElementById('btn-ocr-apply').addEventListener('click', () => {
      const raw = document.getElementById('ocr-result-input').value.trim();
      const val = raw.includes('\\') ? LatexEngine.latexToDesmos(raw) : raw;
      if (val && this.ocrCallback) {
        this.ocrCallback(val);
      }
      this.closeMathOCRModal();
    });
  }

  updateKaTeXPreview(exprOrLatex) {
    if (!exprOrLatex) return;
    const latex = exprOrLatex.includes('\\')
      ? exprOrLatex
      : LatexEngine.desmosToLatex(exprOrLatex);
    LatexEngine.renderLatexToElement('ocr-katex-preview', `y = ${latex}`);
  }

  eraseOCRStrokeAt(pos) {
    const radius = 16;
    const initialLen = this.ocrStrokes.length;
    this.ocrStrokes = this.ocrStrokes.filter((stroke) => {
      return !stroke.some((p) => Math.hypot(p.x - pos.x, p.y - pos.y) <= radius);
    });
    if (this.ocrStrokes.length !== initialLen) {
      this.redrawOCRCanvas();
    }
  }

  redrawOCRCanvas() {
    if (!this.ocrCtx) return;
    const ctx = this.ocrCtx;
    ctx.clearRect(0, 0, 600, 240);

    // Vẽ nền lưới ô ly nhỏ mờ
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < 600; x += 20) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 240);
    }
    for (let y = 0; y < 240; y += 20) {
      ctx.moveTo(0, y);
      ctx.lineTo(600, y);
    }
    ctx.stroke();

    // Vẽ các nét bút viết tay
    ctx.strokeStyle = '#58a6ff';
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const stroke of this.ocrStrokes) {
      if (stroke.length < 1) continue;
      ctx.beginPath();
      ctx.moveTo(stroke[0].x, stroke[0].y);
      for (let i = 1; i < stroke.length; i++) {
        ctx.lineTo(stroke[i].x, stroke[i].y);
      }
      ctx.stroke();
    }
  }

  async performOCRRecognition() {
    if (this.ocrStrokes.length === 0) return;
    const recognizeBtn = document.getElementById('btn-ocr-recognize');
    const originalText = recognizeBtn ? recognizeBtn.innerHTML : '';
    if (recognizeBtn) {
      recognizeBtn.disabled = true;
      recognizeBtn.innerHTML = '⏳ Đang nhận diện...';
      recognizeBtn.style.opacity = '0.7';
    }

    try {
      const res = await MathOCREngine.recognizeStrokes(this.ocrStrokes, this.ocrCanvas);
      if (res && res.expression) {
        document.getElementById('ocr-result-input').value = res.expression;
        this.updateKaTeXPreview(res.latex || res.expression);

        // Cập nhật nhãn trạng thái Engine
        const badge = document.getElementById('unimernet-status-badge');
        if (badge) {
          if (res.isLocalAi || res.engine !== 'in-browser-neural') {
            badge.textContent = `🟢 ${res.engine || 'AI GPU'} (Active)`;
            badge.style.color = '#3fb950';
            badge.style.borderColor = 'rgba(63,185,80,0.4)';
            badge.style.background = 'rgba(63,185,80,0.15)';
          } else {
            badge.textContent = '⚡ In-Browser Neural Engine';
            badge.style.color = '#58a6ff';
            badge.style.borderColor = 'rgba(88,166,255,0.4)';
            badge.style.background = 'rgba(88,166,255,0.15)';
          }
        }
      }
    } catch (e) {
      console.warn('Math OCR Recognition error:', e);
    } finally {
      if (recognizeBtn) {
        recognizeBtn.disabled = false;
        recognizeBtn.innerHTML = originalText || '✨ Nhận Diện Công Thức';
        recognizeBtn.style.opacity = '1';
      }
    }
  }

  async openMathOCRModal(callback, initialExpr = '') {
    this.ocrCallback = callback;
    this.ocrStrokes = [];
    this.ocrTool = 'pen';
    document.getElementById('btn-ocr-pen').classList.add('active');
    document.getElementById('btn-ocr-eraser').classList.remove('active');
    const initial = initialExpr || 'sin(x)';
    document.getElementById('ocr-result-input').value = initial;
    this.updateKaTeXPreview(initial);
    this.redrawOCRCanvas();
    this.ocrModalEl.style.display = 'flex';

    // Kiểm tra kết nối Qwen3.5-LaTeX Local Server
    const badge = document.getElementById('unimernet-status-badge');
    if (badge) {
      const health = await MathOCREngine.checkServerHealth();
      if (health.online) {
        badge.textContent = '🟢 Qwen3.5-LaTeX (GPU Active)';
        badge.style.color = '#3fb950';
        badge.style.borderColor = 'rgba(63,185,80,0.4)';
        badge.style.background = 'rgba(63,185,80,0.15)';
      } else {
        badge.textContent = '⚡ In-Browser Neural Engine';
        badge.style.color = '#58a6ff';
        badge.style.borderColor = 'rgba(88,166,255,0.4)';
        badge.style.background = 'rgba(88,166,255,0.15)';
      }
    }
  }

  closeMathOCRModal() {
    if (this.ocrModalEl) {
      this.ocrModalEl.style.display = 'none';
    }
    this.ocrCallback = null;
  }

  initFloatingOcrPill() {
    this.ocrPillEl = document.getElementById('ocr-floating-pill');
    this.ocrPillTextEl = document.getElementById('ocr-pill-text-content');
    this.ocrPillModelEl = document.getElementById('ocr-pill-model-name');

    const closeBtn = document.getElementById('btn-ocr-pill-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.hideOcrPill());
    }

    const copyBtn = document.getElementById('btn-ocr-pill-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => this.copyOcrText());
    }

    const convertBtn = document.getElementById('btn-ocr-pill-convert');
    if (convertBtn) {
      convertBtn.addEventListener('click', () => this.convertOcrToTextNode());
    }
  }

  hideOcrPill() {
    if (this.ocrPillEl) {
      this.ocrPillEl.style.display = 'none';
    }
    this.ocrHighlightBoxes = [];
    this.activeOcrTarget = null;
  }

  showToast(message, duration = 3000) {
    let toast = document.getElementById('app-toast-notification');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'app-toast-notification';
      toast.className = 'toast-notification';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(this._toastTimeout);
    this._toastTimeout = setTimeout(() => {
      toast.classList.remove('show');
    }, duration);
  }

  async executeMarqueeOCR(selectionBox) {
    if (this.isOcrProcessing) return;

    const x1 = Math.min(selectionBox.startX, selectionBox.currentX);
    const y1 = Math.min(selectionBox.startY, selectionBox.currentY);
    const x2 = Math.max(selectionBox.startX, selectionBox.currentX);
    const y2 = Math.max(selectionBox.startY, selectionBox.currentY);
    const width = Math.max(32, x2 - x1);
    const height = Math.max(32, y2 - y1);
    const screenRect = { x: x1, y: y1, width, height };

    // Find which node is under this box
    const centerScreen = new Vec2(x1 + width * 0.5, y1 + height * 0.5);
    const hit = this.hitTestBoard(centerScreen);
    const targetNode = hit && hit.action === 'body' ? hit.node : this.scene.root;

    // Convert screen selection box to targetNode local coordinates
    const p0Local = this.scene.screenToLocal(new Vec2(x1, y1), targetNode.id, this.camera);
    const p1Local = this.scene.screenToLocal(new Vec2(x2, y2), targetNode.id, this.camera);
    const localMinX = Math.min(p0Local.x, p1Local.x);
    const localMinY = Math.min(p0Local.y, p1Local.y);
    const localMaxX = Math.max(p0Local.x, p1Local.x);
    const localMaxY = Math.max(p0Local.y, p1Local.y);
    const localSelectionRect = {
      x: localMinX,
      y: localMinY,
      width: Math.max(20, localMaxX - localMinX),
      height: Math.max(20, localMaxY - localMinY),
    };

    // Find strokes intersecting or inside localSelectionRect
    const strokesInside = [];
    if (targetNode.elements && targetNode.elements.length > 0) {
      for (const stroke of targetNode.elements) {
        if (
          stroke.bounds.maxX >= localMinX &&
          stroke.bounds.minX <= localMaxX &&
          stroke.bounds.maxY >= localMinY &&
          stroke.bounds.minY <= localMaxY
        ) {
          strokesInside.push(stroke);
        }
      }
    }

    // Capture the exact visible pixels of the selection region from canvas
    const dpr = window.devicePixelRatio || 1;
    const offscreen = document.createElement('canvas');
    offscreen.width = Math.max(32, Math.round(width * dpr));
    offscreen.height = Math.max(32, Math.round(height * dpr));
    const ctx = offscreen.getContext('2d');

    // Fill white as base
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, offscreen.width, offscreen.height);

    try {
      ctx.drawImage(
        this.canvas,
        x1 * dpr,
        y1 * dpr,
        width * dpr,
        height * dpr,
        0,
        0,
        offscreen.width,
        offscreen.height
      );
    } catch (e) {
      console.warn('Canvas crop fallback error:', e);
    }

    const dataUrl = offscreen.toDataURL('image/png');

    this.isOcrProcessing = true;
    this.ocrHighlightBoxes = [
      {
        targetNodeId: targetNode.id,
        localRect: localSelectionRect,
        isLoading: true,
      },
    ];
    this.showToast('🔍 Đang nhận diện văn bản qua AI OCR...', 6000);

    try {
      const result = await TextOCREngine.recognizeImageDataUrl(dataUrl);

      if (result.success && result.blocks && result.blocks.length > 0) {
        // Map detected blocks to targetNode local coordinates
        this.ocrHighlightBoxes = result.blocks.map((block) => ({
          ...block,
          targetNodeId: targetNode.id,
          localRect: localSelectionRect,
          isLoading: false,
        }));

        this.activeOcrTarget = {
          targetNode,
          localSelectionRect,
          strokesInside,
          fullText: result.full_text || result.fullText,
          blocks: result.blocks,
        };

        // Position Floating OCR Action Pill near the selection in real-time
        if (this.ocrPillEl && this.ocrPillTextEl) {
          this.ocrPillTextEl.textContent = result.full_text || result.fullText;
          if (this.ocrPillModelEl && result.model) {
            this.ocrPillModelEl.textContent = result.model;
          }
          this.ocrPillEl.style.display = 'flex';
          this.updateOcrPillPosition();
        }

        this.showToast(`✨ Đã nhận diện: "${result.full_text || result.fullText}"`, 3000);
      } else if (!result.success) {
        this.ocrHighlightBoxes = [];
        this.activeOcrTarget = null;
        this.hideOcrPill();
        this.showToast(`❌ Lỗi OCR Server: ${result.error || 'Vui lòng kiểm tra server'}`, 4000);
      } else {
        this.ocrHighlightBoxes = [];
        this.activeOcrTarget = null;
        this.hideOcrPill();
        this.showToast('ℹ️ Không tìm thấy văn bản rõ ràng trong vùng chọn', 3000);
      }
    } catch (err) {
      console.error('Marquee OCR error:', err);
      this.ocrHighlightBoxes = [];
      this.activeOcrTarget = null;
      this.hideOcrPill();
      this.showToast(`❌ Lỗi xử lý OCR: ${err.message}`, 4000);
    } finally {
      this.isOcrProcessing = false;
    }
  }

  updateOcrPillPosition() {
    if (!this.ocrPillEl || this.ocrPillEl.style.display === 'none' || !this.activeOcrTarget) {
      return;
    }
    const { targetNode, localSelectionRect } = this.activeOcrTarget;
    if (!targetNode || !localSelectionRect) return;

    const p1 = this.scene.localToScreen(
      new Vec2(localSelectionRect.x, localSelectionRect.y),
      targetNode.id,
      this.camera
    );
    const p2 = this.scene.localToScreen(
      new Vec2(localSelectionRect.x + localSelectionRect.width, localSelectionRect.y + localSelectionRect.height),
      targetNode.id,
      this.camera
    );

    const screenX = Math.min(p1.x, p2.x);
    const screenY = Math.min(p1.y, p2.y);
    const screenH = Math.abs(p2.y - p1.y);

    const pillWidth = 320;
    let pillLeft = Math.max(16, Math.min(window.innerWidth - pillWidth - 24, screenX));
    let pillTop = screenY - 140;
    if (pillTop < 70) {
      pillTop = screenY + screenH + 16;
    }

    this.ocrPillEl.style.left = `${pillLeft}px`;
    this.ocrPillEl.style.top = `${pillTop}px`;
  }

  copyOcrText() {
    if (!this.ocrPillTextEl) return;
    const text = this.ocrPillTextEl.textContent.trim();
    if (text) {
      navigator.clipboard.writeText(text).then(() => {
        this.showToast('📋 Đã sao chép văn bản vào Clipboard!', 2500);
      }).catch(() => {
        this.showToast('📋 Đã chọn văn bản', 2000);
      });
    }
  }

  convertOcrToTextNode() {
    if (!this.activeOcrTarget || !this.ocrPillTextEl) return;

    const text = this.ocrPillTextEl.textContent.trim();
    if (!text) {
      this.showToast('⚠️ Văn bản trống!', 2000);
      return;
    }

    const { targetNode, localSelectionRect, strokesInside } = this.activeOcrTarget;
    const parentNode = targetNode || this.scene.root;

    // 1. If there were handwritten strokes inside this box, erase them
    if (strokesInside && strokesInside.length > 0) {
      const initialStrokes = [...parentNode.elements];
      const strokeIdsToDelete = new Set(strokesInside.map((s) => s.id));
      parentNode.elements = parentNode.elements.filter((s) => !strokeIdsToDelete.has(s.id));
      const finalStrokes = [...parentNode.elements];

      this.executeCommand(
        new EraseCommand(parentNode.id, initialStrokes, finalStrokes),
        parentNode.id
      );
    }

    // 2. Create a clean converted Text CanvasNode
    const boardW = Math.max(260, Math.min(700, Math.round(localSelectionRect.width + 40)));
    const boardH = Math.max(140, Math.min(600, Math.round(localSelectionRect.height + 60)));

    const textNode = new CanvasNode(
      '📝 Bảng Văn Bản (OCR)',
      boardW,
      boardH,
      Transform2D.fromTranslation(localSelectionRect.x, localSelectionRect.y)
    );
    textNode.textContent = text;
    textNode.style = 'DottedGrid';

    const cmd = new CreateNodeCommand(parentNode.id, textNode);
    this.executeCommand(cmd, parentNode.id);

    this.selectedNodeId = textNode.id;
    this.hideOcrPill();
    this.updateHierarchyTree();
    this.updateNodeProperties();
    this.showToast('✨ Đã chuyển đổi thành công sang Bảng Văn Bản!', 3000);
  }

  /* =========================================================================
   * ĐỒNG BỘ MẠNG LAN REAL-TIME & KẾT NỐI IPAD / TABLET
   * ========================================================================= */

  initLANSync() {
    const btnSync = document.getElementById('btn-lan-sync');
    const modalSync = document.getElementById('modal-lan-sync');
    const btnClose = document.getElementById('btn-close-lan-modal');
    const dotStatus = document.getElementById('dot-lan-status');
    const labelPresence = document.getElementById('label-lan-presence');
    const inputUrl = document.getElementById('input-lan-url');
    const btnCopy = document.getElementById('btn-copy-lan-url');
    const modalStatus = document.getElementById('lan-modal-status-text');

    this.syncClient = new SyncClient({
      onPresence: (count, localIp) => {
        if (labelPresence) labelPresence.textContent = `${count} Thiết Bị`;
        if (modalStatus) modalStatus.textContent = `🟢 Đang hoạt động (${count} thiết bị)`;
        const port = window.location.port || '3000';
        const url = `http://${localIp}:${port}`;
        if (inputUrl) inputUrl.value = url;
        this.renderQRCode(url);
      },
      onStatus: (connected) => {
        if (dotStatus) {
          dotStatus.style.background = connected ? '#3fb950' : '#f85149';
          dotStatus.style.boxShadow = connected ? '0 0 6px #3fb950' : '0 0 6px #f85149';
        }
        if (modalStatus) {
          modalStatus.textContent = connected
            ? `🟢 Đang kết nối (${this.syncClient.presenceCount} thiết bị)`
            : '🔴 Đang thử kết nối lại...';
          modalStatus.style.color = connected ? '#3fb950' : '#f85149';
        }
      },
    });

    this.syncClient.connect();

    // Nhận các sự kiện từ Sync Server
    this.syncClient.on('WELCOME', (data) => {
      if (data.has_scene && data.scene) {
        this.loadSceneFromJSON(data.scene);
      } else {
        this.broadcastSceneState();
      }
    });

    this.syncClient.on('PLEASE_UPLOAD_SCENE', () => {
      this.broadcastSceneState();
    });

    this.syncClient.on('SCENE_STATE', (data) => {
      if (data.scene) {
        this.loadSceneFromJSON(data.scene);
      }
    });

    this.syncClient.on('STROKE_LIVE', (data) => {
      if (data.clientId === this.clientId) return;
      this.remoteActiveSessions.set(data.clientId, data.session);
    });

    this.syncClient.on('STROKE_ADD', (data) => {
      if (data.clientId === this.clientId) return;
      this.remoteActiveSessions.delete(data.clientId);
      if (data.stroke && data.nodeId) {
        const targetNode = this.scene.getNode(data.nodeId);
        if (targetNode) {
          const stroke = Stroke.fromJSON(data.stroke);
          targetNode.addStroke(stroke);
          this.updateUI();
        }
      }
    });

    this.syncClient.on('STROKE_ERASE', (data) => {
      if (data.nodeId && data.removedStrokeIds) {
        const targetNode = this.scene.getNode(data.nodeId);
        if (targetNode) {
          const idSet = new Set(data.removedStrokeIds);
          targetNode.elements = targetNode.elements.filter((s) => !idSet.has(s.id));
          this.updateUI();
        }
      }
    });

    this.syncClient.on('NODE_TRANSFORM', (data) => {
      const node = this.scene.getNode(data.nodeId);
      if (node) {
        node.transform.tx = data.x;
        node.transform.ty = data.y;
        node.width = data.w;
        node.height = data.h;
        this.updateNodeProperties();
      }
    });

    this.syncClient.on('NODE_CREATE', (data) => {
      if (data.node) {
        this.isApplyingRemoteSync = true;
        const newNode = CanvasNode.fromJSON(data.node);
        this.scene.root.addChild(newNode);
        this.updateHierarchyTree();
        this.updateUI();
        this.isApplyingRemoteSync = false;
      }
    });

    this.syncClient.on('NODE_DELETE', (data) => {
      this.isApplyingRemoteSync = true;
      this.scene.root.removeChild(data.nodeId);
      if (this.selectedNodeId === data.nodeId) {
        this.selectedNodeId = null;
      }
      this.updateHierarchyTree();
      this.updateNodeProperties();
      this.updateUI();
      this.isApplyingRemoteSync = false;
    });

    this.syncClient.on('NODE_STYLE', (data) => {
      this.isApplyingRemoteSync = true;
      if (data.isGlobal) {
        if (data.style) this.applyGlobalTheme(data.style);
        if (data.gridType) this.applyGlobalGrid(data.gridType);
      } else {
        const node = this.scene.getNode(data.nodeId);
        if (node) {
          if (data.style) node.style = data.style;
          if (data.gridType) node.gridType = data.gridType;
          this.updateNodeProperties();
        }
      }
      this.isApplyingRemoteSync = false;
    });

    this.syncClient.on('GRAPH_EXPR', (data) => {
      const node = this.scene.getNode(data.nodeId);
      if (node && node.graphData && data.expressions) {
        node.graphData.expressions = data.expressions;
        this.updateGraphExpressions(node);
      }
    });

    // UI Buttons
    if (btnSync && modalSync) {
      btnSync.addEventListener('click', (e) => {
        e.stopPropagation();
        modalSync.style.display = 'flex';
        const port = window.location.port || '3000';
        const host = this.syncClient?.localIp || window.location.hostname || 'localhost';
        const url = `http://${host}:${port}`;
        if (inputUrl) inputUrl.value = url;
        this.renderQRCode(url);
      });
    }

    if (btnClose && modalSync) {
      btnClose.addEventListener('click', (e) => {
        e.stopPropagation();
        modalSync.style.display = 'none';
      });
    }

    if (modalSync) {
      modalSync.addEventListener('click', (e) => {
        if (e.target === modalSync) modalSync.style.display = 'none';
      });
    }

    if (btnCopy && inputUrl) {
      btnCopy.addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(inputUrl.value).then(() => {
          btnCopy.textContent = '✓ Đã Chép!';
          setTimeout(() => {
            btnCopy.textContent = 'Sao Chép';
          }, 2000);
        });
      });
    }
  }

  broadcastSceneState() {
    if (!this.syncClient || !this.syncClient.isConnected || this.isApplyingRemoteSync) return;
    this.syncClient.send('SCENE_STATE', {
      scene: this.scene.toJSON(),
    });
  }

  loadSceneFromJSON(sceneData) {
    if (!sceneData) return;
    this.isApplyingRemoteSync = true;
    this.scene.loadFromJSON(sceneData);
    this.updateHierarchyTree();
    this.updateNodeProperties();
    this.updateUI();
    this.isApplyingRemoteSync = false;
  }

  renderQRCode(url) {
    const qrContainer = document.getElementById('lan-qrcode');
    if (!qrContainer) return;
    qrContainer.innerHTML = '';
    if (typeof QRCode !== 'undefined') {
      try {
        new QRCode(qrContainer, {
          text: url,
          width: 170,
          height: 170,
          colorDark: '#0f172a',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.M,
        });
        return;
      } catch (e) {
        console.warn('QRCode error:', e);
      }
    }
    qrContainer.innerHTML = `<span style="font-size:12px; color:#334155; text-align:center; word-break:break-all;">${url}</span>`;
  }

  startRenderLoop() {
    const loop = () => {
      const stats = this.renderer.render(
        this.scene,
        this.camera,
        this.selectedNodeId,
        this.activeSession,
        this.eraserCursor,
        this.ocrSelectionBox,
        this.ocrHighlightBoxes,
        this.remoteActiveSessions
      );

      this.updateOcrPillPosition();

      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}

// Start Application
window.addEventListener('DOMContentLoaded', () => {
  window.app = new NestedCanvasApp();
});

