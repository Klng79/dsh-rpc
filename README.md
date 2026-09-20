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

The alternatives really are closed, not merely inconvenient (checked against
0.1.6): the workspace registry is mounted only in the web bundle, so every other
profile creates a session with a `cwd` and nothing else; and the tempting hybrid
— *group* a session through `/api`, then *drive* it with
`dsh --profile headless --session-id` — is refused in code, because web sessions
record an agent preset that the one-shot runner does not compose. It is `/api` or
nothing.

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
      --agent-preset <id>               agent preset for the new session (e.g. standard, ptc,
                                        minimal, cordis; deployment-defined)
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
      --at-seq <n>                      fork at the END of the completed turn containing event n;
                                        the child seeds that turn inclusive and nothing after it.
                                        Omitted or past the end = last completed turn; a turn
                                        that has not completed is an error
      --no-wait --permission,-p <mode> --model <model> --timeout <sec> --quiet
      --task-file --job-id <id> --json --poll-ms <ms>
dsh-rpc search <query>                  search the deployment's session history
dsh-rpc status <sessionId>              print structured JSON evidence about a session
                                        (running, title, permission, plan, agentPreset,
                                        modelSelection, goal, pendingApproval, turnEndReason,
                                        outcome, text)
dsh-rpc queue <sessionId>               list pending input (the inbox: next-turn / next-step)
      --json                            as JSON: id, placement, text, source
dsh-rpc queue <s> remove <itemId>       retract one pending item
dsh-rpc queue <s> steer <itemId>        promote one pending item to steer
dsh-rpc queue <s> edit <itemId> <text…> replace one pending item's text
dsh-rpc cancel <sessionId>              explicitly cancel a session
dsh-rpc rename <sessionId> <title…>     label a session (shows in the web UI and in status)
dsh-rpc history <sessionId>             print a session's messages (user turns, injected context
                                        labelled by source, assistant turns, tool results)
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
dsh-rpc status session-xxxx

# Run a stripped-down agent (presets change the whole toolset, not just a prompt)
dsh-rpc run "fix the failing test" --agent-preset minimal

# Retract a prompt you already submitted while a turn was running
dsh-rpc queue session-xxxx
dsh-rpc queue session-xxxx remove 6406db67-e102-4a89-95f2-317678873a72

# Label a run so it is identifiable later
dsh-rpc rename session-xxxx "nightly audit"

# Raw RPC
dsh-rpc call session/list '{"_request":{}}'
```

### Agent example: bounded topic-aware continuation

Agents do not have to create a fresh session for every closely related
follow-up. The optional
[topic-aware session routing skill](examples/topic-aware-session-routing/SKILL.md)
shows how an orchestrator can capture a `jobId` → `sessionId` ledger and choose
between `prompt`, `fork`, and `run` without changing this CLI's defaults.

The example fails closed to `run` when a topic match is ambiguous and bounds
reuse to six admitted prompts or 24 hours, whichever comes first. This keeps
short follow-ups efficient without encouraging unbounded history growth.

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
- The requested preset is **validated against the deployment's own catalog**
  before it is applied, so a preset the deployment doesn't define is rejected up
  front (instead of relying on a hardcoded list). The catalog is read from
  `permissionPresets/catalog` on dsh ≥ 0.1.6 and from the session's
  `permissions` projection (`options`) on 0.1.5 and earlier — see
  [Compatibility](#compatibility).
- On dsh ≥ 0.1.6 the validation happens **before the session is created**, so a
  typo'd preset costs nothing; on older builds it happens as soon as the new
  session can be asked.
- The chosen preset is applied via `commands/execute` and **verified** against
  the session's `permissions` projection before the task is submitted; a
  mismatch aborts the run.
- To see the presets a deployment actually offers, either read the "not offered"
  rejection (it lists the exact names) or ask directly:
  `dsh-rpc call permissionPresets/catalog '{}'`.

## Agent presets

`run --agent-preset <id>` picks the agent preset for a new session. A preset
changes the agent's whole composition — its toolset, not just a prompt — so it is
a bigger lever than it looks. Typical ids on a stock deployment:

| Preset | What it is |
|--------|------------|
| `standard` | Full coding agent: file editing, shell, search, skills, plan, goal, subagents, workflow |
| `ptc` | Same capabilities, but tools are reached through a programmatic-tool-calling SDK |
| `minimal` | A single persistent-shell tool |
| `cordis` | Standard plus runtime inspection and plugin/preset authoring |

Which presets exist is deployment-defined: `dsh-rpc` passes the id straight to
`session/create`, and dsh rejects an unknown one with its own message. Omit the
flag for the deployment default. The preset the session actually got is echoed
on stderr and is visible in `status` as `agentPreset`.

```sh
dsh-rpc call agentPresets/list '{}'   # discover the ids this deployment defines
```

## Supervising a session

Three commands cover the "what is it doing, and how do I change my mind" half of
driving an agent.

**`status`** prints structured JSON: `running`, `title`, `permission`, `plan`,
`agentPreset`, `modelSelection`, `goal`, `pendingApproval`, `turnEndReason`,
`outcome`, `assistantText`. Every field already rides the `session/follow`
snapshot, so it costs one stream and no extra RPCs.

**`queue`** reads and edits pending input. When you submit a prompt while a turn
is still running, dsh holds it in the session's **inbox** rather than dropping or
merging it — and `cancel` stops the *turn* but deliberately leaves the inbox
alone. Without a way to reach that inbox, a prompt submitted by mistake is
unretractable. It is also visible in the session's `inbox` projection:

```sh
$ dsh-rpc queue session-xxxx
next-turn	6406db67-e102-4a89-95f2-317678873a72	rewrite the parser tests
next-step	9f1c2ab4-...                          also update the changelog

$ dsh-rpc queue session-xxxx remove 6406db67-e102-4a89-95f2-317678873a72
removed 6406db67-... in session-xxxx
```

`next-turn` items wait for the current turn to finish; `next-step` items are
queued for the next model step. `steer` promotes an item so it is delivered at
the next step instead of the next turn; `edit` replaces its text (dsh accepts
text-only replacements, so attachments cannot be edited into an item).

**`rename`** labels a session. Titles are a projection, so a renamed session is
identifiable in the web UI and appears as `title` in `status` — but not in
`sessions`, whose rows carry no title field.

```sh
dsh-rpc rename session-xxxx "nightly audit"
```

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
deployment-aware `--permission` validation (both the 0.1.6 catalog path and the
≤ 0.1.5 projection fallback), the shared `run`/`prompt` completion path, `fork`,
`search`, `history`, `--agent-preset`, the `queue` lifecycle (list, `--json`,
remove/steer/edit, and the malformed-invocation guards), `rename`, `--model`
resolution (bare id, ambiguity, and `--provider` validation), `status`
projections, and auth-failure guidance.

**The mock models the server version it claims to.** A mock that encodes an old
projection shape certifies a server that no longer exists — which is exactly how
the 0.1.6 permission-catalog regression slipped through. Permission tests
therefore declare which build they model: `permissionPresets/catalog` plus a
`{currentValue}`-only projection for 0.1.6, or a 404 on that route plus an
`{options, currentValue}` projection for 0.1.5 and earlier.

## How it works

dsh (source build `dsh-v0.1.2-alpha.2` and later) exposes one unary RPC route
plus one WebSocket stream mux. Unary methods are HTTP POSTs to
`/api/<namespace>/<method>` with `Content-Type: application/json`; the payload
must carry exactly one `args` object whose keys match the server's generated
parameter wire names (`request` for most verbs, `_request` for `session/list`,
`agentId`/`line`/`submittedAttachments` for `commands/execute`). A verb the
server does not have answers **404 at the transport layer**, with no error
envelope — that is the signal dsh-rpc uses to feature-detect newer verbs:

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
`client-connection/browser-session`) or `DSH_AUTH_SECRET`; a missing credential
produces a clear error before anything reaches the server. The server
additionally enforces the **browser-trust fence** (loopback or trusted host).

A **stale** credential is the awkward case: the mux upgrade is rejected with a
bare WebSocket error carrying no HTTP status, so a wrong secret and a dead server
look identical at the socket. When the mux fails to connect, dsh-rpc probes the
unary route — which *does* carry a status — and reports what it finds, so a
rotated secret reads as `not authenticated (401)` instead of a misleading
"is the web UI running?".

Methods used here: `workspace/create`, `workspace/follow` (stream baseline;
replaces the old `workspace.list`), `session/create` (passing `workspaceId`
attaches/groups the session), `session/prompt` (client-minted `requestId`),
`session/list` (carries the `running` flag), `session/follow` (stream journal
snapshot + projections; replaces `session.history`), `session/fork` (branching),
`session/search`, `session/modelCatalog` + `session/selectModel` (`--model`),
`session/cancel`, `session/updateQueue` (`queue`), `session/rename` (`rename`),
`commands/execute` (permission presets), and `permissionPresets/catalog` (preset
discovery; absent before 0.1.6, which is detected rather than assumed).

**Event payloads are not uniform**, and getting this wrong fails silently.
`user/message` carries the message *directly* on `event.data`;
`assistant/message` and `tool/result` wrap theirs under `event.data.message`;
`turn/end` carries `data.reason.kind`; `permission/preset` carries `data.preset`;
`approval/asked`/`approval/decided` pair on `data.id`. `history` labels
non-`user`-sourced `user/message` events as injected context, because the loop
routes system-prompt additions, skill catalogues and notices through the same
event type as operator input.

**Completion detection** polls `session/list` for the session's `running`
flag, then reads the final assistant message from the `session/follow` snapshot
(which also carries the `permissions`, `plan`, `agentPreset`, `modelSelection`
and `goal` projections used by the permission guards and by `status`).

## Safety features

These opt-in guards harden unattended runs. They are additive — the default
`run`/`prompt` behavior is unchanged.

- **Permission control** (`--permission`). The preset is checked against the
  deployment's preset catalog — `permissionPresets/catalog` where the build
  exposes it (0.1.6+), else the session's `permissions` projection `options` —
  applied through `commands/execute` (`/permission <mode>`) and **verified**
  against the session's `permissions` projection before the task is submitted.
  On 0.1.6+ the catalog check runs before the session is created, so a bad
  preset costs nothing. `danger-full-access` additionally
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
| `not authenticated for <endpoint> (401)` | The secret doesn't match the server's (e.g. `~/.dsh/.credentials.yaml` is stale after a server reinstall). Re-run `dsh web` to re-mint it, or set `DSH_AUTH_SECRET` to the server's current secret. On a mux-based command (`workspaces`, `history`, `status`) dsh-rpc reports this by probing the unary route, because a rejected WebSocket upgrade carries no status. |
| `permission "<mode>" is not offered by this deployment` | The preset isn't in the deployment's catalog. The message lists the exact names this deployment defines. |
| `could not set permission "<mode>"` | The `/permission` command itself rejected the preset. Presets are deployment config — the rejection text names the available ones. |
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
  supported.** dsh-rpc 0.5.0 targets the 0.1.2+ authed, namespaced surface
  exclusively.
- **The `/api` bridge is unversioned upstream.** dsh publishes no wire version,
  no deprecation policy, and no compatibility promise for it — dsh-rpc lives on
  feature detection and a verified-version record, not a contract. See
  [Compatibility](#compatibility).
- **Workspace matching resolves symlinks.** Both the target path and each
  registered workspace path are realpath'd before comparison, so `/tmp/x`
  finds the workspace registered as `/private/tmp/x` (macOS). Creation passes
  the path you give; the server canonicalizes it.
- **`run` always starts a fresh session.** Use `prompt <sessionId>` to continue
  an existing one, or `fork <sessionId>` to branch off it into a new session.
- **A running dsh web server is required** for every command.

## Compatibility

dsh-rpc sits on `/api`, the web GUI's own wire, which dsh does **not** version,
publish, or promise to keep stable — the top-level project README warns that
breaking changes will land during developer preview. Two consequences shape how
this tool is built:

- **It feature-detects; it never reads a version.** There is no server version
  string on the wire to read. Where a capability moved between releases, dsh-rpc
  asks for the new thing and falls back on the transport-level 404 that an
  absent verb returns. The permission catalog is the worked example:
  `permissionPresets/catalog` on 0.1.6+, the session `permissions` projection
  `options` on 0.1.5 and earlier.
- **It records what was verified, not what is assumed.** The section below names
  the build each release was exercised against. "Shape-compatible" is not the
  same as "behaviour-compatible": the permission-catalog change was a silent
  data-shape move that no request/response diff would have shown.

If a future dsh release mounts the workspace registry outside the web profile —
or lets headless or the SDK attach a session to a workspace — the reason to
exist for the `/api` route disappears and this tool should migrate. Until then,
grouping is reachable only through `/api`.

## Credits

The permission-via-`commands/execute` technique, the `turn/end: completed`
completion gate, and the approval/timeout-cancel behavior were adapted from a
contributed "guarded runner" proposal
([issue #1 / PR #2](https://github.com/Klng79/dsh-rpc/pull/2)). Thanks!

## Verified against

- **dsh 0.1.6-alpha.1** (`~/Desktop/Developer/deepseek-harness`, source tree at
  `dsh-v0.1.6-alpha.1-5-g0d1f50007f`; the `dsh-v0.1.6-alpha.2` tag was also read
  for the diff), verified live 2026-09-19 (dsh-rpc 0.4.0–0.5.0). All 12 RPCs'
  request/response shapes, the `client-request`/`server-response` envelope, the
  browser-auth cookie, and the `/api/remote.mux` framing are **byte-identical**
  to 0.1.5-rc.2 — the whole `session-controller/src/types.ts` diff for the jump
  is three additive hunks (`session/writer-held` added, `SkillEntry.path` added,
  `session/control` queue types removed). Two behaviour changes did land, and
  both are handled:
  - **`permissions` projection dropped `options`** (moved to the new
    `permissionPresets/catalog` Remote). This silently disabled dsh-rpc's
    deployment pre-check; it now reads the catalog, and validates *before*
    creating a session when the catalog is available.
  - **`session/fork` cut point.** `atSeq` now seeds exactly the turn containing
    the anchor (`boundary.seq + 1`) instead of sweeping the following
    between-turn events — including a queued input the old cut could carry into
    the child — into the seed. Documented under `--at-seq`.
  - Also fixed in this release, found while auditing event shapes against
    0.1.6: `history` had **never** printed user turns (it read `data.message` on
    a `user/message` event, whose data *is* the message). Every release since
    0.1.2 was affected; the mock encoded the same wrong assumption, so no test
    caught it.
  - Live-verified: `workspaces`, `sessions`, `run` (prompt → completion gate →
    final text), `--permission` apply+verify, fail-fast preset rejection with no
    session created, `history`, `status`, `fork`, `cancel`, `search`, the full
    `queue` lifecycle (list a prompt held in the inbox while a turn ran, `remove`
    it, confirm the inbox emptied — which also confirms `cancel` keeps the inbox),
    `rename`, and the stale-credential / unreachable-server / unknown-session
    failure paths. `npm test` 59/59.
  - Alpha.2-only, **not** yet handled (absent at alpha.1): the `session/writer-held`
    error code, and `session/control` losing its queue frames — the latter unused
    by dsh-rpc. `session/updateQueue` resolving cold agents is handled implicitly:
    `queue` addresses items the snapshot just reported, and the verb is a write,
    so a build with cold-resolution only widens what already works.
- dsh 0.1.5-rc.2 (`~/Desktop/Developer/deepseek-harness`, master), verified live
  2026-09-11 (dsh-rpc 0.3.1): the wire surface was unchanged through the
  0.1.2 → 0.1.5 jump — browser-auth cookies, `/api/<ns>/<m>` routes with
  `{args}` payloads and the `client-request`/`server-response` envelope,
  `/api/remote.mux` framing (`workspace/follow` baseline `value.items`,
  `session/follow` snapshot with `records`/`projections`), the `commands/execute`
  `submittedAttachments: []` arg, and all 12 RPCs (`session/*`, `workspace/*`).
  Smoke-tested live (workspaces, sessions, history) plus `npm test` 44/44.
  The 0.1.5 changes that landed (session-format V3, `SessionHandle` lifecycle,
  `str_replace_editor` tool default) are on the Python SDK/plugin side, not the
  web-`/api` wire dsh-rpc talks to.
- dsh source build `dsh-v0.1.3-alpha.1` (`~/Desktop/Developer/deepseek-harness`),
  verified live 2026-09-04 (dsh-rpc 0.3.1): `commands/execute` renamed its
  attachments argument from `images` to `submittedAttachments` (a union of
  encoded images and staged file receipts, added for the new arbitrary-file
  upload feature) — arg validation rejects unknown fields, so dsh-rpc sends
  `submittedAttachments: []`. The rest of the surface (browser-auth cookies,
  `/api/<ns>/<m>` routes with `{args}` payloads, `session/follow` snapshots,
  history) is unchanged from 0.1.2. Known upstream issue in this release: a
  performance regression when loading some historical sessions.
- dsh source build `dsh-v0.1.2-alpha.3` (`~/Desktop/Developer/deepseek-harness`),
  verified live 2026-09-01: browser-auth cookies, `/api/<ns>/<m>` routes with
  `{args}` payloads, `commands/execute` with `images: []`, and the
  `/api/remote.mux` stream surface (`workspace/follow` baseline,
  `session/follow` snapshot with projections).

Older notes: on the 0.1.1-rc.2 and 0.1.2 releases, `commands/execute` required
an `images` argument (dsh-rpc sends `images: []` — it never attaches media);
dsh 0.1.3+ renamed it to `submittedAttachments`.

## License

MIT
