/**
 * NestedCanvas Real-Time LAN Synchronization Client
 * Handles bi-directional WebSocket communication for sub-10ms multi-device collaboration.
 */

export class SyncClient {
  constructor(options = {}) {
    this.port = options.port || 8765;
    this.host = options.host || (typeof window !== 'undefined' ? window.location.hostname : 'localhost') || 'localhost';
    this.ws = null;
    this.isConnected = false;
    this.listeners = new Map();
    this.presenceCount = 1;
    this.localIp = this.host;
    this.reconnectTimer = null;
    this.isManualClose = false;

    // Callbacks
    this.onPresenceCallback = options.onPresence || null;
    this.onStatusCallback = options.onStatus || null;
  }

  connect() {
    this.isManualClose = false;
    const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = (typeof window !== 'undefined' && window.location.hostname) ? window.location.hostname : this.host;
    const url = `${protocol}//${host}:${this.port}`;

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
          if (this.onPresenceCallback) this.onPresenceCallback(this.presenceCount, this.localIp);
        } else if (type === 'PRESENCE') {
          this.presenceCount = data.count || 1;
          if (data.local_ip) this.localIp = data.local_ip;
          if (this.onPresenceCallback) this.onPresenceCallback(this.presenceCount, this.localIp);
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
