/**
 * NestedCanvas Smart Session Manager
 * Handles multi-session lifecycle: creation, auto-save with debounce, thumbnail generation,
 * switching, duplication, export/import (.nested), and migration from legacy localStorage.
 */

import { db } from './db.js';
import { jsPDF } from 'jspdf';

export const DEFAULT_EMPTY_THUMBNAIL = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="130" viewBox="0 0 220 130">
    <rect width="220" height="130" fill="#090d13"/>
    <rect x="12" y="12" width="196" height="106" rx="6" fill="#131822" stroke="#252d3d" stroke-width="1.2" stroke-dasharray="4 4"/>
    <text x="110" y="58" font-size="24" text-anchor="middle">📋</text>
    <text x="110" y="80" font-size="11.5" fill="#6e7681" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-weight="500" text-anchor="middle">Chưa có nét vẽ</text>
  </svg>`
);

export class SessionManager {
  constructor(options = {}) {
    this.currentSessionId = null;
    this.currentSessionMeta = null;
    this.syncClient = options.syncClient || null;
    this.onSessionChangeCallback = options.onSessionChange || null;
    this.onAutoSaveCallback = options.onAutoSave || null;
    this.autoSaveTimer = null;
    this.isSaving = false;
    this.hasPendingSave = false;
    this.pendingSaveArgs = null;
  }

  async init(initialFallbackData = null) {
    await db.init();

    // 1. Kiểm tra xem có phiên đang active được ghi nhớ không
    let activeId = await db.getMetadata('activeSessionId');
    let session = null;

    if (activeId) {
      session = await db.getFullSession(activeId);
    }

    // 2. Nếu không tìm thấy active session, kiểm tra danh sách session
    if (!session) {
      const allSessions = await db.getAllSessions();
      if (allSessions.length > 0) {
        activeId = allSessions[0].id;
        session = await db.getFullSession(activeId);
      }
    }

    // 3. Nếu DB chưa có session nào: Migrate từ localStorage hoặc tạo mới "Phiên làm việc 1"
    if (!session) {
      session = await this._migrateOrInitFirstSession(initialFallbackData);
      activeId = session.meta.id;
    }

    this.currentSessionId = activeId;
    this.currentSessionMeta = session.meta;
    await db.setMetadata('activeSessionId', activeId);

    if (this.onSessionChangeCallback) {
      this.onSessionChangeCallback(this.currentSessionMeta);
    }

    return session;
  }

  async _migrateOrInitFirstSession(initialFallbackData) {
    let migratedScene = null;
    let camera = { zoom: 1, pan: { x: 0, y: 0 } };
    let boardCounter = 0;
    let selectedNodeId = null;

    // Kiểm tra dữ liệu cũ trong localStorage
    try {
      const raw = localStorage.getItem('nestedcanvas_workspace_state');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.scene) migratedScene = parsed.scene;
        if (parsed.camera) camera = parsed.camera;
        if (typeof parsed.boardCounter === 'number') boardCounter = parsed.boardCounter;
        if (parsed.selectedNodeId) selectedNodeId = parsed.selectedNodeId;
        console.log('[SessionManager] 🔄 Migrated existing workspace from localStorage');
      }
    } catch (e) {
      console.warn('[SessionManager] Error reading legacy localStorage:', e);
    }

    if (!migratedScene && initialFallbackData) {
      migratedScene = initialFallbackData.scene || null;
      if (initialFallbackData.camera) camera = initialFallbackData.camera;
    }

    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const now = Date.now();
    const meta = {
      id: sessionId,
      name: 'Phiên làm việc 1',
      createdAt: now,
      updatedAt: now,
      boardCount: migratedScene ? this._countBoards(migratedScene) : 0,
      strokeCount: migratedScene ? this._countStrokes(migratedScene) : 0,
      thumbnail: DEFAULT_EMPTY_THUMBNAIL,
    };

    const content = {
      scene: migratedScene || { root: { children: [], strokes: [], images: [] } },
      camera,
      boardCounter,
      selectedNodeId,
      pages: [{
        id: `page_${now}_1`,
        name: 'Trang 1',
        scene: migratedScene || { root: { children: [], strokes: [], images: [] } },
        camera,
        theme: 'chalkboard',
        gridType: 'grid',
      }],
      currentPageIndex: 0,
    };

    await db.saveSession(meta, content);
    return { meta, content };
  }

  getCurrentSessionId() {
    return this.currentSessionId;
  }

  getCurrentSessionMeta() {
    return this.currentSessionMeta;
  }

  /**
   * Tạo phiên mới hoàn toàn
   */
  async createSession(name = 'Tiết học mới', initialData = null) {
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const now = Date.now();
    const meta = {
      id: sessionId,
      name: name.trim() || 'Bảng mới',
      createdAt: now,
      updatedAt: now,
      boardCount: 0,
      strokeCount: 0,
      thumbnail: DEFAULT_EMPTY_THUMBNAIL,
    };

    const content = initialData || {
      scene: { root: { id: 'root', type: 'root', children: [], strokes: [], images: [] } },
      camera: { zoom: 1, pan: { x: 0, y: 0 } },
      boardCounter: 0,
      selectedNodeId: null,
      pages: [{
        id: `page_${now}_1`,
        name: 'Trang 1',
        scene: { root: { id: 'root', type: 'root', children: [], strokes: [], images: [] } },
        camera: { zoom: 1, pan: { x: 0, y: 0 } },
        theme: 'chalkboard',
        gridType: 'grid',
      }],
      currentPageIndex: 0,
    };

    await db.saveSession(meta, content);
    return this.switchSession(sessionId);
  }

  /**
   * Chuyển sang một phiên khác
   */
  async switchSession(sessionId, broadcast = true) {
    if (!sessionId) return null;

    // Lưu phiên hiện tại ngay lập tức trước khi chuyển
    await this.flushSave();

    const session = await db.getFullSession(sessionId);
    if (!session) {
      console.warn(`[SessionManager] Session ${sessionId} not found`);
      return null;
    }

    this.currentSessionId = sessionId;
    this.currentSessionMeta = session.meta;
    await db.setMetadata('activeSessionId', sessionId);

    if (this.onSessionChangeCallback) {
      this.onSessionChangeCallback(this.currentSessionMeta);
    }

    // Thông báo cho sync server nếu có
    if (broadcast && this.syncClient && this.syncClient.isConnected) {
      this.syncClient.send('SESSION_SWITCH', {
        sessionId: session.meta.id,
        sessionName: session.meta.name,
      });
    }

    return session;
  }

  /**
   * Lưu hoặc cập nhật phiên từ Sync Server mà không kích hoạt auto-save echo loop
   */
  async saveSessionSilently(meta, content) {
    if (!meta || !meta.id || !content) return;
    try {
      await db.saveSession(meta, content);
      if (this.currentSessionId === meta.id) {
        this.currentSessionMeta = meta;
        if (this.onSessionChangeCallback) {
          this.onSessionChangeCallback(meta);
        }
      }
    } catch (e) {
      console.warn('[SessionManager] saveSessionSilently error:', e);
    }
  }

  /**
   * Đổi tên phiên
   */
  async renameSession(sessionId, newName) {
    if (!sessionId || !newName || !newName.trim()) return false;
    const meta = await db.getSessionMeta(sessionId);
    if (!meta) return false;

    meta.name = newName.trim();
    meta.updatedAt = Date.now();
    await db.saveSession(meta);

    if (this.currentSessionId === sessionId) {
      this.currentSessionMeta = meta;
      if (this.onSessionChangeCallback) {
        this.onSessionChangeCallback(this.currentSessionMeta);
      }
    }
    return true;
  }

  /**
   * Nhân bản phiên (Duplicate)
   */
  async duplicateSession(sessionId, customName = null) {
    const session = await db.getFullSession(sessionId);
    if (!session) return null;

    const newId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const now = Date.now();
    const newMeta = {
      ...session.meta,
      id: newId,
      name: customName || `${session.meta.name} (Bản sao)`,
      createdAt: now,
      updatedAt: now,
    };

    const newContent = {
      ...session.content,
      sessionId: newId,
      savedAt: now,
    };

    await db.saveSession(newMeta, newContent);
    return newMeta;
  }

  /**
   * Xóa một phiên
   */
  async deleteSession(sessionId) {
    if (!sessionId) return false;
    await db.deleteSession(sessionId);

    // Nếu vừa xóa phiên đang mở, tự động chuyển sang phiên khác còn lại
    if (this.currentSessionId === sessionId) {
      const remaining = await db.getAllSessions();
      if (remaining.length > 0) {
        await this.switchSession(remaining[0].id);
      } else {
        await this.createSession('Phiên làm việc 1');
      }
    }
    return true;
  }

  /**
   * Tự động lưu ngầm vào IndexedDB (Debounced 1500ms khi người dùng ngừng vẽ)
   * Ghi đè trực tiếp vào bản ghi sessionId hiện tại trong DB cục bộ
   */
  scheduleAutoSave(scene, camera, boardCounter, selectedNodeId, currentCastBoardId = null, pages = null, currentPageIndex = 0) {
    this.pendingSaveArgs = {
      scene: scene ? scene.toJSON() : null,
      camera: camera ? { zoom: camera.zoom, pan: { x: camera.pan.x, y: camera.pan.y } } : null,
      boardCounter,
      selectedNodeId,
      currentCastBoardId,
      pages,
      currentPageIndex,
    };

    if (this.autoSaveTimer) {
      clearTimeout(this.autoSaveTimer);
    }

    this.autoSaveTimer = setTimeout(() => {
      this.autoSaveTimer = null;
      this._performSave();
    }, 1500);
  }

  /**
   * Lưu phiên làm việc thủ công (Explicit Manual Save)
   */
  async saveCurrentSession(scene, camera, boardCounter, selectedNodeId, currentCastBoardId = null, pages = null, currentPageIndex = 0) {
    if (!this.currentSessionId) return null;
    this.pendingSaveArgs = {
      scene: scene ? scene.toJSON() : null,
      camera: camera ? { zoom: camera.zoom, pan: { x: camera.pan.x, y: camera.pan.y } } : null,
      boardCounter,
      selectedNodeId,
      currentCastBoardId,
      pages,
      currentPageIndex,
    };
    await this._performSave();
    return this.currentSessionMeta;
  }

  async flushSave() {
    if (this.autoSaveTimer) {
      clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    if (this.pendingSaveArgs) {
      await this._performSave();
    }
  }

  async _performSave() {
    if (!this.currentSessionId || !this.pendingSaveArgs) return;
    if (this.isSaving) {
      this.hasPendingSave = true;
      return;
    }

    this.isSaving = true;
    const args = this.pendingSaveArgs;
    this.pendingSaveArgs = null;

    try {
      const now = Date.now();
      const boardCount = args.scene ? this._countBoards(args.scene) : 0;
      const strokeCount = args.scene ? this._countStrokes(args.scene) : 0;

      // Sinh thumbnail nhẹ nhàng
      let thumbnail = this.currentSessionMeta?.thumbnail || '';
      if (args.scene) {
        thumbnail = this.generateThumbnail(args.scene);
      }

      const meta = {
        ...(this.currentSessionMeta || {}),
        id: this.currentSessionId,
        name: this.currentSessionMeta?.name || 'Phiên làm việc',
        updatedAt: now,
        boardCount,
        strokeCount,
        thumbnail,
      };

      const content = {
        sessionId: this.currentSessionId,
        scene: args.scene,
        camera: args.camera,
        boardCounter: args.boardCounter || 0,
        selectedNodeId: args.selectedNodeId || null,
        currentCastBoardId: args.currentCastBoardId || null,
        pages: args.pages || null,
        currentPageIndex: args.currentPageIndex || 0,
        savedAt: now,
      };

      // 1. Ghi đè trực tiếp vào bản ghi IndexedDB của chính session này
      await db.saveSession(meta, content);
      this.currentSessionMeta = meta;

      // 2. Báo hiệu lưu thành công cho giao diện
      if (this.onAutoSaveCallback) {
        this.onAutoSaveCallback(this.currentSessionMeta);
      }

      // 3. Lưu 1 bản backup nhẹ vào localStorage phòng hờ
      try {
        localStorage.setItem('nestedcanvas_active_session_id', this.currentSessionId);
      } catch (e) { }


      // SESSION_BACKUP bị tắt trong autosave — server sẽ relay SESSION_UPDATE
      // tới display gây reset camera liên tục. Chỉ gửi backup khi lưu thủ công.
      // if (this.syncClient && this.syncClient.isConnected) {
      //   this.syncClient.send('SESSION_BACKUP', { ... });
      // }

    } catch (err) {
      console.warn('[SessionManager] Auto-save error:', err);
    } finally {
      this.isSaving = false;
      if (this.hasPendingSave) {
        this.hasPendingSave = false;
        this._performSave();
      }
    }
  }

  /**
   * Tạo ảnh thumbnail thu nhỏ từ dữ liệu scene (220x130px)
   */
  generateThumbnail(sceneData) {
    if (!sceneData || !sceneData.root) return '';
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 220;
      canvas.height = 130;
      const ctx = canvas.getContext('2d');
      if (!ctx) return '';

      // Nền tối hiện đại
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Thu thập tất cả các nét vẽ và bảng con kèm tọa độ thế giới (world coordinates)
      const allStrokes = [];
      const boards = [];

      const collect = (node, parentTx = 0, parentTy = 0, isRoot = true) => {
        if (!node) return;
        const tr = node.transform || {};
        const tx = parentTx + (tr.tx ?? tr.x ?? node.x ?? 0);
        const ty = parentTy + (tr.ty ?? tr.y ?? node.y ?? 0);

        if (!isRoot) {
          boards.push({
            x: tx,
            y: ty,
            width: node.width || 800,
            height: node.height || 600,
          });
        }

        const elements = node.elements || node.strokes || [];
        const zoom = !isRoot ? (node.contentZoom || 1) : 1;
        const panX = !isRoot ? (node.contentPan?.x || 0) : 0;
        const panY = !isRoot ? (node.contentPan?.y || 0) : 0;

        for (const s of elements) {
          if (Array.isArray(s.points) && s.points.length >= 1) {
            allStrokes.push({
              color: s.color || '#ffffff',
              baseWidth: s.baseWidth || 2,
              points: s.points.map((p) => ({
                x: p.x * zoom - panX + tx,
                y: p.y * zoom - panY + ty,
              })),
            });
          }
        }

        if (Array.isArray(node.children)) {
          for (const c of node.children) collect(c, tx, ty, false);
        }
      };
      collect(sceneData.root, 0, 0, true);

      if (allStrokes.length === 0 && boards.length === 0) {
        return DEFAULT_EMPTY_THUMBNAIL;
      }

      // Tính bounding box tổng quan
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const s of allStrokes) {
        for (const p of s.points) {
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        }
      }

      for (const b of boards) {
        if (b.x < minX) minX = b.x;
        if (b.y < minY) minY = b.y;
        if (b.x + b.width > maxX) maxX = b.x + b.width;
        if (b.y + b.height > maxY) maxY = b.y + b.height;
      }

      if (!isFinite(minX) || !isFinite(maxX)) {
        minX = 0; minY = 0; maxX = 1000; maxY = 600;
      }

      const padding = 30;
      minX -= padding; minY -= padding;
      maxX += padding; maxY += padding;
      const bW = Math.max(100, maxX - minX);
      const bH = Math.max(100, maxY - minY);

      const scale = Math.min(canvas.width / bW, canvas.height / bH);
      const offsetX = (canvas.width - bW * scale) / 2 - minX * scale;
      const offsetY = (canvas.height - bH * scale) / 2 - minY * scale;

      // Vẽ viền các bảng con
      ctx.fillStyle = 'rgba(88, 166, 255, 0.08)';
      ctx.strokeStyle = 'rgba(88, 166, 255, 0.4)';
      ctx.lineWidth = 1.2;
      for (const b of boards) {
        const cx = b.x * scale + offsetX;
        const cy = b.y * scale + offsetY;
        const cw = b.width * scale;
        const ch = b.height * scale;
        ctx.fillRect(cx, cy, cw, ch);
        ctx.strokeRect(cx, cy, cw, ch);
      }

      // Vẽ các nét vẽ thu nhỏ
      for (const s of allStrokes) {
        if (!Array.isArray(s.points) || s.points.length < 2) continue;
        ctx.beginPath();
        ctx.strokeStyle = s.color || '#58a6ff';
        ctx.lineWidth = Math.max(1, (s.baseWidth || 2) * scale);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        ctx.moveTo(s.points[0].x * scale + offsetX, s.points[0].y * scale + offsetY);
        for (let i = 1; i < s.points.length; i++) {
          ctx.lineTo(s.points[i].x * scale + offsetX, s.points[i].y * scale + offsetY);
        }
        ctx.stroke();
      }

      return canvas.toDataURL('image/webp', 0.65);
    } catch (e) {
      console.warn('[SessionManager] Thumbnail error:', e);
      return '';
    }
  }

  /**
   * Phân tích cây phân cấp toàn cảnh (Hierarchy Tree Analysis)
   */
  _analyzeHierarchy(rootNode) {
    const flatBoards = [];
    let totalStrokes = 0;

    const traverse = (node, parentMatrix = { tx: 0, ty: 0, sx: 1, sy: 1 }, level = 0, path = []) => {
      if (!node) return null;
      const isRoot = level === 0;
      const tr = node.transform || {};
      const ntx = tr.tx ?? tr.x ?? 0;
      const nty = tr.ty ?? tr.y ?? 0;

      const worldTx = isRoot ? 0 : parentMatrix.tx + ntx * parentMatrix.sx;
      const worldTy = isRoot ? 0 : parentMatrix.ty + nty * parentMatrix.sy;
      const worldSx = isRoot ? 1 : parentMatrix.sx * (tr.a ?? 1);
      const worldSy = isRoot ? 1 : parentMatrix.sy * (tr.d ?? 1);

      const w = (node.width || 800) * worldSx;
      const h = (node.height || 600) * worldSy;

      const currentPath = [...path, { id: node.id, name: isRoot ? 'Toàn bộ Bảng Chính' : (node.name || 'Bảng con') }];
      const elements = node.elements || node.strokes || [];
      const strokeCount = elements.length;
      totalStrokes += strokeCount;

      const boardItem = {
        id: node.id,
        name: isRoot ? 'Toàn bộ Bảng Chính' : (node.name || 'Bảng con'),
        isRoot,
        level,
        style: node.style || 'chalkboard',
        strokeCount,
        path: currentPath,
        width: node.width || 800,
        height: node.height || 600,
        worldX: worldTx,
        worldY: worldTy,
        worldW: w,
        worldH: h,
        bounds: {
          minX: isRoot ? Infinity : worldTx,
          minY: isRoot ? Infinity : worldTy,
          maxX: isRoot ? -Infinity : worldTx + w,
          maxY: isRoot ? -Infinity : worldTy + h,
        },
        children: [],
        node,
      };

      if (isRoot) {
        for (const s of elements) {
          for (const p of s.points || []) {
            if (p.x < boardItem.bounds.minX) boardItem.bounds.minX = p.x;
            if (p.y < boardItem.bounds.minY) boardItem.bounds.minY = p.y;
            if (p.x > boardItem.bounds.maxX) boardItem.bounds.maxX = p.x;
            if (p.y > boardItem.bounds.maxY) boardItem.bounds.maxY = p.y;
          }
        }
      }

      flatBoards.push(boardItem);

      const cZoom = !isRoot ? (node.contentZoom || 1) : 1;
      const cPanX = !isRoot ? (node.contentPan?.x || 0) : 0;
      const cPanY = !isRoot ? (node.contentPan?.y || 0) : 0;

      const innerMatrix = !isRoot
        ? { tx: worldTx - cPanX * worldSx, ty: worldTy - cPanY * worldSy, sx: worldSx * cZoom, sy: worldSy * cZoom }
        : { tx: 0, ty: 0, sx: 1, sy: 1 };

      if (Array.isArray(node.children)) {
        for (const child of node.children) {
          const childItem = traverse(child, innerMatrix, level + 1, currentPath);
          if (childItem) {
            boardItem.children.push(childItem);
            if (isFinite(childItem.bounds.minX)) {
              boardItem.bounds.minX = Math.min(boardItem.bounds.minX, childItem.bounds.minX);
              boardItem.bounds.minY = Math.min(boardItem.bounds.minY, childItem.bounds.minY);
              boardItem.bounds.maxX = Math.max(boardItem.bounds.maxX, childItem.bounds.maxX);
              boardItem.bounds.maxY = Math.max(boardItem.bounds.maxY, childItem.bounds.maxY);
            }
          }
        }
      }

      return boardItem;
    };

    const rootItem = traverse(rootNode, { tx: 0, ty: 0, sx: 1, sy: 1 }, 0, []);
    return { rootItem, flatBoards, totalStrokes };
  }

  /**
   * Lấy danh sách các bảng trong một phiên (phục vụ checklist chọn bảng khi xuất)
   */
  async getSessionBoards(sessionId) {
    if (this.currentSessionId === sessionId) {
      await this.flushSave();
    }
    const session = await db.getFullSession(sessionId);
    if (!session || !session.content) return [];

    if (session.content.pages && Array.isArray(session.content.pages) && session.content.pages.length > 0) {
      const allBoards = [];
      session.content.pages.forEach((page, pIdx) => {
        if (page.scene?.root) {
          const hierarchy = this._analyzeHierarchy(page.scene.root);
          hierarchy.flatBoards.forEach((b) => {
            if (b.isRoot) {
              b.name = page.name || `Trang ${pIdx + 1}`;
            }
            allBoards.push(b);
          });
        }
      });
      return allBoards;
    }

    if (!session.content?.scene?.root) return [];
    const hierarchy = this._analyzeHierarchy(session.content.scene.root);
    return hierarchy.flatBoards;
  }

  /**
   * Xuất bài giảng ra tệp JSON chuẩn (.json)
   * Tương thích 100% để mang sang máy tính / phòng học khác nạp vào là tiếp tục giảng dạy ngay
   */
  async exportSessionJSON(sessionId, selectedBoardIds = null) {
    if (this.currentSessionId === sessionId) {
      await this.flushSave();
    }
    const session = await db.getFullSession(sessionId);
    if (!session || !session.content?.scene?.root) return false;

    let sceneRoot = session.content.scene.root;

    // Lọc theo bảng được chọn nếu người dùng chọn phạm vi cụ thể
    if (Array.isArray(selectedBoardIds) && selectedBoardIds.length > 0) {
      const isSelectedOrHasDescendant = (node) => {
        if (!node) return false;
        if (selectedBoardIds.includes(node.id)) return true;
        if (Array.isArray(node.children)) {
          return node.children.some(isSelectedOrHasDescendant);
        }
        return false;
      };

      const filterNode = (node) => {
        if (!node) return null;
        const copy = { ...node };
        if (node.id !== session.content.scene.root.id && !selectedBoardIds.includes(node.id)) {
          copy.elements = [];
          copy.strokes = [];
        }
        if (Array.isArray(node.children)) {
          copy.children = node.children
            .filter(isSelectedOrHasDescendant)
            .map(filterNode)
            .filter(Boolean);
        }
        return copy;
      };

      sceneRoot = filterNode(session.content.scene.root);
    }

    const exportPayload = {
      app: 'NestedCanvas',
      version: 2,
      exportedAt: new Date().toISOString(),
      meta: {
        id: session.meta.id,
        name: session.meta.name || 'Bài giảng',
        createdAt: session.meta.createdAt,
        updatedAt: session.meta.updatedAt,
      },
      content: {
        ...session.content,
        scene: {
          ...session.content.scene,
          root: sceneRoot,
        },
      },
    };

    const jsonString = JSON.stringify(exportPayload, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeName = (session.meta.name || 'bai_giang').replace(/[^a-zA-Z0-9_\u00C0-\u024F\u1E00-\u1EFF]/g, '_');
    a.download = `${safeName}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return true;
  }

  /**
   * Xuất bài giảng ra tài liệu PDF Phân Trang (.pdf)
   * Tự động tạo mỗi bảng là một trang A4 sắc nét 300dpi, có tiêu đề và số trang
   * Hỗ trợ xuất toàn bộ hoặc chỉ xuất các bảng được chọn
   */
  async exportSessionPDF(sessionId, selectedBoardIds = null) {
    if (this.currentSessionId === sessionId) {
      await this.flushSave();
    }
    const session = await db.getFullSession(sessionId);
    if (!session || !session.content) return false;

    // Xác định danh sách bảng cần xuất (từ các trang hoặc scene chính)
    let targetBoards = [];
    if (session.content.pages && Array.isArray(session.content.pages) && session.content.pages.length > 0) {
      session.content.pages.forEach((page, pIdx) => {
        if (page.scene?.root) {
          const hierarchy = this._analyzeHierarchy(page.scene.root);
          hierarchy.flatBoards.forEach((b) => {
            if (b.isRoot) {
              b.name = page.name || `Trang ${pIdx + 1}`;
            }
            targetBoards.push(b);
          });
        }
      });
    } else if (session.content.scene?.root) {
      const hierarchy = this._analyzeHierarchy(session.content.scene.root);
      targetBoards = hierarchy.flatBoards;
    }

    if (Array.isArray(selectedBoardIds) && selectedBoardIds.length > 0) {
      targetBoards = targetBoards.filter((b) => selectedBoardIds.includes(b.id));
    }

    if (targetBoards.length === 0) {
      targetBoards = [hierarchy.flatBoards[0]];
    }

    const firstBoard = targetBoards[0];
    const isFirstLandscape = (firstBoard.width || 800) >= (firstBoard.height || 600);
    const pdf = new jsPDF({
      orientation: isFirstLandscape ? 'landscape' : 'portrait',
      unit: 'mm',
      format: 'a4',
      compress: true,
    });

    const BOARD_THEMES = {
      chalkboard: { bg: '#0d1f18', border: '#2e5b47', headerBg: '#122b22', text: '#58d68d' },
      whiteboard: { bg: '#f8fafc', border: '#cbd5e1', headerBg: '#e2e8f0', text: '#0f172a' },
      blueprint: { bg: '#0a192f', border: '#1d3557', headerBg: '#06101e', text: '#64ffda' },
      midnight: { bg: '#06080c', border: '#1e293b', headerBg: '#0f172a', text: '#f0f6fc' },
      default: { bg: '#161b22', border: '#58a6ff', headerBg: '#21262d', text: '#58a6ff' },
    };

    for (let i = 0; i < targetBoards.length; i++) {
      const b = targetBoards[i];
      const isLandscape = (b.width || 800) >= (b.height || 600);

      if (i > 0) {
        pdf.addPage('a4', isLandscape ? 'landscape' : 'portrait');
      }

      const pageWidth = isLandscape ? 297 : 210;
      const pageHeight = isLandscape ? 210 : 297;
      const margin = 12;
      const availW = pageWidth - margin * 2;
      const availH = pageHeight - margin * 2 - 14;

      const canvas = document.createElement('canvas');
      const scale = 2;
      const bw = b.isRoot ? Math.max(1200, Math.min(2400, (b.bounds.maxX - b.bounds.minX) || 1200)) : (b.width || 800);
      const bh = b.isRoot ? Math.max(800, Math.min(1800, (b.bounds.maxY - b.bounds.minY) || 800)) : (b.height || 600);
      canvas.width = bw * scale;
      canvas.height = bh * scale;
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);

      const theme = BOARD_THEMES[b.style] || BOARD_THEMES.chalkboard;

      if (!b.isRoot) {
        ctx.fillStyle = theme.bg;
        ctx.fillRect(0, 0, bw, bh);

        const headerH = 36;
        ctx.fillStyle = theme.headerBg;
        ctx.fillRect(0, 0, bw, headerH);
        ctx.strokeStyle = theme.border;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(0, 0, bw, bh);
        ctx.beginPath();
        ctx.moveTo(0, headerH);
        ctx.lineTo(bw, headerH);
        ctx.stroke();

        ctx.fillStyle = theme.text;
        ctx.font = 'bold 16px sans-serif';
        ctx.textBaseline = 'middle';
        ctx.fillText(b.name || 'Bảng con', 14, headerH * 0.5);

        ctx.beginPath();
        ctx.rect(0, headerH, bw, bh - headerH);
        ctx.clip();

        const cZoom = b.node.contentZoom || 1.0;
        const cPanX = b.node.contentPan?.x || 0;
        const cPanY = b.node.contentPan?.y || 0;
        ctx.translate(-cPanX, -cPanY);
        ctx.scale(cZoom, cZoom);
      } else {
        ctx.fillStyle = '#0d1117';
        ctx.fillRect(0, 0, bw, bh);
        const offsetX = isFinite(b.bounds.minX) ? b.bounds.minX - 30 : 0;
        const offsetY = isFinite(b.bounds.minY) ? b.bounds.minY - 30 : 0;
        ctx.translate(-offsetX, -offsetY);
      }

      const elements = b.node.elements || b.node.strokes || [];
      for (const s of elements) {
        if (!Array.isArray(s.points) || s.points.length === 0) continue;
        ctx.beginPath();
        ctx.strokeStyle = s.color || '#ffffff';
        ctx.lineWidth = s.baseWidth || 3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        if (s.points.length === 1) {
          ctx.arc(s.points[0].x, s.points[0].y, (s.baseWidth || 3) / 2, 0, Math.PI * 2);
          ctx.fillStyle = s.color || '#ffffff';
          ctx.fill();
        } else {
          ctx.moveTo(s.points[0].x, s.points[0].y);
          for (let k = 1; k < s.points.length; k++) ctx.lineTo(s.points[k].x, s.points[k].y);
          ctx.stroke();
        }
      }

      const imgRatio = bw / bh;
      let drawW = availW;
      let drawH = drawW / imgRatio;
      if (drawH > availH) {
        drawH = availH;
        drawW = drawH * imgRatio;
      }
      const posX = margin + (availW - drawW) / 2;
      const posY = margin + 5 + (availH - drawH) / 2;

      pdf.setFontSize(10);
      pdf.setTextColor(120, 120, 120);
      const pageTitle = b.isRoot ? 'Toàn bộ Bảng Chính' : b.name;
      pdf.text(
        `${session.meta.name || 'Bài giảng'} • ${pageTitle} (${i + 1}/${targetBoards.length})`,
        margin,
        margin + 2
      );

      const imgData = canvas.toDataURL('image/jpeg', 0.95);
      pdf.addImage(imgData, 'JPEG', posX, posY, drawW, drawH);

      pdf.setFontSize(8);
      pdf.setTextColor(160, 160, 160);
      pdf.text(
        `Xuất bản từ NestedCanvas • Trang ${i + 1} / ${targetBoards.length}`,
        pageWidth / 2,
        pageHeight - 5,
        { align: 'center' }
      );
    }

    const safeName = (session.meta.name || 'Bai_giang').replace(/[^a-z0-9\u00C0-\u024F\u1EA0-\u1EF9]/gi, '_');
    pdf.save(`${safeName}.pdf`);
    return true;
  }

  /**
   * Xuất bài giảng ra trang Web HTML Độc Lập (.html)
   * Tự chứa toàn bộ dữ liệu + Trình xem Canvas tương tác + Cây phân cấp rõ ràng + Chế độ Giáo Trình
   * Hỗ trợ xuất toàn bộ hoặc chỉ xuất các bảng được chọn
   */
  async exportSessionHTML(sessionId, selectedBoardIds = null) {
    if (this.currentSessionId === sessionId) {
      await this.flushSave();
    }
    const session = await db.getFullSession(sessionId);
    if (!session || !session.content?.scene?.root) return false;

    let sceneRoot = session.content.scene.root;
    if (Array.isArray(selectedBoardIds) && selectedBoardIds.length > 0) {
      const isSelectedOrHasDescendant = (node) => {
        if (!node) return false;
        if (selectedBoardIds.includes(node.id)) return true;
        if (Array.isArray(node.children)) {
          return node.children.some(isSelectedOrHasDescendant);
        }
        return false;
      };

      const filterNode = (node) => {
        if (!node) return null;
        const copy = { ...node };
        if (node.id !== session.content.scene.root.id && !selectedBoardIds.includes(node.id)) {
          copy.elements = [];
        }
        if (Array.isArray(node.children)) {
          copy.children = node.children
            .filter(isSelectedOrHasDescendant)
            .map(filterNode);
        }
        return copy;
      };

      sceneRoot = filterNode(sceneRoot);
    }

    const sessionData = {
      meta: session.meta,
      content: {
        ...session.content,
        scene: {
          ...session.content.scene,
          root: sceneRoot,
        },
      },
      exportedAt: new Date().toLocaleString('vi-VN'),
    };

    const safeName = (session.meta.name || 'Bai_giang').replace(/[^a-z0-9\u00C0-\u024F\u1EA0-\u1EF9]/gi, '_');
    const htmlContent = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes">
  <title>${session.meta.name || 'Bài giảng'} - NestedCanvas Viewer</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
    body, html { width: 100%; height: 100%; overflow: hidden; background: #0d1117; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #f0f6fc; }
    #viewer-container { width: 100%; height: 100%; position: relative; display: flex; flex-direction: column; }
    
    /* Thanh điều khiển trên cùng (Header) */
    .viewer-header {
      position: absolute; top: 12px; left: 16px; right: 16px;
      display: flex; justify-content: space-between; align-items: center;
      background: rgba(13, 17, 23, 0.92); backdrop-filter: blur(16px);
      border: 1px solid rgba(88, 166, 255, 0.25); border-radius: 12px;
      padding: 10px 16px; z-index: 100; box-shadow: 0 12px 32px rgba(0,0,0,0.6);
      flex-wrap: wrap; gap: 8px;
    }
    .brand-title { display: flex; align-items: center; gap: 10px; cursor: pointer; }
    .session-title { font-size: 15px; font-weight: 700; color: #58a6ff; display: flex; align-items: center; gap: 6px; }
    .session-date { font-size: 11px; color: #8b949e; }
    
    .viewer-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .viewer-btn {
      background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.15);
      color: #c9d1d9; border-radius: 6px; padding: 6px 12px; font-size: 12px; font-weight: 600;
      cursor: pointer; display: flex; align-items: center; gap: 6px; transition: all 0.2s;
    }
    .viewer-btn:hover { background: rgba(88, 166, 255, 0.15); color: #58a6ff; border-color: #58a6ff; }
    .viewer-btn.active { background: #1f6feb; color: #ffffff; border-color: #58a6ff; }
    
    .board-select {
      background: #161b22; border: 1px solid rgba(88, 166, 255, 0.3); color: #58a6ff;
      border-radius: 6px; padding: 6px 10px; font-size: 12px; font-weight: 600; outline: none; cursor: pointer;
      max-width: 220px;
    }

    /* Thanh Breadcrumb hiển thị cấp bậc đang xem */
    .breadcrumb-bar {
      position: absolute; top: 68px; left: 16px; z-index: 90;
      display: flex; align-items: center; gap: 6px;
      background: rgba(13, 17, 23, 0.85); backdrop-filter: blur(10px);
      border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 8px;
      padding: 5px 12px; font-size: 12px; color: #8b949e;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
    .breadcrumb-node { color: #58a6ff; cursor: pointer; font-weight: 600; }
    .breadcrumb-node:hover { text-decoration: underline; }
    .breadcrumb-sep { color: #484f58; font-size: 10px; }
    
    /* Khung vẽ Canvas */
    #canvas-wrap { width: 100%; height: 100%; position: relative; }
    canvas { width: 100%; height: 100%; display: block; background: #0d1117; cursor: grab; }
    canvas:active { cursor: grabbing; }

    /* Cây phân cấp bài giảng Sidebar */
    .hierarchy-sidebar {
      position: absolute; top: 68px; right: 16px; bottom: 44px; width: 320px;
      background: rgba(13, 17, 23, 0.95); backdrop-filter: blur(20px);
      border: 1px solid rgba(88, 166, 255, 0.3); border-radius: 12px;
      padding: 14px; z-index: 105; box-shadow: 0 16px 40px rgba(0,0,0,0.7);
      display: flex; flex-direction: column; gap: 10px;
      transition: transform 0.25s ease, opacity 0.25s ease;
    }
    .hierarchy-sidebar.hidden {
      transform: translateX(120%);
      opacity: 0;
      pointer-events: none;
    }
    .sidebar-header {
      display: flex; justify-content: space-between; align-items: center;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1); padding-bottom: 8px;
    }
    .sidebar-title { font-size: 14px; font-weight: 700; color: #58a6ff; display: flex; align-items: center; gap: 6px; }
    .sidebar-close { background: none; border: none; color: #8b949e; font-size: 16px; cursor: pointer; }
    .sidebar-close:hover { color: #f0f6fc; }
    
    .sidebar-search {
      background: #161b22; border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 6px;
      padding: 6px 10px; color: #f0f6fc; font-size: 12px; outline: none;
    }
    .sidebar-search:focus { border-color: #58a6ff; }
    
    .tree-scroll { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; padding-right: 4px; }
    .tree-item {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 10px; border-radius: 8px; cursor: pointer;
      font-size: 13px; color: #c9d1d9; transition: all 0.15s;
      border: 1px solid transparent;
    }
    .tree-item:hover { background: rgba(88, 166, 255, 0.12); color: #58a6ff; }
    .tree-item.active { background: rgba(88, 166, 255, 0.2); border-color: #58a6ff; color: #ffffff; font-weight: 600; }
    .tree-item-title { display: flex; align-items: center; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tree-badge { font-size: 10px; padding: 2px 6px; border-radius: 10px; background: rgba(255,255,255,0.1); color: #8b949e; }
    .tree-item.active .tree-badge { background: #58a6ff; color: #0d1117; font-weight: bold; }

    /* Chế độ Sổ Giáo Trình / Danh Sách Thẻ (Outline Cards View) */
    #outline-view {
      position: absolute; top: 68px; left: 16px; right: 16px; bottom: 16px;
      background: #0d1117; z-index: 80; overflow-y: auto;
      padding: 16px; border-radius: 12px; border: 1px solid rgba(255, 255, 255, 0.1);
      display: none; flex-direction: column; gap: 20px;
    }
    #outline-view.visible { display: flex; }
    .outline-card {
      background: #161b22; border: 1px solid rgba(88, 166, 255, 0.25);
      border-radius: 10px; overflow: hidden; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    }
    .outline-card-header {
      background: rgba(88, 166, 255, 0.12); padding: 10px 16px;
      display: flex; justify-content: space-between; align-items: center;
      border-bottom: 1px solid rgba(88, 166, 255, 0.2);
    }
    .outline-card-title { font-size: 15px; font-weight: 700; color: #58a6ff; display: flex; align-items: center; gap: 8px; }
    .outline-card-body { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    .outline-preview-wrap { width: 100%; max-height: 420px; background: #000; border-radius: 8px; overflow: hidden; display: flex; justify-content: center; align-items: center; }
    .outline-preview-canvas { max-width: 100%; height: auto; display: block; }
    
    /* Hướng dẫn góc dưới */
    .viewer-tips {
      position: absolute; bottom: 12px; left: 16px;
      background: rgba(13, 17, 23, 0.85); backdrop-filter: blur(8px);
      border: 1px solid rgba(255,255,255,0.1); border-radius: 8px;
      padding: 6px 12px; font-size: 11px; color: #8b949e; pointer-events: none; z-index: 50;
    }
    
    @media (max-width: 768px) {
      .viewer-header { padding: 8px 12px; }
      .hierarchy-sidebar { width: calc(100% - 32px); left: 16px; right: 16px; }
      .session-title { font-size: 13px; max-width: 140px; }
      .viewer-tips { display: none; }
    }
    @media print {
      .viewer-header, .breadcrumb-bar, .hierarchy-sidebar, .viewer-tips { display: none !important; }
      #outline-view { display: flex !important; position: static; overflow: visible; border: none; }
      .outline-card { break-inside: avoid; margin-bottom: 24px; border: 1px solid #000; background: #fff; color: #000; }
      .outline-card-title { color: #000; }
      body, html { overflow: visible; background: #fff; }
    }
  </style>
</head>
<body>
  <div id="viewer-container">
    <!-- Header -->
    <header class="viewer-header">
      <div class="brand-title" id="btn-brand">
        <span style="font-size: 20px;">📁</span>
        <div>
          <div class="session-title" id="title-text">Bài giảng</div>
          <div class="session-date" id="date-text">Xuất bản: vừa xong</div>
        </div>
      </div>
      <div class="viewer-actions">
        <button id="btn-toggle-sidebar" class="viewer-btn" title="Mở danh mục cây phân cấp bài giảng">
          🌳 Mục Lục Phân Cấp
        </button>
        <button id="btn-toggle-view" class="viewer-btn" title="Chuyển giữa Bản Đồ Canvas và Sổ Giáo Trình">
          📑 Sổ Giáo Trình
        </button>
        <select id="select-boards" class="board-select" title="Nhảy nhanh đến bảng con"></select>
        <button id="btn-zoom-fit" class="viewer-btn" title="Thu phóng vừa toàn bộ">🎯 Vừa màn hình</button>
        <button id="btn-zoom-reset" class="viewer-btn" title="Phóng chuẩn 100%">🔍 100%</button>
        <button id="btn-print" class="viewer-btn" title="In hoặc lưu file PDF">🖨️ In / PDF</button>
        <button id="btn-fullscreen" class="viewer-btn" title="Toàn màn hình">⛶</button>
      </div>
    </header>

    <!-- Breadcrumb -->
    <div class="breadcrumb-bar" id="breadcrumb-bar">
      <span class="breadcrumb-node" id="bc-root">🌍 Bảng Chính</span>
    </div>

    <!-- Canvas Map View -->
    <div id="canvas-wrap">
      <canvas id="viewer-canvas"></canvas>
      <div class="viewer-tips">💡 Kéo chuột/ngón tay để di chuyển • Lăn chuột hoặc chụm 2 ngón tay để Thu phóng • Bấm vào bảng để chọn</div>
    </div>

    <!-- Cây phân cấp Sidebar -->
    <aside class="hierarchy-sidebar hidden" id="hierarchy-sidebar">
      <div class="sidebar-header">
        <div class="sidebar-title">🌳 Phân Cấp Bài Giảng</div>
        <button class="sidebar-close" id="btn-close-sidebar">✕</button>
      </div>
      <input type="text" id="sidebar-search" class="sidebar-search" placeholder="🔍 Lọc bảng theo tên..." />
      <div class="tree-scroll" id="tree-list"></div>
    </aside>

    <!-- Chế độ Sổ Giáo Trình (Outline Cards View) -->
    <section id="outline-view"></section>
  </div>

  <script>
    const SESSION_DATA = ${JSON.stringify(sessionData)};

    const canvas = document.getElementById('viewer-canvas');
    const ctx = canvas.getContext('2d');
    const selectBoards = document.getElementById('select-boards');
    const breadcrumbBar = document.getElementById('breadcrumb-bar');
    const hierarchySidebar = document.getElementById('hierarchy-sidebar');
    const treeList = document.getElementById('tree-list');
    const outlineView = document.getElementById('outline-view');
    const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
    const btnToggleView = document.getElementById('btn-toggle-view');
    const sidebarSearch = document.getElementById('sidebar-search');

    document.getElementById('title-text').textContent = SESSION_DATA.meta?.name || 'Bài giảng';
    document.getElementById('date-text').textContent = 'Xuất bản: ' + (SESSION_DATA.exportedAt || '');

    const BOARD_THEMES = {
      chalkboard: { bg: '#0d1f18', border: '#2e5b47', headerBg: '#122b22', text: '#58d68d', name: 'Phấn Xanh', icon: '🟢' },
      whiteboard: { bg: '#f8fafc', border: '#cbd5e1', headerBg: '#e2e8f0', text: '#0f172a', name: 'Bảng Trắng', icon: '🏢' },
      blueprint: { bg: '#0a192f', border: '#1d3557', headerBg: '#06101e', text: '#64ffda', name: 'Kỹ Thuật', icon: '📐' },
      midnight: { bg: '#06080c', border: '#1e293b', headerBg: '#0f172a', text: '#f0f6fc', name: 'Đen OLED', icon: '🌌' },
      default: { bg: '#161b22', border: '#30363d', headerBg: '#21262d', text: '#58a6ff', name: 'Mặc Định', icon: '📑' },
    };

    // 1. Phân tích cấu trúc phân cấp cây bài giảng (Tree Hierarchy Analysis)
    function analyzeHierarchy(rootNode) {
      const flatBoards = [];
      let totalStrokes = 0;

      function traverse(node, parentMatrix = { tx: 0, ty: 0, sx: 1, sy: 1 }, level = 0, path = []) {
        if (!node) return null;
        const isRoot = level === 0;
        const tr = node.transform || {};
        const ntx = tr.tx ?? tr.x ?? 0;
        const nty = tr.ty ?? tr.y ?? 0;

        const worldTx = isRoot ? 0 : parentMatrix.tx + ntx * parentMatrix.sx;
        const worldTy = isRoot ? 0 : parentMatrix.ty + nty * parentMatrix.sy;
        const worldSx = isRoot ? 1 : parentMatrix.sx * (tr.a ?? 1);
        const worldSy = isRoot ? 1 : parentMatrix.sy * (tr.d ?? 1);

        const w = (node.width || 800) * worldSx;
        const h = (node.height || 600) * worldSy;

        const currentPath = [...path, { id: node.id, name: isRoot ? 'Toàn bộ Bảng Chính' : (node.name || 'Bảng con') }];
        const elements = node.elements || node.strokes || [];
        const strokeCount = elements.length;
        totalStrokes += strokeCount;

        const boardItem = {
          id: node.id,
          name: isRoot ? 'Toàn bộ Bảng Chính' : (node.name || 'Bảng con'),
          isRoot,
          level,
          style: node.style || 'chalkboard',
          strokeCount,
          path: currentPath,
          width: node.width || 800,
          height: node.height || 600,
          worldX: worldTx,
          worldY: worldTy,
          worldW: w,
          worldH: h,
          bounds: {
            minX: isRoot ? Infinity : worldTx,
            minY: isRoot ? Infinity : worldTy,
            maxX: isRoot ? -Infinity : worldTx + w,
            maxY: isRoot ? -Infinity : worldTy + h,
          },
          children: [],
          node,
        };

        if (isRoot) {
          for (const s of elements) {
            for (const p of s.points || []) {
              if (p.x < boardItem.bounds.minX) boardItem.bounds.minX = p.x;
              if (p.y < boardItem.bounds.minY) boardItem.bounds.minY = p.y;
              if (p.x > boardItem.bounds.maxX) boardItem.bounds.maxX = p.x;
              if (p.y > boardItem.bounds.maxY) boardItem.bounds.maxY = p.y;
            }
          }
        }

        flatBoards.push(boardItem);

        const cZoom = !isRoot ? (node.contentZoom || 1) : 1;
        const cPanX = !isRoot ? (node.contentPan?.x || 0) : 0;
        const cPanY = !isRoot ? (node.contentPan?.y || 0) : 0;

        const innerMatrix = !isRoot
          ? { tx: worldTx - cPanX * worldSx, ty: worldTy - cPanY * worldSy, sx: worldSx * cZoom, sy: worldSy * cZoom }
          : { tx: 0, ty: 0, sx: 1, sy: 1 };

        if (Array.isArray(node.children)) {
          for (const child of node.children) {
            const childItem = traverse(child, innerMatrix, level + 1, currentPath);
            if (childItem) {
              boardItem.children.push(childItem);
              if (isFinite(childItem.bounds.minX)) {
                boardItem.bounds.minX = Math.min(boardItem.bounds.minX, childItem.bounds.minX);
                boardItem.bounds.minY = Math.min(boardItem.bounds.minY, childItem.bounds.minY);
                boardItem.bounds.maxX = Math.max(boardItem.bounds.maxX, childItem.bounds.maxX);
                boardItem.bounds.maxY = Math.max(boardItem.bounds.maxY, childItem.bounds.maxY);
              }
            }
          }
        }

        return boardItem;
      }

      const rootItem = traverse(rootNode, { tx: 0, ty: 0, sx: 1, sy: 1 }, 0, []);
      return { rootItem, flatBoards, totalStrokes };
    }

    const sceneRoot = SESSION_DATA.content?.scene?.root || { id: 'root', name: 'World Canvas', children: [] };
    const hierarchy = analyzeHierarchy(sceneRoot);

    // 2. Trạng thái Camera & Lựa chọn bảng
    let camera = {
      zoom: 1.0,
      pan: { x: 0, y: 0 }
    };
    let activeBoardId = null;
    let isOutlineView = false;

    // 3. Xây dựng giao diện Sidebar Cây phân cấp & Select
    function buildHierarchyUI() {
      selectBoards.innerHTML = '';
      treeList.innerHTML = '';

      for (const b of hierarchy.flatBoards) {
        // Option dropdown
        const opt = document.createElement('option');
        opt.value = b.id;
        const indentStr = b.level > 0 ? '   '.repeat(b.level) + '└─ ' : '';
        opt.textContent = indentStr + (b.isRoot ? '🌍 Bảng Chính' : ('📑 ' + b.name + ' (' + b.strokeCount + ' nét)'));
        selectBoards.appendChild(opt);

        // Sidebar Tree item
        const item = document.createElement('div');
        item.className = 'tree-item' + (b.id === activeBoardId ? ' active' : '');
        item.dataset.id = b.id;
        item.style.paddingLeft = (10 + (b.level || 0) * 16) + 'px';

        const themeInfo = BOARD_THEMES[b.style] || BOARD_THEMES.chalkboard;
        const icon = b.isRoot ? '🌍' : (themeInfo.icon || '📑');
        const levelTag = b.level > 0 ? ('<span style="opacity:0.4;font-size:11px;margin-right:2px">' + '├─'.repeat(Math.min(1, b.level)) + '</span>') : '';

        item.innerHTML =
          '<div class="tree-item-title">' +
            levelTag + icon + ' <span>' + b.name + '</span>' +
          '</div>' +
          '<span class="tree-badge">' + b.strokeCount + ' nét</span>';

        item.onclick = () => focusBoard(b.id);
        treeList.appendChild(item);
      }
    }

    // 4. Cập nhật thanh Breadcrumb
    function updateBreadcrumbs(boardItem) {
      breadcrumbBar.innerHTML = '';
      if (!boardItem || boardItem.isRoot) {
        breadcrumbBar.innerHTML = '<span class="breadcrumb-node" onclick="focusBoard(hierarchy.flatBoards[0].id)">🌍 Toàn bộ Bảng Chính</span>';
        return;
      }
      boardItem.path.forEach((p, idx) => {
        if (idx > 0) {
          const sep = document.createElement('span');
          sep.className = 'breadcrumb-sep';
          sep.textContent = '›';
          breadcrumbBar.appendChild(sep);
        }
        const nodeSpan = document.createElement('span');
        nodeSpan.className = 'breadcrumb-node';
        nodeSpan.textContent = p.name;
        nodeSpan.onclick = () => focusBoard(p.id);
        breadcrumbBar.appendChild(nodeSpan);
      });
    }

    // 5. Điều hướng & Zoom vào bảng
    function focusBoard(boardId) {
      activeBoardId = boardId;
      selectBoards.value = boardId;
      
      // Cập nhật trạng thái active trên sidebar
      document.querySelectorAll('.tree-item').forEach(el => {
        el.classList.toggle('active', el.dataset.id === boardId);
      });

      const target = hierarchy.flatBoards.find(b => b.id === boardId) || hierarchy.flatBoards[0];
      updateBreadcrumbs(target);

      if (target.isRoot) {
        zoomToFit();
        return;
      }

      // Zoom căn khít bảng mục tiêu
      const padding = 70;
      const bW = target.worldW || 800;
      const bH = target.worldH || 600;
      const scaleX = (window.innerWidth - padding * 2) / bW;
      const scaleY = (window.innerHeight - padding * 2) / bH;
      camera.zoom = Math.min(scaleX, scaleY, 2.5);

      const cx = target.worldX + bW / 2;
      const cy = target.worldY + bH / 2;
      camera.pan.x = window.innerWidth / 2 - cx * camera.zoom;
      camera.pan.y = window.innerHeight / 2 - cy * camera.zoom;
      render();
    }

    function zoomToFit() {
      activeBoardId = hierarchy.flatBoards[0]?.id || null;
      updateBreadcrumbs(hierarchy.flatBoards[0]);

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const b of hierarchy.flatBoards) {
        if (isFinite(b.bounds.minX)) {
          minX = Math.min(minX, b.bounds.minX);
          minY = Math.min(minY, b.bounds.minY);
          maxX = Math.max(maxX, b.bounds.maxX);
          maxY = Math.max(maxY, b.bounds.maxY);
        }
      }

      if (!isFinite(minX)) {
        camera.zoom = 1; camera.pan = { x: window.innerWidth / 2 - 400, y: window.innerHeight / 2 - 300 };
        render();
        return;
      }

      const padding = 80;
      const bW = Math.max(200, maxX - minX);
      const bH = Math.max(200, maxY - minY);
      camera.zoom = Math.min((window.innerWidth - padding * 2) / bW, (window.innerHeight - padding * 2) / bH, 1.5);
      const cx = minX + bW / 2;
      const cy = minY + bH / 2;
      camera.pan.x = window.innerWidth / 2 - cx * camera.zoom;
      camera.pan.y = window.innerHeight / 2 - cy * camera.zoom;
      render();
    }

    // 6. VẼ CANVAS ĐỆ QUY CHUẨN XÁC VỚI SCISSOR CLIPPING (Không đè nét, phân cấp tuyệt đối)
    function render() {
      const dpr = window.devicePixelRatio || 1;
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

      // Nền đen vũ trụ
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

      // Lưới tọa độ nhẹ
      const gridSize = 40 * camera.zoom;
      if (gridSize > 12) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
        const startX = (camera.pan.x % gridSize);
        const startY = (camera.pan.y % gridSize);
        for (let x = startX; x < window.innerWidth; x += gridSize) {
          for (let y = startY; y < window.innerHeight; y += gridSize) {
            ctx.fillRect(x, y, 1.5, 1.5);
          }
        }
      }

      ctx.save();
      ctx.translate(camera.pan.x, camera.pan.y);
      ctx.scale(camera.zoom, camera.zoom);

      // Hàm vẽ đệ quy từng Node (Vẽ container -> Clip -> Nét vẽ -> Bảng con)
      function renderNodeRecursive(node, isRoot = true) {
        ctx.save();

        if (!isRoot) {
          const tx = node.transform?.tx ?? 0;
          const ty = node.transform?.ty ?? 0;
          ctx.translate(tx, ty);

          const theme = BOARD_THEMES[node.style] || BOARD_THEMES.chalkboard;
          const isActive = activeBoardId && node.id === activeBoardId;

          // Đổ bóng (Shadow)
          ctx.shadowColor = isActive ? 'rgba(88, 166, 255, 0.5)' : 'rgba(0, 0, 0, 0.4)';
          ctx.shadowBlur = (isActive ? 24 : 12) / camera.zoom;
          ctx.shadowOffsetY = 4 / camera.zoom;

          // Khung bảng
          ctx.fillStyle = theme.bg;
          ctx.strokeStyle = isActive ? '#58a6ff' : theme.border;
          ctx.lineWidth = (isActive ? 3 : 1.5) / camera.zoom;
          
          ctx.beginPath();
          if (ctx.roundRect) {
            ctx.roundRect(0, 0, node.width, node.height, 8);
          } else {
            ctx.rect(0, 0, node.width, node.height);
          }
          ctx.fill();
          ctx.stroke();

          // Reset shadow
          ctx.shadowColor = 'transparent';

          // Header Bar
          const headerH = 32;
          ctx.fillStyle = isActive ? 'rgba(88, 166, 255, 0.25)' : theme.headerBg;
          ctx.beginPath();
          if (ctx.roundRect) {
            ctx.roundRect(0, 0, node.width, headerH, [8, 8, 0, 0]);
          } else {
            ctx.rect(0, 0, node.width, headerH);
          }
          ctx.fill();

          // Đường phân cách header
          ctx.strokeStyle = theme.border;
          ctx.lineWidth = 1 / camera.zoom;
          ctx.beginPath();
          ctx.moveTo(0, headerH);
          ctx.lineTo(node.width, headerH);
          ctx.stroke();

          // Tiêu đề bảng
          ctx.fillStyle = isActive ? '#58a6ff' : theme.text;
          ctx.font = '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
          ctx.textBaseline = 'middle';
          ctx.fillText((node.name || 'Bảng con'), 12, headerH * 0.5);

          // SCISSOR CLIPPING: Giới hạn nét vẽ CHỈ nằm trong mặt bảng bên dưới Header
          ctx.beginPath();
          ctx.rect(0, headerH, node.width, Math.max(0, node.height - headerH));
          ctx.clip();

          // Áp dụng Pan/Zoom nội bộ của bảng con
          const zoom = node.contentZoom || 1.0;
          const panX = node.contentPan?.x || 0;
          const panY = node.contentPan?.y || 0;
          ctx.translate(-panX, -panY);
          ctx.scale(zoom, zoom);
        }

        // Vẽ nét vẽ thuộc về bảng này (Local coordinates hoàn hảo)
        const elements = node.elements || node.strokes || [];
        for (const s of elements) {
          if (!Array.isArray(s.points) || s.points.length === 0) continue;
          ctx.beginPath();
          ctx.strokeStyle = s.color || '#ffffff';
          ctx.lineWidth = s.baseWidth || 3;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';

          if (s.points.length === 1) {
            ctx.arc(s.points[0].x, s.points[0].y, (s.baseWidth || 3) / 2, 0, Math.PI * 2);
            ctx.fillStyle = s.color || '#ffffff';
            ctx.fill();
          } else {
            ctx.moveTo(s.points[0].x, s.points[0].y);
            for (let i = 1; i < s.points.length; i++) {
              ctx.lineTo(s.points[i].x, s.points[i].y);
            }
            ctx.stroke();
          }
        }

        // Vẽ văn bản ghi chú OCR nếu có
        if (node.textContent) {
          ctx.fillStyle = '#f0f6fc';
          ctx.font = '15px sans-serif';
          ctx.textBaseline = 'top';
          ctx.fillText(node.textContent, 20, 50);
        }

        // Đệ quy vẽ bảng con lồng nhau
        if (Array.isArray(node.children)) {
          for (const child of node.children) {
            renderNodeRecursive(child, false);
          }
        }

        ctx.restore();
      }

      renderNodeRecursive(sceneRoot, true);

      ctx.restore();

      // Thông báo nếu chưa có nội dung
      if (hierarchy.totalStrokes === 0 && hierarchy.flatBoards.length <= 1) {
        ctx.fillStyle = '#8b949e';
        ctx.font = '16px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('📝 Bài giảng này hiện chưa có bảng con hoặc nét vẽ nào.', window.innerWidth / 2, window.innerHeight / 2 - 10);
        ctx.font = '13px sans-serif';
        ctx.fillStyle = '#6e7681';
        ctx.fillText('Hãy mở phần mềm NestedCanvas để bắt đầu tạo các bảng bài giảng.', window.innerWidth / 2, window.innerHeight / 2 + 18);
        ctx.textAlign = 'start';
      }

      ctx.restore();
    }

    // 7. Chế độ Sổ Giáo Trình (Outline Cards View)
    function buildOutlineView() {
      outlineView.innerHTML = '';
      const nonRootBoards = hierarchy.flatBoards.filter(b => !b.isRoot);

      if (nonRootBoards.length === 0) {
        outlineView.innerHTML = '<div style="text-align:center;padding:60px 20px;color:#8b949e">Bài giảng chưa tạo bảng con nào. Bạn có thể xem trên chế độ Bản Đồ Canvas.</div>';
        return;
      }

      for (const b of nonRootBoards) {
        const theme = BOARD_THEMES[b.style] || BOARD_THEMES.chalkboard;
        const card = document.createElement('div');
        card.className = 'outline-card';

        const pathStr = b.path.map(function(p) { return p.name; }).join(' › ');
        card.innerHTML =
          '<div class="outline-card-header">' +
            '<div class="outline-card-title">' +
              '<span>' + theme.icon + ' ' + b.name + '</span>' +
              '<span style="font-size:11px;font-weight:normal;opacity:0.6;margin-left:8px">Cấp ' + b.level + ' • ' + b.strokeCount + ' nét</span>' +
            '</div>' +
            '<button class="viewer-btn btn-open-canvas">🎯 Mở trên Canvas</button>' +
          '</div>' +
          '<div class="outline-card-body">' +
            '<div style="font-size:12px;color:#8b949e">📂 Đường dẫn: <b style="color:#58a6ff">' + pathStr + '</b></div>' +
            '<div class="outline-preview-wrap">' +
              '<canvas id="preview-' + b.id + '" class="outline-preview-canvas" width="' + b.width + '" height="' + b.height + '"></canvas>' +
            '</div>' +
          '</div>';
        outlineView.appendChild(card);

        const btnOpen = card.querySelector('.btn-open-canvas');
        if (btnOpen) {
          btnOpen.onclick = () => openOnCanvas(b.id);
        }

        // Vẽ nội dung bảng con lên preview canvas
        setTimeout(() => {
          const pCanvas = document.getElementById('preview-' + b.id);
          if (!pCanvas) return;
          const pCtx = pCanvas.getContext('2d');
          pCtx.fillStyle = theme.bg;
          pCtx.fillRect(0, 0, b.width, b.height);

          // Header
          pCtx.fillStyle = theme.headerBg;
          pCtx.fillRect(0, 0, b.width, 32);
          pCtx.fillStyle = theme.text;
          pCtx.font = 'bold 14px sans-serif';
          pCtx.fillText(b.name, 12, 21);

          // Strokes với Scissor Clipping & Pan/Zoom
          const cZoom = b.node.contentZoom || 1.0;
          const cPanX = b.node.contentPan?.x || 0;
          const cPanY = b.node.contentPan?.y || 0;

          pCtx.save();
          pCtx.beginPath();
          pCtx.rect(0, 32, b.width, Math.max(0, b.height - 32));
          pCtx.clip();
          pCtx.translate(-cPanX, -cPanY);
          pCtx.scale(cZoom, cZoom);

          const elements = b.node.elements || b.node.strokes || [];
          for (const s of elements) {
            if (!Array.isArray(s.points) || s.points.length === 0) continue;
            pCtx.beginPath();
            pCtx.strokeStyle = s.color || '#ffffff';
            pCtx.lineWidth = s.baseWidth || 3;
            pCtx.lineCap = 'round';
            pCtx.lineJoin = 'round';
            if (s.points.length === 1) {
              pCtx.arc(s.points[0].x, s.points[0].y, (s.baseWidth || 3)/2, 0, Math.PI * 2);
              pCtx.fillStyle = s.color || '#ffffff';
              pCtx.fill();
            } else {
              pCtx.moveTo(s.points[0].x, s.points[0].y);
              for (let i = 1; i < s.points.length; i++) pCtx.lineTo(s.points[i].x, s.points[i].y);
              pCtx.stroke();
            }
          }
          pCtx.restore();
        }, 50);
      }
    }

    window.openOnCanvas = function(boardId) {
      if (isOutlineView) toggleView();
      focusBoard(boardId);
    };

    function toggleView() {
      isOutlineView = !isOutlineView;
      outlineView.classList.toggle('visible', isOutlineView);
      btnToggleView.classList.toggle('active', isOutlineView);
      btnToggleView.textContent = isOutlineView ? '🎨 Bản Đồ Canvas' : '📑 Sổ Giáo Trình';
      if (isOutlineView) buildOutlineView();
    }

    // 8. Tương tác Chuột & Cảm ứng trên Canvas
    let isDragging = false;
    let startX = 0, startY = 0;
    let initialPinchDist = 0;
    let initialPinchZoom = 1;

    canvas.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX - camera.pan.x;
      startY = e.clientY - camera.pan.y;
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      camera.pan.x = e.clientX - startX;
      camera.pan.y = e.clientY - startY;
      render();
    });

    window.addEventListener('mouseup', () => { isDragging = false; });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomFactor = e.deltaY < 0 ? 1.12 : 0.88;
      const mouseX = e.clientX;
      const mouseY = e.clientY;
      const newZoom = Math.max(0.05, Math.min(15.0, camera.zoom * zoomFactor));
      camera.pan.x = mouseX - (mouseX - camera.pan.x) * (newZoom / camera.zoom);
      camera.pan.y = mouseY - (mouseY - camera.pan.y) * (newZoom / camera.zoom);
      camera.zoom = newZoom;
      render();
    }, { passive: false });

    // Cảm ứng Touch / Pinch Zoom
    canvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        isDragging = true;
        startX = e.touches[0].clientX - camera.pan.x;
        startY = e.touches[0].clientY - camera.pan.y;
      } else if (e.touches.length === 2) {
        isDragging = false;
        initialPinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        initialPinchZoom = camera.zoom;
      }
    }, { passive: true });

    canvas.addEventListener('touchmove', (e) => {
      if (isDragging && e.touches.length === 1) {
        camera.pan.x = e.touches[0].clientX - startX;
        camera.pan.y = e.touches[0].clientY - startY;
        render();
      } else if (e.touches.length === 2 && initialPinchDist > 0) {
        const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        const factor = dist / initialPinchDist;
        camera.zoom = Math.max(0.05, Math.min(15.0, initialPinchZoom * factor));
        render();
      }
    }, { passive: true });

    canvas.addEventListener('touchend', () => {
      isDragging = false;
      initialPinchDist = 0;
    });

    // Bấm chọn bảng trên Canvas
    canvas.addEventListener('click', (e) => {
      const worldX = (e.clientX - camera.pan.x) / camera.zoom;
      const worldY = (e.clientY - camera.pan.y) / camera.zoom;

      // Tìm bảng con sâu nhất chứa điểm click
      for (let i = hierarchy.flatBoards.length - 1; i >= 1; i--) {
        const b = hierarchy.flatBoards[i];
        if (worldX >= b.worldX && worldX <= b.worldX + b.worldW && worldY >= b.worldY && worldY <= b.worldY + b.worldH) {
          focusBoard(b.id);
          return;
        }
      }
    });

    // 9. Các nút điều khiển
    btnToggleSidebar.onclick = () => {
      const isHidden = hierarchySidebar.classList.toggle('hidden');
      btnToggleSidebar.classList.toggle('active', !isHidden);
    };
    document.getElementById('btn-close-sidebar').onclick = () => {
      hierarchySidebar.classList.add('hidden');
      btnToggleSidebar.classList.remove('active');
    };
    btnToggleView.onclick = toggleView;
    selectBoards.onchange = () => focusBoard(selectBoards.value);
    document.getElementById('btn-zoom-fit').onclick = zoomToFit;
    document.getElementById('btn-zoom-reset').onclick = () => {
      camera.zoom = 1.0;
      render();
    };
    document.getElementById('btn-print').onclick = () => {
      if (!isOutlineView) toggleView();
      setTimeout(() => window.print(), 300);
    };
    document.getElementById('btn-fullscreen').onclick = () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    };
    sidebarSearch.oninput = () => {
      const q = sidebarSearch.value.trim().toLowerCase();
      document.querySelectorAll('.tree-item').forEach(el => {
        el.style.display = el.textContent.toLowerCase().includes(q) ? 'flex' : 'none';
      });
    };

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      render();
    }
    window.addEventListener('resize', resize);

    // Khởi chạy
    buildHierarchyUI();
    resize();
    zoomToFit();
  </script>
</body>
</html>`;

    const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return true;
  }

  /**
   * Xuất bài giảng ra ảnh Vector SVG (.svg) với cấu trúc phân cấp thẻ <g> và <clipPath>
   */
  async exportSessionSVG(sessionId, selectedBoardIds = null) {
    if (this.currentSessionId === sessionId) {
      await this.flushSave();
    }
    const session = await db.getFullSession(sessionId);
    if (!session || !session.content?.scene?.root) return false;

    let sceneRoot = session.content.scene.root;
    if (Array.isArray(selectedBoardIds) && selectedBoardIds.length > 0) {
      const isSelectedOrHasDescendant = (node) => {
        if (!node) return false;
        if (selectedBoardIds.includes(node.id)) return true;
        if (Array.isArray(node.children)) {
          return node.children.some(isSelectedOrHasDescendant);
        }
        return false;
      };

      const filterNode = (node) => {
        if (!node) return null;
        const copy = { ...node };
        if (node.id !== session.content.scene.root.id && !selectedBoardIds.includes(node.id)) {
          copy.elements = [];
          copy.strokes = [];
        }
        if (Array.isArray(node.children)) {
          copy.children = node.children
            .filter(isSelectedOrHasDescendant)
            .map(filterNode);
        }
        return copy;
      };

      sceneRoot = filterNode(sceneRoot);
    }

    const allClipDefs = [];

    const SVG_THEMES = {
      chalkboard: { bg: '#0d1f18', border: '#2e5b47', headerBg: '#122b22', text: '#58d68d' },
      whiteboard: { bg: '#f8fafc', border: '#cbd5e1', headerBg: '#e2e8f0', text: '#0f172a' },
      blueprint: { bg: '#0a192f', border: '#1d3557', headerBg: '#06101e', text: '#64ffda' },
      midnight: { bg: '#06080c', border: '#1e293b', headerBg: '#0f172a', text: '#f0f6fc' },
      default: { bg: '#161b22', border: '#58a6ff', headerBg: 'rgba(88,166,255,0.15)', text: '#58a6ff' },
    };

    const escapeXML = (str) =>
      String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    // 1. Tạo ClipPath cho từng bảng con để đảm bảo nét vẽ không tràn ra ngoài
    const collectClipDefs = (node) => {
      if (!node) return;
      if (node.id !== sceneRoot.id) {
        allClipDefs.push(
          `    <clipPath id="clip-${node.id}">\n` +
          `      <rect x="0" y="32" width="${node.width || 800}" height="${Math.max(0, (node.height || 600) - 32)}" />\n` +
          `    </clipPath>`
        );
      }
      if (Array.isArray(node.children)) {
        for (const c of node.children) collectClipDefs(c);
      }
    };
    collectClipDefs(sceneRoot);

    // 2. Tính Bounding Box toàn cục
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const calculateBounds = (node, parentTx = 0, parentTy = 0, isRoot = true) => {
      if (!node) return;
      const tr = node.transform || {};
      const tx = parentTx + (tr.tx ?? tr.x ?? 0);
      const ty = parentTy + (tr.ty ?? tr.y ?? 0);

      if (!isRoot) {
        minX = Math.min(minX, tx);
        minY = Math.min(minY, ty);
        maxX = Math.max(maxX, tx + (node.width || 800));
        maxY = Math.max(maxY, ty + (node.height || 600));
      }

      const elements = node.elements || node.strokes || [];
      const zoom = !isRoot ? (node.contentZoom || 1) : 1;
      const panX = !isRoot ? (node.contentPan?.x || 0) : 0;
      const panY = !isRoot ? (node.contentPan?.y || 0) : 0;

      for (const s of elements) {
        for (const p of s.points || []) {
          const wx = tx + (p.x * zoom - panX);
          const wy = ty + (p.y * zoom - panY);
          if (wx < minX) minX = wx;
          if (wy < minY) minY = wy;
          if (wx > maxX) maxX = wx;
          if (wy > maxY) maxY = wy;
        }
      }

      if (Array.isArray(node.children)) {
        for (const c of node.children) calculateBounds(c, tx - panX, ty - panY, false);
      }
    };
    calculateBounds(sceneRoot, 0, 0, true);

    if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 1200; maxY = 800; }
    const padding = 60;
    minX -= padding; minY -= padding;
    maxX += padding; maxY += padding;
    const width = Math.max(200, maxX - minX);
    const height = Math.max(200, maxY - minY);

    // 3. Xuất cây SVG phân cấp chuẩn từng nhóm thẻ <g>
    const renderNodeSVG = (node, isRoot = true, indent = '  ') => {
      let xml = '';
      if (!isRoot) {
        const tx = node.transform?.tx ?? 0;
        const ty = node.transform?.ty ?? 0;
        const theme = SVG_THEMES[node.style] || SVG_THEMES.chalkboard;
        const zoom = node.contentZoom || 1.0;
        const panX = node.contentPan?.x || 0;
        const panY = node.contentPan?.y || 0;

        xml += `${indent}<g id="board-${node.id}" class="nc-board-layer" transform="translate(${tx}, ${ty})">\n`;
        xml += `${indent}  <rect width="${node.width || 800}" height="${node.height || 600}" rx="8" fill="${theme.bg}" stroke="${theme.border}" stroke-width="2" />\n`;
        xml += `${indent}  <rect width="${node.width || 800}" height="32" rx="8" fill="${theme.headerBg}" />\n`;
        xml += `${indent}  <text x="12" y="21" fill="${theme.text}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-weight="bold" font-size="14">${escapeXML(node.name || 'Bảng con')}</text>\n`;
        xml += `${indent}  <g clip-path="url(#clip-${node.id})" transform="translate(${-panX}, ${-panY}) scale(${zoom})">\n`;
      }

      const elements = node.elements || node.strokes || [];
      for (const s of elements) {
        if (!Array.isArray(s.points) || s.points.length === 0) continue;
        if (s.points.length === 1) {
          xml += `${indent}    <circle cx="${s.points[0].x.toFixed(1)}" cy="${s.points[0].y.toFixed(1)}" r="${((s.baseWidth || 3) / 2).toFixed(1)}" fill="${s.color || '#ffffff'}" />\n`;
        } else {
          const pts = s.points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
          xml += `${indent}    <polyline points="${pts}" fill="none" stroke="${s.color || '#ffffff'}" stroke-width="${s.baseWidth || 3}" stroke-linecap="round" stroke-linejoin="round" />\n`;
        }
      }

      if (Array.isArray(node.children)) {
        for (const child of node.children) {
          xml += renderNodeSVG(child, false, indent + '  ');
        }
      }

      if (!isRoot) {
        xml += `${indent}  </g>\n`;
        xml += `${indent}</g>\n`;
      }
      return xml;
    };

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX.toFixed(1)} ${minY.toFixed(1)} ${width.toFixed(1)} ${height.toFixed(1)}" width="${width.toFixed(1)}" height="${height.toFixed(1)}">\n`;
    svg += `  <defs>\n${allClipDefs.join('\n')}\n  </defs>\n`;
    svg += `  <rect x="${minX.toFixed(1)}" y="${minY.toFixed(1)}" width="${width.toFixed(1)}" height="${height.toFixed(1)}" fill="#0d1117" />\n`;
    svg += renderNodeSVG(sceneRoot, true);
    svg += `</svg>`;

    const safeName = (session.meta.name || 'Bai_giang').replace(/[^a-z0-9\u00C0-\u024F\u1EA0-\u1EF9]/gi, '_');
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeName}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return true;
  }

  /**
   * Nhập bài giảng từ file .json, .html hoặc .nested
   * Tự động tương thích linh hoạt mọi phiên bản và cấu trúc dữ liệu
   */
  async importSession(rawText) {
    try {
      let data = null;

      // 1. Nếu là file HTML xuất ra từ NestedCanvas, trích xuất biến SESSION_DATA
      if (typeof rawText === 'string' && (rawText.includes('<!DOCTYPE html>') || rawText.includes('SESSION_DATA'))) {
        const match = rawText.match(/const\s+SESSION_DATA\s*=\s*(\{[\s\S]+?\});\s*(?:const|<)/);
        if (match && match[1]) {
          data = JSON.parse(match[1]);
        } else {
          // Thử tìm JSON giữa script
          const scriptIdx = rawText.indexOf('SESSION_DATA');
          if (scriptIdx !== -1) {
            const startBrace = rawText.indexOf('{', scriptIdx);
            const endBrace = rawText.lastIndexOf('};');
            if (startBrace !== -1 && endBrace !== -1) {
              data = JSON.parse(rawText.substring(startBrace, endBrace + 1));
            }
          }
        }
      }

      // 2. Nếu là file JSON thuần
      if (!data) {
        data = typeof rawText === 'string' ? JSON.parse(rawText) : rawText;
      }

      if (!data) {
        throw new Error('Tệp không chứa dữ liệu JSON hợp lệ');
      }

      // Chuẩn hóa content & scene
      let content = data.content;
      if (!content) {
        if (data.scene) {
          content = {
            scene: data.scene,
            camera: data.camera || { zoom: 1, pan: { x: 0, y: 0 } },
            boardCounter: data.boardCounter || 0,
            selectedNodeId: data.selectedNodeId || null,
          };
        } else if (data.root) {
          content = {
            scene: { root: data.root },
            camera: data.camera || { zoom: 1, pan: { x: 0, y: 0 } },
            boardCounter: data.boardCounter || 0,
            selectedNodeId: data.selectedNodeId || null,
          };
        }
      }

      if (!content || !content.scene || !content.scene.root) {
        throw new Error('Dữ liệu bài giảng không đúng định dạng (thiếu cấu trúc scene.root)');
      }

      const newId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
      const now = Date.now();
      const rawName = data.meta?.name || data.name || 'Bài giảng đã nhập';
      const cleanName = rawName.replace(/\s*\(Đã nhập\)$/, '').replace(/\s*\(Bản sao\)$/, '');

      // Kiểm tra xem ID gốc đã tồn tại trên máy này chưa
      const existing = data.meta?.id ? await db.getSessionMeta(data.meta.id) : null;
      const finalName = existing ? `${cleanName} (Bản sao)` : cleanName;

      const meta = {
        id: newId,
        name: finalName,
        createdAt: now,
        updatedAt: now,
        boardCount: this._countBoards(content.scene),
        strokeCount: this._countStrokes(content.scene),
      };

      const finalContent = {
        ...content,
        sessionId: newId,
        savedAt: now,
      };

      await db.saveSession(meta, finalContent);
      return meta;
    } catch (err) {
      console.error('[SessionManager] Import failed:', err);
      throw err;
    }
  }

  _countBoards(sceneData) {
    if (!sceneData || !sceneData.root) return 0;
    let count = 0;
    const traverse = (node, isRoot = true) => {
      if (!node) return;
      if (!isRoot) count++;
      if (Array.isArray(node.children)) {
        for (const c of node.children) traverse(c, false);
      }
    };
    traverse(sceneData.root, true);
    return count;
  }

  _countStrokes(sceneData) {
    if (!sceneData || !sceneData.root) return 0;
    let count = 0;
    const traverse = (node) => {
      if (!node) return;
      const elements = node.elements || node.strokes || [];
      count += elements.length;
      if (Array.isArray(node.children)) {
        for (const c of node.children) traverse(c);
      }
    };
    traverse(sceneData.root);
    return count;
  }
}
