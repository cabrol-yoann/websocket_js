import { WebSocketServer } from "ws";
import { v4 as uuidv4 } from "uuid";

const PORT = 8080;
const CONNECTION_TIMEOUT = 20000;
const PEERS = new Map();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

const wss = new WebSocketServer({ port: PORT });
wss.on("listening", () => log(`Tracker started on port ${PORT}`));

wss.on("connection", (ws, req) => {
  const peer = { id: null, address: req.socket.remoteAddress || null, username: null };
  PEERS.set(peer, ws);
  log(`New connection from ${peer.address}`, { ts: new Date().toISOString() });

  const timeout = setTimeout(() => {
    if (!peer.id) {
      log(`Timeout: peer ${peer.address}`, { ts: new Date().toISOString() });
      ws.close(1001, JSON.stringify({ type: "error", payload: "Timeout" }));
      PEERS.delete(peer);
    }
  }, CONNECTION_TIMEOUT);

  ws.on("message", (data) => handleMessage(ws, data.toString(), peer, timeout));
  ws.on("close", () => onClose(peer));
  ws.on("error", (err) => log("Socket error:", err.message, { ts: new Date().toISOString() }));
});

function handleMessage(ws, data, peer, timeout) {
  try {
    const msg = JSON.parse(data);
    peer.lastSeen = Date.now();
    if (!msg.type) throw new Error("Missing type");

    clearTimeout(timeout);

    switch (msg.type) {
      case "register":
        peer.id = msg.payload?.id || uuidv4();
        peer.username = msg.payload?.username || "Anonymous";
        peer.port = msg.payload?.port || APP_PORT;
        PEERS.set(peer, ws);
        log(`Registered peer ${peer.id} (${peer.username}) ${peer.port} `, { ts: new Date().toISOString() });
        ws.send(JSON.stringify({ type: "info", ts: Date.now(), from: "tracker", to: peer.id, ts: Date.now(), payload: "Registered successfully" }));
        broadcastPeers(peer);
        break;

      case "unregister":
        PEERS.delete(peer);
        log(`Unregistered peer ${peer.id}`, { ts: new Date().toISOString() });
        ws.send(JSON.stringify({ type: "info", from: "tracker", to: peer.id, ts: Date.now(), payload: "Unregistered" }));
        broadcastPeers(peer);
        break;

      case "getPeers":
        const peersList = Array.from(PEERS.keys())
          .filter(p => p.id !== peer.id)
          .map(p => ({ id: p.id, address: p.address, username: p.username, port: p.port }));
        ws.send(JSON.stringify({ type: "peers", from: "tracker", to: peer.id, ts: Date.now(), payload: peersList }));
        log(`Sent peers list to ${peer.id}`, { ts: new Date().toISOString() });
        break;

      case "ping":
        ws.send(JSON.stringify({ type: "pong", from: "tracker", to: peer.id, ts: Date.now() }));
        log(`Ping received from ${peer.id}`, { ts: new Date().toISOString() });
        break;

      default:
        log("Unknown command:", msg.type, { ts: new Date().toISOString() });
        ws.send(JSON.stringify({ type: "error", from: "tracker", to: peer.id, ts: Date.now(), payload: `Unknown command: ${msg.type}` }));
    }

  } catch (err) {
    log("Error:", err.message, { ts: new Date().toISOString() });
    ws.send(JSON.stringify({ type: "error", from: "tracker", to: peer.id, ts: Date.now(), payload: err.message }));
  }
}

function onClose(peer) {
  log(`Peer disconnected: ${peer.id}`, { ts: new Date().toISOString() });
  PEERS.delete(peer);
  broadcastPeers(peer);
}

function broadcastPeers(excludePeer) {
  const peersList = Array.from(PEERS.keys()).map(p => ({ id: p.id, address: p.address, username: p.username, port: p.port, online: true }));
  const msg = { type: "peersUpdate", ts: Date.now(), from: "tracker", ts: Date.now(), payload: peersList };
  for (const [p, ws] of PEERS.entries()) {
    if (ws.readyState === 1 && p !== excludePeer) {
      ws.send(JSON.stringify(msg));
      log(`Broadcast peers list to ${p.id}`, { ts: new Date().toISOString() });
    }
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, peer] of PEERS.entries()) {
    if (now - peer.lastSeen > CONNECTION_TIMEOUT) {
      log(`Peer offline: ${id}`);
      PEERS.delete(id);
      broadcastPeers();
    }
  }
}, 5000);