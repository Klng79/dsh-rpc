# dsh-rpc

Drive [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) grouped
sessions from a dependency-free Node CLI, with guardrails for unattended jobs.

The tool talks to the same loopback-only `/api` RPC bridge as the Harness web
client. Sessions therefore appear under a registered workspace rather than as
ungrouped headless sessions.

## Why the guarded runner

Automation needs stronger completion evidence than “the process stopped.” A
guarded `run`:

- defaults to `read-only`;
- requires an exact, already registered workspace path and can also require its
  title;
- applies permission through the host's `commands/execute` RPC and verifies
  the resulting projection before sending the task;
- cancels on timeout or an unresolved approval request;
- detects permission drift while the task runs;
- requires a completed `turn/end` event;
- can require a job-specific terminal marker; and
- emits machine-readable JSON.

It never auto-creates a workspace and does not expose the unrestricted raw RPC
escape hatch from the original proof of concept. These are intentional,
safety-related breaking changes.

## Requirements

- Node.js 18 or newer (global `fetch`).
- A running Harness web server:

  ```sh
  npm exec @deepseek-ai/dsh web
  ```

- The target directory already registered as a Harness workspace.

## Install

```sh
install -m 0755 dsh-rpc ~/.local/bin/dsh-rpc
```

## Guarded run

```text
dsh-rpc run [task text] [options]

  --workspace,-w <path>       exact registered path (default: current directory)
  --require-title <title>     also require this workspace title
  --permission,-p <mode>      read-only (default) or workspace-write
  --job-id <id>               require a matching DEEPSEEK_* terminal marker
  --task-file <path>          read multiline task text from a file
  --timeout <seconds>         cancel after the deadline (default: 600)
  --poll-ms <milliseconds>    polling interval
  --no-wait                   return after admission
  --json                      structured output
  --quiet,-q                  suppress progress
```

`danger-full-access` is intentionally hidden from normal usage. It requires
both `--permission danger-full-access` and
`--allow-danger-full-access`; that mechanical acknowledgement is not a
substitute for authorization.

A marker-aware example:

```sh
job_id=audit-2026-08-15-01
dsh-rpc run \
  --workspace /path/to/project \
  --require-title project \
  --permission read-only \
  --job-id "$job_id" \
  --json \
  "Audit the tests. End with DEEPSEEK_DONE:$job_id"
```

Accepted terminal markers are:

```text
DEEPSEEK_DONE:<job-id>
DEEPSEEK_BLOCKED:<job-id>
DEEPSEEK_NEEDS_INPUT:<job-id>
```

The marker must be the final line of the latest assistant response and match
the current job ID.

## Inspect and control sessions

```text
dsh-rpc status <session-id> [--job-id <id>]
dsh-rpc cancel <session-id>
dsh-rpc history <session-id>
dsh-rpc workspaces
dsh-rpc sessions
```

`status`, `history`, `workspaces`, and `sessions` print JSON so callers do
not need to scrape presentation text.

## Permission flow

Harness slash commands are host commands, not conversation prompts. The runner
sets permission with:

```text
POST /api/commands/execute
{ "args": { "agentId": "<session-id>", "line": "/permission read-only" } }
```

It then reads `session.history` and verifies the permission projection before
submitting the actual task through `session.prompt`. This keeps the control
command out of model conversation history.

## Completion contract

For a waiting run, success requires all applicable signals to agree:

1. `session.list` reports that the session is no longer running.
2. No unresolved approval is present.
3. The latest turn ended with reason `completed`.
4. The permission projection still matches the requested mode.
5. When `--job-id` is present, the latest assistant response ends with its
   matching terminal marker.

Timeouts and approval requests trigger `session.cancel`. Any protocol mismatch
fails closed.

## Tests

The mock RPC integration suite covers permission ordering, workspace
fail-closed behavior, approval cancellation, marker validation, permission
drift, timeout cancellation, full-access acknowledgement, and removal of the
raw RPC command.

```sh
node --test dsh-rpc.test.js
```

## Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `DSH_URL` | `http://127.0.0.1:3080` | Harness web server base URL |
| `DSH_POLL_MS` | `1000` | Completion polling interval in milliseconds |

## Security boundary

Harness relies on a loopback/trusted-host fence rather than an application
authentication layer. Do not expose the server to an untrusted network. The
CLI guardrails reduce accidental authority and ambiguous completion; they do
not replace operating-system isolation or user authorization.

## License

MIT
