import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_COMMAND_TIMEOUT_S, isTimeoutExit, KILL_GRACE_S } from "../lib/bash-guard.js";
import { createGuardedBashOperations, MAX_COMMAND_TIMEOUT_S } from "../lib/bash-operations.js";

describe("guard configuration", () => {
	it("retains the 120-second deadline and ten-second kill grace", () => {
		expect(DEFAULT_COMMAND_TIMEOUT_S).toBe(120);
		expect(KILL_GRACE_S).toBe(10);
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, MAX_COMMAND_TIMEOUT_S + 1])(
		"rejects invalid or overflowing default timeout %s",
		(seconds) => {
			expect(() => createGuardedBashOperations(seconds)).toThrow("Invalid timeout");
		},
	);

	it("reports a missing Bash dependency clearly", async () => {
		await expect(
			createGuardedBashOperations().exec("echo ok", process.cwd(), {
				onData: () => undefined,
				env: { PATH: "/nonexistent-bash-guard-test-directory" },
			}),
		).rejects.toThrow("Bash must be on PATH");
	});

	it("does not spawn a command after cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			createGuardedBashOperations().exec("exit 99", process.cwd(), {
				onData: () => undefined,
				signal: controller.signal,
			}),
		).rejects.toThrow("aborted");
	});

	it("bounds a runaway without depending on GNU timeout", async () => {
		const result = await createGuardedBashOperations(0.1).exec(
			"while :; do printf runaway; done",
			process.cwd(),
			{ onData: () => undefined },
		);
		expect(result.exitCode).toBe(124);
	});

	it("does not let a longer per-call timeout extend the ceiling", async () => {
		const result = await createGuardedBashOperations(0.1).exec("sleep 30", process.cwd(), {
			onData: () => undefined,
			timeout: 30,
		});
		expect(result.exitCode).toBe(124);
	});

	it("enforces the deadline with only Bash on PATH and no GNU timeout", async () => {
		const directory = mkdtempSync(join(process.cwd(), ".tmp", "bash-only-"));
		symlinkSync("/bin/bash", join(directory, "bash"));
		try {
			const result = await createGuardedBashOperations(0.1).exec(
				"while :; do :; done",
				process.cwd(),
				{ env: { PATH: directory }, onData: () => undefined },
			);
			expect(result.exitCode).toBe(124);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("does not kill another command's process group", async () => {
		const operations = createGuardedBashOperations();
		let output = "";
		const unrelated = operations.exec("sleep 0.2; printf alive", process.cwd(), {
			onData: (data) => {
				output += data.toString();
			},
		});
		await operations.exec("exit 0", process.cwd(), { onData: () => undefined });
		expect((await unrelated).exitCode).toBe(0);
		expect(output).toBe("alive");
	});

	it("propagates output callback failures instead of leaking the child", async () => {
		await expect(
			createGuardedBashOperations().exec("printf started; sleep 30", process.cwd(), {
				onData: () => {
					throw new Error("output callback failed");
				},
			}),
		).rejects.toThrow("output callback failed");
	});
});

describe("isTimeoutExit", () => {
	it("recognises deadline and forced termination codes", () => {
		expect(isTimeoutExit(124)).toBe(true);
		expect(isTimeoutExit(137)).toBe(true);
	});

	it.each([0, 1, 2, 3])("does not mistake exit %s for a timeout", (code) => {
		expect(isTimeoutExit(code)).toBe(false);
	});
});
