---
name: dsh-session-continuation
description: Decide whether an agent follow-up should reuse an existing dsh session (prompt/fork) or start a fresh one (run). Use when an agent integration has just dispatched a task via dsh-rpc and the next user request is a possible follow-up to the same topic.
---

# dsh-session-continuation — topic-aware session reuse

An optional, orchestrator-owned policy for agent integrations using
[`dsh-rpc`](https://github.com/Klng79/dsh-rpc). It decides **which command to
issue** for a request that *might* be a continuation of prior work:

- `prompt <sessionId>` — reuse the same session for a direct follow-up.
- `fork <sessionId>` — branch when prior context helps but the outcome is new.
- `run <task>` — fresh session (the safe default).

This skill is **documentation/example only**. It changes no CLI defaults and
does not alter dsh-rpc behavior. It is guidance for the *agent/orchestrator*
that drives dsh-rpc, not a change to dsh-rpc itself.

## Guardrail first: this saves tokens only when history is SHORT

Reusing a session re-sends the **entire** session history on every `prompt`.
Cost grows with session length, so reuse wins only for short, closely-related
follow-ups and becomes a **net loss** once history is long.

> **Cutoff rule (mandatory).** Before reusing a session, check its length and
> age. If the candidate session exceeds **~8 turns** or is **~older than 30
> minutes**, fall back to `fork` (context useful) or `run` (fresh). Do **not**
> reuse a long or stale session to "save tokens" — it does the opposite.

Treat this policy as a **guardrail for session hygiene**, not a token-saving
feature. The durable win is avoiding *repeated repository exploration* on
genuine follow-ups, not replaying history.

## The four identities

Keep these separate and never collapse them:

| Identity | What it is | Provided by |
|----------|------------|-------------|
| **workspace** | the grouping path (a directory) | `workspaces`, `--workspace` |
| **topic** | the *intent* of the work | inferred, never a CLI field |
| **session** | one dsh chat instance | `run`/`prompt`/`fork` return its id |
| **job** | one independently verifiable outcome | `--job-id`, unique per outcome |

A session may carry several jobs; a job must never span ambiguous topics.

## Orchestrator-owned job ledger (Rule 2 — do not skip)

The CLI does **not** persist a job-id→session mapping. `--job-id` is validated
only inside a single run's terminal output, and there is no command to look up
a session by a prior job-id. **The orchestrator owns this ledger.**

1. **Capture the session id every time you dispatch.** Both `run --json` and
   `prompt --json` emit a session id field; plain text prints it too. Record
   `{ sessionId, jobId, workspace, topic, turnCount, ts }` in orchestrator
   state.
2. "Prefer the session recorded by the immediately preceding job" means **look
   up your own ledger by the last `jobId`** — never guess the session id from
   memory.
3. If the ledger has no entry for the preceding job, **stop and fall back to
   `run`**. Do not silently assume the "last session you remember" is correct.

## Decision table

Map request → command. **Match all guardrails before any reuse; otherwise `run`.**

| # | Condition | Action |
|---|-----------|--------|
| 1 | Topic is clearly different from the last job | `run` |
| 2 | No ledger entry for the preceding job id | `run` |
| 3 | Ledger session is **long** (>8 turns) or **stale** (>30 min) | `fork` if prior context useful, else `run` |
| 4 | Workspace path does not exactly match the request | `run` |
| 5 | `search`/`history` returns **more than one** unambiguous candidate | `run` |
| 6 | Session is **running**, has pending approval, or permission not set/appropriate | wait or `run`; never queue blindly |
| 7 | Search snippets alone are the only evidence | **`run`** — never select on snippets alone |
| 8 | Direct follow-up, single candidate, idle, checks pass | `prompt <sessionId>` |
| 9 | Prior context useful but **new, independently verifiable outcome / permission boundary** | `fork <sessionId>` |
| 10 | New outcome → **always new `--job-id`**, even on `prompt`/`fork` | record in ledger |

## Procedure (pseudocode)

```
fn select_session(request):
  led = ledger.lookup(lastJobId)          # must be present — else fail
  if led is None:                          return run(request)
  if request.workspace != led.workspace:   return run(request)
  if led.turnCount > 8 or age(led) > 30m:  return fork_or_run(request, led)   # rule 3
  if request.topic differs from led.topic: return run(request)

  candidates = search(request.topic)       # snippet matches only
  if len(candidates) != 1:                return run(request)
  cand = candidates[0]
  if cand.sessionId != led.sessionId:     return run(request)   # snippet alone insufficient
  st = status(cand.sessionId)
  if st.running or st.pendingApproval:    return wait_or_run(st)
  if not has_permission(request, st):     return run(request)    # never reuse with wrong permission

  if request is direct continuation and same bounded outcome:
      return prompt(cand.sessionId, request, jobId=nextJobId())
  else:  # prior context useful but new outcome / permission boundary
      return fork(cand.sessionId, request, jobId=nextJobId())
```

## Command reference (all existing)

- `run <task> [-w <path>] [-p <mode>] [--job-id <id>] [--json]` — fresh session.
- `prompt <sessionId> [--wait] [--job-id <id>] [--json] <text>` — continue.
- `fork <sessionId> [--at-seq <n>] [--job-id <id>] [--json] <text>` — branch.
- `sessions`, `status <sessionId>`, `history <sessionId>`, `search <query…>` — inspect.
- `--permission <mode>` on `run`/`prompt` — set + verify before the task.

## Safety (fail closed)

- **Never** select a session on search snippets alone.
- **Never** match topic continuity on filenames alone.
- Require the **exact** workspace path and **exactly one** unambiguous candidate.
- Only continue when the session is **idle**, its latest turn **completed**, no
  approval is pending, and permission is appropriate.
- Any uncertainty → fresh `run`. A new `--job-id` marks every independently
  verifiable outcome, even when reusing a session.

## Boundaries

- This is orchestrator-owned documentation. Do **not** harden these heuristics
  into dsh-rpc CLI defaults without a separate issue + proposal.
- This skill intentionally leaves dsh-rpc behavior, branding, and defaults
  unchanged.
