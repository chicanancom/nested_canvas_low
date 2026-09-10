import { AABB, Vec2 } from './math.js';
import { MathEvaluator } from './math_evaluator.js';

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
      remoteSessions
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
    const styleId = (rootNode && rootNode.style) || 'dark';
    const gridType = (rootNode && rootNode.gridType) || 'dots';
    const theme = BOARD_THEMES[styleId] || BOARD_THEMES.dark;

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
    remoteSessions = null
  ) {
    // nodeScreenTransform = parentScreenTransform * node.transform
    const nodeScreenTransform = isRoot
      ? parentScreenTransform
      : node.transform.then(parentScreenTransform);

    // Fast bounds calculation
    const localBounds = node.localBounds();
    const nodeScreenBounds = localBounds.transform(nodeScreenTransform);

    if (!isRoot) {
      const isVisible = currentScissor.intersects(nodeScreenBounds);
      if (!isVisible) {
        this.stats.culledNodes++;
        return;
      }
      this.stats.renderedNodes++;

      // Draw Child Board (Bảng Con) Container Background & Frame
      this.drawCanvasContainer(ctx, node, nodeScreenBounds, node.id === selectedNodeId, camera.zoom);
    } else {
      this.stats.renderedNodes++;
    }

    // Scissor clipping for child boards (strictly inside writing surface below header)
    ctx.save();
    let effectiveScissor = currentScissor;

    if (!isRoot) {
      const headerH = Math.max(24, Math.min(32, 28 * Math.min(camera.zoom, 1.2)));
      const bodyBounds = AABB.fromOriginSize(
        nodeScreenBounds.minX,
        nodeScreenBounds.minY + headerH,
        nodeScreenBounds.width,
        Math.max(0, nodeScreenBounds.height - headerH)
      );
      effectiveScissor = currentScissor.intersection(bodyBounds) || currentScissor;
      ctx.beginPath();
      ctx.rect(
        nodeScreenBounds.minX,
        nodeScreenBounds.minY + headerH,
        nodeScreenBounds.width,
        Math.max(0, nodeScreenBounds.height - headerH)
      );
      ctx.clip();
    }

    // Inner Content Screen Transform (Áp dụng cuộn & zoom vô tận bên trong bảng con)
    const innerContentScreenTransform = isRoot
      ? nodeScreenTransform
      : node.localContentTransform().then(nodeScreenTransform);

    // Render Images inside this board (underneath strokes so you can draw on images)
    if (node.images && node.images.length > 0) {
      for (const imgEl of node.images) {
        const imgBounds = imgEl.bounds.transform(innerContentScreenTransform);
        if (effectiveScissor.intersects(imgBounds)) {
          const p0 = innerContentScreenTransform.transformPoint(new Vec2(imgEl.x, imgEl.y));
          const scaleX = innerContentScreenTransform.a || 1.0;
          const scaleY = innerContentScreenTransform.d || 1.0;
          try {
            ctx.drawImage(imgEl.img, p0.x, p0.y, imgEl.width * scaleX, imgEl.height * scaleY);
          } catch (e) {}
        }
      }
    }

    // Render Text Content (if this node is a converted OCR text board / note)
    if (node.textContent) {
      this.drawNodeTextContent(ctx, node, innerContentScreenTransform);
    }

    // Render Strokes inside this board
    for (const stroke of node.elements) {
      const strokeScreenBounds = stroke.bounds.transform(innerContentScreenTransform);
      if (effectiveScissor.intersects(strokeScreenBounds)) {
        this.stats.renderedStrokes++;
        this.drawStroke(ctx, stroke, innerContentScreenTransform);
      } else {
        this.stats.culledStrokes++;
      }
    }

    // Render Live In-Flight Strokes (Hỗ trợ cả nét vẽ đơn điểm lẫn đa điểm / Multi-touch Android)
    if (activeSession) {
      const localSessions = activeSession instanceof Map
        ? Array.from(activeSession.values())
        : (Array.isArray(activeSession) ? activeSession : [activeSession]);

      for (const sess of localSessions) {
        if (sess && sess.targetNodeId === node.id) {
          const livePoints = sess.getSmoothedPoints ? sess.getSmoothedPoints() : sess.rawPoints;
          if (livePoints && livePoints.length >= 2) {
            const liveStroke = {
              points: livePoints,
              color: sess.color,
              baseWidth: sess.baseWidth,
              brushType: sess.brushType,
            };
            this.drawStroke(ctx, liveStroke, innerContentScreenTransform);
          }
        }
      }
    }

    // Render Remote Live In-Flight Strokes (Nét vẽ trực tiếp từ iPad/Tablet)
    if (remoteSessions) {
      const sessions = remoteSessions instanceof Map ? Array.from(remoteSessions.values()) : (Array.isArray(remoteSessions) ? remoteSessions : [remoteSessions]);
      for (const rSession of sessions) {
        if (rSession && rSession.targetNodeId === node.id && rSession.points && rSession.points.length >= 2) {
          const rStroke = {
            points: rSession.points,
            color: rSession.color || '#388bfd',
            baseWidth: rSession.baseWidth || 3.0,
            brushType: rSession.brushType || 'solid',
          };
          this.drawStroke(ctx, rStroke, innerContentScreenTransform);
        }
      }
    }

    // Render Nested Children Canvases (Bảng con lồng trong bảng mẹ)
    for (const child of node.children) {
      this.renderNode(
        ctx,
        child,
        camera,
        innerContentScreenTransform,
        viewportFrustum,
        effectiveScissor,
        false,
        selectedNodeId,
        activeSession,
        remoteSessions
      );
    }

    ctx.restore();
  }

  drawNodeTextContent(ctx, node, innerContentScreenTransform) {
    if (!node.textContent) return;
    const p0 = innerContentScreenTransform.transformPoint(new Vec2(20, 24));
    const scale = Math.hypot(innerContentScreenTransform.a, innerContentScreenTransform.b) || 1.0;
    const baseFontSize = (node.textConfig?.fontSize || 16) * scale;

    if (baseFontSize < 3) return; // Culled if too small

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

  drawCanvasContainer(ctx, node, screenBounds, isSelected, zoom) {
    const { minX, minY, width, height } = screenBounds;
    const radius = 8;
    const theme = BOARD_THEMES[node.style] || BOARD_THEMES.chalkboard;
    const headerH = Math.max(24, Math.min(32, 28 * Math.min(zoom, 1.2)));

    // 1. Elevation Drop Shadow
    ctx.save();
    ctx.shadowColor = isSelected ? 'rgba(88, 166, 255, 0.35)' : 'rgba(0, 0, 0, 0.45)';
    ctx.shadowBlur = (isSelected ? 28 : 16) * Math.min(zoom, 1.5);
    ctx.shadowOffsetY = 6 * Math.min(zoom, 1.5);

    // Board Base Background
    ctx.fillStyle = theme.bg;
    ctx.beginPath();
    ctx.roundRect(minX, minY, width, height, radius);
    ctx.fill();
    ctx.restore();

    // 2. Clean Header Bar
    ctx.fillStyle = isSelected ? theme.headerActiveBg : theme.headerBg;
    ctx.beginPath();
    ctx.roundRect(minX, minY, width, headerH, [radius, radius, 0, 0]);
    ctx.fill();

    // Header divider line
    ctx.strokeStyle = isSelected ? 'rgba(88, 166, 255, 0.4)' : theme.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(minX, minY + headerH);
    ctx.lineTo(minX + width, minY + headerH);
    ctx.stroke();

    // Header Content & Per-Board Action Toolbar
    if (headerH > 10 && width > 30) {
      const centerY = minY + headerH * 0.5;

      // Active indicator dot (chỉ hiện trên App)
      if (!this.isDisplayMode && width > 60) {
        ctx.fillStyle = isSelected ? '#58a6ff' : theme.border;
        ctx.beginPath();
        ctx.arc(minX + 12, centerY, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }

      // Title Text: Trên màn chiếu CHỈ hiển thị tên bảng tinh gọn, không kèm số kích thước
      if (width > (this.isDisplayMode ? 20 : 120)) {
        ctx.fillStyle = isSelected ? '#ffffff' : theme.text;
        ctx.font = `${isSelected ? '600' : '500'} ${Math.max(11, Math.min(14, 12 * zoom))}px "Outfit", sans-serif`;
        ctx.textBaseline = 'middle';
        const startX = this.isDisplayMode ? minX + 14 : minX + 22;
        const maxTitleW = this.isDisplayMode ? Math.max(20, width - 28) : Math.max(40, width - 180);
        const rawTitle = this.isDisplayMode ? (node.name || 'Bảng') : `${node.name} (${Math.round(node.width)}×${Math.round(node.height)})`;
        ctx.fillText(rawTitle, startX, centerY, maxTitleW);
      }

      // --- Per-Board Action Toolbar (Chỉ hiển thị trên App điều khiển, ẩn hoàn toàn trên Màn Chiếu PC) ---
      if (!this.isDisplayMode) {
        // 6. Nút Đóng / Xóa bảng (Delete Board ✕) - Luôn hiển thị
        const btnDelX = minX + width - 12;
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

      // 5. Nút Phóng to toàn màn hình (Fullscreen ⛶)
      if (width >= 56) {
        const btnMaxX = minX + width - 34;
        ctx.fillStyle = isSelected ? 'rgba(88, 166, 255, 0.18)' : 'rgba(255, 255, 255, 0.06)';
        ctx.beginPath();
        ctx.roundRect(btnMaxX - 8, centerY - 8, 16, 16, 4);
        ctx.fill();
        ctx.strokeStyle = isSelected ? '#58a6ff' : '#94a3b8';
        ctx.lineWidth = 1.3;
        const s = 3;
        ctx.beginPath();
        ctx.moveTo(btnMaxX - s, centerY - s + 2);
        ctx.lineTo(btnMaxX - s, centerY - s);
        ctx.lineTo(btnMaxX - s + 2, centerY - s);
        ctx.moveTo(btnMaxX + s, centerY - s + 2);
        ctx.lineTo(btnMaxX + s, centerY - s);
        ctx.lineTo(btnMaxX + s - 2, centerY - s);
        ctx.moveTo(btnMaxX - s, centerY + s - 2);
        ctx.lineTo(btnMaxX - s, centerY + s);
        ctx.lineTo(btnMaxX - s + 2, centerY + s);
        ctx.moveTo(btnMaxX + s, centerY + s - 2);
        ctx.lineTo(btnMaxX + s, centerY + s);
        ctx.lineTo(btnMaxX + s - 2, centerY + s);
        ctx.stroke();
      }

      // 4. Nút Xóa sạch nét bảng (Clear Strokes 🗑️)
      if (width >= 80) {
        const btnClrX = minX + width - 56;
        ctx.fillStyle = isSelected ? 'rgba(240, 136, 62, 0.15)' : 'rgba(255, 255, 255, 0.06)';
        ctx.beginPath();
        ctx.roundRect(btnClrX - 8, centerY - 8, 16, 16, 4);
        ctx.fill();
        ctx.strokeStyle = isSelected ? '#f0883e' : '#94a3b8';
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.rect(btnClrX - 3, centerY - 2.5, 6, 6);
        ctx.moveTo(btnClrX - 4.5, centerY - 2.5);
        ctx.lineTo(btnClrX + 4.5, centerY - 2.5);
        ctx.stroke();
      }

      // 3. Nút Redo riêng của bảng (↷)
      if (width >= 104) {
        const canRedo = node.history && node.history.canRedo();
        const btnRedoX = minX + width - 78;
        ctx.fillStyle = isSelected ? 'rgba(88, 166, 255, 0.18)' : 'rgba(255, 255, 255, 0.06)';
        ctx.beginPath();
        ctx.roundRect(btnRedoX - 8, centerY - 8, 16, 16, 4);
        ctx.fill();
        ctx.strokeStyle = canRedo ? (isSelected ? '#58a6ff' : '#e6edf3') : '#6e7681';
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.arc(btnRedoX - 1, centerY, 3, Math.PI * 1.2, Math.PI * 0.5);
        ctx.moveTo(btnRedoX + 3, centerY - 2);
        ctx.lineTo(btnRedoX + 1, centerY - 3.5);
        ctx.lineTo(btnRedoX + 1, centerY - 1);
        ctx.stroke();
      }

      // 2. Nút Undo riêng của bảng (↶)
      if (width >= 128) {
        const canUndo = node.history && node.history.canUndo();
        const btnUndoX = minX + width - 100;
        ctx.fillStyle = isSelected ? 'rgba(88, 166, 255, 0.18)' : 'rgba(255, 255, 255, 0.06)';
        ctx.beginPath();
        ctx.roundRect(btnUndoX - 8, centerY - 8, 16, 16, 4);
        ctx.fill();
        ctx.strokeStyle = canUndo ? (isSelected ? '#58a6ff' : '#e6edf3') : '#6e7681';
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.arc(btnUndoX + 1, centerY, 3, Math.PI * 0.5, Math.PI * 1.8);
        ctx.moveTo(btnUndoX - 3, centerY - 2);
        ctx.lineTo(btnUndoX - 1, centerY - 3.5);
        ctx.lineTo(btnUndoX - 1, centerY - 1);
        ctx.stroke();
      }

      // 1. Nút Chèn Ảnh (Insert Image 🖼️)
      if (width >= 152) {
        const btnImgX = minX + width - 122;
        ctx.fillStyle = isSelected ? 'rgba(188, 140, 255, 0.18)' : 'rgba(255, 255, 255, 0.06)';
        ctx.beginPath();
        ctx.roundRect(btnImgX - 8, centerY - 8, 16, 16, 4);
        ctx.fill();
        ctx.strokeStyle = isSelected ? '#bc8cff' : '#94a3b8';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.rect(btnImgX - 4, centerY - 3.5, 8, 7);
        ctx.moveTo(btnImgX - 4, centerY + 1);
        ctx.lineTo(btnImgX - 1.5, centerY - 1);
        ctx.lineTo(btnImgX + 1, centerY + 0.5);
        ctx.lineTo(btnImgX + 4, centerY - 2);
        ctx.stroke();
      }

      // 0. Nút Chia Sẻ Bảng Qua Socket LAN (Share Board 📡)
      if (width >= 170) {
        const btnShareX = minX + width - 144;
        const isShared = !!node.isShared;
        ctx.fillStyle = isShared ? 'rgba(63, 185, 80, 0.25)' : (isSelected ? 'rgba(88, 166, 255, 0.18)' : 'rgba(255, 255, 255, 0.06)');
        ctx.beginPath();
        ctx.roundRect(btnShareX - 8, centerY - 8, 16, 16, 4);
        ctx.fill();

        ctx.strokeStyle = isShared ? '#3fb950' : (isSelected ? '#58a6ff' : '#94a3b8');
        ctx.lineWidth = 1.2;

        // Vẽ biểu tượng sóng phát tín hiệu Wi-Fi / Socket
        ctx.beginPath();
        // Tâm phát sóng
        ctx.arc(btnShareX, centerY + 2.5, 1.2, 0, Math.PI * 2);
        ctx.fillStyle = isShared ? '#3fb950' : (isSelected ? '#58a6ff' : '#94a3b8');
        ctx.fill();

        // Cung sóng trong
        ctx.beginPath();
        ctx.arc(btnShareX, centerY + 2.5, 3.5, -Math.PI * 0.8, -Math.PI * 0.2);
        ctx.stroke();

        // Cung sóng ngoài
        ctx.beginPath();
        ctx.arc(btnShareX, centerY + 2.5, 5.5, -Math.PI * 0.85, -Math.PI * 0.15);
        ctx.stroke();

        // Nếu đang chia sẻ: thêm chấm tròn xanh phát sáng báo trạng thái LIVE
        if (isShared) {
          ctx.beginPath();
          ctx.arc(btnShareX + 5, centerY - 5, 2.5, 0, Math.PI * 2);
          ctx.fillStyle = '#3fb950';
          ctx.fill();
        }
      }

      // -1. Nút Thêm Bảng Con Lồng Bên Trong (Add Child Board ＋📋)
      if (width >= 194) {
        const btnAddChildX = minX + width - 166;
        ctx.fillStyle = isSelected ? 'rgba(56, 139, 253, 0.18)' : 'rgba(255, 255, 255, 0.06)';
        ctx.beginPath();
        ctx.roundRect(btnAddChildX - 8, centerY - 8, 16, 16, 4);
        ctx.fill();

        ctx.strokeStyle = isSelected ? '#58a6ff' : '#94a3b8';
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(btnAddChildX - 4, centerY);
        ctx.lineTo(btnAddChildX + 4, centerY);
        ctx.moveTo(btnAddChildX, centerY - 4);
        ctx.lineTo(btnAddChildX, centerY + 4);
        ctx.stroke();
      }

      // -2. Nút Thêm Đồ Thị Con Lồng Bên Trong (Add Graph Board ＋📈)
      if (width >= 218) {
        const btnAddGraphX = minX + width - 188;
        ctx.fillStyle = isSelected ? 'rgba(63, 185, 80, 0.18)' : 'rgba(255, 255, 255, 0.06)';
        ctx.beginPath();
        ctx.roundRect(btnAddGraphX - 8, centerY - 8, 16, 16, 4);
        ctx.fill();

        ctx.strokeStyle = isSelected ? '#3fb950' : '#94a3b8';
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(btnAddGraphX - 4.5, centerY - 3.5);
        ctx.lineTo(btnAddGraphX - 4.5, centerY + 3.5);
        ctx.lineTo(btnAddGraphX + 4.5, centerY + 3.5);
        ctx.moveTo(btnAddGraphX - 3.5, centerY + 1);
        ctx.quadraticCurveTo(btnAddGraphX, centerY + 3.5, btnAddGraphX + 3.5, centerY - 2.5);
        ctx.stroke();
      }
      }
    }

    // 3. Board Inner Writing Area (Lưới Ô Ly Toạ Độ hoặc Hình Ảnh nền)
    const bodyY = minY + headerH;
    const bodyH = Math.max(0, height - headerH);

    ctx.save();
    if (node.graphData) {
      // --- BẢNG VẼ ĐỒ THỊ TOÁN HỌC ---
      ctx.beginPath();
      ctx.roundRect(minX, bodyY, width, bodyH, [0, 0, radius, radius]);
      ctx.clip();

      // Nền đồ thị đồng bộ theo Theme
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

      // 1. Vẽ Lưới Toạ độ Phụ & Chính (Grid Lines)
      let unitStep = 1;
      while (unitStep * scaleX < 24) unitStep *= 2;
      while (unitStep * scaleX > 120) unitStep /= 2;

      ctx.lineWidth = 1;
      // Lưới phụ
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

      // Lưới chính
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

      // 2. Vẽ 2 Trục Toạ Độ Chính Ox và Oy (Bold Axes)
      ctx.lineWidth = 2.0;
      ctx.strokeStyle = theme.graphAxis;
      ctx.beginPath();
      // Trục hoành Ox
      if (originY >= bodyY && originY <= bodyY + bodyH) {
        ctx.moveTo(minX, originY);
        ctx.lineTo(minX + width, originY);
      }
      // Trục tung Oy
      if (originX >= minX && originX <= minX + width) {
        ctx.moveTo(originX, bodyY);
        ctx.lineTo(originX, bodyY + bodyH);
      }
      ctx.stroke();

      // 3. Số toạ độ trên các vạch chia (Tick Numbers)
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

      // 4. Vẽ các đường cong hàm số toán học (Math Curves)
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

      // 5. Hiển thị Tags tên hàm số ở góc trái
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
    } else if (node.image) {
      // Bảng con là Ảnh -> Vẽ hình ảnh lấp đầy thân bảng
      ctx.beginPath();
      ctx.roundRect(minX, bodyY, width, bodyH, [0, 0, radius, radius]);
      ctx.clip();
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(minX, bodyY, width, bodyH);
      try {
        ctx.drawImage(node.image, minX, bodyY, width, bodyH);
      } catch (e) {}
    } else {
      // Bảng con thông thường -> Vẽ Nền và Lưới theo Theme & GridType
      ctx.fillStyle = theme.bg;
      ctx.beginPath();
      ctx.roundRect(minX, bodyY, width, bodyH, [0, 0, radius, radius]);
      ctx.fill();

      // Vẽ Lưới Nền (Grid Lines / Dots / Ruled Lines / Blank)
      const effectiveZoom = zoom * (node.contentZoom || 1.0);
      const gridType = node.gridType || 'grid';

      if (gridType !== 'none' && effectiveZoom > 0.15) {
        let step = 28 * effectiveZoom;
        while (step < 16) step *= 2;
        while (step > 64) step /= 2;
        const panX = node.contentPan ? node.contentPan.x : 0;
        const panY = node.contentPan ? node.contentPan.y : 0;
        const startX = minX + (((-panX * zoom) % step + step) % step);
        const startY = bodyY + (((-panY * zoom) % step + step) % step);

        if (gridType === 'dots') {
          // 1. Lưới Chấm Bi Toạ Độ
          ctx.fillStyle = theme.grid;
          const dotR = effectiveZoom > 1.2 ? 1.2 : 0.9;
          ctx.beginPath();
          for (let x = startX; x < minX + width; x += step) {
            for (let y = startY; y < bodyY + bodyH; y += step) {
              ctx.moveTo(x + dotR, y);
              ctx.arc(x, y, dotR, 0, Math.PI * 2);
            }
          }
          ctx.fill();
        } else if (gridType === 'lines') {
          // 2. Dòng Kẻ Ngang Tập Vở Học Sinh (Ruled Lines)
          ctx.strokeStyle = theme.grid;
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          for (let y = startY; y < bodyY + bodyH; y += step) {
            ctx.moveTo(minX, y);
            ctx.lineTo(minX + width, y);
          }
          ctx.stroke();
        } else {
          // 3. Lưới Ô Vuông Caro 5x5mm Tiêu Chuẩn (Squared Grid)
          ctx.strokeStyle = theme.grid;
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          for (let x = startX; x < minX + width; x += step) {
            ctx.moveTo(x, bodyY);
            ctx.lineTo(x, bodyY + bodyH);
          }
          for (let y = startY; y < bodyY + bodyH; y += step) {
            ctx.moveTo(minX, y);
            ctx.lineTo(minX + width, y);
          }
          ctx.stroke();
        }
      }
    }
    ctx.restore();

    // 4. Viền khung bảng ngoài cùng
    ctx.strokeStyle = isSelected ? '#58a6ff' : theme.border;
    ctx.lineWidth = isSelected ? 2.5 : 1.2;
    ctx.beginPath();
    ctx.roundRect(minX, minY, width, height, radius);
    ctx.stroke();

    // 5. Resize Handles on Selected Board
    if (isSelected && zoom > 0.2) {
      this.drawResizeHandles(ctx, screenBounds);
    }
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
    const scale = Math.hypot(transform.a, transform.b) || 1.0;
    const brushType = stroke.brushType || 'solid';

    // Safely pre-transform points into screen coordinates
    const screenPoints = new Array(len);
    for (let i = 0; i < len; i++) {
      const p = pts[i];
      const rawPt = p && p.pos ? p.pos : p;
      screenPoints[i] = rawPt ? transform.transformPoint(rawPt) : new Vec2(0, 0);
    }

    if (brushType === 'highlighter') {
      ctx.globalAlpha = 0.4;
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = stroke.color;
      ctx.lineCap = 'square';
      ctx.lineJoin = 'miter';
      ctx.lineWidth = Math.max(6, baseW * scale * 3.5);

      ctx.beginPath();
      ctx.moveTo(screenPoints[0].x, screenPoints[0].y);
      for (let i = 1; i < len; i++) {
        ctx.lineTo(screenPoints[i].x, screenPoints[i].y);
      }
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
      ctx.beginPath();
      ctx.moveTo(screenPoints[0].x, screenPoints[0].y);
      for (let i = 1; i < len; i++) {
        ctx.lineTo(screenPoints[i].x, screenPoints[i].y);
      }
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

      ctx.beginPath();
      ctx.moveTo(screenPoints[0].x, screenPoints[0].y);
      for (let i = 1; i < len; i++) {
        ctx.lineTo(screenPoints[i].x, screenPoints[i].y);
      }
      ctx.stroke();
    } else if (brushType === 'dotted') {
      ctx.strokeStyle = stroke.color;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.setLineDash([1, 8 * Math.min(scale, 2.0)]);
      ctx.lineWidth = Math.max(1.2, baseW * scale);

      ctx.beginPath();
      ctx.moveTo(screenPoints[0].x, screenPoints[0].y);
      for (let i = 1; i < len; i++) {
        ctx.lineTo(screenPoints[i].x, screenPoints[i].y);
      }
      ctx.stroke();
    } else if (brushType === 'chalk') {
      // Phấn viết bảng: Nét mộc xước tự nhiên
      ctx.strokeStyle = stroke.color;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = 0.85;
      ctx.setLineDash([2, 1]);
      ctx.lineWidth = Math.max(1, baseW * scale * 1.15);

      ctx.beginPath();
      ctx.moveTo(screenPoints[0].x, screenPoints[0].y);
      for (let i = 1; i < len; i++) {
        ctx.lineTo(screenPoints[i].x, screenPoints[i].y);
      }
      ctx.stroke();
    } else if (brushType === 'calligraphy') {
      // Bút Thư Pháp: Biến thiên độ dày theo góc chuyển động vát 45 độ
      ctx.strokeStyle = stroke.color;
      ctx.lineCap = 'square';
      ctx.lineJoin = 'round';

      for (let i = 0; i < len - 1; i++) {
        const pA = screenPoints[i];
        const pB = screenPoints[i + 1];
        const dx = pB.x - pA.x;
        const dy = pB.y - pA.y;
        const angle = Math.atan2(dy, dx);
        const angleFactor = Math.abs(Math.sin(angle - Math.PI * 0.25));
        const pressure = ((pts[i].pressure || 0.8) + (pts[i + 1].pressure || 0.8)) * 0.5;
        const dynamicW = Math.max(0.8, baseW * scale * (0.3 + 1.2 * angleFactor * pressure));

        ctx.lineWidth = dynamicW;
        ctx.beginPath();
        ctx.moveTo(pA.x, pA.y);
        ctx.lineTo(pB.x, pB.y);
        ctx.stroke();
      }
    } else {
      // Bút mực tiêu chuẩn (Solid)
      ctx.strokeStyle = stroke.color;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(0.5, baseW * scale);

      ctx.beginPath();
      ctx.moveTo(screenPoints[0].x, screenPoints[0].y);
      for (let i = 1; i < len; i++) {
        ctx.lineTo(screenPoints[i].x, screenPoints[i].y);
      }
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
