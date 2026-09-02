# dsh-rpc — Improvement Proposals (2026-08)

Status: **DRAFT for discussion** — no code changed. Per the repo's issue-first
convention, behavior-changing items below should become issues before any PR.

## Current state

`dsh-rpc` v0.2.0 is a dependency-free Node (>=18) CLI over the DeepSeek Harness
`/api` loopback RPC bridge. It creates **workspace-grouped** sessions (same path
the web UI uses) and drives them with `run`/`prompt`/`fork`, hardened by opt-in
guards: deployment-aware `--permission` apply+verify, permission-drift
detection, checkpointed completion (stale `turn/end` never reused), a strong
completion gate, and approval/timeout/Ctrl-C cancel. 37 `node:test` tests run
against an in-process mock of the bridge. Core uses only global `fetch`/`crypto`.

Already in flight and **out of scope here**: issue #5 + PRs #6/#7 (topic-aware
*session-continuation*, deliberately docs/examples-only), and issue #8 (closed
as upstream — blocked on a missing `workspace.attachSession` RPC).

---

## Ranked proposals

### 1. Normalize workspace path matching (symlinks) — **RECOMMEND (do)**

**Gap (verified):** `findWorkspaceByPath` (line 163) does an exact `w.path ===
absPath` string match, and `resolvePath` (lines 123–128) only prefixes cwd — it
never resolves symlinks. On macOS `/tmp/x` and `/private/tmp/x` (and any
symlinked project dir) are treated as distinct, so a `run` from inside a real
dir can fail with "workspace not found" even though the workspace exists — or
`--create-workspace` silently mints a duplicate. The README already documents
this as a gotcha.

**Change:** in the workspace **lookup/match step only**, compare
`fs.realpathSync(path)` of the requested path against `fs.realpathSync` of each
registered `w.path`. Keep the stored/created path as-is (display unchanged);
realpath is a match-time normalization, wrapped in try/catch so a missing or
unresolvable path falls back to the current exact-match behavior.

- **Blast radius:** small, localized to one helper. **Non-breaking** for the
  common already-canonical case (realpath is a no-op).
- **Dependency-free:** yes — `fs` only.
- **Effort:** S.
- **Done when:**
  1. A workspace registered at the canonical path is matched when invoked with
     an equivalent symlinked path (new test: mock returns `/private/tmp/w`,
     caller passes `/tmp/w` → resolves to that workspace, no create).
  2. An unrelated path still correctly misses (no false match).
  3. `npm test` stays green; all existing exact-path tests pass unmodified.

### 2. Live progress via the `/api/events.*` WebSocket — **DEFER (needs a decision)**

**Gap (verified):** completion/progress is detected by polling `session.list`
(`running`) + `session.history` every `DSH_POLL_MS`, so latency ≈ poll interval
and there's no incremental stream (README "Polling, not streaming"). The
`/api/events.mux` and `/api/events.host` downlinks are intentionally unused.

**Change (sketch):** when a global `WebSocket` is available (Node >=22; this
box runs 24), subscribe to the host/session-status downlink to drive completion
instead of polling; **keep polling as the automatic fallback** under `>=18`.

- **The real cost — a baseline decision:** global `WebSocket` is **not** present
  in Node 18/20, which the package currently claims (`engines.node: ">=18"`). A
  zero-dep raw `net`+`crypto` WebSocket handshake would avoid the version bump
  but is exactly the kind of scope creep that sank PR #3. So this item is
  fundamentally: *"raise the floor to Node >=22, or not?"* — not a pure code call.
- **Blast radius:** large-ish (new I/O path, lifecycle, reconnect); **risk of
  behavioral divergence** between stream and poll paths.
- **Dependency-free:** yes, *only if* the engines floor is raised (or a
  capability-gated dual path is added).
- **Effort:** M–L.
- **Recommendation:** **defer.** Highest user-visible value but collides head-on
  with the dependency-free + thin-boundary constraints. If pursued, open an
  issue to decide the Node baseline *first*; opt-in flag, poll stays default.
- **Done when (if ever accepted):** opt-in flag completes a run via WS; with the
  flag absent, behavior is byte-identical to today (poll path); a test asserts
  the fallback triggers when `WebSocket` is undefined.

### 3. `attach` / `move` convenience for ungrouped sessions — **REJECT (blocked upstream)**

**Gap:** headless (`dsh --profile headless`) sessions land ungrouped with no way
to regroup. **Blocked:** `@deepseek-ai/dsh` exposes no `workspace.attachSession`
RPC (issue #8, closed as upstream). The existing `call <method>` escape hatch
already forwards to it the instant the server ships it, so a dedicated
subcommand now would wrap a method that returns an error.
- **Recommendation:** reject as a dsh-rpc change; track it by filing/upvoting
  the server-side request upstream. Revisit only when the RPC exists (then it's
  an S-sized thin wrapper).

### 4. Core session-reuse cache for `run` — **REJECT (thin boundary)**

Tempting given the #5 pain point, but hardening "when to reuse a session"
heuristics into the CLI is the exact policy-in-core move PR #3 was declined
for. That guidance belongs in the #5 docs skill, not the driver. The #5 branch
should ship, not be absorbed here.

### 5. Machine-readable discovery filters — **NICE-TO-HAVE (optional)**

Small additive ergonomics that stay non-breaking (defaults untouched): a
`--json` on `history`, and/or a `--limit`/`--workspace <id>` filter on
`sessions`. Low value, low risk; bundle into another PR if a caller needs it,
otherwise skip rather than churn the surface.

---

## Recommended next step

Ship **#1 (symlink-safe path matching)** now — it's the one clearly-worth-it,
low-risk, non-breaking, dependency-free fix, and it has an obvious test. It's
small enough to go straight to a PR per the repo's own convention.

Open an **issue** for **#2** framed purely as a Node-baseline decision (don't
write code until the `>=18` vs `>=22` call is made). Leave **#3** and **#4**
as rejects with the reasons above so the trail is explicit.
