import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { killProcessTree, ownedProcessAlive, spawnWithFileOutput } from "../spawn.ts";
import { logPathFor } from "../registry.ts";

it("late signals never target an exited owned process identity", async (t) => {
    const task = spawnWithFileOutput({ command: "true", cwd: process.cwd(), logPath: logPathFor("late-signal"), foreground: true });
    await task.exit;
    for (let i = 0; i < 100 && ownedProcessAlive(task.identity); i++) await new Promise(resolve => setTimeout(resolve, 10));
    task.release();
    assert.equal(ownedProcessAlive(task.identity), false);
    let signals = 0;
    t.mock.method(process, "kill", () => { signals++; return true; });
    killProcessTree(task.identity, "SIGKILL");
    assert.equal(signals, 0, "do not probe or signal a potentially reused PID/PGID");
});

it("shell completion reaps its background descendants without waiting for inherited fds", { skip: process.platform !== "linux" }, async () => {
    const task = spawnWithFileOutput({ command: "sleep 60 & echo $!", cwd: process.cwd(), logPath: logPathFor("descendant"), foreground: true });
    try {
        assert.equal((await task.exit).code, 0);
        const pid = Number(readFileSync(task.logPath, "utf8").trim());
        assert.ok(pid > 0);
        const running = () => {
            try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[0] !== "Z"; }
            catch { return false; }
        };
        for (let i = 0; i < 100 && running(); i++) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(running(), false, "supervisor must kill descendants after shell exit");
    } finally { task.release(); }
});
