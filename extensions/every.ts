import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wakeScheduler } from "../lib/wake-scheduler.js";

const EVERY_KEY = "every";

interface EverySpec {
	intervalMs: number;
	intervalLabel: string;
	instruction: string;
	maximumRuns: number;
}

interface EveryState extends EverySpec {
	deliveredRuns: number;
}

let state: EveryState | undefined;

export function parseEvery(raw: string): EverySpec | string {
	const match = /^([1-9]\d*)([smh])\s+(.+)\s+([1-9]\d*)$/.exec(raw.trim());
	if (!match) return "Usage: /every <n>s|<n>m|<n>h <LLM command> <max_times>";
	const amount = Number(match[1]);
	const unit = match[2];
	const instruction = match[3].trim();
	const maximumRuns = Number(match[4]);
	const multiplier = unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
	return {
		intervalMs: amount * multiplier,
		intervalLabel: `${String(amount)}${unit}`,
		instruction,
		maximumRuns,
	};
}

export default function everyExtension(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => wakeScheduler.configure(pi, ctx));
	pi.on("agent_settled", () => wakeScheduler.flush());
	pi.on("session_shutdown", () => {
		state = undefined;
		wakeScheduler.shutdown();
	});

	pi.registerCommand("every", {
		description: "Repeat an LLM instruction: /every <time> <command> <max_times>",
		handler: async (args, ctx) => {
			await Promise.resolve();
			const command = args.trim();
			if (command === "stop") {
				if (!state) {
					ctx.ui.notify("No /every schedule is active.", "info");
					return;
				}
				const stopped = state;
				wakeScheduler.cancel(EVERY_KEY);
				state = undefined;
				ctx.ui.notify(
					`Stopped after ${String(stopped.deliveredRuns)} of ${String(stopped.maximumRuns)} deliveries: ${stopped.instruction}`,
					"info",
				);
				return;
			}
			if (command === "status") {
				if (!state) {
					ctx.ui.notify("No /every schedule is active.", "info");
					return;
				}
				ctx.ui.notify(
					`Every ${state.intervalLabel}: ${state.instruction}\nDelivered: ${String(state.deliveredRuns)} of ${String(state.maximumRuns)}`,
					"info",
				);
				return;
			}
			if (state) {
				ctx.ui.notify("An /every schedule is already active. Use /every stop first.", "error");
				return;
			}
			const parsed = parseEvery(command);
			if (typeof parsed === "string") {
				ctx.ui.notify(parsed, "error");
				return;
			}
			state = { ...parsed, deliveredRuns: 0 };
			wakeScheduler.scheduleEvery(EVERY_KEY, parsed.intervalMs, () => {
				if (!state) return undefined;
				const run = state.deliveredRuns + 1;
				return {
					source: `/every ${state.intervalLabel} — run ${String(run)} of ${String(state.maximumRuns)}`,
					content: state.instruction,
					onDelivered: () => {
						if (!state) return;
						state.deliveredRuns += 1;
						if (state.deliveredRuns >= state.maximumRuns) {
							wakeScheduler.cancel(EVERY_KEY);
							state = undefined;
						}
					},
				};
			});
			ctx.ui.notify(
				`Scheduled every ${parsed.intervalLabel}, maximum ${String(parsed.maximumRuns)} runs: ${parsed.instruction}`,
				"info",
			);
		},
	});
}
