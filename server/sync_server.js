/**
 * NestedCanvas Real-Time LAN Synchronization Server (Node.js)
 * Port: 8765 (WebSocket)
 * Supports Room-Based Sub-Board Synchronization:
 * Enables sharing individual child boards (bảng con) independently over LAN.
 */

import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import os from 'os';

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

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', sharedBoardsCount: sharedBoards.size }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

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
    if (!rootNode || !id) return null;
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

    // Send WELCOME packet (strictly lists active shared child boards)
    sendToWs(ws, {
      type: 'WELCOME',
      count: allClients.size,
      local_ip: localIp,
      shared_boards: Array.from(sharedBoards.values()),
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

      // 9. Nested child board created inside a shared board
      if (type === 'NODE_CREATE') {
        const { boardId, parentId, node } = data;
        const targetRoomId = boardId;
        if (!targetRoomId || !sharedBoards.has(targetRoomId)) return;

        if (node && boardStates.has(targetRoomId)) {
          const rootNode = boardStates.get(targetRoomId);
          const parentNode = findNodeInTree(rootNode, parentId || targetRoomId);
          if (parentNode) {
            if (!Array.isArray(parentNode.children)) parentNode.children = [];
            if (!parentNode.children.some(c => c.id === node.id)) {
              parentNode.children.push(node);
            }
          }
        }

        if (boardRooms.has(targetRoomId)) {
          broadcastToRoom(targetRoomId, JSON.stringify(data), ws);
        }
        return;
      }

      // 10. Node transform on shared board or any of its nested child boards
      if (type === 'NODE_TRANSFORM') {
        const { boardId, nodeId } = data;
        const targetRoomId = boardId || nodeId;
        if (!targetRoomId || !sharedBoards.has(targetRoomId)) return;

        if (boardStates.has(targetRoomId)) {
          const rootNode = boardStates.get(targetRoomId);
          const targetNode = findNodeInTree(rootNode, nodeId || targetRoomId);
          if (targetNode) {
            targetNode.width = data.w;
            targetNode.height = data.h;
            if (!targetNode.transform) targetNode.transform = {};
            targetNode.transform.tx = data.x;
            targetNode.transform.ty = data.y;
          }
        }
        if (boardRooms.has(targetRoomId)) {
          broadcastToRoom(targetRoomId, JSON.stringify(data), ws);
        }
        return;
      }

      // 11. Nested child board deleted inside a shared board
      if (type === 'NODE_DELETE') {
        const { boardId, nodeId } = data;
        const targetRoomId = boardId;
        if (!targetRoomId || !sharedBoards.has(targetRoomId)) return;

        if (nodeId && boardStates.has(targetRoomId)) {
          const rootNode = boardStates.get(targetRoomId);
          removeNodeFromTree(rootNode, nodeId);
        }
        if (boardRooms.has(targetRoomId)) {
          broadcastToRoom(targetRoomId, JSON.stringify(data), ws);
        }
        return;
      }

      // 12. Node style on shared board or any of its nested child boards
      if (type === 'NODE_STYLE') {
        const { boardId, nodeId, style, gridType } = data;
        const targetRoomId = boardId || nodeId;
        if (!targetRoomId || !sharedBoards.has(targetRoomId)) return;

        if (boardStates.has(targetRoomId)) {
          const rootNode = boardStates.get(targetRoomId);
          const targetNode = findNodeInTree(rootNode, nodeId || targetRoomId);
          if (targetNode) {
            if (style) targetNode.style = style;
            if (gridType) targetNode.gridType = gridType;
          }
        }
        if (boardRooms.has(targetRoomId)) {
          broadcastToRoom(targetRoomId, JSON.stringify(data), ws);
        }
        return;
      }

      // 13. Graph expressions on shared board or any of its nested child boards
      if (type === 'GRAPH_EXPR') {
        const { boardId, nodeId, expressions } = data;
        const targetRoomId = boardId || nodeId;
        if (!targetRoomId || !sharedBoards.has(targetRoomId)) return;

        if (expressions && boardStates.has(targetRoomId)) {
          const rootNode = boardStates.get(targetRoomId);
          const targetNode = findNodeInTree(rootNode, nodeId || targetRoomId);
          if (targetNode && targetNode.graphData) {
            targetNode.graphData.expressions = expressions;
          }
        }
        if (boardRooms.has(targetRoomId)) {
          broadcastToRoom(targetRoomId, JSON.stringify(data), ws);
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
