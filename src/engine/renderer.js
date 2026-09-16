import { AABB, Vec2 } from './math.js';
import { MathEvaluator } from './math_evaluator.js';
import { CanvasNode } from './scene.js';

export const BOARD_THEMES = {
  chalkboard: {
    id: 'chalkboard',
    name: 'Bảng Phấn Xanh',
    badge: '🏫 Giảng Đường',
    bg: '#142c22',
    headerBg: '#0e2018',
    headerActiveBg: '#1a3c2e',
    text: '#f2fcf6',
    textMuted: '#84bba0',
    border: 'rgba(132, 187, 160, 0.25)',
    grid: 'rgba(255, 255, 255, 0.12)',
    graphBg: '#0e241b',
    graphAxis: 'rgba(255, 255, 255, 0.85)',
    graphText: '#f2fcf6',
    graphGrid: 'rgba(255, 255, 255, 0.08)',
    defaultPen: '#ffffff',
  },
  whiteboard: {
    id: 'whiteboard',
    name: 'Bảng Trắng Văn Phòng',
    badge: '🏢 Máy Chiếu',
    bg: '#f8fafc',
    headerBg: '#e2e8f0',
    headerActiveBg: '#cbd5e1',
    text: '#0f172a',
    textMuted: '#64748b',
    border: 'rgba(0, 0, 0, 0.15)',
    grid: 'rgba(15, 23, 42, 0.10)',
    graphBg: '#ffffff',
    graphAxis: 'rgba(15, 23, 42, 0.85)',
    graphText: '#0f172a',
    graphGrid: 'rgba(15, 23, 42, 0.08)',
    defaultPen: '#0f172a',
  },
  blueprint: {
    id: 'blueprint',
    name: 'Xanh Kỹ Thuật',
    badge: '📐 Toán Học',
    bg: '#0a192f',
    headerBg: '#06101e',
    headerActiveBg: '#112240',
    text: '#e6f1ff',
    textMuted: '#8892b0',
    border: 'rgba(100, 255, 218, 0.2)',
    grid: 'rgba(88, 166, 255, 0.16)',
    graphBg: '#060f1e',
    graphAxis: 'rgba(100, 255, 218, 0.85)',
    graphText: '#e6f1ff',
    graphGrid: 'rgba(88, 166, 255, 0.1)',
    defaultPen: '#64ffda',
  },
  midnight: {
    id: 'midnight',
    name: 'Đen OLED Sâu',
    badge: '🌌 Màn LED Lớn',
    bg: '#06080c',
    headerBg: '#0d1117',
    headerActiveBg: '#161b22',
    text: '#ffffff',
    textMuted: '#8b949e',
    border: 'rgba(255, 255, 255, 0.15)',
    grid: 'rgba(255, 255, 255, 0.2)',
    graphBg: '#000000',
    graphAxis: 'rgba(255, 255, 255, 0.9)',
    graphText: '#ffffff',
    graphGrid: 'rgba(255, 255, 255, 0.08)',
    defaultPen: '#ffffff',
  },
  warmpaper: {
    id: 'warmpaper',
    name: 'Giấy Ô Ly Ấm',
    badge: '📜 Chống Mỏi Mắt',
    bg: '#fcf8ec',
    headerBg: '#ede4cf',
    headerActiveBg: '#dfd4bc',
    text: '#2b2318',
    textMuted: '#786851',
    border: 'rgba(100, 75, 40, 0.15)',
    grid: 'rgba(66, 133, 244, 0.15)',
    graphBg: '#fbf5e4',
    graphAxis: 'rgba(43, 35, 24, 0.85)',
    graphText: '#2b2318',
    graphGrid: 'rgba(66, 133, 244, 0.1)',
    defaultPen: '#1a1f36',
  },
  dark: {
    id: 'dark',
    name: 'Xanh Đen Hiện Đại',
    badge: '💻 Trung Tính',
    bg: '#161f2e',
    headerBg: '#0f172a',
    headerActiveBg: '#1f293d',
    text: '#f0f6fc',
    textMuted: '#94a3b8',
    border: 'rgba(255, 255, 255, 0.08)',
    grid: 'rgba(255, 255, 255, 0.14)',
    graphBg: '#0b0f19',
    graphAxis: 'rgba(255, 255, 255, 0.85)',
    graphText: '#f0f6fc',
    graphGrid: 'rgba(255, 255, 255, 0.06)',
    defaultPen: '#ffffff',
  },
};

export class CanvasRenderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.isDisplayMode = !!options.isDisplayMode;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.stats = {
      fps: 60,
      renderedNodes: 0,
      culledNodes: 0,
      renderedStrokes: 0,
      culledStrokes: 0,
    };
    this.lastFrameTime = performance.now();
    this.frameCount = 0;
    this.fpsTimer = performance.now();
    this.cachedWidth = 0;
    this.cachedHeight = 0;
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;

    if (this.cachedWidth !== width || this.cachedHeight !== height) {
      this.cachedWidth = width;
      this.cachedHeight = height;
      this.canvas.width = width * dpr;
      this.canvas.height = height * dpr;
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
    }
  }

  render(scene, camera, selectedNodeId, activeSession, eraserCursor, ocrSelectionBox = null, ocrHighlightBoxes = null, remoteSessions = null, options = null) {
    if (options && typeof options.isDisplayMode === 'boolean') {
      this.isDisplayMode = options.isDisplayMode;
    }
    const focusedNodeId = options?.focusedNodeId || null;

    // Phân tích nhánh tập trung (Focused branch analysis):
    // Đảm bảo bảng được chọn, toàn bộ cây con bên trong (cấp 2, 3, 4...) và các bảng cha chứa nó
    // LUÔN hiển thị 100% sắc nét, tuyệt đối không bị làm mờ hay giảm opacity!
    let focusedSubtreeIds = null;
    let focusedAncestorIds = null;

    if (focusedNodeId && !this.isDisplayMode) {
      focusedSubtreeIds = new Set();
      focusedAncestorIds = new Set();

      const findPath = (curr, path = []) => {
        if (!curr) return false;
        const currentPath = [...path, curr.id];
        if (curr.id === focusedNodeId) {
          path.forEach((id) => focusedAncestorIds.add(id));
          const addAll = (n) => {
            focusedSubtreeIds.add(n.id);
            if (Array.isArray(n.children)) {
              for (const c of n.children) addAll(c);
            }
          };
          addAll(curr);
          return true;
        }
        if (Array.isArray(curr.children)) {
          for (const c of curr.children) {
            if (findPath(c, currentPath)) return true;
          }
        }
        return false;
      };

      findPath(scene.root);
    }

    const focusedContext = {
      focusedNodeId,
      focusedSubtreeIds,
      focusedAncestorIds,
    };

    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;

    // Calculate FPS
    this.frameCount++;
    const now = performance.now();
    if (now - this.fpsTimer >= 500) {
      this.stats.fps = Math.round((this.frameCount * 1000) / (now - this.fpsTimer));
      this.frameCount = 0;
      this.fpsTimer = now;
    }

    this.stats.renderedNodes = 0;
    this.stats.culledNodes = 0;
    this.stats.renderedStrokes = 0;
    this.stats.culledStrokes = 0;

    ctx.save();
    ctx.scale(dpr, dpr);

    const screenW = this.cachedWidth;
    const screenH = this.cachedHeight;
    camera.viewportWidth = screenW;
    camera.viewportHeight = screenH;

    // 1. Draw Infinite Mother Canvas (Canvas Mẹ) Background & Grid
    this.drawInfiniteGrid(ctx, camera, screenW, screenH, scene);

    // 2. Viewport Frustum for Culling
    const viewportFrustum = AABB.fromOriginSize(0, 0, screenW, screenH);
    const worldToScreen = camera.worldToScreenTransform();

    // 3. Render Hierarchy: Root (Canvas Mẹ) & Child Boards (Bảng Con)
    this.renderNode(
      ctx,
      scene.root,
      camera,
      worldToScreen,
      viewportFrustum,
      viewportFrustum,
      true,
      selectedNodeId,
      activeSession,
      remoteSessions,
      focusedContext
    );

    // 4. Draw Eraser Brush Ring Indicator
    if (eraserCursor) {
      this.drawEraserCursor(ctx, eraserCursor);
    }

    // 5. Draw OCR Selection Marquee Box (Khoanh vùng OCR)
    if (ocrSelectionBox) {
      this.drawOcrSelectionBox(ctx, ocrSelectionBox);
    }

    // 6. Draw OCR Highlight Blocks
    if (ocrHighlightBoxes && ocrHighlightBoxes.length > 0) {
      this.drawOcrHighlightBoxes(ctx, ocrHighlightBoxes, scene, camera);
    }

    ctx.restore();
    return this.stats;
  }

  drawOcrSelectionBox(ctx, box) {
    const x = Math.min(box.startX, box.currentX);
    const y = Math.min(box.startY, box.currentY);
    const w = Math.abs(box.currentX - box.startX);
    const h = Math.abs(box.currentY - box.startY);

    if (w < 2 && h < 2) return;

    ctx.save();
    // Translucent neon background
    ctx.fillStyle = 'rgba(88, 166, 255, 0.12)';
    ctx.fillRect(x, y, w, h);

    // Glowing dashed border
    ctx.strokeStyle = '#58a6ff';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x, y, w, h);

    // Corner brackets
    const bracketLen = Math.min(12, Math.min(w, h) * 0.4);
    ctx.setLineDash([]);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#ffffff';

    // Top-left
    ctx.beginPath();
    ctx.moveTo(x, y + bracketLen);
    ctx.lineTo(x, y);
    ctx.lineTo(x + bracketLen, y);
    // Top-right
    ctx.moveTo(x + w - bracketLen, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + bracketLen);
    // Bottom-left
    ctx.moveTo(x, y + h - bracketLen);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x + bracketLen, y + h);
    // Bottom-right
    ctx.moveTo(x + w - bracketLen, y + h);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + w, y + h - bracketLen);
    ctx.stroke();

    ctx.restore();
  }

  drawOcrHighlightBoxes(ctx, highlightBoxes, scene = null, camera = null) {
    ctx.save();
    for (const item of highlightBoxes) {
      let rect = item.screenRect || item.rect;
      if (item.localRect && item.targetNodeId !== undefined && scene && camera) {
        const p1 = scene.localToScreen(new Vec2(item.localRect.x, item.localRect.y), item.targetNodeId, camera);
        const p2 = scene.localToScreen(
          new Vec2(item.localRect.x + item.localRect.width, item.localRect.y + item.localRect.height),
          item.targetNodeId,
          camera
        );
        rect = {
          x: Math.min(p1.x, p2.x),
          y: Math.min(p1.y, p2.y),
          width: Math.abs(p2.x - p1.x),
          height: Math.abs(p2.y - p1.y),
        };
      }
      if (!rect) continue;

      if (item.isLoading) {
        ctx.fillStyle = 'rgba(88, 166, 255, 0.12)';
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
        ctx.strokeStyle = '#58a6ff';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      } else {
        ctx.fillStyle = 'rgba(63, 185, 80, 0.18)';
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
        ctx.strokeStyle = '#3fb950';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      }
    }
    ctx.restore();
  }

  drawInfiniteGrid(ctx, camera, screenW, screenH, scene = null) {
    const rootNode = scene ? scene.root : null;
    const styleId = (rootNode && rootNode.style) || 'chalkboard';
    const gridType = (rootNode && rootNode.gridType) || 'grid';
    const theme = BOARD_THEMES[styleId] || BOARD_THEMES.chalkboard;

    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, screenW, screenH);

    if (gridType === 'none') return;

    const zoom = camera.zoom;
    let step = 40;
    while (step * zoom < 20) step *= 2;
    while (step * zoom > 80) step /= 2;

    const screenStep = step * zoom;
    const screenCenter = new Vec2(screenW * 0.5, screenH * 0.5);

    const startX = ((screenCenter.x - camera.pan.x * zoom) % screenStep + screenStep) % screenStep;
    const startY = ((screenCenter.y - camera.pan.y * zoom) % screenStep + screenStep) % screenStep;

    if (gridType === 'dots') {
      ctx.fillStyle = theme.grid;
      const dotRadius = zoom > 1.5 ? 1.5 : 1.0;
      ctx.beginPath();
      for (let x = startX; x < screenW; x += screenStep) {
        for (let y = startY; y < screenH; y += screenStep) {
          ctx.moveTo(x + dotRadius, y);
          ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
        }
      }
      ctx.fill();
    } else if (gridType === 'lines') {
      ctx.strokeStyle = theme.grid;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      for (let y = startY; y < screenH; y += screenStep) {
        ctx.moveTo(0, y);
        ctx.lineTo(screenW, y);
      }
      ctx.stroke();
    } else {
      // grid (ô vuông vô tận)
      ctx.strokeStyle = theme.grid;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      for (let x = startX; x < screenW; x += screenStep) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, screenH);
      }
      for (let y = startY; y < screenH; y += screenStep) {
        ctx.moveTo(0, y);
        ctx.lineTo(screenW, y);
      }
      ctx.stroke();
    }
  }

  renderNode(
    ctx,
    node,
    camera,
    parentScreenTransform,
    viewportFrustum,
    currentScissor,
    isRoot,
    selectedNodeId,
    activeSession,
    remoteSessions = null,
    focusedContext = null
  ) {
    if (isRoot) {
      this.stats.renderedNodes++;

      // 1. Render Children First: Math Graphs & Images on the Infinite Canvas
      for (const child of node.children) {
        const childScreenTransform = child.transform.then(parentScreenTransform);
        const childBounds = child.localBounds().transform(childScreenTransform);
        if (!viewportFrustum.intersects(childBounds)) {
          this.stats.culledNodes++;
          continue;
        }
        this.stats.renderedNodes++;

        if (child.image) {
          this.drawImageNode(ctx, child, childBounds, child.id === selectedNodeId, camera.zoom);
        } else if (child.graphData) {
          this.drawGraphNode(ctx, child, childBounds, child.id === selectedNodeId, camera.zoom);
        } else if (child.textContent) {
          this.drawNodeTextContent(ctx, child, childScreenTransform);
        } else {
          this.drawCanvasContainer(ctx, child, childBounds, child.id === selectedNodeId, camera.zoom);
        }

        // Render any strokes inside the child if any exist (legacy compatibility)
        if (child.elements && child.elements.length > 0) {
          for (const stroke of child.elements) {
            this.drawStroke(ctx, stroke, childScreenTransform);
          }
        }
      }

      // 2. Render Freehand Strokes on the Unified Infinite Canvas (Overlaid on top so you can annotate over images & graphs!)
      const { a: ta, b: tb, c: tc, d: td, tx: ttx, ty: tty } = parentScreenTransform;
      const scMinX = viewportFrustum.minX, scMaxX = viewportFrustum.maxX;
      const scMinY = viewportFrustum.minY, scMaxY = viewportFrustum.maxY;

      for (const stroke of node.elements) {
        const b = stroke.bounds;
        const x1 = ta * b.minX + tc * b.minY + ttx;
        const y1 = tb * b.minX + td * b.minY + tty;
        const x2 = ta * b.maxX + tc * b.minY + ttx;
        const y2 = tb * b.maxX + td * b.minY + tty;
        const x3 = ta * b.minX + tc * b.maxY + ttx;
        const y3 = tb * b.minX + td * b.maxY + tty;
        const x4 = ta * b.maxX + tc * b.maxY + ttx;
        const y4 = tb * b.maxX + td * b.maxY + tty;

        const sMinX = Math.min(x1, x2, x3, x4);
        const sMaxX = Math.max(x1, x2, x3, x4);
        const sMinY = Math.min(y1, y2, y3, y4);
        const sMaxY = Math.max(y1, y2, y3, y4);

        if (sMinX <= scMaxX && sMaxX >= scMinX && sMinY <= scMaxY && sMaxY >= scMinY) {
          this.stats.renderedStrokes++;
          this.drawStroke(ctx, stroke, parentScreenTransform);
        } else {
          this.stats.culledStrokes++;
        }
      }

      // 3. Render Live In-Flight Strokes (Hỗ trợ đa điểm Multi-touch & đơn điểm)
      if (activeSession) {
        const localSessions = activeSession instanceof Map
          ? Array.from(activeSession.values())
          : (Array.isArray(activeSession) ? activeSession : [activeSession]);

        for (const sess of localSessions) {
          if (sess) {
            const livePoints = sess.getSmoothedPoints ? sess.getSmoothedPoints() : sess.rawPoints;
            if (livePoints && livePoints.length >= 2) {
              const liveStroke = {
                points: livePoints,
                color: sess.color,
                baseWidth: sess.baseWidth,
                brushType: sess.brushType,
              };
              this.drawStroke(ctx, liveStroke, parentScreenTransform);
            }
          }
        }
      }

      // 4. Render Remote Live In-Flight Strokes (Từ iPad/Tablet qua mạng LAN)
      if (remoteSessions) {
        const sessions = remoteSessions instanceof Map ? Array.from(remoteSessions.values()) : (Array.isArray(remoteSessions) ? remoteSessions : [remoteSessions]);
        for (const rSession of sessions) {
          if (rSession && rSession.points && rSession.points.length >= 2) {
            const rStroke = {
              points: rSession.points,
              color: rSession.color || '#388bfd',
              baseWidth: rSession.baseWidth || 3.0,
              brushType: rSession.brushType || 'solid',
            };
            this.drawStroke(ctx, rStroke, parentScreenTransform);
          }
        }
      }
    }
  }

  drawImageNode(ctx, node, screenBounds, isSelected, zoom) {
    const { minX, minY, width, height } = screenBounds;
    const radius = 6;

    // 1. Draw Image Content
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(minX, minY, width, height, radius);
    ctx.clip();

    try {
      if (node.image instanceof HTMLImageElement || (typeof Image !== 'undefined' && node.image instanceof Image)) {
        if (node.image.complete && node.image.naturalWidth > 0) {
          ctx.drawImage(node.image, minX, minY, width, height);
        } else {
          ctx.fillStyle = '#161b22';
          ctx.fillRect(minX, minY, width, height);
          ctx.fillStyle = '#8b949e';
          ctx.font = '500 13px "Outfit", sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('🖼️ Đang tải ảnh...', minX + width * 0.5, minY + height * 0.5);

          if (!node.image._hasLoadHandler) {
            node.image._hasLoadHandler = true;
            node.image.addEventListener('load', () => {
              if (typeof CanvasNode.onImageLoaded === 'function') {
                CanvasNode.onImageLoaded();
              }
            });
          }
        }
      } else if (typeof node.image === 'string') {
        const img = new Image();
        img.src = node.image;
        node.image = img;
        ctx.fillStyle = '#161b22';
        ctx.fillRect(minX, minY, width, height);
        ctx.fillStyle = '#8b949e';
        ctx.font = '500 13px "Outfit", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('🖼️ Đang tải ảnh...', minX + width * 0.5, minY + height * 0.5);

        img.onload = () => {
          if (typeof CanvasNode.onImageLoaded === 'function') {
            CanvasNode.onImageLoaded();
          }
        };
      }
    } catch (e) {
      console.warn('[Renderer] Error drawing node.image:', e);
    }
    ctx.restore();

    // 2. Selection border, Move Pill, and Resize Handles (App Mode only)
    if (isSelected && !this.isDisplayMode) {
      ctx.save();
      // Selection outline
      ctx.strokeStyle = '#58a6ff';
      ctx.lineWidth = 2.0;
      ctx.beginPath();
      ctx.roundRect(minX, minY, width, height, radius);
      ctx.stroke();

      // Top floating pill for Dragging & Deleting
      const pillH = 26;
      const pillW = Math.min(width, 160);
      const pillX = minX + (width - pillW) * 0.5;
      const pillY = Math.max(8, minY - pillH - 6);

      ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
      ctx.beginPath();
      ctx.roundRect(pillX, pillY, pillW, pillH, 6);
      ctx.fill();
      ctx.strokeStyle = 'rgba(88, 166, 255, 0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Drag Grip & Title
      ctx.fillStyle = '#e6edf3';
      ctx.font = '500 11px "Outfit", sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText('⋮⋮ Di chuyển', pillX + 10, pillY + pillH * 0.5);

      // Close Button [✕] on pill
      const closeBtnX = pillX + pillW - 14;
      const closeBtnY = pillY + pillH * 0.5;
      ctx.fillStyle = 'rgba(248, 81, 73, 0.25)';
      ctx.beginPath();
      ctx.arc(closeBtnX, closeBtnY, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#f85149';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(closeBtnX - 3, closeBtnY - 3);
      ctx.lineTo(closeBtnX + 3, closeBtnY + 3);
      ctx.moveTo(closeBtnX + 3, closeBtnY - 3);
      ctx.lineTo(closeBtnX - 3, closeBtnY + 3);
      ctx.stroke();

      ctx.restore();

      // Resize Handles
      if (zoom > 0.15) {
        this.drawResizeHandles(ctx, screenBounds);
      }
    }
  }

  drawGraphNode(ctx, node, screenBounds, isSelected, zoom) {
    const { minX, minY, width, height } = screenBounds;
    const radius = 8;
    const theme = BOARD_THEMES[node.style] || BOARD_THEMES.chalkboard;
    const headerH = Math.max(24, Math.min(30, 26 * Math.min(zoom, 1.2)));

    // 1. Container Base & Shadow
    ctx.save();
    ctx.shadowColor = isSelected ? 'rgba(88, 166, 255, 0.35)' : 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = (isSelected ? 24 : 14) * Math.min(zoom, 1.5);
    ctx.shadowOffsetY = 4 * Math.min(zoom, 1.5);

    ctx.fillStyle = theme.bg;
    ctx.beginPath();
    ctx.roundRect(minX, minY, width, height, radius);
    ctx.fill();
    ctx.restore();

    // 2. Header Bar
    ctx.fillStyle = isSelected ? theme.headerActiveBg : theme.headerBg;
    ctx.beginPath();
    ctx.roundRect(minX, minY, width, headerH, [radius, radius, 0, 0]);
    ctx.fill();

    ctx.strokeStyle = isSelected ? 'rgba(88, 166, 255, 0.4)' : theme.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(minX, minY + headerH);
    ctx.lineTo(minX + width, minY + headerH);
    ctx.stroke();

    // Title & Buttons
    const centerY = minY + headerH * 0.5;
    ctx.fillStyle = isSelected ? '#ffffff' : theme.text;
    ctx.font = `600 ${Math.max(11, Math.min(13, 12 * zoom))}px "Outfit", sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(`📈 ${node.name || 'Đồ Thị Hàm Số'}`, minX + 12, centerY, Math.max(40, width - 80));

    if (!this.isDisplayMode) {
      // Nút Xóa [✕]
      const btnDelX = minX + width - 14;
      ctx.fillStyle = isSelected ? 'rgba(248, 81, 73, 0.2)' : 'rgba(255, 255, 255, 0.08)';
      ctx.beginPath();
      ctx.roundRect(btnDelX - 8, centerY - 8, 16, 16, 4);
      ctx.fill();
      ctx.strokeStyle = isSelected ? '#f85149' : '#94a3b8';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(btnDelX - 2.5, centerY - 2.5);
      ctx.lineTo(btnDelX + 2.5, centerY + 2.5);
      ctx.moveTo(btnDelX + 2.5, centerY - 2.5);
      ctx.lineTo(btnDelX - 2.5, centerY + 2.5);
      ctx.stroke();

      // Nút Chỉnh sửa hàm số [✎]
      if (width >= 60) {
        const btnEditX = minX + width - 36;
        ctx.fillStyle = isSelected ? 'rgba(88, 166, 255, 0.2)' : 'rgba(255, 255, 255, 0.08)';
        ctx.beginPath();
        ctx.roundRect(btnEditX - 8, centerY - 8, 16, 16, 4);
        ctx.fill();
        ctx.strokeStyle = isSelected ? '#58a6ff' : '#94a3b8';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(btnEditX - 3, centerY + 3);
        ctx.lineTo(btnEditX + 3, centerY - 3);
        ctx.moveTo(btnEditX + 1, centerY - 4);
        ctx.lineTo(btnEditX + 4, centerY - 1);
        ctx.stroke();
      }
    }

    // 3. Graph Body (Math Coordinate Plane)
    const bodyY = minY + headerH;
    const bodyH = Math.max(0, height - headerH);

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(minX, bodyY, width, bodyH, [0, 0, radius, radius]);
    ctx.clip();

    ctx.fillStyle = theme.graphBg;
    ctx.fillRect(minX, bodyY, width, bodyH);

    const gd = node.graphData;
    const cameraZoom = zoom;
    const graphZoom = node.contentZoom || 1.0;
    const xSpan = (gd.xSpan || 20) / graphZoom;
    const scaleX = width / xSpan;
    const ySpan = bodyH / scaleX;

    const panX = (node.contentPan ? node.contentPan.x : 0) * graphZoom * cameraZoom;
    const panY = (node.contentPan ? node.contentPan.y : 0) * graphZoom * cameraZoom;
    const originX = minX + width * 0.5 - panX;
    const originY = bodyY + bodyH * 0.5 - panY;

    const minMathX = (minX - originX) / scaleX;
    const maxMathX = (minX + width - originX) / scaleX;
    const minMathY = (originY - (bodyY + bodyH)) / scaleX;
    const maxMathY = (originY - bodyY) / scaleX;

    // Grid Lines
    let unitStep = 1;
    while (unitStep * scaleX < 24) unitStep *= 2;
    while (unitStep * scaleX > 120) unitStep /= 2;

    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.graphGrid;
    ctx.beginPath();
    const subStep = unitStep / 5;
    if (subStep * scaleX >= 8) {
      for (let x = Math.floor(minMathX / subStep) * subStep; x <= maxMathX; x += subStep) {
        const sx = originX + x * scaleX;
        ctx.moveTo(sx, bodyY);
        ctx.lineTo(sx, bodyY + bodyH);
      }
      for (let y = Math.floor(minMathY / subStep) * subStep; y <= maxMathY; y += subStep) {
        const sy = originY - y * scaleX;
        ctx.moveTo(minX, sy);
        ctx.lineTo(minX + width, sy);
      }
    }
    ctx.stroke();

    ctx.strokeStyle = theme.graphGrid;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let x = Math.floor(minMathX / unitStep) * unitStep; x <= maxMathX; x += unitStep) {
      const sx = originX + x * scaleX;
      ctx.moveTo(sx, bodyY);
      ctx.lineTo(sx, bodyY + bodyH);
    }
    for (let y = Math.floor(minMathY / unitStep) * unitStep; y <= maxMathY; y += unitStep) {
      const sy = originY - y * scaleX;
      ctx.moveTo(minX, sy);
      ctx.lineTo(minX + width, sy);
    }
    ctx.stroke();

    // Axes
    ctx.lineWidth = 2.0;
    ctx.strokeStyle = theme.graphAxis;
    ctx.beginPath();
    if (originY >= bodyY && originY <= bodyY + bodyH) {
      ctx.moveTo(minX, originY);
      ctx.lineTo(minX + width, originY);
    }
    if (originX >= minX && originX <= minX + width) {
      ctx.moveTo(originX, bodyY);
      ctx.lineTo(originX, bodyY + bodyH);
    }
    ctx.stroke();

    // Tick labels
    ctx.fillStyle = theme.graphText;
    ctx.font = '500 10px "Inter", sans-serif';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    for (let x = Math.floor(minMathX / unitStep) * unitStep; x <= maxMathX; x += unitStep) {
      if (Math.abs(x) < 1e-6) continue;
      const sx = originX + x * scaleX;
      const labelY = Math.min(bodyY + bodyH - 14, Math.max(bodyY + 2, originY + 4));
      ctx.fillText(Number(x.toFixed(2)), sx, labelY);
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let y = Math.floor(minMathY / unitStep) * unitStep; y <= maxMathY; y += unitStep) {
      if (Math.abs(y) < 1e-6) continue;
      const sy = originY - y * scaleX;
      const labelX = Math.min(minX + width - 4, Math.max(minX + 24, originX - 4));
      ctx.fillText(Number(y.toFixed(2)), labelX, sy);
    }

    // Math curves
    const expressions = gd.expressions || [];
    const numSamples = Math.min(800, Math.max(100, Math.round(width * 1.2)));

    for (const item of expressions) {
      if (!item.visible || !item.expr) continue;
      if (!item._compiledFn || item._compiledExpr !== item.expr) {
        item._compiledFn = MathEvaluator.compile(item.expr);
        item._compiledExpr = item.expr;
      }
      ctx.strokeStyle = item.color || '#58a6ff';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      let isFirst = true;
      for (let i = 0; i <= numSamples; i++) {
        const t = i / numSamples;
        const mx = minMathX + t * (maxMathX - minMathX);
        let my = null;
        try {
          my = item._compiledFn(mx, gd.params || {});
        } catch (e) {
          my = null;
        }
        if (my !== null && isFinite(my)) {
          const sx = originX + mx * scaleX;
          const sy = originY - my * scaleX;
          if (isFirst) {
            ctx.moveTo(sx, sy);
            isFirst = false;
          } else {
            ctx.lineTo(sx, sy);
          }
        } else {
          isFirst = true;
        }
      }
      ctx.stroke();
    }

    // Formula tag badges
    if (expressions.length > 0 && width > 180 && bodyH > 100) {
      let tagY = bodyY + 12;
      for (const item of expressions) {
        if (!item.visible || !item.expr) continue;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
        ctx.beginPath();
        ctx.roundRect(minX + 10, tagY, Math.min(140, width - 20), 20, 4);
        ctx.fill();

        ctx.fillStyle = item.color || '#58a6ff';
        ctx.beginPath();
        ctx.arc(minX + 18, tagY + 10, 4, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = theme.text;
        ctx.font = '500 11px "Outfit", sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        let displayExpr = item.expr
          .replace(/\\(lvert|rvert|vert)/g, '|')
          .replace(/\\left|\\right/g, '')
          .replace(/\\cdot/g, '·')
          .replace(/\\times/g, '×');
        ctx.fillText(`y = ${displayExpr}`, minX + 28, tagY + 10, 110);

        tagY += 24;
        if (tagY > bodyY + bodyH - 30) break;
      }
    }
    ctx.restore();

    // 4. Outer border
    ctx.strokeStyle = isSelected ? '#58a6ff' : theme.border;
    ctx.lineWidth = isSelected ? 2.5 : 1.2;
    ctx.beginPath();
    ctx.roundRect(minX, minY, width, height, radius);
    ctx.stroke();

    // 5. Resize Handles
    if (isSelected && zoom > 0.15) {
      this.drawResizeHandles(ctx, screenBounds);
    }
  }

  drawCanvasContainer(ctx, node, screenBounds, isSelected, zoom) {
    if (node.image) {
      this.drawImageNode(ctx, node, screenBounds, isSelected, zoom);
    } else if (node.graphData) {
      this.drawGraphNode(ctx, node, screenBounds, isSelected, zoom);
    }
  }

  drawNodeTextContent(ctx, node, innerContentScreenTransform) {
    if (!node.textContent) return;
    const p0 = innerContentScreenTransform.transformPoint(new Vec2(20, 24));
    const scale = Math.hypot(innerContentScreenTransform.a, innerContentScreenTransform.b) || 1.0;
    const baseFontSize = (node.textConfig?.fontSize || 16) * scale;

    if (baseFontSize < 3) return;

    ctx.save();
    ctx.font = `500 ${baseFontSize}px ${node.textConfig?.font || 'Inter, sans-serif'}`;
    ctx.fillStyle = node.textConfig?.color || '#f0f6fc';
    ctx.textBaseline = 'top';

    const lineHeight = baseFontSize * 1.55;
    const maxWidth = Math.max(60, (node.width - 40) * scale);
    const lines = node.textContent.split('\n');
    let currentY = p0.y;

    for (const rawLine of lines) {
      const words = rawLine.split(' ');
      let currentLine = '';
      for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        const testW = ctx.measureText(testLine).width;
        if (testW > maxWidth && currentLine) {
          ctx.fillText(currentLine, p0.x, currentY);
          currentY += lineHeight;
          currentLine = word;
        } else {
          currentLine = testLine;
        }
      }
      if (currentLine) {
        ctx.fillText(currentLine, p0.x, currentY);
        currentY += lineHeight;
      }
    }
    ctx.restore();
  }

  drawResizeHandles(ctx, bounds) {
    const { minX, minY, maxX, maxY } = bounds;
    const midX = (minX + maxX) * 0.5;
    const midY = (minY + maxY) * 0.5;
    const handleSize = 7;

    const handles = [
      { x: minX, y: minY },
      { x: midX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: midY },
      { x: maxX, y: maxY },
      { x: midX, y: maxY },
      { x: minX, y: maxY },
      { x: minX, y: midY },
    ];

    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#58a6ff';
    ctx.lineWidth = 2;

    for (const h of handles) {
      ctx.beginPath();
      ctx.roundRect(h.x - handleSize * 0.5, h.y - handleSize * 0.5, handleSize, handleSize, 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  drawStroke(ctx, stroke, transform) {
    if (!stroke.points || stroke.points.length < 2) return;

    ctx.save();
    const pts = stroke.points;
    const len = pts.length;
    const baseW = stroke.baseWidth || 3.0;
    const { a, b, c, d, tx, ty } = transform;
    const scale = Math.hypot(a, b) || 1.0;
    const brushType = stroke.brushType || 'solid';

    const tracePath = () => {
      ctx.beginPath();
      ctx.moveTo(a * pts[0].x + c * pts[0].y + tx, b * pts[0].x + d * pts[0].y + ty);
      for (let i = 1; i < len; i++) {
        ctx.lineTo(a * pts[i].x + c * pts[i].y + tx, b * pts[i].x + d * pts[i].y + ty);
      }
    };

    if (brushType === 'highlighter') {
      ctx.globalAlpha = 0.4;
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = stroke.color;
      ctx.lineCap = 'square';
      ctx.lineJoin = 'miter';
      ctx.lineWidth = Math.max(6, baseW * scale * 3.5);
      tracePath();
      ctx.stroke();
    } else if (brushType === 'neon') {
      // Bút Dạ Quang: Lớp hào quang phát sáng + Lõi sáng
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // 1. Lớp hào quang ngoài
      ctx.shadowColor = stroke.color;
      ctx.shadowBlur = 14 * Math.min(scale, 2.0);
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = Math.max(2, baseW * scale * 1.5);
      tracePath();
      ctx.stroke();

      // 2. Lõi sáng trắng
      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(0.8, baseW * scale * 0.4);
      ctx.stroke();
    } else if (brushType === 'dashed') {
      ctx.strokeStyle = stroke.color;
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'round';
      ctx.setLineDash([8 * Math.min(scale, 2.0), 6 * Math.min(scale, 2.0)]);
      ctx.lineWidth = Math.max(0.8, baseW * scale);
      tracePath();
      ctx.stroke();
    } else if (brushType === 'dotted') {
      ctx.strokeStyle = stroke.color;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.setLineDash([1, 8 * Math.min(scale, 2.0)]);
      ctx.lineWidth = Math.max(1.2, baseW * scale);
      tracePath();
      ctx.stroke();
    } else if (brushType === 'chalk') {
      // Phấn viết bảng: Nét mộc xước tự nhiên
      ctx.strokeStyle = stroke.color;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = 0.85;
      ctx.setLineDash([2, 1]);
      ctx.lineWidth = Math.max(1, baseW * scale * 1.15);
      tracePath();
      ctx.stroke();
    } else if (brushType === 'calligraphy') {
      // Bút Thư Pháp: Biến thiên độ dày theo góc chuyển động vát 45 độ
      ctx.strokeStyle = stroke.color;
      ctx.lineCap = 'square';
      ctx.lineJoin = 'round';

      let prevX = a * pts[0].x + c * pts[0].y + tx;
      let prevY = b * pts[0].x + d * pts[0].y + ty;
      for (let i = 0; i < len - 1; i++) {
        const nextX = a * pts[i + 1].x + c * pts[i + 1].y + tx;
        const nextY = b * pts[i + 1].x + d * pts[i + 1].y + ty;
        const dx = nextX - prevX;
        const dy = nextY - prevY;
        const angle = Math.atan2(dy, dx);
        const angleFactor = Math.abs(Math.sin(angle - Math.PI * 0.25));
        const pressure = ((pts[i].pressure || 0.8) + (pts[i + 1].pressure || 0.8)) * 0.5;
        const dynamicW = Math.max(0.8, baseW * scale * (0.3 + 1.2 * angleFactor * pressure));

        ctx.lineWidth = dynamicW;
        ctx.beginPath();
        ctx.moveTo(prevX, prevY);
        ctx.lineTo(nextX, nextY);
        ctx.stroke();
        prevX = nextX;
        prevY = nextY;
      }
    } else {
      // Bút mực tiêu chuẩn (Solid)
      ctx.strokeStyle = stroke.color;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(0.5, baseW * scale);
      tracePath();
      ctx.stroke();
    }

    ctx.restore();
  }

  drawEraserCursor(ctx, cursor) {
    if (!cursor) return;
    const cursors = cursor instanceof Map
      ? Array.from(cursor.values())
      : (Array.isArray(cursor) ? cursor : [cursor]);

    for (const c of cursors) {
      if (!c) continue;
      ctx.save();
      ctx.strokeStyle = '#ff7b72';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.fillStyle = 'rgba(255, 123, 114, 0.12)';

      ctx.beginPath();
      ctx.arc(c.x, c.y, c.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }
}

function sceneWorldTransform(node, camera) {
  // Finds world transform of node
  const accum = node._worldTransformCache || camera.worldToScreenTransform().then(node.transform);
  return accum;
}
