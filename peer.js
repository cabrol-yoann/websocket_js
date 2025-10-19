import WebSocket, { WebSocketServer } from "ws";
import express from "express";
import { createServer } from "http";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";

/* =====================================================
   📦 CONFIG & VARIABLES GLOBALES
===================================================== */
const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_PORT = process.argv[2] ? parseInt(process.argv[2]) : 9001;
const TRACKER_URL = "ws://localhost:8080";
const MAX_PEERS = 2;
const ratchetState = new Map(); 

const keyPair = crypto.generateKeyPairSync("x25519");
const myPrivateKey = keyPair.privateKey;
const myPublicKey = keyPair.publicKey.export({ type: "spki", format: "der" });
const identity = crypto.generateKeyPairSync("ed25519");

const peerId = uuidv4();
let username = `user${Math.floor(Math.random() * 1000)}`;
let clientSocket = null;

const peers = new Map();       // peerId => { socket, username, sessionKey, publicKey, pendingMessages, lastSeen }
const pendingPeers = new Set();
const messageBuffer = new Map();

/* =====================================================
   🧰 UTILITAIRES
===================================================== */
function log(level, ...args) {
  const ts = new Date().toISOString();
  const emoji = {
    info: "ℹ️",
    warn: "⚠️",
    error: "🚨",
    event: "📡",
    secure: "🔐",
    msg: "💬",
    ok: "✅"
  }[level] || "📝";

  console.log(`${ts} ${emoji}`, ...args);
}

function deriveSessionKey(sharedSecret) {
  return crypto.hkdfSync("sha256", sharedSecret, Buffer.alloc(0), Buffer.from("session key"), 32);
}

function encryptMessage(sessionKey, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", sessionKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    encrypted: encrypted.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function decryptMessageWithNonce(peerId, encryptedData, nonce) {
  const state = ratchetState.get(peerId);
  if (!state) {
    log("warn", `Ratchet vide pour ${peerId}, impossible de déchiffrer`);
    return null;
  }
  if (nonce < state.recvCounter) {
    log("warn",`Message replay détecté pour ${peerId}`);
    return null;
  }
  state.recvCounter = nonce + 1;
  return decryptMessage(state.sessionKey, encryptedData);
}

function decryptMessage(sessionKey, encryptedData) {
  const { iv, encrypted, tag } = encryptedData;
  const decipher = crypto.createDecipheriv("aes-256-gcm", sessionKey, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]);
  return decrypted.toString("utf8");
}

function signHandshake(ephemeralPubKey) {
  return crypto.sign(
    null,
    ephemeralPubKey,
    identity.privateKey
  ).toString("base64");
}

function verifyHandshake(ephemeralPubKey, signature, identityPubKey) {
  return crypto.verify(
    null,
    ephemeralPubKey,
    identityPubKey,
    Buffer.from(signature, "base64")
  );
}

function rotateKeys(peerId) {
  const ephemeralKeyPair = crypto.generateKeyPairSync("x25519");
  const peer = peers.get(peerId);
  if (!peer) return;

  // Envoyer la nouvelle clé publique éphémère au peer
  const keyRotationMsg = {
    type: "keyRotation",
    publicKey: ephemeralKeyPair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };

  if (peer.socket.readyState === WebSocket.OPEN) {
    peer.socket.send(JSON.stringify(keyRotationMsg));
  }

  // Calculer localement le nouveau secret partagé
  const sharedSecret = crypto.diffieHellman({ privateKey: ephemeralKeyPair.privateKey, publicKey: peer.publicKey });
  const newSessionKey = deriveSessionKey(sharedSecret);

  ratchetState.set(peerId, {
    sendCounter: 0,
    recvCounter: 0,
    rootKey: sharedSecret,
    sessionKey: newSessionKey,
  });

  peer.sessionKey = newSessionKey;

  log("info", `Clé rotatée localement pour ${peer.username}`);
}

function handleKeyRotation(peerId, msg) {
  const peer = peers.get(peerId);
  if (!peer) return;

  const peerEphemeralPubKey = crypto.createPublicKey({
    key: Buffer.from(msg.publicKey, "base64"),
    type: "spki",
    format: "der",
  });

  // Calculer la nouvelle sessionKey à partir de la clé éphémère reçue
  const sharedSecret = crypto.diffieHellman({ privateKey: myPrivateKey, publicKey: peerEphemeralPubKey });
  const newSessionKey = deriveSessionKey(sharedSecret);

  ratchetState.set(peerId, {
    sendCounter: 0,
    recvCounter: 0,
    rootKey: sharedSecret,
    sessionKey: newSessionKey,
  });

  peer.sessionKey = newSessionKey;

  log("secure", `Clé rotatée pour ${peer.username} après réception`);
}


/* =====================================================
   🧭 AFFICHAGE ÉTAT DU RÉSEAU
===================================================== */
function printNetworkStatus() {
  console.log("\n==============================");
  console.log(`🌐  ÉTAT DU RÉSEAU — ${new Date().toLocaleTimeString()}`);
  console.log(`🆔  PeerID local : ${peerId}`);
  console.log(`👤  Username local : ${username}`);
  console.log(`📡  Peers connectés : ${peers.size}`);

  if (peers.size === 0) {
    console.log("⚠️  Aucun peer connecté");
  } else {
    peers.forEach((peerInfo, id) => {
      const state = peerInfo.socket.readyState === WebSocket.OPEN ? "✅ OPEN" : "❌ CLOSED";
      const lastSeen = new Date(peerInfo.lastSeen).toLocaleTimeString();
      console.log(`- ID: ${id} | User: ${peerInfo.username} | State: ${state} | LastSeen: ${lastSeen}`);
    });
  }

  if (clientSocket) {
    const state = clientSocket.readyState === WebSocket.OPEN ? "✅ OPEN" : "❌ CLOSED";
    console.log(`🖥️  Client web : ${state}`);
  } else {
    console.log(`🖥️  Client web : Aucun`);
  }

  console.log("==============================\n");
}

/* =====================================================
   🧑‍🤝‍🧑 HANDSHAKE FUSIONNÉE
===================================================== */
function initPeerConnection(ws, isInitiator = false, remoteId = null) {
  const peerInfo = {
    socket: ws,
    username: "Anonymous",
    sessionKey: null,
    publicKey: null,
    pendingMessages: [],
    lastSeen: Date.now()
  };

  if (remoteId) peers.set(remoteId, peerInfo);

  ws.on("message", data => {
    const msg = JSON.parse(data.toString());

    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    }

    if (msg.type === "pong") {
      ws.lastPong = Date.now();
      return;
    }

    // --- Enregistrement du client web ---
    if (msg.type === "register") {
      clientSocket = ws;
      clientSocket.username = username;
      log("ok", "Client web enregistré comme clientSocket");
      return;
    }

    // --- Handshake reçu
    if (msg.type === "handshake") {
      const peerIdRemote = msg.peerId;
      const peerPublicKey = crypto.createPublicKey({
        key: Buffer.from(msg.publicKey, "base64"),
        type: "spki",
        format: "der",
      });
      const peerIdentityKey = crypto.createPublicKey({
        key: Buffer.from(msg.identityKey, "base64"),
        type: "spki",
        format: "der",
      });

      const signatureValid = verifyHandshake(
        peerPublicKey.export({ type: "spki", format: "der" }),
        msg.signature,
        peerIdentityKey
      );
    
      if (!signatureValid) {
        log("error", `Handshake signature invalide pour ${peerIdRemote}`);
        ws.close();
        return;
      }

      const sharedSecret = crypto.diffieHellman({ privateKey: myPrivateKey, publicKey: peerPublicKey });
      peerInfo.sessionKey = deriveSessionKey(sharedSecret);
      peerInfo.publicKey = peerPublicKey;
      peerInfo.username = msg.username;
      peerInfo.id = peerIdRemote;

      peers.set(peerIdRemote, peerInfo);

      ratchetState.set(peerIdRemote, {
        sendCounter: 0,
        recvCounter: 0,
        sessionKey: peerInfo.sessionKey
      });

      const identityPubKeyBase64 = identity.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64");

      const signatureAck = signHandshake(myPublicKey);

      ws.send(JSON.stringify({
        type: "handshake_ack",
        peerId,
        username,
        publicKey: myPublicKey.toString("base64"),
        identityKey: identityPubKeyBase64,
        signature: signatureAck
      }));

      log("event", `Handshake reçu et ack envoyé à ${peerIdRemote}`);
      sendBufferedMessages(peerInfo.username);
      return;
    }

    // --- Handshake ack reçu
    if (msg.type === "handshake_ack") {
      const peerIdRemote = msg.peerId;
      const p = peers.get(peerIdRemote);
      if (!p) return;

      const peerPublicKey = crypto.createPublicKey({
        key: Buffer.from(msg.publicKey, "base64"),
        type: "spki",
        format: "der",
      });

      const peerIdentityKey = crypto.createPublicKey({
        key: Buffer.from(msg.identityKey, "base64"),
        type: "spki",
        format: "der",
      });
    
      const valid = verifyHandshake(
        peerPublicKey.export({ type: "spki", format: "der" }),
        msg.signature,
        peerIdentityKey
      );
    
      if (!valid) {
        log("error", `Handshake_ack signature invalide pour ${peerIdRemote}`);
        p.socket.close();
        peers.delete(peerIdRemote);
        return;
      }

      const sharedSecret = crypto.diffieHellman({ privateKey: myPrivateKey, publicKey: peerPublicKey });
      p.sessionKey = deriveSessionKey(sharedSecret);
      p.publicKey = peerPublicKey;
      p.username = msg.username;
      p.id = msg.peerId;

      ratchetState.set(peerIdRemote, {
        sendCounter: 0,
        recvCounter: 0,
        sessionKey: peerInfo.sessionKey
      });

      log("secure", `Handshake_ack reçu et sessionKey dérivée pour ${peerIdRemote}`);
      sendBufferedMessages(p.username);
      return;
    }

    // --- Rotation de key
    if (msg.type === "keyRotation") {
      const peerIdRemote = Array.from(peers.entries()).find(([_, p]) => p.socket === ws)?.[0];
      if (!peerIdRemote) return;
      handleKeyRotation(peerIdRemote, msg);
    }

    // --- Message venant du front (non chiffré)
  if (msg.type === "sendMessage") {
    const { text, to } = msg.data;
    msg.data.username = clientSocket.username;
    msg.peerId = peerId;
    if (to) {
      // Envoi direct à un peer spécifique
      const peer = Array.from(peers.values()).find(p => p.username === to);
      if (peer && peer.socket.readyState === WebSocket.OPEN) sendEncrypted(peer, msg);
      else bufferMessage(to, msg);
    } else {
      // Broadcast aux autres peers (chiffré)
      broadcastToPeers(msg.data.username, text);
    }
    return;
  }

  // --- Message chiffré reçu d’un peer
  const peerIdRemote = Array.from(peers.entries()).find(([_, peer]) => peer.socket === ws)?.[0];
  if (!peerIdRemote) return;

  if (msg.type === "encrypted") {
    const peer = peers.get(peerIdRemote);
    if (!peer.sessionKey) return bufferMessage(peer.username, msg);
    log("info", peerIdRemote+" : "+ msg.payload+ " : "+ msg.nonce)
    const decrypted = decryptMessageWithNonce(peerIdRemote, msg.payload, msg.nonce);
    log("info",decrypted)
    handleClientMessage( JSON.parse(decrypted));
  } else {
    handleClientMessage(msg);
  }
  });

  ws.on("close", () => {
    for (const [id, p] of peers.entries()) {
      if (p.socket === ws) peers.delete(id);
    }
  });

  if (isInitiator) {
    const signature = signHandshake(myPublicKey);
    ws.send(JSON.stringify({
      type: "handshake",
      peerId,
      username,
      publicKey: myPublicKey.toString("base64"),
      identityKey: identity.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      signature
    }));
  }
}

/* =====================================================
   💬 GESTION DES MESSAGES
===================================================== */

function handleClientMessage(msg) {
  if (msg.type !== "sendMessage") return;
  if (msg.peerId === peerId) return;
  const { text, to } = msg.data;
  const sender = msg.data.username;
  log("msg", `${sender}: ${text}`);

  // Préparer l'objet message complet
  const fullMsg = {
    id: uuidv4(),
    type: "sendMessage",
    data: { username: sender, text, to },
    date: new Date()
  };

  if (to) {
    // --- Message privé ---
    if (clientSocket && clientSocket.username === to && clientSocket.readyState === WebSocket.OPEN) {
      // Destinataire = client local
      clientSocket.send(JSON.stringify(fullMsg));
      log("ok", `Message privé livré à client local (${to})`);
    } else {
      // Destinataire = un peer
      const peer = Array.from(peers.values()).find(p => p.username === to);
      if (peer && peer.socket.readyState === WebSocket.OPEN) {
        sendEncrypted(peer, fullMsg);
        log("event", `Message privé envoyé à peer (${to})`);
      } else {
        bufferMessage(to, fullMsg);
        log("warn", `Message privé bufferisé pour ${to}`);
      }
    }
  } else {
    // --- Broadcast public ---
    broadcastToClient(sender, text);
    //broadcastToPeers(sender, text);
  }
}


/* =====================================================
   📨 ENCRYPT / BUFFER
===================================================== */
function ensureRatchet(peerId, sessionKey) {
  if (!ratchetState.has(peerId)) {
    ratchetState.set(peerId, {
      sendCounter: 0,
      recvCounter: 0,
      sessionKey
    });
  }
  return ratchetState.get(peerId);
}

function sendEncrypted(peerInfo, msg) {
  if (!peerInfo.sessionKey) return;
  const state = ensureRatchet(peerInfo.id, peerInfo.sessionKey);
  msg.nonce = state.sendCounter++;
  const encrypted = encryptMessage(state.sessionKey, JSON.stringify(msg));
  if (peerInfo.socket.readyState === WebSocket.OPEN) {
    peerInfo.socket.send(JSON.stringify({ type: "encrypted", payload: encrypted, nonce: msg.nonce }));
    log("secure", `Message chiffré envoyé à ${peerInfo.username}`);
  } else {
    bufferMessage(peerInfo.username, msg);
    log("warn", `Peer ${peerInfo.username} fermé, message bufferisé`);
  }
  ratchetState.set(peerInfo.id, state);
}


function bufferMessage(to, msg) {
  if (!messageBuffer.has(to)) messageBuffer.set(to, []);
  messageBuffer.get(to).push(msg);
  log("warn", `Message bufferisé pour ${to}`);
}

function sendBufferedMessages(to) {
  if (!messageBuffer.has(to)) return;
  const msgs = messageBuffer.get(to);
  const peer = Array.from(peers.values()).find(p => p.username === to);
  if (peer && peer.socket.readyState === WebSocket.OPEN) {
    msgs.forEach(m => sendEncrypted(peer, m));
    messageBuffer.delete(to);
    log("ok", `${msgs.length} messages bufferisés envoyés à ${to}`);
  }
}

/* =====================================================
   📡 TRACKER
===================================================== */
function handleTracker(msg) {
  if (msg.type === "peersUpdate" && Array.isArray(msg.payload)) {
    msg.payload.forEach(p => {
      if (p.id === peerId || peers.has(p.id) || pendingPeers.has(p.id)) return;
      if (peers.size >= MAX_PEERS) return;
      connectToPeer(p.id, p.address || "127.0.0.1", p.port);
      const peerInfo = peers.get(p.id);
      if (peerInfo) peerInfo.online = true;
    });
    for (const id of peers.keys()) {
      if (!msg.payload.find(p => p.id === id)) peers.get(id).online = false;
    }
    log("event", "Tracker update reçu", msg.payload.map(p => p.id));
  }
}

/* =====================================================
   🔌 CONNEXION PEER
===================================================== */
function connectToPeer(id, address, port) {
  if (!port) { log("error", `Cannot connect to peer ${id} - port undefined`); return; }
  if (address.includes(":") && !address.startsWith("[")) address = `[${address}]`;
  const url = `ws://${address}:${port}`;
  pendingPeers.add(id);

  const ws = new WebSocket(url);
  ws.on("open", () => {
    log("event", `Connected to peer ${id} at ${url}`);
    initPeerConnection(ws, true, id);
    pendingPeers.delete(id);
  });

  ws.on("error", err => {
    peers.delete(id);
    pendingPeers.delete(id);
    log("error", `Error connecting to peer ${id}: ${err.message}`);
  });
}

/* =====================================================
   📢 BROADCAST
===================================================== */
function broadcastToPeers(sender, text) {
  const msg = { type: "sendMessage", ts: Date.now(), data: { username: sender, text } };
  peers.forEach(p => {
    if (p.socket.readyState === WebSocket.OPEN) sendEncrypted(p, msg);
    else bufferMessage(p.username, msg);
  });
}

function broadcastToClient(sender, text) {
  if (clientSocket && clientSocket.readyState === WebSocket.OPEN) {
    const msg = { id: uuidv4(), type: "sendMessage", data: { username: sender, text }, date: new Date() };
    clientSocket.send(JSON.stringify(msg));
  }
}

/* =====================================================
   🌐 HTTP + WEBSOCKET SERVER
===================================================== */
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });
app.get("/", (req, res) => res.sendFile(join(__dirname, "index.html")));

wss.on("connection", ws => {
  ws.lastPong = Date.now();
  initPeerConnection(ws, false);
});

/* =====================================================
   🛰️ TRACKER CLIENT
===================================================== */
const tracker = new WebSocket(TRACKER_URL);
tracker.on("open", () => {
  log("ok", "Connected to tracker");
  tracker.send(JSON.stringify({ type: "register", payload: { id: peerId, port: APP_PORT, username } }));
});
tracker.on("message", msg => handleTracker(JSON.parse(msg.toString())));

/* =====================================================
   🕒 KEEPALIVE CLIENT
===================================================== */
setInterval(() => {
  if (clientSocket) {
    if (Date.now() - clientSocket.lastPong > 8000) {
      clientSocket.close();
      clientSocket = null;
    } else if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(JSON.stringify({ type: "ping" }));
    }
  }
}, 5000);

setInterval(printNetworkStatus, 15000);

setInterval(() => {
  peers.forEach((peer, id) => {
    rotateKeys(id);
  });
}, 5 * 60 * 1000);

/* =====================================================
   🚀 START SERVER
===================================================== */
server.listen(APP_PORT, () => log("ok", `Peer running on http://localhost:${APP_PORT}\\`));
