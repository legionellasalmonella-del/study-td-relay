import http from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";

const PORT = Number(process.env.PORT || 8787);

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("study-td-relay ok\n");
});

const wss = new WebSocketServer({ server, path: "/ws" });

const clients = new Map();
const lobbies = new Map();

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch {}
}

function broadcastLobbyList() {
  const list = [...lobbies.values()].map(l => ({
    lobby_id: l.lobby_id,
    display_name: l.display_name,
    game_version: l.game_version,
    members: l.members.size,
    created_at: l.created_at
  }));

  for (const ws of clients.values()) {
    send(ws, { type: "lobby_list", lobbies: list });
  }
}

function cleanupEmptyLobbies() {
  let changed = false;
  for (const [lid, l] of lobbies.entries()) {
    if (!l.members || l.members.size === 0) {
      lobbies.delete(lid);
      changed = true;
    }
  }
  if (changed) broadcastLobbyList();
}

setInterval(() => {
  const now = Date.now();
  let changed = false;

  for (const l of lobbies.values()) {
    for (const cid of [...l.members]) {
      const ws = clients.get(cid);
      const last = l.last_seen.get(cid) || 0;
      if (!ws || (now - last) > 45000) {
        l.members.delete(cid);
        l.last_seen.delete(cid);
        changed = true;
      }
    }
  }

  const before = lobbies.size;
  cleanupEmptyLobbies();
  if (lobbies.size !== before) changed = true;

  if (changed) broadcastLobbyList();
}, 15000);

wss.on("connection", (ws) => {
  const client_id = id("c");
  clients.set(client_id, ws);

  let current_lobby_id = null;
  send(ws, { type: "hello", client_id });

  ws.on("message", (buf) => {
    let msg;
    try { msg = JSON.parse(buf.toString("utf8")); } catch { return; }
    const t = msg?.type;

    function touch(lobby_id) {
      const l = lobbies.get(lobby_id);
      if (!l) return;
      l.last_seen.set(client_id, Date.now());
    }

    if (t === "hello") {
      send(ws, { type: "hello", client_id });
      return;
    }

    if (t === "list_lobbies") {
      broadcastLobbyList();
      return;
    }

    if (t === "create_lobby") {
      const display_name = String(msg.display_name || "Lobby");
      const game_version = String(msg.game_version || "unknown");

      const lobby_id = id("l");
      const lobby = {
        lobby_id,
        display_name,
        game_version,
        created_at: Date.now(),
        host_client_id: client_id,
        members: new Set([client_id]),
        last_seen: new Map([[client_id, Date.now()]])
      };
      lobbies.set(lobby_id, lobby);

      current_lobby_id = lobby_id;
      send(ws, { type: "joined_lobby", lobby: { lobby_id, display_name, game_version, members: lobby.members.size } });
      broadcastLobbyList();
      return;
    }

    if (t === "join_lobby") {
      const lobby_id = String(msg.lobby_id || "");
      const lobby = lobbies.get(lobby_id);
      if (!lobby) {
        send(ws, { type: "error", message: "Lobby not found" });
        return;
      }

      lobby.members.add(client_id);
      lobby.last_seen.set(client_id, Date.now());
      current_lobby_id = lobby_id;

      send(ws, { type: "joined_lobby", lobby: { lobby_id, display_name: lobby.display_name, game_version: lobby.game_version, members: lobby.members.size } });
      broadcastLobbyList();
      return;
    }

    if (t === "leave_lobby") {
      const lobby_id = String(msg.lobby_id || current_lobby_id || "");
      const lobby = lobbies.get(lobby_id);
      if (lobby) {
        lobby.members.delete(client_id);
        lobby.last_seen.delete(client_id);
        if (current_lobby_id === lobby_id) current_lobby_id = null;
        cleanupEmptyLobbies();
        broadcastLobbyList();
      }
      return;
    }

    if (t === "heartbeat") {
      if (current_lobby_id) touch(current_lobby_id);
      return;
    }

    if (t === "relay") {
      const lobby_id = String(msg.lobby_id || "");
      const payload = msg.payload;

      const lobby = lobbies.get(lobby_id);
      if (!lobby) {
        send(ws, { type: "error", message: "Lobby not found" });
        return;
      }
      if (!lobby.members.has(client_id)) {
        send(ws, { type: "error", message: "Not a member of lobby" });
        return;
      }

      touch(lobby_id);

      for (const cid of lobby.members) {
        if (cid === client_id) continue;
        const peer = clients.get(cid);
        if (peer) send(peer, { type: "relay", payload });
      }
      return;
    }
  });

  ws.on("close", () => {
    clients.delete(client_id);
    if (current_lobby_id) {
      const lobby = lobbies.get(current_lobby_id);
      if (lobby) {
        lobby.members.delete(client_id);
        lobby.last_seen.delete(client_id);
      }
    }
    cleanupEmptyLobbies();
    broadcastLobbyList();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`study-td-relay listening on :${PORT} (ws path /ws)`);
});
