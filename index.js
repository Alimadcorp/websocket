// index.js
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 3001 });
const channels = new Map(); // channel -> Set(ws)
const clients = new Map(); // ws -> { ip, subscriptions: Set }

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
  if (!channels.has(name)) return;
  channels.get(name).delete(ws);
  clients.get(ws).subscriptions.delete(name);
  if (channels.get(name).size === 0) channels.delete(name);
}

function parseChannelsField(chField) {
  if (!chField) return [];
  if (typeof chField === 'string' && chField.trim().startsWith('[')) {
    try { return JSON.parse(chField); } catch { return []; }
  }
  if (Array.isArray(chField)) return chField;
  return [String(chField)];
}

function broadcastToChannels(fromWs, chNames, payload) {
  const sent = new Set();
  chNames.forEach(ch => {
    const set = channels.get(ch);
    if (!set) return;
    set.forEach(clientWs => {
      if (clientWs.readyState !== WebSocket.OPEN) return;
      if (sent.has(clientWs)) return;
      sent.add(clientWs);
      const envelope = {
        type: 'broadcast',
        from: clients.get(fromWs).ip,
        channel: chNames,
        data: payload
      };
      clientWs.send(JSON.stringify(envelope));
    });
  });
}

wss.on('connection', (ws, req) => {
  const ip = clientIP(req);
  clients.set(ws, { ip, subscriptions: new Set() });
  ws.on('message', msg => {
    let m;
    try { m = JSON.parse(msg); } catch { return ws.send(JSON.stringify({ type: 'error', reason: 'invalid-json' })); }
    const t = m.type;
    if (t === 'connect') {
      const chs = parseChannelsField(m.channel);
      chs.forEach(ch => subscribe(ws, ch));
      ws.send(JSON.stringify({ type: 'connected', subscribed: [...clients.get(ws).subscriptions] }));
      return;
    }
    if (t === 'broadcast') {
      const chs = parseChannelsField(m.channel);
      if (chs.length === 0) return ws.send(JSON.stringify({ type: 'error', reason: 'no-channel' }));
      broadcastToChannels(ws, chs, m.data);
      return;
    }
    if (t === 'subscribe') {
      const chs = parseChannelsField(m.channel);
      chs.forEach(ch => subscribe(ws, ch));
      return ws.send(JSON.stringify({ type: 'subscribed', subscribed: [...clients.get(ws).subscriptions] }));
    }
    if (t === 'unsubscribe') {
      const chs = parseChannelsField(m.channel);
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
    }
  });

  ws.send(JSON.stringify({ type: 'welcome', ip }));
});

console.log('WebSocket broadcast server listening on ws://127.0.0.1:8080');
