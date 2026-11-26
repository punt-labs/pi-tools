import type { createBashTool, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import bashGuardExtension from "../extensions/bash-guard.js";

const fixtures: string[] = [];

function tool(limit = "120") {
	vi.stubEnv("PI_BASH_TIMEOUT_S", limit);
	const registerTool = vi.fn();
	bashGuardExtension({ registerTool } as unknown as ExtensionAPI);
	return registerTool.mock.calls[0]?.[0] as ReturnType<typeof createBashTool>;
}

afterEach(() => {
	vi.unstubAllEnvs();
	for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

describe("registered bash guard runtime", () => {
	it.each([" >/dev/null 2>&1", ""])(
		"cleans background descendants on command exit with redirection %s",
		async (redirection) => {
			const fixture = mkdtempSync(join(process.cwd(), ".tmp", "bash-background-"));
			fixtures.push(fixture);
			const marker = join(fixture, "escaped");
			const result = await tool().execute("background", {
				command: `(sleep 0.2; printf escaped > '${marker}')${redirection} &`,
			});
			expect(result.content).toBeDefined();
			await delay(350);
			expect(existsSync(marker), "background job survived the registered bash tool").toBe(false);
		},
	);

	it("preserves pipelines and quotes", async () => {
		const result = await tool().execute("pipeline", {
			command: `printf '%s\\n' "it's intact" | tr a-z A-Z`,
		});
		expect(result.content).toContainEqual({ type: "text", text: "IT'S INTACT\n" });
	});

	it("preserves ordinary nonzero exit codes", async () => {
		await expect(tool().execute("exit", { command: "exit 3" })).rejects.toThrow(
			"Command exited with code 3",
		);
	});

	it("reports 124 when the default ceiling terminates a command", async () => {
		await expect(tool("0.1").execute("timeout", { command: "sleep 30" })).rejects.toThrow(
			"Command exited with code 124",
		);
	});

	it("honors a shorter per-call timeout", async () => {
		await expect(
			tool().execute("call-timeout", { command: "sleep 30", timeout: 0.1 }),
		).rejects.toThrow("Command timed out after 0.1 seconds");
	});

	it("supports cancellation", async () => {
		const fixture = mkdtempSync(join(process.cwd(), ".tmp", "bash-cancel-"));
		fixtures.push(fixture);
		const marker = join(fixture, "escaped");
		const controller = new AbortController();
		const running = tool().execute(
			"cancel",
			{ command: `(sleep 0.3; printf escaped > '${marker}') & sleep 30` },
			controller.signal,
		);
		setTimeout(() => controller.abort(), 100);
		await expect(running).rejects.toThrow("Command aborted");
		await delay(350);
		expect(existsSync(marker)).toBe(false);
	});

	it("escalates an ignored SIGTERM after the ten-second grace and reports 137", async () => {
		const start = performance.now();
		await expect(
			tool("0.2").execute("kill", { command: "trap '' TERM; while :; do sleep 1; done" }),
		).rejects.toThrow("Command exited with code 137");
		expect(performance.now() - start).toBeGreaterThanOrEqual(10_000);
	}, 15_000);
});
