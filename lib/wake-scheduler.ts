import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ScheduledWake {
	source: string;
	content: string;
	onDelivered?: () => void;
}

type Timer = ReturnType<typeof setTimeout>;

// A recurring producer may ask the scheduler to stop after this tick. The
// scheduler performs the final enqueue and self-cancel under the tick's token,
// so a producer never has to touch cancel/enqueue itself (which would race an
// in-flight tick against keep_stop or session_shutdown).
export interface ProducerStop {
	stop: true;
	wake?: ScheduledWake;
}

type ProducerResult = ScheduledWake | ProducerStop | undefined;
type Producer = () => ProducerResult | Promise<ProducerResult>;

function isProducerStop(result: ProducerResult): result is ProducerStop {
	return result !== undefined && "stop" in result;
}

// Node clamps setTimeout delays above the 32-bit signed maximum to ~1 ms, which
// would turn a large interval into a busy loop. Reject anything past this bound
// at every scheduling boundary.
export const MAX_TIMER_MS = 2_147_483_647;

export function isSchedulableDelay(ms: number): boolean {
	return Number.isSafeInteger(ms) && ms > 0 && ms <= MAX_TIMER_MS;
}

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
		if (!isSchedulableDelay(intervalMs)) {
			throw new RangeError(
				`interval ${String(intervalMs)}ms is out of range (1..${String(MAX_TIMER_MS)})`,
			);
		}
		this.cancel(key);
		const token = Symbol(key);
		this.tokens.set(key, token);
		const tick = async () => {
			let stop = false;
			try {
				const result = await producer();
				// A tick that resumes after cancel/shutdown must not enqueue or
				// reschedule; the token guard covers both the normal and stop paths.
				if (this.tokens.get(key) === token) {
					if (isProducerStop(result)) {
						stop = true;
						// Enqueue the terminal wake under a derived key so the cancel below
						// (which drops the pending entry under `key`) does not discard it.
						if (result.wake) this.enqueue(`${key}:stopped`, result.wake);
					} else if (result) {
						this.enqueue(key, result);
					}
				}
			} catch (error) {
				if (this.tokens.get(key) === token) {
					this.enqueue(key, {
						source: key,
						content: `Scheduled operation failed: ${errorMessage(error)}`,
					});
				}
			}
			if (stop) {
				if (this.tokens.get(key) === token) this.cancel(key);
				return;
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
		if (!isSchedulableDelay(delayMs)) {
			throw new RangeError(
				`delay ${String(delayMs)}ms is out of range (1..${String(MAX_TIMER_MS)})`,
			);
		}
		this.cancel(key);
		const token = Symbol(key);
		this.tokens.set(key, token);
		this.timers.set(
			key,
			setTimeout(() => {
				this.timers.delete(key);
				void Promise.resolve()
					.then(producer)
					.then((result) => {
						if (this.tokens.get(key) !== token) return;
						this.tokens.delete(key);
						// scheduleAfter is one-shot; a ProducerStop simply contributes its
						// optional wake and the schedule ends regardless.
						const wake = isProducerStop(result) ? result.wake : result;
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
