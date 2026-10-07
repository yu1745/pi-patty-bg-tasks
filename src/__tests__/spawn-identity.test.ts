import { it } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { isSafeLogDirectory, killProcessTree, ownedProcessAlive, processExists, spawnSupervisedProcess } from "../spawn.ts";
import { terminateJobSilently } from "../lifecycle.ts";
import { BackgroundRegistry } from "../state.ts";
import { createRunningJob } from "../registry.ts";

it("PID reassignment never transfers an old spawn capability to the new child", async (t) => {
    const requests: Array<{ child: number; signal: unknown }> = [];
    const numericSignals: number[] = [];
    let serial = 0;
    t.mock.method(childProcess, "spawn", () => {
        const child = ++serial;
        return Object.assign(new EventEmitter(), {
            pid: 424242, exitCode: null, signalCode: null, connected: true, channel: { unref() {} }, unref() {},
            send(message: { signal: unknown }, callback: () => void) {
                requests.push({ child, signal: message.signal }); callback(); return true;
            },
            kill(signal: unknown) { requests.push({ child, signal }); return true; },
        });
    });
    t.mock.method(process, "kill", (pid: number) => { numericSignals.push(pid); return true; });
    syncBuiltinESMExports();
    try {
        const args = { file: "bash", fileArgs: ["-c", "true"], cwd: process.cwd(), stdout: "pipe", stderr: "pipe" } as const;
        const a = spawnSupervisedProcess({ ...args, fileArgs: [...args.fileArgs] });
        const oldIdentity = a.identity!;
        const delayedKill = () => killProcessTree(oldIdentity, "SIGKILL");
        a.emit("exit", 0, null);
        const b = spawnSupervisedProcess({ ...args, fileArgs: [...args.fileArgs] });
        assert.equal(a.pid, b.pid, "deterministic reassignment, not a tombstone-only test");
        assert.notEqual(oldIdentity, b.identity);
        assert.equal(ownedProcessAlive(oldIdentity), false);
        assert.equal(processExists(oldIdentity), false);
        assert.equal(processExists(b.identity), true);
        delayedKill();
        killProcessTree(a.pid as never, "SIGKILL"); // Old untyped PID-only API is also denied.
        killProcessTree({ pid: 424242 }, "SIGKILL"); // forged PID-shaped object has no authority
        const reg = new BackgroundRegistry();
        const oldJob = createRunningJob({ id: "old", command: "test", pid: a.pid!, identity: oldIdentity, logPath: "/nonexistent/identity.log", toolCallId: "t" });
        reg.jobs.set(oldJob.id, oldJob);
        assert.equal(await terminateJobSilently(reg, oldJob), true);
        assert.deepEqual(requests, [], "old Job cleanup must not signal B");
        assert.deepEqual(numericSignals, [], "owned kill/liveness never fall back to PID/PGID probes");
        killProcessTree(b.identity, "SIGTERM");
        assert.deepEqual(requests, [{ child: 2, signal: "SIGTERM" }]);
        b.emit("exit", 0, null);
        assert.equal(processExists(b.identity), false);
    } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
    }
});

it("directory validation keeps POSIX protection without interpreting Windows synthetic mode bits as ACLs", (t) => {
    const stat = { uid: 1000, mode: 0o777, isDirectory: () => true, isSymbolicLink: () => false };
    assert.equal(isSafeLogDirectory(stat, "win32", 2000), true, "synthetic owner/mode cannot reject a real Windows directory");
    if (process.getuid) {
        t.mock.method(process as { getuid: () => number }, "getuid", () => { throw new Error("Windows validation must not call POSIX getuid"); });
        assert.equal(isSafeLogDirectory(stat, "win32"), true);
    }
    assert.equal(isSafeLogDirectory(stat, "linux", 1000), false, "world/group writable POSIX directories remain forbidden");
    assert.equal(isSafeLogDirectory({ ...stat, mode: 0o700 }, "linux", 1000), true);
    assert.equal(isSafeLogDirectory({ ...stat, mode: 0o700 }, "linux", 2000), false, "POSIX foreign owner remains forbidden");
    for (const platform of ["linux", "win32"] as const) {
        assert.equal(isSafeLogDirectory({ ...stat, isDirectory: () => false }, platform, 1000), false);
        assert.equal(isSafeLogDirectory({ ...stat, isSymbolicLink: () => true }, platform, 1000), false);
    }
});
