const WebSocket = require("ws");
const express = require("express");
const http = require("http");

const app = express();
const port = 8392;
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

const clients = new Map();
const channels = new Map();
const channelState = new Map();
const LOG = false;
const PRODUCER_PASSWORD = "AlimadCo(10)";

let producerSocket = null;

function clientIP(req) {
  const h = req.headers["x-forwarded-for"];
  return h ? h.split(",")[0].trim() : req.socket.remoteAddress;
}

function logEvent(...args) {
  if (LOG) console.log(new Date().toISOString(), "-", ...args);
}

function ensureChan(name) {
  if (!channels.has(name)) channels.set(name, new Set());
  return channels.get(name);
}

function subscribe(ws, name) {
  ensureChan(name).add(ws);
  clients.get(ws).subscriptions.add(name);
}

function unsubscribe(ws, name) {
  const set = channels.get(name);
  if (!set) return;
  set.delete(ws);
  clients.get(ws).subscriptions.delete(name);
  if (set.size === 0) channels.delete(name);
}

function parseChannels(chField) {
  if (!chField) return [];
  if (typeof chField === "string" && chField.trim().startsWith("[")) {
    try { return JSON.parse(chField); } catch { return []; }
  }
  if (Array.isArray(chField)) return chField;
  return [String(chField)];
}

function broadcast(fromWs, chNames, payload) {
  const sent = new Set();
  for (const ch of chNames) {
    const set = channels.get(ch);
    if (!set) continue;
    for (const ws of set) {
      if (ws.readyState !== WebSocket.OPEN || sent.has(ws) || ws === fromWs) continue;
      sent.add(ws);
      ws.send(JSON.stringify({
        type: "broadcast",
        from: clients.get(fromWs)?.ip,
        channel: ch,
        data: payload,
      }));
    }
  }
}

function ensureChanState(name) {
  if (!channelState.has(name)) channelState.set(name, {});
  return channelState.get(name);
}

wss.on("connection", (ws, req) => {
  ws.isProducer = false;
  ws.isAuthenticated = false;

  const ip = clientIP(req);
  clients.set(ws, { ip, subscriptions: new Set(), isAlive: true });
  logEvent("Connected:", ip);
  ws.send(JSON.stringify({ type: "welcome", ip }));

  ws.on("pong", () => {
    const info = clients.get(ws);
    if (info) info.isAlive = true;
  });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return ws.send(JSON.stringify({ type: "error", reason: "invalid-json" })); }

    // --- Producer auth & broadcast ---
    if (msg.type === "auth") {
      if (msg.password === PRODUCER_PASSWORD) {
        ws.isProducer = true;
        ws.isAuthenticated = true;
        producerSocket = ws;
        ws.send(JSON.stringify({ type: "auth_ok", device: msg.device || null }));
        console.log("Producer authenticated:", msg.device || "unknown");
      } else {
        ws.send(JSON.stringify({ type: "auth_failed" }));
        ws.close();
      }
      return;
    }

    if (ws.isProducer && ws.isAuthenticated && (msg.type === "sample" || msg.type === "aggregate")) {
      const data = JSON.stringify({ type: msg.type, data: msg.data });
      for (const client of wss.clients) {
        if (client !== ws && client.readyState === WebSocket.OPEN) client.send(data);
      }
      return;
    }

    // --- Client messages ---
    const t = msg.type;
    const clientInfo = clients.get(ws);
    if (t === "ping") return ws.send(JSON.stringify({ type: "pong", time: new Date().toISOString(), id: msg.id }));
    if (t === "connect" || t === "subscribe") {
      const chs = parseChannels(msg.channel);
      chs.forEach(ch => subscribe(ws, ch));
      return ws.send(JSON.stringify({ type: t === "connect" ? "connected" : "subscribed", subscribed: [...clientInfo.subscriptions] }));
    }
    if (t === "unsubscribe") {
      const chs = parseChannels(msg.channel);
      chs.forEach(ch => unsubscribe(ws, ch));
      return ws.send(JSON.stringify({ type: "unsubscribed", subscribed: [...clientInfo.subscriptions] }));
    }
    if (t === "unsubscribe.all") {
      [...clientInfo.subscriptions].forEach(ch => unsubscribe(ws, ch));
      return ws.send(JSON.stringify({ type: "unsubscribed.all" }));
    }
    if (t === "broadcast") {
      const chs = parseChannels(msg.channel);
      if (!chs.length) return ws.send(JSON.stringify({ type: "error", reason: "no-channel" }));
      broadcast(ws, chs, msg.data);
      return;
    }
    if (t === "state") {
      const chs = parseChannels(msg.channel);
      if (!chs.length) return ws.send(JSON.stringify({ type: "error", reason: "no-channel" }));
      const action = msg.action;
      const result = {};
      for (const ch of chs) {
        const state = ensureChanState(ch);
        if (action === "add" && typeof msg.data === "object" && !Array.isArray(msg.data)) Object.assign(state, msg.data);
        if (action === "remove" && Array.isArray(msg.data)) msg.data.forEach(k => delete state[k]);
        result[ch] = state;
      }
      return ws.send(JSON.stringify({ type: "state", action, result }));
    }
    ws.send(JSON.stringify({ type: "error", reason: "type-unknown" }));
  });

  ws.on("close", () => {
    const info = clients.get(ws);
    if (info) {
      [...info.subscriptions].forEach(ch => unsubscribe(ws, ch));
      if (ws === producerSocket) producerSocket = null;
      clients.delete(ws);
      logEvent("Disconnected:", ip);
    }
  });

  ws.on("error", (err) => logEvent("Error from", ip, err.message));
});

const interval = setInterval(() => {
  for (const [ws, info] of clients.entries()) {
    if (!info.isAlive) { ws.terminate(); clients.delete(ws); logEvent("Terminating dead connection:", info.ip); continue; }
    info.isAlive = false;
    ws.ping();
  }
}, 30000);

server.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req)));

server.listen(port, () => console.log("Server listening on port " + port));
