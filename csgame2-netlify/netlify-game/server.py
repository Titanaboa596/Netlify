"""
Tank Trouble — FastAPI WebSocket Server
Deploy this to Railway: https://railway.app

The server is the authoritative matchmaker. Clients send {t:'join'} and
the server assigns 'p1' or 'p2' and relays all subsequent messages between
the two players. Supports one room (one active game) at a time.
"""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import json, logging, os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="Tank Trouble Server")

# Allow all origins — needed for Netlify frontend → Railway backend requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static files when running locally (not needed on Railway + Netlify)
_css_dir = os.path.join(BASE_DIR, "css")
_js_dir  = os.path.join(BASE_DIR, "js")
if os.path.isdir(_css_dir):
    app.mount("/css", StaticFiles(directory=_css_dir), name="css")
if os.path.isdir(_js_dir):
    app.mount("/js",  StaticFiles(directory=_js_dir),  name="js")


# ── Room ─────────────────────────────────────────────────────────────────────

class Room:
    """
    Two-slot game room. First joiner = p1 (host), second = p2.
    Resets automatically when either player disconnects.
    """
    def __init__(self):
        self.slots: list[WebSocket | None] = [None, None]

    def assign(self, ws: WebSocket) -> int | None:
        """Place ws in the next open slot. Returns slot index or None if full."""
        for i, slot in enumerate(self.slots):
            if slot is None:
                self.slots[i] = ws
                return i
        return None

    def peer(self, ws: WebSocket) -> WebSocket | None:
        """Return the other player's socket."""
        for i, slot in enumerate(self.slots):
            if slot is ws:
                return self.slots[1 - i]
        return None

    def remove(self, ws: WebSocket):
        """Vacate a slot on disconnect."""
        for i, slot in enumerate(self.slots):
            if slot is ws:
                self.slots[i] = None
                logger.info(f"Slot {i} (p{i+1}) vacated")

    @property
    def full(self) -> bool:
        return all(s is not None for s in self.slots)


room = Room()


# ── Routes ───────────────────────────────────────────────────────────────────

@app.get("/")
async def serve_game(request: Request):
    """Serve the game locally. On Netlify this route is never hit."""
    index = os.path.join(BASE_DIR, "index.html")
    if os.path.exists(index):
        response = FileResponse(index, media_type="text/html")
        response.headers["ngrok-skip-browser-warning"] = "true"
        return response
    return {"status": "Tank Trouble WebSocket server is running"}


@app.get("/health")
async def health():
    """Health check endpoint for Railway."""
    return {"status": "ok", "players": sum(1 for s in room.slots if s)}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = msg.get("t")

            # ── Join: assign a role ───────────────────────────────────────
            if msg_type == "join":
                slot = room.assign(ws)

                if slot is None:
                    await ws.send_text(json.dumps({"t": "full"}))
                    continue

                role = f"p{slot + 1}"
                await ws.send_text(json.dumps({"t": "assigned", "role": role}))
                logger.info(f"Assigned {role}")

                # When p2 joins, tell p1 to start
                if slot == 1:
                    peer = room.peer(ws)
                    if peer:
                        await peer.send_text(json.dumps({"t": "ready"}))

            # ── All other messages: relay to peer ─────────────────────────
            else:
                peer = room.peer(ws)
                if peer:
                    try:
                        await peer.send_text(raw)
                    except Exception:
                        pass

    except WebSocketDisconnect:
        room.remove(ws)
        peer = room.peer(ws)
        if peer:
            try:
                await peer.send_text(json.dumps({"t": "peer_left"}))
            except Exception:
                pass
    except Exception as exc:
        logger.error(f"Error: {exc}")
        room.remove(ws)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8081))
    logger.info(f"Starting on port {port}")
    uvicorn.run(app, host="0.0.0.0", port=port)
