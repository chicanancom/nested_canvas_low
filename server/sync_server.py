#!/usr/bin/env python3
"""
NestedCanvas Real-Time LAN Synchronization Server
Port: 8765 (WebSocket)
Enables sub-10ms full-duplex collaboration across multiple devices on the same Wi-Fi/LAN.
(e.g., PC connected to Big Projector + iPad / Tablets).
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
    sys.exit(1)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("SyncServer")

PORT = 8765
HOST = "0.0.0.0"

# Connected client sockets
CONNECTED_CLIENTS: Set[WebSocketServerProtocol] = set()

# In-memory master scene cache to quickly provision newly connected devices
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


async def broadcast_presence():
    """Notify all clients of current connected device count."""
    count = len(CONNECTED_CLIENTS)
    presence_msg = json.dumps({
        "type": "PRESENCE",
        "count": count,
        "local_ip": get_local_ip()
    })
    await broadcast(presence_msg)


async def handle_client(websocket: WebSocketServerProtocol):
    global CURRENT_SCENE_STATE
    CONNECTED_CLIENTS.add(websocket)
    client_ip = websocket.remote_address[0] if websocket.remote_address else "unknown"
    logger.info(f"🟢 Client connected: {client_ip} | Total online: {len(CONNECTED_CLIENTS)}")

    try:
        welcome_payload = {
            "type": "WELCOME",
            "count": len(CONNECTED_CLIENTS),
            "local_ip": get_local_ip(),
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

            # 1. Full Scene State Sync (Snapshot)
            if msg_type == "SCENE_STATE":
                CURRENT_SCENE_STATE = data.get("scene")
                await broadcast(message, sender=websocket)

            # 2. Live in-flight stroke points while user is dragging stylus
            elif msg_type == "STROKE_LIVE":
                await broadcast(message, sender=websocket)

            # 3. Completed stroke added
            elif msg_type == "STROKE_ADD":
                await broadcast(message, sender=websocket)

            # 4. Strokes erased
            elif msg_type == "STROKE_ERASE":
                await broadcast(message, sender=websocket)

            # 5. Node moved or resized
            elif msg_type == "NODE_TRANSFORM":
                await broadcast(message, sender=websocket)

            # 6. Node created
            elif msg_type == "NODE_CREATE":
                await broadcast(message, sender=websocket)

            # 7. Node deleted
            elif msg_type == "NODE_DELETE":
                await broadcast(message, sender=websocket)

            # 8. Style / Grid / Theme changed
            elif msg_type == "NODE_STYLE":
                await broadcast(message, sender=websocket)

            # 9. Math Graph expressions updated
            elif msg_type == "GRAPH_EXPR":
                await broadcast(message, sender=websocket)

            # 10. Undo / Redo action triggered
            elif msg_type == "HISTORY_ACTION":
                await broadcast(message, sender=websocket)

            # 11. Request full scene from any peer
            elif msg_type == "REQUEST_SCENE":
                if CURRENT_SCENE_STATE is not None:
                    await websocket.send(json.dumps({
                        "type": "SCENE_STATE",
                        "scene": CURRENT_SCENE_STATE
                    }))
                else:
                    await broadcast(json.dumps({"type": "PLEASE_UPLOAD_SCENE"}), sender=websocket)

            else:
                await broadcast(message, sender=websocket)

    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        logger.error(f"Error handling client {client_ip}: {e}")
    finally:
        CONNECTED_CLIENTS.discard(websocket)
        logger.info(f"🔴 Client disconnected: {client_ip} | Total online: {len(CONNECTED_CLIENTS)}")
        await broadcast_presence()


async def main():
    local_ip = get_local_ip()
    logger.info("=" * 65)
    logger.info("🚀 NestedCanvas Real-Time LAN Sync Server Running")
    logger.info(f"   WebSocket URL (Localhost): ws://localhost:{PORT}")
    logger.info(f"   WebSocket URL (LAN / Wi-Fi): ws://{local_ip}:{PORT}")
    logger.info(f"   Web App URL (for Tablet/iPad): http://{local_ip}:3000")
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
