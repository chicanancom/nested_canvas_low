#!/usr/bin/env python3
"""
NestedCanvas Real-Time LAN Synchronization Server (Python)
Port: 8765 (WebSocket)
Enables sub-10ms full-duplex collaboration across multiple devices on the same Wi-Fi/LAN.
Supports Room-Based Sub-Board Synchronization (chia sẻ từng bảng con độc lập).
"""

import asyncio
import json
import logging
import socket
import sys
from typing import Set, Dict, Any, Optional

try:
    import websockets
    from websockets.server import WebSocketServerProtocol
except ImportError:
    print("[SyncServer Error] 'websockets' package is required. Run: pip install websockets")
    print("Tip: Alternatively, you can use the built-in Node.js server: npm run sync")
    sys.exit(1)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("SyncServer")

PORT = 8765
HOST = "0.0.0.0"

# Connected client sockets
CONNECTED_CLIENTS: Set[WebSocketServerProtocol] = set()

# Room-based mapping: boardId -> Set of WebSockets
BOARD_ROOMS: Dict[str, Set[WebSocketServerProtocol]] = {}

# Client subscriptions: WebSocket -> Set of boardIds
CLIENT_SUBSCRIPTIONS: Dict[WebSocketServerProtocol, Set[str]] = {}

# In-memory storage for shared boards
BOARD_STATES: Dict[str, Dict[str, Any]] = {}
SHARED_BOARDS: Dict[str, Dict[str, Any]] = {}

# Optional master scene cache
CURRENT_SCENE_STATE: Optional[Dict[str, Any]] = None


def get_local_ip() -> str:
    """Detect local LAN IPv4 address."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))
        ip = s.getsockname()[0]
    except Exception:
        ip = '127.0.0.1'
    finally:
        s.close()
    return ip


async def broadcast(message_str: str, sender: Optional[WebSocketServerProtocol] = None):
    """Broadcast raw JSON string to all connected clients except the sender."""
    if not CONNECTED_CLIENTS:
        return
    targets = [ws for ws in CONNECTED_CLIENTS if ws != sender]
    if targets:
        await asyncio.gather(
            *[ws.send(message_str) for ws in targets],
            return_exceptions=True
        )


async def broadcast_to_room(board_id: str, message_str: str, sender: Optional[WebSocketServerProtocol] = None):
    """Broadcast raw JSON string to all clients subscribed to board_id except the sender."""
    clients = BOARD_ROOMS.get(board_id)
    if not clients:
        return
    targets = [ws for ws in clients if ws != sender]
    if targets:
        await asyncio.gather(
            *[ws.send(message_str) for ws in targets],
            return_exceptions=True
        )


def find_node_in_tree(root_node: dict, target_id: str) -> Optional[dict]:
    if not root_node or not target_id:
        return None
    if root_node.get("id") == target_id:
        return root_node
    children = root_node.get("children", [])
    if isinstance(children, list):
        for child in children:
            found = find_node_in_tree(child, target_id)
            if found:
                return found
    return None


def remove_node_from_tree(root_node: dict, target_id: str) -> bool:
    if not root_node or not target_id:
        return False
    children = root_node.get("children", [])
    if isinstance(children, list):
        for i, child in enumerate(children):
            if child.get("id") == target_id:
                children.pop(i)
                return True
            if remove_node_from_tree(child, target_id):
                return True
    return False


async def broadcast_board_presence(board_id: str):
    count = len(BOARD_ROOMS.get(board_id, set()))
    msg = json.dumps({
        "type": "BOARD_PRESENCE",
        "boardId": board_id,
        "count": count
    })
    await broadcast_to_room(board_id, msg)
    await broadcast(msg)


async def broadcast_presence():
    """Notify all clients of current connected device count and shared boards."""
    count = len(CONNECTED_CLIENTS)
    presence_msg = json.dumps({
        "type": "PRESENCE",
        "count": count,
        "local_ip": get_local_ip(),
        "shared_boards": list(SHARED_BOARDS.values())
    })
    await broadcast(presence_msg)


async def handle_client(websocket: WebSocketServerProtocol):
    global CURRENT_SCENE_STATE
    CONNECTED_CLIENTS.add(websocket)
    CLIENT_SUBSCRIPTIONS[websocket] = set()
    client_ip = websocket.remote_address[0] if websocket.remote_address else "unknown"
    logger.info(f"🟢 Client connected: {client_ip} | Total online: {len(CONNECTED_CLIENTS)}")

    try:
        welcome_payload = {
            "type": "WELCOME",
            "count": len(CONNECTED_CLIENTS),
            "local_ip": get_local_ip(),
            "shared_boards": list(SHARED_BOARDS.values()),
            "has_scene": CURRENT_SCENE_STATE is not None
        }
        if CURRENT_SCENE_STATE is not None:
            welcome_payload["scene"] = CURRENT_SCENE_STATE

        await websocket.send(json.dumps(welcome_payload))
        await broadcast_presence()

        async for message in websocket:
            try:
                data = json.loads(message)
            except Exception:
                continue

            msg_type = data.get("type")

            # 1. Share or Unshare a Board
            if msg_type == "SHARE_BOARD":
                board_id = data.get("boardId")
                node = data.get("node")
                is_shared = data.get("isShared", False)
                if board_id:
                    if is_shared:
                        SHARED_BOARDS[board_id] = {
                            "id": board_id,
                            "name": node.get("name", "Sub Canvas") if node else "Sub Canvas",
                            "isShared": True
                        }
                        if node:
                            BOARD_STATES[board_id] = node
                        if board_id not in BOARD_ROOMS:
                            BOARD_ROOMS[board_id] = set()
                        BOARD_ROOMS[board_id].add(websocket)
                        CLIENT_SUBSCRIPTIONS[websocket].add(board_id)
                    else:
                        SHARED_BOARDS.pop(board_id, None)
                        if board_id in BOARD_ROOMS:
                            BOARD_ROOMS[board_id].discard(websocket)
                        CLIENT_SUBSCRIPTIONS[websocket].discard(board_id)

                    await broadcast(json.dumps({
                        "type": "BOARD_SHARE_STATUS",
                        "boardId": board_id,
                        "isShared": is_shared,
                        "node": node
                    }), sender=websocket)

            # 2. Join a Board Room
            elif msg_type == "JOIN_BOARD":
                board_id = data.get("boardId")
                if board_id:
                    if board_id not in BOARD_ROOMS:
                        BOARD_ROOMS[board_id] = set()
                    BOARD_ROOMS[board_id].add(websocket)
                    CLIENT_SUBSCRIPTIONS[websocket].add(board_id)

                    state = BOARD_STATES.get(board_id)
                    if state:
                        await websocket.send(json.dumps({
                            "type": "BOARD_STATE",
                            "boardId": board_id,
                            "node": state,
                            "isShared": board_id in SHARED_BOARDS
                        }))
                    else:
                        await broadcast(json.dumps({
                            "type": "PLEASE_UPLOAD_BOARD",
                            "boardId": board_id
                        }), sender=websocket)

                    await broadcast_board_presence(board_id)

            # 3. Leave a Board Room
            elif msg_type == "LEAVE_BOARD":
                board_id = data.get("boardId")
                if board_id:
                    if board_id in BOARD_ROOMS:
                        BOARD_ROOMS[board_id].discard(websocket)
                    CLIENT_SUBSCRIPTIONS[websocket].discard(board_id)
                    await broadcast_board_presence(board_id)

            # 4. Get Board State
            elif msg_type == "GET_BOARD_STATE":
                board_id = data.get("boardId")
                if board_id and board_id in BOARD_STATES:
                    await websocket.send(json.dumps({
                        "type": "BOARD_STATE",
                        "boardId": board_id,
                        "node": BOARD_STATES[board_id],
                        "isShared": board_id in SHARED_BOARDS
                    }))
                else:
                    await broadcast(json.dumps({
                        "type": "PLEASE_UPLOAD_BOARD",
                        "boardId": board_id
                    }), sender=websocket)

            # 5. Full Board State upload
            elif msg_type == "BOARD_STATE":
                board_id = data.get("boardId")
                node = data.get("node")
                if board_id and node:
                    BOARD_STATES[board_id] = node
                    await broadcast_to_room(board_id, message, sender=websocket)

            # 6. Stroke Added to shared board or any nested child board
            elif msg_type == "STROKE_ADD":
                target_room = data.get("boardId")
                node_id = data.get("nodeId") or target_room
                stroke = data.get("stroke")
                if not target_room or target_room not in SHARED_BOARDS:
                    continue
                if stroke and target_room in BOARD_STATES:
                    root_node = BOARD_STATES[target_room]
                    target_node = find_node_in_tree(root_node, node_id)
                    if target_node:
                        if not isinstance(target_node.get("elements"), list):
                            target_node["elements"] = []
                        target_node["elements"].append(stroke)
                if target_room in BOARD_ROOMS:
                    await broadcast_to_room(target_room, message, sender=websocket)

            # 7. Live in-flight stroke
            elif msg_type == "STROKE_LIVE":
                target_room = data.get("boardId")
                if not target_room or target_room not in SHARED_BOARDS:
                    continue
                if target_room in BOARD_ROOMS:
                    await broadcast_to_room(target_room, message, sender=websocket)

            # 8. Stroke Erase
            elif msg_type == "STROKE_ERASE":
                target_room = data.get("boardId")
                node_id = data.get("nodeId") or target_room
                removed_ids = data.get("removedStrokeIds")
                if not target_room or target_room not in SHARED_BOARDS:
                    continue
                if removed_ids and target_room in BOARD_STATES:
                    root_node = BOARD_STATES[target_room]
                    target_node = find_node_in_tree(root_node, node_id)
                    if target_node and isinstance(target_node.get("elements"), list):
                        id_set = set(removed_ids)
                        target_node["elements"] = [s for s in target_node["elements"] if s.get("id") not in id_set]
                if target_room in BOARD_ROOMS:
                    await broadcast_to_room(target_room, message, sender=websocket)

            # 9. Nested child board created
            elif msg_type == "NODE_CREATE":
                target_room = data.get("boardId")
                parent_id = data.get("parentId") or target_room
                new_node = data.get("node")
                if not target_room or target_room not in SHARED_BOARDS:
                    continue
                if new_node and target_room in BOARD_STATES:
                    root_node = BOARD_STATES[target_room]
                    parent_node = find_node_in_tree(root_node, parent_id)
                    if parent_node:
                        if not isinstance(parent_node.get("children"), list):
                            parent_node["children"] = []
                        if not any(c.get("id") == new_node.get("id") for c in parent_node["children"]):
                            parent_node["children"].append(new_node)
                if target_room in BOARD_ROOMS:
                    await broadcast_to_room(target_room, message, sender=websocket)

            # 10. Node transform (moved/resized)
            elif msg_type == "NODE_TRANSFORM":
                target_room = data.get("boardId")
                node_id = data.get("nodeId") or target_room
                if not target_room or target_room not in SHARED_BOARDS:
                    continue
                if target_room in BOARD_STATES:
                    root_node = BOARD_STATES[target_room]
                    target_node = find_node_in_tree(root_node, node_id)
                    if target_node:
                        target_node["width"] = data.get("w", target_node.get("width", 600))
                        target_node["height"] = data.get("h", target_node.get("height", 400))
                        if "transform" not in target_node or not isinstance(target_node["transform"], dict):
                            target_node["transform"] = {}
                        target_node["transform"]["tx"] = data.get("x", 0)
                        target_node["transform"]["ty"] = data.get("y", 0)
                if target_room in BOARD_ROOMS:
                    await broadcast_to_room(target_room, message, sender=websocket)

            # 11. Nested child board deleted
            elif msg_type == "NODE_DELETE":
                target_room = data.get("boardId")
                node_id = data.get("nodeId")
                if not target_room or target_room not in SHARED_BOARDS:
                    continue
                if node_id and target_room in BOARD_STATES:
                    root_node = BOARD_STATES[target_room]
                    remove_node_from_tree(root_node, node_id)
                if target_room in BOARD_ROOMS:
                    await broadcast_to_room(target_room, message, sender=websocket)

            # 12. Node style / graph expressions on shared board or any nested child board
            elif msg_type in ("NODE_STYLE", "GRAPH_EXPR"):
                target_room = data.get("boardId")
                if target_room and target_room in SHARED_BOARDS and target_room in BOARD_ROOMS:
                    await broadcast_to_room(target_room, message, sender=websocket)

    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        logger.error(f"Error handling client {client_ip}: {e}")
    finally:
        CONNECTED_CLIENTS.discard(websocket)
        subs = CLIENT_SUBSCRIPTIONS.pop(websocket, set())
        for b_id in subs:
            if b_id in BOARD_ROOMS:
                BOARD_ROOMS[b_id].discard(websocket)
                await broadcast_board_presence(b_id)
        logger.info(f"🔴 Client disconnected: {client_ip} | Total online: {len(CONNECTED_CLIENTS)}")
        await broadcast_presence()


async def main():
    local_ip = get_local_ip()
    logger.info("=" * 65)
    logger.info("🚀 NestedCanvas Real-Time LAN Sync Server (Python)")
    logger.info(f"   WebSocket URL (Localhost): ws://localhost:{PORT}")
    logger.info(f"   WebSocket URL (LAN / Wi-Fi): ws://{local_ip}:{PORT}")
    logger.info(f"   Web App URL: http://{local_ip}:3000")
    logger.info("=" * 65)

    async with websockets.serve(handle_client, HOST, PORT):
        await asyncio.Future()


def run_sync_server_in_thread():
    """Utility to run sync server in background daemon thread."""
    import threading

    def _thread_target():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(main())
        except Exception as e:
            logger.error(f"Sync server thread exited: {e}")

    t = threading.Thread(target=_thread_target, daemon=True, name="SyncServerThread")
    t.start()
    return t


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Sync server stopped by user.")
