import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    WATCHDOG_TRACE_MAX_BYTES,
    boundJson,
    createWatchdogTrace,
    resolveWatchdogTracePath,
    summarizeTail,
} from "../watchdog/trace.ts";
import { formatWatchdogTraceStats, readWatchdogTrace } from "../watchdog/trace-report.ts";

const readLines = async (path: string) =>
    (await readFile(path, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));

void describe("watchdog trace", () => {
    void it("resolves a default path, honours an explicit override, and can be disabled", () => {
        assert.equal(
            resolveWatchdogTracePath({ PI_CODING_AGENT_DIR: "/tmp/agentdir" } as NodeJS.ProcessEnv),
            "/tmp/agentdir/watchdog/events.jsonl",
        );
        assert.equal(
            resolveWatchdogTracePath({ PI_PATTY_WATCHDOG_LOG: "/tmp/custom.jsonl", NODE_TEST_CONTEXT: "child-v8" } as NodeJS.ProcessEnv),
            "/tmp/custom.jsonl",
            "an explicit path wins even under the test runner",
        );
        for (const value of ["0", "off", "false", "no", "none", ""]) {
            assert.equal(
                resolveWatchdogTracePath({ PI_PATTY_WATCHDOG_LOG: value } as NodeJS.ProcessEnv),
                undefined,
                `${JSON.stringify(value)} disables tracing`,
            );
        }
        assert.equal(
            resolveWatchdogTracePath({ NODE_TEST_CONTEXT: "child-v8" } as NodeJS.ProcessEnv),
            undefined,
            "the test runner must not write into a real session trace",
        );
    });

    void it("appends one JSON object per line with event, timestamp, and metadata", async () => {
        const root = await mkdtemp(join(tmpdir(), "patty-trace-"));
        const path = join(root, "nested", "events.jsonl");
        try {
            const trace = createWatchdogTrace(path);
            assert.equal(trace.path, path, "creates missing parent directories");
            trace.record("track", { jobId: "b1", command: "sleep 1" });
            trace.record("verdict", { jobId: "b1", stuck: 0.9 });
            const lines = await readLines(path);
            assert.equal(lines.length, 2);
            assert.equal(lines[0].event, "track");
            assert.equal(lines[0].jobId, "b1");
            assert.equal(lines[0].extensionPid, process.pid);
            assert.match(lines[0].ts, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(lines[1].stuck, 0.9);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    void it("stays inert when disabled and never throws or hangs on an unwritable path", async () => {
        const disabled = createWatchdogTrace(undefined);
        assert.equal(disabled.path, undefined);
        assert.doesNotThrow(() => disabled.record("noop"));

        // `/proc` is a regression guard: `mkdir(..., { recursive: true })` blocks
        // forever there instead of throwing, which would freeze pi's main thread.
        // The elapsed-time assertion fails the test rather than hanging the run.
        for (const blockedPath of ["/proc/definitely-not-writable/events.jsonl", "/dev/null/nested/events.jsonl"]) {
            const startedAt = Date.now();
            const blocked = createWatchdogTrace(blockedPath);
            assert.equal(blocked.path, undefined, `${blockedPath} must not be reported as an active trace`);
            assert.doesNotThrow(() => blocked.record("noop"));
            assert.ok(Date.now() - startedAt < 2_000, `${blockedPath} must fail fast instead of hanging`);
        }
    });

    void it("rotates a single oversized trace instead of growing without bound", async () => {
        const root = await mkdtemp(join(tmpdir(), "patty-trace-rotate-"));
        const path = join(root, "events.jsonl");
        try {
            await writeFile(path, "x".repeat(WATCHDOG_TRACE_MAX_BYTES + 1));
            const trace = createWatchdogTrace(path);
            assert.equal(trace.path, path);
            trace.record("watchdog_start", {});
            const rotated = await readFile(`${path}.1`, "utf8");
            assert.equal(rotated.length, WATCHDOG_TRACE_MAX_BYTES + 1);
            const lines = await readLines(path);
            assert.equal(lines.length, 1);
            assert.equal(lines[0].event, "watchdog_start");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    void it("bounds serialized state and evidence tails", () => {
        const deep: Record<string, unknown> = { leaf: "value" };
        let cursor = deep;
        for (let index = 0; index < 12; index += 1) {
            cursor.next = { leaf: "value" };
            cursor = cursor.next as Record<string, unknown>;
        }
        const bounded = boundJson({ long: "y".repeat(50), omitted: undefined, deep, list: Array.from({ length: 100 }, (_, i) => i) }, 10, 3) as {
            long: string;
            omitted?: unknown;
            deep: { next: { next: unknown } };
            list: unknown[];
        };
        assert.equal(bounded.long, `${"y".repeat(10)}…[truncated]`);
        assert.equal("omitted" in bounded, false, "undefined members are dropped so the result is real JSON");
        assert.equal(bounded.list.length, 64);
        assert.equal(JSON.parse(JSON.stringify(bounded)).deep.next.next, "[depth-limit]");

        assert.equal(summarizeTail("short", 100), "short");
        assert.equal(summarizeTail("z".repeat(20), 5), "zzzzz…[truncated]");
    });

    void it("aggregates a trace into reviewable statistics", async () => {
        const root = await mkdtemp(join(tmpdir(), "patty-trace-report-"));
        const path = join(root, "events.jsonl");
        try {
            const trace = createWatchdogTrace(path);
            trace.record("watchdog_start", {});
            trace.record("track", { jobId: "b1" });
            trace.record("poll", { jobId: "b1", gate: "log_still_growing" });
            trace.record("poll", { jobId: "b1", gate: "log_still_growing" });
            trace.record("poll", { jobId: "b1", gate: "passed" });
            trace.record("jev_request", { jobId: "b1" });
            trace.record("verdict", { jobId: "b1", isHigh: true, isDirectHigh: false, likelyCause: "missed_terminal_state", latencyMs: 1_200 });
            trace.record("alert_suppressed", { jobId: "b1", reason: "needs_consecutive_samples" });
            trace.record("poll", { jobId: "b1", gate: "passed" });
            trace.record("jev_request", { jobId: "b1" });
            trace.record("verdict", { jobId: "b1", isHigh: true, isDirectHigh: true, likelyCause: "missed_terminal_state", latencyMs: 900 });
            trace.record("alert", { jobId: "b1", likelyCause: "missed_terminal_state" });
            trace.record("error", { jobId: "b1", message: "boom" });

            const report = await readWatchdogTrace(path);
            assert.ok(report);
            assert.equal(report.stats.trackedJobs, 1);
            assert.equal(report.stats.polls, 4);
            assert.equal(report.stats.gateHistogram.log_still_growing, 2);
            assert.equal(report.stats.gateHistogram.passed, 2);
            assert.equal(report.stats.jevRequests, 2);
            assert.equal(report.stats.verdicts, 2);
            assert.equal(report.stats.highVerdicts, 2);
            assert.equal(report.stats.directHighVerdicts, 1);
            assert.equal(report.stats.alerts, 1);
            assert.equal(report.stats.alertCauses.missed_terminal_state, 1);
            assert.equal(report.stats.suppressedAlerts.needs_consecutive_samples, 1);
            assert.equal(report.stats.jevErrors, 1);
            assert.equal(report.stats.malformedLines, 0);
            assert.equal(report.stats.latencyMs.count, 2);
            assert.equal(report.stats.latencyMs.max, 1_200);

            const rendered = formatWatchdogTraceStats(report.stats);
            assert.match(rendered, /Watchdog trace: /);
            assert.match(rendered, /needs_consecutive_samples: 1/);
            assert.match(rendered, /missed_terminal_state: 1/);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    void it("counts malformed lines and returns undefined for a missing trace", async () => {
        const root = await mkdtemp(join(tmpdir(), "patty-trace-malformed-"));
        const path = join(root, "events.jsonl");
        try {
            await writeFile(path, '{"event":"track","ts":"2026-01-01T00:00:00.000Z"}\nnot json\n\n{"noevent":true}\n');
            const report = await readWatchdogTrace(path);
            assert.ok(report);
            assert.equal(report.records.length, 1);
            assert.equal(report.stats.malformedLines, 2);
            assert.equal(await readWatchdogTrace(join(root, "absent.jsonl")), undefined);
            assert.equal(await readWatchdogTrace(undefined), undefined);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
