// index.js
const WebSocket = require('ws');
const port = 8392;
const wss = new WebSocket.Server({ port });
const channels = new Map();
const clients = new Map();

function clientIP(req) {
  const h = req.headers['x-forwarded-for'];
  if (h) return h.split(',')[0].trim();
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
  if (typeof chField === 'string' && chField.trim().startsWith('[')) {
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
      if (ws.readyState !== WebSocket.OPEN || sent.has(ws)) continue;
      sent.add(ws);
      ws.send(JSON.stringify({
        type: 'broadcast',
        from: clients.get(fromWs)?.ip,
        channel: ch,
        data: payload
      }));
    }
  }
}

function logEvent(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

wss.on('connection', (ws, req) => {
  const ip = clientIP(req);
  clients.set(ws, { ip, subscriptions: new Set(), isAlive: true });
  logEvent('Connected:', ip);

  ws.on('pong', () => {
    const info = clients.get(ws);
    if (info) info.isAlive = true;
  });

  ws.on('message', msg => {
    logEvent('Received from', ip, ':', msg.toString());
    let m;
    try { m = JSON.parse(msg); } catch {
      return ws.send(JSON.stringify({ type: 'error', reason: 'invalid-json' }));
    }
    const t = m.type;
    if (t === 'connect') {
      const chs = parseChannels(m.channel);
      chs.forEach(ch => subscribe(ws, ch));
      return ws.send(JSON.stringify({ type: 'connected', subscribed: [...clients.get(ws).subscriptions] }));
    }
    if (t === 'broadcast') {
      const chs = parseChannels(m.channel);
      if (!chs.length) return ws.send(JSON.stringify({ type: 'error', reason: 'no-channel' }));
      broadcast(ws, chs, m.data);
      return;
    }
    if (t === 'subscribe') {
      const chs = parseChannels(m.channel);
      chs.forEach(ch => subscribe(ws, ch));
      return ws.send(JSON.stringify({ type: 'subscribed', subscribed: [...clients.get(ws).subscriptions] }));
    }
    if (t === 'unsubscribe') {
      const chs = parseChannels(m.channel);
      chs.forEach(ch => unsubscribe(ws, ch));
      return ws.send(JSON.stringify({ type: 'unsubscribed', subscribed: [...clients.get(ws).subscriptions] }));
    }
    if (t === 'unsubscribeAll' || t === 'unsubscribe_all') {
      [...clients.get(ws).subscriptions].forEach(ch => unsubscribe(ws, ch));
      return ws.send(JSON.stringify({ type: 'unsubscribedAll' }));
    }
    ws.send(JSON.stringify({ type: 'error', reason: 'unknown-type' }));
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    if (info) {
      [...info.subscriptions].forEach(ch => unsubscribe(ws, ch));
      clients.delete(ws);
      logEvent('Disconnected:', ip);
    }
  });

  ws.on('error', err => logEvent('Error from', ip, err.message));
  ws.send(JSON.stringify({ type: 'welcome', ip }));
});

// ping clients every 30s to detect dead connections
const interval = setInterval(() => {
  for (const [ws, info] of clients.entries()) {
    if (!info.isAlive) {
      logEvent('Terminating dead connection:', info.ip);
      ws.terminate();
      clients.delete(ws);
      continue;
    }
    info.isAlive = false;
    ws.ping();
  }
}, 30000);

wss.on('close', () => clearInterval(interval));
console.log('WebSocket broadcast server ready on ws://127.0.0.1:' + port);
