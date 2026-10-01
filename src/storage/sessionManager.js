/**
 * NestedCanvas Smart Session Manager
 * Handles multi-session lifecycle: creation, auto-save with debounce, thumbnail generation,
 * switching, duplication, export/import (.nested), and migration from legacy localStorage.
 */

import { db } from './db.js';
import { uniqueSessionName } from './sessionNames.js';
import { jsPDF } from 'jspdf';
import { CanvasRenderer } from '../engine/renderer.js';
import { SceneGraph } from '../engine/scene.js';
import { Camera } from '../engine/math.js';

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
    const uniqueName = uniqueSessionName(name, await db.getAllSessions());
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    const now = Date.now();
    const meta = {
      id: sessionId,
      name: uniqueName,
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
      name: uniqueSessionName(customName || `${session.meta.name} (Bản sao)`, await db.getAllSessions()),
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
  async exportSessionPDF(sessionId, selectedBoardIds = null, liveContent = null, exportName = null) {
    if (!liveContent && this.currentSessionId === sessionId) await this.flushSave();
    const session = liveContent
      ? { meta: { name: exportName || this.currentSessionMeta?.name || 'Bai_giang' }, content: liveContent }
      : await db.getFullSession(sessionId);
    if (!session?.content) return false;

    const pages = Array.isArray(session.content.pages) && session.content.pages.length
      ? session.content.pages.filter((page) => page.scene?.root)
      : (session.content.scene?.root ? [{ name: session.meta.name || 'Trang 1', scene: session.content.scene }] : []);
    if (!pages.length) return false;

    // Explicit board selection remains supported for the export dialog. A direct
    // whole-session export instead preserves one PDF page per presentation page.
    const selected = Array.isArray(selectedBoardIds) && selectedBoardIds.length
      ? new Set(selectedBoardIds) : null;
    const outputPages = [];
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      if (selected) {
        const hierarchy = this._analyzeHierarchy(page.scene.root);
        const matches = hierarchy.flatBoards.filter((board) => selected.has(board.id));
        for (const board of matches) outputPages.push({ scene: { root: board.node }, name: board.name || page.name || `Trang ${i + 1}` });
      } else {
        outputPages.push(page);
      }
    }
    if (!outputPages.length) return false;

    let pdf = null;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    for (let i = 0; i < outputPages.length; i++) {
      const page = outputPages[i];
      const graph = new SceneGraph();
      graph.loadFromJSON(page.scene);
      if (page.theme) graph.root.style = page.theme;
      if (page.gridType) graph.root.gridType = page.gridType;
      const landscape = true;
      const width = 1600;
      // Match the Electron viewport aspect so the same camera shows the same area.
      const viewportAspect = Math.max(1, window.innerWidth / Math.max(1, window.innerHeight));
      const height = Math.round(width / viewportAspect);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      const renderer = new CanvasRenderer(canvas);
      renderer.resize = () => {};
      renderer.cachedWidth = width;
      renderer.cachedHeight = height;
      renderer.cachedDpr = dpr;
      const cameraState = page.camera || session.content.camera || {};
      const camera = new Camera(
        cameraState.pan?.x || 0,
        cameraState.pan?.y || 0,
        cameraState.zoom > 0 ? cameraState.zoom : 1,
        width,
        height
      );
      renderer.render(graph, camera, null, null, null);

      if (!pdf) pdf = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'mm', format: 'a4', compress: true });
      else pdf.addPage('a4', landscape ? 'landscape' : 'portrait');
      const pageWidth = 297;
      const pageHeight = 210;
      const imageAspect = canvas.width / canvas.height;
      const pageAspect = pageWidth / pageHeight;
      const drawWidth = imageAspect > pageAspect ? pageWidth : pageHeight * imageAspect;
      const drawHeight = imageAspect > pageAspect ? pageWidth / imageAspect : pageHeight;
      pdf.addImage(canvas.toDataURL('image/png'), 'PNG', (pageWidth - drawWidth) / 2, (pageHeight - drawHeight) / 2, drawWidth, drawHeight);
      pdf.setFontSize(8);
      pdf.setTextColor(150, 150, 150);
      pdf.text(`${page.name || `Trang ${i + 1}`} • ${i + 1}/${outputPages.length}`, pageWidth / 2, pageHeight - 4, { align: 'center' });
    }

    const safeName = (session.meta.name || 'Bai_giang').replace(/[^a-z0-9\u00C0-\u024F\u1EA0-\u1EF9]/gi, '_');
    pdf.save(`${safeName}.pdf`);
    return true;
  }

  async exportSessionHTML(sessionId, selectedBoardIds = null) {
    const { exportSessionHTML } = await import('./sessionHtmlExport.js');
    return exportSessionHTML(this, sessionId, selectedBoardIds);
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
