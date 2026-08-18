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
const fs = require('node:fs');
const os = require('node:os');

const CLI = path.join(__dirname, '..', 'dsh-rpc');

// handler(record) -> RPC result ({ ok:true, value } | { ok:false, error })
// record = { url, method, payload, rpcId, headers }
// Returning HANG leaves the request open (never responds) to simulate a hung server.
// Returning { $full: <object> } serves that object verbatim as the response body
// (used to simulate a malformed/mismatched RPC envelope).
const HANG = Symbol('hang');

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
        if (result === HANG) return; // leave the socket open — simulates a hung server
        res.writeHead(200, { 'content-type': 'application/json' });
        if (result && result.$full) {
          res.end(JSON.stringify(result.$full)); // verbatim body (envelope-mismatch tests)
          return;
        }
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
  let prompted = false;
  const { server, port } = await startMock((r) => {
    switch (r.method) {
      case 'workspace.list': return ok({ items: [WS('ws1', 'T', ['sess-1'])] });
      case 'session.create': return ok({ sessionId: 'sess-1' });
      case 'session.prompt': prompted = true; return ok(null);
      case 'session.list': {
        listCalls++;
        return ok({ items: [{ sessionId: 'sess-1', running: listCalls < 3 }] });
      }
      case 'session.history': {
        if (!prompted) return ok({ events: [], projections: { values: {} } });
        return ok({
          events: [
            { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
            { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hello result' }] } } } },
          ],
          projections: { values: {} },
        });
      }
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
  let prompted = false;
  const { server, port } = await startMock((r) => {
    calls.push(r.method);
    switch (r.method) {
      case 'workspace.list': return ok({ items: [] });
      case 'workspace.create': return ok({ workspace: WS('ws1', 'T', ['sess-1']) });
      case 'session.create': return ok({ sessionId: 'sess-1' });
      case 'session.prompt': prompted = true; return ok(null);
      case 'session.list': return ok({ items: [{ sessionId: 'sess-1', running: true }] });
      case 'session.history': {
        if (!prompted) return ok({ events: [], projections: { values: {} } });
        return ok({ events: [{ event: { type: 'approval/asked', data: { id: 'a1', toolName: 'bash' } } }], projections: { values: {} } });
      }
      case 'session.cancel': return ok(null);
      default: return ok(null);
    }
  });
  try {
    const res = await runCli(['run', 'do it', '--create-workspace', '--timeout', '5'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /approval/);
    assert.ok(calls.includes('session.cancel'), 'session.cancel should be called');
  } finally {
    server.close();
  }
});

test('run: a non-completed turn/end reason surfaces as an error', async () => {
  let listCalls = 0;
  let prompted = false;
  const { server, port } = await startMock((r) => {
    switch (r.method) {
      case 'workspace.list': return ok({ items: [WS('ws1', 'T', ['sess-1'])] });
      case 'session.create': return ok({ sessionId: 'sess-1' });
      case 'session.prompt': prompted = true; return ok(null);
      case 'session.list': { listCalls++; return ok({ items: [{ sessionId: 'sess-1', running: listCalls < 2 }] }); }
      case 'session.history': {
        if (!prompted) return ok({ events: [], projections: { values: {} } });
        return ok({ events: [{ event: { type: 'turn/end', data: { reason: { kind: 'cancelled' } } } }], projections: { values: {} } });
      }
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
  let prompted = false;
  const options = [{ name: 'read-only' }, { name: 'workspace-write' }, { name: 'custom-audit' }];
  const history = (withEvents) => ({
    events: withEvents ? [
      { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
      { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'custom done' }] } } } },
    ] : [],
    projections: { values: { permissions: { options, currentValue: appliedPermission } } },
  });
  const { server, port } = await startMock((r) => {
    switch (r.method) {
      case 'workspace.list': return ok({ items: [WS('ws1', 'T', ['sess-1'])] });
      case 'session.create': return ok({ sessionId: 'sess-1' });
      case 'commands/execute': {
        appliedPermission = (r.payload && r.payload.args && r.payload.args.line || '').replace('/permission ', '');
        return ok({ result: { kind: 'success', text: 'ok' } });
      }
      case 'session.prompt': prompted = true; return ok(null);
      case 'session.list': { listCalls++; return ok({ items: [{ sessionId: 'sess-1', running: listCalls < 2 }] }); }
      case 'session.history': return ok(history(prompted));
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
  let prompted = false;
  const { server, port } = await startMock((r) => {
    switch (r.method) {
      case 'session.prompt': prompted = true; return ok(null);
      case 'session.list': { listCalls++; return ok({ items: [{ sessionId: 'sess-1', running: listCalls < 2 }] }); }
      case 'session.history': {
        if (!prompted) return ok({ events: [], projections: { values: {} } });
        return ok({
          events: [
            { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
            { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'follow-up result' }] } } } },
          ],
          projections: { values: {} },
        });
      }
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

test('fork: with no text forks and prints the child id (no prompt)', async () => {
  const calls = [];
  const { server, port } = await startMock((r) => {
    calls.push(r.method);
    if (r.method === 'session.fork') {
      assert.deepStrictEqual(r.payload, { sessionId: 'sess-1' });
      return ok({ sessionId: 'child-1' });
    }
    return ok(null);
  });
  try {
    const res = await runCli(['fork', 'sess-1'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 0);
    assert.match(res.out, /child-1/);
    assert.deepStrictEqual(calls, ['session.fork'], 'no prompt when no text is given');
  } finally {
    server.close();
  }
});

test('fork: with text forks, prompts the child and waits', async () => {
  let listCalls = 0;
  let prompted = false;
  const { server, port } = await startMock((r) => {
    switch (r.method) {
      case 'session.fork': return ok({ sessionId: 'child-1' });
      case 'session.prompt': prompted = true; return ok(null);
      case 'session.list': { listCalls++; return ok({ items: [{ sessionId: 'child-1', running: listCalls < 2 }] }); }
      case 'session.history': {
        if (!prompted) return ok({ events: [], projections: { values: {} } });
        return ok({
          events: [
            { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
            { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'fork result' }] } } } },
          ],
          projections: { values: {} },
        });
      }
      default: return ok(null);
    }
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
    if (r.method === 'session.search') {
      assert.deepStrictEqual(r.payload, { query: 'refactor logger' });
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

test('run --model: resolves a bare model id via session.models then selects it', async () => {
  let listCalls = 0;
  let prompted = false;
  const seen = [];
  const { server, port } = await startMock((r) => {
    seen.push([r.method, r.payload]);
    switch (r.method) {
      case 'workspace.list': return ok({ items: [WS('ws1', 'T', ['sess-1'])] });
      case 'session.create': return ok({ sessionId: 'sess-1' });
      case 'session.models': return ok({
        current: { provider: 'p1', model: 'unique-model' }, routable: true,
        groups: [{ id: 'p1', name: 'P1', models: [{ id: 'unique-model' }] }], failures: [],
      });
      case 'session.selectModel': return ok({ selected: { provider: 'p1', model: 'unique-model' } });
      case 'session.prompt': prompted = true; return ok(null);
      case 'session.list': { listCalls++; return ok({ items: [{ sessionId: 'sess-1', running: listCalls < 2 }] }); }
      case 'session.history': {
        if (!prompted) return ok({ events: [], projections: { values: {} } });
        return ok({
          events: [
            { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
            { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'model run done' }] } } } },
          ],
          projections: { values: {} },
        });
      }
      default: return ok(null);
    }
  });
  try {
    const res = await runCli(['run', 'do it', '--model', 'unique-model', '--timeout', '5'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 0);
    assert.match(res.out, /model run done/);
    const sm = seen.find(([m]) => m === 'session.selectModel');
    assert.ok(sm, 'session.selectModel should be called');
    assert.deepStrictEqual(sm[1], { sessionId: 'sess-1', provider: 'p1', model: 'unique-model' });
  } finally {
    server.close();
  }
});

test('run --model: an ambiguous bare id lists candidates and cancels the fresh session', async () => {
  const calls = [];
  const { server, port } = await startMock((r) => {
    calls.push(r.method);
    switch (r.method) {
      case 'workspace.list': return ok({ items: [WS('ws1', 'T', ['sess-1'])] });
      case 'session.create': return ok({ sessionId: 'sess-1' });
      case 'session.models': return ok({
        current: { provider: 'p1', model: 'shared' }, routable: true,
        groups: [
          { id: 'p1', name: 'P1', models: [{ id: 'shared' }] },
          { id: 'p2', name: 'P2', models: [{ id: 'shared' }] },
        ], failures: [],
      });
      case 'session.cancel': return ok(null);
      default: return ok(null);
    }
  });
  try {
    const res = await runCli(['run', 'do it', '--model', 'shared', '--timeout', '5'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /multiple providers/);
    assert.match(res.err, /--provider/);
    assert.ok(calls.includes('session.cancel'), 'fresh session should be cancelled');
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
      case 'workspace.list': return ok({ items: [WS('ws1', 'T', ['sess-1'])] });
      case 'session.create': return ok({ sessionId: 'sess-1' });
      case 'session.prompt': return HANG; // server accepts the prompt but never replies
      case 'session.cancel': return ok(null);
      default: return ok(null);
    }
  });
  try {
    const res = await runCli(['run', 'do it', '--timeout', '5'], {
      DSH_URL: `http://127.0.0.1:${port}`,
      DSH_RPC_TIMEOUT_MS: '200',
    });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /timed out after 200ms/);
    assert.ok(calls.includes('session.cancel'), 'fresh session should be cancelled on timeout');
  } finally {
    server.close();
  }
});

test('run: Ctrl-C cancels the active session before exiting (code 130)', async () => {
  const calls = [];
  const { server, port } = await startMock((r) => {
    calls.push(r.method);
    switch (r.method) {
      case 'workspace.list': return ok({ items: [WS('ws1', 'T', ['sess-1'])] });
      case 'session.create': return ok({ sessionId: 'sess-1' });
      case 'session.prompt': return ok(null);
      case 'session.list': return ok({ items: [{ sessionId: 'sess-1', running: true }] });
      case 'session.cancel': return ok(null);
      default: return ok(null);
    }
  });
  try {
    const cp = spawn(process.execPath, [CLI, 'run', 'do it', '--timeout', '30'], {
      env: { ...process.env, DSH_URL: `http://127.0.0.1:${port}`, DSH_POLL_MS: '20' },
    });
    // Give the child time to enter the wait-loop (polling session.list) before interrupting.
    await new Promise((r) => setTimeout(r, 200));
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
    assert.ok(calls.includes('session.cancel'), 'session.cancel must reach the server before exit');
  } finally {
    server.close();
  }
});

/* ---- guard v2 improvements ---- */

test('rpc: a mismatched envelope (wrong rpcId) is rejected', async () => {
  const { server, port } = await startMock((r) => {
    if (r.method === 'workspace.list') {
      return { $full: { type: 'server-response', rpcId: 'someone-else', result: { ok: true, value: { items: [] } } } };
    }
    return ok(null);
  });
  try {
    const res = await runCli(['workspaces'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /malformed or mismatched response/);
  } finally {
    server.close();
  }
});

test('rpc: a response without a result field is rejected', async () => {
  const { server, port } = await startMock((r) => {
    if (r.method === 'workspace.list') {
      return { $full: { type: 'server-response', rpcId: r.rpcId } }; // no `result`
    }
    return ok(null);
  });
  try {
    const res = await runCli(['workspaces'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /malformed or mismatched response/);
  } finally {
    server.close();
  }
});

test('checkpoint: a stale turn/end + answer from before the prompt is not reused', async () => {
  let listCalls = 0;
  const staleEvents = [
    { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
    { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'stale answer' }] } } } },
  ];
  const { server, port } = await startMock((r) => {
    switch (r.method) {
      case 'workspace.list': return ok({ items: [WS('ws1', 'T', ['sess-1'])] });
      case 'session.create': return ok({ sessionId: 'sess-1' });
      case 'session.prompt': return ok(null);
      case 'session.list': { listCalls++; return ok({ items: [{ sessionId: 'sess-1', running: listCalls < 2 }] }); }
      // history is identical before AND after the prompt — it already held the
      // turn/end + answer from an EARLIER prompt. The checkpoint must ignore it.
      case 'session.history': return ok({ events: staleEvents, projections: { values: {} } });
      default: return ok(null);
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
  const options = [{ name: 'read-only' }, { name: 'workspace-write' }];
  let appliedPermission = 'read-only';
  const { server, port } = await startMock((r) => {
    calls.push(r.method);
    switch (r.method) {
      case 'workspace.list': return ok({ items: [WS('ws1', 'T', ['sess-1'])] });
      case 'session.create': return ok({ sessionId: 'sess-1' });
      case 'commands/execute': {
        appliedPermission = (r.payload && r.payload.args && r.payload.args.line || '').replace('/permission ', '');
        return ok({ result: { kind: 'success', text: 'ok' } });
      }
      case 'session.prompt': prompted = true; return ok(null);
      case 'session.list': return ok({ items: [{ sessionId: 'sess-1', running: true }] });
      case 'session.history': {
        if (!prompted) return ok({ events: [], projections: { values: { permissions: { options, currentValue: appliedPermission } } } });
        // after the prompt the session's permission has drifted away from read-only
        return ok({ events: [], projections: { values: { permissions: { options, currentValue: 'workspace-write' } } } });
      }
      case 'session.cancel': return ok(null);
      default: return ok(null);
    }
  });
  try {
    const res = await runCli(['run', 'do it', '--permission', 'read-only', '--timeout', '5'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /permission drifted/);
    assert.ok(calls.includes('session.cancel'), 'session should be cancelled on permission drift');
  } finally {
    server.close();
  }
});

test('status: prints structured JSON evidence', async () => {
  const { server, port } = await startMock((r) => {
    switch (r.method) {
      case 'session.list': return ok({ items: [{ sessionId: 'sess-1', running: false }] });
      case 'session.history': return ok({
        events: [
          { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
          { event: { type: 'permission/preset', data: { preset: 'read-only' } } },
          { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done result\nDEEPSEEK_DONE:job123' }] } } } },
        ],
        projections: { values: { permissions: { currentValue: 'read-only' } } },
      });
      default: return ok(null);
    }
  });
  try {
    const res = await runCli(['status', 'sess-1'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 0);
    const ev = JSON.parse(res.out);
    assert.strictEqual(ev.sessionId, 'sess-1');
    assert.strictEqual(ev.running, false);
    assert.strictEqual(ev.permission, 'read-only');
    assert.strictEqual(ev.turnEndReason, 'completed');
    assert.strictEqual(ev.outcome, 'DONE');
    assert.match(ev.assistantText, /done result/);
    assert.strictEqual(ev.pendingApproval, null);
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
      case 'workspace.list': return ok({ items: [WS('ws1', 'T', ['sess-1'])] });
      case 'session.create': return ok({ sessionId: 'sess-1' });
      case 'session.prompt': prompted = true; promptText = (r.payload.content || []).map((b) => b.text).join(''); return ok(null);
      case 'session.list': { listCalls++; return ok({ items: [{ sessionId: 'sess-1', running: listCalls < 2 }] }); }
      case 'session.history': {
        if (!prompted) return ok({ events: [], projections: { values: {} } });
        return ok({ events: [
          { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
          { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'file done' }] } } } },
        ], projections: { values: {} } });
      }
      default: return ok(null);
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
      case 'workspace.list': return ok({ items: [WS('ws1', 'T', ['sess-1'])] });
      case 'session.create': return ok({ sessionId: 'sess-1' });
      case 'session.prompt': prompted = true; return ok(null);
      case 'session.list': { listCalls++; return ok({ items: [{ sessionId: 'sess-1', running: listCalls < 2 }] }); }
      case 'session.history': {
        if (!prompted) return ok({ events: [], projections: { values: {} } });
        return ok({ events: [
          { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
          // marker is for a DIFFERENT job id than requested
          { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'DEEPSEEK_DONE:other-job' }] } } } },
        ], projections: { values: {} } });
      }
      default: return ok(null);
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
      case 'workspace.list': return ok({ items: [WS('ws1', 'T', ['sess-1'])] });
      case 'session.create': return ok({ sessionId: 'sess-1' });
      case 'session.prompt': prompted = true; return ok(null);
      case 'session.list': { listCalls++; return ok({ items: [{ sessionId: 'sess-1', running: listCalls < 2 }] }); }
      case 'session.history': {
        if (!prompted) return ok({ events: [], projections: { values: {} } });
        return ok({ events: [
          { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
          { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'blocked\nDEEPSEEK_BLOCKED:job7' }] } } } },
        ], projections: { values: {} } });
      }
      default: return ok(null);
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
    if (r.method === 'workspace.list') return ok({ items: [WS('ws1', 'Expected Title', ['sess-1'])] });
    return ok(null);
  });
  try {
    const res = await runCli(['run', 'do it', '--require-title', 'Wrong Title'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /Expected Title/);
    assert.match(res.err, /Wrong Title/);
    assert.ok(!calls.includes('session.create'), 'no session.create on title mismatch');
  } finally {
    server.close();
  }
});

test('run: missing workspace fails unless --create-workspace is passed', async () => {
  const calls = [];
  const { server, port } = await startMock((r) => {
    calls.push(r.method);
    if (r.method === 'workspace.list') return ok({ items: [] });
    return ok(null);
  });
  try {
    const res = await runCli(['run', 'do it'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 1);
    assert.match(res.err, /--create-workspace/);
    assert.ok(!calls.includes('workspace.create'), 'no workspace.create without --create-workspace');
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
  let promptText = null;
  let prompted = false;
  let listCalls = 0;
  const { server, port } = await startMock((r) => {
    switch (r.method) {
      case 'workspace.list': return ok({ items: [WS('ws1', 'T', ['sess-1'])] });
      case 'session.create': return ok({ sessionId: 'sess-1' });
      case 'session.prompt': prompted = true; promptText = (r.payload.content || []).map((b) => b.text).join(''); return ok(null);
      case 'session.list': { listCalls++; return ok({ items: [{ sessionId: 'sess-1', running: listCalls < 2 }] }); }
      case 'session.history': {
        if (!prompted) return ok({ events: [], projections: { values: {} } });
        return ok({ events: [
          { event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } },
          { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'DEEPSEEK_DONE:job9' }] } } } },
        ], projections: { values: { permissions: { currentValue: 'read-only' } } } });
      }
      default: return ok(null);
    }
  });
  try {
    const res = await runCli(['run', '--json', '--', '--fix the bug'], { DSH_URL: `http://127.0.0.1:${port}` });
    assert.strictEqual(res.code, 0);
    assert.strictEqual(promptText, '--fix the bug');
    const ev = JSON.parse(res.out.trim());
    assert.strictEqual(ev.sessionId, 'sess-1');
    assert.strictEqual(ev.assistantText, 'DEEPSEEK_DONE:job9');
    assert.strictEqual(ev.outcome, 'DONE');
    assert.strictEqual(ev.turnEndReason, 'completed');
  } finally {
    server.close();
  }
});



