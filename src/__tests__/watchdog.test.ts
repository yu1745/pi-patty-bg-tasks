import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundRegistry } from "../state.ts";
import type { Job } from "../types.ts";
import { createJobWatchdog, referencedLogPaths } from "../watchdog/index.ts";
import { JEV_SERVICE_REQUEST_EVENT, type JevServiceV1 } from "../watchdog/jev-service.ts";

void describe("semantic stuck watchdog", () => {
    void it("extracts only bounded absolute text-log references", () => {
        assert.deepEqual(
            referencedLogPaths("until rg READY /tmp/run.log; do cat './relative.txt'; done; tail /var/log/app.out /tmp/run.log; cat /tmp/data.bin"),
            ["/tmp/run.log", "/var/log/app.out"],
        );
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
});
