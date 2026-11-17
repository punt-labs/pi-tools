import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createOwnedSession,
	endSession,
	pythonFromShebang,
	readDefaultSession,
	withRepoLock,
} from "../lib/biff-session.js";

// The lock runs biff's Python, so these need biff installed: integration only.
// Each call starts a Python process, so allow more than vitest's 5 s default.
describe.skipIf(process.env.BIFF_INTEGRATION !== "1")("withRepoLock", { timeout: 30_000 }, () => {
	it("serialises overlapping callers in one repository", async () => {
		const events: string[] = [];
		const run = (name: string) =>
			withRepoLock({ cwd: process.cwd() }, async () => {
				events.push(`${name}+`);
				await new Promise((resolve) => setTimeout(resolve, 50));
				events.push(`${name}-`);
			});
		await Promise.all([run("a"), run("b")]);
		// Each caller's start and end are adjacent: no interleaving.
		expect([
			["a+", "a-", "b+", "b-"],
			["b+", "b-", "a+", "a-"],
		]).toContainEqual(events);
	});

	it("lets a third caller in while two hold it in turn", async () => {
		const order: number[] = [];
		await Promise.all(
			[1, 2, 3].map((n) =>
				withRepoLock({ cwd: process.cwd() }, async () => {
					order.push(n);
					await new Promise((resolve) => setTimeout(resolve, 20));
					order.push(-n);
				}),
			),
		);
		for (let i = 0; i < order.length; i += 2) expect(order[i + 1]).toBe(-order[i]);
	});

	it("releases the lock when the callback throws", async () => {
		await expect(
			withRepoLock({ cwd: process.cwd() }, () => Promise.reject(new Error("boom"))),
		).rejects.toThrow("boom");
		expect(await withRepoLock({ cwd: process.cwd() }, () => Promise.resolve("again"))).toBe(
			"again",
		);
	});
});

describe("pythonFromShebang", () => {
	it("returns an absolute interpreter path", async () => {
		expect(await pythonFromShebang("#!/opt/biff/bin/python3", "biff")).toBe(
			"/opt/biff/bin/python3",
		);
	});

	it("resolves /usr/bin/env python3 on PATH", async () => {
		// A fake python3 on a private PATH, so the test needs no real Python.
		const dir = mkdtempSync(join(tmpdir(), "fakepy-"));
		const fake = join(dir, "python3");
		writeFileSync(fake, "#!/bin/sh\n");
		chmodSync(fake, 0o755);
		const savedPath = process.env.PATH;
		process.env.PATH = `${dir}:/usr/bin:/bin`;
		try {
			expect(await pythonFromShebang("#!/usr/bin/env python3", "biff")).toBe(fake);
		} finally {
			process.env.PATH = savedPath;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects a shell trampoline and a missing shebang", async () => {
		await expect(pythonFromShebang("#!/bin/sh", "biff")).rejects.toThrow(/first line/);
		await expect(pythonFromShebang("echo hi", "biff")).rejects.toThrow(/first line/);
		await expect(pythonFromShebang("#!/usr/bin/env ruby", "biff")).rejects.toThrow(/first line/);
	});
});

// Real biff, real relay: only with BIFF_INTEGRATION=1 (it creates and ends a session).
const integrationEnabled = process.env.BIFF_INTEGRATION === "1";

describe.skipIf(!integrationEnabled)("owned biff session", () => {
	it("creates a session without changing the repo's default session", async () => {
		const opts = { cwd: process.cwd() };
		const before = await readDefaultSession(opts);
		const tty = `owned-${String(process.pid)}`;
		const { id, warning } = await createOwnedSession(opts, tty);
		try {
			expect(id).toMatch(/^cli-[0-9a-f]+$/);
			expect(warning).toBeUndefined();
			expect(await readDefaultSession(opts)).toBe(before);
		} finally {
			await endSession(opts, id);
		}
	}, 60_000);
});
