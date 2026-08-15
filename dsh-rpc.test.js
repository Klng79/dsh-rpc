'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const CLI = path.join(__dirname, 'dsh-rpc');
const WORKSPACE = '/workspace/teleparty';

function response(rpcId, value) {
  return { type: 'server-response', rpcId, result: { ok: true, value } };
}

async function mockHarness(options = {}) {
  const calls = [];
  let permission = options.initialPermission || 'workspace-write';
  let runningPolls = options.runningPolls ?? 0;
  let cancelled = false;
  let taskAccepted = false;
  let historyReadsAfterTask = 0;
  const sessionId = 'session-test';
  const server = http.createServer(async (request, reply) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    calls.push({ method: message.method, payload: message.payload });
    let value;
    switch (message.method) {
      case 'workspace.list':
        value = { items: options.noWorkspace ? [] : [{ workspaceId: 'workspace-test', title: 'teleparty', path: WORKSPACE, sessionIds: [] }] };
        break;
      case 'session.create': value = { sessionId }; break;
      case 'commands/execute': {
        assert.equal(message.payload.args.agentId, sessionId);
        const line = message.payload.args.line;
        if (line.startsWith('/permission ')) permission = line.slice('/permission '.length);
        value = options.rejectPermission
          ? undefined
          : { commandId: 'command-test', result: { kind: 'success', text: `preset ${permission}` } };
        break;
      }
      case 'session.prompt': {
        const text = message.payload.content[0].text;
        taskAccepted = true;
        value = { accepted: true };
        break;
      }
      case 'session.list':
        value = { items: [{ sessionId, running: !cancelled && runningPolls-- > 0, blank: false, cwd: WORKSPACE }] };
        break;
      case 'session.history': {
        if (taskAccepted) historyReadsAfterTask += 1;
        if (options.permissionDrift && historyReadsAfterTask > 0) permission = 'workspace-write';
        const events = [
          { event: { type: 'permission/preset', seq: 0, time: 1, data: { preset: permission } } },
        ];
        if (options.pendingApproval && taskAccepted) {
          events.push({ event: { type: 'approval/asked', seq: 1, time: 2, data: { id: 'approval-1', toolName: 'bash' } } });
        } else if (taskAccepted && runningPolls < 0) {
          const marker = options.badMarker ? 'DEEPSEEK_DONE:wrong-job' : 'DEEPSEEK_DONE:test-job';
          events.push(
            { event: { type: 'assistant/message', seq: 1, time: 2, data: { message: { content: [{ type: 'text', text: `Evidence\n${marker}` }] } } } },
            { event: { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } } },
          );
        }
        value = { events, hasMore: false, projections: { asOfSeq: events.length - 1, values: { permissions: { currentValue: permission } } } };
        break;
      }
      case 'session.cancel': cancelled = true; value = { accepted: true }; break;
      default: throw new Error(`unexpected RPC ${message.method}`);
    }
    reply.writeHead(200, { 'content-type': 'application/json' });
    reply.end(JSON.stringify(response(message.rpcId, value)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    calls,
    url: `http://127.0.0.1:${server.address().port}`,
    wasCancelled: () => cancelled,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function runCli(url, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, DSH_URL: url, DSH_POLL_MS: '10' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('applies and verifies read-only before submitting the task', async t => {
  const harness = await mockHarness();
  t.after(() => harness.close());
  const result = await runCli(harness.url, [
    'run', '--workspace', WORKSPACE, '--require-title', 'teleparty',
    '--permission', 'read-only', '--job-id', 'test-job', '--json', '--quiet', 'audit files',
  ]);
  assert.equal(result.code, 0, result.stderr);
  const commands = harness.calls.filter(call => call.method === 'commands/execute');
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].payload.args, {
    agentId: 'session-test',
    line: '/permission read-only',
  });
  const prompts = harness.calls.filter(call => call.method === 'session.prompt');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].payload.content[0].text, 'audit files');
  const output = JSON.parse(result.stdout);
  assert.equal(output.permission, 'read-only');
  assert.equal(output.outcome, 'DONE');
});

test('fails closed instead of creating a missing workspace', async t => {
  const harness = await mockHarness({ noWorkspace: true });
  t.after(() => harness.close());
  const result = await runCli(harness.url, ['run', '--workspace', WORKSPACE, 'audit']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /required workspace is not registered/);
  assert.equal(harness.calls.some(call => call.method === 'session.create'), false);
});

test('cancels immediately when the session requests approval', async t => {
  const harness = await mockHarness({ pendingApproval: true, runningPolls: 2 });
  t.after(() => harness.close());
  const result = await runCli(harness.url, [
    'run', '--workspace', WORKSPACE, '--job-id', 'test-job', '--quiet', '--poll-ms', '10', 'audit',
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /requested approval.*cancelled/);
  assert.equal(harness.wasCancelled(), true);
});

test('rejects a mismatched terminal marker', async t => {
  const harness = await mockHarness({ badMarker: true });
  t.after(() => harness.close());
  const result = await runCli(harness.url, [
    'run', '--workspace', WORKSPACE, '--job-id', 'test-job', '--quiet', 'audit',
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /protocol failure/);
});

test('fails and cancels if permission drifts while the task runs', async t => {
  const harness = await mockHarness({ permissionDrift: true });
  t.after(() => harness.close());
  const result = await runCli(harness.url, [
    'run', '--workspace', WORKSPACE, '--permission', 'read-only',
    '--job-id', 'test-job', '--quiet', 'audit',
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /permission changed while running/);
  assert.equal(harness.wasCancelled(), true);
});

test('cancels a session when its deadline expires', async t => {
  const harness = await mockHarness({ runningPolls: 1000 });
  t.after(() => harness.close());
  const result = await runCli(harness.url, [
    'run', '--workspace', WORKSPACE, '--job-id', 'test-job', '--quiet',
    '--poll-ms', '10', '--timeout', '0.03', 'audit',
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /timed out.*cancelled session/);
  assert.equal(harness.wasCancelled(), true);
});

test('requires an explicit second acknowledgement for danger-full-access', async () => {
  const result = await runCli('http://127.0.0.1:1', [
    'run', '--workspace', WORKSPACE, '--permission', 'danger-full-access', 'audit',
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /requires the explicit --allow-danger-full-access/);
});

test('does not expose the original unrestricted raw RPC command', async () => {
  const result = await runCli('http://127.0.0.1:1', ['call', 'workspace.delete', '{}']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown command: call/);
});

test('identifies the guarded jnsys build', async () => {
  const result = await runCli('http://127.0.0.1:1', ['--version']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^dsh-rpc jnsys-guarded-1$/m);
  assert.match(result.stdout, /github\.com\/jnsys\/dsh-rpc/);
});
