// src/input.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "./state.ts";
import type { UiContext } from "./types.ts";
import { backgroundActiveForeground } from "./lifecycle.ts";

export function registerInputHandlers(pi: ExtensionAPI, reg: BackgroundRegistry): void {
    pi.on("input", async (event, ctx) => {
        // Cooperative steering (Claude Code parity): ANY input typed while a
        // foreground bash command is running backgrounds that command and
        // re-delivers the input as the next turn — regardless of the message's
        // steer/followUp streamingBehavior. We only intercept when a foreground
        // slot is active; everything else falls through to Pi.
        if (reg.foreground.size === 0) return { action: "continue" };
        // Don't intercept extension-sourced messages.
        if (event.source === "extension") return { action: "continue" };

        const text = event.text;
        const bg = backgroundActiveForeground(reg, ctx as UiContext);
        if (!bg) return { action: "continue" };

        // Abort the current turn so the bash tool returns the "backgrounded" result.
        ctx.abort?.();

        // Resubmit the user's message once the aborted turn has settled.
        // Since Pi 1.0, an aborted run no longer drains the follow-up queue
        // (`!this._agentRunAbortRequested && this.agent.hasQueuedMessages()`),
        // so a followUp submitted here would sit in the pending area forever.
        // Wait for idle, then submit as a normal prompt — that starts a fresh
        // run and the message goes straight to the model.
        void (async () => {
            const deadline = Date.now() + 10_000;
            while (!ctx.isIdle?.()) {
                if (Date.now() > deadline) {
                    // Aborted turn never settled — fall back to a queued follow-up
                    // rather than dropping the user's input.
                    try {
                        pi.sendUserMessage(text, { deliverAs: "followUp" });
                    } catch {
                        // Session ended — nothing to deliver to.
                    }
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            try {
                await pi.sendUserMessage(text);
            } catch {
                // Session ended between abort and resubmit — nothing to deliver to.
            }
        })();

        return { action: "handled" };
    });
}
