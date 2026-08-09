import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ScheduledWake {
	source: string;
	content: string;
	onDelivered?: () => void;
}

type Timer = ReturnType<typeof setTimeout>;
type Producer = () => ScheduledWake | undefined | Promise<ScheduledWake | undefined>;

export class WakeScheduler {
	private readonly timers = new Map<string, Timer>();
	private readonly tokens = new Map<string, symbol>();
	private readonly pending = new Map<string, ScheduledWake>();
	private pi: ExtensionAPI | undefined;
	private ctx: ExtensionContext | undefined;
	private flushQueued = false;

	configure(pi: ExtensionAPI, ctx: ExtensionContext): void {
		this.pi = pi;
		this.ctx = ctx;
	}

	scheduleEvery(key: string, intervalMs: number, producer: Producer): void {
		this.cancel(key);
		const token = Symbol(key);
		this.tokens.set(key, token);
		const tick = async () => {
			try {
				const wake = await producer();
				if (this.tokens.get(key) === token && wake) this.enqueue(key, wake);
			} catch (error) {
				if (this.tokens.get(key) === token) {
					this.enqueue(key, {
						source: key,
						content: `Scheduled operation failed: ${errorMessage(error)}`,
					});
				}
			}
			if (this.tokens.get(key) === token) {
				this.timers.set(
					key,
					setTimeout(() => void tick(), intervalMs),
				);
			}
		};
		this.timers.set(
			key,
			setTimeout(() => void tick(), intervalMs),
		);
	}

	scheduleAfter(key: string, delayMs: number, producer: Producer): void {
		this.cancel(key);
		const token = Symbol(key);
		this.tokens.set(key, token);
		this.timers.set(
			key,
			setTimeout(() => {
				this.timers.delete(key);
				void Promise.resolve(producer())
					.then((wake) => {
						if (this.tokens.get(key) !== token) return;
						this.tokens.delete(key);
						if (wake) this.enqueue(key, wake);
					})
					.catch((error: unknown) => {
						if (this.tokens.get(key) !== token) return;
						this.tokens.delete(key);
						this.enqueue(key, {
							source: key,
							content: `Scheduled operation failed: ${errorMessage(error)}`,
						});
					});
			}, delayMs),
		);
	}

	enqueue(key: string, wake: ScheduledWake): void {
		this.pending.set(key, wake);
		if (this.flushQueued) return;
		this.flushQueued = true;
		queueMicrotask(() => {
			this.flushQueued = false;
			this.flush();
		});
	}

	flush(): void {
		if (!this.pi || !this.ctx?.isIdle() || this.pending.size === 0) return;
		const wakes = [...this.pending.values()];
		this.pending.clear();
		this.pi.sendMessage(
			{
				customType: "scheduled-wake",
				content: wakes.map((wake) => `${wake.source}\n\n${wake.content}`).join("\n\n---\n\n"),
				display: true,
				details: { sources: wakes.map((wake) => wake.source) },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
		for (const wake of wakes) wake.onDelivered?.();
	}

	cancel(key: string): boolean {
		const timer = this.timers.get(key);
		const existed = timer !== undefined || this.tokens.has(key);
		if (timer) clearTimeout(timer);
		this.timers.delete(key);
		this.tokens.delete(key);
		this.pending.delete(key);
		return existed;
	}

	has(key: string): boolean {
		return this.tokens.has(key);
	}

	shutdown(): void {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.tokens.clear();
		this.pending.clear();
		this.pi = undefined;
		this.ctx = undefined;
	}
}

export const wakeScheduler = new WakeScheduler();

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
