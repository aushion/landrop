const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const ROOM_TTL_MS = 2 * 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, "public");
const ENABLE_STUN = process.env.ENABLE_STUN === "true";
const STUN_SERVERS = ENABLE_STUN
  ? (process.env.STUN_SERVERS || "stun:stun.l.google.com:19302")
      .split(",")
      .map((url) => url.trim())
      .filter(Boolean)
      .map((url) => ({ urls: url }))
  : [];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const rooms = new Map();
const peers = new Map();

function send(socket, payload) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function roomSnapshot(room) {
  return {
    code: room.code,
    peers: Array.from(room.clients.values()).map((client) => ({
      role: client.role,
      deviceName: client.deviceName,
    })),
    count: room.clients.size,
  };
}

function removeRoomIfEmpty(code) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.clients.size === 0) {
    clearTimeout(room.timeoutId);
    rooms.delete(code);
  }
}

function scheduleRoomTimeout(code) {
  const room = rooms.get(code);
  if (!room) return;

  clearTimeout(room.timeoutId);
  room.timeoutId = setTimeout(() => {
    const targetRoom = rooms.get(code);
    if (!targetRoom) return;

    for (const client of targetRoom.clients.values()) {
      send(client.socket, {
        type: "room_timeout",
        message: "房间等待超时，请重新输入配对码。",
      });
      client.socket.close(4000, "Room timeout");
    }

    rooms.delete(code);
  }, ROOM_TTL_MS);
}

function detachPeer(socket) {
  const peer = peers.get(socket);
  if (!peer) return;

  const room = rooms.get(peer.code);
  if (room) {
    room.clients.delete(peer.id);

    for (const client of room.clients.values()) {
      send(client.socket, {
        type: "peer_left",
        message: "对端已离开房间。",
      });
    }

    if (room.clients.size > 0) {
      scheduleRoomTimeout(room.code);
    } else {
      removeRoomIfEmpty(room.code);
    }
  }

  peers.delete(socket);
}

function handleJoin(socket, message) {
  const code = String(message.code || "").trim();
  const role = String(message.role || "").trim();
  const deviceName = String(message.deviceName || "").trim().slice(0, 32) || "未命名设备";

  if (!/^\d{4}$/.test(code)) {
    send(socket, { type: "error", message: "请输入 4 位数字配对码。" });
    return;
  }

  if (!["sender", "receiver"].includes(role)) {
    send(socket, { type: "error", message: "角色无效。" });
    return;
  }

  if (peers.has(socket)) {
    send(socket, { type: "error", message: "当前连接已加入房间。" });
    return;
  }

  let room = rooms.get(code);
  if (!room) {
    room = {
      code,
      createdAt: Date.now(),
      clients: new Map(),
      timeoutId: null,
    };
    rooms.set(code, room);
  }

  if (room.clients.size >= 2) {
    send(socket, { type: "room_full", message: "房间已占用，不可配对。" });
    return;
  }

  const roleExists = Array.from(room.clients.values()).some(
    (client) => client.role === role,
  );
  if (roleExists) {
    send(socket, {
      type: "role_conflict",
      message: "该角色已存在，请选择另一角色或更换配对码。",
    });
    return;
  }

  const peer = {
    id: crypto.randomUUID(),
    code,
    role,
    deviceName,
    socket,
  };

  room.clients.set(peer.id, peer);
  peers.set(socket, peer);

  send(socket, {
    type: "joined",
    code,
    role,
    deviceName,
    message:
      room.clients.size === 1 ? "已进入房间，等待对端加入。" : "配对成功，正在建立连接。",
  });

  scheduleRoomTimeout(code);

  if (room.clients.size === 2) {
    clearTimeout(room.timeoutId);
    const participants = Array.from(room.clients.values());
    for (const client of participants) {
      const partner = participants.find((item) => item.id !== client.id);
      send(client.socket, {
        type: "paired",
        code,
        peerRole: partner.role,
        peerDeviceName: partner.deviceName,
        selfDeviceName: client.deviceName,
        initiator: client.role === "sender",
        room: roomSnapshot(room),
      });
    }
  }
}

function handleSignal(socket, message) {
  const peer = peers.get(socket);
  if (!peer) {
    send(socket, { type: "error", message: "请先加入房间。" });
    return;
  }

  const room = rooms.get(peer.code);
  if (!room || room.clients.size < 2) {
    send(socket, { type: "error", message: "对端尚未就绪。" });
    return;
  }

  const target = Array.from(room.clients.values()).find(
    (client) => client.id !== peer.id,
  );
  if (!target) {
    send(socket, { type: "error", message: "找不到对端连接。" });
    return;
  }

  send(target.socket, {
    type: "signal",
    payload: message.payload,
  });
}

function createHttpServer() {
  return http.createServer((req, res) => {
    if (req.url === "/config") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(
        JSON.stringify({
          rtcConfig: { iceServers: STUN_SERVERS },
          networkMode: ENABLE_STUN ? "stun-enabled" : "lan-only",
        }),
      );
      return;
    }

    const requestPath = req.url === "/" ? "/index.html" : req.url;
    const safePath = path
      .normalize(requestPath)
      .replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(PUBLIC_DIR, safePath);

    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    fs.readFile(filePath, (error, data) => {
      if (error) {
        res.writeHead(error.code === "ENOENT" ? 404 : 500);
        res.end(error.code === "ENOENT" ? "Not found" : "Server error");
        return;
      }

      const ext = path.extname(filePath);
      res.writeHead(200, {
        "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      });
      res.end(data);
    });
  });
}

const server = createHttpServer();
const wss = new WebSocketServer({ server });

wss.on("connection", (socket) => {
  send(socket, {
    type: "ready",
    message: "信令服务连接成功。",
  });

  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === "join") {
        handleJoin(socket, message);
        return;
      }

      if (message.type === "signal") {
        handleSignal(socket, message);
        return;
      }

      send(socket, { type: "error", message: "未知消息类型。" });
    } catch (error) {
      send(socket, { type: "error", message: "消息格式错误。" });
    }
  });

  socket.on("close", () => {
    detachPeer(socket);
  });

  socket.on("error", () => {
    detachPeer(socket);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Flash Transfer listening on http://${HOST}:${PORT}`);
});
