import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { followLines } from "../monitor-follow.ts";
import { openMonitorCapture, MONITOR_LOG_BYTES } from "../monitor-capture.ts";

const dir = join(tmpdir(), `pi-bg-follow-${process.pid}`);
mkdirSync(dir, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TICK = 15;

void describe("monitor-follow / followLines", () => {
    void it("emits only complete lines and holds a partial trailing line", async () => {
        const p = join(dir, "partial.log");
        writeFileSync(p, "");
        const batches: string[][] = [];
        const f = followLines(p, (lines) => batches.push(lines), TICK);

        appendFileSync(p, "alpha\nbeta\npar"); // 'par' has no newline yet
        await sleep(TICK * 3);
        assert.deepEqual(batches.flat(), ["alpha", "beta"]);

        appendFileSync(p, "tial\n"); // completes 'partial'
        await sleep(TICK * 3);
        f.stop();
        assert.deepEqual(batches.flat(), ["alpha", "beta", "partial"]);
    });

    void it("batches lines that land within one tick into a single event", async () => {
        const p = join(dir, "batch.log");
        writeFileSync(p, "");
        const batches: string[][] = [];
        const f = followLines(p, (lines) => batches.push(lines), TICK);

        appendFileSync(p, "one\ntwo\nthree\n");
        await sleep(TICK * 3);
        f.stop();
        assert.equal(batches.length, 1);
        assert.deepEqual(batches[0], ["one", "two", "three"]);
    });

    void it("tracks offset forward across successive appends", async () => {
        const p = join(dir, "offset.log");
        writeFileSync(p, "");
        const seen: string[] = [];
        const f = followLines(p, (lines) => seen.push(...lines), TICK);

        appendFileSync(p, "a\n");
        await sleep(TICK * 2);
        appendFileSync(p, "b\n");
        await sleep(TICK * 2);
        appendFileSync(p, "c\n");
        await sleep(TICK * 2);
        f.stop();
        assert.deepEqual(seen, ["a", "b", "c"]); // no re-emits
    });

    void it("flushes a final newline-less line on stop(true)", async () => {
        const p = join(dir, "flush.log");
        writeFileSync(p, "");
        const seen: string[] = [];
        const f = followLines(p, (lines) => seen.push(...lines), TICK);

        appendFileSync(p, "done\nlast-without-newline");
        await sleep(TICK * 2);
        f.stop(true);
        assert.deepEqual(seen, ["done", "last-without-newline"]);
    });

    void it("does not emit the trailing partial when stop() omits flush", async () => {
        const p = join(dir, "noflush.log");
        writeFileSync(p, "");
        const seen: string[] = [];
        const f = followLines(p, (lines) => seen.push(...lines), TICK);

        appendFileSync(p, "kept\ndropped-partial");
        await sleep(TICK * 2);
        f.stop(false);
        assert.deepEqual(seen, ["kept"]);
    });

    void it("bounds burst batches and newline-free lines", async () => {
        const p = join(dir, "burst.log");
        writeFileSync(p, "x".repeat(100_000) + "\n" + "a\n".repeat(20_000));
        const batches: string[][] = [];
        const f = followLines(p, (lines) => batches.push(lines), TICK);
        await sleep(TICK * 10);
        f.stop(true);
        assert.ok(batches.length > 1);
        assert.ok(batches.every((b) => b.length <= 128));
        assert.ok(batches.flat().every((line) => line.length < 4200));
        assert.ok(batches.flat()[0].endsWith("[line truncated]"));
    });

    void it("detects truncate/regrow even when the new size exceeds its old offset", async () => {
        const p = join(dir, "rotation.log");
        const capture = openMonitorCapture(p);
        const seen: string[] = [];
        const f = followLines(p, (lines) => seen.push(...lines), TICK);
        capture.write(Buffer.from("initial\n"));
        await sleep(TICK * 2);
        capture.write(Buffer.alloc(MONITOR_LOG_BYTES - Buffer.byteLength("initial\n"), 120));
        capture.write(Buffer.from("latest-new-output\n"));
        f.stop(true);
        capture.close();
        assert.ok(seen.includes("latest-new-output"));
        assert.ok(seen.some((line) => line.includes("rotated")));
    });

    void it("preserves UTF-8 split across read boundaries", () => {
        const p = join(dir, "utf8.log");
        writeFileSync(p, "a".repeat(16383) + "😀\n");
        const seen: string[] = [];
        const f = followLines(p, (lines) => seen.push(...lines), TICK);
        f.stop(true);
        assert.ok(!seen.join("").includes("�"));
    });

    void it("contains callback exceptions and keeps polling", async () => {
        const p = join(dir, "throw.log");
        writeFileSync(p, "one\n");
        const errors: unknown[] = [];
        let calls = 0;
        const f = followLines(p, () => { calls++; throw new Error("delivery failed"); }, TICK, (e) => errors.push(e));
        await sleep(TICK * 2);
        appendFileSync(p, "two\n");
        await sleep(TICK * 2);
        f.stop();
        assert.equal(calls, 2);
        assert.equal(errors.length, 2);
    });

    void it("tolerates a not-yet-created log file", async () => {
        const p = join(dir, "later.log");
        const seen: string[] = [];
        const f = followLines(p, (lines) => seen.push(...lines), TICK);
        await sleep(TICK * 2);
        writeFileSync(p, "finally\n");
        await sleep(TICK * 3);
        f.stop();
        assert.deepEqual(seen, ["finally"]);
    });
});

process.on("exit", () => {
    try {
        rmSync(dir, { recursive: true, force: true });
    } catch {
        /* best-effort */
    }
});
