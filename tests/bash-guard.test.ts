import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_COMMAND_TIMEOUT_S,
	isTimeoutExit,
	KILL_GRACE_S,
	withTimeout,
} from "../lib/bash-guard.js";

function run(command: string, ms: number): Promise<{ code: number; bytes: number }> {
	return new Promise((resolve) => {
		const child = execFile(
			"bash",
			["-c", command],
			{ timeout: ms, maxBuffer: 64 * 1024 * 1024 },
			(error, stdout, stderr) => {
				const code =
					error && typeof (error as { code?: unknown }).code === "number"
						? (error as { code: number }).code
						: 0;
				resolve({ code, bytes: stdout.length + stderr.length });
			},
		);
		child.stdin?.end();
	});
}

describe("withTimeout", () => {
	it("wraps the command so the kernel bounds it", () => {
		expect(withTimeout("sleep 5", 1)).toContain("timeout");
		expect(withTimeout("sleep 5", 1)).toContain("1s");
	});

	it("escalates to SIGKILL for a command that ignores SIGTERM", () => {
		expect(withTimeout("sleep 5", 1)).toContain(`--kill-after=${String(KILL_GRACE_S)}s`);
	});

	it("preserves the whole command, not just the first word", () => {
		// A pipeline must be bounded end to end; wrapping only the head would
		// leave the tail running unbounded.
		const wrapped = withTimeout("yes | head -c 100", 1);
		expect(wrapped).toContain("yes | head -c 100");
	});

	it("escapes single quotes so quoting cannot break the wrapper", () => {
		const wrapped = withTimeout(`echo 'hi'`, 1);
		expect(wrapped).toContain(`'\\''`);
	});

	it("rejects a nonsensical timeout rather than silently running unbounded", () => {
		expect(() => withTimeout("ls", 0)).toThrow(/Invalid timeout/);
		expect(() => withTimeout("ls", -1)).toThrow(/Invalid timeout/);
		expect(() => withTimeout("ls", Number.NaN)).toThrow(/Invalid timeout/);
	});

	it("defaults to a bound that is generous but finite", () => {
		expect(DEFAULT_COMMAND_TIMEOUT_S).toBeGreaterThan(30);
		expect(Number.isFinite(DEFAULT_COMMAND_TIMEOUT_S)).toBe(true);
	});
});

describe("isTimeoutExit", () => {
	it("recognises the codes timeout uses", () => {
		expect(isTimeoutExit(124)).toBe(true); // SIGTERM at the limit
		expect(isTimeoutExit(137)).toBe(true); // SIGKILL after the grace period
	});

	it("does not mistake ordinary failures for timeouts", () => {
		expect(isTimeoutExit(0)).toBe(false);
		expect(isTimeoutExit(1)).toBe(false);
		expect(isTimeoutExit(2)).toBe(false);
	});
});

describe("bounding a runaway", () => {
	it("stops a command that would otherwise print forever", async () => {
		// The shape that wrote 204 GB: a loop printing at memory speed with
		// nothing to consume. Unwrapped this never returns.
		const runaway = `while :; do echo invalid move; done`;
		const result = await run(withTimeout(runaway, 1), 15_000);
		expect(isTimeoutExit(result.code)).toBe(true);
	}, 20_000);

	it("lets a normal command finish untouched", async () => {
		const result = await run(withTimeout("echo ok", 10), 15_000);
		expect(result.code).toBe(0);
	}, 20_000);

	it("does not disturb a command's own non-zero exit", async () => {
		const result = await run(withTimeout("exit 3", 10), 15_000);
		expect(result.code).toBe(3);
		expect(isTimeoutExit(result.code)).toBe(false);
	}, 20_000);
});
