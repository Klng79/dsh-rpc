'use strict';

/*
 * End-to-end tests for dsh-rpc. The CLI is spawned as a child process and talks
 * to a tiny in-process mock of the dsh /api bridge, so no real dsh server is
 * required and the script keeps its module-system-agnostic property (we never
 * require() it directly).
 *
 * Run with: npm test   (node --test test/)
 */

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'dsh-rpc');

// handler(record) -> RPC result ({ ok:true, value } | { ok:false, error })
// record = { url, method, payload, rpcId, headers }
function startMock(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let reqData = {};
        try { reqData = JSON.parse(body || '{}'); } catch { reqData = {}; }
        const record = {
          url: req.url,
          method: reqData.method,
          payload: reqData.payload,
          rpcId: reqData.rpcId,
          headers: req.headers,
        };
        let result;
        try {
          result = handler(record);
          if (result === undefined) result = { ok: true, value: null };
        } catch (e) {
          result = { ok: false, error: { code: 'mock', message: String((e && e.message) || e) } };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'server-response', rpcId: reqData.rpcId, result }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, DSH_POLL_MS: '10', ...env },
    });
    let out = '';
    let err = '';
    cp.stdout.on('data', (d) => (out += d));
    cp.stderr.on('data', (d) => (err += d));
    cp.on('close', (code, signal) => resolve({ code, signal, out, err }));
  });
}

const ok = (value) => ({ ok: true, value });
const WS = (wsId, title, sessionIds) => ({ workspaceId: wsId, title, path: process.cwd(), sessionIds: sessionIds || [] });

test('call: sends the RPC envelope and tolerates a trailing slash in DSH_URL', async () => {
  const seen = [];
  const { server, port } = await startMock((r) => {
    seen.push(r);
    if (r.method === 'workspace.list') {
      return ok({ items: [WS('ws1', 'Test Workspace', ['s1'])] });
    }
    return ok(null);
  });
  try {
    const res = await runCli(['workspaces'], { DSH_URL: `http://127.0.0.1:${port}/` });
    assert.strictEqual(res.code, 0);
    assert.match(res.out, /ws1/);
    assert.strictEqual(seen.length, 1, 'workspaces makes exactly one RPC');
    const r = seen[0];
    assert.strictEqual(r.url, '/api/workspace.list', 'no double slash from trailing "/"');
    assert.strictEqual(r.method, 'workspace.list');
    assert.strictEqual(typeof r.rpcId, 'string');
    assert.ok(r.rpcId.length > 0, 'rpcId is non-empty');
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
  const { server, port } = await startMock((r) => {
    switch (r.method) {
      case 'workspace.list': return ok({ items: [WS('ws1', 'T', ['sess-1'])] });
      case 'session.create': return ok({ sessionId: 'sess-1' });
      case 'session.prompt': return ok(null);
      case 'session.list': {
        listCalls++;
        return ok({ items: [{ sessionId: 'sess-1', running: listCalls < 3 }] });
      }
      case 'session.history': return ok({
        events: [
          { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
          { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hello result' }] } } } },
        ],
        projections: { values: {} },
      });
      default: return ok(null);
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
  const { server, port } = await startMock((r) => {
    calls.push(r.method);
    switch (r.method) {
      case 'workspace.list': return ok({ items: [] });
      case 'workspace.create': return ok({ workspace: WS('ws1', 'T', ['sess-1']) });
      case 'session.create': return ok({ sessionId: 'sess-1' });
      case 'session.prompt': return ok(null);
      case 'session.list': return ok({ items: [{ sessionId: 'sess-1', running: true }] });
      case 'session.history': return ok({
        events: [{ event: { type: 'approval/asked', data: { id: 'a1', toolName: 'bash' } } }],
        projections: { values: {} },
      });
      case 'session.cancel': return ok(null);
      default: return ok(null);
    }
  });
  try {
    const res = await runCli(['run', 'do it', '--timeout', '5'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /approval/);
    assert.ok(calls.includes('session.cancel'), 'session.cancel should be called');
  } finally {
    server.close();
  }
});

test('run: a non-completed turn/end reason surfaces as an error', async () => {
  let listCalls = 0;
  const { server, port } = await startMock((r) => {
    switch (r.method) {
      case 'workspace.list': return ok({ items: [WS('ws1', 'T', ['sess-1'])] });
      case 'session.create': return ok({ sessionId: 'sess-1' });
      case 'session.prompt': return ok(null);
      case 'session.list': { listCalls++; return ok({ items: [{ sessionId: 'sess-1', running: listCalls < 2 }] }); }
      case 'session.history': return ok({
        events: [{ event: { type: 'turn/end', data: { reason: { kind: 'cancelled' } } } }],
        projections: { values: {} },
      });
      default: return ok(null);
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
test('run: --permission validates against deployment presets (custom preset works)', async () => {
  let listCalls = 0;
  let appliedPermission = null;
  const options = [{ name: 'read-only' }, { name: 'workspace-write' }, { name: 'custom-audit' }];
  const { server, port } = await startMock((r) => {
    switch (r.method) {
      case 'workspace.list': return ok({ items: [WS('ws1', 'T', ['sess-1'])] });
      case 'session.create': return ok({ sessionId: 'sess-1' });
      case 'commands/execute': {
        appliedPermission = (r.payload && r.payload.args && r.payload.args.line || '').replace('/permission ', '');
        return ok({ result: { kind: 'success', text: 'ok' } });
      }
      case 'session.list': { listCalls++; return ok({ items: [{ sessionId: 'sess-1', running: listCalls < 2 }] }); }
      case 'session.history': return ok({
        events: [
          { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
          { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'custom done' }] } } } },
        ],
        projections: { values: { permissions: { options, currentValue: appliedPermission } } },
      });
      default: return ok(null);
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

test('run: --permission not offered by the deployment is rejected (fresh session cancelled)', async () => {
  const calls = [];
  let executed = false;
  const options = [{ name: 'read-only' }, { name: 'workspace-write' }];
  const { server, port } = await startMock((r) => {
    calls.push(r.method);
    switch (r.method) {
      case 'workspace.list': return ok({ items: [WS('ws1', 'T', ['sess-1'])] });
      case 'session.create': return ok({ sessionId: 'sess-1' });
      case 'commands/execute': { executed = true; return ok({ result: { kind: 'success' } }); }
      case 'session.history': return ok({ events: [], projections: { values: { permissions: { options } } } });
      default: return ok(null);
    }
  });
  try {
    const res = await runCli(['run', 'do it', '--permission', 'nope', '--timeout', '5'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /not offered/);
    assert.match(res.err, /workspace-write/);
    assert.strictEqual(executed, false, 'commands/execute must not run');
    assert.ok(calls.includes('session.cancel'), 'fresh session should be cancelled on error');
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
  const { server, port } = await startMock((r) => { calls.push(r.method); return ok(null); });
  try {
    const res = await runCli(['prompt', 'sess-9', 'hello'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 0);
    assert.match(res.out, /accepted session sess-9/);
    assert.ok(!calls.includes('session.cancel'), 'no cancel on the no-wait path');
  } finally {
    server.close();
  }
});

test('prompt --wait: prints the final assistant text (shared runSession path)', async () => {
  let listCalls = 0;
  const { server, port } = await startMock((r) => {
    switch (r.method) {
      case 'session.prompt': return ok(null);
      case 'session.list': { listCalls++; return ok({ items: [{ sessionId: 'sess-1', running: listCalls < 2 }] }); }
      case 'session.history': return ok({
        events: [
          { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
          { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'follow-up result' }] } } } },
        ],
        projections: { values: {} },
      });
      default: return ok(null);
    }
  });
  try {
    const res = await runCli(['prompt', 'sess-1', 'go on', '--wait', '--timeout', '5'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 0);
    assert.match(res.out, /follow-up result/);
  } finally {
    server.close();
  }
});

