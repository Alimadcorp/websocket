const WebSocket = require("ws");
const express = require("express");
const http = require("http");

const port = 8392;
const LOG = false;
const PRODUCER_PASSWORD = process.env.LOG_PASSWORD;
const SLACK_TOKEN = process.env.SLACK_TOKEN;
const app = express();
const server = http.createServer(app);
let lastIcon = {};
let lastActivity = {};
let actConnected = [];
let actAuthed = [];

function prettyDate(d) {
  const now = new Date();
  const days = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  const pad = (n) => n.toString().padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  const isSameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  if (isSameDay(d, now)) return `Today at ${time}`;

  if (isSameDay(d, yesterday)) return `Yesterday at ${time}`;

  const diffYears = now.getFullYear() !== d.getFullYear();

  if (!diffYears) {
    const diffDays = Math.floor((now - d) / 86400000);
    if (diffDays < 7) return `${days[d.getDay()]} at ${time}`;
    return `${months[d.getMonth()]} ${pad(d.getDate())} at ${time}`;
  }

  return `${months[d.getMonth()]} ${pad(
    d.getDate()
  )}, ${d.getFullYear()} at ${time}`;
}

const appMap = {
  chrome: ":chrome:",
  code: ":vsc:",
  discord: ":discord:",
  "whatsapp.root": ":whatsapp:",
  slack: ":slack:",
  windowsterminal: ":terminal:",
  explorer: ":file-explorer:",
  searchhost: ":windows11:",
  shellhost: ":windows11:",
  spotify: ":spotify_logo:",
  idman: ":idman:",
  zoom: ":zoom-new:",
  notepad: ":tw_spiral_note_pad:",
  githubdesktop: ":github:",
  blender: ":blender:",
  processing: ":processing:",
  applicationframehost: ":settings:",
  javaw: ":minecraft:",
};

let lastSent = { text: "", emoji: "" };
let lastRun = 0;
let pending = null;

function setStatus(dat, must = false) {
  pending = dat;
  const now = Date.now();
  if (now - lastRun < 10_000 && !must) return;
  lastRun = now;
  flushStatus();
}

function cleanUtf8(str) {
  if (!str) return "";
  return Buffer.from(str, "utf8")
    .toString("utf8")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function flushStatus() {
  if (!pending) return;

  const { windowName, status } = pending;
  pending = null;

  const emoji = appMap[windowName?.toLowerCase()] || ":discord-online:";
  console.log(emoji, windowName?.toLowerCase());

  if (lastSent.text === status && lastSent.emoji === emoji) {
    LOG && console.log("[slack] skipped (unchanged)", { status, emoji });
    return;
  }

  LOG && console.log("[slack] setting", { status, emoji });

  const safeStatus = cleanUtf8(status);
  const safeEmoji = cleanUtf8(emoji);

  try {
    let r = await fetch("https://slack.com/api/users.profile.set", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SLACK_TOKEN}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        profile: {
          status_text: safeStatus,
          status_emoji: safeEmoji,
          status_expiration: Math.floor(Date.now() / 1000) + 55,
        },
      }),
    });

    let b = await r.json();
    LOG && console.log("[Slack] status", b);

    lastSent = { text: safeStatus, emoji: safeEmoji };
  } catch (e) {
    console.error("[slack] failed", e);
  }
}

const channels = new Map();
const clients = new Map();
const channelState = new Map(); // name -> {}
let producerSocket = [];

const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/socket") {
    wss.handleUpgrade(req, socket, head, (ws) => handleProducer(ws, req));
  } else {
    wss.handleUpgrade(req, socket, head, (ws) => handleClient(ws, req));
  }
});

function handleProducer(ws, req) {
  function clientCount() {
    let n = 0;
    wss.clients.forEach((c) => {
      if (!c.isAuthenticated && c.readyState === WebSocket.OPEN) n++;
    });
    return n;
  }
  ws.isProducer = false;
  ws.isAuthenticated = false;
  ws.produceSub = true;
  ws.synced = false;
  ws.device = "";
  const ip = clientIP(req).replaceAll('"', "");
  actConnected.push(ip);
  ws.ipA = ip;
  ws.send(
    JSON.stringify({
      type: "init",
      devices: producerSocket,
      data: lastActivity,
    })
  );
  wss.clients.forEach((c) => {
    if (c.produceSub && c.readyState === WebSocket.OPEN) {
      c.send(
        JSON.stringify({
          type: "new",
          clients: clientCount(),
        })
      );
    }
  });

  ws.on("message", (msgRaw) => {
    let msg;
    try {
      msg = JSON.parse(msgRaw.toString("utf8"));
    } catch {
      return;
    }
    if (
      (msg.device && msg.device != "ALIMAD-PC") ||
      (msg.data?.device && msg.data.device != "ALIMAD-PC")
    )
    console.log(JSON.stringify(msg));
    if (msg.type === "auth") {
      if (msg.password === PRODUCER_PASSWORD) {
        ws.isProducer = true;
        ws.isAuthenticated = true;
        ws.produceSub = false;
        ws.device = msg.device;
        producerSocket.push(msg.device);
        actAuthed.push(ip);
        ws.send(
          JSON.stringify({ type: "auth_ok", device: msg.device || null })
        );
        return;
      } else {
        ws.send(JSON.stringify({ type: "auth_failed" }));
        ws.close();
        return;
      }
    }

    if (ws.isProducer && ws.isAuthenticated && msg.type === "screenshot") {
      const broadcastMsg = {
        type: "screenshot",
        data: msg.data,
        device: ws.device,
        timestamp: new Date(),
      };

      wss.clients.forEach((c) => {
        if (c !== ws && !c.isAuthenticated && c.readyState === WebSocket.OPEN) {
          c.send(JSON.stringify(broadcastMsg));
        }
      });
    }

    if (msg.type == "request") {
      wss.clients.forEach((c) => {
        if (
          c.device == msg.device &&
          c.isAuthenticated &&
          c.readyState === WebSocket.OPEN
        ) {
          c.send(JSON.stringify({ type: "request", device: msg.device }));
        }
      });
    }

    if (ws.isProducer && ws.isAuthenticated) {
      if (msg.type === "sample" || msg.type === "aggregate") {
        msg.data.ip = ip;
        msg.data.device = ws.device;
        if (msg.data.icon && msg.data.icon.trim() && msg.data.icon != "none") {
          lastIcon[ws.device] = msg.data.icon;
        }

        const broadcastMsg = { type: msg.type, data: { ...msg.data } };
        let la = broadcastMsg.data;
        la.timestamp = new Date();
        lastActivity[ws.device] = la;
        if (ws.device == "ALIMAD-PC") {
          setStatus({ windowName: msg.data.app, status: msg.data.title });
        }
        wss.clients.forEach((c) => {
          if (c !== ws && c.readyState === WebSocket.OPEN) {
            if (!c.synced) {
              broadcastMsg.data.icon = lastIcon[ws.device];
              broadcastMsg.synced = true;
              broadcastMsg.online = producerSocket;
              c.synced = true;
            } else {
              delete broadcastMsg.data.icon;
            }
            c.send(JSON.stringify(broadcastMsg));
          }
        });
      }
    }
  });

  ws.on("close", () => {
    if (producerSocket.includes(ws.device)) {
      producerSocket = producerSocket.filter((e) => e != ws.device);
      actAuthed = actAuthed.filter((e) => ws.ipA != e);
      if (ws.device == "ALIMAD-PC") {
        let la = lastActivity["ALIMAD-PC"];
        setStatus(
          {
            windowName: "offline",
            status: "Last seen " + prettyDate(la.timestamp) + " on " + la.title,
          },
          true
        );
      }
      wss.clients.forEach((c) => {
        if (c.produceSub && c.readyState === WebSocket.OPEN) {
          c.send(
            JSON.stringify({
              type: "offline",
              data: lastActivity,
              device: ws.device,
            })
          );
        }
      });
    }
    actConnected = actConnected.filter((e) => ws.ipA != e);
    wss.clients.forEach((c) => {
      if (c.produceSub && c.readyState === WebSocket.OPEN) {
        c.send(
          JSON.stringify({
            type: "new",
            clients: clientCount(),
          })
        );
      }
    });
  });

  ws.send(JSON.stringify({ type: "welcome", role: "producer" }));
}

function logEvent(...args) {
  if (LOG) console.log(new Date().toISOString(), "-", ...args);
}
function clientIP(req) {
  return (
    JSON.stringify(req.headers["x-forwarded-for"]) ||
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.socket.remoteAddress
  );
}
function ensureChan(name) {
  if (!channels.has(name)) channels.set(name, new Set());
  return channels.get(name);
}
function ensureChanState(name) {
  if (!channelState.has(name)) channelState.set(name, {});
  return channelState.get(name);
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
  return Array.isArray(chField) ? chField : [String(chField)];
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
  if (!set.size) channels.delete(name);
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

function handleClient(ws, req) {
  const ip = clientIP(req);
  clients.set(ws, { ip, subscriptions: new Set(), isAlive: true });
  logEvent("Connected:", ip);

  ws.on("pong", () => {
    const info = clients.get(ws);
    if (info) info.isAlive = true;
  });

  ws.on("message", (msgRaw) => {
    let m;
    try {
      m = JSON.parse(msgRawRaw);
    } catch {
      return ws.send(JSON.stringify({ type: "error", reason: "invalid-json" }));
    }
    const t = m.type;

    if (t === "ping")
      return ws.send(
        JSON.stringify({
          type: "pong",
          time: new Date().toISOString(),
          id: m.id,
        })
      );
    if (t === "connect" || t === "subscribe") {
      parseChannels(m.channel).forEach((ch) => subscribe(ws, ch));
      return ws.send(
        JSON.stringify({
          type: "connected",
          subscribed: [...clients.get(ws).subscriptions],
        })
      );
    }
    if (t === "unsubscribe") {
      parseChannels(m.channel).forEach((ch) => unsubscribe(ws, ch));
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
    if (t === "broadcast") {
      const chs = parseChannels(m.channel);
      if (!chs.length)
        return ws.send(JSON.stringify({ type: "error", reason: "no-channel" }));
      broadcast(ws, chs, m.data);
      return;
    }
    if (t === "state") {
      const chs = parseChannels(m.channel);
      if (!chs.length)
        return ws.send(JSON.stringify({ type: "error", reason: "no-channel" }));
      const result = {};
      for (const ch of chs) {
        const state = ensureChanState(ch);
        if (m.action === "add")
          Object.assign(
            state,
            typeof m.data === "object" && !Array.isArray(m.data) ? m.data : {}
          );
        else if (m.action === "remove")
          (Array.isArray(m.data) ? m.data : []).forEach((k) => delete state[k]);
        result[ch] = state;
      }
      return ws.send(
        JSON.stringify({ type: "state", action: m.action, result })
      );
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

  ws.send(JSON.stringify({ type: "welcome", role: "client", ip }));
}

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

server.listen(port, () =>
  console.log("HTTP/WebSocket server listening on " + port)
);
