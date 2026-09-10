/**
 * NestedCanvas Pure Non-Interactive Fullscreen Canvas Mirror
 * Displays the exact infinite canvas and all child boards in real time.
 * Zero menus, zero buttons, zero interactions, cursor hidden.
 */

import { Camera, Transform2D, Vec2 } from './engine/math.js';
import { CanvasNode, SceneGraph, Stroke } from './engine/scene.js';
import { CanvasRenderer } from './engine/renderer.js';
import { SyncClient } from './sync/client.js';

class PCDisplayApp {
  constructor() {
    this.canvas = document.getElementById('display-canvas');
    this.renderer = new CanvasRenderer(this.canvas, { isDisplayMode: true });
    this.scene = new SceneGraph();
    this.camera = new Camera(0, 0, 1.0, window.innerWidth, window.innerHeight);
    this.remoteActiveSessions = new Map();

    this.idleOverlay = document.getElementById('idle-overlay');
    this.hasSceneData = false;

    // Tải dữ liệu canvas đã lưu từ phiên trước
    this.loadDisplayState();

    // Khởi tạo kết nối mạng LAN
    this.initSync();

    // Xử lý sự kiện cửa sổ & phím tắt (F11)
    this.bindWindowEvents();

    // Vòng lặp render liên tục
    this.startRenderLoop();
  }

  saveDisplayState() {
    try {
      if (!this.hasSceneData) return;
      const data = {
        scene: this.scene.toJSON(),
        camera: {
          zoom: this.camera.zoom,
          pan: { x: this.camera.pan.x, y: this.camera.pan.y },
        },
        savedAt: Date.now(),
      };
      localStorage.setItem('nestedcanvas_display_mirror_state', JSON.stringify(data));
    } catch (e) {}
  }

  loadDisplayState() {
    try {
      const raw = localStorage.getItem('nestedcanvas_display_mirror_state');
      if (!raw) {
        if (this.idleOverlay) this.idleOverlay.classList.remove('hidden');
        return false;
      }
      const data = JSON.parse(raw);
      if (data.scene) {
        this.scene.loadFromJSON(data.scene);
        this.hasSceneData = true;
        if (this.idleOverlay) {
          this.idleOverlay.classList.add('hidden');
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
    } catch (e) {}
    if (this.idleOverlay) this.idleOverlay.classList.remove('hidden');
    return false;
  }

  initSync() {
    this.syncClient = new SyncClient();

    // Nhận thông tin ban đầu khi kết nối
    this.syncClient.on('WELCOME', (data) => {
      if (data.last_canvas_scene) {
        this.applyCanvasMirror(data.last_canvas_scene, data.last_canvas_camera);
      } else {
        // Yêu cầu thiết bị phát gửi toàn cảnh canvas
        this.syncClient.send('GET_CANVAS_MIRROR', {});
      }
    });

    // Nhận toàn cảnh Canvas (Full Scene & Camera)
    this.syncClient.on('CANVAS_MIRROR', (data) => {
      if (data && data.scene) {
        this.applyCanvasMirror(data.scene, data.camera);
      }
    });

    // Nhận góc nhìn camera theo thời gian thực (Camera Zoom & Pan)
    this.syncClient.on('CANVAS_CAMERA_SYNC', (data) => {
      this.applyCameraSync(data);
    });

    // Nhận nét vẽ đang vẽ dở thời gian thực (Live in-flight stroke)
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

    // Tương thích ngược: Khi có thiết bị gửi lệnh CAST_BOARD cũ
    this.syncClient.on('CAST_BOARD', (data) => {
      if (data && data.scene) {
        this.applyCanvasMirror(data.scene, data.camera);
      } else if (data && data.node) {
        let node = CanvasNode.fromJSON(data.node);
        const existing = this.scene.getNode(node.id);
        if (existing) {
          existing.elements = node.elements;
          existing.width = node.width;
          existing.height = node.height;
          existing.transform = node.transform;
          existing.style = node.style;
          existing.gridType = node.gridType;
        } else {
          this.scene.root.children.push(node);
        }
        if (this.idleOverlay) this.idleOverlay.classList.add('hidden');
        this.hasSceneData = true;
        this.saveDisplayState();
      }
    });

    this.syncClient.connect();
  }

  applyCanvasMirror(sceneData, cameraData) {
    if (!sceneData) return;
    this.scene.loadFromJSON(sceneData);
    this.hasSceneData = true;

    if (this.idleOverlay) {
      this.idleOverlay.classList.add('hidden');
    }

    if (cameraData) {
      this.applyCameraSync(cameraData);
    }

    this.saveDisplayState();
  }

  applyCameraSync(data) {
    if (!data) return;
    const { zoom, pan, viewport } = data;
    if (typeof zoom !== 'number' || !pan) return;

    const availW = window.innerWidth;
    const availH = window.innerHeight;

    if (viewport && viewport.w > 0 && viewport.h > 0) {
      // Tỉ lệ scale sao cho trọn vẹn khung hình người thuyết trình hiển thị trên màn chiếu
      const scaleFactor = Math.min(availW / viewport.w, availH / viewport.h);
      this.camera.zoom = Math.max(0.01, Math.min(64.0, zoom * scaleFactor));
      this.camera.pan = new Vec2(pan.x, pan.y);
    } else {
      this.camera.zoom = zoom;
      this.camera.pan = new Vec2(pan.x, pan.y);
    }

    this.saveDisplayState();
  }

  applyStrokeLive(data) {
    const { clientId, session } = data;
    if (!clientId) return;
    if (!session || !session.points || session.points.length === 0) {
      this.remoteActiveSessions.delete(clientId);
    } else {
      this.remoteActiveSessions.set(clientId, session);
    }
  }

  applyStrokeAdd(data) {
    const { nodeId, stroke } = data;
    if (!nodeId || !stroke) return;
    const targetNode = this.scene.getNode(nodeId);
    if (targetNode) {
      const strokeObj = Stroke.fromJSON(stroke);
      if (!Array.isArray(targetNode.elements)) targetNode.elements = [];
      if (!targetNode.elements.some((s) => s.id === strokeObj.id)) {
        targetNode.elements.push(strokeObj);
      }
      this.saveDisplayState();
    }
  }

  applyStrokeErase(data) {
    const { nodeId, removedStrokeIds } = data;
    if (!nodeId || !Array.isArray(removedStrokeIds)) return;
    const targetNode = this.scene.getNode(nodeId);
    if (targetNode && Array.isArray(targetNode.elements)) {
      const idSet = new Set(removedStrokeIds);
      targetNode.elements = targetNode.elements.filter((s) => !idSet.has(s.id));
      this.saveDisplayState();
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
    this.saveDisplayState();
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

    // Phím tắt toàn màn hình tĩnh (chỉ hoạt động qua bàn phím, không hiển thị nút)
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F11') {
        e.preventDefault();
        this.toggleFullscreen();
      } else if (e.key === 'Escape' && document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
    });
  }

  startRenderLoop() {
    const loop = () => {
      // selectedNodeId = null: Tuyệt đối không vẽ viền xanh hay 8 tay cầm co giãn
      // activeSession = null: Không có thao tác vẽ trực tiếp từ màn chiếu
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
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.pcDisplayApp = new PCDisplayApp();
});
