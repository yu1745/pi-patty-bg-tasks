import { it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, statSync } from "node:fs";
import { BackgroundRegistry } from "../state.ts";
import { add, cleanupTerminal, createRunningJob, errPathFor, forget, LOG_DIR, logPathFor } from "../registry.ts";
import { RECENT_TERMINAL_KEEP } from "../types.ts";

it("private log root and terminal ring eviction remove stdout and stderr", () => {
    assert.equal(statSync(LOG_DIR).mode & 0o777, 0o700);
    const reg = new BackgroundRegistry();
    for (let i = 0; i <= RECENT_TERMINAL_KEEP; i++) {
        const id = `retention-${i}`;
        const logPath = logPathFor(id);
        writeFileSync(logPath, "out", { mode: 0o600 });
        writeFileSync(errPathFor(id), "err", { mode: 0o600 });
        const job = createRunningJob({ id, command: "test", pid: 0, logPath, toolCallId: id });
        job.status = "completed";
        add(reg, job);
        forget(reg, job);
    }
    assert.equal(existsSync(logPathFor("retention-0")), false);
    assert.equal(existsSync(errPathFor("retention-0")), false);
    const cleaned = cleanupTerminal(reg);
    assert.equal(cleaned.purged, RECENT_TERMINAL_KEEP);
    assert.equal(cleaned.bytesReclaimed, RECENT_TERMINAL_KEEP * 6);
    assert.equal(existsSync(errPathFor("retention-1")), false);
});
