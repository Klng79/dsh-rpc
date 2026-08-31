# dsh-rpc

Drive [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (`dsh`)
programmatically from the command line — with **grouped** sessions.

`dsh-rpc` is a tiny, dependency-free Node CLI that talks directly to the `/api`
RPC bridge that dsh's own web UI uses. That means the sessions it creates are
attached to a workspace exactly like ones created in the browser — unlike
`dsh --profile headless`, whose sessions always show up **ungrouped**.

- **No browser, no Screen Recording.** Pure HTTP + WebSocket to a loopback server.
- **Grouped sessions.** Created through the same `/api` path as the web UI.
- **Multi-turn.** Keep prompting the same session.
- **Zero dependencies.** Plain Node (22+), uses only global `fetch`/`crypto`/`WebSocket`.

## Why

dsh ships three ways to run a task, and none of them is "programmatic *and*
grouped":

| Path | Grouped? | Programmatic? | Notes |
|------|----------|---------------|-------|
| Web UI (browser) | ✅ | ❌ | manual, needs a browser |
| `--profile headless` | ❌ | ✅ | one-shot, always "ungrouped" |
| **`dsh-rpc`** | ✅ | ✅ | this tool |

dsh's web UI is a React client over a local HTTP RPC bridge plus a WebSocket
mux. `dsh-rpc` speaks that same bridge, so it gets the web UI's grouping
behavior without needing a browser or any screen-capture permission.

## Requirements

- **Node.js 22+** (uses the built-in `WebSocket` client for `/api/remote.mux`; tested on Node 24).
- A **running dsh web server**. Start it with:
  ```sh
  dsh web          # or: npm exec @deepseek-ai/dsh web
  ```
  (default `http://127.0.0.1:3080`).
- A **browser-auth credential**. The 0.1.2+ server signs every request; dsh-rpc
  reads the persisted signing secret from `~/.dsh/.credentials.yaml` (record
  `client-connection/browser-session`, written by the first `dsh web` run) or
  from `DSH_AUTH_SECRET` (base64url).

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
      --workspace,-w <path>             target workspace dir (default: cwd; matched by real path,
                                        so symlinked spellings of the project folder resolve)
      --permission,-p <mode>            set+verify the session permission before the task
                                        (default: workspace-write for task runs)
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
dsh-rpc call session/list '{"_request":{}}'
```

## Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `DSH_URL` | `http://127.0.0.1:3080` | dsh web server base URL |
| `DSH_AUTH_SECRET` | *(from `~/.dsh/.credentials.yaml`)* | browser-session signing secret (base64url), see Requirements |
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

- **`workspace-write` is the default for task runs.** `run`, `prompt`, and
  `fork <text>` apply + verify `workspace-write` unless `--permission`
  overrides it. This pins unattended task execution below dsh's own default
  for new sessions (on this deployment, `danger-full-access`).
- The requested preset is **validated against the deployment's**
  `permissions.options` before it is applied, so a preset the deployment doesn't
  define is rejected up front (instead of relying on a hardcoded list).
- The chosen preset is applied via `commands/execute` and **verified** against
  the session's `permissions` projection before the task is submitted; a
  mismatch aborts the run.
- To see the presets a deployment actually offers: attempt a run with any
  `--permission` value — the "not offered" rejection lists the exact names this
  deployment defines (read from the session's `permissions` projection).

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
that spawns the CLI against an in-process mock of the `/api` bridge — HTTP RPC
plus a minimal RFC6455 server for the `/api/remote.mux` mux — with no real dsh
server needed. The mock enforces browser-auth the way the real server does, so
the suite covers cookie minting/verification, the RPC envelope, trailing-slash
`DSH_URL`, `--timeout`/missing-value validation, completion detection, the
approval → cancel path, the non-completed terminal-reason gate,
deployment-aware `--permission` validation, the shared `run`/`prompt`
completion path, `fork`, `search`, `--model` resolution (bare id, ambiguity,
and `--provider` validation), and auth-failure guidance.

## How it works

dsh (source build `dsh-v0.1.2-alpha.2` and later) exposes one unary RPC route
plus one WebSocket stream mux. Unary methods are HTTP POSTs to
`/api/<namespace>/<method>` with `Content-Type: application/json`; the payload
must carry exactly one `args` object whose keys match the server's generated
parameter wire names (`request` for most verbs, `_request` for `session/list`,
`agentId`/`line`/`images` for `commands/execute`):

```jsonc
// request
{ "type": "client-request", "rpcId": "<uuid>", "method": "<ns>/<m>", "payload": { "args": { /* … */ } } }

// response
{ "type": "server-response", "rpcId": "<uuid>",
  "result": { "ok": true, "value": /* … */ } | { "ok": false, "error": { "code": "…", "message": "…" } } }
```

Stream-only state (workspace list/updates, session journals, projections) is
served by `/api/remote.mux`, a WebSocket carrying JSON text frames: the client
sends `{type:'open', streamId, endpoint, payload}` and the server answers
`{type:'item', streamId, value}` frames followed by `end` (or `error`). dsh-rpc
opens a stream per call and cancels it after the item it needs
(`workspace/follow` baseline, `session/follow` snapshot), reusing one
connection. Requires Node 22+ for the built-in WebSocket client.

**Auth.** The server requires a signed browser-auth cookie named
`dsh-auth-<b64url(sha256(authority))>` with value
`v1.<b64url(JSON)>.<HMAC-SHA256>` over
`{version:1, authority, issuedAt, expiresAt}`. dsh-rpc mints that cookie from
the signing secret in `~/.dsh/.credentials.yaml` (record
`client-connection/browser-session`) or `DSH_AUTH_SECRET`; a missing/invalid
credential produces a clear error before anything reaches the server. The
server additionally enforces the **browser-trust fence** (loopback or trusted
host).

Methods used here: `workspace/create`, `workspace/delete`, `workspace/follow`
(stream baseline; replaces the old `workspace.list`), `session/create` (passing
`workspaceId` attaches/groups the session), `session/prompt` (client-minted
`requestId`), `session/list` (carries the `running` flag), `session/follow`
(stream journal snapshot + projections; replaces `session.history`),
`session/fork` (branching), `session/search`, `session/modelCatalog` +
`session/selectModel` (`--model`), `session/cancel`, and `commands/execute`
(permission presets).

**Completion detection** polls `session/list` for the session's `running`
flag, then reads the final assistant message from the `session/follow` snapshot
(which also carries the `permissions` projection used by the permission
verify/drift guards).

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
| `cannot reach dsh at http://127.0.0.1:3080` | The dsh web server isn't running. Start it with `dsh web` (or `npm exec @deepseek-ai/dsh web`), or point `DSH_URL` at the right address. |
| `no dsh web credential available` | The signing secret wasn't found. Run `dsh web` once to create `~/.dsh/.credentials.yaml`, or set `DSH_AUTH_SECRET` (base64url). |
| `not authenticated for <endpoint> (401)` | The secret doesn't match the server's (e.g. `~/dsh/.credentials.yaml` is stale after a server reinstall). Re-run `dsh web` to re-mint it, or set `DSH_AUTH_SECRET` to the server's current secret. |
| `permission "<mode>" is not offered by this deployment` | The preset isn't in this deployment's `permissions.options`. Attempt a run with any `--permission` value — the rejection lists the exact preset names. |
| `could not set permission "<mode>"` | The `/permission` command was rejected. Presets are deployment config — see the preset names via the same rejection message. |
| `permission verification failed` | The `/permission` command was accepted but the projection didn't reach the expected value. Re-run, or inspect `dsh-rpc history <id>`. |
| `session ended with reason "<x>" (not completed)` | The turn did not finish cleanly (e.g. it was cancelled or errored). See `dsh-rpc history <id>`. |
| `requested approval …; cancelled` | The session hit an approval prompt while unattended; the guard cancelled it. Re-run with a wider preset if the action is expected. |
| `timed out …; cancelled session` | The task exceeded `--timeout`; the session was cancelled. Raise `--timeout` for long jobs. |
| `unknown command` / exit code 2 | Typo in the subcommand — run `dsh-rpc help`. |

## Limitations & gotchas

- **Polling for completion; streams for state.** Completion is detected by
  polling `session.list` every `DSH_POLL_MS` and reading `session/follow`
  snapshots; there is no live token stream (the mux journal is intentionally
  consumed snapshot-by-snapshot).
- **The old `(0.1.1-rc.2 and earlier) dot-method surface is no longer
  supported.** dsh-rpc 0.3.0 targets the 0.1.2+ authed, namespaced surface
  exclusively.
- **Workspace matching resolves symlinks.** Both the target path and each
  registered workspace path are realpath'd before comparison, so `/tmp/x`
  finds the workspace registered as `/private/tmp/x` (macOS). Creation passes
  the path you give; the server canonicalizes it.
- **`run` always starts a fresh session.** Use `prompt <sessionId>` to continue
  an existing one, or `fork <sessionId>` to branch off it into a new session.
- **A running dsh web server is required** for every command.

## Credits

The permission-via-`commands/execute` technique, the `turn/end: completed`
completion gate, and the approval/timeout-cancel behavior were adapted from a
contributed "guarded runner" proposal
([issue #1 / PR #2](https://github.com/Klng79/dsh-rpc/pull/2)). Thanks!

## Verified against

- dsh source build `dsh-v0.1.2-alpha.2` (`~/Desktop/Developer/deepseek-harness`),
  verified live 2026-08-31: browser-auth cookies, `/api/<ns>/<m>` routes with
  `{args}` payloads, `commands/execute` with `images: []`, and the
  `/api/remote.mux` stream surface (`workspace/follow` baseline,
  `session/follow` snapshot with projections).

Older note: on the 0.1.1-rc.2 release, `commands/execute` required an `images`
argument (dsh-rpc sends `images: []` — it never attaches media).

## License

MIT
