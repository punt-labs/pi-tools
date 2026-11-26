import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createGuardedBashOperations } from "../lib/bash-operations.js";

const fixtures: string[] = [];

function fixtureCommand(ignoreTerm: boolean, redirect: boolean) {
	const directory = mkdtempSync(join(process.cwd(), ".tmp", "bash-grace-"));
	fixtures.push(directory);
	const script = join(directory, "child.cjs");
	const ready = join(directory, "ready");
	const marker = join(directory, "flushed");
	writeFileSync(
		script,
		`const fs = require('node:fs');
process.on('SIGTERM', () => { ${ignoreTerm ? "" : `setTimeout(() => { fs.writeFileSync(${JSON.stringify(marker)}, 'flushed'); process.exit(0); }, 300);`} });
fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
setInterval(() => {}, 1000);
`,
	);
	return {
		marker,
		ready,
		command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} ${redirect ? ">/dev/null 2>&1" : ""} & child=$!; wait "$child"; printf finished`,
	};
}

afterEach(() => {
	for (const fixture of fixtures.splice(0)) {
		const ready = join(fixture, "ready");
		if (existsSync(ready)) {
			try {
				process.kill(Number(readFileSync(ready, "utf8")), "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		}
		rmSync(fixture, { recursive: true, force: true });
	}
});

describe("deadline grace after the shell leader exits", () => {
	it.each([false, true])(
		"allows a child to finish its TERM flush (redirected=%s)",
		async (redirect) => {
			const fixture = fixtureCommand(false, redirect);
			const result = await createGuardedBashOperations(0.5).exec(fixture.command, process.cwd(), {
				onData: () => undefined,
			});
			expect(existsSync(fixture.ready), "fixture child must install its TERM handler").toBe(true);
			await delay(400);
			expect(existsSync(fixture.marker), "child lost its 300ms TERM flush grace").toBe(true);
			expect(result.exitCode).toBe(124);
		},
	);

	it.each([false, true])(
		"waits ten seconds then reports forced termination (redirected=%s)",
		async (redirect) => {
			const fixture = fixtureCommand(true, redirect);
			const start = performance.now();
			const result = await createGuardedBashOperations(0.5).exec(fixture.command, process.cwd(), {
				onData: () => undefined,
			});
			expect(existsSync(fixture.ready)).toBe(true);
			expect(result.exitCode).toBe(137);
			expect(performance.now() - start).toBeGreaterThanOrEqual(10_000);
		},
		15_000,
	);
});
