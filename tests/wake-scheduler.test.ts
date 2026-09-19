import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TIMER_MS, WakeScheduler, isSchedulableDelay } from "../lib/wake-scheduler.js";

describe("isSchedulableDelay", () => {
	it("accepts positive delays up to the Node timer ceiling", () => {
		expect(isSchedulableDelay(1)).toBe(true);
		expect(isSchedulableDelay(MAX_TIMER_MS)).toBe(true);
	});

	it("rejects zero, negative, non-integer, and over-ceiling delays", () => {
		expect(isSchedulableDelay(0)).toBe(false);
		expect(isSchedulableDelay(-1)).toBe(false);
		expect(isSchedulableDelay(1.5)).toBe(false);
		expect(isSchedulableDelay(MAX_TIMER_MS + 1)).toBe(false);
		expect(isSchedulableDelay(Number.POSITIVE_INFINITY)).toBe(false);
		expect(isSchedulableDelay(Number.NaN)).toBe(false);
	});
});

interface SentMessage {
	message: { content: string };
	options: { deliverAs: string; triggerTurn: boolean };
}

describe("WakeScheduler", () => {
	afterEach(() => vi.useRealTimers());

	it("throws for delays outside the schedulable range", () => {
		const { scheduler } = configuredScheduler(() => true);
		expect(() => scheduler.scheduleAfter("x", MAX_TIMER_MS + 1, () => undefined)).toThrow(
			RangeError,
		);
		expect(() => scheduler.scheduleEvery("y", 0, () => undefined)).toThrow(RangeError);
	});

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

	it("delivers a failure wake when a scheduleAfter producer throws synchronously", async () => {
		vi.useFakeTimers();
		const { scheduler, sent } = configuredScheduler(() => true);
		scheduler.scheduleAfter("build", 1000, () => {
			throw new Error("boom");
		});

		await vi.advanceTimersByTimeAsync(1000);

		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.content).toContain("boom");
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
