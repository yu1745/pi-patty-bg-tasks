# v2 issue remediation

Scope: installed fork at `2b2cf4b` (v2, based on `697010e`), not v1 patches. No commits, pushes, Pi reloads, dependency changes or unrelated package edits. Read the full installed official `docs/extensions.md` and linked `docs/tui.md`; reviewed upstream audit #11, stale-context #24/#16/#18, optional-agent #12, and PR #20. PR #20's cooperative signal hooks alone cannot cover SIGKILL, so this implementation uses a POSIX process-group supervisor with a parent-owned IPC lifetime.

## Issues

| Issue | Status / design | Verification |
| --- | --- | --- |
| #14 headless timeout | Confirmed, fixed: timeout requests promotion regardless of interactive mode. The existing quick-completion window and timeout/manual result strings remain. | `bash-results.test.ts` headless timeout regression |
| #22 print-mode premature exit | Confirmed, fixed: foreground child handle remains referenced; `release()` unrefs on promotion/finally. Explicit jobs attach holds a referenced timer only during its wait. | `headless-ref.test.ts`, `spawn-security.test.ts`: isolated Node processes, not runner references |
| #25 attach wait:false | Confirmed, fixed: running result, no terminal toast or notification latch. Obsolete `skipWait` is not present in this fork. | `jobs.test.ts` nonblocking attach |
| #24/#16/#18 stale contexts | Confirmed, fixed: generation/disposal fence prevents old completion, warning, retry and stream sends. Session-bound `onExit` is skipped after disposal; resource-only `onCleanup` always runs, and terminal state/timers/log cleanup do not use stale UI. | `disposal.test.ts`, `lifecycle-audit.test.ts`: late exits after disposal/replacement and queued retry fencing |
| #8 orphan cleanup | Confirmed, fixed for ordinary POSIX process-group descendants, including hard parent death. Shell, agent and command-monitor sources share the supervisor; IPC EOF cleanup never targets a recycled group ID. | `spawn-security.test.ts`, `monitor-parent.test.ts`, `descendants.test.ts`: hard SIGKILL, shell exit, no background host reference and late-owned-PID signal suppression |
| #12 optional agent_bg | Fixed via `PI_PATTY_DISABLE_AGENT_BG=1`, `true`, or `yes`; enabled by default. Use this when another subagent extension provides routing/policies. | `index.test.ts` verifies both modes and unaffected tools |

## #11 audit items

| Item | Status / design | Verification surface |
| --- | --- | --- |
| 1 completion send latch | Confirmed, fixed: latch only successful sends; bounded retry while runtime remains active. | notification retry tests |
| 2 swallowed stall/oversize warnings | Confirmed, fixed: failed delivery is diagnosed, not silently treated as delivered; oversize safety action still runs. | monitoring delivery-failure regressions |
| 3 monitor timer send exceptions | Confirmed, fixed: delivery failures cannot escape timer; stop/fail source. | monitor session/follower regressions |
| 4 optimistic kill | Confirmed, fixed: bounded TERM then KILL; jobs, shortcut and panel kill paths await confirmation and do not claim success on failure. Shutdown awaits cleanup. UI feedback is fenced during that wait. | lifecycle resistant-process tests, `ui-kill.test.ts`, jobs/index tests |
| 5 descendants after shell exit | Confirmed, fixed: supervisor cleans group after command exit while forwarding original command result. | spawn tests, hard-death regression |
| 6 hard host termination / PID reuse | Confirmed, fixed within POSIX process groups: IPC EOF is independent of host hooks; live supervisor anchors group identity. Per-spawn capabilities retain ownership across PID reassignment; parent kill/liveness never recover authority from a PID. | separate host SIGKILL tests; deterministic reassignment in `spawn-identity.test.ts` |
| 7 attach dead-PID race | Confirmed, fixed: removed speculative failure marking; authoritative exit callback owns status and cleanup. | jobs/lifecycle tests |
| 8 external foreground signal success | Confirmed, fixed: external signal death throws with signal name; genuine turn cancellation retains cancel semantics. | bash-results signal regression |
| 9 output bounds | Confirmed, fixed: sampled 100 MiB ordinary-job cap (foreground 200 ms; background 5 s); monitor stdout/stderr each retain at most 1 MiB with rotation. Persistent means no deadline, not unlimited disk. | `bash-results.test.ts` sparse oversized foreground log; `monitor-bounded.test.ts`; monitoring tests |
| 10 log retention leaks | Confirmed, fixed for tracked jobs: ring eviction, explicit cleanup, orderly shutdown and late disposed completion remove stdout and stderr. Empty private directories and hard-crash remnants follow OS temp policy. | `retention.test.ts`, `disposal.test.ts`, index shutdown regressions |
| 11 whole-delta allocation / queue | Confirmed, fixed: bounded chunk, line, batch and final flush; rate guard before message construction. No local unbounded retry queue. | burst/long-line/final-flush monitor tests |
| 12 websocket constructor fd leak | Confirmed, fixed: close capture on synchronous constructor failure. | websocket failure tests |
| 13 websocket capture failures | Confirmed, fixed: fail source and close socket rather than swallowing writes. | websocket capture-failure tests |
| 14 stale job_decide docs | Confirmed historical drift, fixed: current README explicitly says absent in v2; historical release notes labeled v1. | source/docs review |
| 15 unused Job.proc | Confirmed, fixed: removed dead field/import/branches. Production retains a per-spawn identity capability, with PID used for display/sampling, not a fabricated Job.proc reference. | typecheck/source review |
| 16 shared temporary storage | Confirmed, fixed: TMPDIR-aware owner-private random root; exclusive no-follow 0600 output; exclusive 0600 continuity prompts inside private root. | spawn security and retention tests |

## Independent-review follow-up

1. **PID-only tombstone overwrite: confirmed, fixed.** The original PID→boolean map was unsafe when B reused exited A's PID. It is removed, not bounded or renamed. A `WeakMap` keyed by an immutable per-spawn capability tracks only that capability's lifetime, releases its child reference on exit/error, and does not retain numeric-PID tombstones. `SpawnResult`, `Job`, command-monitor sources, foreground cancel/output guards, bash_bg deadlines, and TERM→KILL cleanup retain the capability. POSIX signaling requests go over the original supervisor's IPC channel; the live supervisor signals its own group. There is no PID fallback, and bare numeric or forged capabilities are rejected. Windows/direct children use the captured `ChildProcess` handle. The watchdog is advisory and does not terminate processes; its PID sampling is unchanged.
   - Deterministic regression mocks A and B with PID `424242`, exits A before spawning B, then invokes delayed A cleanup, bare-PID and forged-capability kills. B receives no signal or probe; B's own capability still works. Stale `Job` cleanup is also covered. This extends the previous tombstone-only regression.
2. **Unconditional Unix permission validation on Windows: confirmed, fixed.** `isSafeLogDirectory` still rejects non-directories/symlinks on all platforms, but owner/mode checks and `getuid` are POSIX-only. Virtual Windows stats with synthesized writable bits are accepted; equivalent unsafe POSIX stats and foreign owners remain rejected. The test does not require a Windows runner and also ensures the Windows branch does not call `getuid`.
   - **Windows is not runtime verified.** Random/exclusive temp creation remains, but Windows inherits the configured temp parent's ACL; Unix `0700`/`0600` modes do not establish ACL privacy. Use a trusted, user-private temp directory and ensure `bash` is available. Native Job Objects would be needed for Windows descendant/hard-parent-death containment.

## Limitations

- POSIX descendants deliberately escaping the process group with `setsid`/`setpgid` are outside this containment. Independently killing the supervisor itself before cleanup can also defeat protection. Stronger containment requires cgroups/service manager integration. Windows needs a native Job Object and currently uses direct spawn. Machine/power failure is not a cleanup guarantee; killed children may remain zombies until OS reaping.
- Ordinary shell/agent output caps are sampled, not kernel disk quotas: fast producers can overshoot between samples. Monitor rolling retention discards old output; logs are not a lossless infinite archive. Bounded final flush may report omitted backlog.
- Pi's passive message delivery has no queue acknowledgement API. Local batches/rate are bounded; this extension cannot bound Pi's internal accumulated transcript/queue over an indefinitely long watch.
- Hard-crash temporary logs and empty private directories are left to the OS temporary-file policy. Cleanup, ring eviction and orderly disposal handle tracked captures, not directories from dead runtimes. No cross-session task revival is added.
- Failed notification delivery cannot be guaranteed across runtime shutdown. Retries stop at disposal; old runtimes never send into a replacement session.
- Semantic watchdog and steering-resubmit architecture are preserved; existing regression suites remain part of full verification.

## Verification

Final stable verification (Node on Linux):

- `npm run check`: passed (`tsc --noEmit`).
- `npm test`: **220 passed**, 0 failed/cancelled/skipped (62 suites), including the independent-review fixes.
- Additional `node --experimental-strip-types --test` run, **without `--test-force-exit`**, over headless-ref, spawn-security, spawn-identity, monitor-parent, descendants, disposal, lifecycle-audit, monitor-bounded and ui-kill: **30 passed**, natural process exit.
- `git diff --check`: passed.
- Existing steering-resubmit/input, cancellation, semantic-watchdog and trace tests are included in the passing full suite; an additional session-reuse regression checks watchdog tracking is recreated after disposal. The watchdog implementation was not rewritten.

Intermediate failures were corrected rather than hidden: missing signal text, insecure legacy temp fixtures, an incomplete WebSocket mock, outdated expectations for disposed-runtime job listings, and a test awaiting an intentionally unreferenced background source without a bounded keepalive. A secure-prompt `writeFileSync` numeric-flag type error was corrected by opening with numeric exclusive/no-follow flags and writing through the descriptor. The follow-up's capability-only kill signature intentionally exposed PID-only test callers during typecheck; those fixtures now retain capabilities (numeric invalid-input tests explicitly verify rejection). No outstanding test/typecheck failure remains.
