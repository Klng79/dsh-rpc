# dsh-rpc

Drive [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) grouped
sessions from a dependency-free Node CLI, with fail-closed defaults for
unattended automation.

`dsh-rpc` talks to the loopback `/api` RPC bridge used by the Harness Web UI.
Sessions therefore remain attached to a registered workspace instead of
appearing as ungrouped headless sessions.

## What guarded v2 combines

This version keeps the expanded Klng79 command set:

- multi-turn `prompt`, `fork`, and deployment-wide `search`;
- model, provider, and reasoning-effort selection;
- deployment-discovered permission presets;
- per-request RPC timeout and reliable Ctrl-C cancellation;
- grouped sessions, human-readable output, and raw RPC access; and
- a dependency-free `node:test` integration suite.

It also makes the jnsys guarded-runner invariants the default:

- every task submission defaults to `read-only`;
- the target must be an exact, already registered workspace unless creation is
  explicitly acknowledged;
- an optional workspace title can be pinned;
- permission must be observable and exactly match before task admission;
- task admission itself must return `accepted: true`;
- permission drift cancels the running session;
- completion requires a new `turn/end: completed` event for the submitted task;
- an optional job marker can bind the answer to one automation job;
- approval requests, timeouts, and Ctrl-C cancel the session; and
- status and completion evidence can be emitted as JSON.

## Requirements

- Node.js 18 or newer.
- A running Harness Web server:

  ```sh
  npx @deepseek-ai/dsh@latest web
  ```

- The intended directory already registered as a Harness workspace, unless the
  caller deliberately passes `--create-workspace`.

The RPC surface is verified against `@deepseek-ai/dsh` rc.6 and rc.7.

## Install

```sh
install -m 0755 dsh-rpc ~/.local/bin/dsh-rpc
```

Or link the repository checkout:

```sh
npm link
```

Verify the guarded build:

```sh
command -v dsh-rpc
dsh-rpc --version
```

## Usage

```text
dsh-rpc workspaces [--table]
dsh-rpc sessions [--table]

dsh-rpc run <task...> [options]
  --workspace,-w <path>       exact registered workspace (default: cwd)
  --require-title <title>     also require the registered workspace title
  --create-workspace          explicitly allow creation of a missing workspace
  --permission,-p <preset>    deployment preset (default: read-only)
  --allow-danger-full-access  required with danger-full-access
  --model <model>             bare model id or provider/model
  --provider <provider>       disambiguate a bare model id
  --reasoning-effort <id>     select a model reasoning effort
  --task-file <path>          read multiline task text from a file
  --job-id <id>               require a matching DEEPSEEK_* terminal marker
  --timeout <seconds>         job deadline, followed by cancellation
  --poll-ms <milliseconds>    completion polling interval
  --no-wait                   return after verified admission
  --json                      print structured evidence
  --quiet,-q                  suppress progress

dsh-rpc prompt <sessionId> <text...> [--wait] [run options]
dsh-rpc fork <sessionId> [<text...>] [--at-seq <n>] [run options]
dsh-rpc search <query>
dsh-rpc status <sessionId> [--job-id <id>]
dsh-rpc cancel <sessionId>
dsh-rpc history <sessionId> [--json]
dsh-rpc call [--allow-unsafe-call] <method> [json]
```

Use `--` before literal task text that starts with a dash. Unknown options fail
before any RPC call instead of silently becoming prompt text.

## Examples

Safe read-only run in an already registered workspace:

```sh
dsh-rpc run \
  --workspace /path/to/project \
  --require-title project \
  --json \
  "Audit the test coverage"
```

Explicitly authorized write run:

```sh
dsh-rpc run \
  --workspace /path/to/project \
  --permission workspace-write \
  "Add regression tests"
```

Select a model and reasoning effort:

```sh
dsh-rpc run \
  --model deepseek/deepseek-chat \
  --reasoning-effort high \
  "Review the API design"
```

Continue or branch a session:

```sh
dsh-rpc prompt session-xxxx --wait "Now inspect the error path"
dsh-rpc fork session-xxxx "Try a smaller implementation"
```

Bind completion to a unique job:

```sh
job_id=audit-2026-08-18-01
dsh-rpc run \
  --job-id "$job_id" \
  --json \
  "Audit the code. End with DEEPSEEK_DONE:$job_id"
```

Accepted final markers are:

```text
DEEPSEEK_DONE:<job-id>
DEEPSEEK_BLOCKED:<job-id>
DEEPSEEK_NEEDS_INPUT:<job-id>
```

The marker must be the final line of the newest assistant response.

## Permission and workspace policy

Permission names are read from the session's
`projections.values.permissions.options`, so custom deployment presets work.
The requested preset is applied through `commands/execute`, then the permission
projection must exactly match. A missing projection is a failure, not implicit
success.

`danger-full-access` additionally requires
`--allow-danger-full-access`. That flag is only a mechanical acknowledgement;
it is not a substitute for user authorization.

Workspace matching uses a normalized absolute path. A missing workspace fails
closed. `--create-workspace` retains the original convenience behavior as an
explicit opt-in, and `--require-title` protects against selecting the wrong
registered entry at the expected path.

## Completion contract

A waiting task succeeds only when all applicable signals agree:

1. The exact session still exists and is no longer running.
2. No unresolved approval is present.
3. A new `turn/end` event exists for this submission.
4. Its reason is `completed`.
5. The final permission still equals the requested preset.
6. When `--job-id` is used, the newest assistant response ends with the matching
   terminal marker.

The pre-prompt history checkpoint prevents an old completed turn and old answer
from being mistaken for the result of a new multi-turn prompt.

`BLOCKED` and `NEEDS_INPUT` markers produce exit codes 3 and 4. Ordinary errors
use exit code 1, unknown commands use 2, and Ctrl-C uses 130.

## Raw RPC boundary

Read-only discovery methods such as `workspace.list`, `session.list`,
`session.history`, `session.search`, and `session.models` can be called directly.
Other methods require `--allow-unsafe-call` because arbitrary RPC can mutate or
delete Harness state.

## Benefits compared with Klng79 main before guarded v2

- Eliminates the possibility that a plain `run` inherits a deployment default
  of `danger-full-access`.
- Prevents typoed workspace paths from silently creating new workspaces.
- Rejects missing permission projections, rejected prompt admission, missing
  terminal events, stale completion events, and mid-run permission drift.
- Restores `status`, `cancel`, version identity, JSON evidence, task files,
  title pinning, job markers, and marker-specific exit codes.
- Retains the newer prompt/fork/search/model features, custom permission
  presets, RPC timeout, and awaited Ctrl-C cancellation.
- Checks response type and RPC ID, preventing a mismatched response from being
  accepted as the current request.

## Tradeoffs and disadvantages

- Safe defaults require more explicit flags for workspace creation, write
  permission, full access, and mutating raw RPC calls.
- `prompt` with no permission flag resets the existing session to `read-only`;
  callers continuing authorized write work must repeat
  `--permission workspace-write`.
- Strict completion evidence can turn a Harness protocol incompatibility into a
  timeout instead of guessing that the task succeeded.
- Completion uses polling rather than the WebSocket event stream, so updates are
  not token-by-token and depend on `DSH_POLL_MS`/`--poll-ms`.
- The CLI remains a single dependency-free script; this simplifies installation
  but concentrates transport, policy, parsing, and presentation in one file.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DSH_URL` | `http://127.0.0.1:3080` | Harness Web server base URL |
| `DSH_POLL_MS` | `1000` | Completion polling interval |
| `DSH_RPC_TIMEOUT_MS` | `30000` | Timeout for one `/api` request |

## Testing

```sh
npm test
```

The dependency-free mock integration suite covers the upstream feature set and
the fail-closed regressions: default read-only ordering, missing workspace,
explicit workspace creation, missing permission projection, permission drift,
prompt rejection, missing/stale `turn/end`, unknown flags, and guarded raw RPC.

## Security boundary

Harness relies on a loopback/trusted-host fence rather than application
authentication. Do not expose it to an untrusted network. These guardrails
reduce accidental authority and ambiguous completion; they do not replace
operating-system isolation or human authorization.

## Credits

Klng79 created the original grouped-session RPC CLI and added multi-turn,
fork/search, model selection, deployment-aware permissions, request timeouts,
Ctrl-C cancellation, documentation, and the initial integration suite.

jnsys contributed the guarded-runner model and guarded v2 integration.

## License

MIT
