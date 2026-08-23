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

Or link it via the bundled `package.json` (also what enables the test suite):

```sh
npm link          # adds a `dsh-rpc` bin on your PATH
npm test          # runs the dependency-free node:test suite against a mock server
```

## Usage

```
dsh-rpc workspaces                      list workspaces
dsh-rpc sessions                        list sessions
dsh-rpc run <task…> [opts]              create a grouped session, send task, wait, print result
      --workspace,-w <path>             target workspace dir (default: cwd)
      --permission,-p <mode>            set+verify the session permission before the task:
                                        read-only | workspace-write | danger-full-access
      --allow-danger-full-access        required acknowledgement for danger-full-access
      --model <model>                   select the model: a bare id, or <provider>/<model>
      --provider <name>                 disambiguate --model across providers (optional)
      --reasoning-effort <id>           reasoning effort for --model (optional)
      --no-wait                         return the session id immediately
      --timeout <sec>                   max wait, then cancel (default 600)
      --task-file <path>                read the task text from a file (mutually exclusive with positional text)
      --job-id <id>                     require a terminal marker DEEPSEEK_DONE/BLOCKED/NEEDS_INPUT:<id>
      --json                            emit structured JSON evidence instead of plain text
      --poll-ms <ms>                    override the completion polling interval
      --create-workspace                create the workspace if missing (default: fail if missing)
      --require-title <title>           require the registered workspace title to match
      --                                treat every following token as literal task text
      --quiet,-q                        suppress progress
dsh-rpc prompt <sessionId> [opts] <text…>  send a follow-up to an existing session
      --wait                            wait for completion and print the result
      --permission,-p <mode>            (optional) change the permission first
      --model <model>                   (optional) switch the model first
      --timeout <sec>                   max wait, then cancel (default 600)
      --task-file --job-id <id> --json --poll-ms <ms>
dsh-rpc fork <sessionId> [<text…>] [opts]  branch an existing session (child keeps workspace grouping)
      --at-seq <n>                      cut the branch at a specific history seq (optional)
      --no-wait --permission,-p <mode> --model <model> --timeout <sec> --quiet
      --task-file --job-id <id> --json --poll-ms <ms>
dsh-rpc search <query>                  search the deployment's session history
dsh-rpc status <sessionId>              print structured JSON evidence about a session
dsh-rpc cancel <sessionId>              explicitly cancel a session
dsh-rpc history <sessionId>             print a session's messages
dsh-rpc call <method> [json]            raw RPC escape hatch
dsh-rpc version|--version|-V            print the version and repository
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

# Run against a specific model (bare id is resolved uniquely against the catalog)
dsh-rpc run "refactor the logger" --model deepseek-chat

# Disambiguate a model id that multiple providers offer
dsh-rpc run "audit the codebase" --model deepseek-chat --provider my-provider

# Branch an existing session and continue it (child keeps the workspace grouping)
dsh-rpc fork session-xxxx "also handle the edge case"

# Fork without continuing — just get the child session id
dsh-rpc fork session-xxxx

# Search across the deployment's session history
dsh-rpc search "refactor logger"

# Constrain a run to read-only (permission is applied + verified before the task)
dsh-rpc run "audit the codebase for TODOs" --permission read-only

# A write task needs the wider preset explicitly
dsh-rpc run "add a CHANGELOG entry" --permission workspace-write

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
| `DSH_RPC_TIMEOUT_MS` | `30000` | per-request timeout for the `/api` bridge (ms) |

## Permission presets

`--permission` selects a dsh permission preset (a bundle of sandbox mode +
approval policy). The presets available depend on the deployment's configuration;
a typical set:

| Preset | What it allows |
|--------|----------------|
| `read-only` | Read the workspace; no writes or mutating commands |
| `workspace-write` | Write inside the workspace and permitted temp dirs; wider actions require approval |
| `danger-full-access` | Full file access without approval prompts — requires `--allow-danger-full-access` |

Notes:

- dsh assigns its **own default preset to new sessions** (on the deployment this
  was built against, the default is `danger-full-access`). Pass `--permission`
  to override it for a run.
- The requested preset is **validated against the deployment's**
  `permissions.options` before it is applied, so a preset the deployment doesn't
  define is rejected up front (instead of relying on a hardcoded list).
- The chosen preset is applied via `commands/execute` and **verified** against
  the session's `permissions` projection before the task is submitted; a
  mismatch aborts the run.
- To see the presets a deployment actually offers:
  `dsh-rpc call session.history '{"sessionId":"<id>"}'` and read
  `projections.values.permissions.options`.

## Output & exit codes

- The final answer (or session id with `--no-wait`) goes to **stdout**;
  progress and diagnostics go to **stderr**.
- Exit code `0` on success, `1` on error, `2` on an unknown command,
  `130` when interrupted with Ctrl-C (which cancels the active session).
- With `--job-id`, a `DEEPSEEK_BLOCKED:<id>` marker exits `3` and a
  `DEEPSEEK_NEEDS_INPUT:<id>` marker exits `4` (both still print the result);
  a `DEEPSEEK_DONE:<id>` marker exits `0`. A missing terminal marker is an error.

## Testing

`npm test` runs a dependency-free `node:test` suite (`test/dsh-rpc.test.js`)
that spawns the CLI against an in-process mock of the `/api` bridge — no real
dsh server needed. It covers the RPC envelope, trailing-slash `DSH_URL`,
`--timeout`/missing-value validation, completion detection, the approval →
cancel path, the non-completed terminal-reason gate, deployment-aware
`--permission` validation, the shared `run`/`prompt` completion path, `fork`,
`search`, and `--model` resolution (bare id, ambiguity, and `--provider`
validation).

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
`session.prompt`, `session.list` (carries the `running` flag),
`session.history`, `session.fork` (branching), `session.search`,
`session.models` + `session.selectModel` (`--model`),
`session.cancel`, and `commands/execute` (permission presets).

**Completion detection** polls `session.list` for the session's `running` flag
(the same signal the host broadcasts over the `/api/events.host` WebSocket),
then reads the final assistant message via `session.history`. This keeps the
tool dependency-free — no WebSocket client required.

## Safety features

These opt-in guards harden unattended runs. They are additive — the default
`run`/`prompt` behavior is unchanged.

- **Permission control** (`--permission`). The preset is checked against the
  deployment's `permissions.options`, applied through `commands/execute`
  (`/permission <mode>`) and **verified** against the session's `permissions`
  projection before the task is submitted. `danger-full-access` additionally
  requires `--allow-danger-full-access`.
- **Permission-drift detection.** While waiting, if the session's permission
  changes away from the one you requested (with `--permission`), the session is
  cancelled and the run fails. When `--permission` is omitted no permission is
  forced or checked.
- **Checkpointed completion.** The history is snapshotted right before the
  prompt; a stale `turn/end` or answer from an earlier prompt is never reused as
  this submission's result.
- **Stronger completion gate.** On finish, the latest `turn/end` event is
  checked; a terminal reason other than `completed` is surfaced as an error.
- **Approval detection.** If the session raises an unresolved approval request
  while waiting, it is cancelled rather than left hanging.
- **Cancel-on-timeout.** A timeout cancels the session instead of merely
  stopping the wait.
- **Cancel on Ctrl-C.** Interrupting `run` or `prompt --wait` with Ctrl-C
  cancels the active session before exiting (exit code 130).

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| `cannot reach dsh at http://127.0.0.1:3080` | The dsh web server isn't running. Start it with `npm exec @deepseek-ai/dsh web`, or point `DSH_URL` at the right address. |
| `permission "<mode>" is not offered by this deployment` | The preset isn't in this deployment's `permissions.options`. List the real names with `dsh-rpc call session.history '{"sessionId":"<id>"}'` and read `projections.values.permissions.options`. |
| `could not set permission "<mode>"` | The `/permission` command was rejected. Presets are deployment config — inspect `projections.values.permissions.options` via `session.history`. |
| `permission verification failed` | The `/permission` command was accepted but the projection didn't reach the expected value. Re-run, or inspect `dsh-rpc history <id>`. |
| `session ended with reason "<x>" (not completed)` | The turn did not finish cleanly (e.g. it was cancelled or errored). See `dsh-rpc history <id>`. |
| `requested approval …; cancelled` | The session hit an approval prompt while unattended; the guard cancelled it. Re-run with a wider preset if the action is expected. |
| `timed out …; cancelled session` | The task exceeded `--timeout`; the session was cancelled. Raise `--timeout` for long jobs. |
| `unknown command` / exit code 2 | Typo in the subcommand — run `dsh-rpc help`. |

## Limitations & gotchas

- **Polling, not streaming.** Progress and completion are detected by polling
  `session.list` / `session.history` every `DSH_POLL_MS`. There is no live token
  stream (the WebSocket downlinks are intentionally not consumed).
- **Workspace matching is by exact absolute path.** Symlinks are not collapsed,
  so on macOS `/tmp/x` and `/private/tmp/x` are different paths. Running from
  inside the target directory (the default `cwd`) avoids the mismatch.
- **`run` always starts a fresh session.** Use `prompt <sessionId>` to continue
  an existing one, or `fork <sessionId>` to branch off it into a new session.
- **A running dsh web server is required** for every command.

## Credits

The permission-via-`commands/execute` technique, the `turn/end: completed`
completion gate, and the approval/timeout-cancel behavior were adapted from a
contributed "guarded runner" proposal
([issue #1 / PR #2](https://github.com/Klng79/dsh-rpc/pull/2)). Thanks!

## Verified against

- `@deepseek-ai/dsh` v0.1.1-rc.2

dsh-rpc targets the `/api` RPC surface used by the web UI. In 0.1.1-rc.2, the
core session/workspace flow is unchanged from rc.6/rc.7. One compat note: rc.2
made `commands/execute` require an `images` argument, so `--permission` sends
`images: []` (dsh-rpc never attaches media).

## License

MIT
