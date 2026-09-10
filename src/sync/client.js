/**
 * NestedCanvas Real-Time LAN Synchronization Client
 * Handles bi-directional WebSocket communication for sub-10ms multi-device collaboration.
 * Supports room-based / sub-board synchronization.
 */

export class SyncClient {
  constructor(options = {}) {
    this.port = options.port || 8765;
    this.host = options.host || this._resolveDefaultHost();
    this.ws = null;
    this.isConnected = false;
    this.listeners = new Map();
    this.presenceCount = 1;
    this.localIp = this.host;
    this.reconnectTimer = null;
    this.isManualClose = false;

    // Room / Board state tracking
    this.joinedBoards = new Set();
    this.boardPresence = new Map(); // boardId -> count
    this.currentCastBoardId = null;
    this.currentCastBoardNode = null;

    // Callbacks
    this.onPresenceCallback = options.onPresence || null;
    this.onBoardPresenceCallback = options.onBoardPresence || null;
    this.onStatusCallback = options.onStatus || null;
    this.onConnectCallback = options.onConnect || null;
  }

  _resolveDefaultHost() {
    if (typeof window === 'undefined') return 'localhost';

    // 1. Kiểm tra query param ?server=192.168.x.x
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const serverParam = urlParams.get('server');
      if (serverParam && serverParam.trim()) {
        const clean = serverParam.trim().replace(/^https?:\/\//, '').replace(/^wss?:\/\//, '').split(':')[0];
        localStorage.setItem('nestedcanvas_server_host', clean);
        return clean;
      }
    } catch (e) {}

    // 2. Kiểm tra IP đã lưu trong localStorage
    try {
      const saved = localStorage.getItem('nestedcanvas_server_host');
      if (saved && saved.trim()) return saved.trim();
    } catch (e) {}

    // 3. Nhận diện nếu đang chạy trong App APK (Capacitor)
    const isCapacitor = !!(window.Capacitor?.isNativePlatform() || window.location.protocol === 'capacitor:' || (window.location.hostname === 'localhost' && (!window.location.port || window.location.port === '')));
    if (isCapacitor) {
      // Mặc định trỏ về IP của máy tính đang chạy backend
      return '192.168.1.76';
    }

    return window.location.hostname || 'localhost';
  }

  _resolveProtocol(host) {
    // Nếu là IP nội bộ hoặc chạy local, luôn dùng ws: (kể cả khi WebView APK chạy origin https:)
    const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host === 'localhost';
    if (isIp) {
      return 'ws:';
    }
    // Nếu đang chạy trên domain ngoài Internet có HTTPS bảo mật
    if (typeof window !== 'undefined' && window.location.protocol === 'https:' && !window.Capacitor?.isNativePlatform()) {
      return 'wss:';
    }
    return 'ws:';
  }

  getHost() {
    return this.host;
  }

  setHost(newHost) {
    if (!newHost) return;
    const cleanHost = newHost.replace(/^https?:\/\//, '').replace(/^wss?:\/\//, '').split(':')[0].trim();
    if (!cleanHost) return;
    this.host = cleanHost;
    this.localIp = cleanHost;
    try {
      localStorage.setItem('nestedcanvas_server_host', cleanHost);
    } catch (e) {}
    this.reconnect();
  }

  reconnect() {
    this.isManualClose = true;
    if (this.ws) {
      try {
        this.ws.onclose = null;
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }
    this.isConnected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connect();
  }

  connect() {
    this.isManualClose = false;
    const protocol = this._resolveProtocol(this.host);
    const url = `${protocol}//${this.host}:${this.port}`;

    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      console.warn('[SyncClient] Connection error:', e);
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.isConnected = true;
      console.log(`[SyncClient] Connected to LAN sync server at ${url}`);
      if (this.onStatusCallback) this.onStatusCallback(true);
      if (this.onConnectCallback) this.onConnectCallback();

      // Re-join any previously joined boards after reconnect
      for (const boardId of this.joinedBoards) {
        this.send('JOIN_BOARD', { boardId });
      }

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const { type } = data;

        if (type === 'WELCOME') {
          this.presenceCount = data.count || 1;
          if (data.local_ip) this.localIp = data.local_ip;
          if (data.current_cast_board_id) {
            this.currentCastBoardId = data.current_cast_board_id;
            this.currentCastBoardNode = data.current_cast_board_node;
          }
          if (this.onPresenceCallback) this.onPresenceCallback(this.presenceCount, this.localIp, data.shared_boards);
        } else if (type === 'PRESENCE') {
          this.presenceCount = data.count || 1;
          if (data.local_ip) this.localIp = data.local_ip;
          if (this.onPresenceCallback) this.onPresenceCallback(this.presenceCount, this.localIp, data.shared_boards);
        } else if (type === 'BOARD_PRESENCE') {
          if (data.boardId) {
            this.boardPresence.set(data.boardId, data.count || 0);
            if (this.onBoardPresenceCallback) {
              this.onBoardPresenceCallback(data.boardId, data.count || 0);
            }
          }
        } else if (type === 'CAST_BOARD') {
          this.currentCastBoardId = data.boardId;
          this.currentCastBoardNode = data.node;
        } else if (type === 'STOP_CAST_BOARD') {
          this.currentCastBoardId = null;
          this.currentCastBoardNode = null;
        }

        this._dispatch(type, data);
      } catch (e) {
        console.error('[SyncClient] Failed to parse packet:', e);
      }
    };

    this.ws.onclose = () => {
      this.isConnected = false;
      if (this.onStatusCallback) this.onStatusCallback(false);
      if (!this.isManualClose) {
        this._scheduleReconnect();
      }
    };

    this.ws.onerror = (err) => {
      // WebSocket errors will be followed by onclose
    };
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.isConnected && !this.isManualClose) {
        this.connect();
      }
    }, 2500);
  }

  send(type, payload = {}) {
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(JSON.stringify({ type, ...payload }));
      return true;
    } catch (e) {
      console.warn('[SyncClient] Send failed:', e);
      return false;
    }
  }

  // --- Per-Board Room Helpers ---
  joinBoard(boardId) {
    if (!boardId) return;
    this.joinedBoards.add(boardId);
    this.send('JOIN_BOARD', { boardId });
  }

  leaveBoard(boardId) {
    if (!boardId) return;
    this.joinedBoards.delete(boardId);
    this.send('LEAVE_BOARD', { boardId });
  }

  shareBoard(boardId, nodeData, isShared) {
    if (!boardId) return;
    this.send('SHARE_BOARD', {
      boardId,
      node: nodeData,
      isShared: !!isShared,
    });
  }

  requestBoardState(boardId) {
    if (!boardId) return;
    this.send('GET_BOARD_STATE', { boardId });
  }

  sendBoardState(boardId, nodeData) {
    if (!boardId || !nodeData) return;
    this.send('BOARD_STATE', {
      boardId,
      node: nodeData,
    });
  }

  getBoardPresence(boardId) {
    return this.boardPresence.get(boardId) || 0;
  }

  // --- Remote PC Screen Casting Helpers ---
  castBoard(boardId, nodeData = null) {
    if (!boardId) return;
    this.currentCastBoardId = boardId;
    if (nodeData) this.currentCastBoardNode = nodeData;
    this.send('CAST_BOARD', {
      boardId,
      node: nodeData,
    });
  }

  stopCastBoard() {
    this.currentCastBoardId = null;
    this.currentCastBoardNode = null;
    this.send('STOP_CAST_BOARD', {});
  }

  requestCastBoard() {
    this.send('GET_CAST_BOARD', {});
  }

  sendCameraSync(boardId, cameraData) {
    if (!boardId) return;
    this.send('CAMERA_SYNC', {
      boardId,
      ...cameraData,
    });
  }

  on(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type).add(handler);
    return () => this.off(type, handler);
  }

  off(type, handler) {
    if (this.listeners.has(type)) {
      this.listeners.get(type).delete(handler);
    }
  }

  _dispatch(type, data) {
    const handlers = this.listeners.get(type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (e) {
          console.error(`[SyncClient] Error in listener for ${type}:`, e);
        }
      }
    }
  }

  disconnect() {
    this.isManualClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
  }
}
