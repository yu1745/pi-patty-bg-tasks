import { it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { BackgroundRegistry } from "../state.ts";
import { createJobAbort, startBackgroundJob, terminateJobSilently } from "../lifecycle.ts";
import { renderSidebar } from "../registry.ts";
import { sendTaskNotification } from "../notify.ts";
import { retainProcessIdentity } from "../spawn.ts";
import type { Job, UiContext } from "../types.ts";

function job(overrides: Partial<Job> = {}): Job {
    return { id: "audit", command: "test", pid: 0, startTime: Date.now(), status: "running",
        logPath: "/nonexistent/audit.log", toolCallId: "audit-tool", isBackgrounded: true, ...overrides };
}
const stale = { get ui() { throw new Error("stale context"); } } as unknown as UiContext;

it("exit after stale context and failing onExit still performs terminal cleanup", async (t) => {
    t.mock.method(console, "error", () => {});
    const reg = new BackgroundRegistry();
    const task = job();
    reg.jobs.set(task.id, task);
    let resolve!: (value: { code: number; signal: null }) => void;
    const exit = new Promise<{ code: number; signal: null }>((r) => { resolve = r; });
    let sent = 0;
    startBackgroundJob({ reg, job: task, ctx: stale, exit,
        pi: { sendMessage() { sent++; } } as never,
        onExit() { throw new Error("stale callback"); } });
    const done = task.donePromise!;
    resolve({ code: 0, signal: null });
    await done;
    assert.equal(task.status, "completed");
    assert.equal(sent, 1);
    assert.equal(reg.jobAborts.size, 0);
    assert.equal(reg.sidebarTimer, undefined);
});

it("sidebar expiration cannot escape direct non-timer callers", () => {
    const reg = new BackgroundRegistry();
    reg.jobs.set("audit", job());
    assert.doesNotThrow(() => renderSidebar(reg, stale));
    assert.equal(reg.lastSidebarContent, undefined);
    assert.equal(reg.sidebarTimer, undefined);
});

it("completion retries failed delivery once the host recovers", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(console, "error", () => {});
    const reg = new BackgroundRegistry();
    const task = job({ status: "completed" });
    reg.jobs.set(task.id, task);
    let attempts = 0;
    const pi = { sendMessage() { if (++attempts === 1) throw new Error("busy"); } } as never;
    assert.equal(sendTaskNotification({ reg, job: task, pi }), false);
    assert.notEqual(task.notified, true);
    t.mock.timers.tick(1000);
    assert.equal(attempts, 2);
    assert.equal(task.notified, true);
    assert.equal(reg.jobs.size, 0);
    t.mock.timers.tick(10000);
    assert.equal(attempts, 2);
});

it("queued completion retries are fenced after shutdown and replacement", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(console, "error", () => {});
    const reg = new BackgroundRegistry();
    const task = job({ status: "completed" });
    reg.jobs.set(task.id, task);
    let attempts = 0;
    sendTaskNotification({ reg, job: task, pi: { sendMessage() { attempts++; throw new Error("busy"); } } as never });
    reg.disposed = true;
    reg.generation++;
    reg.disposed = false; // A fresh session must not revive this retry.
    t.mock.timers.tick(10000);
    assert.equal(attempts, 1);
    assert.notEqual(task.notified, true);
});

it("permanently stale notification retries are bounded", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(console, "error", () => {});
    const reg = new BackgroundRegistry();
    const task = job({ status: "completed" });
    reg.jobs.set(task.id, task);
    let attempts = 0;
    sendTaskNotification({ reg, job: task, pi: { sendMessage() { attempts++; throw new Error("stale"); } } as never });
    for (let i = 0; i < 10; i++) t.mock.timers.tick(10000);
    assert.equal(attempts, 4);
    assert.notEqual(task.notified, true);
    assert.equal(reg.jobs.has(task.id), true);
});

it("silent termination waits for a SIGTERM-resistant child and escalates", { timeout: 7000 }, async () => {
    const proc = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"],
        { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    try {
        await once(proc.stdout!, "data");
        const exit = once(proc, "exit");
        const reg = new BackgroundRegistry();
        const task = job({ pid: proc.pid!, identity: retainProcessIdentity(proc) });
        reg.jobs.set(task.id, task);
        const ac = createJobAbort(reg, task.id);
        const stopping = terminateJobSilently(reg, task);
        assert.equal(task.status, "running", "TERM is not proof of death");
        assert.equal(ac.signal.aborted, true);
        const [, signal] = await exit;
        assert.equal(signal, "SIGKILL");
        assert.equal(await stopping, true);
        assert.equal(task.status, "killed");
    } finally {
        try { process.kill(-proc.pid!, "SIGKILL"); } catch { /* already exited */ }
    }
});
