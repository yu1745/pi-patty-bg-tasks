import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundRegistry } from "../state.ts";
import type { Job } from "../types.ts";
import {
    createJobWatchdog,
    isDirectHigh,
    isHigh,
    referencedLogPaths,
    type WatchdogVerdict,
} from "../watchdog/index.ts";
import { JEV_SERVICE_REQUEST_EVENT, type JevServiceV1 } from "../watchdog/jev-service.ts";

void describe("semantic stuck watchdog", () => {
    void it("extracts only bounded absolute text-log references", () => {
        assert.deepEqual(
            referencedLogPaths("until rg READY /tmp/run.log; do cat './relative.txt'; done; tail /var/log/app.out /tmp/run.log; cat /tmp/data.bin"),
            ["/tmp/run.log", "/var/log/app.out"],
        );
    });

    void it("alerts direct evidence once but keeps scope evidence on the two-sample path", () => {
        const verdict = (overrides: Partial<WatchdogVerdict> = {}): WatchdogVerdict => ({
            stuck: 0.9,
            shouldAlert: 0.9,
            credibleProgress: 0.1,
            intentionallyPersistent: 0.1,
            validFiniteWait: 0.1,
            evidence: {
                missedTerminalState: 0.9,
                unavailableInteractiveInput: 0.02,
                deadRequiredDependency: 0.03,
                mistakenNonproductiveScope: 0.02,
                repeatingNonprogress: 0.05,
            },
            likelyCause: "missed_terminal_state",
            model: "jev-test",
            ...overrides,
        });
        assert.equal(isHigh(verdict()), true);
        assert.equal(isDirectHigh(verdict()), true);
        assert.equal(isDirectHigh(verdict({
            evidence: {
                missedTerminalState: 0.03,
                unavailableInteractiveInput: 0.02,
                deadRequiredDependency: 0.03,
                mistakenNonproductiveScope: 0.9,
                repeatingNonprogress: 0.05,
            },
        })), false);
        assert.equal(isHigh(verdict({ credibleProgress: 0.51 })), false, "progress above the stricter suppression gate prevents an alert");
    });

    void it("uses direct job PID telemetry, alerts without terminating, and stops on abort", async () => {
        const root = await mkdtemp(join(tmpdir(), "patty-watchdog-"));
        const logPath = join(root, "job.log");
        const referencedPath = join(root, "producer.log");
        await writeFile(logPath, "waiting for marker NEVER_READY\n");
        await writeFile(referencedPath, "producer: server crash signature detected\n");
        const handlers = new Map<string, Set<(data: unknown) => void>>();
        const sent: unknown[] = [];
        let capturedState: unknown;
        const service: JevServiceV1 = {
            version: 1,
            async evaluate(request) {
                capturedState = request.state;
                return {
                    model: "jev-test",
                    answers: {
                        missed_terminal_state: { type: "noul", noul: 0.99 },
                        unavailable_interactive_input: { type: "noul", noul: 0.02 },
                        dead_required_dependency: { type: "noul", noul: 0.03 },
                        mistaken_nonproductive_scope: { type: "noul", noul: 0.02 },
                        repeating_nonprogress: { type: "noul", noul: 0.05 },
                        credible_useful_progress: { type: "noul", noul: 0.01 },
                        expected_indefinite_service: { type: "noul", noul: 0.01 },
                        valid_finite_wait: { type: "noul", noul: 0.01 },
                        likely_cause: { type: "choice", choice: "missed_terminal_state" },
                    },
                    usage: { input_tokens: 1, output_tokens: 1 },
                };
            },
        };
        const pi = {
            events: {
                emit(channel: string, data: unknown) {
                    for (const handler of handlers.get(channel) ?? []) handler(data);
                },
                on(channel: string, handler: (data: unknown) => void) {
                    const set = handlers.get(channel) ?? new Set();
                    set.add(handler);
                    handlers.set(channel, set);
                    return () => set.delete(handler);
                },
            },
            sendMessage(message: unknown) { sent.push(message); },
        };
        pi.events.on(JEV_SERVICE_REQUEST_EVENT, (data) => {
            (data as { accept(value: JevServiceV1): void }).accept(service);
        });
        const notifications: string[] = [];
        const ctx = {
            ui: {
                notify(message: string) { notifications.push(message); },
                setWidget() {}, setStatus() {},
                theme: { fg: (_colour: string, text: string) => text },
                async select() { return undefined; },
                async editor() { return undefined; },
            },
        };
        const reg = new BackgroundRegistry();
        const manager = createJobWatchdog(pi as never, reg);
        reg.watchdog = manager;
        const job: Job = {
            id: "btest1234",
            command: `until grep -q READY ${referencedPath}; do sleep 1; done`,
            pid: process.pid,
            startTime: Date.now() - 120_000,
            status: "running",
            logPath,
            toolCallId: "tool-1",
            isBackgrounded: true,
            kind: "shell",
        };
        reg.jobs.set(job.id, job);
        const controller = new AbortController();
        manager.track(job, ctx, controller.signal);
        try {
            const verdict = await manager.inspectNow(job.id, ctx);
            assert.equal(verdict?.likelyCause, "missed_terminal_state");
            assert.equal(job.status, "running", "watchdog must not terminate the job");
            assert.equal(sent.length, 1, "a high manual verdict emits an advisory alert");
            assert.match(notifications.join("\n"), /semantically blocked|block=0\.99/i);
            const state = capturedState as {
                process_observation?: { root_pid?: number };
                referenced_file_observations?: Array<{ path?: string; recent_tail?: string }>;
            };
            assert.equal(state.process_observation?.root_pid, process.pid);
            assert.equal(state.referenced_file_observations?.[0]?.path, referencedPath);
            assert.match(state.referenced_file_observations?.[0]?.recent_tail ?? "", /crash signature/);
            controller.abort();
            assert.equal(manager.status().length, 0);
        } finally {
            manager.dispose();
            await rm(root, { recursive: true, force: true });
        }
    });

    void it("writes an auditable trace of polls, verdicts, and alerts", async () => {
        const root = await mkdtemp(join(tmpdir(), "patty-watchdog-trace-"));
        const logPath = join(root, "job.log");
        const tracePath = join(root, "trace", "events.jsonl");
        await writeFile(logPath, "waiting for marker NEVER_READY\n");

        const handlers = new Map<string, Set<(data: unknown) => void>>();
        const service: JevServiceV1 = {
            version: 1,
            async evaluate() {
                return {
                    model: "jev-test",
                    answers: {
                        missed_terminal_state: { type: "noul", noul: 0.99 },
                        unavailable_interactive_input: { type: "noul", noul: 0.02 },
                        dead_required_dependency: { type: "noul", noul: 0.03 },
                        mistaken_nonproductive_scope: { type: "noul", noul: 0.02 },
                        repeating_nonprogress: { type: "noul", noul: 0.05 },
                        credible_useful_progress: { type: "noul", noul: 0.01 },
                        expected_indefinite_service: { type: "noul", noul: 0.01 },
                        valid_finite_wait: { type: "noul", noul: 0.01 },
                        likely_cause: { type: "choice", choice: "missed_terminal_state" },
                    },
                    usage: { input_tokens: 1, output_tokens: 1 },
                };
            },
        };
        const pi = {
            events: {
                emit(channel: string, data: unknown) {
                    for (const handler of handlers.get(channel) ?? []) handler(data);
                },
                on(channel: string, handler: (data: unknown) => void) {
                    const set = handlers.get(channel) ?? new Set();
                    set.add(handler);
                    handlers.set(channel, set);
                    return () => set.delete(handler);
                },
            },
            sendMessage() {},
        };
        pi.events.on(JEV_SERVICE_REQUEST_EVENT, (data) => {
            (data as { accept(value: JevServiceV1): void }).accept(service);
        });
        const ctx = {
            ui: {
                notify() {}, setWidget() {}, setStatus() {},
                theme: { fg: (_colour: string, text: string) => text },
                async select() { return undefined; },
                async editor() { return undefined; },
            },
        };
        const reg = new BackgroundRegistry();
        const previousTraceEnv = process.env.PI_PATTY_WATCHDOG_LOG;
        process.env.PI_PATTY_WATCHDOG_LOG = tracePath;
        let manager: ReturnType<typeof createJobWatchdog> | undefined;
        try {
            manager = createJobWatchdog(pi as never, reg);
            reg.watchdog = manager;
            assert.equal(manager.trace?.path, tracePath);
            const job: Job = {
                id: "btrace123",
                command: "until grep -q READY /tmp/never.log; do sleep 1; done",
                pid: process.pid,
                startTime: Date.now() - 120_000,
                status: "running",
                logPath,
                toolCallId: "tool-trace",
                isBackgrounded: true,
                kind: "shell",
            };
            reg.jobs.set(job.id, job);
            const controller = new AbortController();
            manager.track(job, ctx, controller.signal);
            await manager.inspectNow(job.id, ctx);
            controller.abort();
            manager.dispose();
            manager = undefined;

            const events = (await readFile(tracePath, "utf8"))
                .split("\n").filter(Boolean).map((line) => JSON.parse(line) as { event: string; [key: string]: unknown });
            const names = events.map((record) => record.event);
            assert.ok(names.includes("watchdog_start"), `expected a start record, got ${names.join(",")}`);
            assert.ok(names.includes("track"));
            assert.ok(names.includes("poll"));
            assert.ok(names.includes("jev_request"));
            assert.ok(names.includes("verdict"));
            assert.ok(names.includes("alert"), `expected an alert record, got ${names.join(",")}`);
            assert.ok(names.includes("stop"));

            const verdict = events.find((record) => record.event === "verdict");
            assert.equal(verdict?.isHigh, true);
            assert.equal(verdict?.likelyCause, "missed_terminal_state");
            assert.equal(typeof verdict?.latencyMs, "number");

            // The trace stores what the model was actually asked, so a run can be
            // audited without re-deriving the prompt from source.
            const request = events.find((record) => record.event === "jev_request");
            const state = request?.state as { task?: { id?: string }; log_observation?: { recent_tail?: string } };
            assert.equal(state?.task?.id, job.id);
            assert.match(state?.log_observation?.recent_tail ?? "", /NEVER_READY/);

            const stopped = events.find((record) => record.event === "stop");
            assert.equal(stopped?.reason, "aborted");
        } finally {
            manager?.dispose();
            if (previousTraceEnv === undefined) delete process.env.PI_PATTY_WATCHDOG_LOG;
            else process.env.PI_PATTY_WATCHDOG_LOG = previousTraceEnv;
            await rm(root, { recursive: true, force: true });
        }
    });
});
