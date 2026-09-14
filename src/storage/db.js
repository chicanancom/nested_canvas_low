/**
 * NestedCanvas IndexedDB Storage Engine (NestedCanvasDB)
 * High-capacity, non-blocking, asynchronous database for multi-session management.
 */

const DB_NAME = 'NestedCanvasDB';
const DB_VERSION = 1;

export class StorageDB {
  constructor() {
    this.db = null;
    this.initPromise = null;
  }

  async init() {
    if (this.db) return this.db;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise((resolve, reject) => {
      if (typeof window === 'undefined' || !window.indexedDB) {
        console.warn('[StorageDB] IndexedDB not supported in this environment');
        return resolve(null);
      }

      const request = window.indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Store 1: sessions (Metadata danh mục phiên)
        if (!db.objectStoreNames.contains('sessions')) {
          const sessionStore = db.createObjectStore('sessions', { keyPath: 'id' });
          sessionStore.createIndex('updatedAt', 'updatedAt', { unique: false });
          sessionStore.createIndex('createdAt', 'createdAt', { unique: false });
          sessionStore.createIndex('name', 'name', { unique: false });
        }

        // Store 2: session_contents (Chi tiết toàn bộ Scene & Bảng con)
        if (!db.objectStoreNames.contains('session_contents')) {
          db.createObjectStore('session_contents', { keyPath: 'sessionId' });
        }

        // Store 3: app_metadata (Cấu hình và phiên active hiện tại)
        if (!db.objectStoreNames.contains('app_metadata')) {
          db.createObjectStore('app_metadata', { keyPath: 'key' });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        console.log('[StorageDB] ✅ IndexedDB initialized successfully:', DB_NAME);
        resolve(this.db);
      };

      request.onerror = (event) => {
        console.error('[StorageDB] ❌ IndexedDB open error:', event.target.error);
        reject(event.target.error);
      };
    });

    return this.initPromise;
  }

  // --- Session Metadata Operations ---
  async getAllSessions() {
    await this.init();
    if (!this.db) return [];

    return new Promise((resolve, reject) => {
      try {
        const tx = this.db.transaction('sessions', 'readonly');
        const store = tx.objectStore('sessions');
        const index = store.index('updatedAt');
        const request = index.getAll();

        request.onsuccess = () => {
          // Sắp xếp theo thời gian cập nhật mới nhất trước
          const results = request.result || [];
          results.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
          resolve(results);
        };
        request.onerror = () => reject(request.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  async getSessionMeta(sessionId) {
    await this.init();
    if (!this.db) return null;

    return new Promise((resolve, reject) => {
      try {
        const tx = this.db.transaction('sessions', 'readonly');
        const store = tx.objectStore('sessions');
        const request = store.get(sessionId);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  async getSessionContent(sessionId) {
    await this.init();
    if (!this.db) return null;

    return new Promise((resolve, reject) => {
      try {
        const tx = this.db.transaction('session_contents', 'readonly');
        const store = tx.objectStore('session_contents');
        const request = store.get(sessionId);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  async getFullSession(sessionId) {
    const [meta, content] = await Promise.all([
      this.getSessionMeta(sessionId),
      this.getSessionContent(sessionId),
    ]);
    if (!meta) return null;
    return {
      meta,
      content: content || null,
    };
  }

  async saveSession(meta, content = null) {
    await this.init();
    if (!this.db) return false;

    return new Promise((resolve, reject) => {
      try {
        const stores = content ? ['sessions', 'session_contents'] : ['sessions'];
        const tx = this.db.transaction(stores, 'readwrite');

        const sessionStore = tx.objectStore('sessions');
        sessionStore.put({
          ...meta,
          updatedAt: meta.updatedAt || Date.now(),
        });

        if (content) {
          const contentStore = tx.objectStore('session_contents');
          contentStore.put({
            sessionId: meta.id,
            ...content,
            savedAt: Date.now(),
          });
        }

        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  async deleteSession(sessionId) {
    await this.init();
    if (!this.db) return false;

    return new Promise((resolve, reject) => {
      try {
        const tx = this.db.transaction(['sessions', 'session_contents'], 'readwrite');
        tx.objectStore('sessions').delete(sessionId);
        tx.objectStore('session_contents').delete(sessionId);

        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  // --- App Metadata Helpers (Active Session ID, etc.) ---
  async getMetadata(key) {
    await this.init();
    if (!this.db) return null;

    return new Promise((resolve, reject) => {
      try {
        const tx = this.db.transaction('app_metadata', 'readonly');
        const store = tx.objectStore('app_metadata');
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result?.value ?? null);
        request.onerror = () => reject(request.error);
      } catch (err) {
        reject(err);
      }
    });
  }

  async setMetadata(key, value) {
    await this.init();
    if (!this.db) return false;

    return new Promise((resolve, reject) => {
      try {
        const tx = this.db.transaction('app_metadata', 'readwrite');
        const store = tx.objectStore('app_metadata');
        store.put({ key, value, updatedAt: Date.now() });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      } catch (err) {
        reject(err);
      }
    });
  }
}

export const db = new StorageDB();
