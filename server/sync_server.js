/**
 * NestedCanvas Real-Time LAN Synchronization Server (Node.js)
 * Port: 8765 (WebSocket)
 * Supports Room-Based Sub-Board Synchronization:
 * Enables sharing individual child boards (bảng con) independently over LAN.
 */

import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_FILE = path.join(__dirname, 'data', 'sync_state.json');

import dgram from 'dgram';

export function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

export function getBroadcastAddresses() {
  const broadcasts = new Set(['255.255.255.255']);
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name]) {
      if (net.family === 'IPv4' && !net.internal && net.address) {
        try {
          const ipParts = net.address.split('.').map(Number);
          const maskParts = (net.netmask || '255.255.255.0').split('.').map(Number);
          const bcastParts = ipParts.map((p, i) => (p | (~maskParts[i] & 255)));
          broadcasts.add(bcastParts.join('.'));
        } catch (e) {}
      }
    }
  }
  return Array.from(broadcasts);
}

export function startSyncServer(port = 8765) {
  // In-memory storage for shared boards and rooms
  // board_states: Map<boardId, nodeData>
  const boardStates = new Map();
  // sharedBoards: Map<boardId, { id: string, name: string, isShared: boolean, createdAt: number }>
  const sharedBoards = new Map();
  // boardRooms: Map<boardId, Set<WebSocket>>
  const boardRooms = new Map();
  // clientSubscriptions: Map<WebSocket, Set<boardId>>
  const clientSubscriptions = new Map();
  // All connected clients
  const allClients = new Set();
  // Active cast board for PC fullscreen display
  let currentCastBoardId = null;
  let currentCastBoardNode = null;
  let lastCastCameraSync = null;

  // Active full canvas mirror for non-interactive PC display
  let lastCanvasScene = null;
  let lastCanvasCamera = null;
  let lastCanvasPages = null;
  let lastCanvasPageIndex = 0;
  let lastDisplayMode = 'single';

  // Active session tracking across all clients
  let currentActiveSessionId = null;
  let currentActiveSessionMeta = null;
  let currentActiveSessionContent = null;

  let _saveStateTimer = null;
  function scheduleSaveState() {
    if (_saveStateTimer) clearTimeout(_saveStateTimer);
    _saveStateTimer = setTimeout(() => {
      _saveStateTimer = null;
      try {
        const data = {
          currentCastBoardId,
          currentCastBoardNode,
          lastCastCameraSync,
          lastCanvasScene,
          lastCanvasCamera,
          lastCanvasPages,
          lastCanvasPageIndex,
          lastDisplayMode,
          currentActiveSessionId,
          boardStates: Array.from(boardStates.entries()),
          sharedBoards: Array.from(sharedBoards.entries()),
          savedAt: Date.now(),
        };
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf8');
      } catch (e) {
        console.warn('[SyncServer] Error saving state file:', e.message);
      }
    }, 200);
  }

  function loadPersistedState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        const data = JSON.parse(raw);
        if (data.currentCastBoardId) currentCastBoardId = data.currentCastBoardId;
        if (data.currentCastBoardNode) currentCastBoardNode = data.currentCastBoardNode;
        if (data.lastCastCameraSync) lastCastCameraSync = data.lastCastCameraSync;
        if (data.lastCanvasScene) lastCanvasScene = data.lastCanvasScene;
        if (data.lastCanvasCamera) lastCanvasCamera = data.lastCanvasCamera;
        if (Array.isArray(data.lastCanvasPages)) lastCanvasPages = data.lastCanvasPages;
        if (typeof data.lastCanvasPageIndex === 'number') lastCanvasPageIndex = data.lastCanvasPageIndex;
        if (data.lastDisplayMode) lastDisplayMode = data.lastDisplayMode;
        if (data.currentActiveSessionId) currentActiveSessionId = data.currentActiveSessionId;
        if (Array.isArray(data.boardStates)) {
          for (const [k, v] of data.boardStates) boardStates.set(k, v);
        }
        if (Array.isArray(data.sharedBoards)) {
          for (const [k, v] of data.sharedBoards) sharedBoards.set(k, v);
        }
      }

      // Restore active session details from disk
      const sessionsDir = path.join(__dirname, 'data', 'sessions');
      if (currentActiveSessionId) {
        const sessionFile = path.join(sessionsDir, `${currentActiveSessionId}.json`);
        if (fs.existsSync(sessionFile)) {
          try {
            const sData = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
            currentActiveSessionMeta = sData.meta;
            currentActiveSessionContent = sData.content;
          } catch (e) {}
        }
      }
      if (!currentActiveSessionContent && fs.existsSync(sessionsDir)) {
        const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
        if (files.length > 0) {
          const sorted = files.map(f => ({
            file: f,
            mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs,
          })).sort((a, b) => b.mtime - a.mtime);
          try {
            const sData = JSON.parse(fs.readFileSync(path.join(sessionsDir, sorted[0].file), 'utf8'));
            currentActiveSessionId = sData.meta?.id || sorted[0].file.replace('.json', '');
            currentActiveSessionMeta = sData.meta;
            currentActiveSessionContent = sData.content;
          } catch (e) {}
        }
      }
      if (currentActiveSessionContent && currentActiveSessionContent.scene) {
        lastCanvasScene = currentActiveSessionContent.scene;
        if (currentActiveSessionContent.camera) {
          lastCanvasCamera = currentActiveSessionContent.camera;
        }
      }
      console.log(`[SyncServer] 💾 Restored persistent state: Cast board = ${currentCastBoardNode?.name || currentCastBoardId || 'none'}, Active Session = ${currentActiveSessionMeta?.name || currentActiveSessionId || 'none'}, Canvas Mirror = ${lastCanvasScene ? 'Ready' : 'None'}`);
    } catch (e) {
      console.warn('[SyncServer] Error loading state file:', e.message);
    }
  }

  loadPersistedState();

  const server = http.createServer((req, res) => {
    // CORS Headers for LAN auto-discovery from WebViews & external clients
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === '/health') {
      const localIp = getLocalIp();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        app: 'nestedcanvas',
        server: 'NestedCanvas Sync Server',
        ip: localIp,
        port: port,
        activeSessionId: currentActiveSessionId,
        sharedBoardsCount: sharedBoards.size,
      }));
      return;
    }

    if (req.url === '/api/sessions') {
      const sessionsDir = path.join(__dirname, 'data', 'sessions');
      const sessions = [];
      if (fs.existsSync(sessionsDir)) {
        const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
        for (const file of files) {
          try {
            const raw = fs.readFileSync(path.join(sessionsDir, file), 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed.meta) sessions.push(parsed.meta);
          } catch (e) {}
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        activeSessionId: currentActiveSessionId,
        sessions: sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
      }));
      return;
    }

    if (req.url === '/api/sessions/active') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        activeSessionId: currentActiveSessionId,
        meta: currentActiveSessionMeta,
        content: currentActiveSessionContent,
        lastCanvasScene,
        lastCanvasCamera,
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  // Start UDP broadcast beacon for auto-discovery (Port 8766)
  try {
    const udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udpSocket.bind(0, () => {
      try {
        udpSocket.setBroadcast(true);
        setInterval(() => {
          try {
            const currentIp = getLocalIp();
            const beacon = Buffer.from(JSON.stringify({
              app: 'nestedcanvas',
              ip: currentIp,
              port: port,
              name: 'Màn hình tương tác NestedCanvas',
              time: Date.now(),
            }));
            const targets = getBroadcastAddresses();
            for (const bcast of targets) {
              udpSocket.send(beacon, 0, beacon.length, 8766, bcast);
            }
          } catch (err) {}
        }, 1500);
      } catch (err) {}
    });
    udpSocket.on('error', () => {});
  } catch (err) {}

  const wss = new WebSocketServer({ server });

  wss.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[SyncServer] ⚠️ WebSocket port ${port} already in use.`);
    } else {
      console.warn(`[SyncServer] WebSocketServer error:`, err.message);
    }
  });

  function broadcastToRoom(boardId, messageStr, senderWs = null) {
    const clients = boardRooms.get(boardId);
    if (!clients) return;
    for (const ws of clients) {
      if (ws !== senderWs && ws.readyState === WebSocket.OPEN) {
        ws.send(messageStr);
      }
    }
  }

  function broadcastToAll(messageStr, senderWs = null) {
    for (const ws of allClients) {
      if (ws !== senderWs && ws.readyState === WebSocket.OPEN) {
        ws.send(messageStr);
      }
    }
  }

  function sendToWs(ws, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(payload));
      } catch (e) {
        console.error('[SyncServer] send error:', e);
      }
    }
  }

  function findNodeInTree(rootNode, id) {
    if (!rootNode) return null;
    if (!id || id === 'root' || id === rootNode.id) return rootNode;
    if (rootNode.id === id) return rootNode;
    if (Array.isArray(rootNode.children)) {
      for (const child of rootNode.children) {
        const found = findNodeInTree(child, id);
        if (found) return found;
      }
    }
    return null;
  }

  function removeNodeFromTree(rootNode, id) {
    if (!rootNode || !rootNode.children) return false;
    const idx = rootNode.children.findIndex(c => c.id === id);
    if (idx !== -1) {
      rootNode.children.splice(idx, 1);
      return true;
    }
    for (const child of rootNode.children) {
      if (removeNodeFromTree(child, id)) return true;
    }
    return false;
  }

  function broadcastBoardPresence(boardId) {
    const clients = boardRooms.get(boardId);
    const count = clients ? clients.size : 0;
    const msg = JSON.stringify({
      type: 'BOARD_PRESENCE',
      boardId,
      count,
    });
    // Send to everyone in room and all hosts
    broadcastToRoom(boardId, msg);
    broadcastToAll(msg);
  }

  function broadcastGlobalPresence() {
    const localIp = getLocalIp();
    const msg = JSON.stringify({
      type: 'PRESENCE',
      count: allClients.size,
      local_ip: localIp,
      shared_boards: Array.from(sharedBoards.values()),
    });
    broadcastToAll(msg);
  }

  wss.on('connection', (ws, req) => {
    allClients.add(ws);
    clientSubscriptions.set(ws, new Set());

    const clientIp = req.socket.remoteAddress || 'unknown';
    const localIp = getLocalIp();

    console.log(`[SyncServer] 🟢 Client connected from ${clientIp}. Total online: ${allClients.size}`);

    // Send WELCOME packet with active session info so all devices unify immediately
    sendToWs(ws, {
      type: 'WELCOME',
      count: allClients.size,
      local_ip: localIp,
      active_session_id: currentActiveSessionId,
      active_session_meta: currentActiveSessionMeta,
      active_session_content: currentActiveSessionContent,
      shared_boards: Array.from(sharedBoards.values()),
      current_cast_board_id: currentCastBoardId,
      current_cast_board_node: currentCastBoardNode,
      last_cast_camera_sync: lastCastCameraSync,
      last_canvas_scene: lastCanvasScene,
      last_canvas_camera: lastCanvasCamera,
      last_canvas_pages: lastCanvasPages,
      last_canvas_page_index: lastCanvasPageIndex,
      last_display_mode: lastDisplayMode,
    });

    broadcastGlobalPresence();

    ws.on('message', (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch (e) {
        return;
      }

      const { type } = data;
      if (!type) return;

      // 0. Smart Session Backup & Switch Protocol
      if (type === 'SESSION_BACKUP') {
        const { sessionId, meta, content, clientId } = data;
        if (sessionId) {
          currentActiveSessionId = sessionId;
          currentActiveSessionMeta = meta;
          currentActiveSessionContent = content;
          if (content && content.scene) {
            lastCanvasScene = content.scene;
          }
          try {
            const sessionsDir = path.join(__dirname, 'data', 'sessions');
            fs.mkdirSync(sessionsDir, { recursive: true });
            const filePath = path.join(sessionsDir, `${sessionId}.json`);
            fs.writeFileSync(filePath, JSON.stringify({ meta, content, savedAt: Date.now() }, null, 2), 'utf8');
            scheduleSaveState();
          } catch (e) {
            console.warn('[SyncServer] Error writing session backup:', e.message);
          }
          // Broadcast to all other devices so all screens stay 100% unified
          broadcastToAll(JSON.stringify({
            type: 'SESSION_UPDATE',
            sessionId,
            meta,
            content,
            clientId: clientId || null,
          }), ws);
        }
        return;
      }

      if (type === 'SESSION_SWITCH') {
        const { sessionId } = data;
        if (sessionId) {
          currentActiveSessionId = sessionId;
          const sessionFile = path.join(__dirname, 'data', 'sessions', `${sessionId}.json`);
          if (fs.existsSync(sessionFile)) {
            try {
              const sData = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
              currentActiveSessionMeta = sData.meta;
              currentActiveSessionContent = sData.content;
              if (sData.content && sData.content.scene) {
                lastCanvasScene = sData.content.scene;
              }
            } catch (e) {}
          }
          scheduleSaveState();
        }
        broadcastToAll(JSON.stringify(data), ws);
        return;
      }

      // 0. Full Canvas Mirror Protocol for PC Display
      if (type === 'CANVAS_MIRROR') {
        const nodeCount = data.scene?.root?.children?.length || 0;
        const elemCount = data.scene?.root?.elements?.length || 0;
        console.log(`[SyncServer] 📥 Received CANVAS_MIRROR from ${clientIp} (${nodeCount} sub-boards, ${elemCount} root strokes)`);
        if (data.scene) {
          lastCanvasScene = data.scene;
          const rootNode = data.scene.root || data.scene;
          if (data.theme) rootNode.style = data.theme;
          if (data.gridType) rootNode.gridType = data.gridType;
          if (Array.isArray(rootNode.children)) {
            for (const child of rootNode.children) {
              if (child && child.id) {
                boardStates.set(child.id, child);
              }
            }
          }
        }
        if (data.camera) {
          lastCanvasCamera = data.camera;
        }
        if (Array.isArray(data.pages)) {
          lastCanvasPages = data.pages;
        }
        if (typeof data.currentPageIndex === 'number') {
          lastCanvasPageIndex = data.currentPageIndex;
        }
        if (data.displayMode) {
          lastDisplayMode = data.displayMode;
        }
        if (!data.isSingleBoardCast) {
          currentCastBoardId = null;
          currentCastBoardNode = null;
          lastCastCameraSync = null;
        }
        scheduleSaveState();
        broadcastToAll(JSON.stringify(data), ws);
        return;
      }

      // Fast-path Page Switch Protocol (Instant Relay <15ms)
      if (type === 'PAGE_SWITCH') {
        console.log(`[SyncServer] 📄 Page switched by ${clientIp} to page index ${data.currentPageIndex}`);
        if (Array.isArray(data.pages)) {
          lastCanvasPages = data.pages;
        }
        if (typeof data.currentPageIndex === 'number') {
          lastCanvasPageIndex = data.currentPageIndex;
        }
        if (data.scene) {
          lastCanvasScene = data.scene;
        }
        if (data.camera) {
          lastCanvasCamera = data.camera;
        }
        if (data.displayMode) {
          lastDisplayMode = data.displayMode;
        }
        scheduleSaveState();
        broadcastToAll(JSON.stringify(data), ws);
        return;
      }

      // Display Layout / Multi-Board Mode Selection Protocol
      if (type === 'DISPLAY_MODE_SET') {
        console.log(`[SyncServer] 🖥️ Display mode set to "${data.mode}" by ${clientIp}`);
        if (data.mode) {
          lastDisplayMode = data.mode;
        }
        scheduleSaveState();
        broadcastToAll(JSON.stringify(data), ws);
        return;
      }

      if (type === 'CANVAS_CLEAR' || type === 'DISPLAY_RESET') {
        console.log(`[SyncServer] 🧹 Canvas cleared by ${clientIp}`);
        lastCanvasScene = null;
        lastCanvasCamera = null;
        currentCastBoardId = null;
        currentCastBoardNode = null;
        scheduleSaveState();
        broadcastToAll(JSON.stringify({ type: 'CANVAS_CLEAR' }), ws);
        return;
      }

      if (type === 'CANVAS_CAMERA_SYNC') {
        lastCanvasCamera = data;
        broadcastToAll(JSON.stringify(data), ws);
        return;
      }

      if (type === 'GET_CANVAS_MIRROR') {
        const sceneToSend = (currentActiveSessionContent && currentActiveSessionContent.scene) || lastCanvasScene;
        const cameraToSend = (currentActiveSessionContent && currentActiveSessionContent.camera) || lastCanvasCamera;
        const pagesToSend = (currentActiveSessionContent && currentActiveSessionContent.pages) || lastCanvasPages;
        const pageIndexToSend = (currentActiveSessionContent && typeof currentActiveSessionContent.currentPageIndex === 'number') ? currentActiveSessionContent.currentPageIndex : lastCanvasPageIndex;
        if (sceneToSend) {
          const rootNode = sceneToSend.root || sceneToSend;
          sendToWs(ws, {
            type: 'CANVAS_MIRROR',
            scene: sceneToSend,
            camera: cameraToSend,
            theme: rootNode.style || 'chalkboard',
            gridType: rootNode.gridType || 'grid',
            pages: pagesToSend,
            currentPageIndex: pageIndexToSend,
            displayMode: lastDisplayMode,
          });
        } else {
          // If no canvas mirror cached yet, request once from presenter
          broadcastToAll(JSON.stringify({ type: 'PLEASE_UPLOAD_CANVAS_MIRROR' }), ws);
        }
        return;
      }

      if (type === 'CANVAS_STROKE_LIVE') {
        broadcastToAll(JSON.stringify(data), ws);
        return;
      }

      if (type === 'CANVAS_STROKE_ADD') {
        const { nodeId, stroke, sendTime } = data;
        const pts = stroke?.points?.length || 0;
        const latency = sendTime ? `${Date.now() - sendTime}ms` : 'n/a';
        console.log(`[SyncServer] ✏️ Stroke added by ${clientIp}: node="${nodeId || 'root'}", ${pts} pts (Độ trễ LAN: ${latency})`);
        if (!lastCanvasScene) {
          lastCanvasScene = {
            root: {
              id: 'root',
              name: 'World Canvas',
              width: 1000000,
              height: 1000000,
              style: 'chalkboard',
              gridType: 'grid',
              elements: [],
              children: [],
            },
          };
        }
        if (stroke) {
          const root = lastCanvasScene.root || lastCanvasScene;
          const target = (nodeId && nodeId !== 'root') ? (findNodeInTree(root, nodeId) || root) : root;
          if (target) {
            if (!Array.isArray(target.elements)) target.elements = [];
            if (!target.elements.some(s => s.id === stroke.id)) {
              target.elements.push(stroke);
            }
          }
          if (currentActiveSessionContent && currentActiveSessionContent.scene) {
            const sRoot = currentActiveSessionContent.scene.root || currentActiveSessionContent.scene;
            const sTarget = (nodeId && nodeId !== 'root') ? (findNodeInTree(sRoot, nodeId) || sRoot) : sRoot;
            if (sTarget) {
              if (!Array.isArray(sTarget.elements)) sTarget.elements = [];
              if (!sTarget.elements.some(s => s.id === stroke.id)) {
                sTarget.elements.push(stroke);
              }
            }
          }
          scheduleSaveState();
        }
        broadcastToAll(JSON.stringify(data), ws);
        return;
      }

      if (type === 'CANVAS_STROKE_ERASE') {
        const { nodeId, removedStrokeIds } = data;
        if (lastCanvasScene && Array.isArray(removedStrokeIds)) {
          const root = lastCanvasScene.root || lastCanvasScene;
          const target = findNodeInTree(root, nodeId) || root;
          if (target && Array.isArray(target.elements)) {
            const idSet = new Set(removedStrokeIds);
            target.elements = target.elements.filter(s => !idSet.has(s.id));
          }
        }
        if (currentActiveSessionContent && currentActiveSessionContent.scene && Array.isArray(removedStrokeIds)) {
          const sRoot = currentActiveSessionContent.scene.root || currentActiveSessionContent.scene;
          const sTarget = findNodeInTree(sRoot, nodeId) || sRoot;
          if (sTarget && Array.isArray(sTarget.elements)) {
            const idSet = new Set(removedStrokeIds);
            sTarget.elements = sTarget.elements.filter(s => !idSet.has(s.id));
          }
        }
        scheduleSaveState();
        broadcastToAll(JSON.stringify(data), ws);
        return;
      }

      if (type === 'CANVAS_STYLE') {
        const { nodeId, style, gridType, isGlobal } = data;
        const updateStyleOnRoot = (root) => {
          if (!root) return;
          if (isGlobal || !nodeId || nodeId === 'root' || nodeId === root.id) {
            if (style) root.style = style;
            if (gridType) root.gridType = gridType;
            const updateRecursive = (n) => {
              if (style) n.style = style;
              if (gridType) n.gridType = gridType;
              if (Array.isArray(n.children)) {
                for (const c of n.children) updateRecursive(c);
              }
            };
            if (Array.isArray(root.children)) {
              for (const c of root.children) updateRecursive(c);
            }
          } else if (nodeId) {
            const target = findNodeInTree(root, nodeId);
            if (target) {
              if (style) target.style = style;
              if (gridType) target.gridType = gridType;
            }
          }
        };

        if (lastCanvasScene) {
          updateStyleOnRoot(lastCanvasScene.root || lastCanvasScene);
        }
        if (currentActiveSessionContent && currentActiveSessionContent.scene) {
          updateStyleOnRoot(currentActiveSessionContent.scene.root || currentActiveSessionContent.scene);
        }
        scheduleSaveState();
        broadcastToAll(JSON.stringify(data), ws);
        return;
      }

      // Legacy/Fallback Cast Board to PC Display Screen
      if (type === 'CAST_BOARD') {
        const { boardId, node } = data;
        currentCastBoardId = boardId;
        if (node) {
          currentCastBoardNode = node;
          boardStates.set(boardId, node);
        } else if (boardStates.has(boardId)) {
          currentCastBoardNode = boardStates.get(boardId);
        }
        console.log(`[SyncServer] 📺 Cast Board requested: ${boardId} (${currentCastBoardNode?.name || 'Unknown'})`);
        scheduleSaveState();
        broadcastToAll(JSON.stringify({
          type: 'CAST_BOARD',
          boardId: currentCastBoardId,
          node: currentCastBoardNode,
        }));
        return;
      }

      if (type === 'STOP_CAST_BOARD') {
        console.log(`[SyncServer] 📺 Cast Board stopped by client`);
        currentCastBoardId = null;
        currentCastBoardNode = null;
        lastCastCameraSync = null;
        scheduleSaveState();
        broadcastToAll(JSON.stringify({
          type: 'STOP_CAST_BOARD',
        }));
        return;
      }

      if (type === 'GET_CAST_BOARD') {
        sendToWs(ws, {
          type: 'CAST_BOARD',
          boardId: currentCastBoardId,
          node: currentCastBoardNode,
          cameraSync: lastCastCameraSync,
        });
        return;
      }

      // Real-time camera zoom & pan synchronization for PC Display Screen
      if (type === 'CAMERA_SYNC') {
        const { boardId } = data;
        if (boardId) {
          lastCastCameraSync = data;
          scheduleSaveState();
          broadcastToAll(JSON.stringify(data), ws);
        }
        return;
      }

      // 1. Host registers or unregisters a shared board
      if (type === 'SHARE_BOARD') {
        const { boardId, node, isShared } = data;
        if (!boardId) return;

        if (isShared) {
          sharedBoards.set(boardId, {
            id: boardId,
            name: node?.name || 'Sub Canvas',
            isShared: true,
            updatedAt: Date.now(),
          });
          if (node) {
            boardStates.set(boardId, node);
          }
          if (!boardRooms.has(boardId)) {
            boardRooms.set(boardId, new Set());
          }
          boardRooms.get(boardId).add(ws);
          clientSubscriptions.get(ws)?.add(boardId);
          console.log(`[SyncServer] 📡 Board shared: ${node?.name || boardId}`);
        } else {
          sharedBoards.delete(boardId);
          if (boardRooms.has(boardId)) {
            boardRooms.get(boardId).delete(ws);
          }
          clientSubscriptions.get(ws)?.delete(boardId);
          console.log(`[SyncServer] 📴 Board stopped sharing: ${boardId}`);
        }
        scheduleSaveState();

        // Broadcast share status to all connected clients
        broadcastToAll(JSON.stringify({
          type: 'BOARD_SHARE_STATUS',
          boardId,
          isShared: !!isShared,
          node: node || null,
        }), ws);
        return;
      }

      // 2. Client joins a specific board room
      if (type === 'JOIN_BOARD') {
        const { boardId, role } = data;
        if (!boardId) return;

        if (!boardRooms.has(boardId)) {
          boardRooms.set(boardId, new Set());
        }
        boardRooms.get(boardId).add(ws);
        clientSubscriptions.get(ws).add(boardId);

        console.log(`[SyncServer] 👤 Client joined board room ${boardId} (Room size: ${boardRooms.get(boardId).size})`);

        // Send current board state if available
        const state = boardStates.get(boardId);
        if (state) {
          sendToWs(ws, {
            type: 'BOARD_STATE',
            boardId,
            node: state,
            isShared: sharedBoards.has(boardId),
          });
        } else {
          // Ask host to upload board state if not cached
          broadcastToAll(JSON.stringify({
            type: 'PLEASE_UPLOAD_BOARD',
            boardId,
          }), ws);
        }

        broadcastBoardPresence(boardId);
        return;
      }

      // 3. Client leaves a board room
      if (type === 'LEAVE_BOARD') {
        const { boardId } = data;
        if (!boardId) return;
        if (boardRooms.has(boardId)) {
          boardRooms.get(boardId).delete(ws);
        }
        clientSubscriptions.get(ws)?.delete(boardId);
        broadcastBoardPresence(boardId);
        return;
      }

      // 4. Client requests board state
      if (type === 'GET_BOARD_STATE') {
        const { boardId } = data;
        if (boardStates.has(boardId)) {
          sendToWs(ws, {
            type: 'BOARD_STATE',
            boardId,
            node: boardStates.get(boardId),
            isShared: sharedBoards.has(boardId),
          });
        } else {
          broadcastToAll(JSON.stringify({
            type: 'PLEASE_UPLOAD_BOARD',
            boardId,
          }), ws);
        }
        return;
      }

      // 5. Host updates or uploads full board state
      if (type === 'BOARD_STATE') {
        const { boardId, node } = data;
        if (boardId && node) {
          boardStates.set(boardId, node);
          // Broadcast to everyone in this room
          broadcastToRoom(boardId, JSON.stringify(data), ws);
        }
        return;
      }

      // 6. Stroke added to a shared board or any of its nested child boards
      if (type === 'STROKE_ADD') {
        const { boardId, nodeId, stroke } = data;
        const targetRoomId = boardId;

        if (!targetRoomId || !sharedBoards.has(targetRoomId)) return;

        if (stroke && boardStates.has(targetRoomId)) {
          const rootNode = boardStates.get(targetRoomId);
          const targetNode = findNodeInTree(rootNode, nodeId || targetRoomId);
          if (targetNode) {
            if (!Array.isArray(targetNode.elements)) targetNode.elements = [];
            targetNode.elements.push(stroke);
          }
        }

        if (boardRooms.has(targetRoomId)) {
          broadcastToRoom(targetRoomId, JSON.stringify(data), ws);
        }
        return;
      }

      // 7. Live in-flight stroke points on shared board or any of its nested child boards
      if (type === 'STROKE_LIVE') {
        const { boardId } = data;
        const targetRoomId = boardId;
        if (!targetRoomId || !sharedBoards.has(targetRoomId)) return;

        if (boardRooms.has(targetRoomId)) {
          broadcastToRoom(targetRoomId, JSON.stringify(data), ws);
        }
        return;
      }

      // 8. Strokes erased in a shared board or any of its nested child boards
      if (type === 'STROKE_ERASE') {
        const { boardId, nodeId, removedStrokeIds } = data;
        const targetRoomId = boardId;
        if (!targetRoomId || !sharedBoards.has(targetRoomId)) return;

        if (removedStrokeIds && boardStates.has(targetRoomId)) {
          const rootNode = boardStates.get(targetRoomId);
          const targetNode = findNodeInTree(rootNode, nodeId || targetRoomId);
          if (targetNode && Array.isArray(targetNode.elements)) {
            const idSet = new Set(removedStrokeIds);
            targetNode.elements = targetNode.elements.filter((s) => !idSet.has(s.id));
          }
        }
        if (boardRooms.has(targetRoomId)) {
          broadcastToRoom(targetRoomId, JSON.stringify(data), ws);
        }
        return;
      }

      // 9. Nested child board created
      if (type === 'NODE_CREATE') {
        const { boardId, parentId, node } = data;
        const targetRoomId = boardId;

        if (node && lastCanvasScene) {
          const root = lastCanvasScene.root || lastCanvasScene;
          const parentNode = findNodeInTree(root, parentId || (targetRoomId && targetRoomId !== root.id ? targetRoomId : root.id)) || root;
          if (parentNode) {
            if (!Array.isArray(parentNode.children)) parentNode.children = [];
            if (!parentNode.children.some(c => c.id === node.id)) {
              parentNode.children.push(node);
            }
            scheduleSaveState();
          }
        }

        if (targetRoomId && sharedBoards.has(targetRoomId) && boardStates.has(targetRoomId)) {
          const rootNode = boardStates.get(targetRoomId);
          const parentNode = findNodeInTree(rootNode, parentId || targetRoomId);
          if (parentNode) {
            if (!Array.isArray(parentNode.children)) parentNode.children = [];
            if (!parentNode.children.some(c => c.id === node.id)) {
              parentNode.children.push(node);
            }
          }
        }

        if (targetRoomId && boardRooms.has(targetRoomId)) {
          broadcastToRoom(targetRoomId, JSON.stringify(data), ws);
        } else {
          broadcastToAll(JSON.stringify(data), ws);
        }
        return;
      }

      // 10. Node transform on canvas or shared board
      if (type === 'NODE_TRANSFORM') {
        const { boardId, nodeId } = data;
        const targetId = nodeId || boardId;

        if (lastCanvasScene && targetId) {
          const root = lastCanvasScene.root || lastCanvasScene;
          const targetNode = findNodeInTree(root, targetId);
          if (targetNode) {
            if (typeof data.w === 'number') targetNode.width = data.w;
            if (typeof data.h === 'number') targetNode.height = data.h;
            if (!targetNode.transform) targetNode.transform = {};
            if (typeof data.x === 'number') targetNode.transform.tx = data.x;
            if (typeof data.y === 'number') targetNode.transform.ty = data.y;
            scheduleSaveState();
          }
        }

        if (targetId && sharedBoards.has(targetId) && boardStates.has(targetId)) {
          const rootNode = boardStates.get(targetId);
          const targetNode = findNodeInTree(rootNode, targetId);
          if (targetNode) {
            targetNode.width = data.w;
            targetNode.height = data.h;
            if (!targetNode.transform) targetNode.transform = {};
            targetNode.transform.tx = data.x;
            targetNode.transform.ty = data.y;
          }
        }

        if (boardId && boardRooms.has(boardId)) {
          broadcastToRoom(boardId, JSON.stringify(data), ws);
        } else {
          broadcastToAll(JSON.stringify(data), ws);
        }
        return;
      }

      // 11. Nested child board deleted
      if (type === 'NODE_DELETE') {
        const { boardId, nodeId } = data;
        const targetId = nodeId || boardId;

        if (lastCanvasScene && targetId) {
          const root = lastCanvasScene.root || lastCanvasScene;
          removeNodeFromTree(root, targetId);
          scheduleSaveState();
        }

        if (boardId && sharedBoards.has(boardId) && boardStates.has(boardId)) {
          const rootNode = boardStates.get(boardId);
          removeNodeFromTree(rootNode, targetId);
        }

        if (boardId && boardRooms.has(boardId)) {
          broadcastToRoom(boardId, JSON.stringify(data), ws);
        } else {
          broadcastToAll(JSON.stringify(data), ws);
        }
        return;
      }

      // 12. Node style
      if (type === 'NODE_STYLE') {
        const { boardId, nodeId, style, gridType } = data;
        const targetId = nodeId || boardId;

        if (lastCanvasScene && targetId) {
          const root = lastCanvasScene.root || lastCanvasScene;
          const targetNode = findNodeInTree(root, targetId);
          if (targetNode) {
            if (style) targetNode.style = style;
            if (gridType) targetNode.gridType = gridType;
            scheduleSaveState();
          }
        }

        if (boardId && sharedBoards.has(boardId) && boardStates.has(boardId)) {
          const rootNode = boardStates.get(boardId);
          const targetNode = findNodeInTree(rootNode, targetId);
          if (targetNode) {
            if (style) targetNode.style = style;
            if (gridType) targetNode.gridType = gridType;
          }
        }

        if (boardId && boardRooms.has(boardId)) {
          broadcastToRoom(boardId, JSON.stringify(data), ws);
        } else {
          broadcastToAll(JSON.stringify(data), ws);
        }
        return;
      }

      // 12.1 Node clear
      if (type === 'NODE_CLEAR') {
        const { boardId, nodeId } = data;
        const targetId = nodeId || boardId;

        if (lastCanvasScene && targetId) {
          const root = lastCanvasScene.root || lastCanvasScene;
          const targetNode = findNodeInTree(root, targetId) || (targetId === root.id ? root : null);
          if (targetNode) {
            targetNode.elements = [];
            targetNode.images = [];
            scheduleSaveState();
          }
        }

        if (boardId && boardRooms.has(boardId)) {
          broadcastToRoom(boardId, JSON.stringify(data), ws);
        } else {
          broadcastToAll(JSON.stringify(data), ws);
        }
        return;
      }

      // 13. Graph expressions on shared board or any of its nested child boards
      if (type === 'GRAPH_EXPR') {
        const { boardId, nodeId, expressions } = data;
        const targetId = nodeId || boardId;

        if (expressions && lastCanvasScene && targetId) {
          const root = lastCanvasScene.root || lastCanvasScene;
          const targetNode = findNodeInTree(root, targetId);
          if (targetNode && targetNode.graphData) {
            targetNode.graphData.expressions = expressions;
            scheduleSaveState();
          }
        }

        if (boardId && boardRooms.has(boardId)) {
          broadcastToRoom(boardId, JSON.stringify(data), ws);
        } else {
          broadcastToAll(JSON.stringify(data), ws);
        }
        return;
      }
    });

    ws.on('close', () => {
      allClients.delete(ws);
      const subs = clientSubscriptions.get(ws);
      if (subs) {
        for (const bId of subs) {
          if (boardRooms.has(bId)) {
            boardRooms.get(bId).delete(ws);
            broadcastBoardPresence(bId);
          }
        }
        clientSubscriptions.delete(ws);
      }
      console.log(`[SyncServer] 🔴 Client disconnected (${clientIp}). Remaining: ${allClients.size}`);
      broadcastGlobalPresence();
    });

    ws.on('error', (err) => {
      console.warn(`[SyncServer] Client error: ${err.message}`);
    });
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[SyncServer] ⚠️ Port ${port} is already in use (another sync server instance may be active).`);
    } else {
      console.error(`[SyncServer] Server error:`, err);
    }
  });

  server.listen(port, '0.0.0.0', () => {
    const localIp = getLocalIp();
    console.log('='.repeat(65));
    console.log(`🚀 NestedCanvas Per-Board LAN Sync Server Running on port ${port}`);
    console.log(`   WebSocket URL (Localhost): ws://localhost:${port}`);
    console.log(`   WebSocket URL (LAN / Wi-Fi): ws://${localIp}:${port}`);
    console.log(`   Web App URL: http://${localIp}:3000`);
    console.log('='.repeat(65));
  });

  return { server, wss };
}

// Auto-run if executed directly via `node server/sync_server.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  startSyncServer(8765);
}
