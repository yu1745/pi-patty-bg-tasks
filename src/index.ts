/**
 * pi-patty-bg-tasks — background task extension for the pi agent.
 *
 * Registers five tools:
 *   - bash (override)
 *   - bash_bg
 *   - jobs
 *   - agent_bg
 *   - monitor (streaming-event watch)
 *
 * Also registers keyboard shortcuts and slash commands.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { BackgroundRegistry } from "./state.ts";
import { detectNonInteractive, terminateJobSilently } from "./lifecycle.ts";
import { stopSidebarTicker } from "./registry.ts";
import { EVENT } from "./types.ts";
import { registerBashTool } from "./tools/bash.ts";
import { registerBashBgTool } from "./tools/bash-bg.ts";
import { registerJobsTool } from "./tools/jobs.ts";
import { registerAgentBgTool } from "./tools/agent-bg.ts";
import { registerMonitorTool } from "./tools/monitor.ts";
import { registerShortcuts } from "./shortcuts.ts";
import { registerCommands } from "./commands.ts";
import { registerInputHandlers } from "./input.ts";
import { createJobWatchdog } from "./watchdog/index.ts";
import { formatWatchdogTraceStats, readWatchdogTrace } from "./watchdog/trace-report.ts";

/** Extension entry point. */
export default function (pi: ExtensionAPI): void {
    const reg = new BackgroundRegistry();
    reg.watchdog = createJobWatchdog(pi, reg);

    // ── Tool registration ─────────────────────────────────────────
    // Use the unwrapped tool *definition* so the override inherits Pi's native
    // bash renderCall/renderResult (createBashTool returns a wrapped AgentTool
    // that drops them).
    const originalBash = createBashToolDefinition(process.cwd());
    registerBashTool(pi, reg, originalBash);
    registerBashBgTool(pi, reg);
    registerJobsTool(pi, reg);
    registerAgentBgTool(pi, reg);
    registerMonitorTool(pi, reg);

    // ── Shortcuts / commands ──────────────────────────────────────
    registerShortcuts(pi, reg);
    registerCommands(pi, reg);
    registerInputHandlers(pi, reg);
    pi.registerCommand("stuck-watchdog", {
        description: "Inspect or toggle Jev-based semantic stall detection",
        handler: async (args, ctx) => {
            const [action = "status", jobId] = args.trim().split(/\s+/, 2);
            if (action === "on") {
                reg.watchdog?.setEnabled(true);
                ctx.ui.notify("Semantic stuck watchdog enabled.", "info");
                return;
            }
            if (action === "off") {
                reg.watchdog?.setEnabled(false);
                ctx.ui.notify("Semantic stuck watchdog disabled; no jobs were changed.", "info");
                return;
            }
            if (action === "check") {
                if (!jobId) {
                    ctx.ui.notify("Usage: /stuck-watchdog check <job-id>", "warning");
                    return;
                }
                await reg.watchdog?.inspectNow(jobId, ctx);
                return;
            }
            if (action === "stats" || action === "log") {
                const tracePath = reg.watchdog?.trace?.path;
                if (!tracePath) {
                    ctx.ui.notify("Watchdog tracing is disabled (PI_PATTY_WATCHDOG_LOG=0).", "warning");
                    return;
                }
                const report = await readWatchdogTrace(tracePath);
                if (!report) {
                    ctx.ui.notify(`No watchdog trace yet at ${tracePath}.`, "info");
                    return;
                }
                ctx.ui.notify(formatWatchdogTraceStats(report.stats), "info");
                return;
            }
            const items = reg.watchdog?.status() ?? [];
            const lines = items.map((item) =>
                `${item.jobId} age=${item.ageSeconds}s${item.verdict ? ` stuck=${item.verdict.stuck.toFixed(2)} cause=${item.verdict.likelyCause}` : " unchecked"}`
            );
            ctx.ui.notify(
                `Semantic stuck watchdog is ${reg.watchdog?.isEnabled() ? "on" : "off"}. Tracking ${items.length} job(s).${lines.length ? `\n${lines.join("\n")}` : ""}\nTrace: ${reg.watchdog?.trace?.path ?? "disabled"} (use /stuck-watchdog stats)`,
                "info",
            );
        },
    });

    // ── Message rendering ─────────────────────────────────────────
    // <task-notification> messages render as one colored line: green for
    // completed, red for failed, yellow for killed and for the statusless
    // stall warning (CC's unread/attention color).
    const renderTaskNotification = (
        message: { content: unknown; details?: unknown },
        theme: { fg(colour: string, text: string): string }
    ) => {
        const details = message.details as
            | { status?: string; summary?: string }
            | undefined;
        const colour =
            details?.status === "completed"
                ? "success"
                : details?.status === "failed"
                  ? "error"
                  : "warning";
        const line = theme.fg(colour, `● ${details?.summary ?? String(message.content)}`);
        return { render: () => [line], invalidate: () => {} };
    };
    pi.registerMessageRenderer(EVENT.taskNotification, (message, _options, theme) =>
        renderTaskNotification(message, theme)
    );
    pi.registerMessageRenderer(EVENT.stall, (message, _options, theme) =>
        renderTaskNotification(message, theme)
    );
    pi.registerMessageRenderer(EVENT.semanticStall, (message, _options, theme) =>
        renderTaskNotification(message, theme)
    );

    // ── Session start ─────────────────────────────────────────────
    // Claude Code parity: the registry is purely in-memory — no persistence,
    // no revival. Every session starts with an empty registry.
    pi.on("session_start", async (_event, _ctx) => {
        reg.nonInteractive = detectNonInteractive(
            process.argv,
            Boolean(process.stdin.isTTY)
        );
    });

    // ── Session shutdown ──────────────────────────────────────────
    pi.on("session_shutdown", async (_event, _ctx) => {
        // Stop semantic/process samplers before terminating jobs.
        reg.watchdog?.dispose();

        // Stop the live-duration ticker so the interval doesn't outlive the session.
        stopSidebarTicker(reg);

        // Claude Code's gracefulShutdown: kill ALL running tasks on ANY
        // shutdown reason, so no orphans outlive the session. The silent-kill
        // path latches `notified`, so no <task-notification> fires on the way
        // out. Log files are left for the OS to clean.
        for (const job of reg.jobs.values()) {
            if (job.status === "running") {
                terminateJobSilently(reg, job);
            }
        }
    });
}
