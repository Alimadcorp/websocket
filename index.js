const WebSocket = require("ws");
const express = require("express");
const http = require("http");

const port = 8392;
const LOG = false;
const PRODUCER_PASSWORD = "AlimadCo(10)";

const app = express();
const server = http.createServer(app);

const channels = new Map();
const clients = new Map();
const channelState = new Map(); // name -> {}
let producerSocket = null;

function logEvent(...args) { if (LOG) console.log(new Date().toISOString(), "-", ...args); }
function clientIP(req) { return (req.headers["x-forwarded-for"]?.split(",")[0].trim()) || req.socket.remoteAddress; }
function ensureChan(name) { if (!channels.has(name)) channels.set(name, new Set()); return channels.get(name); }
function ensureChanState(name) { if (!channelState.has(name)) channelState.set(name, {}); return channelState.get(name); }
function parseChannels(chField) {
  if (!chField) return [];
  if (typeof chField === "string" && chField.trim().startsWith("[")) {
    try { return JSON.parse(chField); } catch { return []; }
  }
  return Array.isArray(chField) ? chField : [String(chField)];
}
function subscribe(ws, name) { ensureChan(name).add(ws); clients.get(ws).subscriptions.add(name); }
function unsubscribe(ws, name) { const set = channels.get(name); if (!set) return; set.delete(ws); clients.get(ws).subscriptions.delete(name); if (!set.size) channels.delete(name); }
function broadcast(fromWs, chNames, payload) {
  const sent = new Set();
  for (const ch of chNames) {
    const set = channels.get(ch);
    if (!set) continue;
    for (const ws of set) {
      if (ws.readyState !== WebSocket.OPEN || sent.has(ws) || ws === fromWs) continue;
      sent.add(ws);
      ws.send(JSON.stringify({ type: "broadcast", from: clients.get(fromWs)?.ip, channel: ch, data: payload }));
    }
  }
}

const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  console.log("Raahhh");
  if (req.url === "/socket") {
    wss.handleUpgrade(req, socket, head, (ws) => handleProducer(ws, req));
  } else {
    wss.handleUpgrade(req, socket, head, (ws) => handleClient(ws, req));
  }
});

function handleProducer(ws, req) {
  ws.isProducer = false;
  ws.isAuthenticated = false;

  ws.on("message", (msgRaw) => {
    let msg;
    try { msg = JSON.parse(msgRaw.toString("utf8")); } catch { return; }
    if (msg.type === "auth") {
      if (msg.password === PRODUCER_PASSWORD) {
        ws.isProducer = true;
        ws.isAuthenticated = true;
        producerSocket = ws;
        ws.send(JSON.stringify({ type: "auth_ok", device: msg.device || null }));
        console.log("Producer authenticated:", msg.device || "unknown");
        return;
      } else {
        ws.send(JSON.stringify({ type: "auth_failed" }));
        ws.close();
        return;
      }
    }

    if (ws.isProducer && ws.isAuthenticated) {
      if (msg.type === "sample" || msg.type === "aggregate") {
        const broadcastMsg = JSON.stringify({ type: msg.type, data: msg.data });
        wss.clients.forEach((c) => { if (c !== ws && c.readyState === WebSocket.OPEN) c.send(broadcastMsg); });
      }
    }
  });

  ws.on("close", () => {
    if (ws === producerSocket) { producerSocket = null; console.log("Producer disconnected"); }
  });

  ws.send(JSON.stringify({ type: "welcome", role: "producer" }));
}

function handleClient(ws, req) {
  const ip = clientIP(req);
  clients.set(ws, { ip, subscriptions: new Set(), isAlive: true });
  logEvent("Connected:", ip);

  ws.on("pong", () => { const info = clients.get(ws); if (info) info.isAlive = true; });

  ws.on("message", (msgRaw) => {
    let m;
    try { m = JSON.parse(msgRawRaw); } catch { return ws.send(JSON.stringify({ type: "error", reason: "invalid-json" })); }
    const t = m.type;

    if (t === "ping") return ws.send(JSON.stringify({ type: "pong", time: new Date().toISOString(), id: m.id }));
    if (t === "connect" || t === "subscribe") { parseChannels(m.channel).forEach(ch => subscribe(ws, ch)); return ws.send(JSON.stringify({ type: "connected", subscribed: [...clients.get(ws).subscriptions] })); }
    if (t === "unsubscribe") { parseChannels(m.channel).forEach(ch => unsubscribe(ws, ch)); return ws.send(JSON.stringify({ type: "unsubscribed", subscribed: [...clients.get(ws).subscriptions] })); }
    if (t === "unsubscribe.all") { [...clients.get(ws).subscriptions].forEach(ch => unsubscribe(ws, ch)); return ws.send(JSON.stringify({ type: "unsubscribed.all" })); }
    if (t === "broadcast") { const chs = parseChannels(m.channel); if (!chs.length) return ws.send(JSON.stringify({ type: "error", reason: "no-channel" })); broadcast(ws, chs, m.data); return; }
    if (t === "state") {
      const chs = parseChannels(m.channel);
      if (!chs.length) return ws.send(JSON.stringify({ type: "error", reason: "no-channel" }));
      const result = {};
      for (const ch of chs) {
        const state = ensureChanState(ch);
        if (m.action === "add") Object.assign(state, typeof m.data === "object" && !Array.isArray(m.data) ? m.data : {}); 
        else if (m.action === "remove") (Array.isArray(m.data) ? m.data : []).forEach(k => delete state[k]);
        result[ch] = state;
      }
      return ws.send(JSON.stringify({ type: "state", action: m.action, result }));
    }
    ws.send(JSON.stringify({ type: "error", reason: "type-unknown" }));
  });

  ws.on("close", () => { const info = clients.get(ws); if (info) { [...info.subscriptions].forEach(ch => unsubscribe(ws, ch)); clients.delete(ws); logEvent("Disconnected:", ip); } });
  ws.on("error", (err) => logEvent("Error from", ip, err.message));

  ws.send(JSON.stringify({ type: "welcome", role: "client", ip }));
}

const interval = setInterval(() => {
  for (const [ws, info] of clients.entries()) {
    if (!info.isAlive) { logEvent("Terminating dead connection:", info.ip); ws.terminate(); clients.delete(ws); continue; }
    info.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(port, () => console.log("HTTP/WebSocket server listening on " + port));
