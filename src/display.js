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
    this.youtubeAudioUnlocked = false;
    this.youtubePlayback = new Map();

    CanvasNode.onImageLoaded = () => {
      this.hasSceneData = this.hasMeaningfulContent();
      this.updateOverlayVisibility();
      this.scheduleRender();
    };

    this.idleOverlay = document.getElementById('idle-overlay');
    this.statusPill = document.getElementById('display-status-pill');
    this.pillDot = document.getElementById('display-pill-dot');
    this.pillText = document.getElementById('display-pill-text');
    this.pillPage = document.getElementById('display-pill-page');
    this.toastElement = document.getElementById('display-page-toast');
    this.toastText = document.getElementById('display-toast-text');
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
    this._toastTimer = null;

    // Multi-Page & Multi-Board Display Mode State
    this.pages = [];
    this.currentPageIndex = 0;
    this.displayMode = 'single'; // 'single', 'dual', 'grid'
    this.displaySelection = { mode: 'follow', pageIds: [] };

    console.log('[PC Display] 🚀 Starting Fullscreen PC Display App...');

    // Đảm bảo kích thước renderer khớp 100% với cửa sổ
    this.renderer.resize(window.innerWidth, window.innerHeight);

    // Tải dữ liệu canvas đã lưu từ phiên trước
    this.loadDisplayState();

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

    this.youtubeViews = [];
    if (this.displaySelection?.mode === 'fixed') {
      const limit = this.displayMode === 'single' ? 1 : this.displayMode === 'dual' ? 2 : this.displayMode === 'quad' ? 4 : Infinity;
      let indices;
      if (this.displayMode === 'quad') {
        indices = [0, 1, 2, 3].map(slot => {
          const id = this.displaySelection.pageIds[slot];
          if (!id) return this.pages.length + slot;
          const idx = this.pages.findIndex(p => p.id === id);
          return idx >= 0 ? idx : (this.pages.length + slot);
        });
      } else {
        indices = this.displaySelection.pageIds
          .map(id => this.pages.findIndex(page => page.id === id))
          .filter(index => index >= 0).slice(0, limit);
      }
      this.renderPageTiles(indices, this.displayMode === 'dual' || this.displayMode === 'quad' ? 2 : null);
    } else if (this.displayMode === 'single') {
      this.youtubeViews.push({ scene: this.scene, camera: this.camera, viewport: {
        x: 0, y: 0, width: window.innerWidth, height: window.innerHeight,
      } });
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
      // Hiển thị badge số trang tinh tế ở chế độ 1 Bảng khi có từ 2 trang trở lên
      if (this.pages && this.pages.length > 1) {
        const curName = this.pages[this.currentPageIndex]?.name || `Trang ${this.currentPageIndex + 1}`;
        this.drawViewportBadge(
          this.renderer.ctx,
          20,
          24,
          `${curName} (${this.currentPageIndex + 1}/${this.pages.length})`,
          true,
          this.remoteActiveSessions && this.remoteActiveSessions.size > 0
        );
      }
    } else if (this.displayMode === 'dual') {
      this._renderDualMode();
    } else if (this.displayMode === 'quad') {
      this._renderQuadMode();
    } else if (this.displayMode === 'grid') {
      this._renderGridMode();
    }

    this.updateYoutubeOverlays();

    // Tiếp tục nếu camera vẫn đang lerp
    if (this._isCameraLerping()) {
      this.scheduleRender();
    }
  }

  updateYoutubeOverlays() {
    const host = document.getElementById('display-video-overlays');
    if (!host) return;
    const liveIds = new Set();
    // Use the exact scenes, cameras and viewports drawn on the canvas, including
    // inactive pages and fixed selections. Navigation must not hide their players.
    for (const { scene, camera, viewport } of this.youtubeViews || []) {
      const nodes = (scene.root.children || []).filter(node => node.youtubeData?.videoId);
      const project = point => {
        const local = camera.worldToScreen(point);
        return new Vec2(local.x + viewport.x, local.y + viewport.y);
      };
      for (const node of nodes) {
        const p0 = project(node.transform.transformPoint(new Vec2(0, 0)));
        const p1 = project(node.transform.transformPoint(new Vec2(node.width, node.height)));
        const left = Math.min(p0.x, p1.x), top = Math.min(p0.y, p1.y);
        const width = Math.abs(p1.x - p0.x), height = Math.abs(p1.y - p0.y);
        if (width < 12 || height < 12 || left >= viewport.x + viewport.width || top >= viewport.y + viewport.height || left + width <= viewport.x || top + height <= viewport.y) continue;
        liveIds.add(node.id);
        let iframe = host.querySelector(`[data-node-id="${node.id}"]`);
        if (!iframe) {
          iframe = document.createElement('iframe');
          iframe.dataset.nodeId = node.id;
          iframe.src = `https://www.youtube.com/embed/${node.youtubeData.videoId}?rel=0&enablejsapi=1&playsinline=1&origin=${encodeURIComponent(window.location.origin)}`;
          iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
          iframe.allowFullscreen = true;
          host.appendChild(iframe);
        }
        iframe.style.left = `${left}px`; iframe.style.top = `${top}px`;
        iframe.style.width = `${width}px`; iframe.style.height = `${height}px`;
        iframe.style.display = 'block';
        iframe.style.clipPath = `inset(${Math.max(0, viewport.y - top)}px ${Math.max(0, left + width - viewport.x - viewport.width)}px ${Math.max(0, top + height - viewport.y - viewport.height)}px ${Math.max(0, viewport.x - left)}px)`;
      }
    }
    // Không hủy player khi đổi trang/chế độ: giữ iframe để video không bị reset.
    // Chỉ xóa khi node YouTube thực sự không còn trong toàn bộ scene/pages.
    const allYoutubeIds = new Set();
    const collectYoutubeIds = (value) => {
      if (!value) return;
      const children = value.root?.children || value.children || [];
      for (const child of children) {
        if (child.youtubeData?.videoId) allYoutubeIds.add(child.id);
        collectYoutubeIds(child);
      }
    };
    collectYoutubeIds(this.scene);
    for (const page of this.pages || []) collectYoutubeIds(page.scene);
    host.querySelectorAll('iframe').forEach(frame => {
      if (liveIds.has(frame.dataset.nodeId)) {
        frame.style.visibility = 'visible';
      } else if (allYoutubeIds.has(frame.dataset.nodeId)) {
        frame.style.visibility = 'hidden';
      } else {
        frame.remove();
      }
    });
  }

  controlYoutube(data) {
    if (!data?.nodeId || !data.action) return;
    const iframe = document.querySelector(`#display-video-overlays iframe[data-node-id="${data.nodeId}"]`);
    if (!iframe || !iframe.contentWindow) return;
    if (data.action === 'play' && !this.youtubeAudioUnlocked) {
      // Cho video chạy ngay cả khi autoplay audio bị trình duyệt chặn.
      // Âm thanh được điều khiển bằng nút Unmute trên app.
      iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'mute', args: [] }), '*');
      iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'playVideo', args: [] }), '*');
      return;
    }
    const state = this.youtubePlayback.get(data.nodeId) || { time: 0, playing: false, startedAt: 0 };
    const now = performance.now();
    if (state.playing) state.time += (now - state.startedAt) / 1000;
    state.startedAt = now;
    let command = 'pauseVideo';
    let args = [];
    if (data.action === 'play') {
      command = 'playVideo'; state.playing = true;
    } else if (data.action === 'pause') {
      command = 'pauseVideo'; state.playing = false;
    } else if (data.action === 'stop') {
      command = 'stopVideo'; state.playing = false; state.time = 0;
    } else if (data.action === 'unmute') {
      this.youtubeAudioUnlocked = true;
      iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'unMute', args: [] }), '*');
      iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'setVolume', args: [100] }), '*');
      this.youtubePlayback.set(data.nodeId, state);
      return;
    } else if (data.action === 'restart') {
      command = 'seekTo'; args = [0, true]; state.time = 0; state.playing = true;
    } else if (data.action === 'backward' || data.action === 'forward') {
      const delta = data.action === 'backward' ? -10 : 10;
      state.time = Math.max(0, state.time + delta);
      command = 'seekTo'; args = [state.time, true];
    }
    this.youtubePlayback.set(data.nodeId, state);
    iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func: command, args }), '*');
  }

  _renderDualMode() {
    const first = Math.max(0, this.currentPageIndex - 1);
    this.renderPageTiles([first, first + 1], 2);
  }

  _renderQuadMode() {
    const total = this.pages.length;
    let indices;
    if (total <= 4) {
      // Phương án 1: Luôn giữ khung 4 ô cố định (2x2). Các trang chưa có sẽ thành ô chờ
      indices = [0, 1, 2, 3];
    } else {
      const start = Math.max(0, Math.min(this.currentPageIndex - 1, total - 4));
      indices = [start, start + 1, start + 2, start + 3];
    }
    this.renderPageTiles(indices, 2);
  }

  _renderGridMode() {
    const total = Math.max(1, this.pages.length);
    this.renderPageTiles(Array.from({ length: total }, (_, i) => i));
  }

  renderPageTiles(indices, fixedColumns = null) {
    this.youtubeViews = [];
    const w = window.innerWidth;
    const h = window.innerHeight;
    const ctx = this.renderer.ctx;
    const dpr = window.devicePixelRatio || 1;
    const gap = 4;
    const margin = 3;
    const header = 28;
    const aspect = 16 / 9;

    // Fill every row; aspect ratio only guides the number of columns.
    const layoutFor = (cols) => {
      const rows = Math.ceil(indices.length / cols);
      const availableW = Math.max(1, (w - margin * 2 - gap * (cols - 1)) / cols);
      const availableH = Math.max(1, (h - margin * 2 - gap * (rows - 1)) / rows - header);
      return { cols, rows, width: availableW, height: availableH + header };
    };
    let layout = layoutFor(fixedColumns || 1);
    if (!fixedColumns) {
      for (let cols = 2; cols <= indices.length; cols++) {
        const candidate = layoutFor(cols);
        const score = item => Math.abs(Math.log((item.width / Math.max(1, item.height - header)) / aspect));
        if (score(candidate) < score(layout)) layout = candidate;
      }
    }

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#090d13';
    ctx.fillRect(0, 0, w, h);
    if (!indices.length) {
      ctx.fillStyle = '#aab8c8';
      ctx.font = '16px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Chưa chọn trang để chiếu', w / 2, h / 2);
    }
    ctx.restore();
    if (!indices.length) return;

    const top = (h - (layout.height * layout.rows + gap * (layout.rows - 1))) / 2;
    for (let slot = 0; slot < indices.length; slot++) {
      const index = indices[slot];
      const row = Math.floor(slot / layout.cols);
      const col = slot % layout.cols;
      const rowCount = Math.min(layout.cols, indices.length - row * layout.cols);
      layout.width = (w - margin * 2 - gap * (rowCount - 1)) / rowCount;
      const left = margin;
      const x = left + col * (layout.width + gap);
      const y = top + row * (layout.height + gap);
      const page = this.pages[index];
      const active = index === this.currentPageIndex;
      const pageScene = active ? this.scene : (page ? this.getPageScene(page) : new SceneGraph());
      const viewport = {
        x: x + 2, y: y + header,
        width: Math.max(1, layout.width - 4),
        height: Math.max(1, layout.height - header - 2),
      };
      const camera = new Camera(0, 0, 1, viewport.width, viewport.height);
      if (active) {
        camera.pan = this.camera.pan.clone();
        camera.zoom = this.camera.zoom * Math.min(viewport.width / w, viewport.height / h);
      } else {
        this.fitSceneInViewport(pageScene, camera, viewport.width, viewport.height, 24);
      }

      this.youtubeViews.push({ scene: pageScene, camera, viewport });
      this.renderer.render(
        pageScene, camera, null, null, null, null, null,
        active ? this.remoteActiveSessions : null,
        { viewport, isDisplayMode: true }
      );

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = active ? '#132c46' : '#18212d';
      ctx.fillRect(x, y, layout.width, header);
      ctx.strokeStyle = active ? '#58a6ff' : '#73859a';
      ctx.lineWidth = active ? 3 : 2;
      ctx.setLineDash([]);
      ctx.strokeRect(x + 1.5, y + 1.5, layout.width - 3, layout.height - 3);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 2, y + header - 0.5);
      ctx.lineTo(x + layout.width - 2, y + header - 0.5);
      ctx.stroke();
      ctx.beginPath();
      ctx.rect(x + 4, y + 1, Math.max(1, layout.width - 8), header - 2);
      ctx.clip();
      this.drawViewportBadge(
        ctx, x + 6, y + 2,
        (page ? (page.name || `Trang ${index + 1}`) : `Ô ${slot + 1}`) + (active ? ' · Đang viết' : (!page ? ' · Chờ' : '')),
        active, active && this.remoteActiveSessions.size > 0
      );
      ctx.restore();
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
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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

  showPageTransitionBanner(pageIndex = this.currentPageIndex, totalPages = this.pages.length, pageName = null) {
    if (!this.toastElement || !this.toastText) return;
    const currentNum = (typeof pageIndex === 'number' ? pageIndex : 0) + 1;
    const total = Math.max(1, totalPages || 1);
    const name = pageName || this.pages[pageIndex]?.name || `Trang ${currentNum}`;
    this.toastText.textContent = `${name} (${currentNum} / ${total})`;
    this.toastElement.style.opacity = '1';
    this.toastElement.style.transform = 'translateX(-50%) translateY(0)';
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      if (this.toastElement) {
        this.toastElement.style.opacity = '0';
        this.toastElement.style.transform = 'translateX(-50%) translateY(-20px)';
      }
    }, 2200);
  }

  updatePageUI() {
    if (this.pillPage) {
      const cur = (this.currentPageIndex || 0) + 1;
      const total = Math.max(1, this.pages?.length || 1);
      const modeLabels = { single: '1 Bảng', dual: 'Ghép Đôi', quad: 'Chia 4', grid: 'Lưới' };
      const modeStr = modeLabels[this.displayMode] || this.displayMode;
      this.pillPage.textContent = `Trang ${cur} / ${total} [${modeStr}]`;
    }
  }

  setDisplayMode(mode) {
    if (!['single', 'dual', 'quad', 'grid'].includes(mode)) return;
    this.displayMode = mode;
    console.log(`[PC Display] 🖥️ Display mode switched to: ${mode}`);
    this.updatePageUI();
    this.saveDisplayState();
    this.requestRender();
  }

  applyDisplaySelection(selection) {
    if (!selection || !['follow', 'fixed'].includes(selection.mode) || !Array.isArray(selection.pageIds)) return;
    this.displaySelection = { mode: selection.mode, pageIds: [...new Set(selection.pageIds)] };
    this.requestRender();
    this.saveDisplayState();
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
          displaySelection: this.displaySelection,
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
      this.applyDisplaySelection(data.displaySelection);
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
        const sceneData = this.resolveCurrentPageScene(data.scene);
        this.scene.loadFromJSON(sceneData);
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

  // Only fall back to page data when the packet omits its scene.
  resolveCurrentPageScene(sceneData) {
    const page = this.pages?.[this.currentPageIndex];
    // An explicitly empty scene is a valid blank page, never stale data.
    return sceneData ?? page?.scene ?? new SceneGraph().toJSON();
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
    const isConnected = this.syncClient && this.syncClient.isConnected;
    const hasPages = Array.isArray(this.pages) && this.pages.length > 0;
    if (this.hasSceneData || this.hasMeaningfulContent() || isConnected || hasPages) {
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
    this.updatePageUI();
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
      this.applyDisplaySelection(data.displaySelection);
      this._currentSessionId = data.active_session_id;
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
      this.applyDisplaySelection(data?.displaySelection);
      if (data && ['single', 'dual', 'quad', 'grid'].includes(data.displayMode)) {
        this.setDisplayMode(data.displayMode);
      }
      if (data && data.scene) {
        console.log('[PC Display] 📥 Received CANVAS_MIRROR update');
        this.applyCanvasMirror(
          data.scene,
          data.camera,
          { theme: data.theme, gridType: data.gridType },
          data.pages,
          data.currentPageIndex
        );
      }
    });

    // YouTube chỉ chạy tại Display; thiết bị điều khiển gửi lệnh từ xa.
    this.syncClient.on('YOUTUBE_CONTROL', (data) => {
      this.controlYoutube(data);
      setTimeout(() => this.controlYoutube(data), 350);
      setTimeout(() => this.controlYoutube(data), 1200);
      setTimeout(() => this.controlYoutube(data), 2500);
    });

    // Fast-path Page Switch Protocol (Instant Relay <15ms)
    this.syncClient.on('PAGE_SWITCH', (data) => {
      if (!data) return;
      this.remoteActiveSessions.clear();
      this.targetPan = null;
      this.targetZoom = null;
      console.log(`[PC Display] ⚡ Instant PAGE_SWITCH to page index ${data.currentPageIndex}`);
      if (Array.isArray(data.pages)) {
        this.pages = data.pages;
        // Xóa cache scene instance để luôn render bản mới nhất
        for (const p of this.pages) {
          delete p._sceneInstance;
          delete p._lastSceneJSON;
        }
      }
      if (typeof data.currentPageIndex === 'number') {
        this.currentPageIndex = data.currentPageIndex;
      }
      {
        const sceneData = this.resolveCurrentPageScene(data.scene);
        this.scene.loadFromJSON(sceneData);
        const theme = data.theme || sceneData.root?.style || 'chalkboard';
        const grid = data.gridType || sceneData.root?.gridType || 'grid';
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
      this.showPageTransitionBanner();
      this.updatePageUI();
      this.saveDisplayState();
      this.requestRender();
    });

    // Display Layout / Multi-Board Mode Selection Protocol
    this.syncClient.on('DISPLAY_MODE_SET', (data) => {
      if (!data) return;
      this.applyDisplaySelection(data.displaySelection);
      this.remoteActiveSessions.clear();
      this.targetPan = null;
      this.targetZoom = null;
      if (Array.isArray(data.pages)) {
        this.pages = data.pages;
        for (const p of this.pages) {
          delete p._sceneInstance;
          delete p._lastSceneJSON;
        }
      }
      if (typeof data.currentPageIndex === 'number') {
        this.currentPageIndex = data.currentPageIndex;
      }
      if (data.scene) {
        this.scene.loadFromJSON(this.resolveCurrentPageScene(data.scene));
        const theme = data.theme || data.scene.root?.style || 'chalkboard';
        const grid = data.gridType || data.scene.root?.gridType || 'grid';
        this.scene.root.style = theme;
        this.scene.root.gridType = grid;
      }
      if (data.camera) {
        if (typeof data.camera.zoom === 'number') this.camera.zoom = data.camera.zoom;
        if (data.camera.pan) this.camera.pan = new Vec2(data.camera.pan.x, data.camera.pan.y);
      }
      if (data.mode) {
        this.setDisplayMode(data.mode);
      }
      this.hasSceneData = true;
      this.hideIdleOverlay();
      this.updatePageUI();
      this.requestRender();
    });

    // Nhận cập nhật phiên làm việc từ xa (Chỉ áp dụng khi khởi tạo hoặc chuyển phiên thực sự)
    this.syncClient.on('SESSION_UPDATE', (data) => {
      if (data && data.content && data.content.scene) {
        const isNewSession = data.sessionId && data.sessionId !== this._currentSessionId;
        if (!this.hasSceneData || isNewSession) {
          console.log('[PC Display] 📥 Applying SESSION_UPDATE (initial / session switch)');
          this._currentSessionId = data.sessionId;
          this.applyCanvasMirror(data.content.scene, data.content.camera, null,
            data.content.pages || [], data.content.currentPageIndex ?? 0);
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
        if (target.pdfData) target.setPdfPageStrokes(data.pdfPageIndex ?? target.pdfData.pageIndex, []);
        else target.elements = [];
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
      existing.youtubeData = node.youtubeData;
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
    this.remoteActiveSessions.clear();
    this.targetPan = null;
    this.targetZoom = null;
    const prevIndex = this.currentPageIndex;
    // Cập nhật danh sách trang nếu có và xóa cache instance
    if (Array.isArray(pagesData)) {
      this.pages = pagesData;
      for (const p of this.pages) {
        delete p._sceneInstance;
        delete p._lastSceneJSON;
      }
    }
    if (typeof pageIndex === 'number') {
      this.currentPageIndex = pageIndex;
    }

    this.scene.loadFromJSON(this.resolveCurrentPageScene(sceneData));

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
    if (typeof pageIndex === 'number' && pageIndex !== prevIndex) {
      this.showPageTransitionBanner();
    }
    this.updatePageUI();
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
    const { clientId, session, pageIndex } = data;
    if (!clientId) return;
    if (typeof pageIndex === 'number' && pageIndex !== this.currentPageIndex) return;
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
    const { nodeId, stroke, clientId, sendTime, pageIndex, pdfPageIndex } = data;
    if (!stroke) return;

    // Định tuyến nét vẽ theo pageIndex nếu có và đang ở trang khác
    let targetScene = this.scene;
    if (typeof pageIndex === 'number' && pageIndex !== this.currentPageIndex && this.pages[pageIndex]) {
      targetScene = this.getPageScene(this.pages[pageIndex]);
      // Cập nhật luôn json của page đó
      const pageNode = (nodeId ? targetScene.getNode(nodeId) : null) || targetScene.root;
      if (pageNode) {
        const strokeObj = Stroke.fromJSON(stroke);
        const pdfPage = pageNode.pdfData ? (pdfPageIndex ?? pageNode.pdfData.pageIndex) : null;
        const strokes = pdfPage != null ? pageNode.getPdfPageStrokes(pdfPage) : pageNode.elements;
        if (!strokes.some((s) => s.id === strokeObj.id)) {
          if (pdfPage != null) pageNode.setPdfPageStrokes(pdfPage, [...strokes, strokeObj]);
          else pageNode.addStroke(strokeObj);
        }
        this.pages[pageIndex].scene = targetScene.toJSON();
        this.pages[pageIndex]._lastSceneJSON = this.pages[pageIndex].scene;
      }
    }

    // Chỉ vẽ lên this.scene nếu nét vẽ thuộc đúng trang hiện tại (hoặc không truyền pageIndex)
    const isCurrentPage = (typeof pageIndex !== 'number') || (pageIndex === this.currentPageIndex);
    if (isCurrentPage) {
      const targetNode = (nodeId ? this.scene.getNode(nodeId) : null) || this.scene.root;
      if (targetNode) {
        const strokeObj = Stroke.fromJSON(stroke);
        const pdfPage = targetNode.pdfData ? (pdfPageIndex ?? targetNode.pdfData.pageIndex) : null;
        const strokes = pdfPage != null ? targetNode.getPdfPageStrokes(pdfPage) : targetNode.elements;
        if (!strokes.some((s) => s.id === strokeObj.id)) {
          if (pdfPage != null) targetNode.setPdfPageStrokes(pdfPage, [...strokes, strokeObj]);
          else targetNode.addStroke(strokeObj);
        }
        if (this.pages && this.pages[this.currentPageIndex]) {
          this.pages[this.currentPageIndex].scene = this.scene.toJSON();
          delete this.pages[this.currentPageIndex]._sceneInstance;
          delete this.pages[this.currentPageIndex]._lastSceneJSON;
        }
        this.hasSceneData = true;
        this.hideIdleOverlay();
        const delay = sendTime ? ` [Độ trễ toàn trình: ${Date.now() - sendTime}ms]` : '';
        console.log(`[PC Display] ✏️ Rendered stroke in "${targetNode.name || targetNode.id}" (${strokeObj.points?.length || 0} pts, tổng: ${targetNode.elements.length})${delay}`);
      } else {
        console.warn(`[PC Display] ⚠️ Target node "${nodeId}" not found for stroke!`);
      }
    }
    if (clientId && isCurrentPage) {
      this.remoteActiveSessions.delete(clientId);
    }
    this.saveDisplayState();
    this.requestRender();
  }

  applyStrokeErase(data) {
    const { nodeId, removedStrokeIds, pdfPageIndex } = data;
    if (!Array.isArray(removedStrokeIds)) return;
    const targetNode = (nodeId ? this.scene.getNode(nodeId) : null) || this.scene.root;
    if (targetNode && Array.isArray(targetNode.elements)) {
      const idSet = new Set(removedStrokeIds);
      const pdfPage = targetNode.pdfData ? (pdfPageIndex ?? targetNode.pdfData.pageIndex) : null;
      const strokes = pdfPage != null ? targetNode.getPdfPageStrokes(pdfPage) : targetNode.elements;
      const remaining = strokes.filter((s) => !idSet.has(s.id));
      if (pdfPage != null) targetNode.setPdfPageStrokes(pdfPage, remaining);
      else targetNode.elements = remaining;
      console.log(`[PC Display] 🧹 Erased ${strokes.length - remaining.length} strokes in "${targetNode.name || targetNode.id}"`);
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
    // Một thao tác trực tiếp trên Display là điều kiện cần để trình duyệt cho phép âm thanh.
    window.addEventListener('pointerdown', () => {
      this.unlockYoutubeAudioForAll();
    }, { passive: true });

    window.addEventListener('resize', () => {
      this.renderer.resize(window.innerWidth, window.innerHeight);
      this.camera.viewportWidth = window.innerWidth;
      this.camera.viewportHeight = window.innerHeight;
      this.requestRender();
    });

    window.addEventListener('beforeunload', () => {
      this.saveDisplayState();
    });
    window.addEventListener('pagehide', () => this.saveDisplayState());

    // Phím tắt toàn màn hình & chuyển chế độ hiển thị
    window.addEventListener('keydown', (e) => {
      // Phím số 1, 2, 4 để đổi chế độ hiển thị bảng (hoặc 3/G cho Lưới)
      if (e.key === '1') {
        this.setDisplayMode('single');
      } else if (e.key === '2') {
        this.setDisplayMode('dual');
      } else if (e.key === '4') {
        this.setDisplayMode('quad');
      } else if (e.key === '3' || e.key === 'g' || e.key === 'G') {
        this.setDisplayMode('grid');
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

  unlockYoutubeAudioForAll() {
    const frames = document.querySelectorAll('#display-video-overlays iframe');
    if (!frames.length) return;
    this.youtubeAudioUnlocked = true;
    frames.forEach((iframe) => {
      if (!iframe.contentWindow) return;
      iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'unMute', args: [] }), '*');
      iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'setVolume', args: [100] }), '*');
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
