'use strict';

/*
 * End-to-end tests for dsh-rpc. The CLI is spawned as a child process and talks
 * to a tiny in-process mock of the dsh /api bridge (HTTP RPC + RFC6455 WebSocket
 * mux at /api/remote.mux), so no real dsh server is required and the script
 * keeps its module-system-agnostic property (we never require() it directly).
 *
 * The mock enforces what the real dsh 0.1.2+ server enforces:
 *   - browser-auth cookie on every request (same HMAC the web UI uses;
 *     the test secret rides DSH_AUTH_SECRET into the CLI)
 *   - slashed /api/<namespace>/<method> endpoints with payload {args}
 *   - stream-only state via the mux (workspace/follow baseline,
 *     session/follow snapshot)
 *
 * Run with: npm test   (node --test test/)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const CLI = path.join(__dirname, '..', 'dsh-rpc');

// Shared browser-auth signing secret for the whole test run; the CLI receives
// it via DSH_AUTH_SECRET and the mock independently mints/validates cookies
// with it, so the full signing path is exercised without touching ~/.dsh.
const TEST_SECRET = crypto.randomBytes(32).toString('base64url');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

// Mint the cookie the real server would expect from this authority+secret —
// mock-side mirror of dsh-rpc's wsCookie() and dsh's browser-auth.
function cookieNameFor(authority) {
  return 'dsh-auth-' + b64url(crypto.createHash('sha256').update(authority).digest());
}

function verifyBrowserAuth(cookieHeader, authority) {
  const pairs = String(cookieHeader || '').split(';').map((s) => s.trim()).filter(Boolean);
  const expectName = cookieNameFor(authority);
  const pair = pairs.find((p) => p.startsWith(expectName + '='));
  if (!pair) return 'no dsh-auth cookie';
  const value = pair.slice(expectName.length + 1);
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return 'cookie value is not v1.<body>.<sig>';
  const [, body, sig] = parts;
  const expectedSig = b64url(crypto.createHmac('sha256', Buffer.from(TEST_SECRET, 'base64url')).update(body).digest());
  if (parts[2] !== expectedSig) return 'cookie signature mismatch';
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'));
  } catch {
    return 'cookie payload is not JSON';
  }
  if (payload.version !== 1 || payload.authority !== authority) return 'cookie/authority mismatch';
  if (!(typeof payload.issuedAt === 'number' && typeof payload.expiresAt === 'number')) return 'cookie missing timestamps';
  return null; // authenticated
}

// handler(record) -> RPC result ({ ok:true, value } | { ok:false, error })
// record = { url, method, args, rpcId, headers }; method = '<ns>/<m>'.
// Returning HANG leaves the request open (never responds) to simulate a hung server.
// Returning { $full: <object> } serves that object verbatim as the response body
// (used to simulate a malformed/mismatched RPC envelope).
// Returning { $status: 401, text: '…' } serves a bare HTTP failure.
const HANG = Symbol('hang');

// mux(frame, send) — called for every {type:'open'} on /api/remote.mux.
// frame = { type:'open', streamId, endpoint, payload } and send(obj) writes a
// server frame ({type:'item'|'error'|'end', streamId, …}) as JSON text.
function startMock(handler, muxHandler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      // Browser-auth gate, like the real 0.1.2+ server: reject before routing.
      const authError = verifyBrowserAuth(req.headers.cookie, req.headers.host);
      if (authError) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized', detail: authError }));
        return;
      }
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let reqData = {};
        try { reqData = JSON.parse(body || '{}'); } catch { reqData = {}; }
        const record = {
          url: req.url,
          method: typeof req.url === 'string' ? req.url.replace(/^\/api\//u, '') : undefined,
          args: reqData.payload && reqData.payload.args,
          rpcId: reqData.rpcId,
          headers: req.headers,
        };
        let result;
        try {
          result = handler(record);
          if (result === undefined) {
            // Task runs default to workspace-write, so every run/prompt/fork
            // mock sees a /permission commands/execute first; accept it unless
            // the test explicitly intercepts the endpoint.
            result = record.method === 'commands/execute'
              ? { ok: true, value: { result: { kind: 'success', text: 'ok' } } }
              : { ok: true, value: null };
          } else if (record.method === 'commands/execute'
            && result && result.ok === true && result.value === null) {
            // A test that didn't model /permission still gets a realistic
            // success (the default workspace-write flow calls it).
            result = { ok: true, value: { result: { kind: 'success', text: 'ok' } } };
          }
        } catch (e) {
          result = { ok: false, error: { code: 'mock', message: String((e && e.message) || e) } };
        }
        if (result === HANG) return; // leave the socket open — simulates a hung server
        if (result && result.$status) {
          res.writeHead(result.$status, { 'content-type': 'application/json' });
          res.end(result.text || 'unauthorized');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        if (result && result.$full) {
          res.end(JSON.stringify(result.$full)); // verbatim body (envelope-mismatch tests)
          return;
        }
        res.end(JSON.stringify({ type: 'server-response', rpcId: reqData.rpcId, result }));
      });
    });

    // Minimal RFC6455 server: accepts undici WebSocket upgrades on the mux path
    // and exchanges JSON text frames ("open"/"cancel" in, "item"/"error"/"end" out).
    server.on('upgrade', (req, socket) => {
      const key = req.headers['sec-websocket-key'];
      if (req.url !== '/api/remote.mux' || !key) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }
      const authError = verifyBrowserAuth(req.headers.cookie, req.headers.host);
      if (authError) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const accept = crypto.createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      // The CLI may close abruptly right after its command ends (undici can RST
      // half-open upgrade sockets); never let that crash the test process.
      socket.on('error', () => socket.destroy());
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        buffer = drainFrames(buffer, (opcode, payload) => {
          if (opcode === 8) { // close
            socket.write(closeFrame());
            socket.end();
            return;
          }
          if (opcode === 10) return; // pong (unsolicited here)
          if (opcode === 9) { // ping → pong
            socket.write(controlFrame(10, Buffer.alloc(0)));
            return;
          }
          if (opcode !== 1 || !muxHandler) return;
          let frame;
          try { frame = JSON.parse(payload.toString('utf8')); } catch { return; }
          const send = (obj) => {
            if (socket.destroyed) return;
            const data = Buffer.from(JSON.stringify(obj), 'utf8');
            const len = data.length;
            let header;
            if (len < 126) { header = Buffer.from([0x81, len]); }
            else if (len < 65536) {
              header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
            } else {
              header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
            }
            socket.write(Buffer.concat([header, data]));
          };
          if (frame.type === 'open') {
            ensureClosedOnCancel(socket, frame.streamId, send);
            muxHandler(frame, send);
          } else if (frame.type === 'cancel') {
            send({ type: 'end', streamId: frame.streamId });
          }
        });
      });
    });

    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// Workaround-friendly no-op: our mux mock answers each open with one item, so
// streams self-terminate from the client's perspective (it sends cancel after
// the first item; 'end' races harmlessly).
function ensureClosedOnCancel(socket, streamId, send) { /* baseline/snapshot single-shot */ }

function drainFrames(buf, onFrame) {
  for (;;) {
    if (buf.length < 2) return buf;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return buf;
      len = buf.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return buf;
      len = Number(buf.readBigUInt64BE(2)); off = 10;
    }
    if (buf.length < off + (masked ? 4 : 0) + len) return buf;
    let payload = buf.subarray(off + (masked ? 4 : 0), off + (masked ? 4 : 0) + len);
    if (masked) {
      const mask = buf.subarray(off, off + 4);
      const un = Buffer.from(payload);
      for (let i = 0; i < un.length; i++) un[i] ^= mask[i % 4];
      payload = un;
    }
    onFrame(opcode, payload);
    buf = buf.subarray(off + (masked ? 4 : 0) + len);
  }
}

function closeFrame() {
  return controlFrame(8, Buffer.alloc(0));
}

function controlFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[0] = 0x80 | opcode; header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}

function maskClientFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[0] = 0x81; header[1] = 0x80 | len; }
  else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        DSH_POLL_MS: '10',
        DSH_AUTH_SECRET: TEST_SECRET,
        ...env,
      },
    });
    let out = '';
    let err = '';
    cp.stdout.on('data', (d) => (out += d));
    cp.stderr.on('data', (d) => (err += d));
    cp.on('close', (code, signal) => resolve({ code, signal, out, err }));
  });
}

const ok = (value) => ({ ok: true, value });
const wksp = (wsId, title, sessionIds) => ({ workspaceId: wsId, title, path: process.cwd(), sessionIds: sessionIds || [] });

// Follow-snapshot record builders matching the dsh 0.1.2 wire (event entries).
const ev = (event) => ({ type: 'event', event });
const snapshot = (events, projections) => ({
  type: 'snapshot', header: {}, cursor: 0, records: events.map(ev), hasMore: false,
  projections: projections || { values: {} },
});
// workspace/follow baseline item.
const baseline = (items) => ({ type: 'baseline', value: { items, archivedSessionIds: [] } });

test('call: sends the RPC envelope and tolerates a trailing slash in DSH_URL', async () => {
  const seen = [];
  const { server, port } = await startMock((r) => {
    seen.push(r);
    return ok(null);
  }, (frame, send) => {
    if (frame.endpoint === 'workspace/follow') {
      seen.push({ url: `mux:${frame.endpoint}`, args: frame.payload.args, method: `mux:${frame.endpoint}` });
      send({ type: 'item', streamId: frame.streamId, value: baseline([]) });
    } else {
      seen.push({ url: `mux:${frame.endpoint}`, args: frame.payload.args, method: `mux:${frame.endpoint}` });
    }
  });
  try {
    const res = await runCli(['workspaces'], { DSH_URL: `http://127.0.0.1:${port}/` });
    assert.strictEqual(res.code, 0);
    assert.strictEqual(seen.length, 1, 'workspaces opens exactly one mux stream');
    const r = seen[0];
    assert.strictEqual(r.url, 'mux:workspace/follow', 'stream-only state rides the mux');
    assert.deepStrictEqual(r.args, {}, 'workspace/follow takes no args');
  } finally {
    server.close();
  }
});

test('run: a non-numeric --timeout fails before any RPC is made', async () => {
  let hit = false;
  const { server, port } = await startMock(() => { hit = true; return ok(null); });
  try {
    const res = await runCli(['run', 'do something', '--timeout', 'abc'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /--timeout/);
    assert.strictEqual(hit, false, 'validation must happen before contacting the server');
  } finally {
    server.close();
  }
});

test('run: a flag missing its value fails cleanly', async () => {
  let hit = false;
  const { server, port } = await startMock(() => { hit = true; return ok(null); });
  try {
    const res = await runCli(['run', 'task', '--workspace'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /requires a value/);
    assert.strictEqual(hit, false);
  } finally {
    server.close();
  }
});

test('run: waits for completion and prints the final assistant text', async () => {
  let listCalls = 0;
  let prompted = false;
  const { server, port } = await startMock((r) => {
    switch (r.method) {
      case 'session/create': return ok({ sessionId: 'sess-1' });
      case 'session/prompt': prompted = true; return ok(null);
      case 'session/list': {
        listCalls++;
        return ok({ items: [{ sessionId: 'sess-1', running: listCalls < 3 }] });
      }
      default: return ok(null);
    }
  }, (frame, send) => {
    if (frame.endpoint === 'session/follow') {
      const { request } = frame.payload.args;
      assert.deepStrictEqual(request.address, { kind: 'session', sessionId: 'sess-1' });
      if (!prompted) { send({ type: 'item', streamId: frame.streamId, value: snapshot([]) }); return; }
      send({
        type: 'item', streamId: frame.streamId,
        value: snapshot([
          { type: 'turn/end', data: { reason: { kind: 'completed' } } },
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hello result' }] } } },
        ]),
      });
    } else if (frame.endpoint === 'workspace/follow') {
      send({ type: 'item', streamId: frame.streamId, value: baseline([wksp('ws1', 'T', ['sess-1'])]) });
    }
  });
  try {
    const res = await runCli(['run', 'do it', '--timeout', '5'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 0);
    assert.match(res.out, /hello result/);
  } finally {
    server.close();
  }
});

test('run: a pending approval cancels the session instead of hanging', async () => {
  const calls = [];
  let prompted = false;
  const { server, port } = await startMock((r) => {
    calls.push(r.method);
    switch (r.method) {
      case 'workspace/create': return ok({ workspace: wksp('ws1', 'T', ['sess-1']) });
      case 'session/create': return ok({ sessionId: 'sess-1' });
      case 'session/prompt': prompted = true; return ok(null);
      case 'session/list': return ok({ items: [{ sessionId: 'sess-1', running: true }] });
      case 'session/cancel': return ok(null);
      default: return ok(null);
    }
  }, (frame, send) => {
    if (frame.endpoint === 'workspace/follow') {
      send({ type: 'item', streamId: frame.streamId, value: baseline([]) });
    } else if (frame.endpoint === 'session/follow') {
      if (!prompted) { send({ type: 'item', streamId: frame.streamId, value: snapshot([]) }); return; }
      send({
        type: 'item', streamId: frame.streamId,
        value: snapshot([{ type: 'approval/asked', data: { id: 'a1', toolName: 'bash' } }]),
      });
    }
  });
  try {
    const res = await runCli(['run', 'do it', '--create-workspace', '--timeout', '5'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /approval/);
    assert.ok(calls.includes('session/cancel'), 'session.cancel should be called');
  } finally {
    server.close();
  }
});

test('run: a non-completed turn/end reason surfaces as an error', async () => {
  let listCalls = 0;
  let prompted = false;
  const { server, port } = await startMock((r) => {
    switch (r.method) {
      case 'session/create': return ok({ sessionId: 'sess-1' });
      case 'session/prompt': prompted = true; return ok(null);
      case 'session/list': { listCalls++; return ok({ items: [{ sessionId: 'sess-1', running: listCalls < 2 }] }); }
      default: return ok(null);
    }
  }, (frame, send) => {
    if (frame.endpoint === 'workspace/follow') {
      send({ type: 'item', streamId: frame.streamId, value: baseline([wksp('ws1', 'T', ['sess-1'])]) });
    } else if (frame.endpoint === 'session/follow') {
      if (!prompted) { send({ type: 'item', streamId: frame.streamId, value: snapshot([]) }); return; }
      send({
        type: 'item', streamId: frame.streamId,
        value: snapshot([{ type: 'turn/end', data: { reason: { kind: 'cancelled' } } }]),
      });
    }
  });
  try {
    const res = await runCli(['run', 'do it', '--timeout', '5'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /cancelled/);
  } finally {
    server.close();
  }
});

test('run: a non-completed "error" turn/end surfaces the underlying error message', async () => {
  let listCalls = 0;
  let prompted = false;
  const { server, port } = await startMock((r) => {
    switch (r.method) {
      case 'session/create': return ok({ sessionId: 'sess-1' });
      case 'session/prompt': prompted = true; return ok(null);
      case 'session/list': { listCalls++; return ok({ items: [{ sessionId: 'sess-1', running: listCalls < 2 }] }); }
      default: return ok(null);
    }
  }, (frame, send) => {
    if (frame.endpoint === 'workspace/follow') {
      send({ type: 'item', streamId: frame.streamId, value: baseline([wksp('ws1', 'T', ['sess-1'])]) });
    } else if (frame.endpoint === 'session/follow') {
      if (!prompted) { send({ type: 'item', streamId: frame.streamId, value: snapshot([]) }); return; }
      send({
        type: 'item', streamId: frame.streamId,
        value: snapshot([{
          type: 'turn/end',
          data: { reason: { kind: 'error', error: { message: 'Authentication Fails, api key invalid', code: 'AUTH', status: 401 } } },
        }]),
      });
    }
  });
  try {
    const res = await runCli(['run', 'do it', '--timeout', '5'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /not completed/);
    assert.match(res.err, /Authentication Fails, api key invalid/);
  } finally {
    server.close();
  }
});
test('run: --permission validates against deployment presets (custom preset works)', async () => {
  let listCalls = 0;
  let appliedPermission = null;
  let prompted = false;
  const options = [
    { value: 'read-only', name: 'read-only' },
    { value: 'workspace-write', name: 'workspace-write' },
    { value: 'custom-audit', name: 'custom-audit' },
  ];
  const projections = () => ({ values: { permissions: { options, currentValue: appliedPermission } } });
  const { server, port } = await startMock((r) => {
    switch (r.method) {
      case 'session/create': return ok({ sessionId: 'sess-1' });
      case 'commands/execute': {
        appliedPermission = (r.args.line || '').replace('/permission ', '');
        assert.strictEqual(r.args.agentId, 'sess-1', 'commands/execute addresses the agent by sessionId');
        assert.deepStrictEqual(r.args.images, [], 'never attaches media');
        assert.ok(!r.args.line.includes('danger'), 'line carries the preset only');
        return ok({ result: { kind: 'success', text: 'ok' } });
      }
      case 'session/prompt': prompted = true; return ok(null);
      case 'session/list': { listCalls++; return ok({ items: [{ sessionId: 'sess-1', running: listCalls < 2 }] }); }
      default: return ok(null);
    }
  }, (frame, send) => {
    if (frame.endpoint === 'workspace/follow') {
      send({ type: 'item', streamId: frame.streamId, value: baseline([wksp('ws1', 'T', ['sess-1'])]) });
    } else if (frame.endpoint === 'session/follow') {
      if (!prompted) { send({ type: 'item', streamId: frame.streamId, value: snapshot([], projections()) }); return; }
      send({
        type: 'item', streamId: frame.streamId,
        value: snapshot([
          { type: 'turn/end', data: { reason: { kind: 'completed' } } },
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'custom done' }] } } },
        ], projections()),
      });
    }
  });
  try {
    const res = await runCli(['run', 'do it', '--permission', 'custom-audit', '--timeout', '5'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 0);
    assert.strictEqual(appliedPermission, 'custom-audit');
    assert.match(res.out, /custom done/);
    assert.match(res.err, /verified permission custom-audit/);
  } finally {
    server.close();
  }
});

test('run: --permission sends images:[] to commands/execute (required by dsh >= 0.1.1-rc.2)', async () => {
  const options = [{ value: 'read-only', name: 'read-only' }];
  let prompted = false;
  let imagesArg = null;
  const { server, port } = await startMock((r) => {
    switch (r.method) {
      case 'session/create': return ok({ sessionId: 'sess-1' });
      case 'commands/execute': {
        imagesArg = r.args.images;
        return ok({ result: { kind: 'success', text: 'ok' } });
      }
      case 'session/prompt': prompted = true; return ok(null);
      case 'session/list': return ok({ items: [{ sessionId: 'sess-1', running: false }] });
      default: return ok(null);
    }
  }, (frame, send) => {
    if (frame.endpoint !== 'session/follow') {
      send({ type: 'item', streamId: frame.streamId, value: baseline([wksp('ws1', 'T', ['sess-1'])]) });
      return;
    }
    send({
      type: 'item', streamId: frame.streamId,
      value: snapshot(prompted ? [
        { type: 'turn/end', data: { reason: { kind: 'completed' } } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } },
      ] : [], { values: { permissions: { options, currentValue: imagesArg !== null ? 'read-only' : undefined } } }),
    });
  });
  try {
    const res = await runCli(['run', 'do it', '--permission', 'read-only', '--timeout', '5'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 0);
    assert.ok(Array.isArray(imagesArg), 'commands/execute must receive an images array');
    assert.strictEqual(imagesArg.length, 0, 'dsh-rpc never attaches media, so images must be empty');
    void prompted;
  } finally {
    server.close();
  }
});

test('run: --permission not offered by the deployment is rejected (fresh session cancelled)', async () => {
  const calls = [];
  let executed = false;
  const options = [{ value: 'read-only', name: 'read-only' }, { value: 'workspace-write', name: 'workspace-write' }];
  const { server, port } = await startMock((r) => {
    calls.push(r.method);
    switch (r.method) {
      case 'session/create': return ok({ sessionId: 'sess-1' });
      case 'commands/execute': { executed = true; return ok({ result: { kind: 'success' } }); }
      default: return ok(null);
    }
  }, (frame, send) => {
    if (frame.endpoint === 'workspace/follow') {
      send({ type: 'item', streamId: frame.streamId, value: baseline([wksp('ws1', 'T', ['sess-1'])]) });
    } else if (frame.endpoint === 'session/follow') {
      send({
        type: 'item', streamId: frame.streamId,
        value: snapshot([], { values: { permissions: { options } } }),
      });
    }
  });
  try {
    const res = await runCli(['run', 'do it', '--permission', 'nope', '--timeout', '5'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /not offered/);
    assert.match(res.err, /workspace-write/);
    assert.strictEqual(executed, false, 'commands/execute must not run');
    assert.ok(calls.includes('session/cancel'), 'fresh session should be cancelled on error');
  } finally {
    server.close();
  }
});

test('run: danger-full-access without --allow-danger-full-access is rejected before any server call', async () => {
  let hit = false;
  const { server, port } = await startMock(() => { hit = true; return ok(null); });
  try {
    const res = await runCli(['run', 'do it', '--permission', 'danger-full-access', '--timeout', '5'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /allow-danger-full-access/);
    assert.strictEqual(hit, false);
  } finally {
    server.close();
  }
});

test('prompt: no-wait prints "accepted session <id>" and does not cancel', async () => {
  const calls = [];
  // prompt on an existing session still checkpoints via the mux before prompting.
  const { server, port } = await startMock((r) => { calls.push(r.method); return ok(null); }, (frame, send) => {
    if (frame.endpoint === 'session/follow') {
      send({ type: 'item', streamId: frame.streamId, value: snapshot([]) });
    }
  });
  try {
    const res = await runCli(['prompt', 'sess-9', 'hello'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 0);
    assert.match(res.out, /accepted session sess-9/);
    assert.ok(!calls.includes('session/cancel'), 'no cancel on the no-wait path');
  } finally {
    server.close();
  }
});

test('prompt --wait: prints the final assistant text (shared runSession path)', async () => {
  let listCalls = 0;
  let prompted = false;
  const { server, port } = await startMock((r) => {
    switch (r.method) {
      case 'session/prompt': prompted = true; return ok(null);
      case 'session/list': { listCalls++; return ok({ items: [{ sessionId: 'sess-1', running: listCalls < 2 }] }); }
      default: return ok(null);
    }
  }, (frame, send) => {
    if (frame.endpoint !== 'session/follow') return;
    if (!prompted) { send({ type: 'item', streamId: frame.streamId, value: snapshot([]) }); return; }
    send({
      type: 'item', streamId: frame.streamId,
      value: snapshot([
        { type: 'turn/end', data: { reason: { kind: 'completed' } } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'follow-up result' }] } } },
      ]),
    });
  });
  try {
    const res = await runCli(['prompt', 'sess-1', 'go on', '--wait', '--timeout', '5'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 0);
    assert.match(res.out, /follow-up result/);
  } finally {
    server.close();
  }
});

test('fork: with no text forks and prints the child id (no prompt)', async () => {
  const calls = [];
  const { server, port } = await startMock((r) => {
    calls.push(r.method);
    if (r.method === 'session/fork') {
      assert.deepStrictEqual(r.args, { request: { sessionId: 'sess-1' } });
      return ok({ sessionId: 'child-1' });
    }
    return ok(null);
  });
  try {
    const res = await runCli(['fork', 'sess-1'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 0);
    assert.match(res.out, /child-1/);
    assert.deepStrictEqual(calls, ['session/fork'], 'no prompt when no text is given');
  } finally {
    server.close();
  }
});

test('fork: with text forks, prompts the child and waits', async () => {
  let listCalls = 0;
  let prompted = false;
  const { server, port } = await startMock((r) => {
    switch (r.method) {
      case 'session/fork': return ok({ sessionId: 'child-1' });
      case 'session/prompt': prompted = true; return ok(null);
      case 'session/list': { listCalls++; return ok({ items: [{ sessionId: 'child-1', running: listCalls < 2 }] }); }
      default: return ok(null);
    }
  }, (frame, send) => {
    if (frame.endpoint !== 'session/follow') return;
    if (!prompted) { send({ type: 'item', streamId: frame.streamId, value: snapshot([]) }); return; }
    send({
      type: 'item', streamId: frame.streamId,
      value: snapshot([
        { type: 'turn/end', data: { reason: { kind: 'completed' } } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'fork result' }] } } },
      ]),
    });
  });
  try {
    const res = await runCli(['fork', 'sess-1', 'continue', '--timeout', '5'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 0);
    assert.match(res.out, /fork result/);
  } finally {
    server.close();
  }
});

test('search: prints matching session ids and snippets', async () => {
  const { server, port } = await startMock((r) => {
    if (r.method === 'session/search') {
      assert.deepStrictEqual(r.args, { request: { query: 'refactor logger' } });
      return ok({ items: [{ sessionId: 'sess-1', snippet: 'refactor the logger …' }], hasMore: false });
    }
    return ok(null);
  });
  try {
    const res = await runCli(['search', 'refactor', 'logger'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 0);
    assert.match(res.out, /sess-1/);
    assert.match(res.out, /refactor the logger/);
  } finally {
    server.close();
  }
});

test('run --model: resolves a bare model id via session/modelCatalog then selects it', async () => {
  let listCalls = 0;
  let prompted = false;
  let selectPayload = null;
  const { server, port } = await startMock((r) => {
    switch (r.method) {
      case 'session/create': return ok({ sessionId: 'sess-1' });
      case 'session/modelCatalog': return ok({
        default: { provider: 'p1', model: 'unique-model' },
        routableProviders: ['p1'],
        groups: [{ id: 'p1', name: 'P1', models: [{ id: 'unique-model', reasoning: { efforts: [], defaultEffort: 'high' } }] }],
        failures: [],
      });
      case 'session/selectModel': selectPayload = r.args; return ok({ selected: { provider: 'p1', model: 'unique-model' } });
      case 'session/prompt': prompted = true; return ok(null);
      case 'session/list': { listCalls++; return ok({ items: [{ sessionId: 'sess-1', running: listCalls < 2 }] }); }
      default: return ok(null);
    }
  }, (frame, send) => {
    if (frame.endpoint === 'workspace/follow') {
      send({ type: 'item', streamId: frame.streamId, value: baseline([wksp('ws1', 'T', ['sess-1'])]) });
    } else if (frame.endpoint === 'session/follow') {
      if (!prompted) { send({ type: 'item', streamId: frame.streamId, value: snapshot([]) }); return; }
      send({
        type: 'item', streamId: frame.streamId,
        value: snapshot([
          { type: 'turn/end', data: { reason: { kind: 'completed' } } },
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'model run done' }] } } },
        ]),
      });
    }
  });
  try {
    const res = await runCli(['run', 'do it', '--model', 'unique-model', '--timeout', '5'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 0);
    assert.match(res.out, /model run done/);
    assert.ok(selectPayload, 'session/selectModel should be called');
    assert.deepStrictEqual(selectPayload, {
      request: { sessionId: 'sess-1', provider: 'p1', model: 'unique-model', reasoningEffort: 'high' },
    });
  } finally {
    server.close();
  }
});

test('run --model: an ambiguous bare id lists candidates and cancels the fresh session', async () => {
  const calls = [];
  const { server, port } = await startMock((r) => {
    calls.push(r.method);
    switch (r.method) {
      case 'session/create': return ok({ sessionId: 'sess-1' });
      case 'session/modelCatalog': return ok({
        default: { provider: 'p1', model: 'shared' },
        routableProviders: ['p1'],
        groups: [
          { id: 'p1', name: 'P1', models: [{ id: 'shared' }] },
          { id: 'p2', name: 'P2', models: [{ id: 'shared' }] },
        ],
        failures: [],
      });
      case 'session/cancel': return ok(null);
      default: return ok(null);
    }
  }, (frame, send) => {
    if (frame.endpoint === 'workspace/follow') {
      send({ type: 'item', streamId: frame.streamId, value: baseline([wksp('ws1', 'T', ['sess-1'])]) });
    } else if (frame.endpoint === 'session/follow') {
      // The default workspace-write flow snapshots the journal before prompting.
      send({ type: 'item', streamId: frame.streamId, value: snapshot([]) });
    }
  });
  try {
    const res = await runCli(['run', 'do it', '--model', 'shared', '--timeout', '5'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /multiple providers/);
    assert.match(res.err, /--provider/);
    assert.ok(calls.includes('session/cancel'), 'fresh session should be cancelled');
  } finally {
    server.close();
  }
});

test('run --model: --provider without --model is rejected before any server call', async () => {
  let hit = false;
  const { server, port } = await startMock(() => { hit = true; return ok(null); });
  try {
    const res = await runCli(['run', 'task', '--provider', 'p1'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /requires --model/);
    assert.strictEqual(hit, false);
  } finally {
    server.close();
  }
});

test('rpc: a request that never returns times out with a clear error', async () => {
  const calls = [];
  const { server, port } = await startMock((r) => {
    calls.push(r.method);
    switch (r.method) {
      case 'session/create': return ok({ sessionId: 'sess-1' });
      case 'session/prompt': return HANG; // server accepts the prompt but never replies
      case 'session/cancel': return ok(null);
      default: return ok(null);
    }
  }, (frame, send) => {
    if (frame.endpoint === 'workspace/follow') {
      send({ type: 'item', streamId: frame.streamId, value: baseline([wksp('ws1', 'T', ['sess-1'])]) });
    } else if (frame.endpoint === 'session/follow') {
      send({ type: 'item', streamId: frame.streamId, value: snapshot([]) });
    }
  });
  try {
    const res = await runCli(['run', 'do it', '--timeout', '5'], {
      DSH_URL: `http://127.0.0.1:${port}`,
      DSH_RPC_TIMEOUT_MS: '200',
    });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /timed out after 200ms/);
    assert.ok(calls.includes('session/cancel'), 'fresh session should be cancelled on timeout');
  } finally {
    server.close();
  }
});

test('run: Ctrl-C cancels the active session before exiting (code 130)', async () => {
  const calls = [];
  const { server, port } = await startMock((r) => {
    calls.push(r.method);
    switch (r.method) {
      case 'session/create': return ok({ sessionId: 'sess-1' });
      case 'session/prompt': return ok(null);
      case 'session/list': return ok({ items: [{ sessionId: 'sess-1', running: true }] });
      case 'session/cancel': return ok(null);
      default: return ok(null);
    }
  }, (frame, send) => {
    if (frame.endpoint === 'workspace/follow') {
      send({ type: 'item', streamId: frame.streamId, value: baseline([wksp('ws1', 'T', ['sess-1'])]) });
    } else if (frame.endpoint === 'session/follow') {
      send({ type: 'item', streamId: frame.streamId, value: snapshot([]) });
    }
  });
  try {
    const cp = spawn(process.execPath, [CLI, 'run', 'do it', '--timeout', '30', '--quiet'], {
      env: {
        ...process.env,
        DSH_URL: `http://127.0.0.1:${port}`,
        DSH_POLL_MS: '20',
        DSH_AUTH_SECRET: TEST_SECRET,
      },
    });
    // Give the child time to enter the wait-loop (polling session/list) before interrupting.
    await new Promise((r) => setTimeout(r, 300));
    cp.kill('SIGINT');
    const res = await new Promise((resolve) => {
      let out = ''; let err = '';
      cp.stdout.on('data', (d) => (out += d));
      cp.stderr.on('data', (d) => (err += d));
      cp.on('close', (code, signal) => resolve({ code, signal, out, err }));
    });
    assert.strictEqual(res.signal, null);
    assert.strictEqual(res.code, 130);
    assert.match(res.err, /interrupted/);
    assert.ok(calls.includes('session/cancel'), 'session.cancel must reach the server before exit');
  } finally {
    server.close();
  }
});

/* ---- guard v2 improvements ---- */

test('rpc: a mismatched envelope (wrong rpcId) is rejected', async () => {
  const { server, port } = await startMock((r) => {
    if (r.method === 'session/list') {
      return { $full: { type: 'server-response', rpcId: 'not-ours', result: { ok: true, value: { items: [] } } } };
    }
    return ok(null);
  });
  try {
    const res = await runCli(['sessions'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /malformed or mismatched response/);
  } finally {
    server.close();
  }
});

test('rpc: a response without a result field is rejected', async () => {
  const { server, port } = await startMock((r) => {
    if (r.method === 'session/list') {
      return { $full: { type: 'server-response', rpcId: r.rpcId } }; // no `result`
    }
    return ok(null);
  });
  try {
    const res = await runCli(['sessions'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /malformed or mismatched response/);
  } finally {
    server.close();
  }
});

test('checkpoint: a stale turn/end + answer from before the prompt is not reused', async () => {
  let listCalls = 0;
  const staleEvents = [
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'stale answer' }] } } },
  ];
  const { server, port } = await startMock((r) => {
    switch (r.method) {
      case 'session/create': return ok({ sessionId: 'sess-1' });
      case 'session/prompt': return ok(null);
      case 'session/list': { listCalls++; return ok({ items: [{ sessionId: 'sess-1', running: listCalls < 2 }] }); }
      default: return ok(null);
    }
  }, (frame, send) => {
    if (frame.endpoint === 'workspace/follow') {
      send({ type: 'item', streamId: frame.streamId, value: baseline([wksp('ws1', 'T', ['sess-1'])]) });
    } else if (frame.endpoint === 'session/follow') {
      // snapshot is identical before AND after the prompt — it already held the
      // turn/end + answer from an EARLIER prompt. The checkpoint must ignore it.
      send({ type: 'item', streamId: frame.streamId, value: snapshot(staleEvents) });
    }
  });
  try {
    const res = await runCli(['run', 'do it', '--timeout', '5'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 0);
    assert.ok(!res.out.includes('stale answer'), 'stale answer must not be reused as this submission\'s result');
  } finally {
    server.close();
  }
});

test('run: permission drift during polling cancels the session', async () => {
  const calls = [];
  let prompted = false;
  const options = [
    { value: 'read-only', name: 'read-only' },
    { value: 'workspace-write', name: 'workspace-write' },
  ];
  let appliedPermission = 'read-only';
  const { server, port } = await startMock((r) => {
    calls.push(r.method);
    switch (r.method) {
      case 'session/create': return ok({ sessionId: 'sess-1' });
      case 'commands/execute': {
        appliedPermission = (r.args.line || '').replace('/permission ', '');
        return ok({ result: { kind: 'success', text: 'ok' } });
      }
      case 'session/prompt': prompted = true; return ok(null);
      case 'session/list': return ok({ items: [{ sessionId: 'sess-1', running: true }] });
      case 'session/cancel': return ok(null);
      default: return ok(null);
    }
  }, (frame, send) => {
    if (frame.endpoint === 'workspace/follow') {
      send({ type: 'item', streamId: frame.streamId, value: baseline([wksp('ws1', 'T', ['sess-1'])]) });
    } else if (frame.endpoint === 'session/follow') {
      // after the prompt the session's permission has drifted away from read-only
      const drift = prompted ? 'workspace-write' : appliedPermission;
      send({
        type: 'item', streamId: frame.streamId,
        value: snapshot([], { values: { permissions: { options, currentValue: drift } } }),
      });
    }
  });
  try {
    const res = await runCli(['run', 'do it', '--permission', 'read-only', '--timeout', '5'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /permission drifted/);
    assert.ok(calls.includes('session/cancel'), 'session should be cancelled on permission drift');
  } finally {
    server.close();
  }
});

test('status: prints structured JSON evidence', async () => {
  const { server, port } = await startMock((r) => {
    switch (r.method) {
      case 'session/list': return ok({ items: [{ sessionId: 'sess-1', running: false }] });
      default: return ok(null);
    }
  }, (frame, send) => {
    if (frame.endpoint !== 'session/follow') return;
    send({
      type: 'item', streamId: frame.streamId,
      value: snapshot([
        { type: 'turn/end', data: { reason: { kind: 'completed' } } },
        { type: 'permission/preset', data: { preset: 'read-only' } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done result\nDEEPSEEK_DONE:job123' }] } } },
      ], { values: { permissions: { currentValue: 'read-only' } } }),
    });
  });
  try {
    const res = await runCli(['status', 'sess-1'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 0);
    const evidence = JSON.parse(res.out);
    assert.strictEqual(evidence.sessionId, 'sess-1');
    assert.strictEqual(evidence.running, false);
    assert.strictEqual(evidence.permission, 'read-only');
    assert.strictEqual(evidence.turnEndReason, 'completed');
    assert.strictEqual(evidence.outcome, 'DONE');
    assert.match(evidence.assistantText, /done result/);
    assert.strictEqual(evidence.pendingApproval, null);
  } finally {
    server.close();
  }
});

test('run --task-file: reads the task text from a file', async () => {
  const tmp = path.join(os.tmpdir(), `dsh-rpc-task-${Date.now()}.txt`);
  fs.writeFileSync(tmp, 'line one\nline two');
  let promptText = null;
  let prompted = false;
  let listCalls = 0;
  const { server, port } = await startMock((r) => {
    switch (r.method) {
      case 'session/create': return ok({ sessionId: 'sess-1' });
      case 'session/prompt': prompted = true; promptText = (r.args.request.content || []).map((b) => b.text).join(''); return ok(null);
      case 'session/list': { listCalls++; return ok({ items: [{ sessionId: 'sess-1', running: listCalls < 2 }] }); }
      default: return ok(null);
    }
  }, (frame, send) => {
    if (frame.endpoint === 'workspace/follow') {
      send({ type: 'item', streamId: frame.streamId, value: baseline([wksp('ws1', 'T', ['sess-1'])]) });
    } else if (frame.endpoint === 'session/follow') {
      if (!prompted) { send({ type: 'item', streamId: frame.streamId, value: snapshot([]) }); return; }
      send({
        type: 'item', streamId: frame.streamId,
        value: snapshot([
          { type: 'turn/end', data: { reason: { kind: 'completed' } } },
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'file done' }] } } },
        ]),
      });
    }
  });
  try {
    const res = await runCli(['run', '--task-file', tmp, '--timeout', '5'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 0);
    assert.strictEqual(promptText, 'line one\nline two');
    assert.match(res.out, /file done/);
  } finally {
    server.close();
    fs.unlinkSync(tmp);
  }
});

test('run --task-file: combining with positional task text is rejected', async () => {
  const tmp = path.join(os.tmpdir(), `dsh-rpc-task-${Date.now()}.txt`);
  fs.writeFileSync(tmp, 'x');
  let hit = false;
  const { server, port } = await startMock(() => { hit = true; return ok(null); });
  try {
    const res = await runCli(['run', 'inline task', '--task-file', tmp], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /cannot be combined/);
    assert.strictEqual(hit, false);
  } finally {
    server.close();
    fs.unlinkSync(tmp);
  }
});

test('run --job-id: a mismatched or missing terminal marker is an error', async () => {
  let listCalls = 0;
  let prompted = false;
  const { server, port } = await startMock((r) => {
    switch (r.method) {
      case 'session/create': return ok({ sessionId: 'sess-1' });
      case 'session/prompt': prompted = true; return ok(null);
      case 'session/list': { listCalls++; return ok({ items: [{ sessionId: 'sess-1', running: listCalls < 2 }] }); }
      default: return ok(null);
    }
  }, (frame, send) => {
    if (frame.endpoint === 'workspace/follow') {
      send({ type: 'item', streamId: frame.streamId, value: baseline([wksp('ws1', 'T', ['sess-1'])]) });
    } else if (frame.endpoint === 'session/follow') {
      if (!prompted) { send({ type: 'item', streamId: frame.streamId, value: snapshot([]) }); return; }
      send({
        type: 'item', streamId: frame.streamId,
        value: snapshot([
          { type: 'turn/end', data: { reason: { kind: 'completed' } } },
          // marker is for a DIFFERENT job id than requested
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'DEEPSEEK_DONE:other-job' }] } } },
        ]),
      });
    }
  });
  try {
    const res = await runCli(['run', 'do it', '--job-id', 'job42', '--timeout', '5'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /terminal marker/);
  } finally {
    server.close();
  }
});

test('run --job-id: a BLOCKED marker exits 3', async () => {
  let listCalls = 0;
  let prompted = false;
  const { server, port } = await startMock((r) => {
    switch (r.method) {
      case 'session/create': return ok({ sessionId: 'sess-1' });
      case 'session/prompt': prompted = true; return ok(null);
      case 'session/list': { listCalls++; return ok({ items: [{ sessionId: 'sess-1', running: listCalls < 2 }] }); }
      default: return ok(null);
    }
  }, (frame, send) => {
    if (frame.endpoint === 'workspace/follow') {
      send({ type: 'item', streamId: frame.streamId, value: baseline([wksp('ws1', 'T', ['sess-1'])]) });
    } else if (frame.endpoint === 'session/follow') {
      if (!prompted) { send({ type: 'item', streamId: frame.streamId, value: snapshot([]) }); return; }
      send({
        type: 'item', streamId: frame.streamId,
        value: snapshot([
          { type: 'turn/end', data: { reason: { kind: 'completed' } } },
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'blocked\nDEEPSEEK_BLOCKED:job7' }] } } },
        ]),
      });
    }
  });
  try {
    const res = await runCli(['run', 'do it', '--job-id', 'job7', '--timeout', '5'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 3);
    assert.match(res.out, /blocked/);
  } finally {
    server.close();
  }
});

test('run --require-title: a title mismatch is rejected before session.create', async () => {
  const calls = [];
  const { server, port } = await startMock((r) => {
    calls.push(r.method);
    return ok(null);
  }, (frame, send) => {
    if (frame.endpoint === 'workspace/follow') {
      calls.push('mux:workspace/follow');
      send({ type: 'item', streamId: frame.streamId, value: baseline([wksp('ws1', 'Expected Title', ['sess-1'])]) });
    }
  });
  try {
    const res = await runCli(['run', 'do it', '--require-title', 'Wrong Title'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /Expected Title/);
    assert.match(res.err, /Wrong Title/);
    assert.ok(!calls.includes('session/create'), 'no session.create on title mismatch');
  } finally {
    server.close();
  }
});

test('run: missing workspace fails unless --create-workspace is passed', async () => {
  const calls = [];
  const { server, port } = await startMock((r) => {
    calls.push(r.method);
    return ok(null);
  }, (frame, send) => {
    if (frame.endpoint === 'workspace/follow') {
      calls.push('mux:workspace/follow');
      send({ type: 'item', streamId: frame.streamId, value: baseline([]) });
    }
  });
  try {
    const res = await runCli(['run', 'do it'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /--create-workspace/);
    assert.ok(!calls.includes('workspace/create'), 'no workspace.create without --create-workspace');
  } finally {
    server.close();
  }
});

test('run: unknown flag is rejected before any RPC call', async () => {
  let hit = false;
  const { server, port } = await startMock(() => { hit = true; return ok(null); });
  try {
    const res = await runCli(['run', 'do it', '--bogus'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /unknown flag/);
    assert.strictEqual(hit, false);
  } finally {
    server.close();
  }
});

test('run: -- emits literal task text and --json emits structured evidence', async () => {
  let promptRequestId = null;
  let promptText = null;
  let prompted = false;
  let appliedPermission = null;
  let listCalls = 0;
  const { server, port } = await startMock((r) => {
    switch (r.method) {
      case 'session/create': return ok({ sessionId: 'sess-1' });
      case 'commands/execute':
        appliedPermission = (r.args.line || '').replace('/permission ', '');
        return ok({ result: { kind: 'success', text: 'ok' } });
      case 'session/prompt':
        prompted = true;
        promptText = (r.args.request.content || []).map((b) => b.text).join('');
        promptRequestId = r.args.request.requestId;
        return ok(null);
      case 'session/list': { listCalls++; return ok({ items: [{ sessionId: 'sess-1', running: listCalls < 2 }] }); }
      default: return ok(null);
    }
  }, (frame, send) => {
    if (frame.endpoint === 'workspace/follow') {
      send({ type: 'item', streamId: frame.streamId, value: baseline([wksp('ws1', 'T', ['sess-1'])]) });
    } else if (frame.endpoint === 'session/follow') {
      if (!prompted) { send({ type: 'item', streamId: frame.streamId, value: snapshot([]) }); return; }
      send({
        type: 'item', streamId: frame.streamId,
        value: snapshot([
          { type: 'turn/end', data: { reason: { kind: 'completed' } } },
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'DEEPSEEK_DONE:job9' }] } } },
        ], { values: { permissions: { currentValue: appliedPermission } } }),
      });
    }
  });
  try {
    const res = await runCli(['run', '--json', '--', '--fix the bug'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 0);
    assert.strictEqual(promptText, '--fix the bug');
    assert.ok(/^[0-9a-f-]{36}$/u.test(promptRequestId), 'prompts carry a client-minted requestId (uuid)');
    const evidence = JSON.parse(res.out.trim());
    assert.strictEqual(evidence.sessionId, 'sess-1');
    assert.strictEqual(evidence.assistantText, 'DEEPSEEK_DONE:job9');
    assert.strictEqual(evidence.outcome, 'DONE');
    assert.strictEqual(evidence.turnEndReason, 'completed');
  } finally {
    server.close();
  }
});

test('run: a session that never reports running and produces no completion is not falsely completed', async () => {
  const calls = [];
  let prompted = false;
  const { server, port } = await startMock((r) => {
    calls.push(r.method);
    switch (r.method) {
      case 'session/create': return ok({ sessionId: 'sess-1' });
      case 'session/prompt': prompted = true; return ok(null);
      // the session is never observed running and history never gets a turn/end
      case 'session/list': return ok({ items: [{ sessionId: 'sess-1', running: false }] });
      case 'session/cancel': return ok(null);
      default: return ok(null);
    }
  }, (frame, send) => {
    if (frame.endpoint === 'workspace/follow') {
      send({ type: 'item', streamId: frame.streamId, value: baseline([wksp('ws1', 'T', ['sess-1'])]) });
    } else if (frame.endpoint === 'session/follow') {
      void prompted;
      send({ type: 'item', streamId: frame.streamId, value: snapshot([]) });
    }
  });
  try {
    const res = await runCli(['run', 'do it', '--timeout', '2'], { DSH_URL: `http://127.0.0.1:${port}` });
    // Must NOT exit 0 as "completed" just because the 3s grace elapsed while idle.
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /timed out/);
    assert.ok(calls.includes('session/cancel'), 'idle/no-completion session should be cancelled, not reported done');
  } finally {
    server.close();
  }
});

test('workspaces: a workspace object without sessionIds is rendered defensively', async () => {
  const { server, port } = await startMock(() => ok(null), (frame, send) => {
    if (frame.endpoint === 'workspace/follow') {
      send({ type: 'item', streamId: frame.streamId, value: baseline([{ workspaceId: 'ws1', title: 'T', path: '/x' }]) });
    }
  });
  try {
    const res = await runCli(['workspaces'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 0);
    assert.match(res.out, /\[0 sessions\]/);
  } finally {
    server.close();
  }
});

test('search: a null result value is handled instead of crashing', async () => {
  const { server, port } = await startMock((r) => ok(null));
  try {
    const res = await runCli(['search', 'foo'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 0);
    assert.match(res.out, /no matches/);
  } finally {
    server.close();
  }
});

/* ---- default permission + workspace path resolution ---- */

test('run: tasks default to workspace-write permission when --permission is omitted', async () => {
  let appliedLine = null;
  let prompted = false;
  let listCalls = 0;
  const { server, port } = await startMock((r) => {
    switch (r.method) {
      case 'session/create': return ok({ sessionId: 'sess-1' });
      case 'commands/execute':
        appliedLine = r.args.line;
        return ok({ result: { kind: 'success', text: 'ok' } });
      case 'session/prompt': prompted = true; return ok(null);
      case 'session/list': { listCalls++; return ok({ items: [{ sessionId: 'sess-1', running: listCalls < 2 }] }); }
      default: return ok(null);
    }
  }, (frame, send) => {
    if (frame.endpoint === 'workspace/follow') {
      send({ type: 'item', streamId: frame.streamId, value: baseline([wksp('ws1', 'T', ['sess-1'])]) });
    } else if (frame.endpoint === 'session/follow') {
      const projections = {
        values: {
          permissions: {
            options: [{ value: 'read-only', name: 'read-only' }, { value: 'workspace-write', name: 'workspace-write' }],
            currentValue: appliedLine ? appliedLine.replace('/permission ', '') : null,
          },
        },
      };
      if (!prompted) { send({ type: 'item', streamId: frame.streamId, value: snapshot([], projections) }); return; }
      send({
        type: 'item', streamId: frame.streamId,
        value: snapshot([
          { type: 'turn/end', data: { reason: { kind: 'completed' } } },
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'default-permission done' }] } } },
        ], projections),
      });
    }
  });
  try {
    // Non-quiet so the "verified permission" progress line lands on stderr.
    const res = await runCli(['run', 'do it', '--timeout', '5'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 0);
    assert.strictEqual(appliedLine, '/permission workspace-write', 'unflagged task runs must pin workspace-write (dsh default is wider)');
    assert.match(res.err, /verified permission workspace-write/);
    assert.match(res.out, /default-permission done/);
  } finally {
    server.close();
  }
});

test('run: workspace lookup resolves symlinked paths against the registered project folder', async () => {
  const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rpc-real-'));
  const linkDir = `${realDir}-link`;
  fs.symlinkSync(realDir, linkDir, 'dir');
  let createdWorkspace = false;
  let prompted = false;
  let listCalls = 0;
  const { server, port } = await startMock((r) => {
    switch (r.method) {
      case 'workspace/create': { createdWorkspace = true; return ok({ workspace: wksp('ws-dup', 'dup', ['sess-1']) }); }
      case 'session/create': return ok({ sessionId: 'sess-1' });
      case 'session/prompt': prompted = true; return ok(null);
      case 'session/list': { listCalls++; return ok({ items: [{ sessionId: 'sess-1', running: listCalls < 2 }] }); }
      default: return ok(null);
    }
  }, (frame, send) => {
    if (frame.endpoint === 'workspace/follow') {
      // The registry stores the canonicalized path (as the real server does on
      // macOS: /var/... → /private/var/...), while the CLI was pointed at a
      // symlink spelling of the same folder.
      send({
        type: 'item', streamId: frame.streamId,
        value: baseline([{ workspaceId: 'ws1', title: 'Real', path: fs.realpathSync(realDir), sessionIds: [] }]),
      });
    } else if (frame.endpoint === 'session/follow') {
      if (!prompted) { send({ type: 'item', streamId: frame.streamId, value: snapshot([]) }); return; }
      send({
        type: 'item', streamId: frame.streamId,
        value: snapshot([
          { type: 'turn/end', data: { reason: { kind: 'completed' } } },
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'symlink run done' }] } } },
        ]),
      });
    }
  });
  try {
    // No --create-workspace: the existing workspace must be found through the
    // symlinked spelling instead of failing, and no duplicate must be created.
    const res = await runCli(['run', 'do it', '--workspace', linkDir, '--timeout', '5'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 0);
    assert.match(res.err, /session sess-1 in workspace "Real"/);
    assert.strictEqual(createdWorkspace, false, 'a symlinked spelling must not mint a duplicate workspace');
    assert.match(res.out, /symlink run done/);
    void prompted;
  } finally {
    fs.rmSync(linkDir, { force: true });
    fs.rmSync(realDir, { recursive: true, force: true });
    server.close();
  }
});

/* ---- browser auth (dsh 0.1.2+) ---- */

test('auth: every request carries a signed browser-auth cookie bound to the authority', async () => {
  const seen = [];
  const { server, port } = await startMock((r) => {
    seen.push(r);
    return ok(null);
  });
  try {
    const res = await runCli(['sessions'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 0);
    assert.strictEqual(seen.length, 1);
    const authority = `127.0.0.1:${port}`;
    assert.ok(
      String(seen[0].headers.cookie || '').startsWith(cookieNameFor(authority) + '=v1.'),
      'cookie name is bound to the authority (the mock only reaches the handler after verifying the full v1.<body>.<sig> HMAC and payload)',
    );
  } finally {
    server.close();
  }
});

test('auth: an unsigned request is rejected by the server (401) with an auth hint', async () => {
  const { server, port } = await startMock(() => ok(null));
  try {
    // simulate a stale/lost secret: the CLI mints with a DIFFERENT key, so the
    // server's HMAC check fails → 401 → the CLI surfaces the auth guidance.
    const res = await runCli(['sessions'], {
      DSH_URL: `http://127.0.0.1:${port}`,
      DSH_AUTH_SECRET: crypto.randomBytes(32).toString('base64url'),
    });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /not authenticated|transport failure 401|unauthorized/u);
    assert.match(res.err, /browser-auth cookie/);
  } finally {
    server.close();
  }
});

test('auth: with no DSH_AUTH_SECRET and no credentials file, the CLI fails with actionable guidance', async () => {
  const homeEmpty = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rpc-nohome-'));
  let hit = false;
  const { server, port } = await startMock(() => { hit = true; return ok(null); });
  try {
    const res = await runCli(['sessions'], {
      DSH_URL: `http://127.0.0.1:${port}`,
      HOME: homeEmpty,
      DSH_AUTH_SECRET: '',
    });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /credential|DSH_AUTH_SECRET|credentials\.yaml/u);
    assert.strictEqual(hit, false, 'no request should reach the server without a credential');
  } finally {
    server.close();
    fs.rmSync(homeEmpty, { recursive: true, force: true });
  }
});