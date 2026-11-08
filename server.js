// vless-voroa-in: minimal VLESS over WebSocket proxy server for Voroa.
//
// Adapted from ../vless-wasmer-us/server.js (same zero-dependency Node code).
// Voroa-specific changes (see round-4 report):
//   1. Deployed via Dockerfile (Voroa Docker runtime) — Dockerfile services
//      never idle-sleep, even on the free Nano plan.
//   2. Server sends a WebSocket ping every 30 s: Voroa's edge closes a WS
//      connection after ~100 s with no data, so the ping (and the client's
//      automatic pong) keeps the connection alive.
//
// Zero dependencies: only Node built-ins (http, net, crypto).
// Voroa docs used: https://getvoroa.com/docs/websockets/ (public inbound WS,
// no max connection duration, ~100 s idle close) and
// https://getvoroa.com/docs/idle-sleep/ (Dockerfile services never sleep).
//
// Configuration is ONLY via environment variables (the repo is public):
//   VLESS_UUID  - the VLESS user UUID (required for proxying)
//   WS_PATH     - the WebSocket path, e.g. /<16 lowercase hex chars> (required)
//   PORT        - listen port (default 80)
// Without VLESS_UUID/WS_PATH the server still starts and answers
// GET / with 200 ok (health check) but refuses every WebSocket upgrade.
//
// Endpoints (listen 0.0.0.0:$PORT):
//   GET /        -> 200 "ok"
//   WS upgrade to WS_PATH -> VLESS over WebSocket, TCP only (command 1)
//   anything else -> 404
//
// UDP (VLESS command 2) is NOT supported: the sandbox used for local
// verification blocks all UDP sends (dgram send -> EPERM, even to
// 127.0.0.1), so no UDP implementation could be verified end to end, and
// it is deliberately left out rather than shipped unverified. A client
// that sends command 2 gets its session closed. Impact: UDP traffic
// (e.g. DNS over UDP, QUIC, VoIP) through this node fails; TCP browsing
// is unaffected.
//
// Logs contain no secrets: only a startup line and connection counters.

'use strict';

const http = require('http');
const net = require('net');
const crypto = require('crypto');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CONNECT_TIMEOUT_MS = 5000;
const IDLE_TIMEOUT_MS = 300000; // 5 min idle on an established proxy session
const WS_PING_INTERVAL_MS = 30000; // Voroa edge closes WS after ~100 s idle
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

const port = parsePort(process.env.PORT) || 80;
const VLESS_UUID = (process.env.VLESS_UUID || '').trim().toLowerCase();
const WS_PATH = (process.env.WS_PATH || '').trim();
const configured = isValidUuid(VLESS_UUID) && WS_PATH.startsWith('/') && WS_PATH.length > 1;
const UUID_BYTES = configured ? Buffer.from(VLESS_UUID.replace(/-/g, ''), 'hex') : null;

let sessionCount = 0;
let activeSessions = 0;

function parsePort(v) {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

function isValidUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
}

function sendText(res, status, body) {
  const reason = { 200: 'OK', 404: 'Not Found' }[status] || 'OK';
  res.writeHead(status, {
    'Content-Type': 'text/plain',
    'Content-Length': Buffer.byteLength(body),
    'Connection': 'close',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/') {
    sendText(res, 200, 'ok\n');
    return;
  }
  // Any other plain HTTP request: 404. The WS path is not distinguishable
  // from any other path here (no Upgrade header -> no proxy).
  sendText(res, 404, 'not found\n');
});

// --- WebSocket upgrade handling (RFC 6455) ---------------------------------

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (!configured || url.pathname !== WS_PATH) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 10\r\n\r\nnot found\n');
    socket.destroy();
    return;
  }
  const upgrade = (req.headers.upgrade || '').toLowerCase();
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];
  if (upgrade !== 'websocket' || !key || version !== '13') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 12\r\n\r\nbad request\n');
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  startVlessSession(socket, head);
});

// --- VLESS session ----------------------------------------------------------

function startVlessSession(socket, head) {
  sessionCount += 1;
  activeSessions += 1;
  const id = sessionCount;
  console.error(`session ${id} start (active: ${activeSessions})`);
  let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  let msg = Buffer.alloc(0);
  let msgOpcode = 0;
  let destroyed = false;
  let pingTimer = null;   // 30 s WS ping, keeps Voroa edge from idle-closing
  let target = null;      // net.Socket for TCP
  let headerParsed = false;
  let command = 0;

  socket.setTimeout(IDLE_TIMEOUT_MS);
  socket.on('timeout', () => destroyAll());
  socket.on('error', () => destroyAll());
  socket.on('close', () => destroyAll());
  // Sockets detached by the HTTP 'upgrade' event emit 'end' when the peer
  // sends FIN but may not emit 'close' until we close our side too, so
  // treat 'end' as session end as well.
  socket.on('end', () => destroyAll());

  // Voroa: send a WS ping every 30 s so the edge (~100 s idle close) never
  // drops a quiet session; the client answers with pong automatically.
  pingTimer = setInterval(() => {
    if (!destroyed) sendFrame(true, 9, Buffer.alloc(0));
  }, WS_PING_INTERVAL_MS);
  if (pingTimer.unref) pingTimer.unref();

  function destroyAll() {
    if (destroyed) return;
    destroyed = true;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    try { if (target) target.destroy(); } catch (_) { /* ignore */ }
    try { socket.destroy(); } catch (_) { /* ignore */ }
    activeSessions -= 1;
    console.error(`session ${id} end (active: ${activeSessions})`);
  }

  // Server frames are never masked. Lengths 126/127 supported.
  function sendFrame(fin, opcode, payload) {
    if (destroyed) return false;
    const header = [];
    header.push((fin ? 0x80 : 0x00) | (opcode & 0x0f));
    const len = payload.length;
    if (len < 126) {
      header.push(len);
    } else if (len <= 0xffff) {
      header.push(126, (len >> 8) & 0xff, len & 0xff);
    } else {
      const b = Buffer.alloc(8);
      b.writeBigUInt64BE(BigInt(len));
      header.push(127, ...b);
    }
    try {
      socket.write(Buffer.concat([Buffer.from(header), payload]));
      return true;
    } catch (_) {
      return false;
    }
  }

  function sendBinary(payload) {
    return sendFrame(true, 2, payload);
  }

  function closeWs() {
    if (destroyed) return;
    try { sendFrame(true, 8, Buffer.alloc(0)); } catch (_) { /* ignore */ }
    destroyAll();
  }

  function pump() {
    if (destroyed) return;
    while (true) {
      if (buf.length < 2) return; // need more data
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (!Number.isSafeInteger(len) || len > MAX_FRAME_BYTES) { destroyAll(); return; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return; // need more data
      let payload = buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      buf = buf.subarray(off + maskLen + len);

      if (opcode === 8) { // close
        closeWs();
        return;
      } else if (opcode === 9) { // ping -> pong
        if (!sendFrame(true, 10, payload)) return;
      } else if (opcode === 10) { // pong: ignore
      } else if (opcode === 1 || opcode === 2) { // data start
        if (msg.length === 0) msgOpcode = opcode;
        msg = Buffer.concat([msg, payload]);
        if (msg.length > MAX_MESSAGE_BYTES) { destroyAll(); return; }
        if (fin && !handleMessage(msg)) return;
        if (fin) msg = Buffer.alloc(0);
      } else if (opcode === 0) { // continuation
        msg = Buffer.concat([msg, payload]);
        if (msg.length > MAX_MESSAGE_BYTES) { destroyAll(); return; }
        if (fin && !handleMessage(msg)) return;
        if (fin) msg = Buffer.alloc(0);
      } else { // reserved opcode
        destroyAll();
        return;
      }
    }
  }

  // Returns false when the session must end.
  function handleMessage(data) {
    if (!headerParsed) {
      headerParsed = true;
      const parsed = parseVlessHeader(data);
      if (!parsed) { destroyAll(); return false; }
      command = parsed.command;
      if (command === 1) {
        startTcp(parsed);
      } else {
        // Command 2 (UDP) and anything else: not supported, close session.
        destroyAll();
        return false;
      }
      return true;
    }
    // Subsequent messages: payload for the established TCP target.
    if (command === 1 && target) {
      try { target.write(data); } catch (_) { destroyAll(); return false; }
    }
    return true;
  }

  // VLESS header: ver(1) uuid(16) addonLen(1) addon(M) cmd(1) port(2)
  // addrType(1) addr(var) payload(rest). Returns null on any failure.
  function parseVlessHeader(data) {
    try {
      if (data.length < 1 + 16 + 1 + 1 + 2 + 1 + 1) return null;
      if (data[0] !== 0) return null; // only version 0 accepted
      if (!data.subarray(1, 17).equals(UUID_BYTES)) return null;
      const addonLen = data[17];
      let off = 18 + addonLen;
      if (data.length < off + 1 + 2 + 1) return null;
      const cmd = data[off];
      off += 1;
      const targetPort = data.readUInt16BE(off);
      off += 2;
      const addrType = data[off];
      off += 1;
      let host;
      let family = 4;
      if (addrType === 1) { // IPv4
        if (data.length < off + 4) return null;
        host = Array.from(data.subarray(off, off + 4)).join('.');
        off += 4;
      } else if (addrType === 2) { // domain
        if (data.length < off + 1) return null;
        const domainLen = data[off];
        off += 1;
        if (domainLen === 0 || data.length < off + domainLen) return null;
        host = data.subarray(off, off + domainLen).toString('utf8');
        off += domainLen;
        if (!/^[A-Za-z0-9.-]+$/.test(host)) return null;
      } else if (addrType === 3) { // IPv6
        if (data.length < off + 16) return null;
        const parts = [];
        for (let i = 0; i < 16; i += 2) parts.push(data.readUInt16BE(off + i).toString(16));
        host = parts.join(':');
        off += 16;
        family = 6;
      } else {
        return null;
      }
      if (targetPort < 1 || targetPort > 65535) return null;
      const payload = data.subarray(off);
      return { command: cmd, host, port: targetPort, family, payload };
    } catch (_) {
      return null;
    }
  }

  function startTcp(parsed) {
    target = net.connect({
      host: parsed.host,
      port: parsed.port,
      timeout: CONNECT_TIMEOUT_MS,
    });
    target.on('timeout', () => destroyAll());
    target.on('error', () => destroyAll());
    target.on('close', () => destroyAll());
    target.on('end', () => destroyAll());
    target.on('connect', () => {
      // VLESS response header: version 0, addon length 0.
      if (!sendBinary(Buffer.from([0x00, 0x00]))) return;
      if (parsed.payload.length) {
        try { target.write(parsed.payload); } catch (_) { destroyAll(); }
      }
    });
    target.on('data', (chunk) => {
      if (!sendBinary(chunk)) destroyAll();
    });
  }

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    pump();
  });
  pump();
}

server.on('error', (err) => {
  console.error('server error:', err);
  process.exit(1);
});

server.listen(port, '0.0.0.0', () => {
  console.error(`vless-voroa-in listening on 0.0.0.0:${port} (configured: ${configured ? 'yes' : 'no'})`);
});
