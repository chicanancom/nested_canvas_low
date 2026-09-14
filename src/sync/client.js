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
    this.onDiscoveredCallback = options.onDiscovered || null;
    this.failedConnectAttempts = 0;
    this.isAutoDiscovering = false;
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
      return '192.168.1.121';
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

  // --- LAN Auto-Discovery Engine ---
  /**
   * Phát hiện các dải mạng subnet tiềm năng thông qua WebRTC ICE Candidates và các dải thông dụng
   */
  async _detectSubnetCandidates() {
    const subnets = new Set();

    // 1. Thêm subnet từ host hiện tại
    if (this.host && /^(\d{1,3}\.){3}\d{1,3}$/.test(this.host)) {
      const parts = this.host.split('.');
      subnets.add(`${parts[0]}.${parts[1]}.${parts[2]}.`);
    }

    // 2. Thử lấy IP local qua WebRTC STUN/Host candidates (hoạt động không cần mạng ngoài)
    try {
      const detectedIp = await new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(null), 800);
        try {
          const RTCPC = window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
          if (!RTCPC) return resolve(null);

          const pc = new RTCPC({ iceServers: [] });
          pc.createDataChannel('');
          pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch(() => resolve(null));
          pc.onicecandidate = (event) => {
            if (!event || !event.candidate || !event.candidate.candidate) return;
            const cand = event.candidate.candidate;
            const match = cand.match(/([0-9]{1,3}(\.[0-9]{1,3}){3})/);
            if (match && match[1] && !match[1].startsWith('127.')) {
              clearTimeout(timeout);
              try { pc.close(); } catch (e) {}
              resolve(match[1]);
            }
          };
        } catch (e) {
          clearTimeout(timeout);
          resolve(null);
        }
      });

      if (detectedIp) {
        const parts = detectedIp.split('.');
        subnets.add(`${parts[0]}.${parts[1]}.${parts[2]}.`);
      }
    } catch (e) {}

    // 3. Bổ sung các subnet LAN phổ biến nhất ở gia đình, trường học và điểm phát 4G/Hotspot
    subnets.add('192.168.1.');   // Router phổ biến (VNPT, Viettel, FPT, Asus, TP-Link)
    subnets.add('192.168.0.');   // D-Link, TP-Link
    subnets.add('172.20.10.');   // iPhone / iOS Personal Hotspot
    subnets.add('192.168.43.');  // Android Wi-Fi Hotspot
    subnets.add('192.168.100.'); // Huawei / ZTE PON Routers

    return Array.from(subnets);
  }

  /**
   * Quét nhanh tìm máy chủ PC NestedCanvas qua HTTP GET /health hoặc WebSocket probe
   * @param {Object} opts
   * @param {number} opts.timeoutMs - Timeout mỗi request ping (mặc định 600ms)
   * @param {Function} opts.onProgress - Callback cập nhật tiến độ ({ scanned, total, currentIp })
   * @returns {Promise<{ success: boolean, ip?: string, data?: any }>}
   */
  async discoverServer(opts = {}) {
    const timeoutMs = opts.timeoutMs || 600;
    const port = this.port || 8765;
    const onProgress = opts.onProgress || (() => {});
    const onFound = opts.onFound || (() => {});

    console.log('[SyncClient] 🔍 Starting LAN Auto-Discovery on port', port);

    // 1. Thử ping nhanh máy chủ host hiện tại, 192.168.1.121 và localhost trước
    const quickTargets = Array.from(new Set([this.host, '192.168.1.121', '127.0.0.1', 'localhost'].filter(Boolean)));
    for (const target of quickTargets) {
      const res = await this._pingServer(target, port, 400);
      if (res.success) {
        console.log(`[SyncClient] ✅ Quick found server at ${target}`);
        this.setHost(target);
        onFound(target, res.data);
        return { success: true, ip: target, data: res.data };
      }
    }

    // 2. Thu thập danh sách subnet
    const candidateSubnets = await this._detectSubnetCandidates();

    // 3. Tạo danh sách IP để quét
    // Ưu tiên dải từ .100 đến .150 trước (nơi modem thường cấp DHCP cho laptop/PC), sau đó đến .2-.99 và .151-.254
    const ipList = [];
    for (const subnet of candidateSubnets) {
      // Dải ưu tiên cao nhất
      for (let i = 100; i <= 150; i++) {
        ipList.push(`${subnet}${i}`);
      }
      for (let i = 2; i < 100; i++) {
        ipList.push(`${subnet}${i}`);
      }
      for (let i = 151; i <= 254; i++) {
        ipList.push(`${subnet}${i}`);
      }
    }

    const total = ipList.length;
    let scanned = 0;
    let foundResult = null;
    const globalAbort = new AbortController();

    // Quét theo từng batch đồng thời (batchSize = 35) để không gây nghẽn mạng
    const batchSize = 35;
    for (let b = 0; b < ipList.length; b += batchSize) {
      if (foundResult) break;
      const batch = ipList.slice(b, b + batchSize);

      await Promise.all(
        batch.map(async (ip) => {
          if (foundResult) return;
          try {
            const check = await this._pingServer(ip, port, timeoutMs, globalAbort.signal);
            scanned++;
            onProgress({ scanned, total, currentIp: ip });
            if (check.success && !foundResult) {
              foundResult = { ip, data: check.data };
              globalAbort.abort(); // Dừng tất cả các request khác ngay lập tức
            }
          } catch (e) {
            scanned++;
            onProgress({ scanned, total, currentIp: ip });
          }
        })
      );

      if (foundResult) break;
    }

    if (foundResult) {
      console.log(`[SyncClient] 🎉 Server discovered at IP: ${foundResult.ip}`);
      this.setHost(foundResult.ip);
      onFound(foundResult.ip, foundResult.data);
      return { success: true, ip: foundResult.ip, data: foundResult.data };
    }

    console.log('[SyncClient] ❌ Auto-Discovery finished: No server found.');
    return { success: false };
  }

  async _pingServer(ip, port, timeoutMs = 600, externalSignal = null) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // Liên kết external signal nếu có
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timeoutId);
        return { success: false };
      }
      externalSignal.addEventListener('abort', () => {
        clearTimeout(timeoutId);
        controller.abort();
      });
    }

    // 1. Thử HTTP GET /health trước
    try {
      const url = `http://${ip}:${port}/health`;
      const res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        if (data && (data.app === 'nestedcanvas' || data.server?.includes('NestedCanvas'))) {
          clearTimeout(timeoutId);
          return { success: true, data };
        }
      }
    } catch (e) {
      // Fetch có thể bị lỗi mạng hoặc Mixed-Content trên một số WebView
    }

    // 2. Thử WebSocket probe handshake trực tiếp nếu fetch chưa được
    if (!controller.signal.aborted) {
      try {
        const wsOk = await new Promise((resolve) => {
          let ws = null;
          let settled = false;
          const finish = (result) => {
            if (settled) return;
            settled = true;
            if (ws) {
              try { ws.close(); } catch (_) {}
            }
            resolve(result);
          };

          const wsTimer = setTimeout(() => finish(false), Math.min(350, timeoutMs));

          try {
            ws = new WebSocket(`ws://${ip}:${port}`);
            ws.onopen = () => {
              clearTimeout(wsTimer);
              finish(true);
            };
            ws.onerror = () => {
              clearTimeout(wsTimer);
              finish(false);
            };
          } catch (_) {
            clearTimeout(wsTimer);
            finish(false);
          }
        });

        if (wsOk) {
          clearTimeout(timeoutId);
          return { success: true, data: { app: 'nestedcanvas', ip, port } };
        }
      } catch (e) {}
    }

    clearTimeout(timeoutId);
    return { success: false };
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
      this.failedConnectAttempts = 0;
      this.isAutoDiscovering = false;
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
      this.failedConnectAttempts++;
      if (this.onStatusCallback) this.onStatusCallback(false);

      // Nếu không kết nối được sau 2 lần thử và chưa quét, tự động quét mạng LAN tìm PC
      if (this.failedConnectAttempts >= 2 && !this.isAutoDiscovering && !this.isManualClose) {
        this._triggerBackgroundDiscovery();
      }

      if (!this.isManualClose) {
        this._scheduleReconnect();
      }
    };

    this.ws.onerror = (err) => {
      // WebSocket errors will be followed by onclose
    };
  }

  async _triggerBackgroundDiscovery() {
    this.isAutoDiscovering = true;
    console.log('[SyncClient] 🔍 Auto-triggering background LAN Discovery...');
    try {
      const result = await this.discoverServer({
        timeoutMs: 500,
        onFound: (ip, data) => {
          if (this.onDiscoveredCallback) {
            this.onDiscoveredCallback(ip, data);
          }
        }
      });
      if (result.success) {
        this.failedConnectAttempts = 0;
      }
    } catch (e) {
      console.warn('[SyncClient] Background discovery error:', e);
    } finally {
      this.isAutoDiscovering = false;
    }
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
