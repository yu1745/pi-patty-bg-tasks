/**
 * index.ts session lifecycle — Claude Code parity:
 *   - the registry is born empty on session_start (no persistence, no revival;
 *     a stale `background-tasks-state` entry is never consulted)
 *   - session_shutdown kills ALL running tasks on ANY reason, not just "quit",
 *     and appends no state snapshot
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import extension from "../index.ts";
import { EVENT } from "../types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A process marker unique to this test run, so pgrep can't hit strangers. */
const MARKER = `pi-bg-shutdown-test-${process.pid}`;
const WATCH_CMD = `while true; do sleep 1; done # ${MARKER}`;

/** Count live processes whose command line carries our marker. The `[w]hile`
 *  trick keeps the pgrep shell's own cmdline from matching itself. */
function liveMarkedProcesses(): number {
    try {
        const out = execSync(
            `pgrep -f "[w]hile true; do sleep 1; done # ${MARKER}" | wc -l`,
            { encoding: "utf-8" }
        );
        return Number.parseInt(out.trim(), 10);
    } catch {
        return 0;
    }
}

interface CapturedTool {
    name: string;
    execute: (
        toolCallId: string,
        params: unknown,
        signal: unknown,
        onUpdate: unknown,
        ctx: unknown
    ) => Promise<{ content: { type: "text"; text: string }[] }>;
}

type SessionHandler = (event: { reason?: string }, ctx: unknown) => Promise<void>;

function makePi() {
    const tools = new Map<string, CapturedTool>();
    const handlers = new Map<string, SessionHandler>();
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const messages: { customType: string }[] = [];
    const appendedEntries: unknown[] = [];
    const pi = {
        registerTool(def: CapturedTool) {
            tools.set(def.name, def);
        },
        registerShortcut() {},
        registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(name, command); },
        registerMessageRenderer() {},
        on(event: string, handler: SessionHandler) {
            handlers.set(event, handler);
        },
        sendMessage(msg: { customType: string }) {
            messages.push(msg);
        },
        appendEntry(_customType: string, data: unknown) {
            appendedEntries.push(data);
        },
    };
    return { pi, tools, handlers, commands, messages, appendedEntries };
}

const uiCtx = {
    cwd: process.cwd(),
    ui: {
        notify() {},
        setWidget() {},
        setStatus() {},
        theme: { fg: (_c: string, t: string) => t },
    },
};

function startExtension() {
    const h = makePi();
    extension(h.pi as never);
    return h;
}

void it("agent_bg is enabled by default and can be omitted without disabling other tools", () => {
    const previous = process.env.PI_PATTY_DISABLE_AGENT_BG;
    try {
        delete process.env.PI_PATTY_DISABLE_AGENT_BG;
        assert.ok(startExtension().tools.has("agent_bg"));
        process.env.PI_PATTY_DISABLE_AGENT_BG = "1";
        const { tools } = startExtension();
        assert.equal(tools.has("agent_bg"), false);
        for (const name of ["bash", "bash_bg", "jobs", "monitor"]) assert.ok(tools.has(name));
    } finally {
        if (previous === undefined) delete process.env.PI_PATTY_DISABLE_AGENT_BG;
        else process.env.PI_PATTY_DISABLE_AGENT_BG = previous;
    }
});

void describe("session_start — registry is born empty (no revival)", () => {
    void it("ignores a stale persisted state entry entirely", async () => {
        const h = startExtension();
        // If session_start still tried to restore state, it would consult the
        // session manager — make that throw to prove it's never touched.
        const ctx = {
            sessionManager: {
                getEntries(): never {
                    throw new Error("session entries must not be consulted");
                },
            },
        };
        await h.handlers.get("session_start")!({}, ctx);

        const jobs = h.tools.get("jobs")!;
        const res = await jobs.execute("t1", { action: "list" }, undefined, undefined, uiCtx);
        assert.equal(res.content[0].text, "No background jobs");
        assert.equal(h.appendedEntries.length, 0, "no state snapshot is written");
    });
});

void it("a reused extension runtime restores semantic watchdog tracking for the new session", async () => {
    const h = startExtension();
    await h.handlers.get("session_start")!({}, {});
    await h.handlers.get("session_shutdown")!({ reason: "reload" }, {});
    await h.handlers.get("session_start")!({}, {});
    const notices: string[] = [];
    const ctx = { ...uiCtx, ui: { ...uiCtx.ui, notify: (message: string) => { notices.push(message); } } };
    try {
        await h.tools.get("bash")!.execute("new-session", { command: "sleep 30", run_in_background: true }, undefined, undefined, ctx);
        await h.commands.get("stuck-watchdog")!.handler("status", ctx);
        assert.ok(notices.some(message => message.includes("Tracking 1 job(s)")));
    } finally {
        await h.handlers.get("session_shutdown")!({ reason: "quit" }, {});
    }
});

void describe("session_shutdown — kills running tasks on ANY reason", () => {
    for (const reason of ["quit", "reload"]) {
        void it(`reason "${reason}" kills running tasks silently`, async () => {
            const h = startExtension();
            await h.handlers.get("session_start")!({}, {});

            // Start a real long-running background task.
            const bash = h.tools.get("bash")!;
            const started = await bash.execute(
                "t2",
                { command: WATCH_CMD, run_in_background: true },
                undefined,
                undefined,
                uiCtx
            );
            const id = /with ID: (\w+)\./.exec(started.content[0].text)?.[1];
            assert.ok(id && /^b[0-9a-z]{8}$/.test(id), `typed shell id, got: ${id}`);
            assert.ok(liveMarkedProcesses() > 0, "task process is running");

            await h.handlers.get("session_shutdown")!({ reason }, {});
            await sleep(200); // let the SIGTERM land

            const jobs = h.tools.get("jobs")!;
            const list = await jobs.execute("t3", { action: "list" }, undefined, undefined, uiCtx);
            assert.equal(list.content[0].text, "No background jobs", "disposed runtime leaves no phantom jobs");
            assert.equal(liveMarkedProcesses(), 0, "no orphaned process survives");
            assert.equal(
                h.messages.filter((m) => m.customType === EVENT.taskNotification).length,
                0,
                "silent kill — no <task-notification> on the way out"
            );
            assert.equal(h.appendedEntries.length, 0, "no state snapshot on shutdown");
        });
    }
});

after(() => {
    // Best-effort cleanup if a test failed mid-flight.
    try {
        execSync(`pkill -f "[w]hile true; do sleep 1; done # ${MARKER}" || true`);
    } catch {
        /* already gone */
    }
});
