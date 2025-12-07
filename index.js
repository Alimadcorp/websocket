// index.js
const WebSocket = require("ws");
const express = require("express");
const http = require("http");
const port = 8392;
const wss = new WebSocket.Server({ port });
const channels = new Map();
const clients = new Map();
const LOG = false;
const PRODUCER_PASSWORD = "AlimadCo(10)";

const app = express();
const server = http.createServer(app);

const wss2 = new WebSocket.Server({ noServer: true });
let producerSocket = null;

server.on("upgrade", (request, socket, head) => {
  if (request.url === "/socket") {
    wss2.handleUpgrade(request, socket, head, (ws) => {
      wss2.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss2.on("connection", (ws) => {
  ws.isProducer = false;
  ws.isAuthenticated = false;

  ws.on("message", (msgRaw) => {
    let msg;
    try { msg = JSON.parse(msgRaw.toString("utf8")); } 
    catch { return; }
    console.log(msg)

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
        const broadcast = JSON.stringify({ type: msg.type, data: msg.data });
        wss2.clients.forEach((c) => {
          if (c !== ws && c.readyState === WebSocket.OPEN) c.send(broadcast);
        });
      }
    }
  });

  ws.on("close", () => {
    if (ws === producerSocket) {
      producerSocket = null;
      console.log("Producer disconnected");
    }
  });
});

function clientIP(req) {
  const h = req.headers["x-forwarded-for"];
  if (h) return h.split(",")[0].trim();
  return req.socket.remoteAddress;
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
    try {
      return JSON.parse(chField);
    } catch {
      return [];
    }
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
      if (ws.readyState !== WebSocket.OPEN || sent.has(ws) || ws === fromWs)
        continue;
      sent.add(ws);
      ws.send(
        JSON.stringify({
          type: "broadcast",
          from: clients.get(fromWs)?.ip,
          channel: ch,
          data: payload,
        })
      );
    }
  }
}

function logEvent(...args) {
  if (!LOG) return;
  console.log(new Date().toISOString(), "-", ...args);
}

const channelState = new Map(); // name -> {}
function ensureChanState(name) {
  if (!channelState.has(name)) channelState.set(name, {});
  return channelState.get(name);
}

wss.on("connection", (ws, req) => {
  const ip = clientIP(req);
  clients.set(ws, { ip, subscriptions: new Set(), isAlive: true });
  logEvent("Connected:", ip);

  ws.on("pong", () => {
    const info = clients.get(ws);
    if (info) info.isAlive = true;
  });

  ws.on("message", (msg) => {
    logEvent("Received from", ip, ":", msg.toString());
    let m;
    try {
      m = JSON.parse(msg);
    } catch {
      return ws.send(JSON.stringify({ type: "error", reason: "invalid-json" }));
    }
    const t = m.type;
    if (t === "ping") {
      let r = { type: "pong", time: new Date().toISOString() };
      if (m.id) r.id = m.id;
      return ws.send(JSON.stringify(r));
    }
    if (t === "connect") {
      const chs = parseChannels(m.channel);
      chs.forEach((ch) => subscribe(ws, ch));
      return ws.send(
        JSON.stringify({
          type: "connected",
          subscribed: [...clients.get(ws).subscriptions],
        })
      );
    }
    if (t === "broadcast") {
      const chs = parseChannels(m.channel);
      if (!chs.length)
        return ws.send(JSON.stringify({ type: "error", reason: "no-channel" }));
      broadcast(ws, chs, m.data);
      return;
    }
    if (t === "subscribe") {
      const chs = parseChannels(m.channel);
      chs.forEach((ch) => subscribe(ws, ch));
      return ws.send(
        JSON.stringify({
          type: "subscribed",
          subscribed: [...clients.get(ws).subscriptions],
        })
      );
    }
    if (t === "unsubscribe") {
      const chs = parseChannels(m.channel);
      chs.forEach((ch) => unsubscribe(ws, ch));
      return ws.send(
        JSON.stringify({
          type: "unsubscribed",
          subscribed: [...clients.get(ws).subscriptions],
        })
      );
    }
    if (t === "unsubscribe.all") {
      [...clients.get(ws).subscriptions].forEach((ch) => unsubscribe(ws, ch));
      return ws.send(JSON.stringify({ type: "unsubscribed.all" }));
    }
    if (t === "state") {
      const chs = parseChannels(m.channel);
      if (!chs.length) {
        return ws.send(JSON.stringify({ type: "error", reason: "no-channel" }));
      }
      const mode = m.action; // add, remove, get
      const result = {};
      for (const ch of chs) {
        const state = ensureChanState(ch);

        if (mode === "add") {
          const data =
            typeof m.data === "object" && !Array.isArray(m.data) ? m.data : {};
          Object.assign(state, data);
          result[ch] = state;
        } else if (mode === "remove") {
          const arr = Array.isArray(m.data) ? m.data : [];
          for (const key of arr) delete state[key];
          result[ch] = state;
        } else if (mode === "get") {
          result[ch] = state;
        } else {
          return ws.send(
            JSON.stringify({ type: "error", reason: "invalid-state-action" })
          );
        }
      }
      return ws.send(JSON.stringify({ type: "state", action: mode, result }));
    }
    ws.send(JSON.stringify({ type: "error", reason: "type-unknown" }));
  });

  ws.on("close", () => {
    const info = clients.get(ws);
    if (info) {
      [...info.subscriptions].forEach((ch) => unsubscribe(ws, ch));
      clients.delete(ws);
      logEvent("Disconnected:", ip);
    }
  });

  ws.on("error", (err) => logEvent("Error from", ip, err.message));
  ws.send(JSON.stringify({ type: "welcome", ip }));
});

const interval = setInterval(() => {
  for (const [ws, info] of clients.entries()) {
    if (!info.isAlive) {
      logEvent("Terminating dead connection:", info.ip);
      ws.terminate();
      clients.delete(ws);
      continue;
    }
    info.isAlive = false;
    ws.ping();
  }
}, 30000);

wss.on("close", () => clearInterval(interval));
server.listen(port, () => console.log("HTTP/WebSocket server listening on " + port));
console.log("WebSocket broadcast server ready on port " + port);
