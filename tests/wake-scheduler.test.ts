import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WakeScheduler } from "../lib/wake-scheduler.js";

interface SentMessage {
	message: { content: string };
	options: { deliverAs: string; triggerTurn: boolean };
}

describe("WakeScheduler", () => {
	afterEach(() => vi.useRealTimers());

	it("delivers a one-shot wake and triggers an agent turn", async () => {
		vi.useFakeTimers();
		const { scheduler, sent } = configuredScheduler(() => true);
		scheduler.scheduleAfter("build", 1000, () => ({ source: "build", content: "done" }));

		await vi.advanceTimersByTimeAsync(1000);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
		expect(sent[0]?.message.content).toContain("done");
	});

	it("coalesces repeated events while the agent is busy", () => {
		vi.useFakeTimers();
		let idle = false;
		const { scheduler, sent } = configuredScheduler(() => idle);
		scheduler.enqueue("watch", { source: "watch", content: "first" });
		scheduler.enqueue("watch", { source: "watch", content: "latest" });
		vi.runAllTicks();
		expect(sent).toHaveLength(0);

		idle = true;
		scheduler.flush();

		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.content).toContain("latest");
		expect(sent[0]?.message.content).not.toContain("first");
	});

	it("cancellation prevents a scheduled wake", async () => {
		vi.useFakeTimers();
		const { scheduler, sent } = configuredScheduler(() => true);
		scheduler.scheduleAfter("build", 1000, () => ({ source: "build", content: "done" }));
		scheduler.cancel("build");

		await vi.advanceTimersByTimeAsync(1000);

		expect(sent).toHaveLength(0);
	});

	it("does not deliver an in-flight producer after cancellation", async () => {
		vi.useFakeTimers();
		const { scheduler, sent } = configuredScheduler(() => true);
		let finish: ((value: { source: string; content: string }) => void) | undefined;
		const produced = new Promise<{ source: string; content: string }>((resolve) => {
			finish = resolve;
		});
		scheduler.scheduleEvery("watch", 1000, () => produced);
		await vi.advanceTimersByTimeAsync(1000);
		scheduler.cancel("watch");
		finish?.({ source: "watch", content: "late" });
		await Promise.resolve();

		expect(sent).toHaveLength(0);
	});

	it("shutdown cancels every timer and pending event", async () => {
		vi.useFakeTimers();
		const { scheduler, sent } = configuredScheduler(() => true);
		scheduler.scheduleEvery("watch", 1000, () => ({ source: "watch", content: "tick" }));
		scheduler.enqueue("pending", { source: "pending", content: "pending" });
		scheduler.shutdown();

		await vi.advanceTimersByTimeAsync(2000);

		expect(sent).toHaveLength(0);
	});
});

function configuredScheduler(isIdle: () => boolean): {
	scheduler: WakeScheduler;
	sent: SentMessage[];
} {
	const scheduler = new WakeScheduler();
	const sent: SentMessage[] = [];
	const sendMessage = (message: { content: string }, options: SentMessage["options"]) => {
		sent.push({ message, options });
	};
	scheduler.configure(
		{ sendMessage } as unknown as ExtensionAPI,
		{ isIdle } as unknown as ExtensionContext,
	);
	return { scheduler, sent };
}
