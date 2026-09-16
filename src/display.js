/**
 * NestedCanvas Pure Non-Interactive Fullscreen Canvas Mirror
 * Displays the exact infinite canvas and all child boards in real time.
 * Zero menus, zero buttons, zero interactions, cursor hidden.
 */

import { Camera, Transform2D, Vec2 } from './engine/math.js';
import { CanvasNode, SceneGraph, Stroke, ImageElement } from './engine/scene.js';
import { CanvasRenderer } from './engine/renderer.js';
import { SyncClient } from './sync/client.js';

class PCDisplayApp {
  constructor() {
    this.canvas = document.getElementById('display-canvas');
    this.renderer = new CanvasRenderer(this.canvas, { isDisplayMode: true });
    this.scene = new SceneGraph();
    this.camera = new Camera(0, 0, 1.0, window.innerWidth, window.innerHeight);
    this.remoteActiveSessions = new Map();

    CanvasNode.onImageLoaded = () => {
      this.hasSceneData = this.hasMeaningfulContent();
      this.updateOverlayVisibility();
      this.scheduleRender();
    };

    this.idleOverlay = document.getElementById('idle-overlay');
    this.statusPill = document.getElementById('display-status-pill');
    this.pillDot = document.getElementById('display-pill-dot');
    this.pillText = document.getElementById('display-pill-text');
    this.idleStatusText = document.getElementById('idle-status-text');
    this.idleStatusDot = document.getElementById('idle-status-dot');

    if (this.idleOverlay) {
      this.idleOverlay.addEventListener('click', () => {
        this.hasSceneData = true;
        this.hideIdleOverlay();
      });
    }

    this.hasSceneData = false;
    this.targetZoom = null;
    this.targetPan = null;
    this._saveStateTimer = null;

    // Multi-Page & Multi-Board Display Mode State
    this.pages = [];
    this.currentPageIndex = 0;
    this.displayMode = 'single'; // 'single', 'dual', 'grid'
    this.hudElement = document.getElementById('display-controls-hud');
    this.hudTimer = null;

    console.log('[PC Display] 🚀 Starting Fullscreen PC Display App...');

    // Đảm bảo kích thước renderer khớp 100% với cửa sổ
    this.renderer.resize(window.innerWidth, window.innerHeight);

    // Tải dữ liệu canvas đã lưu từ phiên trước
    this.loadDisplayState();

    // Khởi tạo thanh điều khiển nổi HUD cho màn chiếu
    this.initDisplayHUD();

    // Xử lý sự kiện cửa sổ & phím tắt (F11)
    this.bindWindowEvents();

    // Vòng lặp render liên tục
    this.startRenderLoop();

    // Khởi tạo kết nối mạng LAN
    this.initSync();

    window.displayApp = this;
  }

  requestRender() {
    this.scheduleRender();
  }

  scheduleRender() {
    if (this._renderScheduled) return;
    this._renderScheduled = true;
    requestAnimationFrame(() => this._doRender());
  }

  _isCameraLerping() {
    if (this.targetPan) {
      const dx = this.targetPan.x - this.camera.pan.x;
      const dy = this.targetPan.y - this.camera.pan.y;
      if (Math.abs(dx) > 0.02 || Math.abs(dy) > 0.02) return true;
    }
    if (typeof this.targetZoom === 'number') {
      if (Math.abs(this.targetZoom - this.camera.zoom) > 0.0005) return true;
    }
    return false;
  }

  _doRender() {
    this._renderScheduled = false;

    // Smooth Camera Lerp (silky smooth damping)
    if (this.targetPan) {
      const dx = this.targetPan.x - this.camera.pan.x;
      const dy = this.targetPan.y - this.camera.pan.y;
      if (Math.abs(dx) > 0.02 || Math.abs(dy) > 0.02) {
        this.camera.pan.x += dx * 0.45;
        this.camera.pan.y += dy * 0.45;
      } else {
        this.camera.pan.x = this.targetPan.x;
        this.camera.pan.y = this.targetPan.y;
        this.targetPan = null; // Lerp xong, dừng vòng lặp
      }
    }
    if (typeof this.targetZoom === 'number') {
      const dz = this.targetZoom - this.camera.zoom;
      if (Math.abs(dz) > 0.0005) {
        this.camera.zoom += dz * 0.45;
      } else {
        this.camera.zoom = this.targetZoom;
        this.targetZoom = null; // Lerp xong, dừng vòng lặp
      }
    }

    if (this.displayMode === 'single') {
      this.renderer.render(
        this.scene,
        this.camera,
        null,
        null,
        null,
        null,
        null,
        this.remoteActiveSessions
      );
    } else if (this.displayMode === 'dual') {
      this._renderDualMode();
    } else if (this.displayMode === 'grid') {
      this._renderGridMode();
    }

    // Tiếp tục nếu camera vẫn đang lerp
    if (this._isCameraLerping()) {
      this.scheduleRender();
    }
  }

  _renderDualMode() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const halfW = Math.floor(w / 2);
    const ctx = this.renderer.ctx;

    // Slot 1 (Bên trái): Trang trước hoặc trang tham chiếu (Index - 1 nếu có, hoặc trang 0)
    let leftIndex = this.currentPageIndex - 1;
    if (leftIndex < 0) leftIndex = (this.pages.length > 1) ? 1 : 0;
    const rightIndex = this.currentPageIndex;

    const leftPage = this.pages[leftIndex];
    const rightPage = this.pages[rightIndex];

    const vpLeft = { x: 0, y: 0, width: halfW, height: h };
    const vpRight = { x: halfW, y: 0, width: w - halfW, height: h };

    // Render Bảng Trái
    if (leftPage) {
      const leftScene = this.getPageScene(leftPage);
      const leftCam = new Camera(0, 0, 1.0, halfW, h);
      this.fitSceneInViewport(leftScene, leftCam, halfW, h, 60);
      this.renderer.render(
        leftScene,
        leftCam,
        null,
        null,
        null,
        null,
        null,
        null,
        { viewport: vpLeft, isDisplayMode: true }
      );
      this.drawViewportBadge(
        ctx,
        16,
        20,
        leftPage.name || `Trang ${leftIndex + 1}`,
        false,
        false
      );
    } else {
      this.renderer.render(
        this.scene,
        this.camera,
        null,
        null,
        null,
        null,
        null,
        null,
        { viewport: vpLeft, isDisplayMode: true }
      );
    }

    // Render Bảng Phải (Trang hiện tại đang viết)
    const rightScene = rightPage ? this.getPageScene(rightPage) : this.scene;
    this.renderer.render(
      rightScene,
      this.camera,
      null,
      null,
      null,
      null,
      null,
      this.remoteActiveSessions,
      { viewport: vpRight, isDisplayMode: true }
    );
    this.drawViewportBadge(
      ctx,
      halfW + 16,
      20,
      rightPage?.name || `Trang ${rightIndex + 1}`,
      true,
      this.remoteActiveSessions && this.remoteActiveSessions.size > 0
    );

    // Đường kẻ phân chia 2 bảng sắc nét hiện đại
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(halfW, 0);
    ctx.lineTo(halfW, h);
    ctx.stroke();
    ctx.restore();
  }

  _renderGridMode() {
    const total = Math.max(1, this.pages.length);
    const w = window.innerWidth;
    const h = window.innerHeight;
    const ctx = this.renderer.ctx;

    // Tính toán số cột và dòng tối ưu cho lưới NxM
    let cols = 1, rows = 1;
    if (total === 2) {
      cols = 2; rows = 1;
    } else if (total <= 4) {
      cols = 2; rows = 2;
    } else if (total <= 6) {
      cols = 3; rows = 2;
    } else {
      cols = Math.ceil(Math.sqrt(total));
      rows = Math.ceil(total / cols);
    }

    const cellW = Math.floor(w / cols);
    const cellH = Math.floor(h / rows);

    for (let i = 0; i < total; i++) {
      const c = i % cols;
      const r = Math.floor(i / cols);
      const vx = c * cellW;
      const vy = r * cellH;
      const vw = (c === cols - 1) ? (w - vx) : cellW;
      const vh = (r === rows - 1) ? (h - vy) : cellH;

      const page = this.pages[i];
      const pageScene = page ? this.getPageScene(page) : this.scene;
      const isActive = (i === this.currentPageIndex);

      const cellCam = isActive ? this.camera : new Camera(0, 0, 1.0, vw, vh);
      if (!isActive) {
        this.fitSceneInViewport(pageScene, cellCam, vw, vh, 40);
      }

      const sessions = isActive ? this.remoteActiveSessions : null;

      this.renderer.render(
        pageScene,
        cellCam,
        null,
        null,
        null,
        null,
        null,
        sessions,
        { viewport: { x: vx, y: vy, width: vw, height: vh }, isDisplayMode: true }
      );

      // Khung viền phân cách từng ô
      ctx.save();
      ctx.strokeStyle = isActive ? 'rgba(88, 166, 255, 0.8)' : 'rgba(255, 255, 255, 0.12)';
      ctx.lineWidth = isActive ? 3 : 1;
      ctx.setLineDash(isActive ? [] : [4, 4]);
      ctx.strokeRect(vx + 1, vy + 1, vw - 2, vh - 2);
      ctx.restore();

      this.drawViewportBadge(
        ctx,
        vx + 12,
        vy + 16,
        page?.name || `Trang ${i + 1}`,
        isActive,
        isActive && sessions && sessions.size > 0
      );
    }
  }

  getPageScene(page) {
    if (!page) return this.scene;
    if (page._sceneInstance && page._lastSceneJSON === page.scene) {
      return page._sceneInstance;
    }
    const scene = new SceneGraph();
    if (page.scene) {
      scene.loadFromJSON(page.scene);
      if (page.theme) scene.root.style = page.theme;
      if (page.gridType) scene.root.gridType = page.gridType;
    }
    page._sceneInstance = scene;
    page._lastSceneJSON = page.scene;
    return scene;
  }

  fitSceneInViewport(scene, camera, vw, vh, padding = 40) {
    const bounds = this.getSceneBoundsFor(scene);
    if (!bounds) {
      camera.zoom = 1.0;
      camera.pan = new Vec2(0, 0);
      return;
    }
    const availW = Math.max(100, vw - padding * 2);
    const availH = Math.max(100, vh - padding * 2);
    const zoomW = availW / bounds.width;
    const zoomH = availH / bounds.height;
    camera.zoom = Math.max(0.05, Math.min(2.5, Math.min(zoomW, zoomH)));
    camera.pan = new Vec2(bounds.centerX, bounds.centerY);
  }

  getSceneBoundsFor(scene) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let count = 0;
    if (Array.isArray(scene.root.children)) {
      for (const b of scene.root.children) {
        count++;
        const tx = b.transform?.tx || 0;
        const ty = b.transform?.ty || 0;
        const w = b.width || 800;
        const h = b.height || 600;
        minX = Math.min(minX, tx);
        minY = Math.min(minY, ty);
        maxX = Math.max(maxX, tx + w);
        maxY = Math.max(maxY, ty + h);
      }
    }
    if (Array.isArray(scene.root.elements)) {
      for (const el of scene.root.elements) {
        if (Array.isArray(el.points) && el.points.length > 0) {
          count++;
          for (const p of el.points) {
            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
          }
        }
      }
    }
    if (count === 0 || !isFinite(minX) || !isFinite(maxX)) return null;
    return {
      minX,
      minY,
      maxX,
      maxY,
      width: Math.max(10, maxX - minX),
      height: Math.max(10, maxY - minY),
      centerX: (minX + maxX) * 0.5,
      centerY: (minY + maxY) * 0.5,
    };
  }

  drawViewportBadge(ctx, x, y, title, isActive, isWriting = false) {
    ctx.save();
    ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    const textMetrics = ctx.measureText(title);
    const badgeW = textMetrics.width + (isWriting ? 34 : 20);
    const badgeH = 24;

    // Badge Background
    ctx.fillStyle = isActive ? 'rgba(15, 23, 42, 0.85)' : 'rgba(15, 23, 42, 0.65)';
    ctx.strokeStyle = isActive ? '#58a6ff' : 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, badgeW, badgeH, 6) : ctx.rect(x, y, badgeW, badgeH);
    ctx.fill();
    ctx.stroke();

    // Text & Dot
    ctx.fillStyle = isActive ? '#ffffff' : 'rgba(255, 255, 255, 0.7)';
    ctx.fillText(title, x + 10, y + 16);

    if (isWriting) {
      ctx.fillStyle = '#3fb950';
      ctx.beginPath();
      ctx.arc(x + badgeW - 12, y + 12, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  initDisplayHUD() {
    if (!this.hudElement) return;

    const btnSingle = document.getElementById('hud-mode-single');
    const btnDual = document.getElementById('hud-mode-dual');
    const btnGrid = document.getElementById('hud-mode-grid');
    const btnFs = document.getElementById('hud-btn-fullscreen');

    if (btnSingle) {
      btnSingle.addEventListener('click', () => this.setDisplayMode('single', true));
    }
    if (btnDual) {
      btnDual.addEventListener('click', () => this.setDisplayMode('dual', true));
    }
    if (btnGrid) {
      btnGrid.addEventListener('click', () => this.setDisplayMode('grid', true));
    }
    if (btnFs) {
      btnFs.addEventListener('click', () => this.toggleFullscreen());
    }

    // Auto-hide HUD on inactivity
    const showHUD = () => {
      this.hudElement.style.opacity = '1';
      this.hudElement.style.pointerEvents = 'auto';
      document.body.classList.remove('hide-cursor');
      if (this.hudTimer) clearTimeout(this.hudTimer);
      this.hudTimer = setTimeout(() => {
        this.hudElement.style.opacity = '0';
        this.hudElement.style.pointerEvents = 'none';
        document.body.classList.add('hide-cursor');
      }, 3000);
    };

    window.addEventListener('mousemove', showHUD);
    window.addEventListener('touchstart', showHUD);
    showHUD();
  }

  setDisplayMode(mode, broadcast = false) {
    if (!['single', 'dual', 'grid'].includes(mode)) return;
    this.displayMode = mode;

    // Cập nhật trạng thái active trên HUD buttons
    const btnSingle = document.getElementById('hud-mode-single');
    const btnDual = document.getElementById('hud-mode-dual');
    const btnGrid = document.getElementById('hud-mode-grid');
    if (btnSingle) btnSingle.classList.toggle('active', mode === 'single');
    if (btnDual) btnDual.classList.toggle('active', mode === 'dual');
    if (btnGrid) btnGrid.classList.toggle('active', mode === 'grid');

    console.log(`[PC Display] 🖥️ Display mode switched to: ${mode}`);
    this.saveDisplayState();
    this.requestRender();

    if (broadcast && this.syncClient && this.syncClient.isConnected) {
      this.syncClient.send('DISPLAY_MODE_SET', { mode });
    }
  }

  dismissStandbyBanner() {
    this.updateOverlayVisibility();
  }

  updateConnectionInfo() {
    this.updateConnectionUI(this.syncClient?.isConnected);
  }

  saveDisplayState() {
    if (this._saveStateTimer) clearTimeout(this._saveStateTimer);
    this._saveStateTimer = setTimeout(() => {
      this._saveStateTimer = null;
      try {
        if (!this.hasSceneData) return;
        const data = {
          scene: this.scene.toJSON(),
          theme: this.scene.root.style,
          gridType: this.scene.root.gridType,
          camera: {
            zoom: this.camera.zoom,
            pan: { x: this.camera.pan.x, y: this.camera.pan.y },
          },
          pages: this.pages,
          currentPageIndex: this.currentPageIndex,
          displayMode: this.displayMode,
          savedAt: Date.now(),
        };
        localStorage.setItem('nestedcanvas_display_mirror_state', JSON.stringify(data));
      } catch (e) {}
    }, 1000);
  }

  clearDisplayState() {
    try {
      localStorage.removeItem('nestedcanvas_display_mirror_state');
    } catch (e) {}
    this.scene = new SceneGraph();
    this.pages = [];
    this.currentPageIndex = 0;
    this.hasSceneData = false;
    this.camera = new Camera(0, 0, 1.0, window.innerWidth, window.innerHeight);
    this.updateOverlayVisibility();
    this.requestRender();
    console.log('[PC Display] 🧹 Display state cleared, returning to standby overlay.');
  }

  loadDisplayState() {
    try {
      const raw = localStorage.getItem('nestedcanvas_display_mirror_state');
      if (!raw) {
        this.updateOverlayVisibility();
        return false;
      }
      const data = JSON.parse(raw);
      if (Array.isArray(data.pages)) {
        this.pages = data.pages;
      }
      if (typeof data.currentPageIndex === 'number') {
        this.currentPageIndex = data.currentPageIndex;
      }
      if (data.displayMode) {
        this.setDisplayMode(data.displayMode, false);
      }
      if (data.scene) {
        this.scene.loadFromJSON(data.scene);
        if (data.theme) this.scene.root.style = data.theme;
        if (data.gridType) this.scene.root.gridType = data.gridType;
        this.hasSceneData = this.hasMeaningfulContent();
        if (data.camera) {
          if (typeof data.camera.zoom === 'number' && data.camera.zoom > 0) {
            this.camera.zoom = data.camera.zoom;
          }
          if (data.camera.pan && typeof data.camera.pan.x === 'number') {
            this.camera.pan = new Vec2(data.camera.pan.x, data.camera.pan.y);
          }
        }
        this.updateOverlayVisibility();
        return true;
      }
    } catch (e) {
      console.warn('[PC Display] Error loading local display state:', e);
    }
    this.updateOverlayVisibility();
    return false;
  }

  hasMeaningfulContent() {
    const hasChildren = Array.isArray(this.scene.root.children) && this.scene.root.children.length > 0;
    const hasElements = Array.isArray(this.scene.root.elements) && this.scene.root.elements.length > 0;
    const hasImages = (Array.isArray(this.scene.root.images) && this.scene.root.images.length > 0) ||
      (hasChildren && this.scene.root.children.some(c => c.image || (Array.isArray(c.images) && c.images.length > 0)));
    const hasChildElements = hasChildren && this.scene.root.children.some(c => (Array.isArray(c.elements) && c.elements.length > 0) || (Array.isArray(c.children) && c.children.length > 0));
    const hasLiveSession = this.remoteActiveSessions && this.remoteActiveSessions.size > 0;
    return hasChildren || hasElements || hasChildElements || hasImages || hasLiveSession;
  }

  hideIdleOverlay() {
    if (this.idleOverlay) {
      this.idleOverlay.classList.add('hidden');
      this.idleOverlay.style.display = 'none';
      if (this.statusPill) {
        this.statusPill.style.opacity = '0.35';
      }
    }
  }

  showIdleOverlay() {
    if (this.idleOverlay) {
      this.idleOverlay.classList.remove('hidden');
      this.idleOverlay.style.display = 'flex';
      if (this.statusPill) {
        this.statusPill.style.opacity = '0.9';
      }
    }
  }

  updateOverlayVisibility() {
    if (!this.idleOverlay) return;
    if (this.hasSceneData || this.hasMeaningfulContent() || (this.syncClient && this.syncClient.presenceCount > 1)) {
      this.hideIdleOverlay();
    } else {
      this.showIdleOverlay();
    }
  }

  updateConnectionUI(isConnected, ip = null) {
    const serverHost = ip || this.syncClient?.getHost() || 'localhost';
    if (isConnected) {
      if (this.idleStatusDot) {
        this.idleStatusDot.style.background = '#3fb950';
        this.idleStatusDot.style.boxShadow = '0 0 12px #3fb950';
      }
      if (this.idleStatusText) {
        this.idleStatusText.textContent = `🟢 Đã kết nối LAN (${serverHost}:8765) • Sẵn sàng nhận bài`;
      }
      if (this.pillDot) {
        this.pillDot.style.background = '#3fb950';
        this.pillDot.style.boxShadow = '0 0 6px #3fb950';
      }
      if (this.pillText) {
        this.pillText.textContent = `Đã kết nối • ${serverHost}`;
      }
    } else {
      if (this.idleStatusDot) {
        this.idleStatusDot.style.background = '#f85149';
        this.idleStatusDot.style.boxShadow = '0 0 12px #f85149';
      }
      if (this.idleStatusText) {
        this.idleStatusText.textContent = `🔴 Đang kết nối máy chủ LAN (${serverHost}:8765)...`;
      }
      if (this.pillDot) {
        this.pillDot.style.background = '#f85149';
        this.pillDot.style.boxShadow = '0 0 6px #f85149';
      }
      if (this.pillText) {
        this.pillText.textContent = `Mất kết nối LAN (${serverHost})`;
      }
    }
  }

  getSceneBounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let count = 0;

    // 1. Quét các bảng con (children) và nét vẽ bên trong bảng con
    if (Array.isArray(this.scene.root.children)) {
      for (const b of this.scene.root.children) {
        count++;
        const tx = b.transform?.tx || 0;
        const ty = b.transform?.ty || 0;
        const w = b.width || 800;
        const h = b.height || 600;
        minX = Math.min(minX, tx);
        minY = Math.min(minY, ty);
        maxX = Math.max(maxX, tx + w);
        maxY = Math.max(maxY, ty + h);

        if (Array.isArray(b.elements)) {
          for (const el of b.elements) {
            if (Array.isArray(el.points) && el.points.length > 0) {
              for (const p of el.points) {
                minX = Math.min(minX, tx + p.x);
                minY = Math.min(minY, ty + p.y);
                maxX = Math.max(maxX, tx + p.x);
                maxY = Math.max(maxY, ty + p.y);
              }
            }
          }
        }
      }
    }

    // 2. Quét các nét vẽ trên root (elements)
    if (Array.isArray(this.scene.root.elements)) {
      for (const el of this.scene.root.elements) {
        if (Array.isArray(el.points) && el.points.length > 0) {
          count++;
          for (const p of el.points) {
            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
          }
        }
      }
    }

    // 3. Quét các ảnh trên root (images)
    if (Array.isArray(this.scene.root.images)) {
      for (const img of this.scene.root.images) {
        if (img) {
          count++;
          minX = Math.min(minX, img.x);
          minY = Math.min(minY, img.y);
          maxX = Math.max(maxX, img.x + (img.width || 200));
          maxY = Math.max(maxY, img.y + (img.height || 200));
        }
      }
    }

    if (count === 0 || !isFinite(minX) || !isFinite(maxX)) return null;
    return {
      minX,
      minY,
      maxX,
      maxY,
      width: Math.max(10, maxX - minX),
      height: Math.max(10, maxY - minY),
      centerX: (minX + maxX) * 0.5,
      centerY: (minY + maxY) * 0.5,
    };
  }

  fitSceneContent() {
    const bounds = this.getSceneBounds();
    if (!bounds) return;

    const padding = 80;
    const availW = Math.max(300, window.innerWidth - padding * 2);
    const availH = Math.max(200, window.innerHeight - padding * 2);

    const zoomW = availW / bounds.width;
    const zoomH = availH / bounds.height;
    const targetZoom = Math.max(0.1, Math.min(2.5, Math.min(zoomW, zoomH)));

    this.camera.zoom = targetZoom;
    this.camera.pan = new Vec2(bounds.centerX, bounds.centerY);
    console.log(`[PC Display] 🎯 Auto-fitted content to screen: zoom=${targetZoom.toFixed(2)}, center=(${bounds.centerX.toFixed(0)}, ${bounds.centerY.toFixed(0)})`);
  }

  initSync() {
    this.syncClient = new SyncClient({
      onConnect: () => {
        this.updateConnectionUI(true);
      },
      onStatus: (status) => {
        this.updateConnectionUI(status === 'connected');
      },
    });

    // Nhận thông tin ban đầu khi kết nối
    this.syncClient.on('WELCOME', (data) => {
      this.updateConnectionUI(true, data.local_ip);

      // Phát hiện server restart qua generation ID
      if (data.server_gen && data.server_gen !== this._lastServerGen) {
        if (this._lastServerGen) {
          console.log('[PC Display] 🔄 Server restarted (new gen). Clearing stale cache.');
          // Xóa localStorage cũ để không hiện nội dung stale
          try { localStorage.removeItem('nestedcanvas_display_mirror_state'); } catch (e) {}
          this.scene = new (this.scene.constructor)();
          this.hasSceneData = false;
        }
        this._lastServerGen = data.server_gen;
      }

      console.log('[PC Display] 🟢 Connected to Sync Server. Restoring canvas mirror...');

      if (data.count > 1) {
        this.hasSceneData = true;
        this.hideIdleOverlay();
      }

      if (data.last_display_mode) {
        this.setDisplayMode(data.last_display_mode, false);
      }
      if (Array.isArray(data.last_canvas_pages)) {
        this.pages = data.last_canvas_pages;
      }
      if (typeof data.last_canvas_page_index === 'number') {
        this.currentPageIndex = data.last_canvas_page_index;
      }

      // Ưu tiên active_session_content nếu có (phiên làm việc thực tế hiện hành)
      if (data.active_session_content && data.active_session_content.scene) {
        this.applyCanvasMirror(
          data.active_session_content.scene,
          data.active_session_content.camera || data.last_canvas_camera,
          data.active_session_content.theme || { theme: data.active_session_content.scene?.root?.style, gridType: data.active_session_content.scene?.root?.gridType },
          data.active_session_content.pages || data.last_canvas_pages,
          typeof data.active_session_content.currentPageIndex === 'number' ? data.active_session_content.currentPageIndex : data.last_canvas_page_index
        );
      } else if (data.last_canvas_scene) {
        this.applyCanvasMirror(
          data.last_canvas_scene,
          data.last_canvas_camera,
          null,
          data.last_canvas_pages,
          data.last_canvas_page_index
        );
      } else if (data.current_cast_board_id && data.current_cast_board_id !== 'canvas' && data.current_cast_board_node) {
        this.applyCastSingleBoard(data.current_cast_board_node);
      } else if (data.current_cast_board_node) {
        this.applyCastSingleBoard(data.current_cast_board_node);
      }

      // Lấy bản chiếu Canvas mới nhất từ sync server
      this.syncClient.send('GET_CANVAS_MIRROR', {});
    });

    // Lắng nghe sự hiện diện của các thiết bị khác trên mạng LAN
    this.syncClient.on('PRESENCE', (data) => {
      if (data && data.count > 1) {
        console.log(`[PC Display] 📱 Device connected online (total: ${data.count}). Hiding standby overlay.`);
        this.hasSceneData = true;
        this.hideIdleOverlay();
        this.requestRender();
      }
    });

    // Nhận toàn cảnh Canvas (Full Scene & Camera & Theme & Pages & DisplayMode)
    this.syncClient.on('CANVAS_MIRROR', (data) => {
      if (data && data.scene) {
        console.log('[PC Display] 📥 Received CANVAS_MIRROR update');
        this.applyCanvasMirror(
          data.scene,
          data.camera,
          { theme: data.theme, gridType: data.gridType },
          data.pages,
          data.currentPageIndex
        );
        if (data.displayMode) {
          this.setDisplayMode(data.displayMode, false);
        }
      }
    });

    // Fast-path Page Switch Protocol (Instant Relay <15ms)
    this.syncClient.on('PAGE_SWITCH', (data) => {
      if (!data) return;
      console.log(`[PC Display] ⚡ Instant PAGE_SWITCH to page index ${data.currentPageIndex}`);
      if (Array.isArray(data.pages)) {
        this.pages = data.pages;
      }
      if (typeof data.currentPageIndex === 'number') {
        this.currentPageIndex = data.currentPageIndex;
      }
      if (data.scene) {
        this.scene.loadFromJSON(data.scene);
        const theme = data.theme || data.scene.root?.style || 'chalkboard';
        const grid = data.gridType || data.scene.root?.gridType || 'grid';
        this.scene.root.style = theme;
        this.scene.root.gridType = grid;
      }
      if (data.camera) {
        if (typeof data.camera.zoom === 'number') {
          this.camera.zoom = data.camera.zoom;
          this.targetZoom = data.camera.zoom;
        }
        if (data.camera.pan) {
          this.camera.pan = new Vec2(data.camera.pan.x, data.camera.pan.y);
          this.targetPan = new Vec2(data.camera.pan.x, data.camera.pan.y);
        }
      }
      if (data.displayMode) {
        this.setDisplayMode(data.displayMode, false);
      }
      this.hasSceneData = true;
      this.hideIdleOverlay();
      this.saveDisplayState();
      this.requestRender();
    });

    // Display Layout / Multi-Board Mode Selection Protocol
    this.syncClient.on('DISPLAY_MODE_SET', (data) => {
      if (data && data.mode) {
        this.setDisplayMode(data.mode, false);
      }
    });

    // Nhận cập nhật phiên làm việc từ xa (Chỉ áp dụng khi khởi tạo hoặc chuyển phiên thực sự)
    this.syncClient.on('SESSION_UPDATE', (data) => {
      if (data && data.content && data.content.scene) {
        const isNewSession = data.sessionId && data.sessionId !== this._currentSessionId;
        if (!this.hasSceneData || isNewSession) {
          console.log('[PC Display] 📥 Applying SESSION_UPDATE (initial / session switch)');
          this._currentSessionId = data.sessionId;
          this.applyCanvasMirror(data.content.scene, data.content.camera);
        }
      }
    });

    // Nhận góc nhìn camera theo thời gian thực (Camera Zoom & Pan)
    this.syncClient.on('CANVAS_CAMERA_SYNC', (data) => {
      this.applyCameraSync(data);
    });

    // Nhận nét vẽ đang vẽ dở thời gian thực (Live in-flight stroke <15ms)
    this.syncClient.on('CANVAS_STROKE_LIVE', (data) => {
      this.applyStrokeLive(data);
    });

    // Nhận nét vẽ hoàn thành
    this.syncClient.on('CANVAS_STROKE_ADD', (data) => {
      this.applyStrokeAdd(data);
    });

    // Nhận xóa nét vẽ
    this.syncClient.on('CANVAS_STROKE_ERASE', (data) => {
      this.applyStrokeErase(data);
    });

    // Nhận thay đổi màu sắc & lưới nền bảng ngay lập tức
    this.syncClient.on('CANVAS_STYLE', (data) => {
      this.applyCanvasStyle(data);
    });
    this.syncClient.on('NODE_STYLE', (data) => {
      this.applyCanvasStyle(data);
    });

    // Nhận các thao tác cấu trúc bảng (thêm, di chuyển, xóa, dọn bảng)
    this.syncClient.on('NODE_CREATE', (data) => {
      const { parentId, node: nodeData } = data;
      if (!nodeData) return;
      const parentNode = (parentId ? this.scene.getNode(parentId) : null) || this.scene.root;
      if (!parentNode) return;
      if (this.scene.getNode(nodeData.id)) return;
      const newNode = CanvasNode.fromJSON(nodeData);
      parentNode.addChild(newNode);
      this.dismissStandbyBanner();
      this.updateConnectionInfo();
      this.requestRender();
    });

    this.syncClient.on('NODE_TRANSFORM', (data) => {
      const targetId = data.nodeId || data.boardId;
      if (!targetId || targetId === this.scene.root.id) return;
      const node = this.scene.getNode(targetId);
      if (node) {
        if (typeof data.x === 'number') node.transform.tx = data.x;
        if (typeof data.y === 'number') node.transform.ty = data.y;
        if (typeof data.w === 'number') node.width = data.w;
        if (typeof data.h === 'number') node.height = data.h;
        this.requestRender();
      }
    });

    this.syncClient.on('NODE_DELETE', (data) => {
      const { nodeId } = data;
      if (!nodeId) return;
      const parentNode = this.scene.findParentNode(nodeId);
      if (parentNode) {
        parentNode.removeChild(nodeId);
      } else {
        this.scene.root.removeChild(nodeId);
      }
      this.requestRender();
    });

    this.syncClient.on('NODE_CLEAR', (data) => {
      const target = (data.nodeId ? this.scene.getNode(data.nodeId) : null) || this.scene.root;
      if (target) {
        target.elements = [];
        target.images = [];
        this.requestRender();
      }
    });

    // Nhận lệnh dọn màn chiếu / xóa bảng
    this.syncClient.on('CANVAS_CLEAR', () => {
      console.log('[PC Display] 🧹 Received CANVAS_CLEAR from server');
      this.clearDisplayState();
    });

    // Nhận thông báo chuyển phiên từ thiết bị điều khiển
    this.syncClient.on('SESSION_SWITCH', (data) => {
      console.log('[PC Display] 🔄 Session switched, requesting canvas mirror...');
      this.syncClient.send('GET_CANVAS_MIRROR', {});
    });

    // Tương thích ngược: Khi có thiết bị gửi lệnh CAST_BOARD
    this.syncClient.on('CAST_BOARD', (data) => {
      if (data && data.scene) {
        this.applyCanvasMirror(data.scene, data.camera);
      } else if (data && data.node) {
        this.applyCastSingleBoard(data.node);
      }
    });

    this.syncClient.connect();
  }

  applyCastSingleBoard(nodeData) {
    let node = CanvasNode.fromJSON(nodeData);
    if (!node) return;
    const existing = this.scene.getNode(node.id);
    if (existing) {
      existing.elements = node.elements;
      existing.width = node.width;
      existing.height = node.height;
      existing.transform = node.transform;
      existing.style = node.style;
      existing.gridType = node.gridType;
      existing.image = node.image;
      existing.images = node.images;
      existing.textContent = node.textContent;
      existing.graphData = node.graphData;
    } else {
      this.scene.root.children.push(node);
    }
    this.hasSceneData = true;
    this.fitSceneContent();
    this.hideIdleOverlay();
    this.saveDisplayState();
    this.requestRender();
  }

  applyCanvasMirror(sceneData, cameraData, themeData = null, pagesData = null, pageIndex = null) {
    if (!sceneData) return;
    this.scene.loadFromJSON(sceneData);

    // Cập nhật danh sách trang nếu có
    if (Array.isArray(pagesData)) {
      this.pages = pagesData;
    }
    if (typeof pageIndex === 'number') {
      this.currentPageIndex = pageIndex;
    }

    // Đồng bộ triệt để theme & grid từ dữ liệu nhận được
    const theme = (themeData && themeData.theme) || (themeData && themeData.style) || (sceneData.root && sceneData.root.style) || 'chalkboard';
    const grid = (themeData && themeData.gridType) || (sceneData.root && sceneData.root.gridType) || 'grid';
    this.scene.root.style = theme;
    this.scene.root.gridType = grid;

    this.hasSceneData = true;

    if (cameraData) {
      if (typeof cameraData.zoom === 'number') {
        this.camera.zoom = cameraData.zoom;
        this.targetZoom = cameraData.zoom;
      }
      if (cameraData.pan) {
        this.camera.pan = new Vec2(cameraData.pan.x, cameraData.pan.y);
        this.targetPan = new Vec2(cameraData.pan.x, cameraData.pan.y);
      }
    } else {
      this.fitSceneContent();
    }

    this.hideIdleOverlay();
    this.saveDisplayState();
    this.requestRender();
  }

  applyCameraSync(data) {
    if (!data) return;
    const { zoom, pan } = data;
    if (typeof zoom !== 'number' || !pan) return;

    this.targetZoom = zoom;
    this.targetPan = new Vec2(pan.x, pan.y);

    this.hasSceneData = true;
    this.hideIdleOverlay();
    this.scheduleRender();
  }

  applyStrokeLive(data) {
    const { clientId, session } = data;
    if (!clientId) return;
    if (!session || !session.points || session.points.length === 0) {
      this.remoteActiveSessions.delete(clientId);
    } else {
      if (session.isDelta && this.remoteActiveSessions.has(clientId)) {
        // Chế độ delta: nối thêm điểm mới vào session hiện có thay vì replace
        const existing = this.remoteActiveSessions.get(clientId);
        existing.points = existing.points.concat(session.points);
        // Cập nhật metadata nếu có thay đổi
        if (session.color) existing.color = session.color;
        if (session.baseWidth) existing.baseWidth = session.baseWidth;
        if (session.brushType) existing.brushType = session.brushType;
      } else {
        // Gói đầu tiên hoặc full snapshot: set toàn bộ
        this.remoteActiveSessions.set(clientId, { ...session });
        console.log(`[PC Display] 🖊️ Live stroke streaming from client "${clientId}"`);
      }
      // Khi đang có nét vẽ dở truyền sang, lập tức ẩn màn hình chờ
      this.hasSceneData = true;
      this.hideIdleOverlay();
    }
    this.requestRender();
  }

  applyStrokeAdd(data) {
    const { nodeId, stroke, clientId, sendTime, pageIndex } = data;
    if (!stroke) return;

    // Định tuyến nét vẽ theo pageIndex nếu có và đang ở trang khác
    let targetScene = this.scene;
    if (typeof pageIndex === 'number' && this.pages[pageIndex]) {
      targetScene = this.getPageScene(this.pages[pageIndex]);
      // Cập nhật luôn json của page đó
      const pageNode = (nodeId ? targetScene.getNode(nodeId) : null) || targetScene.root;
      if (pageNode) {
        const strokeObj = Stroke.fromJSON(stroke);
        if (!Array.isArray(pageNode.elements)) pageNode.elements = [];
        if (!pageNode.elements.some((s) => s.id === strokeObj.id)) {
          pageNode.elements.push(strokeObj);
        }
        this.pages[pageIndex].scene = targetScene.toJSON();
        this.pages[pageIndex]._lastSceneJSON = this.pages[pageIndex].scene;
      }
    }

    const targetNode = (nodeId ? this.scene.getNode(nodeId) : null) || this.scene.root;
    if (targetNode) {
      const strokeObj = Stroke.fromJSON(stroke);
      if (!Array.isArray(targetNode.elements)) targetNode.elements = [];
      if (!targetNode.elements.some((s) => s.id === strokeObj.id)) {
        targetNode.elements.push(strokeObj);
      }
      this.hasSceneData = true;
      this.hideIdleOverlay();
      const delay = sendTime ? ` [Độ trễ toàn trình: ${Date.now() - sendTime}ms]` : '';
      console.log(`[PC Display] ✏️ Rendered stroke in "${targetNode.name || targetNode.id}" (${strokeObj.points?.length || 0} pts, tổng: ${targetNode.elements.length})${delay}`);
    } else {
      console.warn(`[PC Display] ⚠️ Target node "${nodeId}" not found for stroke!`);
    }
    if (clientId) {
      this.remoteActiveSessions.delete(clientId);
    }
    this.saveDisplayState();
    this.requestRender();
  }

  applyStrokeErase(data) {
    const { nodeId, removedStrokeIds } = data;
    if (!Array.isArray(removedStrokeIds)) return;
    const targetNode = (nodeId ? this.scene.getNode(nodeId) : null) || this.scene.root;
    if (targetNode && Array.isArray(targetNode.elements)) {
      const idSet = new Set(removedStrokeIds);
      const before = targetNode.elements.length;
      targetNode.elements = targetNode.elements.filter((s) => !idSet.has(s.id));
      console.log(`[PC Display] 🧹 Erased ${before - targetNode.elements.length} strokes in "${targetNode.name || targetNode.id}"`);
      this.saveDisplayState();
      this.requestRender();
    }
  }

  applyCanvasStyle(data) {
    if (!data) return;
    const { nodeId, boardId, style, gridType, isGlobal } = data;
    const targetId = nodeId || boardId;

    if (isGlobal || (!targetId && (style || gridType))) {
      if (style) this.scene.root.style = style;
      if (gridType) this.scene.root.gridType = gridType;
      const updateRecursive = (n) => {
        if (style) n.style = style;
        if (gridType) n.gridType = gridType;
        if (Array.isArray(n.children)) {
          for (const c of n.children) updateRecursive(c);
        }
      };
      if (Array.isArray(this.scene.root.children)) {
        for (const c of this.scene.root.children) updateRecursive(c);
      }
    } else if (targetId) {
      const target = this.scene.getNode(targetId);
      if (target) {
        if (style) target.style = style;
        if (gridType) target.gridType = gridType;
      }
    }
    this.hasSceneData = true;
    this.hideIdleOverlay();
    this.saveDisplayState();
    this.requestRender();
  }

  toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
    }
  }

  bindWindowEvents() {
    window.addEventListener('resize', () => {
      this.renderer.resize(window.innerWidth, window.innerHeight);
      this.camera.viewportWidth = window.innerWidth;
      this.camera.viewportHeight = window.innerHeight;
    });

    window.addEventListener('beforeunload', () => this.saveDisplayState());
    window.addEventListener('pagehide', () => this.saveDisplayState());

    // Phím tắt toàn màn hình & chuyển chế độ hiển thị
    window.addEventListener('keydown', (e) => {
      // Phím số 1, 2, 3 để đổi chế độ hiển thị bảng
      if (e.key === '1') {
        this.setDisplayMode('single', true);
      } else if (e.key === '2') {
        this.setDisplayMode('dual', true);
      } else if (e.key === '3') {
        this.setDisplayMode('grid', true);
      } else if (e.key === 'F11') {
        e.preventDefault();
        this.toggleFullscreen();
      } else if (e.key === 'Escape' && document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        this.clearDisplayState();
        if (this.syncClient && this.syncClient.isConnected) {
          this.syncClient.send('CANVAS_CLEAR', {});
        }
      }
    });
  }

  startRenderLoop() {
    // Render lần đầu để hiện nền ngay khi load
    this._renderScheduled = false;
    this.scheduleRender();
  }
}

function initDisplay() {
  if (!window.pcDisplayApp) {
    window.pcDisplayApp = new PCDisplayApp();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDisplay);
} else {
  initDisplay();
}
