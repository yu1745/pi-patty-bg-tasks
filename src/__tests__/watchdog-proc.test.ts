import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProcStat, sampleProcessGroup } from "../watchdog/proc-sampler.ts";

function statLine(pid: number, comm: string, state: string, ppid: number, pgrp: number, utime: number, stime: number, rss: number): string {
    const fields = [state, ppid, pgrp, 0, 0, 0, 0, 0, 0, 0, 0, utime, stime, 0, 0, 0, 0, 0, 0, 0, 0, rss];
    return `${pid} (${comm}) ${fields.join(" ")}\n`;
}

async function processFixture(root: string, args: {
    pid: number; comm: string; state: string; ppid: number; pgrp: number;
    utime: number; stime: number; rssPages: number; rssKb: number; wchan?: string;
}) {
    const dir = join(root, String(args.pid));
    await mkdir(dir);
    await writeFile(join(dir, "stat"), statLine(
        args.pid, args.comm, args.state, args.ppid, args.pgrp,
        args.utime, args.stime, args.rssPages,
    ));
    await writeFile(join(dir, "status"), `Name:\t${args.comm}\nVmRSS:\t${args.rssKb} kB\n`);
    await writeFile(join(dir, "wchan"), args.wchan ?? "0");
}

void describe("watchdog /proc sampler", () => {
    void it("parses command names containing spaces and closing parentheses", () => {
        const parsed = parseProcStat(statLine(42, "worker ) name", "S", 1, 42, 12, 7, 30));
        assert.deepEqual(parsed, {
            pid: 42,
            comm: "worker ) name",
            state: "S",
            ppid: 1,
            pgrp: 42,
            cpuTicks: 19,
            rssPages: 30,
        });
    });

    void it("samples the union of process-group members and descendants", async () => {
        const root = await mkdtemp(join(tmpdir(), "patty-proc-"));
        try {
            await processFixture(root, { pid: 100, comm: "bash", state: "S", ppid: 1, pgrp: 100, utime: 2, stime: 3, rssPages: 2, rssKb: 20, wchan: "do_wait" });
            await processFixture(root, { pid: 101, comm: "worker", state: "R", ppid: 100, pgrp: 101, utime: 10, stime: 1, rssPages: 3, rssKb: 30 });
            await processFixture(root, { pid: 102, comm: "detached", state: "S", ppid: 1, pgrp: 100, utime: 4, stime: 0, rssPages: 4, rssKb: 40, wchan: "pipe_read" });
            await processFixture(root, { pid: 999, comm: "other", state: "R", ppid: 1, pgrp: 999, utime: 99, stime: 0, rssPages: 9, rssKb: 90 });
            const sample = await sampleProcessGroup(100, root);
            assert.deepEqual(sample.pids, [100, 101, 102]);
            assert.equal(sample.totalCpuTicks, 20);
            assert.equal(sample.totalRssKb, 90);
            assert.deepEqual(sample.states, { S: 2, R: 1 });
            assert.deepEqual(sample.waitChannels, { do_wait: 1, pipe_read: 1 });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
