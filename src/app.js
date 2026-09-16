import { Camera, Transform2D, Vec2, generateUUID } from './engine/math.js';
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
import { SessionManager, DEFAULT_EMPTY_THUMBNAIL } from './storage/sessionManager.js';
import { db } from './storage/db.js';

class NestedCanvasApp {
  constructor() {
    this.clientId = generateUUID();
    this.isApplyingRemoteSync = false;
    this.remoteActiveSessions = new Map();
    this.syncClient = null;
    this.sessionManager = null;
    this.hasUnsavedChanges = false;

    // Multi-Page / Multi-Board presentation state
    this.pages = [];
    this.currentPageIndex = 0;

    this.canvas = document.getElementById('canvas');
    this.renderer = new CanvasRenderer(this.canvas);
    this.scene = new SceneGraph();
    this.history = new HistoryManager(100);
    this.camera = new Camera(0, 0, 1.0, window.innerWidth, window.innerHeight);

    CanvasNode.onImageLoaded = () => {
      this.requestRender();
    };

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

    // Active in-flight drawing gestures (Hỗ trợ đa điểm chạm / Multi-touch)
    this.activeSessions = new Map(); // pointerId -> session
    this.isMultiPointMode = false;   // Chế độ vẽ đa điểm (cho Android / Tablet)
    this.eraserCursor = null;
    this.eraserCursors = new Map();

    // Canvas Node Dragging / Resizing initial cache
    this.nodeDragInitialPos = null;
    this.nodeDragCurrentTransform = null;
    this.resizeInitialPos = null;
    this.resizeInitialDims = null;

    this.boardCounter = 0;
    this.desmosCounter = 0;

    // Kiểm tra chế độ chia sẻ theo từng bảng con (Single Board Room)
    const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    this.singleBoardId = urlParams ? (urlParams.get('board') || urlParams.get('boardId')) : null;
    this.isSingleBoardMode = !!this.singleBoardId;
    this.currentSharingBoardNode = null;

    // Multi-touch gestures for mobile / touch devices
    this.activePointers = new Map();
    this.initialPinchDistance = null;
    this.initialPinchZoom = null;
    this._savedCastBoardId = null;

    // Chế Độ Tập Trung (Focus Mode - Bảo toàn bố cục bảng chính 100%)
    this.isFocusMode = false;
    this.focusNodeId = null;
    this.savedPreFocusCamera = null;
    this.focusSyncDisplay = false; // Mặc định: Giữ nguyên bố cục màn chiếu PC, không zoom theo

    this.initDefaultScene();
    this.bindEvents();
    this.initLANSync();
    this.initSessionStorage();
    this.initSessionUI();
    this.initCastPCControls();
    if (this._savedCastBoardId) {
      const node = this.scene.getNode(this._savedCastBoardId);
      if (node) {
        setTimeout(() => this.castBoardToPC(node), 300);
      }
    }
    this.updateUI();
    this.startRenderLoop();
  }

  // Getter & Setter để đảm bảo tương thích ngược 100% với các tính năng đơn điểm
  get activeSession() {
    if (!this.activeSessions || this.activeSessions.size === 0) return null;
    return this.activeSessions.values().next().value || null;
  }

  set activeSession(val) {
    if (!this.activeSessions) this.activeSessions = new Map();
    if (!val) {
      this.activeSessions.clear();
    } else {
      const pid = val.pointerId !== undefined ? val.pointerId : 0;
      this.activeSessions.set(pid, val);
    }
  }

  markUnsavedChanges() {
    if (this.isApplyingRemoteSync) return;
    this.hasUnsavedChanges = true;
    const dot = document.getElementById('dot-unsaved-changes');
    if (dot) dot.style.visibility = 'visible';
    const label = document.getElementById('label-save-status');
    if (label) label.textContent = 'Lưu Bài*';
    const btn = document.getElementById('btn-save-workspace');
    if (btn) {
      btn.style.borderColor = 'rgba(240,136,62,0.6)';
      btn.style.color = '#f0883e';
    }
  }

  saveState() {
    // Chỉ đánh dấu có thay đổi chưa lưu — KHÔNG tự động lưu hay broadcast ở đây.
    // Autosave được kích hoạt rờ rạc từ các sự kiện quan trọng (stroke add, erase, node create...).
    this.markUnsavedChanges();
  }

  /**
   * Gọi sau khi có thay đổi thực sự về nội dung.
   * Chỉ lưu vào IndexedDB (debounce 3s) — KHÔNG tự động broadcast CANVAS_MIRROR.
   * Display chỉ được cập nhật khi user bấm lưu thủ công (Ctrl+S / nút Lưu)
   * để tránh việc display reset camera liên tục.
   */
  scheduleContentSave() {
    this.markUnsavedChanges();
    if (this.sessionManager) {
      this.saveCurrentPage();
      this.sessionManager.scheduleAutoSave(
        this.scene,
        this.camera,
        this.boardCounter || 0,
        this.selectedNodeId,
        this.syncClient?.currentCastBoardId || null,
        this.pages,
        this.currentPageIndex
      );
    }
  }

  scheduleCanvasMirrorBroadcast() {
    // Đã vô hiệu hóa — không tự động broadcast CANVAS_MIRROR nữa.
    // Gọi broadcastCanvasMirror() trực tiếp sau khi lưu thủ công.
  }

  async saveManualWorkspace(silent = false) {
    try {
      if (this.isSingleBoardMode) {
        const node = this.scene.getNode(this.singleBoardId);
        if (node) {
          localStorage.setItem(`nestedcanvas_single_${this.singleBoardId}`, JSON.stringify({
            node: node.toJSON(),
            camera: {
              zoom: this.camera.zoom,
              pan: { x: this.camera.pan.x, y: this.camera.pan.y },
            },
            savedAt: Date.now(),
          }));
        }
      } else if (this.sessionManager) {
        this.saveCurrentPage();
        await this.sessionManager.saveCurrentSession(
          this.scene,
          this.camera,
          this.boardCounter || 0,
          this.selectedNodeId,
          this.syncClient?.currentCastBoardId || null,
          this.pages,
          this.currentPageIndex
        );
      }

      this.markSavedState();

      // Broadcast CANVAS_MIRROR một lần duy nhất sau khi lưu thủ công
      if (this.syncClient && this.syncClient.isConnected) {
        this.broadcastCanvasMirror();
      }

      if (!silent) {
        this.showToast('💾 Đã lưu bài giảng thành công!');
      }

      return true;
    } catch (e) {
      console.warn('[Storage] Manual save error:', e);
      if (!silent) this.showToast('❌ Lỗi khi lưu bài giảng');
      return false;
    }
  }

  markSavedState() {
    this.hasUnsavedChanges = false;
    const dot = document.getElementById('dot-unsaved-changes');
    if (dot) dot.style.visibility = 'hidden';
    const label = document.getElementById('label-save-status');
    if (label) label.textContent = 'Đã Lưu ✅';
    const btn = document.getElementById('btn-save-workspace');
    if (btn) {
      btn.style.borderColor = 'rgba(63,185,80,0.5)';
      btn.style.color = '#3fb950';
    }

    setTimeout(() => {
      if (!this.hasUnsavedChanges && label) {
        label.textContent = 'Lưu Bài';
        if (btn) {
          btn.style.borderColor = '';
          btn.style.color = '';
        }
      }
    }, 2500);
  }

  saveStateImmediately() {
    return this.saveManualWorkspace(true);
  }

  showUnsavedConfirmModal(onProceedToExit) {
    const modal = document.getElementById('modal-unsaved-confirm');
    if (!modal) {
      if (onProceedToExit) onProceedToExit();
      return;
    }

    modal.style.display = 'flex';

    const btnSaveExit = document.getElementById('btn-unsaved-save-exit');
    const btnDiscardExit = document.getElementById('btn-unsaved-discard-exit');
    const btnCancelExit = document.getElementById('btn-unsaved-cancel') || document.getElementById('btn-unsaved-cancel-exit');

    const cleanup = () => {
      modal.style.display = 'none';
      if (btnSaveExit) btnSaveExit.onclick = null;
      if (btnDiscardExit) btnDiscardExit.onclick = null;
      if (btnCancelExit) btnCancelExit.onclick = null;
    };

    if (btnSaveExit) {
      btnSaveExit.onclick = async () => {
        cleanup();
        await this.saveManualWorkspace(true);
        if (onProceedToExit) onProceedToExit();
      };
    }

    if (btnDiscardExit) {
      btnDiscardExit.onclick = () => {
        cleanup();
        this.hasUnsavedChanges = false;
        if (onProceedToExit) onProceedToExit();
      };
    }

    if (btnCancelExit) {
      btnCancelExit.onclick = () => {
        cleanup();
      };
    }
  }

  async initSessionStorage() {
    if (this.isSingleBoardMode) return;
    try {
      this.sessionManager = new SessionManager({
        syncClient: this.syncClient,
        onSessionChange: (meta) => {
          this.updateActiveSessionUI(meta);
        },
        onAutoSave: (meta) => {
          this.markSavedState();
        },
      });

      // 1. Thử kéo phiên làm việc đang hoạt động (Active Session) từ Sync Server để đồng nhất 100%
      try {
        const host = this.syncClient?.getHost() || window.location.hostname || 'localhost';
        const port = this.syncClient?.port || 8765;
        const res = await fetch(`http://${host}:${port}/api/sessions/active`, { signal: AbortSignal.timeout(600) });
        if (res.ok) {
          const serverActive = await res.json();
          if (serverActive && serverActive.meta && serverActive.content) {
            await this.sessionManager.saveSessionSilently(serverActive.meta, serverActive.content);
            this.sessionManager.currentSessionId = serverActive.meta.id;
            this.sessionManager.currentSessionMeta = serverActive.meta;
            this.applySessionContent(serverActive.content);
            this.updateActiveSessionUI(serverActive.meta);
            console.log(`[SessionManager] 🎯 Unified with server active session: ${serverActive.meta.name}`);
            return;
          }
        }
      } catch (e) {
        // Tiếp tục dùng local session nếu chưa nối được server
      }

      const session = await this.sessionManager.init({
        scene: this.scene.toJSON(),
        camera: { zoom: this.camera.zoom, pan: { x: this.camera.pan.x, y: this.camera.pan.y } },
      });

      if (session && session.content) {
        this.applySessionContent(session.content);
      }
      this.updateActiveSessionUI(this.sessionManager.getCurrentSessionMeta());
      this._sessionLoaded = true;

      // Tự động đồng bộ toàn cảnh nét vẽ cũ lên Display và Server ngay khi nạp xong
      if (this.syncClient && this.syncClient.isConnected) {
        this.broadcastCanvasMirror();
        this.broadcastCurrentCameraSync();
        if (this._savedCastBoardId) {
          const castNode = this.scene.getNode(this._savedCastBoardId);
          if (castNode) this.castBoardToPC(castNode);
        }
      }
    } catch (err) {
      console.warn('[SessionManager] Init error:', err);
    }
  }

  applySessionContent(content) {
    if (!content) return;
    try {
      if (content.pages && Array.isArray(content.pages) && content.pages.length > 0) {
        this.pages = content.pages;
        let idx = typeof content.currentPageIndex === 'number' ? content.currentPageIndex : 0;
        if (idx < 0 || idx >= this.pages.length) idx = 0;
        this.currentPageIndex = idx;
        const p = this.pages[idx];
        if (p && p.scene) {
          content.scene = p.scene;
          if (p.camera) content.camera = p.camera;
        }
      } else {
        this.pages = [{
          id: `page_${Date.now()}_1`,
          name: 'Trang 1',
          scene: content.scene || this.scene.toJSON(),
          camera: content.camera || { zoom: this.camera.zoom, pan: { x: this.camera.pan.x, y: this.camera.pan.y } },
          theme: content.scene?.root?.style || this.globalTheme || 'chalkboard',
          gridType: content.scene?.root?.gridType || this.globalGrid || 'grid',
        }];
        this.currentPageIndex = 0;
      }
      this.updatePageIndicator();

      if (content.scene && content.scene.root) {
        this.scene.loadFromJSON(content.scene);
        this.globalTheme = this.scene.root.style || 'chalkboard';
        this.globalGrid = this.scene.root.gridType || 'grid';
        if (this.renderThemeMenu) this.renderThemeMenu();
      }
      if (typeof content.boardCounter === 'number') {
        this.boardCounter = content.boardCounter;
      }
      if (content.camera) {
        if (typeof content.camera.zoom === 'number' && content.camera.zoom > 0) {
          this.camera.zoom = content.camera.zoom;
        }
        if (content.camera.pan && typeof content.camera.pan.x === 'number') {
          this.camera.pan = new Vec2(content.camera.pan.x, content.camera.pan.y);
        }
      }
      if (content.selectedNodeId && this.scene.getNode(content.selectedNodeId)) {
        this.selectedNodeId = content.selectedNodeId;
      } else if (this.scene.root.children.length > 0) {
        this.selectedNodeId = this.scene.root.children[0].id;
      } else {
        this.selectedNodeId = null;
      }

      if (content.currentCastBoardId) {
        this._savedCastBoardId = content.currentCastBoardId;
      }

      this.history.clear();
      this.updateHierarchyTree();
      this.updateUI();
    } catch (e) {
      console.warn('[SessionManager] Error applying session content:', e);
    }
  }

  updateActiveSessionUI(meta) {
    const label = document.getElementById('label-active-session-name');
    if (label && meta) {
      label.textContent = meta.name || 'Phiên làm việc';
      label.title = `Phiên hiện tại: ${meta.name}`;
    }
  }

  /* ==========================================================================
     Multi-Page / Multi-Board Presentation System
     ========================================================================== */

  saveCurrentPage() {
    if (!this.pages || this.pages.length === 0) {
      this.pages = [{
        id: `page_${Date.now()}_1`,
        name: 'Trang 1',
        scene: this.scene.toJSON(),
        camera: { zoom: this.camera.zoom, pan: { x: this.camera.pan.x, y: this.camera.pan.y } },
        theme: this.globalTheme || this.scene.root?.style || 'chalkboard',
        gridType: this.globalGrid || this.scene.root?.gridType || 'grid',
      }];
      this.currentPageIndex = 0;
      return;
    }
    if (this.currentPageIndex < 0 || this.currentPageIndex >= this.pages.length) {
      this.currentPageIndex = 0;
    }
    const current = this.pages[this.currentPageIndex];
    if (current) {
      current.scene = this.scene.toJSON();
      current.camera = { zoom: this.camera.zoom, pan: { x: this.camera.pan.x, y: this.camera.pan.y } };
      current.theme = this.globalTheme || this.scene.root?.style || 'chalkboard';
      current.gridType = this.globalGrid || this.scene.root?.gridType || 'grid';
    }
  }

  loadPage(index) {
    if (!this.pages || this.pages.length === 0) return;
    if (index < 0) index = 0;
    if (index >= this.pages.length) index = this.pages.length - 1;
    this.currentPageIndex = index;
    const page = this.pages[index];
    if (!page) return;

    if (page.scene) {
      this.scene.loadFromJSON(page.scene);
      if (page.theme) {
        this.globalTheme = page.theme;
        if (this.scene.root) this.scene.root.style = page.theme;
      }
      if (page.gridType) {
        this.globalGrid = page.gridType;
        if (this.scene.root) this.scene.root.gridType = page.gridType;
      }
      if (this.renderThemeMenu) this.renderThemeMenu();
    }
    if (page.camera) {
      if (typeof page.camera.zoom === 'number' && page.camera.zoom > 0) {
        this.camera.zoom = page.camera.zoom;
      }
      if (page.camera.pan && typeof page.camera.pan.x === 'number') {
        this.camera.pan = new Vec2(page.camera.pan.x, page.camera.pan.y);
      }
    }

    this.history.clear();
    this.selectedNodeId = null;
    this.updateZoomHUD();
    this.updatePageIndicator();
    this.updateHierarchyTree();
    this.updateUI();
    this.requestRender();

    if (this.syncClient && this.syncClient.isConnected) {
      this.broadcastCanvasMirror();
      this.broadcastCurrentCameraSync();
    }
  }

  switchToPage(index) {
    if (index === this.currentPageIndex || index < 0 || index >= this.pages.length) return;
    this.saveCurrentPage();
    this.loadPage(index);
    this.scheduleContentSave();
  }

  addNewPage() {
    this.saveCurrentPage();
    const newPageNum = this.pages.length + 1;
    const newPageId = `page_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const blankScene = {
      root: {
        id: 'root',
        type: 'root',
        children: [],
        strokes: [],
        images: [],
        style: this.globalTheme || 'chalkboard',
        gridType: this.globalGrid || 'grid',
      }
    };
    const newPage = {
      id: newPageId,
      name: `Trang ${newPageNum}`,
      scene: blankScene,
      camera: { zoom: 1.0, pan: { x: 0, y: 0 } },
      theme: this.globalTheme || 'chalkboard',
      gridType: this.globalGrid || 'grid',
    };
    this.pages.push(newPage);
    this.loadPage(this.pages.length - 1);
    this.scheduleContentSave();
    this.showToast(`✨ Đã tạo Trang ${this.pages.length}`);
  }

  duplicateCurrentPage() {
    this.saveCurrentPage();
    const current = this.pages[this.currentPageIndex];
    if (!current) return;
    const newPageNum = this.pages.length + 1;
    const newPageId = `page_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const clonedScene = JSON.parse(JSON.stringify(current.scene));
    const newPage = {
      id: newPageId,
      name: `${current.name || `Trang ${this.currentPageIndex + 1}`} (Bản sao)`,
      scene: clonedScene,
      camera: { ...current.camera },
      theme: current.theme || this.globalTheme || 'chalkboard',
      gridType: current.gridType || this.globalGrid || 'grid',
    };
    this.pages.splice(this.currentPageIndex + 1, 0, newPage);
    this.loadPage(this.currentPageIndex + 1);
    this.scheduleContentSave();
    this.showToast(`📄 Đã nhân đôi trang`);
    this.closePageMenuPopover();
  }

  deleteCurrentPage() {
    if (this.pages.length <= 1) {
      this.showToast('⚠️ Không thể xóa khi chỉ còn 1 trang!');
      return;
    }
    const pageName = this.pages[this.currentPageIndex]?.name || `Trang ${this.currentPageIndex + 1}`;
    if (!confirm(`Bạn có chắc muốn xóa "${pageName}" không?`)) {
      return;
    }
    this.pages.splice(this.currentPageIndex, 1);
    if (this.currentPageIndex >= this.pages.length) {
      this.currentPageIndex = this.pages.length - 1;
    }
    this.loadPage(this.currentPageIndex);
    this.scheduleContentSave();
    this.showToast(`🗑️ Đã xóa trang`);
    this.closePageMenuPopover();
  }

  updatePageIndicator() {
    const indicator = document.getElementById('page-indicator');
    const btnPrev = document.getElementById('btn-page-prev');
    const btnNext = document.getElementById('btn-page-next');
    const total = (this.pages && this.pages.length > 0) ? this.pages.length : 1;
    const current = (this.currentPageIndex >= 0 && this.currentPageIndex < total) ? (this.currentPageIndex + 1) : 1;

    if (indicator) {
      indicator.textContent = `Trang ${current} / ${total}`;
    }
    if (btnPrev) {
      btnPrev.disabled = (this.currentPageIndex <= 0);
    }
    if (btnNext) {
      btnNext.disabled = (this.currentPageIndex >= total - 1);
    }
  }

  togglePageMenuPopover() {
    const popover = document.getElementById('popover-page-menu');
    if (!popover) return;
    const isOpen = popover.style.display === 'flex';
    if (isOpen) {
      this.closePageMenuPopover();
    } else {
      this.renderPageListPopover();
      popover.style.display = 'flex';
    }
  }

  closePageMenuPopover() {
    const popover = document.getElementById('popover-page-menu');
    if (popover) popover.style.display = 'none';
  }

  renderPageListPopover() {
    const listEl = document.getElementById('page-list-items');
    if (!listEl) return;
    listEl.innerHTML = '';
    this.pages.forEach((p, idx) => {
      const item = document.createElement('button');
      item.className = `page-item-btn ${idx === this.currentPageIndex ? 'active' : ''}`;
      const strokeCount = (p.scene?.root?.strokes?.length || 0) + (p.scene?.root?.elements?.length || 0);
      item.innerHTML = `
        <span style="font-weight:600;">${p.name || `Trang ${idx + 1}`}</span>
        <span style="font-size:10px; opacity:0.6;">${strokeCount} nét</span>
      `;
      item.addEventListener('click', () => {
        this.switchToPage(idx);
        this.closePageMenuPopover();
      });
      listEl.appendChild(item);
    });
  }

  initSessionUI() {
    const btnOpenSessions = document.getElementById('btn-open-sessions');
    const modalSessions = document.getElementById('modal-sessions');
    const btnCloseSessions = document.getElementById('btn-close-sessions-modal');
    const inputSearch = document.getElementById('input-search-sessions');
    const btnCreateSession = document.getElementById('btn-create-session-modal');
    const btnImportSession = document.getElementById('btn-import-session-modal');
    const inputImport = document.getElementById('input-import-session');

    if (btnOpenSessions && modalSessions) {
      btnOpenSessions.addEventListener('click', (e) => {
        e.stopPropagation();
        modalSessions.style.display = 'flex';
        if (inputSearch) inputSearch.value = '';
        this.renderSessionsGrid();
      });
    }

    if (btnCloseSessions && modalSessions) {
      btnCloseSessions.addEventListener('click', (e) => {
        e.stopPropagation();
        modalSessions.style.display = 'none';
      });
    }

    if (modalSessions) {
      modalSessions.addEventListener('click', (e) => {
        if (e.target === modalSessions) {
          modalSessions.style.display = 'none';
        }
      });
    }

    if (inputSearch) {
      inputSearch.addEventListener('input', () => {
        this.renderSessionsGrid(inputSearch.value.trim());
      });
    }

    if (btnCreateSession) {
      btnCreateSession.addEventListener('click', async (e) => {
        e.stopPropagation();
        const name = await this._promptSessionName('Tạo Phiên Làm Việc Mới', 'Bảng mới');
        if (name && name.trim()) {
          await this.createNewSession(name.trim());
        }
      });
    }

    if (btnImportSession && inputImport) {
      btnImportSession.addEventListener('click', (e) => {
        e.stopPropagation();
        inputImport.value = '';
        inputImport.click();
      });

      inputImport.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (file) {
          await this.importSessionFile(file);
        }
      });
    }
  }

  async importSessionFile(file) {
    if (!file) return;
    try {
      this.showToast(`⏳ Đang nạp bài giảng "${file.name}"...`, 1500);
      const text = await file.text();
      const importedMeta = await this.sessionManager.importSession(text);
      // Tự động chuyển ngay sang bài giảng vừa nạp để dạy ngay
      await this.switchSession(importedMeta.id);
      this.showToast(`✨ Đã mở thành công bài giảng: "${importedMeta.name}"!`, 3500);
      const modalSessions = document.getElementById('modal-sessions');
      if (modalSessions) modalSessions.style.display = 'none';
      this.renderSessionsGrid();
    } catch (err) {
      console.error('[SessionManager] Import failed:', err);
      this.showToast(`❌ Không thể nạp file: ${err.message}`, 4000);
    }
  }

  _promptSessionName(title, defaultValue = '') {
    return new Promise((resolve) => {
      const modal = document.getElementById('modal-session-prompt');
      const titleEl = document.getElementById('session-prompt-title');
      const input = document.getElementById('input-session-prompt-name');
      const btnCancel = document.getElementById('btn-cancel-session-prompt');
      const btnConfirm = document.getElementById('btn-confirm-session-prompt');

      if (!modal || !input || !btnConfirm || !btnCancel) {
        const res = window.prompt(title, defaultValue);
        return resolve(res);
      }

      if (titleEl) titleEl.textContent = title;
      input.value = defaultValue;
      modal.style.display = 'flex';
      setTimeout(() => {
        input.focus();
        input.select();
      }, 50);

      const cleanup = () => {
        modal.style.display = 'none';
        btnConfirm.onclick = null;
        btnCancel.onclick = null;
        input.onkeydown = null;
      };

      btnConfirm.onclick = (e) => {
        e.stopPropagation();
        const val = input.value.trim();
        cleanup();
        resolve(val || null);
      };

      btnCancel.onclick = (e) => {
        e.stopPropagation();
        cleanup();
        resolve(null);
      };

      input.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const val = input.value.trim();
          cleanup();
          resolve(val || null);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cleanup();
          resolve(null);
        }
      };
    });
  }

  async createNewSession(name) {
    if (!this.sessionManager) return;
    try {
      // Lưu phiên hiện tại trước khi tạo phiên mới
      await this.sessionManager.flushSave();

      const session = await this.sessionManager.createSession(name);
      if (session && session.content) {
        this.applySessionContent(session.content);
      }
      this.updateActiveSessionUI(session.meta);
      this.broadcastCanvasMirror();
      this.broadcastCurrentCameraSync();
      this.showToast(`✨ Đã mở phiên mới: "${session.meta.name}"`, 3000);

      const modalSessions = document.getElementById('modal-sessions');
      if (modalSessions) modalSessions.style.display = 'none';
    } catch (err) {
      console.error('[SessionManager] Create session error:', err);
      this.showToast(`❌ Lỗi tạo phiên: ${err.message}`, 3000);
    }
  }

  async switchSession(sessionId) {
    if (!this.sessionManager || this.sessionManager.getCurrentSessionId() === sessionId) {
      const modalSessions = document.getElementById('modal-sessions');
      if (modalSessions) modalSessions.style.display = 'none';
      return;
    }

    try {
      this.showToast('⏳ Đang nạp bài giảng...', 1500);
      const session = await this.sessionManager.switchSession(sessionId);
      if (session && session.content) {
        this.applySessionContent(session.content);
        this.updateActiveSessionUI(session.meta);
        this.broadcastCanvasMirror();
        this.broadcastCurrentCameraSync();
        this.showToast(`📖 Đã mở: "${session.meta.name}"`, 3000);
      }
      const modalSessions = document.getElementById('modal-sessions');
      if (modalSessions) modalSessions.style.display = 'none';
    } catch (err) {
      console.error('[SessionManager] Switch error:', err);
      this.showToast(`❌ Lỗi chuyển phiên: ${err.message}`, 3000);
    }
  }

  async renderSessionsGrid(filterText = '') {
    const grid = document.getElementById('sessions-grid');
    const countLabel = document.getElementById('sessions-count-label');
    if (!grid) return;

    try {
      const allSessions = await db.getAllSessions();
      const currentId = this.sessionManager?.getCurrentSessionId();

      let filtered = allSessions;
      if (filterText) {
        const lower = filterText.toLowerCase();
        filtered = allSessions.filter((s) => (s.name || '').toLowerCase().includes(lower));
      }

      if (countLabel) {
        countLabel.textContent = `Tổng cộng: ${allSessions.length} phiên làm việc`;
      }

      if (filtered.length === 0) {
        grid.innerHTML = `
          <div style="grid-column: 1 / -1; padding: 40px 20px; text-align: center; color: var(--text-muted); display: flex; flex-direction: column; align-items: center; gap: 8px;">
            <span style="font-size: 32px;">📭</span>
            <span style="font-size: 13px;">Không tìm thấy phiên làm việc nào phù hợp</span>
          </div>
        `;
        return;
      }

      grid.innerHTML = '';

      for (const s of filtered) {
        const isActive = s.id === currentId;
        const card = document.createElement('div');
        card.className = `session-card ${isActive ? 'active' : ''}`;

        // Format relative time
        let timeStr = 'Mới đây';
        if (s.updatedAt) {
          const diffMin = Math.floor((Date.now() - s.updatedAt) / 60000);
          if (diffMin < 1) timeStr = 'Vừa xong';
          else if (diffMin < 60) timeStr = `${diffMin} phút trước`;
          else {
            const diffHour = Math.floor(diffMin / 60);
            if (diffHour < 24) timeStr = `${diffHour} giờ trước`;
            else {
              const d = new Date(s.updatedAt);
              timeStr = `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
            }
          }
        }

        let thumbSrc = DEFAULT_EMPTY_THUMBNAIL;
        if (s.thumbnail && typeof s.thumbnail === 'string') {
          if (s.thumbnail.startsWith('data:image/webp') || s.thumbnail.startsWith('data:image/png') || s.thumbnail.startsWith('data:image/jpeg')) {
            thumbSrc = s.thumbnail;
          } else if (s.thumbnail.startsWith('data:image/svg+xml') && !s.thumbnail.includes('"')) {
            thumbSrc = s.thumbnail;
          }
        }

        card.innerHTML = `
          <div class="session-card-thumb-wrap" title="Nhấn để mở phiên này">
            <img src="${thumbSrc}" class="session-card-thumb" alt="Thumbnail" onerror="this.onerror=null; this.src='${DEFAULT_EMPTY_THUMBNAIL}';" />
            ${isActive ? '<div class="session-card-badge-active">🟢 Đang mở</div>' : ''}
          </div>
          <div class="session-card-body">
            <div class="session-card-title" title="${s.name}">${s.name || 'Phiên không tên'}</div>
            <div class="session-card-meta">
              <span>🕒 ${timeStr}</span>
              <span>📋 ${s.boardCount || 0} bảng • ✏️ ${s.strokeCount || 0} nét</span>
            </div>
            <div class="session-card-actions">
              <button class="session-btn-open" title="Mở làm việc trên phiên này">
                ${isActive ? '✓ Đang mở' : '▶ Mở bài'}
              </button>
              <button class="session-btn-icon btn-rename-session" title="Đổi tên phiên">✏️</button>
              <button class="session-btn-icon btn-dup-session" title="Nhân bản (Duplicate)">📋</button>
              <button class="session-btn-icon btn-export-session" title="Xuất bài giảng ra file (JSON, PDF, SVG)">📤</button>
              <button class="session-btn-icon danger btn-del-session" title="Xóa phiên này">🗑️</button>
            </div>
          </div>
        `;

        // Sự kiện click mở phiên
        const thumbWrap = card.querySelector('.session-card-thumb-wrap');
        const btnOpen = card.querySelector('.session-btn-open');
        const openHandler = () => this.switchSession(s.id);
        thumbWrap.addEventListener('click', openHandler);
        btnOpen.addEventListener('click', openHandler);

        // Đổi tên
        const btnRename = card.querySelector('.btn-rename-session');
        btnRename.addEventListener('click', async (e) => {
          e.stopPropagation();
          const newName = await this._promptSessionName('Đổi Tên Phiên Làm Việc', s.name);
          if (newName && newName.trim() && newName.trim() !== s.name) {
            await this.sessionManager.renameSession(s.id, newName.trim());
            this.showToast(`✏️ Đã đổi tên thành: "${newName.trim()}"`, 2500);
            this.renderSessionsGrid(filterText);
          }
        });

        // Nhân bản
        const btnDup = card.querySelector('.btn-dup-session');
        btnDup.addEventListener('click', async (e) => {
          e.stopPropagation();
          const dupMeta = await this.sessionManager.duplicateSession(s.id);
          if (dupMeta) {
            this.showToast(`📋 Đã tạo bản sao: "${dupMeta.name}"`, 2500);
            this.renderSessionsGrid(filterText);
          }
        });

        // Xuất file đa định dạng (PDF, HTML, SVG)
        const btnExport = card.querySelector('.btn-export-session');
        btnExport.addEventListener('click', (e) => {
          e.stopPropagation();
          this.openExportOptionsModal(s);
        });

        // Xóa phiên
        const btnDel = card.querySelector('.btn-del-session');
        btnDel.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (allSessions.length <= 1) {
            this.showToast('⚠️ Không thể xóa phiên duy nhất còn lại!', 3000);
            return;
          }
          if (window.confirm(`Bạn có chắc chắn muốn xóa vĩnh viễn bài giảng "${s.name}" không?`)) {
            await this.sessionManager.deleteSession(s.id);
            this.showToast(`🗑️ Đã xóa phiên: "${s.name}"`, 2500);
            this.renderSessionsGrid(filterText);
          }
        });

        grid.appendChild(card);
      }
    } catch (err) {
      console.error('[SessionManager] Render grid error:', err);
    }
  }

  async openExportOptionsModal(s) {
    const modal = document.getElementById('modal-export-options');
    const subtitle = document.getElementById('export-session-name-subtitle');
    const btnClose = document.getElementById('btn-close-export-modal');
    const scopeAll = document.getElementById('scope-all');
    const scopeCustom = document.getElementById('scope-custom');
    const scopeActions = document.getElementById('export-scope-actions');
    const btnSelectAll = document.getElementById('btn-export-select-all');
    const btnDeselectAll = document.getElementById('btn-export-deselect-all');
    const checklistContainer = document.getElementById('export-boards-checklist');
    const btnJson = document.getElementById('btn-export-opt-json');
    const btnPdf = document.getElementById('btn-export-opt-pdf');
    const btnSvg = document.getElementById('btn-export-opt-svg');

    if (!modal) return;
    if (subtitle) subtitle.textContent = `Bài giảng: "${s.name}"`;
    modal.style.display = 'flex';

    // Reset phạm vi về "Tất cả"
    if (scopeAll) scopeAll.checked = true;
    if (scopeCustom) scopeCustom.checked = false;
    if (checklistContainer) {
      checklistContainer.style.display = 'none';
      checklistContainer.innerHTML = '<div style="font-size:11px;color:#8b949e;padding:6px 0;">⏳ Đang nạp danh sách bảng...</div>';
    }
    if (scopeActions) scopeActions.style.display = 'none';

    const escapeHTML = (str) =>
      String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    // Nạp danh sách bảng
    try {
      const boards = await this.sessionManager.getSessionBoards(s.id);
      if (checklistContainer) {
        checklistContainer.innerHTML = '';
        if (!boards || boards.length === 0) {
          checklistContainer.innerHTML = '<div style="font-size:11px;color:#8b949e;padding:4px 0;">Không tìm thấy bảng con nào.</div>';
        } else {
          boards.forEach((b) => {
            const label = document.createElement('label');
            label.style.display = 'flex';
            label.style.alignItems = 'center';
            label.style.gap = '8px';
            label.style.padding = '5px 8px';
            label.style.borderRadius = '6px';
            label.style.background = 'rgba(255,255,255,0.03)';
            label.style.cursor = 'pointer';
            label.style.fontSize = '12px';
            label.style.transition = 'background 0.15s';
            label.onmouseover = () => { label.style.background = 'rgba(255,255,255,0.08)'; };
            label.onmouseout = () => { label.style.background = 'rgba(255,255,255,0.03)'; };

            const indent = b.level > 0 ? '&nbsp;'.repeat(b.level * 3) + '└─ ' : '';
            const icon = b.isRoot ? '🌍' : '📑';
            label.innerHTML = `
              <input type="checkbox" class="export-board-cb" value="${b.id}" checked style="cursor:pointer;" />
              <span style="color:${b.isRoot ? '#58a6ff' : '#f0f6fc'}; user-select:none;">
                ${indent}${icon} <strong>${escapeHTML(b.name)}</strong>
                <span style="font-size:11px;opacity:0.6;margin-left:4px">(${b.strokeCount} nét)</span>
              </span>
            `;
            checklistContainer.appendChild(label);
          });
        }
      }
    } catch (err) {
      console.error('[ExportModal] Error loading boards:', err);
    }

    const updateScopeUI = () => {
      const isCustom = scopeCustom && scopeCustom.checked;
      if (checklistContainer) checklistContainer.style.display = isCustom ? 'flex' : 'none';
      if (scopeActions) scopeActions.style.display = isCustom ? 'flex' : 'none';
    };

    if (scopeAll) scopeAll.onchange = updateScopeUI;
    if (scopeCustom) scopeCustom.onchange = updateScopeUI;

    if (btnSelectAll) {
      btnSelectAll.onclick = (e) => {
        e.preventDefault();
        modal.querySelectorAll('.export-board-cb').forEach((cb) => (cb.checked = true));
      };
    }
    if (btnDeselectAll) {
      btnDeselectAll.onclick = (e) => {
        e.preventDefault();
        modal.querySelectorAll('.export-board-cb').forEach((cb) => (cb.checked = false));
      };
    }

    const getSelectedBoardIds = () => {
      if (!scopeCustom || !scopeCustom.checked) {
        return null; // Toàn bộ
      }
      const cbs = Array.from(modal.querySelectorAll('.export-board-cb:checked'));
      if (cbs.length === 0) {
        this.showToast('⚠️ Vui lòng chọn ít nhất 1 bảng để xuất!', 3000);
        return false;
      }
      return cbs.map((cb) => cb.value);
    };

    const close = () => {
      modal.style.display = 'none';
      if (btnClose) btnClose.onclick = null;
      if (btnJson) btnJson.onclick = null;
      if (btnPdf) btnPdf.onclick = null;
      if (btnSvg) btnSvg.onclick = null;
      if (scopeAll) scopeAll.onchange = null;
      if (scopeCustom) scopeCustom.onchange = null;
      if (btnSelectAll) btnSelectAll.onclick = null;
      if (btnDeselectAll) btnDeselectAll.onclick = null;
      modal.onclick = null;
    };

    if (btnClose) btnClose.onclick = (e) => { e.stopPropagation(); close(); };
    modal.onclick = (e) => { if (e.target === modal) close(); };

    // 1. Xuất Tệp Dữ Liệu JSON Chuẩn (Để nạp vào phòng khác)
    if (btnJson) {
      btnJson.onclick = async (e) => {
        e.stopPropagation();
        const selected = getSelectedBoardIds();
        if (selected === false) return;
        close();
        this.showToast('⏳ Đang xuất tệp dữ liệu JSON...', 1500);
        try {
          await this.sessionManager.exportSessionJSON(s.id, selected);
          this.showToast(`📦 Đã tải tệp bài giảng: "${s.name}.json"!`, 3500);
        } catch (err) {
          console.error('[Export JSON] Error:', err);
          this.showToast('❌ Lỗi khi xuất JSON: ' + err.message, 4000);
        }
      };
    }

    // 2. Xuất Tài Liệu PDF Phân Trang
    if (btnPdf) {
      btnPdf.onclick = async (e) => {
        e.stopPropagation();
        const selected = getSelectedBoardIds();
        if (selected === false) return;
        close();
        this.showToast('⏳ Đang tạo tài liệu PDF phân trang...', 2000);
        try {
          await this.sessionManager.exportSessionPDF(s.id, selected);
          this.showToast(`📄 Đã tải file PDF: "${s.name}.pdf"!`, 3500);
        } catch (err) {
          console.error('[Export PDF] Error:', err);
          this.showToast('❌ Lỗi khi xuất PDF: ' + err.message, 4000);
        }
      };
    }

    // 3. Xuất Ảnh Vector SVG
    if (btnSvg) {
      btnSvg.onclick = async (e) => {
        e.stopPropagation();
        const selected = getSelectedBoardIds();
        if (selected === false) return;
        close();
        this.showToast('⏳ Đang xuất ảnh Vector...', 1500);
        try {
          await this.sessionManager.exportSessionSVG(s.id, selected);
          this.showToast(`🖼️ Đã tải ảnh Vector SVG: "${s.name}.svg"!`, 3500);
        } catch (err) {
          console.error('[Export SVG] Error:', err);
          this.showToast('❌ Lỗi khi xuất SVG: ' + err.message, 4000);
        }
      };
    }
  }

  loadState() {
    try {
      if (this.isSingleBoardMode) {
        const raw = localStorage.getItem(`nestedcanvas_single_${this.singleBoardId}`);
        if (!raw) return false;
        const data = JSON.parse(raw);
        if (data.node) {
          const node = CanvasNode.fromJSON(data.node);
          node.id = this.singleBoardId;
          node.isShared = true;
          this.scene.root.children = [node];
          this.selectedNodeId = node.id;
        }
        if (data.camera) {
          if (typeof data.camera.zoom === 'number' && data.camera.zoom > 0) {
            this.camera.zoom = data.camera.zoom;
          }
          if (data.camera.pan && typeof data.camera.pan.x === 'number') {
            this.camera.pan = new Vec2(data.camera.pan.x, data.camera.pan.y);
          }
        }
        return true;
      }

      // Khi không phải single board mode, dữ liệu sẽ do initSessionStorage đảm nhiệm
      const raw = localStorage.getItem('nestedcanvas_workspace_state');
      if (!raw) return false;
      const data = JSON.parse(raw);

      if (data.scene && data.scene.root) {
        this.scene.loadFromJSON(data.scene);
      }

      if (typeof data.boardCounter === 'number') {
        this.boardCounter = data.boardCounter;
      }

      if (data.camera) {
        if (typeof data.camera.zoom === 'number' && data.camera.zoom > 0) {
          this.camera.zoom = data.camera.zoom;
        }
        if (data.camera.pan && typeof data.camera.pan.x === 'number') {
          this.camera.pan = new Vec2(data.camera.pan.x, data.camera.pan.y);
        }
      }

      if (data.selectedNodeId && this.scene.getNode(data.selectedNodeId)) {
        this.selectedNodeId = data.selectedNodeId;
      } else if (this.scene.root.children.length > 0) {
        this.selectedNodeId = this.scene.root.children[0].id;
      }

      if (data.currentCastBoardId) {
        this._savedCastBoardId = data.currentCastBoardId;
      }

      return true;
    } catch (e) {
      console.warn('[Storage] Error loading workspace state:', e);
      return false;
    }
  }

  initDefaultScene() {
    if (this.isSingleBoardMode) {
      const loaded = this.loadState();
      if (!loaded) {
        const placeholder = new CanvasNode('Bảng Chia Sẻ', 780, 540, Transform2D.identity(), null, null, 'chalkboard', 'grid');
        placeholder.id = this.singleBoardId;
        placeholder.isShared = true;
        this.scene.root.addChild(placeholder);
        this.selectedNodeId = this.singleBoardId;
        setTimeout(() => this.focusBoardFullscreen(placeholder), 60);
      }
    } else {
      const loaded = this.loadState();
      if (!loaded) {
        this.scene.root.children = [];
        this.selectedNodeId = null;
      }
    }
  }

  bindEvents() {
    window.addEventListener('resize', () => this.renderer.resize());
    window.addEventListener('beforeunload', (e) => {
      if (this.hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = 'Bạn có thay đổi chưa lưu. Bạn có muốn lưu bài giảng trước khi thoát không?';
        return e.returnValue;
      }
    });

    // Bắt sự kiện nút quay lại / thoát app trên Android (Capacitor)
    document.addEventListener('backbutton', (e) => {
      if (this.hasUnsavedChanges) {
        e.preventDefault();
        this.showUnsavedConfirmModal(() => {
          if (window.Capacitor?.isNativePlatform() && window.Capacitor.Plugins?.App?.exitApp) {
            window.Capacitor.Plugins.App.exitApp();
          } else {
            window.history.back();
          }
        });
      }
    });

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
    window.addEventListener('pointercancel', (e) => this.onPointerUp(e));

    // Native Touch Events (100% Reliable 2-Finger Pinch-Zoom & Two-Finger Pan on Mobile)
    this.canvas.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
    window.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
    window.addEventListener('touchend', (e) => this.onTouchEnd(e), { passive: false });
    window.addEventListener('touchcancel', (e) => this.onTouchEnd(e), { passive: false });

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

    // Điều khiển mở / đóng Drawer Cây phân cấp trên thiết bị di động
    const btnToggleInspector = document.getElementById('btn-toggle-inspector');
    const btnCloseInspector = document.getElementById('btn-close-inspector');
    const inspectorPanel = document.getElementById('inspector-panel');

    if (btnToggleInspector && inspectorPanel) {
      btnToggleInspector.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = inspectorPanel.classList.toggle('mobile-open');
        btnToggleInspector.classList.toggle('active', isOpen);
      });
    }

    if (btnCloseInspector && inspectorPanel) {
      btnCloseInspector.addEventListener('click', (e) => {
        e.stopPropagation();
        inspectorPanel.classList.remove('mobile-open');
        btnToggleInspector?.classList.remove('active');
      });
    }

    // Khi chạm vào canvas trên điện thoại, tự động ẩn Drawer mục lục
    this.canvas.addEventListener('pointerdown', () => {
      if (window.innerWidth <= 768 && inspectorPanel?.classList.contains('mobile-open')) {
        inspectorPanel.classList.remove('mobile-open');
        btnToggleInspector?.classList.remove('active');
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

    // Multi-Page Navigation Bar & Popover Events
    const btnPagePrev = document.getElementById('btn-page-prev');
    const btnPageNext = document.getElementById('btn-page-next');
    const btnPageAdd = document.getElementById('btn-page-add');
    const pageIndicator = document.getElementById('page-indicator');
    const btnClosePageMenu = document.getElementById('btn-close-page-menu');
    const btnDuplicatePage = document.getElementById('btn-duplicate-page');
    const btnDeletePage = document.getElementById('btn-delete-page');

    if (btnPagePrev) {
      btnPagePrev.addEventListener('click', () => {
        if (this.currentPageIndex > 0) {
          this.switchToPage(this.currentPageIndex - 1);
        }
      });
    }

    if (btnPageNext) {
      btnPageNext.addEventListener('click', () => {
        if (this.currentPageIndex < this.pages.length - 1) {
          this.switchToPage(this.currentPageIndex + 1);
        }
      });
    }

    if (btnPageAdd) {
      btnPageAdd.addEventListener('click', () => {
        this.addNewPage();
      });
    }

    if (pageIndicator) {
      pageIndicator.addEventListener('click', (e) => {
        e.stopPropagation();
        this.togglePageMenuPopover();
      });
    }

    if (btnClosePageMenu) {
      btnClosePageMenu.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closePageMenuPopover();
      });
    }

    if (btnDuplicatePage) {
      btnDuplicatePage.addEventListener('click', (e) => {
        e.stopPropagation();
        this.duplicateCurrentPage();
      });
    }

    if (btnDeletePage) {
      btnDeletePage.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteCurrentPage();
      });
    }

    window.addEventListener('click', (e) => {
      const popover = document.getElementById('popover-page-menu');
      if (popover && popover.style.display === 'flex') {
        if (!popover.contains(e.target) && e.target !== pageIndicator) {
          this.closePageMenuPopover();
        }
      }
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
      this.broadcastCurrentCameraSync();
    });
    document.getElementById('btn-zoom-fit').addEventListener('click', () => {
      this.fitAllContent();
      this.broadcastCurrentCameraSync();
    });

    // Nút Lưu Bài Giảng Thủ Công
    const btnSaveWorkspace = document.getElementById('btn-save-workspace');
    if (btnSaveWorkspace) {
      btnSaveWorkspace.addEventListener('click', () => {
        this.saveManualWorkspace();
      });
    }

    // Undo / Redo
    document.getElementById('btn-undo').addEventListener('click', () => this.undo());
    document.getElementById('btn-redo').addEventListener('click', () => this.redo());

    // Thêm bảng mới (legacy hooks guarded)
    const addSampleBtn = document.getElementById('btn-add-sample');
    if (addSampleBtn) addSampleBtn.addEventListener('click', () => this.createNewBoard());
    const newChildBtn = document.getElementById('btn-new-child-canvas');
    if (newChildBtn) newChildBtn.addEventListener('click', () => this.createNewBoard());

    // Thêm Bảng Đồ Thị Toán Học Desmos
    const desmosBtn = document.getElementById('btn-add-desmos');
    if (desmosBtn) {
      desmosBtn.addEventListener('click', () => {
        this.createDesmosBoard();
      });
    }

    // Chế Độ Tập Trung (Focus Mode Buttons - guarded)
    const topFocusBtn = document.getElementById('btn-top-focus');
    if (topFocusBtn) {
      topFocusBtn.addEventListener('click', () => {
        if (this.selectedNodeId && this.selectedNodeId !== this.scene.root.id) {
          const node = this.scene.getNode(this.selectedNodeId);
          if (node) this.toggleFocusMode(node);
        }
      });
    }

    const exitFocusBtn = document.getElementById('btn-exit-focus-mode');
    if (exitFocusBtn) {
      exitFocusBtn.addEventListener('click', () => {
        this.exitFocusMode();
      });
    }

    const toggleDisplaySyncBtn = document.getElementById('btn-focus-toggle-display');
    if (toggleDisplaySyncBtn) {
      toggleDisplaySyncBtn.addEventListener('click', () => {
        this.toggleFocusDisplaySync();
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

    // Kéo thả tệp bài giảng JSON hoặc ảnh vào màn hình
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer?.files?.length > 0) {
        const file = e.dataTransfer.files[0];
        const lower = (file.name || '').toLowerCase();
        if (lower.endsWith('.json') || lower.endsWith('.nested') || lower.endsWith('.html')) {
          this.importSessionFile(file);
          return;
        }
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

    // Chế độ vẽ đa điểm (Multi-touch Drawing Mode)
    const btnMultiLeft = document.getElementById('tool-multipoint');
    if (btnMultiLeft) {
      btnMultiLeft.addEventListener('click', () => {
        this.toggleMultiPointMode();
      });
    }

    const btnMultiBottom = document.getElementById('btn-toggle-multipoint');
    if (btnMultiBottom) {
      btnMultiBottom.addEventListener('click', () => {
        this.toggleMultiPointMode();
      });
    }

    const btnHudToggle = document.getElementById('btn-hud-multipoint-toggle');
    if (btnHudToggle) {
      btnHudToggle.addEventListener('click', () => {
        this.toggleMultiPointMode(false);
      });
    }
  }

  toggleMultiPointMode(forcedState = null) {
    this.isMultiPointMode = forcedState !== null ? forcedState : !this.isMultiPointMode;

    const btnLeft = document.getElementById('tool-multipoint');
    const btnBottom = document.getElementById('btn-toggle-multipoint');
    const bottomStatusText = document.getElementById('multipoint-status-text');
    const btnMobile = document.getElementById('mobile-tool-multipoint');
    const hud = document.getElementById('multipoint-hud');

    if (btnLeft) {
      btnLeft.classList.toggle('active', this.isMultiPointMode);
    }
    if (btnBottom) {
      btnBottom.classList.toggle('active', this.isMultiPointMode);
    }
    if (bottomStatusText) {
      bottomStatusText.textContent = this.isMultiPointMode ? 'BẬT' : 'TẮT';
    }
    if (btnMobile) {
      btnMobile.classList.toggle('active', this.isMultiPointMode);
    }
    if (hud) {
      hud.style.display = this.isMultiPointMode ? 'flex' : 'none';
    }

    if (this.isMultiPointMode) {
      if (this.activeTool === 'select' || this.activeTool === 'pan') {
        this.setTool('pen');
      }
      this.showToast('🖐️ Đã BẬT Chế độ Vẽ Đa Điểm! Chạm nhiều ngón tay cùng lúc để vẽ đồng thời (Android & Cảm ứng).');
    } else {
      this.showToast('✌️ Đã TẮT Vẽ Đa Điểm. Chuyển về cử chỉ chuẩn (1 ngón vẽ, 2 ngón thu phóng/di chuyển).');
    }
  }

  setTool(tool) {
    this.activeTool = tool;
    document.querySelectorAll('.tool-btn[data-tool]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tool === tool);
    });

    const bottomBar = document.getElementById('bottom-bar');
    if (bottomBar) {
      const brushElements = bottomBar.querySelectorAll('.brush-types, .color-palette, .size-slider-wrapper');
      if (tool.startsWith('eraser') || tool === 'pan' || tool === 'select' || tool === 'ocr') {
        brushElements.forEach((el) => {
          el.style.opacity = '0.35';
          el.style.pointerEvents = 'none';
        });
      } else {
        brushElements.forEach((el) => {
          el.style.opacity = '1';
          el.style.pointerEvents = 'auto';
        });
      }
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
    this.scheduleContentSave();
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
        const parentNode = this.scene.root;
        const maxDim = 650;
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
          const worldPt = this.camera.screenToWorld(screenPos);
          localX = worldPt.x - w * 0.5;
          localY = worldPt.y - h * 0.5;
        } else {
          const center = this.camera.screenToWorld(new Vec2(window.innerWidth * 0.5, window.innerHeight * 0.5));
          localX = center.x - w * 0.5;
          localY = center.y - h * 0.5;
        }

        let targetImg = img;
        const maxResolution = 2048;
        if (img.width > maxResolution || img.height > maxResolution || (e.target.result && e.target.result.length > 2 * 1024 * 1024)) {
          try {
            const scale = Math.min(1, maxResolution / Math.max(img.width, img.height));
            const cvs = document.createElement('canvas');
            cvs.width = Math.round(img.width * scale);
            cvs.height = Math.round(img.height * scale);
            const ctx = cvs.getContext('2d');
            ctx.drawImage(img, 0, 0, cvs.width, cvs.height);
            const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
            const optDataUrl = cvs.toDataURL(mime, 0.88);
            const optImg = new Image();
            optImg.src = optDataUrl;
            targetImg = optImg;
          } catch (err) {}
        }

        const fileName = file.name ? file.name.replace(/\.[^/.]+$/, '') : 'Ảnh Mới';
        const imageCanvasNode = new CanvasNode(
          `🖼️ ${fileName}`,
          w,
          h,
          Transform2D.fromTranslation(localX, localY),
          targetImg
        );

        const cmd = new CreateNodeCommand(parentNode.id, imageCanvasNode);
        this.executeCommand(cmd, parentNode.id);
        if (this.syncClient && this.syncClient.isConnected && !this.isApplyingRemoteSync) {
          this.syncClient.send('NODE_CREATE', {
            clientId: this.clientId,
            parentId: parentNode.id,
            node: imageCanvasNode.toJSON(),
          });
          setTimeout(() => this.broadcastCanvasMirror(), 60);
        }
        this.selectedNodeId = imageCanvasNode.id;
        this.updateHierarchyTree();
        this.updateNodeProperties();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  // --- CỬ CHỈ CẢM ỨNG NATIVE 2 NGÓN TAY (NATIVE PINCH-TO-ZOOM & TWO-FINGER PAN) ---
  onTouchStart(e) {
    if (this.isMultiPointMode) return;
    if (e.touches && e.touches.length >= 2) {
      if (e.cancelable) e.preventDefault();
      this.isPinching = true;

      // Xóa và hủy bỏ các nét vẽ dở của 2 ngón tay vừa chạm
      if (this.activeSessions.size > 0) {
        for (const [pid] of this.activeSessions.entries()) {
          if (this.syncClient && this.syncClient.isConnected) {
            this.syncClient.send('CANVAS_STROKE_LIVE', {
              clientId: `${this.clientId}_${pid}`,
              session: null,
            });
          }
        }
        this.activeSessions.clear();
      }
      this.isDragging = false;
      this.isPanning = false;
      this.isPanningChild = false;

      const t0 = e.touches[0];
      const t1 = e.touches[1];
      this.initialPinchDistance = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      this.initialPinchZoom = this.camera.zoom;
      const midScreen = new Vec2((t0.clientX + t1.clientX) * 0.5, (t0.clientY + t1.clientY) * 0.5);
      this.initialPinchCenterWorld = this.camera.screenToWorld(midScreen);
    }
  }

  onTouchMove(e) {
    if (this.isMultiPointMode) return;
    if (e.touches && e.touches.length >= 2) {
      if (e.cancelable) e.preventDefault();
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      const curDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      const curMidScreen = new Vec2((t0.clientX + t1.clientX) * 0.5, (t0.clientY + t1.clientY) * 0.5);

      if (!this.isPinching || !this.initialPinchDistance || !this.initialPinchCenterWorld || this.initialPinchDistance < 5) {
        this.isPinching = true;
        this.initialPinchDistance = Math.max(5, curDist);
        this.initialPinchZoom = this.camera.zoom;
        this.initialPinchCenterWorld = this.camera.screenToWorld(curMidScreen);
        return;
      }

      const factor = curDist / this.initialPinchDistance;
      const newZoom = Math.max(0.05, Math.min(32.0, this.initialPinchZoom * factor));
      this.camera.zoom = newZoom;
      const screenCenter = new Vec2(this.camera.viewportWidth * 0.5, this.camera.viewportHeight * 0.5);
      this.camera.pan = this.initialPinchCenterWorld.sub(curMidScreen.sub(screenCenter).scale(1.0 / newZoom));
      this.updateZoomHUD();
      this.broadcastCurrentCameraSync();
    }
  }

  onTouchEnd(e) {
    if (!e.touches || e.touches.length < 2) {
      if (this.isPinching) {
        this.justFinishedPinching = Date.now();
        // Lưu trạng thái sau khi kết thúc pinch (không phải mỗi frame)
        this.scheduleContentSave();
      }
      this.isPinching = false;
      this.initialPinchDistance = null;
      this.initialPinchCenterWorld = null;
    }
  }

  onPointerDown(e) {
    // Nếu đang trong cử chỉ 2 ngón tay hoặc vừa thả tay sau khi pinch, bỏ qua không tạo nét vẽ
    if (this.isPinching || (!this.isMultiPointMode && this.justFinishedPinching && (Date.now() - this.justFinishedPinching < 300))) {
      return;
    }

    if (e.pointerType === 'touch' && !this.isMultiPointMode && e.isPrimary === false) {
      // Ngón tay thứ 2 trở đi trong chế độ vẽ đơn điểm không được tạo nét vẽ
      return;
    }

    const screenPos = new Vec2(e.clientX, e.clientY);
    this.lastPointerScreen = screenPos;
    this.activePointers.set(e.pointerId, screenPos);

    // Chạm 2 ngón tay trên màn hình cảm ứng: Chuyển sang cử chỉ Phóng to/Thu nhỏ (Pinch Zoom) + Di chuyển 2 ngón (Pan)
    // CHỈ kích hoạt Pinch Zoom khi KHÔNG ở chế độ vẽ đa điểm
    if (!this.isMultiPointMode && this.activePointers.size >= 2) {
      this.isPinching = true;
      this.activeSessions.clear();
      this.isDragging = false;
      this.isPanning = false;
      this.isPanningChild = false;
      const pts = Array.from(this.activePointers.values());
      this.initialPinchDistance = pts[0].distanceTo(pts[1]);
      this.initialPinchZoom = this.camera.zoom;
      const midScreen = new Vec2((pts[0].x + pts[1].x) * 0.5, (pts[0].y + pts[1].y) * 0.5);
      this.initialPinchCenterWorld = this.camera.screenToWorld(midScreen);
      return;
    }

    // Giữ chuột giữa (button 1), chuột phải (button 2), phím Space, hoặc công cụ Pan
    if (e.button === 1 || e.button === 2 || e.spaceKey || this.isSpacePressed || this.activeTool === 'pan') {
      e.preventDefault();
      const hit = this.hitTestBoard(screenPos);

      // Nếu bấm vào thân đồ thị toán học -> Di chuyển hệ toạ độ Oxy bên trong đồ thị!
      if (hit && hit.action === 'graph-body') {
        this.selectedNodeId = hit.node.id;
        this.bringToFront(hit.node.id);
        this.isPanningChild = true;
        this.panningNode = hit.node;
        this.canvas.style.cursor = 'grabbing';
        this.updateHierarchyTree();
        this.updateNodeProperties();
        return;
      }

      // Mặc định: Di chuyển camera canvas mẹ vô tận
      this.isPanning = true;
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    if (e.button === 0) {
      const hit = this.hitTestBoard(screenPos);

      // 1. Nút Đóng / Xóa đối tượng [✕]
      if (hit && hit.action === 'close') {
        this.deleteBoard(hit.node.id);
        return;
      }

      // 2. Nút Chỉnh sửa hàm số đồ thị [✎]
      if (hit && hit.action === 'edit-graph') {
        this.openGraphEditor(hit.node);
        return;
      }

      // 3. Co giãn kích thước đối tượng (8 điểm neo Resize Handles)
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

      // 4. Kéo di chuyển đối tượng (Thanh tiêu đề đồ thị hoặc Thanh di chuyển ảnh)
      if (hit && hit.action === 'drag-widget') {
        this.selectedNodeId = hit.node.id;
        this.bringToFront(hit.node.id);
        this.isDragging = true;
        this.draggingNode = hit.node;
        this.dragInitialScreenPos = screenPos.clone();
        this.dragInitialTransform = hit.node.transform.clone();
        this.canvas.style.cursor = 'grabbing';
        this.updateHierarchyTree();
        this.updateNodeProperties();
        if (hit.node.graphData) {
          this.updateGraphExpressions(hit.node);
        }
        return;
      }

      // 5. CÔNG CỤ CHỌN (SELECT TOOL)
      if (this.activeTool === 'select') {
        if (hit) {
          this.selectedNodeId = hit.node.id;
          this.bringToFront(hit.node.id);
          this.isDragging = true;
          this.draggingNode = hit.node;
          this.dragInitialScreenPos = screenPos.clone();
          this.dragInitialTransform = hit.node.transform.clone();
          this.canvas.style.cursor = 'grabbing';
          if (hit.node.graphData) {
            this.updateGraphExpressions(hit.node);
          }
        } else {
          this.selectedNodeId = null;
          this.isPanning = true;
        }
        this.updateHierarchyTree();
        this.updateNodeProperties();
        return;
      }

      // 6. CÔNG CỤ BÚT VẼ (PEN TOOL) - Luôn vẽ trực tiếp lên Infinite Canvas mẹ!
      if (this.activeTool === 'pen') {
        const localPt = this.scene.screenToLocal(screenPos, this.scene.root.id, this.camera);
        this.updateHierarchyTree();
        this.updateNodeProperties();

        const newSession = {
          pointerId: e.pointerId,
          targetNodeId: this.scene.root.id,
          rawPoints: [new Point2D(localPt.x, localPt.y, (e.pressure > 0 ? e.pressure : 0.8))],
          color: this.brushColor,
          baseWidth: this.brushSize,
          brushType: this.brushType,
          getSmoothedPoints() {
            return CatmullRomSpline.smooth(this.rawPoints, 4);
          },
        };
        this.activeSessions.set(e.pointerId, newSession);
        return;
      }

      // 7. CÔNG CỤ TẨY (ERASER TOOL - OBJECT & SEGMENT)
      if (this.activeTool.startsWith('eraser')) {
        this.isErasing = true;
        this.performErase(screenPos, this.scene.root);
        return;
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

    // Luôn cập nhật vị trí ngón tay TRƯỚC — kể cả khi đang pinch
    // để activePointers có tọa độ chính xác cho tính curDist
    if (this.activePointers) {
      this.activePointers.set(e.pointerId, screenPos);
    }

    if (this.isPinching) {
      // Trong chế độ pinch: chỉ xử lý zoom/pan, bỏ qua mọi thứ khác
      if (!this.isMultiPointMode && this.activePointers && this.activePointers.size >= 2) {
        if (!this.initialPinchDistance || !this.initialPinchCenterWorld) {
          const pts = Array.from(this.activePointers.values());
          if (pts.length >= 2) {
            this.initialPinchDistance = Math.max(5, pts[0].distanceTo(pts[1]));
            this.initialPinchZoom = this.camera.zoom;
            const midScreen = new Vec2((pts[0].x + pts[1].x) * 0.5, (pts[0].y + pts[1].y) * 0.5);
            this.initialPinchCenterWorld = this.camera.screenToWorld(midScreen);
          }
        }

        if (this.initialPinchDistance && this.initialPinchCenterWorld) {
          const pts = Array.from(this.activePointers.values());
          if (pts.length >= 2) {
            const curDist = pts[0].distanceTo(pts[1]);
            const curMidScreen = new Vec2((pts[0].x + pts[1].x) * 0.5, (pts[0].y + pts[1].y) * 0.5);
            if (curDist > 5 && this.initialPinchDistance > 5) {
              const factor = curDist / this.initialPinchDistance;
              const newZoom = Math.max(0.05, Math.min(32.0, this.initialPinchZoom * factor));
              this.camera.zoom = newZoom;
              const screenCenter = new Vec2(this.camera.viewportWidth * 0.5, this.camera.viewportHeight * 0.5);
              this.camera.pan = this.initialPinchCenterWorld.sub(curMidScreen.sub(screenCenter).scale(1.0 / newZoom));
              this.updateZoomHUD();
              this.broadcastCurrentCameraSync();
            }
          }
        }
      }
      return;
    }

    // Xử lý phóng to/thu nhỏ 2 ngón tay (Pointer API fallback khi không có isPinching)
    if (!this.isMultiPointMode && this.activePointers && this.activePointers.size >= 2) {
      if (!this.initialPinchDistance || !this.initialPinchCenterWorld) {
        const pts = Array.from(this.activePointers.values());
        if (pts.length >= 2) {
          this.initialPinchDistance = Math.max(5, pts[0].distanceTo(pts[1]));
          this.initialPinchZoom = this.camera.zoom;
          const midScreen = new Vec2((pts[0].x + pts[1].x) * 0.5, (pts[0].y + pts[1].y) * 0.5);
          this.initialPinchCenterWorld = this.camera.screenToWorld(midScreen);
        }
      }

      if (this.initialPinchDistance && this.initialPinchCenterWorld) {
        const pts = Array.from(this.activePointers.values());
        if (pts.length >= 2) {
          const curDist = pts[0].distanceTo(pts[1]);
          const curMidScreen = new Vec2((pts[0].x + pts[1].x) * 0.5, (pts[0].y + pts[1].y) * 0.5);
          if (curDist > 5 && this.initialPinchDistance > 5) {
            const factor = curDist / this.initialPinchDistance;
            const newZoom = Math.max(0.05, Math.min(32.0, this.initialPinchZoom * factor));
            this.camera.zoom = newZoom;
            const screenCenter = new Vec2(this.camera.viewportWidth * 0.5, this.camera.viewportHeight * 0.5);
            this.camera.pan = this.initialPinchCenterWorld.sub(curMidScreen.sub(screenCenter).scale(1.0 / newZoom));
            this.updateZoomHUD();
            this.broadcastCurrentCameraSync();
          }
          return;
        }
      }
    }

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
      this.broadcastCurrentCameraSync();
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    // 2. Di chuyển camera sân khấu canvas mẹ (Mother Canvas Pan)
    if (this.isPanning || (e.buttons & 4) !== 0) {
      this.camera.pan = this.camera.pan.sub(delta.scale(1.0 / this.camera.zoom));
      this.updateZoomHUD();
      this.broadcastCurrentCameraSync();
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
      this.broadcastCurrentCameraSync();

      if (this.syncClient && this.syncClient.isConnected && !this.isApplyingRemoteSync) {
        const now = performance.now();
        if (!this._lastTransformSync || now - this._lastTransformSync >= 30) {
          this._lastTransformSync = now;
          this.syncClient.send('NODE_TRANSFORM', {
            clientId: this.clientId,
            nodeId: node.id,
            x: node.transform.tx,
            y: node.transform.ty,
            w: node.width,
            h: node.height,
          });
        }
      }
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
      this.broadcastCurrentCameraSync();

      if (this.syncClient && this.syncClient.isConnected && !this.isApplyingRemoteSync) {
        const now = performance.now();
        if (!this._lastTransformSync || now - this._lastTransformSync >= 30) {
          this._lastTransformSync = now;
          this.syncClient.send('NODE_TRANSFORM', {
            clientId: this.clientId,
            nodeId: this.draggingNode.id,
            x: this.draggingNode.transform.tx,
            y: this.draggingNode.transform.ty,
            w: this.draggingNode.width,
            h: this.draggingNode.height,
          });
        }
      }
      return;
    }

    // 5. Thêm điểm vẽ của cái bút đang thao tác (Hỗ trợ đa điểm / Multi-touch)
    const session = this.activeSessions.get(e.pointerId);
    if (session) {
      const localPt = this.scene.screenToLocal(screenPos, session.targetNodeId, this.camera);
      const lastPt = session.rawPoints[session.rawPoints.length - 1];

      if (lastPt.distanceTo(localPt) > 1.5) {
        session.rawPoints.push(
          new Point2D(localPt.x, localPt.y, (e.pressure > 0 ? e.pressure : 0.8))
        );

        // Phát sóng nét vẽ đang vẽ trực tiếp qua mạng LAN (Live Streaming)
        const targetId = session?.targetNodeId;
        const sharedRoot = this.getSharedRootForNode(targetId);

        if (this.syncClient && this.syncClient.isConnected) {
          const now = performance.now();
          if (!session._lastLiveSync || now - session._lastLiveSync >= 16) {
            session._lastLiveSync = now;
            const smoothed = session.getSmoothedPoints ? session.getSmoothedPoints() : session.rawPoints;
            // Chỉ gửi delta: các điểm mới kể từ lần sync trước để giảm payload
            const lastSentIdx = session._lastLiveSyncIdx || 0;
            const deltaPoints = smoothed.slice(lastSentIdx);
            session._lastLiveSyncIdx = smoothed.length;

            if (deltaPoints.length > 0) {
              const strokeSession = {
                targetNodeId: targetId,
                // Gửi full nếu lần đầu (để display có context), sau đó gửi delta
                points: lastSentIdx === 0
                  ? smoothed.map((p) => ({ x: p.x, y: p.y, pressure: p.pressure }))
                  : deltaPoints.map((p) => ({ x: p.x, y: p.y, pressure: p.pressure })),
                isDelta: lastSentIdx > 0,
                color: session.color,
                baseWidth: session.baseWidth,
                brushType: session.brushType,
              };

              // Gửi cho màn chiếu Canvas PC
              this.syncClient.send('CANVAS_STROKE_LIVE', {
                clientId: `${this.clientId}_${e.pointerId}`,
                session: strokeSession,
                sendTime: Date.now(),
              });

              // Gửi cho phòng bảng con (nếu có chia sẻ)
              if (sharedRoot) {
                this.syncClient.send('STROKE_LIVE', {
                  clientId: `${this.clientId}_${e.pointerId}`,
                  boardId: sharedRoot.id,
                  nodeId: targetId,
                  session: strokeSession,
                });
              }
            }
          }
        }
      }
    }

    // 6. Xử lý di chuột / ngón tay xóa liên tục (Continuous Drag Erasing)
    if (this.activeTool.startsWith('eraser')) {
      if (!this.eraserCursors) this.eraserCursors = new Map();
      this.eraserCursors.set(e.pointerId, {
        x: screenPos.x,
        y: screenPos.y,
        radius: this.eraserRadius,
      });
      this.eraserCursor = Array.from(this.eraserCursors.values());
      if (e.buttons === 1 || this.isErasing) {
        const hit = this.hitTestBoard(screenPos);
        const targetNode = hit && hit.action === 'body' ? hit.node : (hit ? hit.node : this.scene.root);
        if (targetNode) {
          this.performErase(screenPos, targetNode);
        }
      }
    } else {
      this.eraserCursor = null;
      if (this.eraserCursors) this.eraserCursors.clear();
    }

    // Cập nhật con trỏ chuột linh hoạt khi di chuyển tự do (Hover Cursor)
    if (!this.isDragging && !this.isResizing && !this.isPanning && !this.isPanningChild && this.activeSessions.size === 0) {
      const hoverHit = this.hitTestBoard(screenPos);
      if (hoverHit) {
        if (hoverHit.action === 'resize') {
          this.canvas.style.cursor = `${hoverHit.handle}-resize`;
        } else if (hoverHit.action === 'share' || hoverHit.action === 'maximize' || hoverHit.action === 'clear' || hoverHit.action === 'close' || hoverHit.action === 'undo' || hoverHit.action === 'redo' || hoverHit.action === 'insert-image' || hoverHit.action === 'add-child' || hoverHit.action === 'add-graph') {
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
    if (e.pointerType === 'touch') {
      try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    }

    if (this.activePointers) {
      this.activePointers.delete(e.pointerId);
      if (this.activePointers.size < 2) {
        if (this.initialPinchDistance) {
          this.justFinishedPinching = Date.now();
        }
        this.initialPinchDistance = null;
        this.initialPinchCenterWorld = null;
      }
    }

    if (this.eraserCursors) {
      this.eraserCursors.delete(e.pointerId);
      this.eraserCursor = this.eraserCursors.size > 0 ? Array.from(this.eraserCursors.values()) : null;
    }

    if (this.isPanning) {
      this.isPanning = false;
      this.broadcastCurrentCameraSync();
    }

    if (this.isPanningChild) {
      this.isPanningChild = false;
      this.panningNode = null;
      this.broadcastCurrentCameraSync();
    }

    if (this.isResizing) {
      const sharedRoot = this.getSharedRootForNode(this.resizingNode?.id);
      if (this.syncClient && this.syncClient.isConnected) {
        this.syncClient.send('NODE_TRANSFORM', {
          clientId: this.clientId,
          nodeId: this.resizingNode.id,
          boardId: sharedRoot ? sharedRoot.id : null,
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
      this.broadcastCurrentCameraSync();
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
        const sharedRoot = this.getSharedRootForNode(nodeId);
        if (this.syncClient && this.syncClient.isConnected) {
          const remainingIds = new Set(finalStrokes.map((s) => s.id));
          const removedIds = initialStrokes.filter((s) => !remainingIds.has(s.id)).map((s) => s.id);
          if (removedIds.length > 0) {
            this.syncClient.send('CANVAS_STROKE_ERASE', {
              nodeId,
              removedStrokeIds: removedIds,
            });
            if (sharedRoot) {
              this.syncClient.send('STROKE_ERASE', {
                clientId: this.clientId,
                boardId: sharedRoot.id,
                nodeId,
                removedStrokeIds: removedIds,
              });
            }
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
        const sharedRoot = this.getSharedRootForNode(this.draggingNode?.id);
        if (this.syncClient && this.syncClient.isConnected) {
          this.syncClient.send('NODE_TRANSFORM', {
            clientId: this.clientId,
            nodeId: this.draggingNode.id,
            boardId: sharedRoot ? sharedRoot.id : null,
            x: this.draggingNode.transform.tx,
            y: this.draggingNode.transform.ty,
            w: this.draggingNode.width,
            h: this.draggingNode.height,
          });
        }
      }
      this.draggingNode = null;
      this.dragInitialTransform = null;
      this.nodeDragInitialPos = null;
      this.broadcastCurrentCameraSync();
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

    // Hoàn tất nét vẽ của điểm chạm này (Hỗ trợ cả vẽ đơn điểm lẫn đa điểm / Multi-touch)
    const session = this.activeSessions.get(e.pointerId);
    if (session) {
      const smoothed = session.getSmoothedPoints ? session.getSmoothedPoints() : session.rawPoints;
      if (smoothed.length >= 2) {
        const stroke = new Stroke(
          smoothed,
          session.color,
          session.baseWidth,
          session.brushType
        );
        const cmd = new AddStrokeCommand(session.targetNodeId, stroke);
        this.executeCommand(cmd, session.targetNodeId);

        const targetId = session.targetNodeId;
        const sharedRoot = this.getSharedRootForNode(targetId);

        if (this.syncClient && this.syncClient.isConnected) {
          const streamClientId = `${this.clientId}_${e.pointerId}`;
          this.syncClient.send('CANVAS_STROKE_ADD', {
            nodeId: targetId,
            stroke: stroke.toJSON(),
            clientId: streamClientId,
            sendTime: Date.now(),
          });
          this.syncClient.send('CANVAS_STROKE_LIVE', {
            clientId: streamClientId,
            session: null,
          });
          if (sharedRoot) {
            this.syncClient.send('STROKE_ADD', {
              clientId: streamClientId,
              boardId: sharedRoot.id,
              nodeId: targetId,
              stroke: stroke.toJSON(),
            });
          }
        }
      }
      this.activeSessions.delete(e.pointerId);
      this.updateHierarchyTree();
    }
  }

  hitTestBoard(screenPos) {
    const children = this.scene.root.children;
    if (!children || children.length === 0) return null;

    const handleHitRadius = 14;

    for (let i = children.length - 1; i >= 0; i--) {
      const node = children[i];
      const screenTransform = this.scene.computeScreenTransform(node.id, this.camera);
      const screenBounds = node.localBounds().transform(screenTransform);
      const isSelected = this.selectedNodeId === node.id;
      const localPt = this.scene.screenToLocal(screenPos, node.id, this.camera);

      // 1. Kiểm tra 8 điểm neo Resize (khi đối tượng đang được chọn)
      if (isSelected) {
        const handles = [
          { name: 'nw', x: screenBounds.minX, y: screenBounds.minY },
          { name: 'ne', x: screenBounds.maxX, y: screenBounds.minY },
          { name: 'se', x: screenBounds.maxX, y: screenBounds.maxY },
          { name: 'sw', x: screenBounds.minX, y: screenBounds.maxY },
          { name: 'n', x: (screenBounds.minX + screenBounds.maxX) * 0.5, y: screenBounds.minY },
          { name: 's', x: (screenBounds.minX + screenBounds.maxX) * 0.5, y: screenBounds.maxY },
          { name: 'e', x: screenBounds.maxX, y: (screenBounds.minY + screenBounds.maxY) * 0.5 },
          { name: 'w', x: screenBounds.minX, y: (screenBounds.minY + screenBounds.maxY) * 0.5 },
        ];

        for (const handle of handles) {
          if (Math.hypot(screenPos.x - handle.x, screenPos.y - handle.y) <= handleHitRadius) {
            return { node, action: 'resize', handle: handle.name, localPt };
          }
        }
      }

      // 2. Đối tượng là Ảnh (Image Widget)
      if (node.image) {
        // Nếu ảnh đang chọn: kiểm tra thanh thao tác di chuyển / nút xóa phía trên ảnh
        if (isSelected) {
          const pillH = 26;
          const pillW = Math.min(screenBounds.width, 160);
          const pillX = screenBounds.minX + (screenBounds.width - pillW) * 0.5;
          const pillY = Math.max(8, screenBounds.minY - pillH - 6);

          // Nút xóa [✕] trên thanh di chuyển
          const closeBtnX = pillX + pillW - 14;
          const closeBtnY = pillY + pillH * 0.5;
          if (Math.hypot(screenPos.x - closeBtnX, screenPos.y - closeBtnY) <= 12) {
            return { node, action: 'close', localPt };
          }

          // Vùng thanh di chuyển
          if (
            screenPos.x >= pillX &&
            screenPos.x <= pillX + pillW &&
            screenPos.y >= pillY &&
            screenPos.y <= pillY + pillH
          ) {
            return { node, action: 'drag-widget', localPt };
          }
        }

        // Bấm trong thân ảnh
        if (
          screenPos.x >= screenBounds.minX &&
          screenPos.x <= screenBounds.maxX &&
          screenPos.y >= screenBounds.minY &&
          screenPos.y <= screenBounds.maxY
        ) {
          return { node, action: 'image-body', localPt };
        }
      }

      // 3. Đối tượng là Đồ Thị Toán Học (Graph Widget)
      if (node.graphData) {
        const headerH = Math.max(24, Math.min(30, 26 * Math.min(this.camera.zoom, 1.2)));

        // Thanh tiêu đề Header
        if (
          screenPos.x >= screenBounds.minX &&
          screenPos.x <= screenBounds.maxX &&
          screenPos.y >= screenBounds.minY &&
          screenPos.y <= screenBounds.minY + headerH
        ) {
          const centerY = screenBounds.minY + headerH * 0.5;

          // Nút Xóa [✕]
          const delX = screenBounds.maxX - 14;
          if (Math.hypot(screenPos.x - delX, screenPos.y - centerY) <= 12) {
            return { node, action: 'close', localPt };
          }

          // Nút Chỉnh Sửa Hàm Số [✎]
          if (screenBounds.width >= 60) {
            const editX = screenBounds.maxX - 36;
            if (Math.hypot(screenPos.x - editX, screenPos.y - centerY) <= 12) {
              return { node, action: 'edit-graph', localPt };
            }
          }

          // Kéo di chuyển bảng đồ thị
          return { node, action: 'drag-widget', localPt };
        }

        // Vùng thân đồ thị (Math Coordinate Plane)
        if (
          screenPos.x >= screenBounds.minX &&
          screenPos.x <= screenBounds.maxX &&
          screenPos.y >= screenBounds.minY + headerH &&
          screenPos.y <= screenBounds.maxY
        ) {
          return { node, action: 'graph-body', localPt };
        }
      }
    }

    return null;
  }

  enterFocusMode(node) {
    if (!node || node.id === this.scene.root.id) return;
    if (this.isFocusMode && this.focusNodeId === node.id) return;

    if (!this.isFocusMode) {
      this.savedPreFocusCamera = {
        zoom: this.camera.zoom,
        pan: this.camera.pan.clone ? this.camera.pan.clone() : new Vec2(this.camera.pan.x, this.camera.pan.y),
      };
    }

    this.isFocusMode = true;
    this.focusNodeId = node.id;
    this.selectedNodeId = node.id;

    // BẢO TOÀN BỐ CỤC BẢNG CHÍNH 100%:
    // 1. Tuyệt đối KHÔNG gọi bringToFront để không xáo trộn mảng children và z-index của các bảng!
    // 2. Tuyệt đối KHÔNG thay đổi node.transform (x, y, w, h) của bảng!
    // 3. Mặc định KHÔNG gửi camera sync sang Màn Chiếu để Màn Chiếu PC giữ nguyên toàn cảnh các bảng!

    const isMobile = window.innerWidth <= 768 || this.isSingleBoardMode;
    const paddingX = isMobile ? 14 : 64;
    const paddingTop = isMobile ? 76 : 88;
    const paddingBottom = isMobile ? 84 : 72;

    const availW = Math.max(160, window.innerWidth - paddingX * 2);
    const availH = Math.max(160, window.innerHeight - (paddingTop + paddingBottom));

    const worldTransform = this.scene.computeWorldTransform(node.id);
    const worldScale = Math.hypot(worldTransform.a, worldTransform.b) || 1.0;
    const worldW = (node.width || 800) * worldScale;
    const worldH = (node.height || 600) * worldScale;

    const zoomW = availW / worldW;
    const zoomH = availH / worldH;
    const targetZoom = Math.max(0.1, Math.min(8.0, Math.min(zoomW, zoomH)));

    const worldCenter = worldTransform.transformPoint(new Vec2(node.width * 0.5, node.height * 0.5));
    const offsetYInWorld = ((paddingTop - paddingBottom) * 0.5) / targetZoom;

    this.camera.zoom = targetZoom;
    this.camera.pan = new Vec2(worldCenter.x, worldCenter.y - offsetYInWorld);

    this.updateFocusModeUI();
    this.updateZoomHUD();
    this.updateHierarchyTree();
    this.updateNodeProperties();

    if (this.focusSyncDisplay) {
      this.broadcastCurrentCameraSync();
    }
  }

  exitFocusMode() {
    if (!this.isFocusMode) return;

    if (this.savedPreFocusCamera) {
      this.camera.zoom = this.savedPreFocusCamera.zoom;
      this.camera.pan = this.savedPreFocusCamera.pan.clone ? this.savedPreFocusCamera.pan.clone() : new Vec2(this.savedPreFocusCamera.pan.x, this.savedPreFocusCamera.pan.y);
      this.savedPreFocusCamera = null;
    }

    this.isFocusMode = false;
    this.focusNodeId = null;

    this.updateFocusModeUI();
    this.updateZoomHUD();
    this.updateHierarchyTree();
    this.updateNodeProperties();

    // Khôi phục lại góc nhìn toàn cảnh của display nếu trước đó đang bật đồng bộ
    if (this.focusSyncDisplay) {
      this.broadcastCurrentCameraSync();
    }
  }

  toggleFocusMode(node) {
    if (!node || node.id === this.scene.root.id) return;
    if (this.isFocusMode && this.focusNodeId === node.id) {
      this.exitFocusMode();
    } else {
      this.enterFocusMode(node);
    }
  }

  toggleFocusDisplaySync() {
    this.focusSyncDisplay = !this.focusSyncDisplay;
    this.updateFocusModeUI();
    if (this.focusSyncDisplay) {
      this.broadcastCurrentCameraSync();
    } else if (this.savedPreFocusCamera && this.syncClient && this.syncClient.isConnected) {
      this.syncClient.send('CANVAS_CAMERA_SYNC', {
        zoom: this.savedPreFocusCamera.zoom,
        pan: { x: this.savedPreFocusCamera.pan.x, y: this.savedPreFocusCamera.pan.y },
        viewport: { w: window.innerWidth, h: window.innerHeight },
      });
    }
  }

  updateFocusModeUI() {
    const focusBar = document.getElementById('focus-mode-bar');
    const titleEl = document.getElementById('focus-mode-board-title');
    const syncText = document.getElementById('focus-sync-text');
    const syncBtn = document.getElementById('btn-focus-toggle-display');
    const appContainer = document.getElementById('app');

    if (this.isFocusMode && this.focusNodeId) {
      const node = this.scene.getNode(this.focusNodeId);
      if (focusBar) focusBar.style.display = 'flex';
      if (titleEl) titleEl.textContent = `Bảng: ${node ? node.name : 'Bảng Con'}`;
      if (appContainer) appContainer.classList.add('in-focus-mode');

      if (syncBtn) {
        if (this.focusSyncDisplay) {
          syncBtn.classList.add('syncing');
          if (syncText) syncText.textContent = 'Màn Chiếu: Đang Phóng To';
        } else {
          syncBtn.classList.remove('syncing');
          if (syncText) syncText.textContent = 'Màn Chiếu: Giữ Toàn Cảnh';
        }
      }
    } else {
      if (focusBar) focusBar.style.display = 'none';
      if (appContainer) appContainer.classList.remove('in-focus-mode');
    }
  }

  focusBoardFullscreen(node) {
    this.toggleFocusMode(node);
  }

  clearBoard(node) {
    if (node.elements.length === 0 && (!node.images || node.images.length === 0)) return;
    const cmd = new EraseCommand(node.id, [...node.elements], []);
    this.executeCommand(cmd, node.id);
    this.updateHierarchyTree();
    this.updateNodeProperties();
    if (this.syncClient && this.syncClient.isConnected && !this.isApplyingRemoteSync) {
      this.syncClient.send('NODE_CLEAR', {
        clientId: this.clientId,
        nodeId: node.id,
      });
    }
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
    const sharedRoot = this.getSharedRootForNode(nodeId);
    parentNode.removeChild(nodeId);
    if (this.selectedNodeId === nodeId) {
      this.selectedNodeId = parentNode.id !== this.scene.root.id ? parentNode.id : (this.scene.root.children.length > 0 ? this.scene.root.children[0].id : null);
    }
    if (this.syncClient && this.syncClient.isConnected && !this.isApplyingRemoteSync) {
      this.syncClient.send('NODE_DELETE', {
        clientId: this.clientId,
        boardId: sharedRoot ? sharedRoot.id : null,
        nodeId: nodeId,
      });
    }
    this.updateHierarchyTree();
    this.updateNodeProperties();
    this.updateUI();
    this.scheduleContentSave();
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
      this.broadcastCurrentCameraSync();
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
    this.broadcastCurrentCameraSync();
  }

  zoomAroundScreenCenter(factor) {
    const center = new Vec2(window.innerWidth * 0.5, window.innerHeight * 0.5);
    this.zoomAtAnchor(center, factor);
  }

  onKeyDown(e) {
    if (e.key === 'Escape') {
      if (this.isFocusMode) {
        this.exitFocusMode();
        e.preventDefault();
        return;
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      if (e.shiftKey) {
        this.redo();
      } else {
        this.undo();
      }
      e.preventDefault();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      this.saveManualWorkspace();
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
    } else if (e.key.toLowerCase() === 'm') {
      this.toggleMultiPointMode();
    } else if (e.key.toLowerCase() === 'f' && !e.ctrlKey && !e.metaKey && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
      if (this.isFocusMode) {
        this.exitFocusMode();
      } else if (this.selectedNodeId && this.selectedNodeId !== this.scene.root.id) {
        const node = this.scene.getNode(this.selectedNodeId);
        if (node) this.toggleFocusMode(node);
      } else {
        this.fitAllContent();
      }
      e.preventDefault();
    } else if (e.key === '0') {
      this.fitAllContent();
    } else if (e.key === 'PageUp' || (e.key === '[' && !e.ctrlKey && !e.metaKey && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA')) {
      if (this.currentPageIndex > 0) {
        this.switchToPage(this.currentPageIndex - 1);
        e.preventDefault();
      }
    } else if (e.key === 'PageDown' || (e.key === ']' && !e.ctrlKey && !e.metaKey && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA')) {
      if (this.currentPageIndex < this.pages.length - 1) {
        this.switchToPage(this.currentPageIndex + 1);
        e.preventDefault();
      }
    }
  }

  undoNode(node) {
    if (node && node.history && node.history.canUndo()) {
      node.history.undo(this.scene);
      this.updateHierarchyTree();
      this.updateNodeProperties();
      this.scheduleContentSave();
      return;
    }
    if (this.history.canUndo()) {
      this.history.undo(this.scene);
      this.updateHierarchyTree();
      this.updateNodeProperties();
      this.scheduleContentSave();
    }
  }

  redoNode(node) {
    if (node && node.history && node.history.canRedo()) {
      node.history.redo(this.scene);
      this.updateHierarchyTree();
      this.updateNodeProperties();
      this.scheduleContentSave();
      return;
    }
    if (this.history.canRedo()) {
      this.history.redo(this.scene);
      this.updateHierarchyTree();
      this.updateNodeProperties();
      this.scheduleContentSave();
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

  createNewBoard(targetParent) {
    // Version 2: Loại bỏ hoàn toàn bảng con lồng nhau. Toàn bộ nét vẽ nằm trên Canvas vô tận.
    return null;
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
    this.broadcastCurrentCameraSync();
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

  openGraphEditor(node) {
    if (!node) return;
    this.selectedNodeId = node.id;
    const inspector = document.getElementById('inspector-panel');
    if (inspector) inspector.classList.add('open');
    this.updateHierarchyTree();
    this.updateGraphExpressions(node);
  }

  centerCameraOnNode(node) {
    if (!node) return;
    const screenCenter = new Vec2(window.innerWidth * 0.5, window.innerHeight * 0.5);
    const worldCenter = new Vec2(node.transform.tx + node.width * 0.5, node.transform.ty + node.height * 0.5);
    this.camera.pan.x = worldCenter.x - (screenCenter.x / this.camera.zoom);
    this.camera.pan.y = worldCenter.y - (screenCenter.y / this.camera.zoom);
    this.broadcastCurrentCameraSync();
  }

  updateHierarchyTree() {
    const container = document.getElementById('tree-list');
    if (!container) return;
    container.innerHTML = '';

    const objects = this.scene.root.children;

    if (!objects || objects.length === 0) {
      container.innerHTML = `
        <div style="padding: 16px 10px; font-size: 11.5px; color: var(--text-muted); text-align: center; line-height: 1.6;">
          Chưa có ảnh hoặc đồ thị nào.<br>
          <span style="font-size: 10.5px; opacity: 0.75;">Bấm <b>+ Đồ Thị</b> hoặc <b>Chèn Ảnh</b> ở thanh trên để thêm.</span>
        </div>
      `;
      const activeBadge = document.getElementById('stat-active-board');
      if (activeBadge) activeBadge.textContent = 'Toàn bộ canvas';
      const statNodes = document.getElementById('stat-nodes');
      if (statNodes) statNodes.textContent = '0';
      const statStrokes = document.getElementById('stat-strokes');
      if (statStrokes) statStrokes.textContent = this.scene.root.elements.length;
      return;
    }

    for (const node of objects) {
      const item = document.createElement('div');
      item.className = `tree-item ${node.id === this.selectedNodeId ? 'selected' : ''}`;
      item.style.padding = '6px 8px';
      item.style.display = 'flex';
      item.style.alignItems = 'center';
      item.style.justifyContent = 'space-between';
      item.style.borderRadius = '6px';
      item.style.marginBottom = '3px';
      item.style.cursor = 'pointer';

      const icon = node.image ? '🖼️' : (node.graphData ? '📈' : '📄');
      const name = node.name || (node.image ? 'Hình Ảnh' : 'Đồ Thị');

      item.innerHTML = `
        <div style="display: flex; align-items: center; gap: 6px; overflow: hidden; flex: 1;">
          <span style="font-size: 13px;">${icon}</span>
          <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px; font-weight: 500;">${name}</span>
        </div>
        <div style="display: flex; align-items: center; gap: 4px;">
          <button class="btn-obj-center" title="Định vị & phóng tới đối tượng này" style="background: rgba(88,166,255,0.12); border: 1px solid rgba(88,166,255,0.3); color: #58a6ff; cursor: pointer; font-size: 11px; padding: 2px 5px; border-radius: 4px;">🔍</button>
          ${node.graphData ? `<button class="btn-obj-edit" title="Chỉnh sửa hàm số" style="background: rgba(63,185,80,0.15); border: 1px solid rgba(63,185,80,0.3); color: #3fb950; cursor: pointer; font-size: 11px; padding: 2px 5px; border-radius: 4px;">✎</button>` : ''}
          <button class="btn-obj-del" title="Xóa đối tượng này" style="background: rgba(248,81,73,0.15); border: 1px solid rgba(248,81,73,0.3); color: #f85149; cursor: pointer; font-size: 11px; padding: 2px 5px; border-radius: 4px;">✕</button>
        </div>
      `;

      // Zoom to object
      const centerBtn = item.querySelector('.btn-obj-center');
      if (centerBtn) {
        centerBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.selectedNodeId = node.id;
          this.centerCameraOnNode(node);
          this.updateHierarchyTree();
          this.updateNodeProperties();
        });
      }

      // Edit graph expressions
      const editBtn = item.querySelector('.btn-obj-edit');
      if (editBtn) {
        editBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.openGraphEditor(node);
        });
      }

      // Delete object
      const delBtn = item.querySelector('.btn-obj-del');
      if (delBtn) {
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.deleteBoard(node.id);
        });
      }

      // Select object
      item.addEventListener('click', () => {
        this.selectedNodeId = node.id;
        this.bringToFront(node.id);
        this.updateHierarchyTree();
        this.updateNodeProperties();
        if (node.graphData) {
          this.updateGraphExpressions(node);
        }
      });

      container.appendChild(item);
    }

    const activeNode = this.scene.getNode(this.selectedNodeId);
    const activeBadge = document.getElementById('stat-active-board');
    if (activeBadge) {
      activeBadge.textContent = activeNode ? `Đang chọn: ${activeNode.name.split(':')[0]}` : 'Toàn bộ canvas';
    }

    const statNodes = document.getElementById('stat-nodes');
    if (statNodes) statNodes.textContent = objects.length;
    const statStrokes = document.getElementById('stat-strokes');
    if (statStrokes) statStrokes.textContent = this.scene.root.elements.length;
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

  createDesmosBoard() {
    this.graphCounter = (this.graphCounter || 0) + 1;
    const count = this.graphCounter;
    const parent = this.scene.root;

    const desmosW = 720;
    const desmosH = 500;

    const screenCenter = new Vec2(window.innerWidth * 0.5, window.innerHeight * 0.5);
    const worldPos = this.camera.screenToWorld(screenCenter);
    const posX = worldPos.x - desmosW * 0.5;
    const posY = worldPos.y - desmosH * 0.5;

    const defaultGraphData = {
      xSpan: 20,
      expressions: [
        { id: 'exp_1', expr: 'sin(x)', color: '#58a6ff', visible: true },
        { id: 'exp_2', expr: '0.2 * x^2 - 3', color: '#f85149', visible: true },
      ],
      params: { a: 1.0, b: 1.0 },
    };

    const desmosNode = new CanvasNode(
      `Đồ Thị ${count}`,
      desmosW,
      desmosH,
      Transform2D.fromTranslation(posX, posY),
      null,
      defaultGraphData,
      this.globalTheme || this.scene.root.style || 'chalkboard',
      this.globalGrid || this.scene.root.gridType || 'grid'
    );

    this.history.execute(new CreateNodeCommand(parent.id, desmosNode), this.scene);
    this.selectedNodeId = desmosNode.id;

    // Phát sóng NODE_CREATE đến toàn bộ các thiết bị đang mở app (Phone, Web, Display)
    const sharedRoot = this.getSharedRootForNode(parent.id);
    if (this.syncClient && this.syncClient.isConnected && !this.isApplyingRemoteSync) {
      this.syncClient.send('NODE_CREATE', {
        clientId: this.clientId,
        boardId: sharedRoot ? sharedRoot.id : null,
        parentId: parent.id,
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

        <!-- Chia sẻ qua Socket (Từng Bảng Con) -->
        <div style="margin-top:6px; padding:8px 10px; background:rgba(88,166,255,0.06); border-radius:6px; border:1px solid rgba(88,166,255,0.2);">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-size:11px; font-weight:600; color:#58a6ff;">Chia sẻ qua Socket:</span>
            <span style="font-size:10px; color:${node.isShared ? '#3fb950' : '#8b949e'}; font-weight:600;">${node.isShared ? '🟢 Đang bật' : '⚪ Đang tắt'}</span>
          </div>
          <button id="btn-prop-share-board" class="btn-action ${node.isShared ? 'primary' : ''}" style="width:100%; margin-top:6px; padding:5px 8px; font-size:11px; justify-content:center; display:flex; align-items:center; gap:6px; cursor:pointer;">
            📡 ${node.isShared ? 'Cài Đặt & Xem Mã QR' : 'Bật Chia Sẻ Bảng Này'}
          </button>
        </div>

        <!-- Chế Độ Tập Trung (Bảo toàn bố cục bảng chính) -->
        <button id="btn-prop-focus-mode" class="btn-action" style="width:100%; margin-top:8px; padding:6px 10px; font-size:11px; justify-content:center; display:flex; align-items:center; gap:6px; cursor:pointer; color:#d2a8ff; border-color:rgba(188,140,255,0.4); background:rgba(188,140,255,0.12); font-weight:600;">
          🎯 ${this.isFocusMode && this.focusNodeId === node.id ? 'Thoát Chế Độ Tập Trung (Esc)' : 'Chế Độ Tập Trung (Bảo Toàn Bố Cục)'}
        </button>
    `;

    html += `</div>`;
    propPanel.innerHTML = html;

    // Event listeners
    const propFocusBtn = document.getElementById('btn-prop-focus-mode');
    if (propFocusBtn) {
      propFocusBtn.addEventListener('click', () => {
        this.toggleFocusMode(node);
      });
    }
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
        this.saveStateImmediately();
        if (this.syncClient && this.syncClient.isConnected) {
          this.syncClient.send('CANVAS_STYLE', {
            nodeId: node.id,
            style: newTheme,
          });
          this.broadcastCanvasMirror();
        }
      });
    }

    const gridSelect = document.getElementById('prop-node-grid');
    if (gridSelect) {
      gridSelect.addEventListener('change', (e) => {
        node.gridType = e.target.value;
        this.saveStateImmediately();
        if (this.syncClient && this.syncClient.isConnected) {
          this.syncClient.send('CANVAS_STYLE', {
            nodeId: node.id,
            gridType: e.target.value,
          });
          this.broadcastCanvasMirror();
        }
      });
    }
    const propShareBtn = document.getElementById('btn-prop-share-board');
    if (propShareBtn) {
      propShareBtn.addEventListener('click', () => {
        this.openBoardShareModal(node);
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
      input.onchange = () => {
        this.broadcastGraphExpr(node);
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
    const sharedRoot = this.getSharedRootForNode(node?.id);
    if (sharedRoot && this.syncClient && this.syncClient.isConnected && !this.isApplyingRemoteSync && node && node.graphData) {
      this.syncClient.send('GRAPH_EXPR', {
        clientId: this.clientId,
        boardId: sharedRoot.id,
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

    this.globalTheme = this.globalTheme || this.scene.root.style || 'chalkboard';
    this.globalGrid = this.globalGrid || this.scene.root.gridType || 'grid';

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
      const currentThemeId = this.globalTheme || 'chalkboard';
      const currentGridId = this.globalGrid || 'grid';
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
    this.saveStateImmediately();

    if (this.syncClient && this.syncClient.isConnected && !this.isApplyingRemoteSync) {
      this.syncClient.send('CANVAS_STYLE', {
        clientId: this.clientId,
        style: themeId,
        isGlobal: true,
      });
      this.broadcastCanvasMirror();

      if (this.isSingleBoardMode && this.singleBoardId) {
        this.syncClient.send('NODE_STYLE', {
          clientId: this.clientId,
          boardId: this.singleBoardId,
          style: themeId,
          isGlobal: true,
        });
      } else {
        for (const child of this.scene.root.children) {
          if (child.isShared) {
            this.syncClient.send('NODE_STYLE', {
              clientId: this.clientId,
              boardId: child.id,
              style: themeId,
              isGlobal: true,
            });
          }
        }
      }
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
    this.saveStateImmediately();

    if (this.syncClient && this.syncClient.isConnected && !this.isApplyingRemoteSync) {
      this.syncClient.send('CANVAS_STYLE', {
        clientId: this.clientId,
        gridType: gridId,
        isGlobal: true,
      });
      this.broadcastCanvasMirror();

      if (this.isSingleBoardMode && this.singleBoardId) {
        this.syncClient.send('NODE_STYLE', {
          clientId: this.clientId,
          boardId: this.singleBoardId,
          gridType: gridId,
          isGlobal: true,
        });
      } else {
        for (const child of this.scene.root.children) {
          if (child.isShared) {
            this.syncClient.send('NODE_STYLE', {
              clientId: this.clientId,
              boardId: child.id,
              gridType: gridId,
              isGlobal: true,
            });
          }
        }
      }
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

  copyToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const successful = document.execCommand('copy');
        document.body.removeChild(textarea);
        if (successful) resolve();
        else reject(new Error('Copy failed'));
      } catch (err) {
        reject(err);
      }
    });
  }

  copyOcrText() {
    if (!this.ocrPillTextEl) return;
    const text = this.ocrPillTextEl.textContent.trim();
    if (text) {
      this.copyToClipboard(text).then(() => {
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
    if (this.syncClient && this.syncClient.isConnected && !this.isApplyingRemoteSync) {
      this.syncClient.send('NODE_CREATE', {
        clientId: this.clientId,
        parentId: parentNode.id,
        node: textNode.toJSON(),
      });
    }

    this.selectedNodeId = textNode.id;
    this.hideOcrPill();
    this.updateHierarchyTree();
    this.updateNodeProperties();
    this.showToast('✨ Đã chuyển đổi thành công sang Bảng Văn Bản!', 3000);
  }

  /**
   * Xác định xem một node hoặc nodeId có thuộc phạm vi của bảng con được chia sẻ nào không.
   * Nếu có, trả về node gốc của bảng được chia sẻ đó (dùng làm roomId trên WebSocket).
   * Bảng Mẹ (root / world canvas) và các bảng không chia sẻ luôn trả về null.
   */
  getSharedRootForNode(nodeOrId) {
    if (!nodeOrId) return null;
    const nodeId = typeof nodeOrId === 'string' ? nodeOrId : nodeOrId.id;
    if (!nodeId || nodeId === this.scene.root.id) return null;

    if (this.isSingleBoardMode) {
      if (nodeId === this.singleBoardId) {
        return this.scene.getNode(this.singleBoardId);
      }
      const sharedRoot = this.scene.getNode(this.singleBoardId);
      if (sharedRoot && (sharedRoot.findNode(nodeId) || sharedRoot.id === nodeId)) {
        return sharedRoot;
      }
      return null;
    }

    // Host mode: Duyệt ngược lên cây để tìm tổ tiên cao nhất (dưới scene.root) có isShared === true
    const node = this.scene.getNode(nodeId);
    if (!node) return null;

    let curr = node;
    let sharedAncestor = null;
    while (curr && curr.id !== this.scene.root.id) {
      if (curr.isShared) {
        sharedAncestor = curr;
      }
      curr = this.scene.findParentNode(curr.id);
    }
    return sharedAncestor;
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

    // Single Board Mode HUD elements
    const singleBanner = document.getElementById('single-board-banner');
    const singleName = document.getElementById('single-board-name');
    const singlePresence = document.getElementById('single-board-presence');
    const btnSingleFit = document.getElementById('btn-single-board-fit');
    const btnSingleExit = document.getElementById('btn-single-board-exit');

    // Board Share Modal elements
    const modalBoardShare = document.getElementById('modal-board-share');
    const btnCloseBoardShare = document.getElementById('btn-close-board-share');
    const toggleBoardShare = document.getElementById('toggle-board-share');
    const btnCopyBoardUrl = document.getElementById('btn-copy-board-url');
    const inputBoardUrl = document.getElementById('input-board-share-url');

    const isMobileClient = !!(window.Capacitor?.isNativePlatform() || window.location.protocol === 'capacitor:' || (window.location.hostname === 'localhost' && (!window.location.port || window.location.port === '')) || (typeof window !== 'undefined' && window.innerWidth <= 768 && !window.location.search.includes('display')));

    this.syncClient = new SyncClient({
      onPresence: (count, localIp, sharedBoards) => {
        if (labelPresence) {
          labelPresence.textContent = isMobileClient ? 'Đã đồng bộ' : `${count} Thiết Bị`;
        }
        if (modalStatus) modalStatus.textContent = `🟢 Đang hoạt động (${count} thiết bị)`;
        const port = window.location.port || '3000';
        const url = `http://${localIp}:${port}`;
        if (inputUrl) inputUrl.value = url;
        this.renderQRCode(url);

        // Update presence for currently active single board
        if (this.isSingleBoardMode && this.singleBoardId) {
          const bCount = this.syncClient.getBoardPresence(this.singleBoardId) || count;
          if (singlePresence) singlePresence.textContent = `(${bCount} thiết bị)`;
          const mobPresence = document.getElementById('mobile-board-presence');
          if (mobPresence) mobPresence.textContent = `${bCount} thiết bị`;
        }
      },
      onBoardPresence: (boardId, count) => {
        if (this.isSingleBoardMode && this.singleBoardId === boardId) {
          if (singlePresence) singlePresence.textContent = `(${count} thiết bị)`;
          const mobPresence = document.getElementById('mobile-board-presence');
          if (mobPresence) mobPresence.textContent = `${count} thiết bị`;
        }
        if (this.currentSharingBoardNode && this.currentSharingBoardNode.id === boardId) {
          const badge = document.getElementById('board-presence-badge');
          if (badge) badge.textContent = `🟢 ${count} thiết bị`;
        }
      },
      onStatus: (connected) => {
        if (dotStatus) {
          dotStatus.style.background = connected ? '#3fb950' : '#f85149';
          dotStatus.style.boxShadow = connected ? '0 0 8px #3fb950' : '0 0 6px #f85149';
        }
        if (labelPresence) {
          labelPresence.textContent = isMobileClient
            ? (connected ? 'Đã đồng bộ' : 'Chưa đồng bộ')
            : (connected ? `${this.syncClient.presenceCount} Thiết Bị` : 'Ngoại tuyến');
        }
        if (btnSync) {
          btnSync.style.color = connected ? '#3fb950' : '#f85149';
          btnSync.style.borderColor = connected ? 'rgba(63,185,80,0.45)' : 'rgba(248,81,73,0.35)';
          btnSync.style.background = connected ? 'rgba(63,185,80,0.12)' : 'rgba(248,81,73,0.08)';
          btnSync.title = connected
            ? `🟢 Đang đồng bộ với Màn hình (${this.syncClient.getHost()}). Bấm để phát lại bài giảng.`
            : '🔴 Chưa đồng bộ màn hình. Bấm để kết nối.';
        }
        if (modalStatus) {
          modalStatus.textContent = connected
            ? `🟢 Đang kết nối (${this.syncClient.presenceCount} thiết bị)`
            : '🔴 Đang thử kết nối lại...';
          modalStatus.style.color = connected ? '#3fb950' : '#f85149';
        }
        const pillHost = document.getElementById('lan-server-host-pill');
        if (pillHost) {
          pillHost.textContent = connected ? `🟢 Đã nối: ${this.syncClient.getHost()}` : `🔴 Chưa nối: ${this.syncClient.getHost()}`;
          pillHost.style.color = connected ? '#3fb950' : '#f85149';
          pillHost.style.background = connected ? 'rgba(63,185,80,0.15)' : 'rgba(248,81,73,0.15)';
        }
        if (connected) {
          this.broadcastCanvasMirror();
        }
      },
      onDiscovered: (ip, data) => {
        const inputServerHost = document.getElementById('input-server-host');
        if (inputServerHost) inputServerHost.value = ip;
        const scanStatus = document.getElementById('lan-scan-status-text');
        if (scanStatus) {
          scanStatus.style.display = 'block';
          scanStatus.style.color = '#3fb950';
          scanStatus.textContent = `🎉 Đã tìm thấy Màn hình (${ip})!`;
        }

        // Tự động hoàn thành và đóng màn hình chờ Sync Gate
        if (syncGateOverlay && syncGateOverlay.style.display !== 'none') {
          if (syncGateTitle) syncGateTitle.textContent = `Đã Tìm Thấy Màn Hình: ${ip}!`;
          if (syncGateDesc) syncGateDesc.textContent = `Đang kết nối ${data?.name || 'Màn hình tương tác'} & đồng bộ bài giảng...`;
          if (syncGateProgressFill) syncGateProgressFill.style.width = '100%';
          if (syncGateSpinner) syncGateSpinner.textContent = '✅';
          if (syncGateIpHint) syncGateIpHint.textContent = `Tự động ghép nối thành công`;
          setTimeout(closeSyncGate, 600);
        }

        this.showToast(`🎉 Đã tự động kết nối Màn hình tương tác tại ${ip}!`, 3500);
      },
    });

    // Kết nối cấu hình Máy chủ Backend (cho APK / điện thoại)
    const inputServerHost = document.getElementById('input-server-host');
    const btnSaveServerHost = document.getElementById('btn-save-server-host');
    const btnAutoDiscoverLan = document.getElementById('btn-auto-discover-lan');
    const lanScanStatus = document.getElementById('lan-scan-status-text');
    const lanScanIcon = document.getElementById('lan-scan-icon');
    const lanScanBtnLabel = document.getElementById('lan-scan-btn-label');

    if (inputServerHost) {
      inputServerHost.value = this.syncClient.getHost();
    }
    if (btnSaveServerHost && inputServerHost) {
      btnSaveServerHost.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = inputServerHost.value.trim();
        if (val) {
          this.syncClient.setHost(val);
          btnSaveServerHost.textContent = '✓ Đang nối...';
          setTimeout(() => {
            btnSaveServerHost.textContent = 'Lưu & Kết Nối';
          }, 1500);
        }
      });
    }

    if (btnAutoDiscoverLan) {
      btnAutoDiscoverLan.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (btnAutoDiscoverLan.disabled) return;
        btnAutoDiscoverLan.disabled = true;
        if (lanScanIcon) lanScanIcon.textContent = '⏳';
        if (lanScanBtnLabel) lanScanBtnLabel.textContent = 'Đang quét mạng Wi-Fi...';
        if (lanScanStatus) {
          lanScanStatus.style.display = 'block';
          lanScanStatus.style.color = '#58a6ff';
          lanScanStatus.textContent = '🔍 Đang dò quét tìm máy tính PC trong cùng mạng Wi-Fi...';
        }

        try {
          const res = await this.syncClient.discoverServer({
            timeoutMs: 500,
            onProgress: ({ scanned, total, currentIp }) => {
              if (lanScanStatus) {
                lanScanStatus.textContent = `🔍 Đang dò: ${currentIp} (${scanned}/${total})`;
              }
            }
          });

          if (res.success) {
            if (inputServerHost) inputServerHost.value = res.ip;
            if (lanScanIcon) lanScanIcon.textContent = '✅';
            if (lanScanBtnLabel) lanScanBtnLabel.textContent = `Đã tìm thấy: ${res.ip}`;
            if (lanScanStatus) {
              lanScanStatus.style.color = '#3fb950';
              lanScanStatus.textContent = `🎉 Tìm thấy máy chủ PC: ${res.ip} (Port ${res.data?.port || 8765}). Đang đồng bộ!`;
            }
            this.showToast(`🎉 Đã tìm thấy PC (${res.ip}) và kết nối thành công!`, 4000);
          } else {
            if (lanScanIcon) lanScanIcon.textContent = '❌';
            if (lanScanBtnLabel) lanScanBtnLabel.textContent = 'Quét lại';
            if (lanScanStatus) {
              lanScanStatus.style.color = '#f85149';
              lanScanStatus.textContent = '⚠️ Không tìm thấy PC. Hãy kiểm tra điện thoại và PC đã kết nối cùng mạng Wi-Fi chưa.';
            }
            this.showToast('⚠️ Không tìm thấy PC trong mạng Wi-Fi này.', 4000);
          }
        } catch (err) {
          console.error('[Auto-Discover] Error:', err);
        } finally {
          btnAutoDiscoverLan.disabled = false;
          setTimeout(() => {
            if (lanScanIcon) lanScanIcon.textContent = '🔍';
            if (lanScanBtnLabel) lanScanBtnLabel.textContent = 'Tự Động Quét Tìm PC (Auto-Discovery)';
          }, 4000);
        }
      });
    }

    // === HỘP THOẠI ĐỒNG BỘ MÀN HÌNH TƯƠNG TÁC (SYNC GATE) ===
    const syncGateOverlay = document.getElementById('mobile-sync-gate-overlay');
    const syncGateTitle = document.getElementById('sync-gate-title');
    const syncGateDesc = document.getElementById('sync-gate-desc');
    const syncGateProgressFill = document.getElementById('sync-gate-progress-fill');
    const syncGateSpinner = document.getElementById('sync-gate-spinner');
    const syncGateIpHint = document.getElementById('sync-gate-ip-hint');
    const syncGateFallback = document.getElementById('sync-gate-fallback');
    const syncGateManualIp = document.getElementById('sync-gate-manual-ip');
    const syncGateBtnConnectIp = document.getElementById('sync-gate-btn-connect-ip');
    const syncGateBtnRescan = document.getElementById('sync-gate-btn-rescan');
    const syncGateBtnOffline = document.getElementById('sync-gate-btn-offline');

    const closeSyncGate = () => {
      if (!syncGateOverlay) return;
      syncGateOverlay.classList.add('sync-gate-fade-out');
      setTimeout(() => {
        syncGateOverlay.style.display = 'none';
      }, 450);
    };

    let isGateScanning = false;
    const startGateDiscovery = async () => {
      if (isGateScanning) return;
      isGateScanning = true;
      if (syncGateFallback) syncGateFallback.style.display = 'none';
      if (syncGateTitle) syncGateTitle.textContent = 'Đang Quét Tìm Máy Tính PC';
      if (syncGateDesc) syncGateDesc.textContent = 'Tự động dò IP động trong mạng Wi-Fi và đồng bộ bài giảng từ PC về điện thoại...';
      if (syncGateProgressFill) syncGateProgressFill.style.width = '15%';
      if (syncGateSpinner) syncGateSpinner.textContent = '⏳';
      if (syncGateIpHint) syncGateIpHint.textContent = 'Bắt đầu quét mạng Wi-Fi...';

      try {
        const res = await this.syncClient.discoverServer({
          timeoutMs: 450,
          onProgress: ({ scanned, total, currentIp }) => {
            const pct = Math.min(95, Math.max(15, Math.round((scanned / total) * 100)));
            if (syncGateProgressFill) syncGateProgressFill.style.width = `${pct}%`;
            if (syncGateIpHint) syncGateIpHint.textContent = `Đang dò: ${currentIp} (${pct}%)`;
          },
          onFound: (ip, data) => {
            if (syncGateProgressFill) syncGateProgressFill.style.width = '90%';
            if (syncGateSpinner) syncGateSpinner.textContent = '⚡';
            if (syncGateTitle) syncGateTitle.textContent = `Đã Tìm Thấy PC: ${ip}!`;
            if (syncGateDesc) syncGateDesc.textContent = 'Đang kết nối và tải toàn bộ dữ liệu bài giảng...';
            if (syncGateIpHint) syncGateIpHint.textContent = `Máy chủ: ${ip}:${this.syncClient.port || 8765}`;
            if (syncGateManualIp) syncGateManualIp.value = ip;
            if (inputServerHost) inputServerHost.value = ip;
          }
        });

        if (!res.success) {
          if (syncGateTitle) syncGateTitle.textContent = 'Chưa Tìm Thấy Máy Tính PC';
          if (syncGateDesc) syncGateDesc.textContent = 'Hãy đảm bảo máy tính đã bật NestedCanvas và cả 2 thiết bị kết nối chung 1 mạng Wi-Fi.';
          if (syncGateSpinner) syncGateSpinner.textContent = '❌';
          if (syncGateIpHint) syncGateIpHint.textContent = 'Đã quét hết dải IP mạng Wi-Fi hiện tại.';
          if (syncGateFallback) syncGateFallback.style.display = 'flex';
          if (syncGateProgressFill) syncGateProgressFill.style.width = '100%';
        }
      } catch (err) {
        console.warn('[SyncGate] Scan error:', err);
      } finally {
        isGateScanning = false;
      }
    };

    if (syncGateBtnOffline) {
      syncGateBtnOffline.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showToast('🚀 Mở chế độ độc lập (Tự động đồng bộ màn hình khi online)', 3500);
        closeSyncGate();
        // Vẫn tiếp tục duy trì kết nối nền
        if (!this.syncClient.isConnected) {
          this.syncClient.connect();
        }
      });
    }

    if (syncGateBtnRescan) {
      syncGateBtnRescan.addEventListener('click', (e) => {
        e.stopPropagation();
        startGateDiscovery();
      });
    }

    if (syncGateBtnConnectIp && syncGateManualIp) {
      syncGateBtnConnectIp.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = syncGateManualIp.value.trim();
        if (val) {
          this.syncClient.setHost(val);
          if (syncGateIpHint) syncGateIpHint.textContent = `Đang kết nối tới ${val}...`;
          if (syncGateSpinner) syncGateSpinner.textContent = '⏳';
          this.syncClient.connect();
        }
      });
    }

    // Hoàn toàn không chặn màn hình khi khởi động: cho phép vẽ ngay lập tức!
    if (syncGateOverlay) syncGateOverlay.style.display = 'none';
    if (syncGateManualIp) syncGateManualIp.value = this.syncClient.getHost() || '192.168.1.25';

    const btnCloseSyncGate = document.getElementById('btn-close-sync-gate');
    if (btnCloseSyncGate) {
      btnCloseSyncGate.addEventListener('click', (e) => {
        e.stopPropagation();
        closeSyncGate();
      });
    }
    if (syncGateOverlay) {
      syncGateOverlay.addEventListener('click', (e) => {
        if (e.target === syncGateOverlay) {
          closeSyncGate();
        }
      });
    }

    // Kết nối và nhận diện tự động trong nền
    this.syncClient.connect();
    if (isMobileClient) {
      setTimeout(() => {
        if (!this.syncClient.isConnected) {
          startGateDiscovery();
        }
      }, 2000);
    }

    // Thiết lập Giao diện Mobile Single Board nếu người dùng truy cập ?board=...
    if (this.isSingleBoardMode && this.singleBoardId) {
      document.body.classList.add('mode-single-board');
      const mobileUI = document.getElementById('mobile-single-board-ui');
      if (mobileUI) mobileUI.style.display = 'flex';
      const initialNode = this.scene.getNode(this.singleBoardId);
      const mobName = document.getElementById('mobile-board-name');
      if (mobName && initialNode) mobName.textContent = initialNode.name;
      if (singleName && initialNode) singleName.textContent = initialNode.name;
      this.bindMobileSingleBoardEvents();
    }

    // Nhận các sự kiện từ Sync Server
    this.syncClient.on('WELCOME', async (data) => {
      // CHỈ nạp dữ liệu từ server khi máy này hoàn toàn trống (chưa có nét vẽ nào)
      const hasLocalStrokes = (this.scene.root.elements && this.scene.root.elements.length > 0) ||
        (this.scene.root.children && this.scene.root.children.some(c => (c.elements && c.elements.length > 0) || c.graphData));

      if (!hasLocalStrokes) {
        if (data.active_session_content && this.sessionManager) {
          try {
            const remoteMeta = data.active_session_meta || {
              id: data.active_session_id || 'default_session',
              name: 'Phiên làm việc',
              updatedAt: Date.now(),
            };
            await this.sessionManager.saveSessionSilently(remoteMeta, data.active_session_content);
            this.sessionManager.currentSessionId = remoteMeta.id;
            this.sessionManager.currentSessionMeta = remoteMeta;
            this.applySessionContent(data.active_session_content);
            this.updateActiveSessionUI(remoteMeta);
            this.updateHierarchyTree();
            this.updateUI();
          } catch (e) {
            console.warn('[App] Error syncing active session on WELCOME:', e);
          }
        } else if (data.last_canvas_scene) {
          try {
            this.scene.loadFromJSON(data.last_canvas_scene);
            if (data.last_canvas_camera) {
              if (typeof data.last_canvas_camera.zoom === 'number' && data.last_canvas_camera.zoom > 0) {
                this.camera.zoom = data.last_canvas_camera.zoom;
              }
              if (data.last_canvas_camera.pan && typeof data.last_canvas_camera.pan.x === 'number') {
                this.camera.pan = new Vec2(data.last_canvas_camera.pan.x, data.last_canvas_camera.pan.y);
              }
            }
            this.updateHierarchyTree();
            this.updateUI();
          } catch (e) {
            console.warn('[App] Error applying last_canvas_scene:', e);
          }
        }
      }

      // Luôn đồng bộ toàn bộ nét vẽ, theme, cấu hình bảng và góc nhìn camera hiện tại
      // sang PC Display ngay khi kết nối thành công!
      this.broadcastCanvasMirror();
      this.broadcastCurrentCameraSync();
      if (this._savedCastBoardId) {
        const castNode = this.scene.getNode(this._savedCastBoardId);
        if (castNode) this.castBoardToPC(castNode);
      }

      // Đóng màn hình Sync Gate khi đồng bộ xong
      if (syncGateOverlay && syncGateOverlay.style.display !== 'none') {
        if (syncGateTitle) syncGateTitle.textContent = 'Đồng Bộ Thành Công!';
        if (syncGateDesc) syncGateDesc.textContent = `Đã kết nối (${this.syncClient.getHost()}) & nạp phiên làm việc.`;
        if (syncGateProgressFill) syncGateProgressFill.style.width = '100%';
        if (syncGateSpinner) syncGateSpinner.textContent = '✅';
        if (syncGateIpHint) syncGateIpHint.textContent = `Sẵn sàng trên cổng ${this.syncClient.port || 8765}`;
        setTimeout(closeSyncGate, 650);
      }

      if (this.isSingleBoardMode && this.singleBoardId) {
        // Tham gia phòng của bảng con này
        this.syncClient.joinBoard(this.singleBoardId);
        this.syncClient.requestBoardState(this.singleBoardId);
      } else {
        const serverSharedIds = new Set((data.shared_boards || []).map((b) => b.id));
        for (const child of this.scene.root.children) {
          if (child.isShared) {
            this.syncClient.shareBoard(child.id, child.toJSON(), true);
            this.syncClient.joinBoard(child.id);
          } else if (serverSharedIds.has(child.id)) {
            child.isShared = true;
            this.syncClient.joinBoard(child.id);
          }
        }
        this.updateHierarchyTree();
        this.checkRemoteLobby(data.shared_boards || []);
      }
    });

    // Cập nhật số lượng thiết bị khi nhận PRESENCE (tránh gửi lặp lại gây nghẽn mạng)
    this.syncClient.on('PRESENCE', (data) => {
      if (data && typeof data.count === 'number') {
        const count = data.count;
        const pillText = document.getElementById('lan-presence-count');
        if (pillText) pillText.textContent = `${count} Thiết Bị`;
      }
    });

    // 2. Nhận nét vẽ đang vẽ dở thời gian thực từ thiết bị khác (Live in-flight stroke)
    this.syncClient.on('CANVAS_STROKE_LIVE', (data) => {
      if (data.clientId && (data.clientId === this.clientId || data.clientId.startsWith(this.clientId + '_'))) return;
      const { clientId, session } = data;
      if (!clientId) return;
      if (!session || !session.points || session.points.length === 0) {
        this.remoteActiveSessions.delete(clientId);
      } else if (session.isDelta && this.remoteActiveSessions.has(clientId)) {
        // Chế độ delta: nối thêm điểm mới
        const existing = this.remoteActiveSessions.get(clientId);
        existing.points = existing.points.concat(session.points);
      } else {
        this.remoteActiveSessions.set(clientId, { ...session });
      }
    });

    // 3. Nhận nét vẽ hoàn thành từ thiết bị khác
    this.syncClient.on('CANVAS_STROKE_ADD', (data) => {
      if (data.clientId && (data.clientId === this.clientId || data.clientId.startsWith(this.clientId + '_'))) return;
      const { nodeId, stroke, clientId } = data;
      if (clientId) {
        this.remoteActiveSessions.delete(clientId);
      }
      if (!stroke) return;
      const targetNode = (nodeId ? this.scene.getNode(nodeId) : null) || this.scene.root;
      if (targetNode) {
        const strokeObj = Stroke.fromJSON(stroke);
        if (!Array.isArray(targetNode.elements)) targetNode.elements = [];
        if (!targetNode.elements.some((s) => s.id === strokeObj.id)) {
          targetNode.elements.push(strokeObj);
        }
        this.updateUI();
      }
    });

    // 4. Nhận xóa nét vẽ từ thiết bị khác
    this.syncClient.on('CANVAS_STROKE_ERASE', (data) => {
      if (data.clientId && (data.clientId === this.clientId || data.clientId.startsWith(this.clientId + '_'))) return;
      const { nodeId, removedStrokeIds } = data;
      if (!Array.isArray(removedStrokeIds)) return;
      const targetNode = (nodeId ? this.scene.getNode(nodeId) : null) || this.scene.root;
      if (targetNode && Array.isArray(targetNode.elements)) {
        const idSet = new Set(removedStrokeIds);
        targetNode.elements = targetNode.elements.filter((s) => !idSet.has(s.id));
        this.updateUI();
      }
    });

    // 5. Nhận thay đổi màu nền & lưới từ thiết bị khác
    this.syncClient.on('CANVAS_STYLE', (data) => {
      if (!data) return;
      const { nodeId, style, gridType, isGlobal } = data;
      if (isGlobal || (!nodeId && (style || gridType))) {
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
      } else if (nodeId) {
        const target = this.scene.getNode(nodeId);
        if (target) {
          if (style) target.style = style;
          if (gridType) target.gridType = gridType;
        }
      }
      this.updateUI();
    });

    // 6. Nhận cập nhật phiên làm việc từ xa (CHỈ lưu ngầm vào DB, không ghi đè làm mất nét vẽ đang vẽ dở)
    this.syncClient.on('SESSION_UPDATE', async (data) => {
      if (data.sessionId && data.content && this.sessionManager) {
        await this.sessionManager.saveSessionSilently(data.meta, data.content);
      }
    });

    // 7. Nhận lệnh chuyển phiên làm việc từ xa
    this.syncClient.on('SESSION_SWITCH', async (data) => {
      if (data.clientId && (data.clientId === this.clientId || data.clientId.startsWith(this.clientId + '_'))) return;
      if (data.sessionId && this.sessionManager) {
        if (this.sessionManager.currentSessionId !== data.sessionId) {
          const s = await this.sessionManager.switchSession(data.sessionId, false);
          if (s && s.content) {
            this.applySessionContent(s.content);
            this.updateHierarchyTree();
            this.updateUI();
          }
        }
      }
    });

    // Nhận toàn cảnh Canvas Mirror thời gian thực từ PC
    this.syncClient.on('CANVAS_MIRROR', (data) => {
      // Đang có nét vẽ dở thì không ghi đè đột ngột
      if (this.activeSessions && this.activeSessions.size > 0) return;
      if (data && data.scene) {
        const hasLocalContent = (this.scene.root.elements && this.scene.root.elements.length > 0) ||
          (this.scene.root.children && this.scene.root.children.some(c => (c.elements && c.elements.length > 0) || c.graphData));
        if (hasLocalContent && !data.forceOverride) {
          return;
        }
        try {
          this.isApplyingRemoteSync = true;
          this.scene.loadFromJSON(data.scene);
          if (data.camera) {
            if (typeof data.camera.zoom === 'number' && data.camera.zoom > 0) {
              this.camera.zoom = data.camera.zoom;
            }
            if (data.camera.pan && typeof data.camera.pan.x === 'number') {
              this.camera.pan = new Vec2(data.camera.pan.x, data.camera.pan.y);
            }
          }
          this.updateHierarchyTree();
          this.updateUI();
          if (syncGateOverlay && syncGateOverlay.style.display !== 'none') {
            closeSyncGate();
          }
        } catch (e) {
          console.warn('[App] Error applying CANVAS_MIRROR:', e);
        } finally {
          this.isApplyingRemoteSync = false;
        }
      }
    });

    // Nhận đồng bộ vị trí và tỉ lệ Camera thời gian thực từ thiết bị khác
    this.syncClient.on('CANVAS_CAMERA_SYNC', (data) => {
      if (data.clientId && (data.clientId === this.clientId || data.clientId.startsWith(this.clientId + '_'))) return;
      if (this.isPanning || this.isPinching || (this.activeSessions && this.activeSessions.size > 0)) return;
      if (typeof data.zoom === 'number' && data.zoom > 0) {
        this.camera.zoom = data.zoom;
      }
      if (data.pan && typeof data.pan.x === 'number' && typeof data.pan.y === 'number') {
        this.camera.pan = new Vec2(data.pan.x, data.pan.y);
      }
      this.updateZoomHUD();
      this.updateUI();
    });

    this.syncClient.on('PLEASE_UPLOAD_BOARD', (data) => {
      if (data.boardId) {
        const target = this.scene.getNode(data.boardId);
        if (target && target.isShared) {
          this.syncClient.sendBoardState(data.boardId, target.toJSON());
        }
      }
    });

    this.syncClient.on('BOARD_SHARE_STATUS', (data) => {
      const { boardId, isShared } = data;
      const target = this.scene.getNode(boardId);
      if (target) {
        target.isShared = isShared;
        this.updateHierarchyTree();
        this.updateNodeProperties();
      }
      if (this.isSingleBoardMode && this.singleBoardId === boardId && !isShared) {
        this.showToast('⚠️ Bảng con này đã dừng chia sẻ bởi người chủ trì', 5000);
      }
      this.renderLanSyncBoardsList();
      if (!this.isSingleBoardMode) {
        this.checkRemoteLobby(this.syncClient?.sharedBoards || []);
      }
    });

    this.syncClient.on('BOARD_STATE', (data) => {
      const { boardId, node } = data;
      if (!boardId || !node) return;

      this.isApplyingRemoteSync = true;
      let targetNode = this.scene.getNode(boardId);
      if (targetNode) {
        targetNode.name = node.name || targetNode.name;
        targetNode.width = node.width || targetNode.width;
        targetNode.height = node.height || targetNode.height;
        targetNode.style = node.style || targetNode.style;
        targetNode.gridType = node.gridType || targetNode.gridType;
        if (node.elements) {
          targetNode.elements = node.elements.map((s) => Stroke.fromJSON(s));
        }
        if (node.children) {
          targetNode.children = node.children.map((c) => CanvasNode.fromJSON(c)).filter(Boolean);
        }
        if (node.graphData) targetNode.graphData = node.graphData;
        if (node.textContent) targetNode.textContent = node.textContent;
        if (node.image) {
          if (typeof node.image === 'string') {
            const img = new Image();
            img.src = node.image;
            if (!img.complete) {
              img.onload = () => {
                if (typeof CanvasNode.onImageLoaded === 'function') CanvasNode.onImageLoaded();
              };
            }
            targetNode.image = img;
          } else {
            targetNode.image = node.image;
          }
        }
        if (node.images && Array.isArray(node.images)) {
          targetNode.images = node.images.map((imgData) => ImageElement.fromJSON(imgData)).filter(Boolean);
        }
      } else if (this.isSingleBoardMode && this.singleBoardId === boardId) {
        targetNode = CanvasNode.fromJSON(node);
        this.scene.root.addChild(targetNode);
      }

      if (targetNode) {
        targetNode.isShared = true;
      }

      if (this.isSingleBoardMode && this.singleBoardId === boardId && targetNode) {
        if (singleName) singleName.textContent = targetNode.name;
        const mobName = document.getElementById('mobile-board-name');
        if (mobName) mobName.textContent = targetNode.name;
        this.selectedNodeId = boardId;
        setTimeout(() => this.focusBoardFullscreen(targetNode), 60);
      }

      this.updateHierarchyTree();
      this.updateNodeProperties();
      this.updateUI();
      this.isApplyingRemoteSync = false;
    });

    this.syncClient.on('STROKE_LIVE', (data) => {
      if (data.clientId === this.clientId) return;
      const targetId = data.nodeId || data.boardId || data.session?.targetNodeId;
      if (!targetId || targetId === this.scene.root.id) return;

      const sharedRoot = this.getSharedRootForNode(targetId);
      if (!sharedRoot) return;
      if (this.isSingleBoardMode && sharedRoot.id !== this.singleBoardId) return;

      const { clientId, session } = data;
      if (!session || !session.points || session.points.length === 0) {
        this.remoteActiveSessions.delete(clientId);
      } else if (session.isDelta && this.remoteActiveSessions.has(clientId)) {
        const existing = this.remoteActiveSessions.get(clientId);
        existing.points = existing.points.concat(session.points);
      } else {
        this.remoteActiveSessions.set(clientId, { ...session });
      }
    });

    this.syncClient.on('STROKE_ADD', (data) => {
      if (data.clientId === this.clientId) return;
      this.remoteActiveSessions.delete(data.clientId);
      const targetId = data.nodeId || data.boardId;
      if (!targetId || targetId === this.scene.root.id) return;

      const sharedRoot = this.getSharedRootForNode(targetId);
      if (!sharedRoot) return;
      if (this.isSingleBoardMode && sharedRoot.id !== this.singleBoardId) return;

      const targetNode = this.scene.getNode(targetId);
      if (!targetNode) return;

      if (data.stroke) {
        const stroke = Stroke.fromJSON(data.stroke);
        targetNode.addStroke(stroke);
        this.updateUI();
      }
    });

    this.syncClient.on('STROKE_ERASE', (data) => {
      const targetId = data.nodeId || data.boardId;
      if (!targetId || targetId === this.scene.root.id) return;

      const sharedRoot = this.getSharedRootForNode(targetId);
      if (!sharedRoot) return;
      if (this.isSingleBoardMode && sharedRoot.id !== this.singleBoardId) return;

      const targetNode = this.scene.getNode(targetId);
      if (!targetNode) return;

      if (data.removedStrokeIds) {
        const idSet = new Set(data.removedStrokeIds);
        targetNode.elements = targetNode.elements.filter((s) => !idSet.has(s.id));
        this.updateUI();
      }
    });

    this.syncClient.on('NODE_CREATE', (data) => {
      if (data.clientId && (data.clientId === this.clientId || data.clientId.startsWith(this.clientId + '_'))) return;
      const { parentId, node: nodeData } = data;
      if (!nodeData) return;

      if (this.isSingleBoardMode && this.singleBoardId) {
        const sharedRoot = this.getSharedRootForNode(parentId);
        if (!sharedRoot || sharedRoot.id !== this.singleBoardId) return;
      }

      const parentNode = (parentId ? this.scene.getNode(parentId) : null) || this.scene.root;
      if (!parentNode) return;

      if (this.scene.getNode(nodeData.id)) return;

      this.isApplyingRemoteSync = true;
      const newNode = CanvasNode.fromJSON(nodeData);
      parentNode.addChild(newNode);
      this.updateHierarchyTree();
      this.updateUI();
      this.isApplyingRemoteSync = false;
    });

    this.syncClient.on('NODE_TRANSFORM', (data) => {
      if (data.clientId && (data.clientId === this.clientId || data.clientId.startsWith(this.clientId + '_'))) return;
      const targetId = data.nodeId || data.boardId;
      if (!targetId || targetId === this.scene.root.id) return;

      if (this.isSingleBoardMode && this.singleBoardId && targetId !== this.singleBoardId) {
        const sharedRoot = this.getSharedRootForNode(targetId);
        if (!sharedRoot || sharedRoot.id !== this.singleBoardId) return;
      }

      const node = this.scene.getNode(targetId);
      if (node) {
        if (typeof data.x === 'number') node.transform.tx = data.x;
        if (typeof data.y === 'number') node.transform.ty = data.y;
        if (typeof data.w === 'number') node.width = data.w;
        if (typeof data.h === 'number') node.height = data.h;
        this.updateNodeProperties();
        this.updateUI();
      }
    });

    this.syncClient.on('NODE_DELETE', (data) => {
      if (data.clientId && (data.clientId === this.clientId || data.clientId.startsWith(this.clientId + '_'))) return;
      const { nodeId } = data;
      if (!nodeId) return;
      if (this.isSingleBoardMode && nodeId === this.singleBoardId) {
        this.showToast('⚠️ Bảng con này đã bị xóa bởi người chủ trì', 5000);
        return;
      }
      this.isApplyingRemoteSync = true;
      const parentNode = this.scene.findParentNode(nodeId);
      if (parentNode) {
        parentNode.removeChild(nodeId);
      } else {
        this.scene.root.removeChild(nodeId);
      }
      if (this.selectedNodeId === nodeId) {
        this.selectedNodeId = this.isSingleBoardMode ? this.singleBoardId : null;
      }
      this.updateHierarchyTree();
      this.updateNodeProperties();
      this.updateUI();
      this.isApplyingRemoteSync = false;
    });

    this.syncClient.on('NODE_STYLE', (data) => {
      if (data.clientId && (data.clientId === this.clientId || data.clientId.startsWith(this.clientId + '_'))) return;
      const targetId = data.nodeId || data.boardId;

      this.isApplyingRemoteSync = true;
      if (data.isGlobal || !targetId) {
        const updateRecursive = (n) => {
          if (data.style) n.style = data.style;
          if (data.gridType) n.gridType = data.gridType;
          for (const c of n.children) updateRecursive(c);
        };
        updateRecursive(this.scene.root);
        this.updateNodeProperties();
      } else {
        const node = this.scene.getNode(targetId);
        if (node) {
          if (data.style) node.style = data.style;
          if (data.gridType) node.gridType = data.gridType;
          this.updateNodeProperties();
        }
      }
      this.updateUI();
      this.isApplyingRemoteSync = false;
    });

    this.syncClient.on('NODE_CLEAR', (data) => {
      if (data.clientId && (data.clientId === this.clientId || data.clientId.startsWith(this.clientId + '_'))) return;
      const target = (data.nodeId ? this.scene.getNode(data.nodeId) : null) || this.scene.root;
      if (target) {
        this.isApplyingRemoteSync = true;
        target.elements = [];
        target.images = [];
        this.updateHierarchyTree();
        this.updateNodeProperties();
        this.updateUI();
        this.isApplyingRemoteSync = false;
      }
    });

    this.syncClient.on('GRAPH_EXPR', (data) => {
      if (data.clientId && (data.clientId === this.clientId || data.clientId.startsWith(this.clientId + '_'))) return;
      const targetId = data.nodeId || data.boardId;
      if (!targetId) return;

      const node = this.scene.getNode(targetId);
      if (node && node.graphData && data.expressions) {
        node.graphData.expressions = data.expressions;
        this.updateGraphExpressions(node);
      }
    });

    // Single Board Mode controls
    if (btnSingleFit) {
      btnSingleFit.addEventListener('click', () => {
        const target = this.scene.getNode(this.singleBoardId);
        if (target) this.focusBoardFullscreen(target);
      });
    }

    if (btnSingleExit) {
      btnSingleExit.addEventListener('click', () => {
        const url = new URL(window.location.href);
        url.searchParams.delete('board');
        url.searchParams.delete('boardId');
        window.location.href = url.pathname;
      });
    }

    // Modal Board Share UI handlers
    if (btnCloseBoardShare && modalBoardShare) {
      btnCloseBoardShare.addEventListener('click', () => {
        modalBoardShare.style.display = 'none';
      });
    }

    if (modalBoardShare) {
      modalBoardShare.addEventListener('click', (e) => {
        if (e.target === modalBoardShare) modalBoardShare.style.display = 'none';
      });
    }

    if (toggleBoardShare) {
      toggleBoardShare.addEventListener('change', (e) => {
        if (this.currentSharingBoardNode) {
          this.toggleBoardShare(this.currentSharingBoardNode, e.target.checked);
        }
      });
    }

    if (btnCopyBoardUrl && inputBoardUrl) {
      btnCopyBoardUrl.addEventListener('click', (e) => {
        e.stopPropagation();
        this.copyToClipboard(inputBoardUrl.value).then(() => {
          btnCopyBoardUrl.textContent = '✓ Đã Chép!';
          setTimeout(() => {
            btnCopyBoardUrl.textContent = 'Sao Chép';
          }, 2000);
        });
      });
    }

    // UI Buttons for global LAN Sync & Màn hình tương tác
    if (btnSync) {
      btnSync.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isMobileClient) {
          if (this.syncClient && this.syncClient.isConnected) {
            this.broadcastCanvasMirror();
            this.showToast(`🟢 Đang đồng bộ với Màn hình (${this.syncClient.getHost()})! Đã phát lại toàn bộ bảng.`, 3000);
          } else {
            if (syncGateOverlay) {
              syncGateOverlay.style.display = 'flex';
              startGateDiscovery();
            } else if (modalSync) {
              this.openGlobalLanSyncModal();
            }
          }
        } else {
          this.openGlobalLanSyncModal();
        }
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
        this.copyToClipboard(inputUrl.value).then(() => {
          btnCopy.textContent = '✓ Đã Chép!';
          setTimeout(() => {
            btnCopy.textContent = 'Sao Chép';
          }, 2000);
        });
      });
    }
  }

  /* =========================================================================
   * CHIA SẺ TỪNG BẢNG CON QUA SOCKET (SUB-BOARD ROOM SHARING)
   * ========================================================================= */

  openBoardShareModal(node) {
    if (!node || node.id === this.scene.root.id) return;
    this.currentSharingBoardNode = node;

    const modal = document.getElementById('modal-board-share');
    const titleEl = document.getElementById('board-share-title');
    const subtitleEl = document.getElementById('board-share-subtitle');
    const toggle = document.getElementById('toggle-board-share');
    const details = document.getElementById('board-share-details');
    const inputUrl = document.getElementById('input-board-share-url');
    const linkOpenTab = document.getElementById('link-open-board-tab');
    const presenceBadge = document.getElementById('board-presence-badge');

    if (!modal) return;

    titleEl.textContent = `📡 Chia Sẻ: ${node.name}`;
    subtitleEl.textContent = `Kích thước: ${Math.round(node.width)}×${Math.round(node.height)} px • ID: ${node.id.slice(0, 8)}...`;

    const port = window.location.port || '3000';
    const host = this.syncClient?.localIp || this.syncClient?.getHost() || window.location.hostname || 'localhost';
    const boardUrl = `${window.location.protocol}//${host}:${port}/?board=${node.id}&server=${host}`;

    if (inputUrl) inputUrl.value = boardUrl;
    if (linkOpenTab) linkOpenTab.href = boardUrl;

    if (toggle) toggle.checked = !!node.isShared;
    if (details) details.style.display = node.isShared ? 'flex' : 'none';

    const currentPresence = this.syncClient ? this.syncClient.getBoardPresence(node.id) : 1;
    if (presenceBadge) {
      presenceBadge.textContent = `🟢 ${Math.max(1, currentPresence)} thiết bị`;
    }

    this.renderBoardQRCode(boardUrl);
    modal.style.display = 'flex';
  }

  toggleBoardShare(node, isShared) {
    if (!node) return;
    node.isShared = isShared;

    if (this.syncClient && this.syncClient.isConnected) {
      this.syncClient.shareBoard(node.id, node.toJSON(), isShared);
      if (isShared) {
        this.syncClient.joinBoard(node.id);
      } else {
        this.syncClient.leaveBoard(node.id);
      }
    }

    const details = document.getElementById('board-share-details');
    if (details) details.style.display = isShared ? 'flex' : 'none';

    this.updateHierarchyTree();
    this.updateNodeProperties();
    this.showToast(isShared ? `📡 Đã bật chia sẻ bảng "${node.name}" qua Socket` : `📴 Đã tắt chia sẻ bảng "${node.name}"`);
  }

  renderBoardQRCode(url) {
    const qrContainer = document.getElementById('board-share-qrcode');
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
        console.warn('Board QRCode error:', e);
      }
    }
    qrContainer.innerHTML = `<span style="font-size:11px; color:#334155; text-align:center; word-break:break-all;">${url}</span>`;
  }

  /* =========================================================================
   * GIAO DIỆN ĐIỆN THOẠI CHO BẢNG CON (MOBILE COLLABORATION UI HANDLERS)
   * ========================================================================= */

  bindMobileSingleBoardEvents() {
    const btnExit = document.getElementById('btn-mobile-exit');
    const btnUndo = document.getElementById('btn-mobile-undo');
    const btnRedo = document.getElementById('btn-mobile-redo');
    const btnFit = document.getElementById('btn-mobile-fit');
    const btnClear = document.getElementById('btn-mobile-clear');

    const btnPen = document.getElementById('mobile-tool-pen');
    const btnBrushType = document.getElementById('mobile-tool-brush-toggle');
    const btnEraser = document.getElementById('mobile-tool-eraser');
    const btnPan = document.getElementById('mobile-tool-pan');
    const btnPaletteToggle = document.getElementById('mobile-btn-palette-toggle');
    const paletteDrawer = document.getElementById('mobile-palette-drawer');
    const brushLabel = document.getElementById('mobile-brush-label');
    const brushIcon = document.getElementById('mobile-brush-icon');
    const colorIndicator = document.getElementById('mobile-current-color-dot');

    if (btnExit) {
      btnExit.addEventListener('click', () => {
        const url = new URL(window.location.href);
        url.searchParams.delete('board');
        url.searchParams.delete('boardId');
        window.location.href = url.pathname;
      });
    }

    if (btnUndo) {
      btnUndo.addEventListener('click', () => {
        const node = this.scene.getNode(this.singleBoardId);
        if (node) this.undoNode(node);
      });
    }

    if (btnRedo) {
      btnRedo.addEventListener('click', () => {
        const node = this.scene.getNode(this.singleBoardId);
        if (node) this.redoNode(node);
      });
    }

    const btnZoomOut = document.getElementById('btn-mobile-zoom-out');
    const btnZoomIn = document.getElementById('btn-mobile-zoom-in');

    if (btnZoomOut) {
      btnZoomOut.addEventListener('click', () => {
        this.zoomAroundScreenCenter(1.0 / 1.25);
      });
    }

    if (btnZoomIn) {
      btnZoomIn.addEventListener('click', () => {
        this.zoomAroundScreenCenter(1.25);
      });
    }

    if (btnFit) {
      btnFit.addEventListener('click', () => {
        const node = this.scene.getNode(this.singleBoardId);
        if (node) this.focusBoardFullscreen(node);
      });
    }

    if (btnClear) {
      btnClear.addEventListener('click', () => {
        const node = this.scene.getNode(this.singleBoardId);
        if (node && confirm('Xóa toàn bộ nét vẽ trên bảng này?')) {
          this.clearBoard(node);
        }
      });
    }

    const btnMobileCast = document.getElementById('btn-mobile-cast-pc');
    if (btnMobileCast) {
      btnMobileCast.addEventListener('click', () => {
        if (this.isSingleBoardMode && this.singleBoardId) {
          const node = this.scene.getNode(this.singleBoardId);
          if (node) {
            if (this.syncClient && this.syncClient.currentCastBoardId === this.singleBoardId) {
              this.stopCastPC();
            } else {
              this.castBoardToPC(node);
            }
          }
        } else {
          this.openCastPCModal();
        }
      });
    }

    const updateMobileToolActive = (activeToolId) => {
      if (btnPen) btnPen.classList.toggle('active', activeToolId === 'pen');
      if (btnEraser) btnEraser.classList.toggle('active', activeToolId.startsWith('eraser'));
      if (btnPan) btnPan.classList.toggle('active', activeToolId === 'pan');
    };

    if (btnPen) {
      btnPen.addEventListener('click', () => {
        this.setTool('pen');
        updateMobileToolActive('pen');
      });
    }

    if (btnEraser) {
      btnEraser.addEventListener('click', () => {
        this.setTool('eraser-object');
        updateMobileToolActive('eraser-object');
      });
    }

    if (btnPan) {
      btnPan.addEventListener('click', () => {
        this.setTool('pan');
        updateMobileToolActive('pan');
      });
    }

    const btnMobileMultipoint = document.getElementById('mobile-tool-multipoint');
    if (btnMobileMultipoint) {
      btnMobileMultipoint.addEventListener('click', () => {
        this.toggleMultiPointMode();
      });
    }

    if (btnPaletteToggle && paletteDrawer) {
      btnPaletteToggle.addEventListener('click', () => {
        const isHidden = window.getComputedStyle(paletteDrawer).display === 'none';
        paletteDrawer.style.display = isHidden ? 'flex' : 'none';
      });
    }

    // Đổi kiểu bút vẽ (Mực, Phấn, Dạ Quang, Thư Pháp, Nét Đứt)
    const brushList = [
      { id: 'solid', name: 'Bút Mực', icon: '✒️' },
      { id: 'chalk', name: 'Bút Phấn', icon: '🖍️' },
      { id: 'neon', name: 'Dạ Quang', icon: '✨' },
      { id: 'calligraphy', name: 'Thư Pháp', icon: '🖌️' },
      { id: 'dashed', name: 'Nét Đứt', icon: '┈' },
    ];
    let brushIdx = 0;

    if (btnBrushType) {
      btnBrushType.addEventListener('click', () => {
        brushIdx = (brushIdx + 1) % brushList.length;
        const b = brushList[brushIdx];
        this.brushType = b.id;
        if (brushLabel) brushLabel.textContent = b.name;
        if (brushIcon) brushIcon.textContent = b.icon;
        this.showToast(`Kiểu bút: ${b.name}`);
      });
    }

    // Chọn màu cho điện thoại
    document.querySelectorAll('.mobile-color-dot').forEach((dot) => {
      dot.addEventListener('click', () => {
        document.querySelectorAll('.mobile-color-dot').forEach((d) => d.classList.remove('active'));
        dot.classList.add('active');
        this.brushColor = dot.dataset.color;
        if (colorIndicator) colorIndicator.style.background = this.brushColor;
        this.updateColorPaletteActive();
      });
    });

    // Chọn cỡ nét cho điện thoại
    document.querySelectorAll('.mobile-size-pill').forEach((pill) => {
      pill.addEventListener('click', () => {
        document.querySelectorAll('.mobile-size-pill').forEach((p) => p.classList.remove('active'));
        pill.classList.add('active');
        this.brushSize = parseFloat(pill.dataset.size);
      });
    });

    // Khi xoay màn hình điện thoại hoặc thay đổi kích thước cửa sổ, tự động đồng bộ camera
    window.addEventListener('resize', () => {
      if (this.isSingleBoardMode && this.singleBoardId) {
        const node = this.scene.getNode(this.singleBoardId);
        if (node) this.focusBoardFullscreen(node);
      }
      this.broadcastCanvasCamera();
    });
  }

  /* =========================================================================
   * ĐIỀU KHIỂN CHIẾU BẢNG LÊN MÀN HÌNH PC TOÀN MÀN HÌNH (REMOTE PC CAST)
   * ========================================================================= */

  initCastPCControls() {
    const btnCast = document.getElementById('btn-cast-pc');
    const modalCast = document.getElementById('modal-cast-pc');
    const btnCloseCast = document.getElementById('btn-close-cast-modal');
    const btnStopCast = document.getElementById('btn-stop-current-cast');
    const btnCreateCastBoard = document.getElementById('btn-cast-create-board');

    if (btnCast) {
      btnCast.addEventListener('click', (e) => {
        e.stopPropagation();
        this.openCastPCModal();
      });
    }

    if (btnCloseCast && modalCast) {
      btnCloseCast.addEventListener('click', () => {
        modalCast.style.display = 'none';
      });
    }

    if (modalCast) {
      modalCast.addEventListener('click', (e) => {
        if (e.target === modalCast) modalCast.style.display = 'none';
      });
    }

    const btnCastEntireCanvas = document.getElementById('btn-cast-entire-canvas');
    if (btnCastEntireCanvas) {
      btnCastEntireCanvas.addEventListener('click', () => {
        this.broadcastCanvasMirror();
        this.updateCastUIState('canvas', { name: 'Toàn Bộ Canvas' });
        this.showToast('🖥️ Đang chiếu toàn bộ Canvas lên màn hình PC!');
      });
    }

    if (btnStopCast) {
      btnStopCast.addEventListener('click', () => {
        this.stopCastPC();
      });
    }

    if (btnCreateCastBoard) {
      btnCreateCastBoard.addEventListener('click', () => {
        const board = this.createNewBoard();
        this.renderCastBoardsList();
        if (board) {
          this.castBoardToPC(board);
        }
      });
    }

    // Lắng nghe sự kiện từ SyncClient
    if (this.syncClient) {
      this.syncClient.on('CAST_BOARD', (data) => {
        this.updateCastUIState(data.boardId, data.node);
      });

      this.syncClient.on('STOP_CAST_BOARD', () => {
        this.updateCastUIState(null, null);
      });

      this.syncClient.on('WELCOME', (data) => {
        if (data.current_cast_board_id) {
          this.updateCastUIState(data.current_cast_board_id, data.current_cast_board_node);
        } else {
          this.updateCastUIState('canvas', { name: 'Toàn Bộ Canvas' });
        }
      });

      this.syncClient.on('PLEASE_UPLOAD_CANVAS_MIRROR', () => {
        this.broadcastCanvasMirror();
        this.broadcastCurrentCameraSync();
        if (this._savedCastBoardId) {
          const castNode = this.scene.getNode(this._savedCastBoardId);
          if (castNode) this.castBoardToPC(castNode);
        }
      });
    }
  }

  openCastPCModal() {
    const modal = document.getElementById('modal-cast-pc');
    if (!modal) return;
    modal.style.display = 'flex';
    this.renderCastBoardsList();
  }

  broadcastCanvasMirror() {
    if (!this.syncClient || !this.syncClient.isConnected) return;
    if (this._mirrorDebounceTimer) clearTimeout(this._mirrorDebounceTimer);
    this._mirrorDebounceTimer = setTimeout(() => {
      this._mirrorDebounceTimer = null;
      if (!this.syncClient || !this.syncClient.isConnected) return;
      const currentTheme = this.globalTheme || this.scene.root.style || 'chalkboard';
      const currentGrid = this.globalGrid || this.scene.root.gridType || 'grid';
      this.scene.root.style = currentTheme;
      this.scene.root.gridType = currentGrid;
      this.syncClient.send('CANVAS_MIRROR', {
        sessionId: this.sessionManager?.getCurrentSessionId(),
        scene: this.scene.toJSON(),
        theme: currentTheme,
        gridType: currentGrid,
        camera: {
          zoom: this.camera.zoom,
          pan: { x: this.camera.pan.x, y: this.camera.pan.y },
          viewport: { w: window.innerWidth, h: window.innerHeight },
        },
        sendTime: Date.now(),
      });
    }, 60);
  }

  broadcastCanvasCamera() {
    if (!this.syncClient || !this.syncClient.isConnected) return;
    if (this.isFocusMode && !this.focusSyncDisplay) {
      // Trong Chế Độ Tập Trung: Mặc định không gửi camera sync sang PC Display để bảo toàn bố cục toàn cảnh
      return;
    }
    if (this._canvasCameraThrottler) return;
    this._canvasCameraThrottler = requestAnimationFrame(() => {
      this._canvasCameraThrottler = null;
      if (!this.syncClient || !this.syncClient.isConnected) return;
      if (this.isFocusMode && !this.focusSyncDisplay) return;
      this.syncClient.send('CANVAS_CAMERA_SYNC', {
        clientId: this.clientId,
        zoom: this.camera.zoom,
        pan: { x: this.camera.pan.x, y: this.camera.pan.y },
        viewport: { w: window.innerWidth, h: window.innerHeight },
      });
    });
  }

  updateCastUIState(boardId, node = null) {
    const dotStatus = document.getElementById('dot-cast-status');
    const labelCast = document.getElementById('label-cast-pc');
    const btnCast = document.getElementById('btn-cast-pc');
    const btnMobileCast = document.getElementById('btn-mobile-cast-pc');
    const statusTextDisplay = document.getElementById('cast-status-text-display');
    const btnStopCurrent = document.getElementById('btn-stop-current-cast');

    const nodeName = node?.name || (boardId ? this.scene.getNode(boardId)?.name : null) || 'Bảng Con';

    if (boardId) {
      if (dotStatus) {
        dotStatus.style.background = '#3fb950';
        dotStatus.style.boxShadow = '0 0 8px #3fb950';
      }
      if (labelCast) labelCast.textContent = `📺 Chiếu: ${nodeName}`;
      if (btnCast) {
        btnCast.style.borderColor = 'rgba(63,185,80,0.6)';
        btnCast.style.color = '#3fb950';
      }
      if (btnMobileCast) {
        btnMobileCast.style.borderColor = '#3fb950';
        btnMobileCast.style.background = 'rgba(63,185,80,0.2)';
      }
      if (statusTextDisplay) {
        statusTextDisplay.textContent = `🟢 Đang chiếu: "${nodeName}"`;
        statusTextDisplay.style.color = '#3fb950';
      }
      if (btnStopCurrent) btnStopCurrent.style.display = 'block';
    } else {
      if (dotStatus) {
        dotStatus.style.background = '#8b949e';
        dotStatus.style.boxShadow = 'none';
      }
      if (labelCast) labelCast.textContent = '📺 Chiếu PC';
      if (btnCast) {
        btnCast.style.borderColor = 'rgba(88,166,255,0.4)';
        btnCast.style.color = '#58a6ff';
      }
      if (btnMobileCast) {
        btnMobileCast.style.borderColor = 'transparent';
        btnMobileCast.style.background = 'transparent';
      }
      if (statusTextDisplay) {
        statusTextDisplay.textContent = 'Chưa chọn bảng nào';
        statusTextDisplay.style.color = '#8b949e';
      }
      if (btnStopCurrent) btnStopCurrent.style.display = 'none';
    }

    // Cập nhật lại danh sách bảng trong modal nếu đang hiển thị
    const modal = document.getElementById('modal-cast-pc');
    if (modal && modal.style.display === 'flex') {
      this.renderCastBoardsList();
    }
  }

  castBoardToPC(node, autoFocus = false) {
    if (!node) return;
    node.isShared = true;
    if (this.syncClient) {
      this.syncClient.shareBoard(node.id, node.toJSON(), true);
      this.syncClient.joinBoard(node.id);
      this.syncClient.castBoard(node.id, node.toJSON());
    }
    this.updateCastUIState(node.id, node);
    this.showToast(`📺 Đang chiếu "${node.name}" lên Màn hình PC!`);

    // Chỉ tự căn giữa nếu được yêu cầu rõ ràng
    if (autoFocus && !this.isSingleBoardMode) {
      this.focusBoardFullscreen(node);
    }
    setTimeout(() => {
      this.broadcastCurrentCameraSync();
      this.broadcastCanvasMirror();
    }, 100);
  }

  stopCastPC() {
    if (this.syncClient) {
      this.syncClient.stopCastBoard();
    }
    this.updateCastUIState(null, null);
    this.showToast('📺 Đã dừng chiếu lên màn hình PC');
  }

  broadcastCurrentCameraSync() {
    // KHÔNG gọi saveState() ở đây — camera sync được gọi liên tục trong khi pinch/pan,
    // gọi saveState() mỗi frame sẽ trigger scene.toJSON() + scheduleCanvasMirrorBroadcast() gây lag nặng.
    // saveState() chỉ được gọi khi kết thúc gesture (onTouchEnd / onPointerUp).
    this.broadcastCanvasCamera();
    if (this.isFocusMode && !this.focusSyncDisplay) return;
    if (!this.syncClient || !this.syncClient.currentCastBoardId) return;
    const boardId = this.syncClient.currentCastBoardId;
    const node = this.scene.getNode(boardId);
    if (!node) return;

    if (this._cameraSyncThrottler) return;
    this._cameraSyncThrottler = requestAnimationFrame(() => {
      this._cameraSyncThrottler = null;
      if (!this.syncClient || !this.syncClient.currentCastBoardId) return;

      const isMobile = window.innerWidth <= 768 || this.isSingleBoardMode;
      const paddingX = isMobile ? 14 : 64;
      const paddingTop = isMobile ? 60 : 64;
      const paddingBottom = isMobile ? 96 : 64;

      const availW = Math.max(160, window.innerWidth - paddingX * 2);
      const availH = Math.max(160, window.innerHeight - (paddingTop + paddingBottom));

      const worldTransform = this.scene.computeWorldTransform(node.id);
      const worldScale = Math.hypot(worldTransform.a, worldTransform.b) || 1.0;
      const worldW = (node.width || 800) * worldScale;
      const worldH = (node.height || 600) * worldScale;

      const baseFitZoom = Math.min(availW / worldW, availH / worldH);
      const fitRatio = this.camera.zoom / Math.max(0.001, baseFitZoom);

      const worldCenter = worldTransform.transformPoint(
        new Vec2(node.width * 0.5, node.height * 0.5)
      );
      const offsetYInWorld = isMobile ? ((paddingTop - paddingBottom) * 0.5) / this.camera.zoom : 0;
      const expectedCenterY = worldCenter.y - offsetYInWorld;

      const panOffsetX = this.camera.pan.x - worldCenter.x;
      const panOffsetY = this.camera.pan.y - expectedCenterY;

      this.syncClient.sendCameraSync(boardId, {
        contentZoom: node.contentZoom || 1.0,
        contentPan: {
          x: node.contentPan ? node.contentPan.x : 0,
          y: node.contentPan ? node.contentPan.y : 0,
        },
        width: node.width,
        height: node.height,
        fitRatio: fitRatio,
        panOffsetX: panOffsetX,
        panOffsetY: panOffsetY,
      });
    });
  }

  renderCastBoardsList() {
    const container = document.getElementById('cast-boards-list');
    if (!container) return;
    container.innerHTML = '';

    const boards = this.scene.root.children.filter((c) => c && c.id !== this.scene.root.id);
    const activeCastId = this.syncClient?.currentCastBoardId || null;

    if (boards.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 20px 14px; background: rgba(255,255,255,0.02); border-radius: 8px; border: 1px dashed var(--border-subtle); color: var(--text-muted); font-size: 12px; line-height: 1.6;">
          ⚠️ Bạn chưa có bảng nào trên màn hình.<br>
          Bấm <b style="color:#58a6ff;">"+ Thêm Bảng Mới"</b> ở trên để tạo bảng bài học.
        </div>
      `;
      return;
    }

    boards.forEach((board) => {
      const isCastingThis = activeCastId === board.id;
      const strokesCount = Array.isArray(board.elements) ? board.elements.length : 0;
      const typeLabel = board.graphData ? '📊 Đồ Thị Desmos' : (board.style === 'whiteboard' ? '📋 Bảng Trắng' : '📐 Bảng Phấn');

      const card = document.createElement('div');
      card.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 14px;
        border-radius: 10px;
        background: ${isCastingThis ? 'rgba(63, 185, 80, 0.12)' : 'rgba(255, 255, 255, 0.03)'};
        border: 1px solid ${isCastingThis ? 'rgba(63, 185, 80, 0.5)' : 'var(--border-subtle)'};
        transition: all 0.2s ease;
      `;

      card.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 4px;">
          <div style="font-weight: 700; font-size: 13.5px; color: ${isCastingThis ? '#3fb950' : '#f0f6fc'}; display: flex; align-items: center; gap: 6px;">
            <span>${board.name || 'Bảng Con'}</span>
            ${isCastingThis ? '<span style="font-size: 10px; background: rgba(63,185,80,0.2); color: #3fb950; padding: 2px 6px; border-radius: 10px;">Đang chiếu</span>' : ''}
          </div>
          <div style="font-size: 11px; color: var(--text-muted); display: flex; gap: 8px;">
            <span>${typeLabel}</span>
            <span>•</span>
            <span>${strokesCount} nét vẽ</span>
            <span>•</span>
            <span>${Math.round(board.width)}×${Math.round(board.height)} px</span>
          </div>
        </div>

        <div style="display: flex; align-items: center; gap: 8px;">
          ${isCastingThis ? `
            <button class="btn-action danger btn-stop-cast-item" style="padding: 6px 12px; font-size: 12px; cursor: pointer;">
              Dừng Chiếu
            </button>
          ` : `
            <button class="btn-action primary btn-start-cast-item" style="padding: 6px 14px; font-size: 12px; cursor: pointer; display: flex; align-items: center; gap: 4px;">
              <span>▶️ Chiếu Lên PC</span>
            </button>
          `}
        </div>
      `;

      const btnStart = card.querySelector('.btn-start-cast-item');
      if (btnStart) {
        btnStart.addEventListener('click', (e) => {
          e.stopPropagation();
          this.castBoardToPC(board);
          const modal = document.getElementById('modal-cast-pc');
          if (modal) modal.style.display = 'none';
        });
      }

      const btnStop = card.querySelector('.btn-stop-cast-item');
      if (btnStop) {
        btnStop.addEventListener('click', (e) => {
          e.stopPropagation();
          this.stopCastPC();
        });
      }

      container.appendChild(card);
    });
  }

  openGlobalLanSyncModal() {
    const modalSync = document.getElementById('modal-lan-sync');
    if (!modalSync) return;
    const inputServerHost = document.getElementById('input-server-host');
    if (inputServerHost && this.syncClient) {
      inputServerHost.value = this.syncClient.getHost();
    }
    modalSync.style.display = 'flex';
    this.renderLanSyncBoardsList();
  }

  renderLanSyncBoardsList() {
    const container = document.getElementById('lan-child-boards-list');
    const qrSection = document.getElementById('lan-qr-section');
    const urlSection = document.getElementById('lan-url-section');
    const inputUrl = document.getElementById('input-lan-url');
    const titleEl = document.getElementById('lan-qr-board-title');
    if (!container) return;

    container.innerHTML = '';
    const childBoards = this.scene.root.children.filter((c) => c && c.id !== this.scene.root.id);

    if (childBoards.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 16px 12px; background: rgba(255,255,255,0.02); border-radius: 8px; border: 1px dashed var(--border-subtle); color: var(--text-muted); font-size: 12px; line-height: 1.6;">
          ⚠️ Chưa có Bảng Con nào trên Canvas.<br>
          Bấm nút <b style="color:#58a6ff;">"+ Thêm Bảng"</b> trên thanh công cụ để tạo bảng học tập mới cần chia sẻ.
        </div>
      `;
      if (qrSection) qrSection.style.display = 'none';
      if (urlSection) urlSection.style.display = 'none';
      return;
    }

    const port = window.location.port || '3000';
    const host = this.syncClient?.localIp || this.syncClient?.getHost() || window.location.hostname || 'localhost';

    let selectedBoard = childBoards.find((b) => b.isShared) || childBoards[0];

    const updateSelectedBoardView = (board) => {
      selectedBoard = board;
      const boardUrl = `${window.location.protocol}//${host}:${port}/?board=${board.id}&server=${host}`;
      if (titleEl) titleEl.textContent = `Mã QR: ${board.name} ${board.isShared ? '🟢 (Đang mở)' : '⚪ (Chưa bật chia sẻ)'}`;
      if (inputUrl) inputUrl.value = boardUrl;
      if (qrSection) {
        qrSection.style.display = 'flex';
        this.renderQRCode(boardUrl);
      }
      if (urlSection) urlSection.style.display = 'flex';
    };

    childBoards.forEach((board) => {
      const row = document.createElement('div');
      row.style.cssText = 'display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.03); border: 1px solid var(--border-subtle); padding: 8px 12px; border-radius: 8px; font-size: 12px;';

      const left = document.createElement('div');
      left.style.cssText = 'display: flex; align-items: center; gap: 8px; cursor: pointer; flex: 1;';
      left.innerHTML = `
        <span style="font-size: 16px;">📋</span>
        <div>
          <div style="font-weight: 600; color: #f0f6fc;">${board.name}</div>
          <div style="font-size: 11px; color: ${board.isShared ? '#3fb950' : 'var(--text-muted)'};">
            ${board.isShared ? '🟢 Đang chia sẻ qua Socket' : '⚪ Chưa bật chia sẻ'}
          </div>
        </div>
      `;
      left.addEventListener('click', () => updateSelectedBoardView(board));

      const right = document.createElement('div');
      right.style.cssText = 'display: flex; align-items: center; gap: 8px;';

      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = !!board.isShared;
      toggle.title = 'Bật/Tắt chia sẻ bảng này';
      toggle.style.cursor = 'pointer';
      toggle.addEventListener('change', (e) => {
        this.toggleBoardShare(board, e.target.checked);
        this.renderLanSyncBoardsList();
      });

      const btnQr = document.createElement('button');
      btnQr.className = 'btn-action';
      btnQr.style.cssText = 'padding: 4px 8px; font-size: 11px;';
      btnQr.textContent = 'Mã QR';
      btnQr.addEventListener('click', () => updateSelectedBoardView(board));

      right.appendChild(btnQr);
      right.appendChild(toggle);
      row.appendChild(left);
      row.appendChild(right);
      container.appendChild(row);
    });

    if (selectedBoard) {
      updateSelectedBoardView(selectedBoard);
    }
  }

  checkRemoteLobby(sharedBoards = []) {
    if (this.isSingleBoardMode) return;
    const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    const isHostRole = localStorage.getItem('nestedcanvas_role') === 'host';
    if (isLocalHost || isHostRole) return; // Máy giáo viên, không hiện lobby

    const lobbyModal = document.getElementById('modal-remote-lobby');
    const container = document.getElementById('remote-lobby-boards-container');
    const btnUnlock = document.getElementById('btn-unlock-host-role');
    if (!lobbyModal || !container) return;

    if (btnUnlock && !btnUnlock.__bound) {
      btnUnlock.__bound = true;
      btnUnlock.addEventListener('click', () => {
        localStorage.setItem('nestedcanvas_role', 'host');
        lobbyModal.style.display = 'none';
        this.showToast('🔓 Đã mở quyền Người chủ trì (Host Canvas)');
      });
    }

    lobbyModal.style.display = 'flex';
    container.innerHTML = '';

    const list = Array.isArray(sharedBoards) ? sharedBoards : [];
    if (list.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 20px 14px; color: var(--text-muted); font-size: 13px; line-height: 1.6; background: rgba(255,255,255,0.02); border-radius: 8px;">
          ⏳ Thầy cô hiện chưa kích hoạt chia sẻ bảng con nào.<br>
          <span style="font-size: 11.5px; color: #8b949e;">Màn hình sẽ tự động cập nhật khi có bảng con được chia sẻ...</span>
        </div>
      `;
      return;
    }

    if (list.length === 1) {
      // Tự động chuyển hướng vào bảng con duy nhất
      window.location.replace(`/?board=${list[0].id}`);
      return;
    }

    list.forEach((b) => {
      const item = document.createElement('div');
      item.style.cssText = 'display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.04); border: 1px solid var(--border-subtle); padding: 12px 16px; border-radius: 10px;';
      item.innerHTML = `
        <div>
          <div style="font-weight: 700; font-size: 14px; color: #58a6ff;">📋 ${b.name || 'Bảng Con'}</div>
          <div style="font-size: 11.5px; color: #3fb950; margin-top: 2px;">🟢 Đang mở chia sẻ</div>
        </div>
      `;
      const btnJoin = document.createElement('button');
      btnJoin.className = 'btn-action primary';
      btnJoin.style.cssText = 'padding: 8px 16px; font-weight: 600; cursor: pointer;';
      btnJoin.textContent = 'Tham Gia Vẽ';
      btnJoin.addEventListener('click', () => {
        window.location.href = `/?board=${b.id}`;
      });
      item.appendChild(btnJoin);
      container.appendChild(item);
    });
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
        this.activeSessions,
        this.eraserCursor,
        this.ocrSelectionBox,
        this.ocrHighlightBoxes,
        this.remoteActiveSessions,
        {
          focusedNodeId: this.isFocusMode ? this.focusNodeId : null,
        }
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

