import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BackgroundRegistry } from "../state.ts";
import { terminateJobSilently } from "../lifecycle.ts";
import { registerBashBgTool } from "../tools/bash-bg.ts";

void describe("bash_bg — explicit sleeps are ordinary commands", () => {
    function bashBg() {
        let tool: { execute: (id: string, p: unknown, s: unknown, u: unknown, c: unknown) => Promise<unknown> } | undefined;
        const pi = { registerTool: (def: typeof tool) => { tool = def; }, sendMessage() {} };
        const reg = new BackgroundRegistry();
        registerBashBgTool(pi as never, reg);
        const ctx = {
            cwd: process.cwd(),
            ui: { notify() {}, setWidget() {}, setStatus() {}, theme: { fg: (_c: string, t: string) => t } },
        };
        return { tool: tool!, ctx, reg };
    }

    void it("allows a standalone long sleep", async () => {
        const { tool, ctx, reg } = bashBg();
        const result = await tool.execute("t1", { command: "sleep 600", notify: false }, undefined, undefined, ctx);
        assert.ok(result);
        const job = [...reg.jobs.values()][0];
        assert.equal(job?.command, "sleep 600");
        if (job) terminateJobSilently(reg, job);
    });

    void it("allows an embedded sleep", async () => {
        const { tool, ctx, reg } = bashBg();
        const result = await tool.execute(
            "t2",
            { command: "printf start; sleep 600; printf done", notify: false },
            undefined,
            undefined,
            ctx,
        );
        assert.ok(result);
        const job = [...reg.jobs.values()][0];
        assert.match(job?.command ?? "", /sleep 600/);
        if (job) terminateJobSilently(reg, job);
    });
});
