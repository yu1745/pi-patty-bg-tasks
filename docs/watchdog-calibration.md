# Semantic watchdog calibration

Calibration date: 2026-09-18. This is a development record, not a claim of population-level accuracy.

## Historical sweep

The scanner read every `*.jsonl` under Pi's local session root (1,793 files, about 1.1 GB) and parsed every line successfully. It retained 843 records with either a structured tool duration of at least 60 seconds or an explicit timeout/auto-background signature:

- 531 records had a structured duration of at least 60 seconds.
- 358 records contained an explicit timeout or auto-background signature.
- These sets overlap.

Durations embedded in arbitrary tool output were deliberately ignored. An earlier draft incorrectly interpreted strings such as image dimensions `(1128h)` as elapsed time; the final counts above use structured duration metadata and recognized completion messages only.

No whole transcript was sent to TypeSafe. Calibration requests contained a redacted command, bounded log/task context, and synthetic process telemetry shaped like the observed run.

## Selected historical positives

| Case | Historical locator | Why operator inspection was warranted |
|---|---|---|
| Missed crash marker | session `01a09b0c-9ce3-7370-9733-767e5e5fc429`, lines 537–542 | The loop waited for `PASS|FAIL|timed out|EXIT=` while its referenced log already said `server crash signature detected`; it remained alive until supervision killed the obsolete waiter. |
| Home-wide binary search | session `01a09ad8-5d3f-74ee-8617-536b4147c707`, line 101 | `fd tsc /home/wangyu/` traversed an unnecessarily broad home tree, auto-backgrounded after 120 seconds, and was then abandoned. |
| Root-wide cache search | session `01a09c26-c897-7370-9733-7698305bac0f`, line 109 | A `find / ...` fallback searched the whole filesystem for a cache artifact despite narrower known cache locations, then auto-backgrounded after 120 seconds. |

Two additional positive fixtures model recurring failure shapes: a detached process waiting for unavailable stdin, and a polling loop whose required producer has explicitly exited. Negatives model a CPU-active compile, an explicit finite sleep, an intentional server, a progressing download, quiet CPU-heavy computation, and a bounded polling loop.

## Prompt iterations

All 11 cases were evaluated independently with `jev-latest` (`jev-1.13.0` at calibration time) to avoid cross-case contamination.

1. **Broad holistic questions (v1).** Asked whether the task was “operationally stuck” and “should alert.” At the original very high gate, it detected 0/5 positives. The model often identified the right `Choice` cause but returned appropriately uncertain broad Noul probabilities.
2. **Expanded holistic policy (v2).** Added mistaken-scope language and stronger contrasts. It improved cause selection but still detected 0/5 positives at the original `.90/.85/.20` composite gate.
3. **Atomic evidence questions (v3).** Replaced the broad classifier with independent Noul questions for missed terminal state, unavailable input, dead dependency, mistaken scope, and repeating non-progress. Code takes the maximum blocking-evidence probability, then suppresses alerts when credible progress, an indefinite service, or a valid finite wait is probable.

At the selected advisory gate (blocking evidence ≥ `.70`; each suppression signal ≤ `.50`), v3 classified all 5 positive fixtures and none of 6 negative fixtures in this single calibration pass. Positive maximum evidence scores were `.72–.95`; negative maximum evidence scores were `.04–.15`. Scope/repetition alerts require the gate twice consecutively. Direct evidence—missed terminal state, unavailable stdin, or a dead dependency—may alert after one ≥ `.85` result. All alerts have a 15-minute cooldown.

The missed-marker case also changed telemetry design: Patty's own job log can be empty while the command polls another log. The watchdog therefore includes bounded tails from at most three absolute `.log`, `.out`, or `.txt` paths explicitly named by the command. It does not crawl directories or send arbitrary session history.

## Interpretation

The calibration supports the architecture, not universal accuracy. The alert is low stakes and reversible, but false positives are still disruptive; therefore the watchdog never kills a process, skips declared persistent monitors, retains two-sample confirmation for intent-sensitive scope/repetition judgments, and exposes manual inspection/status controls. Thresholds should be revisited as real alerts accumulate.

## Low-latency profile

Because Jev input is inexpensive relative to the operator time lost to an obvious blocked wait, the runtime profile was tightened after calibration: bash auto-backgrounds after 60 seconds; sampling runs every 15 seconds; minimum age and quiet gates are 30 seconds; ambiguous checks repeat after 30 seconds; repetitive output qualifies after 60 seconds; and the Jev per-attempt deadline is 10 seconds. This yields an expected first direct-evidence alert about 30 seconds after backgrounding and an ambiguous two-sample alert about 60 seconds after backgrounding, while stricter `.50` healthy-work suppression limits the additional false-positive risk.
