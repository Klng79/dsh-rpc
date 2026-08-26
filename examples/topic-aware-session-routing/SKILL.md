---
name: dsh-rpc-topic-routing
description: Route agent-managed DeepSeek Harness follow-ups to prompt, fork, or run with an orchestrator-owned job-to-session ledger, exact workspace checks, bounded history reuse, permission verification, and fail-closed topic matching. Use when an agent needs to continue related dsh-rpc work without creating a fresh session for every action.
---

# Topic-aware dsh-rpc session routing

Use this optional orchestration policy on top of `dsh-rpc`. Do not change the
CLI's core defaults, output formats, branding, or permission semantics.

## Verify the CLI and workspace

Run `dsh-rpc --version` and require the expected project identity before every
managed workflow. Read the target project's instructions yourself.

Run `dsh-rpc workspaces` and require the exact registered absolute path. Require
the known workspace title with `--require-title` when creating a session. Never
select a workspace from a partial path or create one unless the user explicitly
authorizes `--create-workspace`.

## Own a durable job ledger

The orchestrator, not `dsh-rpc`, owns the mapping between jobs and sessions.
Keep the ledger in durable private orchestrator state, outside the target
workspace. If it is file-backed, write it atomically, restrict it to the current
user, and never commit it.

Capture one record for every admitted job:

```json
{
  "jobId": "audit-login-20260818-a1",
  "sessionId": "session-xxxx",
  "parentSessionId": null,
  "workspacePath": "/absolute/path/to/project",
  "workspaceTitle": "project",
  "topicKey": "login-session-validation",
  "permission": "read-only",
  "command": "run",
  "historyPromptCount": 1,
  "historyStartedAt": "2026-08-18T08:00:00Z",
  "admittedAt": "2026-08-18T08:00:00Z",
  "completedAt": null,
  "outcome": null
}
```

Store only routing metadata. Do not store task text, assistant responses,
secrets, personal data, or repository contents in the ledger.

Treat session-ID capture as part of admission:

- `run --no-wait --json` returns the new `sessionId`.
- `prompt --json` returns the existing `sessionId` and `accepted: true`.
- `fork --no-wait --json` returns the child `sessionId`; record the parent ID.

Persist the admission record before monitoring. After completion, update its
completion time and terminal outcome. Increment `historyPromptCount` for every
accepted prompt, including the initial `run`. A fork inherits the parent's
history, so copy its `historyStartedAt` and set the child's count to the parent
count plus the forked prompt. Do not reset either bound merely because the
session ID changed.

If admission succeeds but the ledger write fails, keep the returned session ID
in the current report and do not auto-continue it later.

## Bound context reuse

Use these default limits unless the operator configures stricter ones:

- at most 6 admitted prompts in one session; and
- at most 24 hours since `historyStartedAt`.

Use `prompt` only while both limits pass. When either limit is reached, use a
fresh `run`. Do not use `fork` as a token-reset mechanism: a fork inherits
parent history and is useful for isolation, not for shrinking context.

## Match a topic conservatively

Prefer the session ID from the immediately preceding managed job in the current
orchestrator conversation. Otherwise query the ledger by exact workspace path
and topic key.

Assign a short stable topic key from the bounded outcome, not merely from file
names. Reuse it only when the new request explicitly depends on that outcome.

Only when the user explicitly asks to continue prior work and the ledger lacks
a usable record:

1. Run `dsh-rpc sessions` and `dsh-rpc search` with two or three distinctive
   topic terms.
2. Filter results to the exact workspace path.
3. Inspect every remaining candidate with `dsh-rpc history <sessionId>` and
   `dsh-rpc status <sessionId>`.
4. Never trust a search snippet or matching filename by itself.
5. Start a fresh `run` when zero or multiple candidates remain.

Do not auto-continue a search-recovered session when its prompt count or age
cannot be proven. A missing ledger must fail closed to `run`, not silently
bypass the reuse bounds.

## Choose the command

| Condition | Command |
|---|---|
| The admitted job is still running | Monitor `status`; do not submit duplicate work |
| One exact topic match, same bounded outcome, same permission, limits pass | `prompt` |
| Related new outcome, parent context is useful, authorization is sufficient, limits pass | `fork` |
| Explicitly authorized permission change where parent context remains useful and limits pass | `fork` |
| Topic differs, match is ambiguous, ledger is incomplete, or a limit is reached | `run` |
| Prior work failed, was cancelled, drifted permission, or used full access | `run` |

Always generate a new job ID for each independently verifiable outcome. Keep
exploration, editing, testing, and diff review for one outcome inside the same
job rather than treating each action as a new topic.

Require the final Harness response to end with exactly one marker containing
that job ID: `DEEPSEEK_DONE:<job-id>`, `DEEPSEEK_BLOCKED:<job-id>`, or
`DEEPSEEK_NEEDS_INPUT:<job-id>`.

Never auto-reuse a full-access session. Never interpret topic continuity as
authorization for writes, deployment, destructive actions, secret access,
commits, pushes, pull requests, or external messages.

## Submit with explicit evidence

Use an explicit permission for every managed job. The examples below choose
`read-only`; use a wider preset only when separately authorized.

Start fresh:

```text
dsh-rpc run
  --workspace <absolute-path>
  --require-title <title>
  --permission read-only
  --job-id <new-job-id>
  --no-wait
  --json
  -- <bounded-task>
```

Continue the same bounded outcome:

```text
dsh-rpc prompt <session-id>
  --permission read-only
  --job-id <new-job-id>
  --json
  -- <bounded-follow-up>
```

Branch related work:

```text
dsh-rpc fork <parent-session-id>
  --permission read-only
  --job-id <new-job-id>
  --no-wait
  --json
  -- <bounded-new-outcome>
```

For long instructions, use `--task-file` instead of positional task text.

## Verify admission and completion

Accept `run` only when JSON identifies a new session. Accept `prompt` only when
JSON contains the expected existing `sessionId` and `accepted: true`. Accept
`fork` only when JSON identifies a new child, then confirm through `sessions`
that its workspace path matches the parent and target workspace.

Poll `dsh-rpc status <sessionId>` in bounded intervals. Cancel and stop on a
pending approval, timeout, permission drift, scope deviation, or unsafe
ambiguity.

Accept completion only when status reports all of the following:

- `running` is `false`;
- `permission` matches the requested mode;
- `pendingApproval` is `null`;
- `turnEndReason` is `completed`;
- `outcome` matches the kind in the current job's terminal marker; and
- `assistantText` ends with the current job's exact terminal marker.

Update the ledger only from this verified evidence.

## Routing pseudocode

```text
job = createUniqueJob(request)
candidate = immediatelyPreviousLedgerEntry(request.workspace, request.topic)
         or uniqueLedgerMatch(request.workspace, request.topic)

if candidate is running:
    monitor(candidate.sessionId)
else if candidate is missing or ambiguous:
    runFresh(job)
else if candidate is unsafe, stale, at 6 prompts, or at 24 hours:
    runFresh(job)
else if request is the same outcome and permission is unchanged:
    prompt(candidate.sessionId, job)
else if request explicitly depends on prior context:
    fork(candidate.sessionId, job)
else:
    runFresh(job)

captureAdmissionInLedger(job)
monitorAndVerify(job)
captureCompletionInLedger(job)
```

## Report

State whether routing used a new, continued, or forked session. Report the
session ID, parent ID when applicable, job ID, workspace, permission, current
prompt count, session age, verification evidence, files changed or none,
blockers, and remaining risks.
