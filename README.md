# dsh-rpc

Drive [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (`dsh`)
programmatically from the command line — with **grouped** sessions.

`dsh-rpc` is a tiny, dependency-free Node CLI that talks directly to the `/api`
RPC bridge that dsh's own web UI uses. That means the sessions it creates are
attached to a workspace exactly like ones created in the browser — unlike
`dsh --profile headless`, whose sessions always show up **ungrouped**.

- **No browser, no Screen Recording.** Pure HTTP to a loopback server.
- **Grouped sessions.** Created through the same `/api` path as the web UI.
- **Multi-turn.** Keep prompting the same session.
- **Zero dependencies.** Plain Node (18+), uses only global `fetch`/`crypto`.

## Why

dsh ships three ways to run a task, and none of them is "programmatic *and*
grouped":

| Path | Grouped? | Programmatic? | Notes |
|------|----------|---------------|-------|
| Web UI (browser) | ✅ | ❌ | manual, needs a browser |
| `--profile headless` | ❌ | ✅ | one-shot, always "ungrouped" |
| **`dsh-rpc`** | ✅ | ✅ | this tool |

dsh's web UI is a React client over a local HTTP RPC bridge plus two WebSocket
downlinks. `dsh-rpc` speaks that same bridge, so it gets the web UI's grouping
behavior without needing a browser or any screen-capture permission.

## Requirements

- **Node.js 18+** (uses global `fetch`; tested on Node 24).
- A **running dsh web server**. Start it with:
  ```sh
  npm exec @deepseek-ai/dsh web
  ```
  (default `http://127.0.0.1:3080`).

## Install

Copy the script anywhere on your `PATH`:

```sh
install -m 0755 dsh-rpc ~/.local/bin/dsh-rpc
```

## Usage

```
dsh-rpc workspaces                      list workspaces
dsh-rpc sessions                        list sessions
dsh-rpc run <task…> [opts]              create a grouped session, send task, wait, print result
      --workspace,-w <path>             target workspace dir (default: cwd)
      --no-wait                         return the session id immediately
      --timeout <sec>                   max wait (default 600)
      --quiet,-q                        suppress progress
dsh-rpc prompt <sessionId> [opts] <text…>  send a follow-up to an existing session
      --wait                            wait for completion and print the result
      --timeout <sec>                   max wait (default 600)
dsh-rpc history <sessionId>             print a session's messages
dsh-rpc call <method> [json]            raw RPC escape hatch
```

### Examples

```sh
# Run a task grouped under the workspace for the current directory
cd /path/to/my/project
dsh-rpc run "run the tests and summarize failures"

# Run against a specific workspace, don't wait
dsh-rpc run "refactor the logger" --workspace /path/to/my/project --no-wait

# Follow up in the same session
dsh-rpc prompt session-xxxx --wait "commit the passing tests"

# Inspect
dsh-rpc sessions
dsh-rpc history session-xxxx

# Raw RPC
dsh-rpc call workspace.list '{}'
```

## Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `DSH_URL` | `http://127.0.0.1:3080` | dsh web server base URL |
| `DSH_POLL_MS` | `1000` | completion poll period (ms) |

## How it works

dsh exposes a single RPC route. Each method is an HTTP POST to
`/api/<method>` with `Content-Type: application/json`:

```jsonc
// request
{ "type": "client-request", "rpcId": "<uuid>", "method": "<method>", "payload": { /* … */ } }

// response
{ "type": "server-response", "rpcId": "<uuid>",
  "result": { "ok": true, "value": /* … */ } | { "ok": false, "error": { "code": "…", "message": "…" } } }
```

The server enforces a **browser-trust fence**: every request's `Host` must be a
loopback authority (`127.0.0.1` / `localhost`) or a declared `--trusted-host`.
Local calls pass automatically. There is no auth layer — the server is
loopback-only by design.

Methods used here: `workspace.list`, `workspace.create`, `workspace.delete`,
`session.create` (passing `workspaceId` attaches/groups the session),
`session.prompt`, `session.list` (carries the `running` flag), and
`session.history`.

**Completion detection** polls `session.list` for the session's `running` flag
(the same signal the host broadcasts over the `/api/events.host` WebSocket),
then reads the final assistant message via `session.history`. This keeps the
tool dependency-free — no WebSocket client required.

## Verified against

- `@deepseek-ai/dsh` v0.1.0-rc.6

## License

MIT
