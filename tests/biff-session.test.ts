import { describe, expect, it } from "vitest";
import {
	createOwnedSession,
	endSession,
	pythonFromShebang,
	readDefaultSession,
} from "../lib/biff-session.js";

describe("pythonFromShebang", () => {
	it("returns an absolute interpreter path", async () => {
		expect(await pythonFromShebang("#!/opt/biff/bin/python3", "biff")).toBe(
			"/opt/biff/bin/python3",
		);
	});

	it("resolves /usr/bin/env python3 on PATH", async () => {
		expect(await pythonFromShebang("#!/usr/bin/env python3", "biff")).toMatch(/python3$/);
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
