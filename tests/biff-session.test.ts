import { describe, expect, it } from "vitest";
import { createOwnedSession, endSession, readDefaultSession } from "../lib/biff-session.js";

// Real biff, real relay: only with BIFF_INTEGRATION=1 (it creates and ends a session).
const integrationEnabled = process.env.BIFF_INTEGRATION === "1";

describe.skipIf(!integrationEnabled)("owned biff session", () => {
	it("creates a session without changing the repo's default session", async () => {
		const opts = { cwd: process.cwd() };
		const before = await readDefaultSession(opts);
		const tty = `owned-${String(process.pid)}`;
		const id = await createOwnedSession(opts, tty);
		try {
			expect(id).toMatch(/^cli-[0-9a-f]+$/);
			expect(await readDefaultSession(opts)).toBe(before);
		} finally {
			await endSession(opts, id);
		}
	}, 60_000);
});
